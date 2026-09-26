/**
 * Explain Git failures that are caused by specific working-tree paths.
 *
 * Git reports these as `invalid path`, `unable to add`, `open(...)` or
 * permission errors. Callers keep the raw Git output; this module only adds a
 * plain-language explanation and never proposes deleting files automatically.
 */

export type GitProblemPathReason =
	| "windows-reserved-name"
	| "invalid-path"
	| "nested-repository"
	| "permission-denied"
	| "unreadable";

export interface GitProblemPath {
	path: string;
	reason: GitProblemPathReason;
}

// Windows device names are reserved in every directory and with any extension
// (`nul`, `NUL.txt`, `com1.log`); trailing dots/spaces are also stripped by Win32.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

const PATH_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: GitProblemPathReason }> = [
	{ pattern: /invalid path '([^']+)'/g, reason: "invalid-path" },
	{ pattern: /'([^']+)' does not have a commit checked out/g, reason: "nested-repository" },
	{ pattern: /unable to add '([^']+)' to index/g, reason: "unreadable" },
	{ pattern: /unable to index file '([^']+)'/g, reason: "unreadable" },
	{ pattern: /short read while indexing (\S.*)$/gm, reason: "unreadable" },
	{ pattern: /open\("([^"]+)"\): Permission denied/g, reason: "permission-denied" },
	{ pattern: /could not open directory '([^']+)': Permission denied/g, reason: "permission-denied" },
	{ pattern: /unable to stat '([^']+)'/g, reason: "unreadable" },
];

export function isWindowsReservedPathSegment(segment: string): boolean {
	const trimmed = segment.replace(/[. ]+$/u, "");
	return WINDOWS_RESERVED_NAME.test(trimmed);
}

function classifyPath(path: string, fallback: GitProblemPathReason): GitProblemPathReason {
	const segments = path.split(/[\\/]/u).filter(Boolean);
	if (segments.some(isWindowsReservedPathSegment)) return "windows-reserved-name";
	return fallback;
}

/** Collect the working-tree paths that Git named in its error output. */
export function extractGitProblemPaths(output: string): GitProblemPath[] {
	const byPath = new Map<string, GitProblemPath>();
	for (const { pattern, reason } of PATH_PATTERNS) {
		for (const match of output.matchAll(pattern)) {
			const path = match[1]?.trim();
			if (!path) continue;
			const classified = classifyPath(path, reason);
			const existing = byPath.get(path);
			// Keep the most specific explanation reported for a path.
			if (!existing || existing.reason === "unreadable") byPath.set(path, { path, reason: classified });
		}
	}
	return [...byPath.values()];
}

const REASON_LABELS: Record<GitProblemPathReason, string> = {
	"windows-reserved-name": "文件名是 Windows 保留设备名（如 NUL、CON、COM1），Windows 上的 Git 无法把它加入索引",
	"invalid-path": "Git 认为这个路径在当前系统上无效",
	"nested-repository": "这是一个还没有任何提交的嵌套 Git 仓库，外层仓库无法把它加入索引",
	"permission-denied": "没有读取权限",
	unreadable: "Git 无法读取这个文件",
};

/**
 * Describe path-specific Git failures for the user.
 * Returns undefined when the output does not name a problematic path.
 */
export function describeGitPathFailure(output: string): string | undefined {
	const problems = extractGitProblemPaths(output);
	if (problems.length === 0) return undefined;
	const shown = problems.slice(0, 5);
	const lines = [
		"原因分析：以下工作区路径导致 Git 命令失败：",
		...shown.map((problem) => `- ${problem.path}：${REASON_LABELS[problem.reason]}`),
		...(problems.length > shown.length ? [`- 另有 ${problems.length - shown.length} 个路径`] : []),
		"MyHarness 不会自动删除或改动这些文件。确认来源后可手动重命名、删除，或加入 .gitignore。",
	];
	if (problems.some((problem) => problem.reason === "windows-reserved-name")) {
		lines.push(
			"提示：这类文件常由命令行误把输出重定向到 nul 产生；Windows 上需要用 \\\\?\\ 前缀的完整路径才能删除。",
		);
	}
	return lines.join("\n");
}
