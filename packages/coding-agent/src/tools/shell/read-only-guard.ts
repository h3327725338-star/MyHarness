/**
 * Delegated（Sub Agent / Explore）会话的只读 Bash 守卫。
 *
 * 这是普通 delegated agent（sub-agent.ts 的 Explore 任务）的 bash 边界，
 * 不是 Auto Review 的安全机制。Auto Review 已不再使用 bash（见 review-check-*）。
 *
 * 安全边界：denylist + read-only allowlist + 可选 AI adjudicator。
 * 注意：AI adjudicator 只用于 delegated 会话的未知只读形状裁决，
 * Auto Review 已不使用任何 AI 安全判决。
 */

import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";

export interface ReadOnlyGuardAiAdjudicatorOptions {
	provider: string;
	model: string;
	timeoutMs?: number;
	maxCalls?: number;
}

const BLOCKED_BASH_PATTERNS: Array<[string, string]> = [
	["\\brm\\b", "i"],
	["\\brmdir\\b", "i"],
	["\\bmv\\b", "i"],
	["\\bcp\\b", "i"],
	["\\bmkdir\\b", "i"],
	["\\btouch\\b", "i"],
	["\\bchmod\\b", "i"],
	["\\bchown\\b", "i"],
	["\\bchgrp\\b", "i"],
	["\\bln\\b", "i"],
	["\\btee\\b", "i"],
	["\\btruncate\\b", "i"],
	["\\bdd\\b", "i"],
	["\\bshred\\b", "i"],
	["\\b(set|add)-content\\b", "i"],
	["\\bout-file\\b", "i"],
	["\\bnew-item\\b", "i"],
	["\\bremove-item\\b", "i"],
	["\\bmove-item\\b", "i"],
	["\\bcopy-item\\b", "i"],
	["\\brename-item\\b", "i"],
	["\\bclear-content\\b", "i"],
	["\\bnpm\\s+(install|uninstall|update|ci|link|publish)", "i"],
	["\\byarn\\s+(add|remove|install|publish)", "i"],
	["\\bpnpm\\s+(add|remove|install|publish)", "i"],
	["\\bpip\\s+(install|uninstall)", "i"],
	["\\bapt(-get)?\\s+(install|remove|purge|update|upgrade)", "i"],
	["\\bbrew\\s+(install|uninstall|upgrade)", "i"],
	[
		"\\bgit\\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|init|clone|clean)",
		"i",
	],
];

function hasExplicitAutoReviewBlockedPattern(command: string, blockedPatterns: Array<[string, string]>): boolean {
	const safetyText = getAutoReviewCommandSafetyText(command);
	const segments = splitAutoReviewShellSequence(safetyText);
	if (!segments) return true;
	return segments.some((segment) => {
		const tokens = getAutoReviewCommandTokens(segment);
		if (!tokens || tokens.length === 0) return true;
		const executable =
			tokens[0]
				.split(/[\\/]/)
				.at(-1)
				?.replace(/\.(?:exe|cmd|bat)$/i, "")
				.toLowerCase() ?? "";
		return blockedPatterns.some(([source, flags]) => {
			const patternInputs = source.includes("\\s") ? [executable, `${executable} ${tokens[1] ?? ""}`] : [executable];
			return patternInputs.some((input) => new RegExp(source, flags).test(input));
		});
	});
}

