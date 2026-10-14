/**
 * Delegated read-write boundary for Explore sub-agents running inside their own
 * Git worktree. The read-only guard (read-only-guard.ts) restricts *which*
 * commands may run; this guard instead restricts *where* anything may be
 * touched: file tools are jailed to the worktree root, the shell starts and
 * stays inside it, Git may only be used in its read-only inspection form
 * (commit/push/merge/add and history-rewriting or deleting commands are always
 * rejected), and the worker may never dispatch further agents.
 */
import {
	delegatedExecutableOf,
	getAutoReviewCommandTokens,
	isSafeAutoReviewCdCommand,
	isUnsafeDelegatedGitInvocation,
	splitAutoReviewShellSequence,
} from "./read-only-guard.ts";

/**
 * Cross-module helpers referenced through a same-module binding so the
 * `toString()` embedding in the generated extension source never captures
 * loader-rewritten import identifiers (vitest SSR rewrites bare imports in
 * function bodies; module-local bindings stay stable).
 */
const WRITE_GUARD_DEPS = {
	delegatedExecutableOf,
	getAutoReviewCommandTokens,
	isSafeAutoReviewCdCommand,
	isUnsafeDelegatedGitInvocation,
	splitAutoReviewShellSequence,
};

/** Stable marker embedded in every write-guard interception. */
export const WRITE_GUARD_BLOCK_MARKER = "[delegated-write-guard]";

/** Tool names that dispatch further agents; a delegated worker must never run them. */
const WRITE_GUARD_DISPATCH_TOOL_NAMES = new Set(["agent", "workflow", "ultracode"]);

/**
 * Name fragments of dispatch tools, matched as substrings so a renamed or
 * namespaced agent-dispatching tool (future MCP/skill registration) is still
 * rejected here. Mirrors the runtime chokepoint in agent-session.ts.
 */
const WRITE_GUARD_DISPATCH_NAME_FRAGMENTS = [
	"agent",
	"subagent",
	"sub-agent",
	"sub_agent",
	"workflow",
	"ultracode",
	"delegate",
	"dispatch",
];

