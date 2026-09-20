/**
 * LspProcess 单元测试（板块 3）：进程生命周期、spawn 失败、
 * EPIPE 安全处理、stderr 环形缓冲、dispose 幂等。
 */

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LspInvalidStateError, LspProcessError } from "../../../src/symbols/lsp/errors.ts";
import { encodeLspMessage } from "../../../src/symbols/lsp/framing.ts";
import { LspProcess } from "../../../src/symbols/lsp/process.ts";
import { DEFAULT_MAX_STDERR_BYTES } from "../../../src/symbols/lsp/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mock-lsp-server.mjs", import.meta.url));

const processes: LspProcess[] = [];

function createProcess(options: ConstructorParameters<typeof LspProcess>[0]): LspProcess {
	const proc = new LspProcess(options);
	processes.push(proc);
	return proc;
}

afterEach(async () => {
	for (const proc of processes) {
		try {
			await proc.dispose();
		} catch {
			// 清理失败也要继续
		}
	}
	processes.length = 0;
});

describe("LspProcess: spawn", () => {
	it("command 不存在时 start 拒绝为 LspProcessError 并保留 ENOENT", async () => {
		const proc = createProcess({ command: "definitely-not-a-real-command-xyz-12345" });
		const err = await proc.start().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LspProcessError);
		expect((err as LspProcessError).code).toBe("ENOENT");
		expect(proc.state).toBe("failed");
	});

	it("重复 start 抛 LspInvalidStateError", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "standard"] });
		await proc.start();
		expect(proc.state).toBe("running");
		await expect(proc.start()).rejects.toBeInstanceOf(LspInvalidStateError);
	});

	it("进程正常退出：state exited、exitInfo 正确、waitForExit resolve", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "standard"] });
		await proc.start();
		expect(proc.pid).toBeTypeOf("number");

		await proc.write(encodeLspMessage({ jsonrpc: "2.0", method: "exit" }));
		proc.markStopRequested();
		const info = await proc.waitForExit(5_000);
		expect(info.exitCode).toBe(0);
		expect(info.unexpected).toBe(false);
		expect(proc.state).toBe("exited");
	});
});

describe("LspProcess: write / EPIPE", () => {
	it("未启动时 write 抛 LspInvalidStateError", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "standard"] });
		await expect(proc.write(Buffer.from("x"))).rejects.toBeInstanceOf(LspInvalidStateError);
	});

	it("进程退出后 write 抛 LspInvalidStateError", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "standard"] });
		await proc.start();
		await proc.write(encodeLspMessage({ jsonrpc: "2.0", method: "exit" }));
		await proc.waitForExit(5_000);
		await expect(proc.write(Buffer.from("x"))).rejects.toBeInstanceOf(LspInvalidStateError);
	});

	it("进程快速退出时的大写入不产生未捕获异常（EPIPE 安全）", async () => {
		const proc = createProcess({
			command: process.execPath,
			args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(0), 30);"],
		});
		await proc.start();
		// 1MB 写入：进程可能已退出（EPIPE / 状态错误），也可能写入成功；
		// 关键断言是整个过程不 crash，且随后 dispose 正常完成。
		await proc.write(Buffer.alloc(1024 * 1024, 0x61)).catch(() => {
			// 预期中的错误路径（LspInvalidStateError / LspProcessError）
		});
		await proc.dispose();
		expect(proc.state).toBe("disposed");
	});
});

describe("LspProcess: stderr", () => {
	it("stderr 大量输出不会导致未捕获异常，且环形缓冲有上限", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "stderr-noise"] });
		let stderrEvents = 0;
		proc.onStderr = () => {
			stderrEvents += 1;
		};
		await proc.start();
		// 等待 stderr 噪音写完（mock 写约 400KB）
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(stderrEvents).toBeGreaterThan(0);
		expect(proc.recentStderr.length).toBeLessThanOrEqual(DEFAULT_MAX_STDERR_BYTES);
	});
});

describe("LspProcess: dispose / kill", () => {
	it("dispose 幂等并清理状态", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "standard"] });
		await proc.start();
		await proc.dispose();
		await proc.dispose();
		expect(proc.state).toBe("disposed");
		// 回调被清空
		expect(proc.onStdout).toBeUndefined();
		expect(proc.onExit).toBeUndefined();
	});

	it("kill 后进程退出且标记为 requested stop（unexpected=false）", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "delay"] });
		await proc.start();
		proc.kill();
		const info = await proc.waitForExit(5_000);
		expect(info.unexpected).toBe(false);
		expect(proc.state).toBe("exited");
	});

	it("从未启动时 dispose 直接完成", async () => {
		const proc = createProcess({ command: process.execPath, args: [FIXTURE, "standard"] });
		await proc.dispose();
		expect(proc.state).toBe("disposed");
	});
});
