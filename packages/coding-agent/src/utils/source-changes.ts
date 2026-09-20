/**
 * 源码变更检测（Source Change Detection）。
 *
 * 扩展 API 只能热重载配置与扩展（jiti moduleCache: false 每次重新编译），
 * 核心模块（interactive-mode、settings-selector 等）由 tsx 静态加载，
 * ESM import cache 无法在进程内清除，因此核心代码改动必须重启进程才能生效。
 * 本模块用于在扩展触发热重载时检测“进程启动后是否修改过核心源码”，
 * 从而明确提示用户重启，而不是让代码改动静默不生效。
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 核心源码根目录（packages/coding-agent/src，由本文件位置推导）。 */
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src");

const MAX_SCAN_DEPTH = 10;
const DEFAULT_LIMIT = 5;

/**
 * 返回 src 下 mtime 晚于 `sinceMs` 的 .ts 文件（相对 src 的路径，正斜杠）。
 * 用于判断进程启动后核心代码是否被修改。
 *
 * @param sinceMs 基线时间戳（毫秒），通常为进程启动时间
 * @param options.root 覆盖扫描根目录（测试用）；默认推导自本模块位置
 * @param options.limit 最多返回的文件数
 */
export function findRecentlyModifiedSourceFiles(
	sinceMs: number,
	options: { root?: string; limit?: number } = {},
): string[] {
	const root = options.root ?? SOURCE_ROOT;
	const limit = options.limit ?? DEFAULT_LIMIT;
	const found: string[] = [];

	const walk = (dir: string, depth: number): void => {
		if (depth > MAX_SCAN_DEPTH || found.length >= limit) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.length >= limit) return;
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath, depth + 1);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			try {
				if (statSync(fullPath).mtimeMs > sinceMs) {
					found.push(relative(root, fullPath).replace(/\\/g, "/"));
				}
			} catch {
				// 无法 stat（权限/已删除）时忽略该文件。
			}
		}
	};

	walk(root, 0);
	return found;
}