/** Whether a tool name is an agent-dispatch tool the worker must never run. */
function isWriteGuardDispatchToolName(toolName: string): boolean {
	const normalized = toolName.toLowerCase();
	if (WRITE_GUARD_DISPATCH_TOOL_NAMES.has(normalized)) return true;
	return WRITE_GUARD_DISPATCH_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Input keys whose string values are treated as paths by the file tools. */
const PATH_LIKE_KEYS = new Set(["path", "file_path", "dir", "directory"]);

/** Env var pointing a temp-sandbox worker back at the read-only origin workspace (non-Git fallback). */
const SANDBOX_ORIGIN_ENV = "MYHARNESS_INTERNAL_SANDBOX_ORIGIN";
/** Read-only file tools that may read from the sandbox origin in non-Git fallback mode. */
const SANDBOX_READABLE_TOOLS = new Set(["read", "grep", "find", "ls", "symbols"]);

function getSandboxOrigin(explicitOrigin?: string): string | undefined {
	const raw = explicitOrigin ?? (typeof process !== "undefined" ? process.env?.[SANDBOX_ORIGIN_ENV] : undefined);
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	return raw;
}

/** True when a read path stays inside the sandbox jail or inside the read-only origin workspace. */
function isAllowedSandboxReadPath(candidate: string, root: string, origin?: string): boolean {
	if (isPathWithinJail(candidate, root)) return true;
	const resolvedOrigin = getSandboxOrigin(origin);
	if (resolvedOrigin && isPathWithinJail(candidate, resolvedOrigin)) return true;
	return false;
}

/** Glob-like parameters that must stay relative to the jail root, per tool. */
const GLOB_LIKE_KEYS_BY_TOOL: Record<string, string[]> = { grep: ["glob"], find: ["pattern"] };

/**
 * Executables a read-write worker may never invoke directly: they change the
 * shell location in ways `cd`'s jail check cannot follow, exec inline code
 * that hides further commands, spawn other processes, or reach outside the
 * filesystem (remote shells, script hosts).
 */
const ALWAYS_BLOCKED_EXECUTABLES = new Set([
	"cmd",
	"eval",
	"exec",
	"env",
	"xargs",
	"parallel",
	"source",
	"iex",
	"invoke-expression",
	"invoke-command",
	"add-type",
	"start-process",
	"start-job",
	"new-pssession",
	"set-location",
	"sl",
	"push-location",
	"pop-location",
	"pushd",
	"popd",
	"chdir",
	"start",
	"ssh",
	"scp",
	"sftp",
	"wscript",
	"cscript",
	"mshta",
]);

/** Interpreter inline-code flags; running a script *file* stays allowed. */
const INLINE_CODE_FLAGS_BY_EXECUTABLE: Record<string, string[]> = {
	bash: ["-c"],
	sh: ["-c"],
	zsh: ["-c"],
	dash: ["-c"],
	ksh: ["-c"],
	node: ["-e", "--eval", "-p", "--print"],
	python: ["-c"],
	python3: ["-c"],
	py: ["-c"],
	ruby: ["-e"],
	perl: ["-e"],
	php: ["-r"],
	pwsh: ["-c", "-command", "-encodedcommand"],
	powershell: ["-c", "-command", "-encodedcommand"],
	deno: ["-e", "--eval"],
	bun: ["-e", "--eval"],
};

/** Flags that turn an otherwise-inspection tool into a program runner. */
const BLOCKED_ANYWHERE_TOKENS = new Set([
	"-exec",
	"-execdir",
	"--exec",
	"--exec-batch",
	"-comobject",
	"-encodedcommand",
]);

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

function isDriveAbsolute(value: string): boolean {
	return /^[A-Za-z]:\//.test(value);
}

function isUnixAbsolute(value: string): boolean {
	return value.startsWith("/");
}

function lowerForCompare(value: string): string {
	// Windows path comparison is case-insensitive; normalize the whole candidate.
	return value.toLowerCase();
}

/**
 * Collapse `.`/`..` segments against an absolute base without touching the
 * filesystem, so symlinked paths are not resolved here (documented limitation:
 * the jail is lexical; the worker's own cwd is always inside the jail).
 */
function resolveLexically(raw: string, root: string): string | undefined {
	const value = normalizeSlashes(raw.trim());
	if (value === "") return root;
	if (value.startsWith("~")) return undefined; // home paths are never inside the worktree jail
	if (/\0/.test(value)) return undefined;
	const base = isDriveAbsolute(value) || isUnixAbsolute(value) ? value : `${root}/${value}`;
	const segments: string[] = [];
	for (const segment of normalizeSlashes(base).split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
			else segments.push("..");
			continue;
		}
		segments.push(segment);
	}
	const drive = base.match(/^([A-Za-z]):\//);
	const joined = segments.join("/");
	return drive ? `${drive[1]}:/${joined}` : `/${joined}`;
}

/** True when `candidate` resolves (lexically) to the jail root or something inside it. */
export function isPathWithinJail(candidate: string, root: string): boolean {
	const resolved = resolveLexically(candidate, root);
	const resolvedRoot = resolveLexically(".", root);
	if (resolved === undefined || resolvedRoot === undefined) return false;
	const left = lowerForCompare(resolved);
	const right = lowerForCompare(resolvedRoot);
	return left === right || left.startsWith(`${right}/`);
}

/** Whether a tool input path value points outside the jail. */
export function pathValueEscapesJail(rawPath: unknown, root: string): boolean {
	if (typeof rawPath !== "string") return false;
	const value = rawPath.trim();
	if (value === "") return false; // empty path means the session root itself, which is the jail
	if (value.startsWith("@")) return pathValueEscapesJail(value.slice(1), root);
	return !isPathWithinJail(value, root);
}

function globValueEscapesJail(raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	const value = normalizeSlashes(raw);
	return (
		/(?:^|\/)\.\.(?:\/|$)/.test(value) || isDriveAbsolute(value) || value.startsWith("~/") || value.startsWith("/")
	);
}

function collectValuesByKeys(value: unknown, keys: Set<string>, bucket: string[], depth = 0): void {
	if (depth > 6 || bucket.length > 64) return;
	if (Array.isArray(value)) {
		for (const item of value) collectValuesByKeys(item, keys, bucket, depth + 1);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "string" && keys.has(key)) bucket.push(item);
		else collectValuesByKeys(item, keys, bucket, depth + 1);
	}
}

/** Redirection targets must be the null device, an OS temp path, or inside the jail. */
function unquotedRedirectionTargets(command: string): string[] | undefined {
	const targets: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "=" && command[index + 1] === ">") {
			// PowerShell splatting/operators like `==>` are not shell redirections; skip `>` pairs preceded by `=`.
			index += 1;
			continue;
		}
		if (char !== ">") continue;
		let cursor = index + 1;
		if (command[cursor] === ">") cursor += 1; // `>>` append operator
		while (cursor < command.length && /\s/.test(command[cursor])) cursor += 1;
		const targetMatch = command.slice(cursor).match(/^(?:"([^"]*)"|'([^']*)'|([^\s|;&<>]+))/);
		if (!targetMatch) return undefined;
		const target = targetMatch[1] ?? targetMatch[2] ?? targetMatch[3] ?? "";
		index = cursor + target.length - 1;
		targets.push(target);
	}
	return targets;
}

