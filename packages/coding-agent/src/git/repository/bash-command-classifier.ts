/**
 * Conservative Bash mutation classifier for the main Agent.
 *
 * This classifier is intentionally narrower than the Auto Review command
 * boundary. It is only used to decide whether a Bash call needs a Git
 * checkpoint snapshot before execution. A false negative costs performance;
 * a false positive would remove the protection that makes restoration safe.
 * Therefore anything that cannot be statically proven read-only is rejected.
 */

import {
	lexShellSegment,
	type ShellWordToken,
	splitShellCommandSegments,
	stripStaticShellPrefixes,
} from "../../utils/shell-command-lexer.ts";

export type BashCommandRisk = "read-only" | "unknown" | "mutating";

export interface BashCommandClassification {
	risk: BashCommandRisk;
	reason: string;
	segments: readonly string[];
}

const READ_ONLY_COMMANDS = new Set([
	"cat",
	"cmp",
	"cut",
	"diff",
	"dir",
	"dirname",
	"echo",
	"false",
	"file",
	"find",
	"fold",
	"head",
	"ls",
	"more",
	"od",
	"paste",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"rev",
	"rg",
	"grep",
	"seq",
	"sort",
	"stat",
	"strings",
	"tail",
	"test",
	"tree",
	"tr",
	"true",
	"type",
	"uniq",
	"uname",
	"uptime",
	"wc",
	"where",
	"which",
]);

const READ_ONLY_VERSION_COMMANDS = new Set(["node -v", "node --version", "python --version", "python3 --version"]);

const SAFE_FIND_FLAGS = new Set([
	"-H",
	"-L",
	"-P",
	"-O",
	"-D",
	"-xdev",
	"-mount",
	"-depth",
	"-daystart",
	"-ignore_readdir_race",
	"-noignore_readdir_race",
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-regextype",
	"-type",
	"-xtype",
	"-size",
	"-amin",
	"-atime",
	"-anewer",
	"-cmin",
	"-ctime",
	"-cnewer",
	"-mmin",
	"-mtime",
	"-newer",
	"-newermt",
	"-newerxy",
	"-user",
	"-uid",
	"-group",
	"-gid",
	"-perm",
	"-links",
	"-inum",
	"-samefile",
	"-fstype",
	"-empty",
	"-readable",
	"-writable",
	"-executable",
	"-maxdepth",
	"-mindepth",
	"-prune",
	"-print",
	"-print0",
	"-printf",
	"-ls",
	"-o",
	"-or",
	"-a",
	"-and",
	"!",
	"-not",
	"(",
	")",
]);

const SAFE_GREP_FLAGS = new Set([
	"-a",
	"--text",
	"-b",
	"--byte-offset",
	"-c",
	"--count",
	"--color",
	"--colour",
	"-E",
	"--extended-regexp",
	"-F",
	"--fixed-strings",
	"-h",
	"--no-filename",
	"-H",
	"--with-filename",
	"-i",
	"--ignore-case",
	"-l",
	"--files-with-matches",
	"-L",
	"--files-without-match",
	"-n",
	"--line-number",
	"-o",
	"--only-matching",
	"-q",
	"--quiet",
	"-r",
	"-R",
	"--recursive",
	"-s",
	"--no-messages",
	"-v",
	"--invert-match",
	"-w",
	"--word-regexp",
	"-x",
	"--line-regexp",
	"-e",
	"--regexp",
	"-f",
	"--file",
	"-A",
	"-B",
	"-C",
	"--after-context",
	"--before-context",
	"--context",
	"--include",
	"--exclude",
	"--exclude-dir",
	"--exclude-from",
	"--binary-files",
	"--label",
	"--max-count",
	"-m",
	"--null",
	"--null-data",
	"--line-buffered",
	"--no-ignore",
	"--hidden",
	"--glob",
	"-g",
	"--type",
	"-t",
	"--type-not",
	"-T",
	"--type-list",
	"--stats",
	"--heading",
	"--no-heading",
	"--column",
	"--no-column",
	"--smart-case",
	"-S",
	"--case-sensitive",
	"--json",
]);

const SAFE_GENERIC_FLAGS = new Set([
	"-a",
	"-b",
	"-c",
	"-d",
	"-f",
	"-h",
	"-i",
	"-l",
	"-n",
	"-q",
	"-r",
	"-R",
	"-s",
	"-t",
	"-u",
	"-v",
	"-x",
	"-A",
	"-B",
	"-C",
	"-F",
	"-L",
	"-P",
	"-T",
	"-V",
	"--all",
	"--bytes",
	"--color",
	"--format",
	"--help",
	"--human-readable",
	"--ignore-case",
	"--line-number",
	"--long",
	"--max-depth",
	"--name",
	"--number",
	"--recursive",
	"--show-all",
	"--show-ends",
	"--show-nonprinting",
	"--show-tabs",
	"--short",
	"--version",
	"--verbose",
	"--width",
	"--zero-terminated",
]);

