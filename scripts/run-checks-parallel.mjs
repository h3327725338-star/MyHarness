#!/usr/bin/env node
/**
 * 并行运行 `npm run check` 中除 biome --write 之外的只读检查。
 *
 * 前提：biome check --write 必须先于本脚本完成（见根 package.json 的 check 脚本），
 * 避免并发读取正在被 biome 改写的源文件。
 *
 * 与旧的串行 npm run 链相比：
 * - 直接调用 node/tsgo，跳过 6 个 `npm run` 包装进程（Windows 上每个约 0.3-1s 额外开销）；
 * - 所有检查并行执行，总耗时从各项之和变为最长单项；
 * - tsgo 使用 --incremental（tsbuildinfo 已被 .gitignore 覆盖，不会进入提交）。
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";

// 本脚本始终以仓库根为工作目录运行（无论从何处被调用）。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 确保裸终端直接运行时也能找到 tsgo（npm script 环境会自动注入 node_modules/.bin）。
const binDir = join(repoRoot, "node_modules", ".bin");
const pathSeparator = isWindows ? ";" : ":";
if (!process.env.PATH?.split(pathSeparator).includes(binDir)) {
	process.env.PATH = `${binDir}${pathSeparator}${process.env.PATH ?? ""}`;
}

// 宽松超时，仅用于防止子进程永久挂起导致提交无反馈。
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

const steps = [
	{ name: "pinned-deps", cmd: "node scripts/check-pinned-deps.mjs" },
	{ name: "ts-imports", cmd: "node scripts/check-ts-relative-imports.mjs" },
	{ name: "shrinkwrap", cmd: "node scripts/generate-coding-agent-shrinkwrap.mjs --check" },
	{ name: "install-lock", cmd: "node scripts/generate-coding-agent-install-lock.mjs --check" },
	// --preserveSymlinks：pnpm 布局的 node_modules 用 junction 链接 .pnpm store，
	// tsgo 按真实路径解析时无法从 @types/node 内部解析 undici-types，导致大量
	// Response/Headers 类型错误（npm 布局无此问题，该参数在 npm 布局下为无害空操作）。
	{ name: "tsgo", cmd: "tsgo --noEmit --incremental --preserveSymlinks" },
	{ name: "browser-smoke", cmd: "node scripts/check-browser-smoke.mjs" },
];

const results = new Map();

function terminateProcessTree(child) {
	const pid = child.pid;
	if (!pid) {
		try {
			child.kill("SIGKILL");
		} catch {
			// The process exited between the timeout and the fallback kill.
		}
		return Promise.resolve();
	}

	if (isWindows) {
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// The process may already have exited.
				}
				finish();
			}, 5_000);
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", finish);
			killer.once("close", finish);
		});
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// The process may already have exited.
		}
	}
	return Promise.resolve();
}

function runStep(step) {
	return new Promise((resolve) => {
		const child = spawn(step.cmd, {
			shell: true,
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: !isWindows,
		});
		const chunks = [];
		const append = (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);

		let settled = false;
		const settle = (code, output) => {
			if (settled) return;
			settled = true;
			results.set(step.name, { code, output });
			resolve();
		};

		child.on("error", (error) => {
			settle(1, `\n[spawn error] ${error.message}\n`);
		});
		child.on("close", (code) => {
			settle(code ?? 1, Buffer.concat(chunks).toString("utf-8"));
		});

		const timer = setTimeout(() => {
			void terminateProcessTree(child).finally(() => {
				settle(1, `\n[timeout] ${step.name} exceeded ${STEP_TIMEOUT_MS / 1000}s and was killed with its process tree.\n`);
			});
		}, STEP_TIMEOUT_MS);
		child.on("close", () => clearTimeout(timer));
	});
}

await Promise.all(steps.map(runStep));

let failed = false;
for (const step of steps) {
	const result = results.get(step.name);
	const prefix = result.code === 0 ? "\u2713" : "\u2717";
	console.log(`\n[${prefix} ${step.name}] (exit ${result.code})`);
	if (result.output.trim()) {
		const indented = result.output
			.trimEnd()
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n");
		console.log(indented);
	}
	if (result.code !== 0) failed = true;
}

if (failed) {
	console.error("\nSome checks failed. Please fix the errors before committing.");
	process.exit(1);
}
console.log("\nAll checks passed!");
