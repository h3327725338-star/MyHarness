import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/platform/process/exec.ts";

const STUCK_COMMAND = "setInterval(() => {}, 1000);";

function isWindows(): boolean {
	return process.platform === "win32";
}

describe("execCommand cancellation", () => {
	it("reports the timeout exit code instead of 0", async () => {
		const startedAt = Date.now();
		const result = await execCommand(process.execPath, ["-e", STUCK_COMMAND], process.cwd(), {
			timeout: 200,
			killGraceMs: 100,
		});

		expect(result.killed).toBe(true);
		// A timed-out command must never look like a successful one.
		expect(result.code).toBe(124);
		// Must not wait for the force-kill grace after the process is already gone.
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("reports the abort exit code instead of 0", async () => {
		const controller = new AbortController();
		const promise = execCommand(process.execPath, ["-e", STUCK_COMMAND], process.cwd(), {
			signal: controller.signal,
			killGraceMs: 100,
		});
		setTimeout(() => controller.abort(), 100);

		const result = await promise;
		expect(result.killed).toBe(true);
		expect(result.code).toBe(130);
	});

	it("kills immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await execCommand(process.execPath, ["-e", STUCK_COMMAND], process.cwd(), {
			signal: controller.signal,
			killGraceMs: 100,
		});

		expect(result.killed).toBe(true);
		expect(result.code).toBe(130);
	});

	it("keeps the real exit code for a normal exit", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(3);"], process.cwd(), {
			killGraceMs: 100,
		});

		expect(result.killed).toBe(false);
		expect(result.code).toBe(3);
	});

	it("terminates descendants when the command is cancelled", async () => {
		const marker = join(tmpdir(), `myharness-exec-descendant-${process.pid}-${Date.now()}.tmp`);
		const descendant = `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"); process.exit(0); }, 900); setInterval(() => {}, 1000);`;
		const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
		try {
			const result = await execCommand(process.execPath, ["-e", parent], process.cwd(), {
				timeout: 120,
				killGraceMs: 200,
			});
			expect(result.killed).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (existsSync(marker)) rmSync(marker, { force: true });
		}
	});

	// On Windows `kill("SIGTERM")` maps to TerminateProcess, so the escalation path
	// can only be exercised where SIGTERM is a catchable signal.
	it.skipIf(isWindows())("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		const startedAt = Date.now();
		const result = await execCommand(
			process.execPath,
			["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
			process.cwd(),
			{ timeout: 150, killGraceMs: 200 },
		);
		const elapsed = Date.now() - startedAt;

		expect(result.killed).toBe(true);
		expect(result.code).toBe(124);
		// The graceful timeout must have elapsed before the forced kill landed.
		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(elapsed).toBeLessThan(5_000);
	});
});