const FIND_DANGEROUS_FLAGS = /^(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint\d*|-fls|-fprintf)$/i;
const GENERIC_DANGEROUS_FLAGS =
	/(?:^|[-_])(delete|exec|execdir|in-place|output|write|install|remove|replace|pre)(?:[-_=]|$)/i;

function executableName(token: ShellWordToken | undefined): string | undefined {
	if (!token || token.hasDynamicExpansion) return undefined;
	if (token.value.includes("/") || token.value.includes("\\")) return undefined;
	return token.value.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function optionName(token: string): string {
	const equals = token.indexOf("=");
	return (equals === -1 ? token : token.slice(0, equals)).toLowerCase();
}

function isCombinedShortFlag(token: string, allowed: Set<string>): boolean {
	if (!/^-[A-Za-z]+$/.test(token) || token.length < 3) return false;
	return [...token.slice(1)].every((char) => allowed.has(`-${char}`));
}

function validateFlagSet(args: readonly ShellWordToken[], safeFlags: Set<string>, shortFlags: Set<string>): boolean {
	for (const token of args) {
		if (token.hasDynamicExpansion) return false;
		if (!token.value.startsWith("-") || token.value === "-") continue;
		if (token.value === "--") continue;
		const name = optionName(token.value);
		if (name === "--compress-program") return false;
		if (GENERIC_DANGEROUS_FLAGS.test(name)) return false;
		if (safeFlags.has(name)) continue;
		if (isCombinedShortFlag(token.value, shortFlags)) continue;
		return false;
	}
	return true;
}

function validateFind(args: readonly ShellWordToken[]): boolean {
	for (const token of args) {
		if (token.hasDynamicExpansion) return false;
		if (!token.value.startsWith("-")) continue;
		if (FIND_DANGEROUS_FLAGS.test(token.value)) return false;
		if (SAFE_FIND_FLAGS.has(optionName(token.value))) continue;
		return false;
	}
	return true;
}

function validateGrep(executable: string, args: readonly ShellWordToken[]): boolean {
	for (const token of args) {
		if (token.hasDynamicExpansion) return false;
		if (!token.value.startsWith("-") || token.value === "-") continue;
		if (token.value === "--") continue;
		const name = optionName(token.value);
		if (GENERIC_DANGEROUS_FLAGS.test(name) || name === "--pre" || name === "--pre-glob" || name === "--replace")
			return false;
		if (SAFE_GREP_FLAGS.has(name)) continue;
		if (executable === "rg" && (name === "--engine" || name === "--threads" || name === "--max-columns")) continue;
		if (isCombinedShortFlag(token.value, SAFE_GREP_FLAGS)) continue;
		return false;
	}
	return true;
}

/**
 * Only the narrow exit-status read (`$?`) may expand dynamically: it reflects
 * the previous command's exit code and cannot mutate any state. Every other
 * variable / command-substitution expansion stays rejected.
 */
function isNarrowExitStatusRead(executable: string, segment: string): boolean {
	if (executable === "echo") {
		return /^echo\s+(?:"\$\?"|'\$\?'|\$\?)\s*$/u.test(segment);
	}
	if (executable === "printf") {
		return /^printf\s+(?:"%s\\n"|'%s\\n'|%s\\n)\s+(?:"\$\?"|'\$\?'|\$\?)\s*$/u.test(segment);
	}
	return false;
}

function validateCommand(segment: string): {
	ok: boolean;
	executable?: string;
	hasGit: boolean;
	hasCd: boolean;
	reason?: string;
} {
	const lexical = lexShellSegment(segment);
	if (!lexical || lexical.words.length === 0)
		return { ok: false, hasGit: false, hasCd: false, reason: "命令无法解析" };
	if (lexical.hasFileRedirection || lexical.hasUnresolvedRedirection) {
		return { ok: false, hasGit: false, hasCd: false, reason: "包含文件重定向" };
	}
	// `!` and `time`/`time -p` only affect pipeline exit status or timing; the
	// real executable behind them decides the risk.
	const prefix = stripStaticShellPrefixes(lexical.words);
	const tokens = prefix.remainingWords;
	const executable = executableName(tokens[0]);
	if (tokens.some((token) => token.hasDynamicExpansion)) {
		if (executable !== undefined && isNarrowExitStatusRead(executable, segment)) {
			return { ok: true, executable, hasGit: false, hasCd: false };
		}
		return { ok: false, hasGit: false, hasCd: false, reason: "包含变量、通配符或动态展开" };
	}
	if (executable === undefined) {
		return { ok: false, hasGit: false, hasCd: false, reason: "命令名称不是固定的可执行文件" };
	}
	const args = tokens.slice(1);
	if (executable === "git") {
		// Git 命令不再维护只读白名单。无法静态证明只读时按潜在修改处理：
		// checkpoint 在首次可能修改前创建，之后 Git 自由执行，不再被语义证明阻止。
		return { ok: false, executable, hasGit: true, hasCd: false, reason: "Git 参数不是确定的只读形式" };
	}
	if (executable === "cd") {
		return {
			ok: args.length === 1 && !args[0]?.value.startsWith("-"),
			executable,
			hasGit: false,
			hasCd: true,
			reason: "cd 路径不是固定的只读形式",
		};
	}
	if (READ_ONLY_VERSION_COMMANDS.has([executable, args[0]?.value].filter(Boolean).join(" "))) {
		return { ok: args.length === 1, executable, hasGit: false, hasCd: false, reason: "版本查询参数不符合白名单" };
	}
	if (!READ_ONLY_COMMANDS.has(executable)) {
		return { ok: false, executable, hasGit: false, hasCd: false, reason: "命令不在主 Agent 只读白名单" };
	}

	if (executable === "find") {
		return {
			ok: validateFind(args),
			executable,
			hasGit: false,
			hasCd: false,
			reason: "find 含有可能写入或执行程序的参数",
		};
	}
	if (executable === "grep" || executable === "rg") {
		return {
			ok: validateGrep(executable, args),
			executable,
			hasGit: false,
			hasCd: false,
			reason: "搜索命令含有未知或危险参数",
		};
	}
	if (executable === "head" || executable === "tail") {
		return {
			ok: args.every((token) => {
				if (token.hasDynamicExpansion) return false;
				if (/^-\d+$/.test(token.value)) return true;
				if (!token.value.startsWith("-") || token.value === "-") return true;
				return new Set(["-n", "--lines", "-c", "--bytes", "-q", "--quiet", "-v", "--verbose"]).has(
					optionName(token.value),
				);
			}),
			executable,
			hasGit: false,
			hasCd: false,
			reason: `${executable} 含有未知参数`,
		};
	}
	if (executable === "sort") {
		return {
			ok: validateFlagSet(
				args,
				new Set([
					"-b",
					"-d",
					"-f",
					"-g",
					"-h",
					"-n",
					"-M",
					"-r",
					"-R",
					"-s",
					"-t",
					"-k",
					"--batch",
					"--field-separator",
					"--ignore-case",
					"--key",
					"--numeric-sort",
					"--reverse",
					"--stable",
					"--unique",
				]),
				new Set(["-b", "-d", "-f", "-g", "-h", "-n", "-r", "-R", "-s", "-u"]),
			),
			executable,
			hasGit: false,
			hasCd: false,
			reason: "sort 含有未知或输出文件参数",
		};
	}
	if (executable === "tree") {
		return {
			ok: validateFlagSet(
				args,
				new Set([
					"-a",
					"-d",
					"-f",
					"-h",
					"-i",
					"-L",
					"-P",
					"-I",
					"--dirsfirst",
					"--noreport",
					"--charset",
					"--filelimit",
				]),
				new Set(["-a", "-d", "-f", "-i"]),
			),
			executable,
			hasGit: false,
			hasCd: false,
			reason: "tree 含有未知或输出文件参数",
		};
	}
	if (executable === "echo" || executable === "printf" || executable === "test") {
		return { ok: true, executable, hasGit: false, hasCd: false };
	}

	return {
		ok: validateFlagSet(args, SAFE_GENERIC_FLAGS, SAFE_GENERIC_FLAGS),
		executable,
		hasGit: false,
		hasCd: false,
		reason: "命令含有未知参数",
	};
}

export function classifyBashCommand(command: string): BashCommandClassification {
	const scan = splitShellCommandSegments(command);
	if (scan.hasBackgroundExecution) {
		return { risk: "unknown", reason: "包含后台执行或不支持的 Shell 操作符", segments: [] };
	}
	if (scan.reason) {
		return { risk: "unknown", reason: scan.reason, segments: [] };
	}

	let hasGit = false;
	let hasCd = false;
	for (const segment of scan.segments) {
		if (segment.hasGroupingSyntax) {
			return { risk: "unknown", reason: "包含 Shell 分组或子 Shell", segments: [] };
		}
		const result = validateCommand(segment.text);
		if (!result.ok) {
			return {
				risk: "unknown",
				reason: result.reason ?? "命令未通过只读白名单",
				segments: scan.segments.map((item) => item.text),
			};
		}
		hasGit ||= result.hasGit;
		hasCd ||= result.hasCd;
	}
	if (hasGit && hasCd) {
		return {
			risk: "unknown",
			reason: "包含 cd 与 Git 的组合，不能自动跳过 Git 检查点",
			segments: scan.segments.map((segment) => segment.text),
		};
	}
	return {
		risk: "read-only",
		reason: "所有 Shell 子命令和参数都通过只读白名单",
		segments: scan.segments.map((segment) => segment.text),
	};
}

export function isBashCommandReadOnly(command: string): boolean {
	return classifyBashCommand(command).risk === "read-only";
}
