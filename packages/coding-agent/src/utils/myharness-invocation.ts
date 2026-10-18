import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 计算启动 MyHarness 子进程的命令与参数。
 *
 * - 显式入口（MYHARNESS_PROCESS_ENTRY 环境变量；旧 MYHARNESS_CLI_ENTRY 仅作兼容，Benchmark 等测试工具使用）：指向 MyHarness Web
 *   的编译产物（如 dist/web.js），优先级最高，不依赖 process.argv[1]；
 * - 在已打包的 MyHarness 可执行文件（非 node/bun 运行时）中：直接以当前可执行文件运行；
 * - 在 node/bun 源码环境（含 vitest、bun test）中：以当前运行时 + 父进程的启动开关（process.execArgv，如
 *   `--import scripts/dev-fast-loader.mjs`，相对路径会先解析成绝对路径）+ 当前脚本运行，保证子进程与父进程加载同一套代码；
 * - 其他情况回退到全局 `myharness` 命令。
 */

/** URLs and absolute paths are already cwd-independent; everything else may be a cwd-relative path. */
function isCwdRelativePath(spec: string): boolean {
	return !/^[a-z][a-z0-9+.-]*:\//i.test(spec) && !path.isAbsolute(spec);
}

/**
 * A path relative to the parent's cwd (like `scripts/dev-fast-loader.mjs`, or a relative `process.argv[1]`) would
 * resolve against the *child's* cwd once forwarded - and sub-agent children spawn in the task's workspace, not the
 * parent's. A bare package specifier (`--import tsx`) is not a path and stays untouched. Existing files become
 * absolute (Node requires `--import` to receive a file:// URL on Windows; `--require` takes a plain path);
 * anything else is passed through unchanged so the child reports the same error the parent would.
 */
function absolutizeIfRelativePath(spec: string, as: "url" | "path"): string {
	if (!spec || !isCwdRelativePath(spec) || !/[/\\]|^[.~]/.test(spec)) return spec;
	const resolved = path.resolve(process.cwd(), spec);
	if (!fs.existsSync(resolved)) return spec;
	return as === "url" ? pathToFileURL(resolved).href : resolved;
}

/** Rewrite the file specifiers of `--import`/`--require` (both the `--flag value` and the `--flag=value` form). */
function absolutizeRuntimeFlags(flags: string[]): string[] {
	const out: string[] = [];
	for (let index = 0; index < flags.length; index++) {
		const flag = flags[index]!;
		const inline = /^--(import|require)=/.exec(flag);
		if (inline) {
			const as = inline[1] === "import" ? "url" : "path";
			out.push(
				`${flag.slice(0, inline[0].length - 1)}=${absolutizeIfRelativePath(flag.slice(inline[0].length), as)}`,
			);
		} else if ((flag === "--import" || flag === "--require") && index + 1 < flags.length) {
			out.push(flag, absolutizeIfRelativePath(flags[++index]!, flag === "--import" ? "url" : "path"));
		} else {
			out.push(flag);
		}
	}
	return out;
}

export function getMyHarnessInvocation(args: string[]): { command: string; args: string[] } {
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	// Flags that come before the script path (process.execArgv) decide how the runtime resolves the workspace: the
	// Windows dev launcher starts the app with `node --import scripts/dev-fast-loader.mjs packages/coding-agent/src/web.ts`, and that
	// loader rewrites every `@myharness/*` specifier to the current sources. A spawned child that loses the flags
	// resolves the same specifiers through package.json to the compiled dist instead, so it either runs a different
	// version than the parent or crashes at module-link time when the sources import something the dist predates.
	// The child must start with exactly the parent's runtime flags (the same rule the web restart path follows in
	// modes/web/web-mode.ts, which restarts inside the parent's cwd; sub-agent children may run in another
	// workspace, so cwd-relative file specifiers are made absolute here). Packaged executables take their runtime
	// with them and accept no Node flags.
	const runtimeFlags = isGenericRuntime ? absolutizeRuntimeFlags([...process.execArgv]) : [];

	const explicitEntry = process.env.MYHARNESS_PROCESS_ENTRY ?? process.env.MYHARNESS_CLI_ENTRY;
	if (explicitEntry && fs.existsSync(explicitEntry)) {
		return { command: process.execPath, args: [...runtimeFlags, path.resolve(explicitEntry), ...args] };
	}

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [...runtimeFlags, path.resolve(currentScript), ...args] };
	}

	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "myharness", args };
}