const ALLOWED_REDIRECT_LITERALS = new Set(["/dev/null", "nul", "$null", "&1", "&2", "1", "2"]);

/**
 * Whether one command token references a path outside the jail (absolute
 * outside paths, home directories, arbitrary environment variables, or
 * relative paths that escape upward). Returns a block reason when it does.
 */
function escapePathTokenReason(rawToken: string, root: string): string | undefined {
	let token = normalizeSlashes(rawToken.trim());
	if (token === "") return undefined;
	if (token.startsWith("@")) return escapePathTokenReason(token.slice(1), root);
	const equals = token.indexOf("=");
	if (token.startsWith("-") && equals > 0) token = normalizeSlashes(token.slice(equals + 1));
	if (token.startsWith("-")) return undefined;
	const lower = token.toLowerCase();
	if (lower === "~" || lower.startsWith("~/")) return `路径指向用户主目录，越出本任务 worktree：${rawToken}`;
	if (
		/^(?:\$env:(?:home|userprofile|appdata|localappdata)|\$home|%userprofile%|%appdata%|%localappdata%)/i.test(lower)
	) {
		return `路径指向用户配置目录，越出本任务 worktree：${rawToken}`;
	}
	// `bash script.sh 2>/dev/null`-style absolute device/temp paths stay allowed.
	if (lower === "/dev/null" || lower === "nul" || lower === "$null") return undefined;
	// Git-Bash style `/c/dir` maps to `C:/dir` before the containment test.
	const gitBashDrive = token.match(/^\/([A-Za-z])(?:\/|$)/);
	if (gitBashDrive) token = `${gitBashDrive[1].toUpperCase()}:/${normalizeSlashes(token).slice(2)}`;
	const isTempConvention = /^\/tmp(?:\/|$)/i.test(token) || /^\/var\/tmp(?:\/|$)/i.test(token);
	if (isDriveAbsolute(token) || isUnixAbsolute(token)) {
		if (isTempConvention && !token.includes("..")) return undefined;
		if (!isPathWithinJail(token, root)) return `命令中的绝对路径越出本任务 worktree：${rawToken}`;
		return undefined;
	}
	// Relative tokens containing `$env:`/`$var` expand to unknown directories.
	if (/\$env:/i.test(lower) && !/^\$env:(?:temp|tmp)(?:[\\/]|$)/i.test(lower)) {
		return `命令中的环境变量路径无法确认留在 worktree 内：${rawToken}`;
	}
	if (token.startsWith("$") && !/^\$(?:null|tmpdir\b)/i.test(token) && token.includes("/")) {
		return `命令中的变量路径无法确认留在 worktree 内：${rawToken}`;
	}
	if (!isPathWithinJail(token, root)) return `命令中的相对路径越出本任务 worktree：${rawToken}`;
	return undefined;
}

function isAllowedRedirectionTarget(target: string, root: string): boolean {
	const value = normalizeSlashes(target.trim());
	if (value === "") return false;
	if (ALLOWED_REDIRECT_LITERALS.has(value.toLowerCase())) return true;
	if (value.startsWith("&")) return /^&[12]$/.test(value);
	if (/^\/tmp(?:\/[A-Za-z0-9@_.-]+)*$/i.test(value) || /^\$TMPDIR(?:\/[A-Za-z0-9@_.-]*)*$/i.test(value)) {
		return !value.includes("..");
	}
	return isPathWithinJail(value, root);
}