export function hasHardAutoReviewBashCommand(
	command: string,
	blockedPatterns: Array<[string, string]> = BLOCKED_BASH_PATTERNS,
): boolean {
	const safetyText = getAutoReviewCommandSafetyText(command);
	if (hasExplicitAutoReviewBlockedPattern(command, blockedPatterns)) return true;
	if (hasUnsafeAutoReviewOutputRedirection(command)) return true;
	if (/[`]|\$\(|\$\{/.test(command)) return true;
	if (
		/\bfind\b[^\r\n;&|]*(?:^|\s)-(?:exec|execdir|delete|ok|okdir)\b/i.test(safetyText) ||
		/\b(?:xargs|eval|source)\b/i.test(safetyText) ||
		/\b(?:bash|sh|zsh|cmd|powershell|pwsh)\s+(?:-c|\/c|--command|-command)\b/i.test(safetyText) ||
		/\b(?:curl|wget|invoke-webrequest|invoke-restmethod|ssh|scp|ftp)\b/i.test(safetyText) ||
		/\b(?:writeFileSync|appendFileSync|createWriteStream|unlinkSync|rmSync|mkdirSync|renameSync|chmodSync|chownSync|execSync|execFileSync|spawnSync|child_process)\b/i.test(
			command,
		) ||
		/(?:^|[;&])\s*cd\s+(?:["']?)[^;&\r\n]*\.\.(?:[\\/"']|$)/i.test(command)
	) {
		return true;
	}
	return false;
}

export function isAutoReviewAiAdjudicationCandidate(
	command: string,
	blockedPatterns: Array<[string, string]> = BLOCKED_BASH_PATTERNS,
): boolean {
	if (command.length === 0 || command.length > 12_000 || command.includes("\0")) return false;
	if (hasHardAutoReviewBashCommand(command, blockedPatterns)) return false;
	const normalized = stripAutoReviewDiagnosticRedirections(command);
	if (!normalized) return false;
	const segments = splitAutoReviewShellSequence(normalized);
	if (!segments) return false;
	const allowedExecutables = new Set([
		"awk",
		"cat",
		"cd",
		"diff",
		"echo",
		"file",
		"find",
		"grep",
		"head",
		"ls",
		"od",
		"printf",
		"rg",
		"sed",
		"sort",
		"stat",
		"tail",
		"test",
		"uniq",
		"wc",
		"where",
		"which",
	]);
	return segments.every((segment) => {
		const tokens = getAutoReviewCommandTokens(segment);
		if (!tokens || tokens.length === 0) return false;
		const executable =
			tokens[0]
				.split(/[\\/]/)
				.at(-1)
				?.replace(/\.(?:exe|cmd|bat)$/i, "")
				.toLowerCase() ?? "";
		if (isSafeAutoReviewNodeVersionCommand(segment) || isAutoReviewNodeModuleImportAdjudicationCandidate(segment)) {
			return true;
		}
		if (!allowedExecutables.has(executable)) return false;
		if (executable === "cd") return isSafeAutoReviewCdCommand(segment);
		return true;
	});
}

export function isAutoReviewValidationCommand(command: string): boolean {
	if (/[;&|<>\r\n`]/.test(command) || /\$\(|\$\{/.test(command)) return false;
	const tokens =
		command
			.trim()
			.match(/(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|<>`]+)/g)
			?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
	if (tokens.length === 0) return false;

	let executable =
		tokens
			.shift()!
			.split(/[\\/]/)
			.at(-1)
			?.replace(/\.(?:exe|cmd|bat)$/i, "")
			.toLowerCase() ?? "";
	const args = tokens;
	for (const token of args) {
		if (
			/^(?:--?(?:watch|coverage|fix|write|update(?:snapshot)?|install|prefix|config|output|output-file|outputFile|in-place|delete|exec|script-shell|cache|cache-location))(?:=|$)/i.test(
				token,
			) ||
			/^(?:-u|--watch)$/i.test(token)
		) {
			return false;
		}
	}

	const packageManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
	if (packageManagers.has(executable)) {
		const operation = args[0]?.toLowerCase();
		if (operation === "--version" || operation === "-v" || operation === "version") return true;
		if (operation === "test") return true;
		return (
			operation === "run" &&
			new Set([
				"test",
				"typecheck",
				"type-check",
				"check-types",
				"lint:check",
				"format:check",
				"check:browser-smoke",
				"check:pinned-deps",
				"check:shrinkwrap",
				"check:install-lock:coding-agent",
				"check:ts-imports",
			]).has(args[1]?.toLowerCase() ?? "")
		);
	}

	if (executable === "npx") {
		if (args[0] !== "--no-install") return false;
		args.shift();
		executable =
			args
				.shift()
				?.split(/[\\/]/)
				.at(-1)
				?.replace(/\.(?:exe|cmd|bat)$/i, "")
				.toLowerCase() ?? "";
	}

	if (executable === "node") {
		return args[0]?.toLowerCase() === "--check" || args[0]?.toLowerCase() === "--version" || args[0] === "-v";
	}

	if (executable === "timeout") {
		const seconds = Number(args[0]);
		if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) return false;
		return (
			args[1]?.toLowerCase() === "npx" &&
			args[2]?.toLowerCase() === "tsgo" &&
			args.slice(3).length === 1 &&
			args[3]?.toLowerCase() === "--noemit"
		);
	}

	if (executable === "tsc" || executable === "tsgo") {
		let noEmit = false;
		for (let index = 0; index < args.length; index++) {
			const token = args[index].toLowerCase();
			if (token === "--noemit") {
				if (args[index + 1]?.toLowerCase() === "false") return false;
				noEmit = true;
			}
			if (token === "--noemit=true") noEmit = true;
			if (token === "--noemit=false") return false;
		}
		return noEmit;
	}
	if (executable === "biome") return args[0]?.toLowerCase() === "check";
	if (executable === "eslint") return !args.some((token) => /^--fix(?:=|$)/i.test(token));
	if (executable === "prettier") return args.some((token) => token.toLowerCase() === "--check");
	if (executable === "vitest" || executable === "jest" || executable === "pytest") {
		return !args.some((token) => /^(?:-u|--update(?:snapshot)?|--write|--fix)(?:=|$)/i.test(token));
	}
	if (executable === "cargo") return ["test", "check", "clippy"].includes(args[0]?.toLowerCase() ?? "");
	if (executable === "go") {
		return args[0]?.toLowerCase() === "test" && !args.some((token) => /^-coverprofile(?:=|$)/i.test(token));
	}
	if (executable === "dotnet") return args[0]?.toLowerCase() === "test";
	if (executable === "mvn" || executable === "gradle") {
		return (
			args.some((token) => /^(?:test|check)$/i.test(token)) &&
			!args.some((token) => /^(?:-D?skipTests|--tests?=none)$/i.test(token))
		);
	}

	return false;
}

function hasUnquotedShellSyntax(command: string): boolean {
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
		if (/[;&|<>`\r\n]/.test(char) || (char === "$" && (command[index + 1] === "(" || command[index + 1] === "{"))) {
			return true;
		}
	}
	return Boolean(quote);
}

export function hasUnsafeAutoReviewOutputRedirection(command: string): boolean {
	if (isSafeAutoReviewNullProbeCommand(command)) return false;
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
		if (char !== ">") continue;

		const remainder = command.slice(index + 1);
		if (/^\s*&\s*\d\b/.test(remainder)) continue;
		const match = remainder.match(/^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
		const target = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
		// 允许往平台空设备、临时目录（/tmp 或 $TMPDIR）重定向，供审查员编写临时测试脚本。
		if (/^(?:\/dev\/null|nul\b|\$null\b)/i.test(target)) continue;
		if (/^\$TMPDIR(?:\/|$)/i.test(target)) continue;
		if (/^\/tmp(?:\/|$)/.test(target)) continue;
		return true;
	}

	return false;
}

function isSafeAutoReviewNullOutputCommand(command: string): boolean {
	const tokens = getAutoReviewCommandTokens(command);
	if (!tokens || tokens.length === 0 || hasUnsafeDelegatedBashCommand(command)) return false;
	const executable = tokens[0]
		.split(/[\\/]/)
		.at(-1)
		?.replace(/\.(?:exe|cmd|bat)$/i, "")
		.toLowerCase();
	return ["cat", "diff", "find", "grep", "head", "ls", "rg", "sort", "stat", "tail", "uniq", "wc", "which"].includes(
		executable ?? "",
	);
}

export function getAutoReviewCommandSafetyText(command: string): string {
	const runtimeEval = /\b(?:node|bun|deno|python|python3)\b[^\r\n;&|]*?\s(?:-e|-c|--eval)\s*/gi;
	let result = command;
	let searchFrom = 0;

	while (searchFrom < result.length) {
		runtimeEval.lastIndex = searchFrom;
		const match = runtimeEval.exec(result);
		if (!match) break;
		const argumentStart = match.index + match[0].length;
		const quote = result[argumentStart];
		if (quote !== "'" && quote !== '"') {
			searchFrom = argumentStart + 1;
			continue;
		}

		let escaped = false;
		let argumentEnd = argumentStart + 1;
		for (; argumentEnd < result.length; argumentEnd++) {
			const char = result[argumentEnd];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) break;
		}
		if (argumentEnd >= result.length) {
			searchFrom = argumentStart + 1;
			continue;
		}
		result = `${result.slice(0, argumentStart)}${quote}<inline-script>${quote}${result.slice(argumentEnd + 1)}`;
		searchFrom = argumentStart + "<inline-script>".length + 2;
	}

	return result;
}

export function hasUnsafeDelegatedBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed === "") return true;

	// Do not allow a delegated command to compose another shell operation or
	// redirect output into a file. This also blocks command substitution.
	if (hasUnquotedShellSyntax(trimmed)) return true;

	const firstToken = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
	const executable = (firstToken?.[1] ?? firstToken?.[2] ?? firstToken?.[3] ?? "")
		.split(/[\\/]/)
		.at(-1)
		?.replace(/\.(?:exe|cmd|bat)$/i, "")
		.toLowerCase();
	const readOnlyExecutables = new Set([
		"cat",
		"type",
		"more",
		"head",
		"tail",
		"rg",
		"grep",
		"find",
		"fd",
		"ls",
		"dir",
		"pwd",
		"where",
		"which",
		"stat",
		"wc",
		"diff",
		"sort",
		"uniq",
		"git",
		"get-content",
		"get-childitem",
		"gci",
		"gc",
		"select-string",
		"measure-object",
		"get-location",
		"file",
		"od",
		"cut",
		"tr",
	]);
	if (!executable || !readOnlyExecutables.has(executable)) return true;

	// These options can execute another program or turn an inspection utility
	// into a writer even when the executable itself looks harmless.
	if (
		/(?:^|\s)(?:xargs|--exec|--pre|--replace|--output|--in-place|--delete|--remove|--write|--install)(?:\s|=|$)|(?:^|\s)-exec(?:dir)?(?:\s|$)/i.test(
			trimmed,
		) ||
		/(?:^|\s)-(?:delete|fdelete|fls|fprint|fprintf)(?:\s|$)/i.test(trimmed) ||
		(/(?:^|\s)-o(?:\s|=)/i.test(trimmed) && executable !== "grep" && executable !== "rg")
	) {
		return true;
	}

	if (executable !== "git") return false;

	const tokens = trimmed.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""));
	let subcommandIndex = 1;
	if (tokens[subcommandIndex] === "--no-pager") subcommandIndex += 1;
	while (tokens[subcommandIndex] === "-C") {
		if (!tokens[subcommandIndex + 1]) return true;
		subcommandIndex += 2;
	}
	// Only -C path selectors are accepted above for the host-provided review
	// scope. Do not allow -c, --git-dir, or other global options to alter Git's
	// execution environment.
	if (!tokens[subcommandIndex] || tokens[subcommandIndex].startsWith("-")) return true;

	const subcommand = tokens[subcommandIndex].toLowerCase();
	const readOnlyGitCommands = new Set([
		"status",
		"diff",
		"log",
		"show",
		"ls-files",
		"ls-tree",
		"rev-parse",
		"branch",
		"tag",
		"remote",
		"describe",
		"blame",
		"grep",
	]);
	if (!readOnlyGitCommands.has(subcommand)) return true;

	const gitArguments = tokens.slice(subcommandIndex + 1);
	if (gitArguments.some((token) => /^--?(?:output|exec-path|upload-pack|receive-pack|ext-diff)(?:=|$)/i.test(token))) {
		return true;
	}
	if (subcommand === "branch" || subcommand === "tag") {
		// `git branch` and `git tag` are read-only only when they are used to
		// list refs. Reject every positional argument and every option that is
		// not explicitly known to be a listing/filtering option. This prevents
		// creation, deletion, rename, move, and forced updates through aliases
		// or less common short forms.
		const readOnlyOptions = new Set([
			"-a",
			"--all",
			"-r",
			"--remotes",
			"-l",
			"--list",
			"--show-current",
			"-v",
			"-vv",
			"--verbose",
			"--no-color",
			"--color",
			"--column",
			"--no-column",
		]);
		const readOnlyOptionsWithEquals = new Set([
			"--sort",
			"--format",
			"--contains",
			"--no-contains",
			"--merged",
			"--no-merged",
			"--points-at",
			"--color",
			"--column",
		]);
		for (const token of gitArguments) {
			if (!token.startsWith("-")) return true;
			if (readOnlyOptions.has(token.toLowerCase())) continue;
			const optionName = token.slice(0, token.indexOf("="));
			if (optionName !== token && readOnlyOptionsWithEquals.has(optionName.toLowerCase())) continue;
			return true;
		}
	}
	if (subcommand === "remote") {
		const firstArgument = gitArguments[0];
		if (firstArgument && !["-v", "--verbose", "show", "get-url"].includes(firstArgument.toLowerCase())) {
			return true;
		}
	}

	return false;
}

