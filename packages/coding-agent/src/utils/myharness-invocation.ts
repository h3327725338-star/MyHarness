import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 计算启动 MyHarness 子进程的命令与参数。
 *
 * - 显式入口（MYHARNESS_PROCESS_ENTRY 环境变量；旧 MYHARNESS_CLI_ENTRY 仅作兼容，Benchmark 等测试工具使用）：指向 MyHarness Web
 *   的编译产物（如 dist/web.js），优先级最高，不依赖 process.argv[1]；
 * - 在已打包的 MyHarness 可执行文件（非 node/bun 运行时）中：直接以当前可执行文件运行；
 * - 在 node/bun 源码环境（含 vitest、bun test）中：以当前运行时 + 当前脚本运行；
 * - 其他情况回退到全局 `myharness` 命令。
 */
export function getMyHarnessInvocation(args: string[]): { command: string; args: string[] } {
	const explicitEntry = process.env.MYHARNESS_PROCESS_ENTRY ?? process.env.MYHARNESS_CLI_ENTRY;
	if (explicitEntry && fs.existsSync(explicitEntry)) {
		return { command: process.execPath, args: [explicitEntry, ...args] };
	}

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "myharness", args };
}