function describeShellBlock(command: string, root: string): string | undefined {
	const trimmed = command.trim();
	if (trimmed === "") return "命令为空";
	if (trimmed.includes("`") || /\$\(/.test(trimmed)) return "包含命令替换（反引号或 $(...)）";
	// Normalize fd-dup/PowerShell all-output redirections before splitting so
	// `2>&1` is not mistaken for a background `&` and `&> file` gets scanned.
	const normalizedCommand = trimmed.replace(/(?:\d*)>&(?!&)\s*\d+/g, "").replace(/&>(?!&)/g, ">");
	const segments = WRITE_GUARD_DEPS.splitAutoReviewShellSequence(normalizedCommand);
	if (!segments) return "包含无法安全解析的 shell 组合（如 ||、子 shell、输入重定向 <）";
	for (const segmentRaw of segments) {
		const segment = segmentRaw.trim();
		const tokens = WRITE_GUARD_DEPS.getAutoReviewCommandTokens(segment) ?? [];
		const executable = WRITE_GUARD_DEPS.delegatedExecutableOf(segment);
		if (ALWAYS_BLOCKED_EXECUTABLES.has(executable)) {
			return `读写子代理禁止直接运行 ${executable}：它可能切换工作目录、执行内联代码、启动进程或访问 worktree 之外；在 worktree 内切换目录请用 cd，运行测试请直接调用测试命令`;
		}
		const inlineFlags = INLINE_CODE_FLAGS_BY_EXECUTABLE[executable];
		if (inlineFlags && tokens.some((token) => inlineFlags.includes(token.toLowerCase()))) {
			return `${executable} 的内联代码参数（如 ${inlineFlags[0]}）被禁止：请把逻辑写进 worktree 内的脚本文件再运行脚本`;
		}
		if (tokens.some((token) => BLOCKED_ANYWHERE_TOKENS.has(token.toLowerCase()))) {
			return "命令包含可执行外部程序或改写执行目标的参数（-exec/--exec/-EncodedCommand/-ComObject 等），已拒绝";
		}
		if (executable === "git") {
			if (WRITE_GUARD_DEPS.isUnsafeDelegatedGitInvocation(segment)) {
				const sub = tokens.slice(1).find((token) => !token.startsWith("-") && token !== "--no-pager") ?? "?";
				return `git ${sub} 不在允许范围：读写子代理禁止 commit、push、merge、add、reset、clean、checkout、switch、branch/tag 写操作、stash、rebase、worktree 变更等改变仓库状态或历史的命令（这些不能通过任何选项解锁）`;
			}
		} else if (executable === "cd") {
			if (tokens.length === 1) return "cd 必须带明确的目标目录（裸 cd 会跳到用户主目录）";
			if (!WRITE_GUARD_DEPS.isSafeAutoReviewCdCommand(segment)) return "cd 目标包含通配符、变量或无法安全解析";
			const target = tokens[1] ?? "";
			if (target && !isPathWithinJail(target, root)) return `cd 目标越出 worktree：${target}`;
		}
		for (const token of tokens) {
			const reason = escapePathTokenReason(token, root);
			if (reason) return reason;
		}
	}
	const targets = unquotedRedirectionTargets(normalizedCommand);
	if (!targets) return "包含无法解析的重定向";
	for (const target of targets) {
		if (!isAllowedRedirectionTarget(target, root)) return `重定向目标越出 worktree：${target}`;
	}
	return undefined;
}

/**
 * Pure decision function for one delegated write-mode tool call.
 * Returns a human-readable block reason, or undefined when the call is allowed.
 * `root` is the worker's worktree directory (normally process.cwd()).
 */
export function evaluateDelegatedWriteToolCall(
	toolName: string,
	input: Record<string, unknown> | undefined,
	root: string,
	origin?: string,
): string | undefined {
	const normalized = toolName.toLowerCase();
	if (isWriteGuardDispatchToolName(normalized)) {
		return "读写子代理不能派发子代理（agent、workflow、ultracode 及同类派发工具都被禁止）";
	}
	const args = (input ?? {}) as Record<string, unknown>;
	if (normalized === "bash" || normalized === "pwsh") {
		if (args.run_in_background === true || args.preserve_state === true) {
			return "子智能体会话禁止使用 run_in_background 或 preserve_state 参数";
		}
		const command = typeof args.command === "string" ? args.command : "";
		return describeShellBlock(command, root);
	}
	const pathValues: string[] = [];
	collectValuesByKeys(args, PATH_LIKE_KEYS, pathValues);
	const mayReadOrigin = SANDBOX_READABLE_TOOLS.has(normalized);
	for (const value of pathValues) {
		if (mayReadOrigin) {
			if (typeof value !== "string" || value.trim() === "") continue;
			const stripped = value.trim().startsWith("@") ? value.trim().slice(1) : value;
			if (!isAllowedSandboxReadPath(stripped, root, origin)) return `路径越出本任务 worktree：${value}`;
			continue;
		}
		if (pathValueEscapesJail(value, root)) return `路径越出本任务 worktree：${value}`;
	}
	const globKeys = GLOB_LIKE_KEYS_BY_TOOL[normalized];
	if (globKeys) {
		const globValues: string[] = [];
		collectValuesByKeys(args, new Set(globKeys), globValues);
		for (const value of globValues) {
			if (globValueEscapesJail(value)) return `搜索匹配参数越出本任务 worktree：${value}`;
		}
	}
	return undefined;
}

/**
 * Generate the delegated write guard extension source. It runs inside the
 * worker process, where the session cwd is already the task's own worktree.
 */
export function createDelegatedWriteGuardExtensionSource(): string {
	return `const WRITE_GUARD_BLOCK_MARKER = ${JSON.stringify(WRITE_GUARD_BLOCK_MARKER)};
const WRITE_GUARD_DISPATCH_TOOL_NAMES = new Set(${JSON.stringify([...WRITE_GUARD_DISPATCH_TOOL_NAMES])});
const WRITE_GUARD_DISPATCH_NAME_FRAGMENTS = ${JSON.stringify(WRITE_GUARD_DISPATCH_NAME_FRAGMENTS)};
const PATH_LIKE_KEYS = new Set(${JSON.stringify([...PATH_LIKE_KEYS])});
const GLOB_LIKE_KEYS_BY_TOOL = ${JSON.stringify(GLOB_LIKE_KEYS_BY_TOOL)};
const ALWAYS_BLOCKED_EXECUTABLES = new Set(${JSON.stringify([...ALWAYS_BLOCKED_EXECUTABLES])});
const INLINE_CODE_FLAGS_BY_EXECUTABLE = ${JSON.stringify(INLINE_CODE_FLAGS_BY_EXECUTABLE)};
const BLOCKED_ANYWHERE_TOKENS = new Set(${JSON.stringify([...BLOCKED_ANYWHERE_TOKENS])});
const delegatedExecutableOf = ${delegatedExecutableOf.toString()};
const getAutoReviewCommandTokens = ${getAutoReviewCommandTokens.toString()};
const isSafeAutoReviewCdCommand = ${isSafeAutoReviewCdCommand.toString()};
const isUnsafeDelegatedGitInvocation = ${isUnsafeDelegatedGitInvocation.toString()};
const splitAutoReviewShellSequence = ${splitAutoReviewShellSequence.toString()};
const WRITE_GUARD_DEPS = {
  delegatedExecutableOf,
  getAutoReviewCommandTokens,
  isSafeAutoReviewCdCommand,
  isUnsafeDelegatedGitInvocation,
  splitAutoReviewShellSequence,
};
const SANDBOX_ORIGIN_ENV = "MYHARNESS_INTERNAL_SANDBOX_ORIGIN";
const SANDBOX_READABLE_TOOLS = new Set(["read", "grep", "find", "ls", "symbols"]);
const getSandboxOrigin = ${getSandboxOrigin.toString()};
const isAllowedSandboxReadPath = ${isAllowedSandboxReadPath.toString()};
const normalizeSlashes = ${normalizeSlashes.toString()};
const isDriveAbsolute = ${isDriveAbsolute.toString()};
const isUnixAbsolute = ${isUnixAbsolute.toString()};
const lowerForCompare = ${lowerForCompare.toString()};
const resolveLexically = ${resolveLexically.toString()};
const isPathWithinJail = ${isPathWithinJail.toString()};
const pathValueEscapesJail = ${pathValueEscapesJail.toString()};
const globValueEscapesJail = ${globValueEscapesJail.toString()};
const collectValuesByKeys = ${collectValuesByKeys.toString()};
const unquotedRedirectionTargets = ${unquotedRedirectionTargets.toString()};
const ALLOWED_REDIRECT_LITERALS = new Set(${JSON.stringify([...ALLOWED_REDIRECT_LITERALS])});
const escapePathTokenReason = ${escapePathTokenReason.toString()};
const isAllowedRedirectionTarget = ${isAllowedRedirectionTarget.toString()};
const describeShellBlock = ${describeShellBlock.toString()};
const isWriteGuardDispatchToolName = ${isWriteGuardDispatchToolName.toString()};
const evaluateDelegatedWriteToolCall = ${evaluateDelegatedWriteToolCall.toString()};

export default function (pi) {
  pi.on("tool_call", async (event) => {
    const root = typeof process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE === "string" && process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE !== "" ? process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE : process.cwd();
    const origin = typeof process.env[SANDBOX_ORIGIN_ENV] === "string" && process.env[SANDBOX_ORIGIN_ENV] !== "" ? process.env[SANDBOX_ORIGIN_ENV] : undefined;
    const reason = evaluateDelegatedWriteToolCall(event.toolName, event.input, root, origin);
    if (reason !== undefined) {
      return { block: true, reason: WRITE_GUARD_BLOCK_MARKER + " 已拦截：" + reason + "。请改用允许的方式完成任务，并在最终报告中如实说明被拦截的操作；不要尝试绕过。" };
    }
  });
}`;
}