function stripAutoReviewDiagnosticRedirections(command: string): string | undefined {
	const removals: Array<{ start: number; end: number }> = [];
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
		if (char !== ">") continue;
		if (command[index - 1] === "=") continue;

		const prefix = command.slice(0, index);
		const fdMatch = prefix.match(/(?:^|\s)2\s*(?:&)?$/);
		const remainder = command.slice(index + 1);
		const targetMatch = remainder.match(
			/^\s*&\s*1\b|^\s*(?:\/dev\/null|nul\b|\$null\b|\/tmp(?:\/[A-Za-z0-9@_.-]+)*|\$TMPDIR(?:\/[A-Za-z0-9@_.-]+)*)/i,
		);
		if (!targetMatch || /\.\./.test(targetMatch[0])) return undefined;
		if (!fdMatch) {
			const prefixSegments = splitAutoReviewShellSequence(command.slice(0, index).trim());
			const validationCommand = prefixSegments?.at(-1);
			const isValidationOutputSuppression = validationCommand
				? isAutoReviewValidationCommand(validationCommand)
				: false;
			const isReadOnlyOutputSuppression = validationCommand
				? isSafeAutoReviewNullOutputCommand(validationCommand)
				: false;
			if (
				!/^\s*(?:\/tmp(?:\/[A-Za-z0-9@_.-]+)*|\$TMPDIR(?:\/[A-Za-z0-9@_.-]*)*)/i.test(targetMatch[0]) &&
				!(
					/^\s*\/dev\/null\b/i.test(targetMatch[0]) &&
					(isValidationOutputSuppression || isReadOnlyOutputSuppression)
				)
			)
				return undefined;
			removals.push({ start: index, end: index + 1 + targetMatch[0].length });
			index += targetMatch[0].length;
			continue;
		}

		const matchStart = index - fdMatch[0].length + (fdMatch[0].startsWith(" ") ? 1 : 0);
		removals.push({ start: matchStart, end: index + 1 + targetMatch[0].length });
		index += targetMatch[0].length;
	}

	let result = command;
	for (const removal of removals.reverse()) {
		result = `${result.slice(0, removal.start)}${result.slice(removal.end)}`;
	}
	return result.trim();
}

function splitAutoReviewShellSequence(
	command: string,
	allowCommandSubstitutions = false,
	allowStructuredBlocks = false,
): string[] | undefined {
	const segments: string[] = [];
	let start = 0;
	let loopDepth = 0;
	let ifDepth = 0;
	let commandSubstitutionDepth = 0;
	let groupDepth = 0;
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
		if (char === "$" && command[index + 1] === "(") {
			if (!allowCommandSubstitutions && loopDepth === 0) return undefined;
			commandSubstitutionDepth += 1;
			index += 1;
			continue;
		}
		if (char === "$" && command[index + 1] === "{" && loopDepth === 0) return undefined;
		if (commandSubstitutionDepth > 0) {
			if (char === ")") commandSubstitutionDepth -= 1;
			continue;
		}
		if (char === "(") {
			groupDepth += 1;
			continue;
		}
		if (char === ")") {
			if (groupDepth === 0) return undefined;
			groupDepth -= 1;
			continue;
		}
		if (/^for\s+[A-Za-z_][\w]*\s+in\s+/i.test(command.slice(index))) {
			loopDepth += 1;
			continue;
		}
		if (loopDepth > 0 && /^done\b/i.test(command.slice(index))) {
			loopDepth -= 1;
			continue;
		}
		if (allowStructuredBlocks && loopDepth === 0 && /^if\s+\[/i.test(command.slice(index))) {
			ifDepth += 1;
			continue;
		}
		if (allowStructuredBlocks && ifDepth > 0 && /^fi\b/i.test(command.slice(index))) {
			ifDepth -= 1;
			continue;
		}
		if (loopDepth > 0 || ifDepth > 0 || groupDepth > 0) continue;
		if (char === "<") return undefined;
		if (char === "|") {
			if (command[index + 1] === "|") return undefined;
			const segment = command.slice(start, index).trim();
			if (!segment) return undefined;
			segments.push(segment);
			start = index + 1;
			continue;
		}
		if (char === "&") {
			if (command[index + 1] !== "&") return undefined;
			const segment = command.slice(start, index).trim();
			if (!segment) return undefined;
			segments.push(segment);
			index += 1;
			start = index + 1;
			continue;
		}
		if (char === ";") {
			const segment = command.slice(start, index).trim();
			if (!segment) return undefined;
			segments.push(segment);
			start = index + 1;
			continue;
		}
		if (char === "\r" || char === "\n") {
			const segment = command.slice(start, index).trim();
			if (!segment) return undefined;
			segments.push(segment);
			start = index + 1;
			if (char === "\r" && command[index + 1] === "\n") index += 1;
		}
	}

	const finalSegment = command.slice(start).trim();
	if (quote || loopDepth !== 0 || ifDepth !== 0 || groupDepth !== 0 || commandSubstitutionDepth !== 0 || !finalSegment)
		return undefined;
	segments.push(finalSegment);
	if (segments.length > 24) return undefined;
	return segments;
}

function getAutoReviewCommandTokens(command: string): string[] | undefined {
	return command
		.trim()
		.match(/(?:"[^"]*"|'[^']*'|[^\s;&|<>`]+)/g)
		?.map((token) => token.replace(/^["']|["']$/g, ""));
}

function isSafeAutoReviewCdCommand(command: string): boolean {
	const tokens = getAutoReviewCommandTokens(command);
	if (!tokens || tokens.length !== 2 || tokens[0].toLowerCase() !== "cd") return false;
	const target = tokens[1];
	return target !== "" && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(target) && !/[?$*`]/.test(target);
}

function isSafeAutoReviewPath(value: string, allowAbsolute = false): boolean {
	return (
		value !== "" &&
		!/[`$?$*;|&<>(){}[\]\r\n]/.test(value) &&
		!/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value) &&
		(allowAbsolute || !/^([A-Za-z]:[\\/]|[\\/])/.test(value))
	);
}

function isSafeAutoReviewNodeVersionCommand(command: string): boolean {
	const tokens = getAutoReviewCommandTokens(command);
	if (!tokens || tokens.length !== 2) return false;
	const executable = tokens[0]
		.split(/[\\/]/)
		.at(-1)
		?.replace(/\.(?:exe|cmd|bat)$/i, "")
		.toLowerCase();
	return executable === "node" && ["--version", "-v"].includes(tokens[1].toLowerCase());
}

function isAutoReviewNodeModuleImportAdjudicationCandidate(command: string): boolean {
	const tokens = getAutoReviewCommandTokens(command);
	if (!tokens || tokens.length !== 4) return false;
	const executable = tokens[0]
		.split(/[\\/]/)
		.at(-1)
		?.replace(/\.(?:exe|cmd|bat)$/i, "")
		.toLowerCase();
	if (executable !== "node" && executable !== "bun") return false;
	if (tokens[1].toLowerCase() !== "--input-type=module") return false;
	if (tokens[2].toLowerCase() !== "-e" && tokens[2].toLowerCase() !== "--eval") return false;

	const source = tokens[3].trim();
	if (!source || /[`$]/.test(source)) return false;
	const importPattern =
		/\bimport\s+(?:(?:(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))|[A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\1\s*;?/g;
	const imports = [...source.matchAll(importPattern)];
	if (imports.length === 0) return false;
	if (
		imports.some(
			(match) =>
				!match[2].startsWith("./") || !isSafeAutoReviewPath(match[2]) || !/[A-Za-z0-9_-]/.test(match[2].slice(2)),
		)
	) {
		return false;
	}

	const sourceWithoutImports = source.replace(importPattern, " ");
	if (/\b(?:import|export)\b/i.test(sourceWithoutImports)) return false;
	if (!/\bconsole\.(?:log|error|dir|table)\s*\(/i.test(sourceWithoutImports)) return false;
	return !/\b(?:writeFile|appendFile|unlink|rmSync|mkdir|rmdir|rename|chmod|chown|exec|spawn|fork|fetch|XMLHttpRequest|WebSocket|Deno|child_process)\b/i.test(
		sourceWithoutImports,
	);
}

function isSafeAutoReviewNullProbeCommand(command: string): boolean {
	const match = command
		.trim()
		.match(/^ls\s+["']([^"']+)["']\s+>\/dev\/null\s+2>&1\s*;\s*echo\s+["']sqlite-node pkg:\s*\$\?["']$/i);
	return Boolean(match && isSafeAutoReviewPath(match[1], true) && /(?:^|[\\/])package\.json$/i.test(match[1]));
}

/**
 * Generate the read-only guard extension source for delegated Bash sessions.
 *
 * The generated extension only serves the delegated mode: it blocks Bash
 * commands that are not read-only inspection. The Auto Review mode and its
 * shell-parser functions were removed from this generator.
 */
export function createReadOnlyGuardExtensionSource(
	blockReason: string,
	options: {
		maxBashCommands?: number;
		mode?: "delegated";
		adjudicator?: ReadOnlyGuardAiAdjudicatorOptions;
	} = {},
): string {
	const adjudicatorConfig = options.adjudicator
		? {
				provider: options.adjudicator.provider,
				model: options.adjudicator.model,
				timeoutMs: options.adjudicator.timeoutMs ?? 12_000,
				maxCalls: options.adjudicator.maxCalls ?? 4,
			}
		: undefined;
	return `const patterns = ${JSON.stringify(BLOCKED_BASH_PATTERNS)}.map(([source, flags]) => new RegExp(source, flags));
const hasUnsafeAutoReviewOutputRedirection = ${hasUnsafeAutoReviewOutputRedirection.toString()};
const hasUnsafeOutputRedirection = hasUnsafeAutoReviewOutputRedirection;
const getAutoReviewCommandSafetyText = ${getAutoReviewCommandSafetyText.toString()};
const getCommandSafetyText = getAutoReviewCommandSafetyText;
const hasUnsafeDelegatedBashCommand = ${hasUnsafeDelegatedBashCommand.toString()};
const isSafeAutoReviewNullOutputCommand = ${isSafeAutoReviewNullOutputCommand.toString()};
const isAutoReviewValidationCommand = ${isAutoReviewValidationCommand.toString()};
const stripAutoReviewDiagnosticRedirections = ${stripAutoReviewDiagnosticRedirections.toString()};
const splitAutoReviewShellSequence = ${splitAutoReviewShellSequence.toString()};
const getAutoReviewCommandTokens = ${getAutoReviewCommandTokens.toString()};
const isSafeAutoReviewCdCommand = ${isSafeAutoReviewCdCommand.toString()};
const isSafeAutoReviewPath = ${isSafeAutoReviewPath.toString()};
const isSafeAutoReviewNodeVersionCommand = ${isSafeAutoReviewNodeVersionCommand.toString()};
const isAutoReviewNodeModuleImportAdjudicationCandidate = ${isAutoReviewNodeModuleImportAdjudicationCandidate.toString()};
const isAutoReviewAiAdjudicationCandidate = ${isAutoReviewAiAdjudicationCandidate.toString()};
const hasExplicitAutoReviewBlockedPattern = ${hasExplicitAutoReviewBlockedPattern.toString()};
const hasHardAutoReviewBashCommand = ${hasHardAutoReviewBashCommand.toString()};
const hasUnquotedShellSyntax = ${hasUnquotedShellSyntax.toString()};
const isSafeAutoReviewNullProbeCommand = ${isSafeAutoReviewNullProbeCommand.toString()};
const maxBashCommands = ${JSON.stringify(options.maxBashCommands)};
const adjudicator = ${JSON.stringify(adjudicatorConfig)};
const adjudicationCache = new Map();
let adjudicationCalls = 0;

async function askAiToAdjudicateReadonly(command, ctx) {
  if (!adjudicator || adjudicationCalls >= adjudicator.maxCalls) return false;
  if (!isAutoReviewAiAdjudicationCandidate(command, patterns.map((pattern) => [pattern.source, pattern.flags]))) return false;
  const cached = adjudicationCache.get(command);
  if (cached !== undefined) return cached;
  adjudicationCalls += 1;
  const pending = (async () => {
    try {
      const model = ctx?.modelRegistry?.find(adjudicator.provider, adjudicator.model);
      if (!model || model.api !== "openai-completions" || typeof model.baseUrl !== "string") return false;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth || auth.ok !== true || typeof auth.apiKey !== "string" || auth.apiKey.length === 0) return false;
      const baseUrl = model.baseUrl.replace(/\\/+$/, "");
      const endpoint = new URL(baseUrl + "/chat/completions");
      if (endpoint.protocol !== "https:") return false;
      const headers = { "content-type": "application/json", ...(auth.headers || {}) };
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
        headers.authorization = "Bearer " + auth.apiKey;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), adjudicator.timeoutMs);
      const onAbort = () => controller.abort();
      if (ctx.signal?.aborted) return false;
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: adjudicator.model,
            stream: false,
            temperature: 0,
            messages: [
              {
                role: "system",
                content:
                  ${JSON.stringify(loadSystemPrompt("tasks/shell-adjudicator.md"))},
              },
              {
                role: "user",
                content: JSON.stringify({
                  command,
                  workingDirectory:
                    typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : undefined,
                }),
              },
            ],
          }),
        });
        if (!response.ok) return false;
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length > 2_000) return false;
        const decision = JSON.parse(content.trim());
        return (
          decision &&
          decision.decision === "readonly" &&
          typeof decision.confidence === "number" &&
          decision.confidence >= 0.95 &&
          typeof decision.reason === "string" &&
          decision.reason.length > 0 &&
          decision.reason.length <= 500
        );
      } finally {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    } catch {
      return false;
    }
  })();
  adjudicationCache.set(command, pending);
  return pending;
}

let bashCommandCount = 0;
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    bashCommandCount += 1;
    if (typeof maxBashCommands === "number" && bashCommandCount > maxBashCommands) {
      return { block: true, reason: "已到达 Bash 命令数量上限。" };
    }
    const safetyText = getCommandSafetyText(command);
    const strictBlocked =
      hasUnsafeDelegatedBashCommand(command) ||
      hasUnsafeOutputRedirection(command) ||
      patterns.some((pattern) => pattern.test(safetyText));
    if (strictBlocked && adjudicator && !hasHardAutoReviewBashCommand(command, patterns.map((pattern) => [pattern.source, pattern.flags]))) {
      if (await askAiToAdjudicateReadonly(command, ctx)) return;
    }
    if (strictBlocked) {
      return { block: true, reason: ${JSON.stringify(blockReason)} };
    }
  });
}`;
}
