/**
 * Conservative lexical reconstruction for one already-separated shell command
 * segment. This is deliberately not a shell parser: it only reconstructs the
 * static argv words that the command boundary needs and removes redirections.
 *
 * This module is the single low-level Shell lexical/structural implementation.
 * Both consumers (the Bash command classifier and the Git task transaction
 * preflight) must use the shared word lexer (lexShellSegment) and the shared
 * command segment scanner (splitShellCommandSegments) below instead of
 * maintaining their own quote / escape / comment / control-operator logic.
 */

export interface ShellWordToken {
	value: string;
	hasDynamicExpansion: boolean;
	wasQuoted: boolean;
}

export interface ShellLexResult {
	words: ShellWordToken[];
	/** Here-doc and process-substitution syntax cannot be resolved statically. */
	hasUnresolvedRedirection: boolean;
	/** A resolved file redirection was removed from the reconstructed argv. */
	hasFileRedirection: boolean;
}

export interface ShellCommandSegment {
	text: string;
	/** Unquoted `(`/`)` appeared in this segment; consumers must stay conservative. */
	hasGroupingSyntax: boolean;
}

export type ShellExecutionSubstitutionKind = "command" | "backtick" | "process-input" | "process-output";

export interface ShellExecutionSubstitution {
	kind: ShellExecutionSubstitutionKind;
	body: string;
}

export const MAX_NESTED_SHELL_EXECUTION_DEPTH = 4;

export interface ShellCommandScanResult {
	segments: ShellCommandSegment[];
	hasBackgroundExecution: boolean;
	executionSubstitutions: ShellExecutionSubstitution[];
	/** Structural failure (unclosed quote or empty compound structure). */
	reason?: string;
}

export interface ShellPrefixStripResult {
	remainingWords: ShellWordToken[];
	hasUnsupportedPrefix: boolean;
}

type Quote = "single" | "double" | undefined;

interface PendingHereDocument {
	delimiter: string;
	stripTabs: boolean;
	expands: boolean;
}

interface ParsedHereDocumentRedirect extends PendingHereDocument {
	nextIndex: number;
}

interface ConsumedHereDocuments {
	nextIndex: number;
	executionSubstitutions: ShellExecutionSubstitution[];
	reason?: string;
}

const UNSUPPORTED_SHELL_COMPOUND_MARKERS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
	"coproc",
]);

function isWhitespace(value: string): boolean {
	return /\s/u.test(value);
}

function isDynamicCharacter(value: string): boolean {
	return (
		value === "$" ||
		value === "`" ||
		value === "*" ||
		value === "?" ||
		value === "[" ||
		value === "]" ||
		value === "{" ||
		value === "}"
	);
}

function isDescriptorPrefix(value: string): boolean {
	return /^\d+$/u.test(value);
}

/**
 * Find the matching `)` that closes the process substitution starting at
 * `operatorIndex` (which points at `<` or `>`; the opening `(` follows it).
 * Returns the closing-paren index, or -1 when the group is unbalanced.
 */
function findProcessSubstitutionEnd(segment: string, operatorIndex: number): number {
	let depth = 0;
	let quote: Quote;
	for (let index = operatorIndex + 1; index < segment.length; index++) {
		const character = segment[index]!;
		if (quote === "single") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else if (character === "\\") index++;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			continue;
		}
		if (character === "\\") {
			index++;
			continue;
		}
		if (character === "(") depth++;
		else if (character === ")") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function getRedirectionOperator(
	segment: string,
	index: number,
	currentWord: string,
): { length: number; unresolved: boolean; consumesTarget: boolean } | undefined {
	const remaining = segment.slice(index);
	const duplicate = /^(?:\d*)[<>]&(\d+|-)(?=\s|[;&|]|$)/u.exec(remaining);
	if (duplicate) return { length: duplicate[0].length, unresolved: false, consumesTarget: false };
	if (remaining.startsWith("<<<")) return { length: 3, unresolved: false, consumesTarget: true };
	if (remaining.startsWith("<<-")) return { length: 3, unresolved: true, consumesTarget: true };
	if (remaining.startsWith("<<")) return { length: 2, unresolved: true, consumesTarget: true };
	if (remaining.startsWith("&>>")) return { length: 3, unresolved: false, consumesTarget: true };
	if (remaining.startsWith("&>")) return { length: 2, unresolved: false, consumesTarget: true };
	// `<(` / `>(` process substitution is detected by the main loop before this
	// branch, so a plain `<`/`>`/`>>` here is an ordinary file redirection.
	if (remaining.startsWith(">>") || remaining.startsWith(">") || remaining.startsWith("<")) {
		return {
			length: remaining.startsWith(">>") ? 2 : 1,
			unresolved: false,
			consumesTarget: true,
		};
	}
	// `2>file` and `0<input` use a descriptor prefix only when the current
	// word consists entirely of unquoted digits. Otherwise `file2>log` keeps
	// `file2` as the preceding argv word.
	if ((remaining.startsWith(">") || remaining.startsWith("<")) && isDescriptorPrefix(currentWord)) {
		return { length: remaining.startsWith(">>") ? 2 : 1, unresolved: false, consumesTarget: true };
	}
	return undefined;
}

/**
 * Reconstruct static Bash words from a single shell command segment.
 * `undefined` means the segment cannot be resolved statically (unclosed quote
 * or unbalanced process substitution), so consumers must fail closed.
 *
 * Comment semantics follow Bash: `#` starts a comment only when it is outside
 * quotes, unescaped, and at the start of a new word. The comment swallows the
 * rest of the segment.
 */
export function lexShellSegment(segment: string): ShellLexResult | undefined {
	const words: ShellWordToken[] = [];
	let value = "";
	let hasDynamicExpansion = false;
	let wasQuoted = false;
	let quote: Quote;
	let wordStarted = false;
	let hasUnresolvedRedirection = false;
	let hasFileRedirection = false;
	let discardingRedirectionTarget = false;

	const pushWord = () => {
		if (!wordStarted) return;
		if (!discardingRedirectionTarget) words.push({ value, hasDynamicExpansion, wasQuoted });
		value = "";
		hasDynamicExpansion = false;
		wasQuoted = false;
		wordStarted = false;
		discardingRedirectionTarget = false;
	};

	const appendLiteral = (character: string) => {
		if (!wordStarted && character === "~" && quote === undefined) hasDynamicExpansion = true;
		value += character;
		wordStarted = true;
	};

	for (let index = 0; index < segment.length; index++) {
		const character = segment[index]!;
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else appendLiteral(character);
			continue;
		}

		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				const next = segment[index + 1];
				if (next === "\n") {
					index++;
					continue;
				}
				if (next === "$" || next === "`" || next === '"' || next === "\\") {
					appendLiteral(next);
					index++;
					continue;
				}
				appendLiteral(character);
				continue;
			}
			if (character === "$" || character === "`") hasDynamicExpansion = true;
			appendLiteral(character);
			continue;
		}

		if (character === "'") {
			quote = "single";
			wasQuoted = true;
			wordStarted = true;
			continue;
		}
		if (character === '"') {
			quote = "double";
			wasQuoted = true;
			wordStarted = true;
			continue;
		}
		if (character === "\\") {
			const next = segment[index + 1];
			if (next === "\n") {
				index++;
				continue;
			}
			if (next !== undefined) {
				appendLiteral(next);
				index++;
			}
			continue;
		}
		if (isWhitespace(character)) {
			pushWord();
			continue;
		}

		// Process substitution `<(...)` / `>(...)` is checked before any ordinary
		// file redirection. It cannot be resolved statically, so it becomes one
		// dynamic argv word and marks the segment as unresolved redirection.
		if ((character === "<" || character === ">") && segment[index + 1] === "(") {
			const endIndex = findProcessSubstitutionEnd(segment, index);
			if (endIndex < 0) return undefined;
			if (isDescriptorPrefix(value)) {
				value = "";
				wordStarted = false;
				hasDynamicExpansion = false;
				wasQuoted = false;
			} else {
				pushWord();
			}
			hasUnresolvedRedirection = true;
			words.push({ value: segment.slice(index, endIndex + 1), hasDynamicExpansion: true, wasQuoted: false });
			index = endIndex;
			continue;
		}

		const redirection = getRedirectionOperator(segment, index, value);
		if (redirection) {
			if (isDescriptorPrefix(value)) {
				value = "";
				wordStarted = false;
				hasDynamicExpansion = false;
				wasQuoted = false;
			} else {
				pushWord();
			}
			// File-descriptor duplication (`2>&1`) re-routes an existing stream and
			// opens no file; only real file redirections and here-docs set the flags.
			if (redirection.unresolved || redirection.consumesTarget) hasFileRedirection = true;
			hasUnresolvedRedirection ||= redirection.unresolved;
			discardingRedirectionTarget = redirection.consumesTarget;
			index += redirection.length - 1;
			continue;
		}

		// Word-start comment: everything until the end of the segment is text.
		if (character === "#" && !wordStarted) break;

		if (isDynamicCharacter(character)) hasDynamicExpansion = true;
		appendLiteral(character);
	}

	if (quote !== undefined) return undefined;
	pushWord();
	return { words, hasUnresolvedRedirection, hasFileRedirection };
}

function startsWithUnsupportedCompoundMarker(segment: string): boolean {
	const lexical = lexShellSegment(segment);
	if (!lexical) return false;
	const first = stripStaticShellPrefixes(lexical.words).remainingWords[0];
	return Boolean(
		first && !first.wasQuoted && !first.hasDynamicExpansion && UNSUPPORTED_SHELL_COMPOUND_MARKERS.has(first.value),
	);
}

/**
 * Conservatively find a static `git` / `git.exe` word inside a Shell structure
 * whose execution semantics are not modeled. Callers may use this only to
 * expand a fail-closed decision, never to prove that a command is safe.
 */
export function containsStaticGitExecutableInUnsupportedStructure(command: string): boolean {
	let normalized = "";
	let quote: Quote;
	let atWordStart = true;
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (quote === "single") {
			normalized += character;
			if (character === "'") quote = undefined;
			continue;
		}
		if (character === "\\") {
			normalized += character;
			const next = command[index + 1];
			if (next !== undefined) {
				normalized += next;
				index++;
			}
			atWordStart = false;
			continue;
		}
		if (quote === "double") {
			normalized += character;
			if (character === '"') quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			normalized += character;
			atWordStart = false;
			continue;
		}
		if (character === "#" && atWordStart) {
			while (index + 1 < command.length && command[index + 1] !== "\n") index++;
			normalized += " ";
			atWordStart = true;
			continue;
		}
		if ("(){};&|\n".includes(character)) {
			normalized += " ";
			atWordStart = true;
			continue;
		}
		normalized += character;
		atWordStart = isWhitespace(character);
	}
	const lexical = lexShellSegment(normalized);
	if (!lexical) return false;
	return lexical.words.some((word) => {
		if (word.hasDynamicExpansion) return false;
		const executable = word.value.split(/[\\/]/u).at(-1)?.toLowerCase();
		return executable === "git" || executable === "git.exe";
	});
}

function findBacktickSubstitutionEnd(command: string, startIndex: number): number {
	let quote: Quote;
	for (let index = startIndex + 1; index < command.length; index++) {
		const character = command[index]!;
		if (character === "\\") {
			index++;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			continue;
		}
		if (character === "`") return index;
	}
	return -1;
}

function findParenthesizedSubstitutionEnd(command: string, startIndex: number, nestingDepth = 0): number {
	if (nestingDepth >= MAX_NESTED_SHELL_EXECUTION_DEPTH) return -1;
	let depth = 1;
	let quote: Quote;
	let atWordStart = true;
	for (let index = startIndex + 2; index < command.length; index++) {
		const character = command[index]!;
		if (character === "\\") {
			index++;
			atWordStart = false;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "$" && command[index + 1] === "(") {
				const endIndex = findParenthesizedSubstitutionEnd(command, index, nestingDepth + 1);
				if (endIndex < 0) return -1;
				index = endIndex;
				continue;
			}
			if (character === "`") {
				const endIndex = findBacktickSubstitutionEnd(command, index);
				if (endIndex < 0) return -1;
				index = endIndex;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			atWordStart = false;
			continue;
		}
		if (character === "`") {
			const endIndex = findBacktickSubstitutionEnd(command, index);
			if (endIndex < 0) return -1;
			index = endIndex;
			atWordStart = false;
			continue;
		}
		if (character === "#" && atWordStart) {
			while (index + 1 < command.length && command[index + 1] !== "\n") index++;
			atWordStart = true;
			continue;
		}
		if ((character === "$" || character === "<" || character === ">") && command[index + 1] === "(") {
			const endIndex = findParenthesizedSubstitutionEnd(command, index, nestingDepth + 1);
			if (endIndex < 0) return -1;
			index = endIndex;
			atWordStart = false;
			continue;
		}
		if (character === "(") depth++;
		else if (character === ")") {
			depth--;
			if (depth === 0) return index;
		}
		atWordStart = isWhitespace(character) || ";&|".includes(character);
	}
	return -1;
}

function parseHereDocumentRedirect(command: string, operatorIndex: number): ParsedHereDocumentRedirect | undefined {
	if (!command.startsWith("<<", operatorIndex) || command.startsWith("<<<", operatorIndex)) return undefined;
	const stripTabs = command.startsWith("<<-", operatorIndex);
	let index = operatorIndex + (stripTabs ? 3 : 2);
	while (command[index] === " " || command[index] === "\t") index++;

	let delimiter = "";
	let quote: Quote;
	let quoted = false;
	let wordStarted = false;
	for (; index < command.length; index++) {
		const character = command[index]!;
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else delimiter += character;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				const next = command[index + 1];
				if (next === "\n") {
					index++;
					continue;
				}
				if (next === "$" || next === "`" || next === '"' || next === "\\") {
					delimiter += next;
					index++;
					continue;
				}
				delimiter += character;
				continue;
			}
			delimiter += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			quoted = true;
			wordStarted = true;
			continue;
		}
		if (character === "\\") {
			const next = command[index + 1];
			if (next === undefined) return undefined;
			quoted = true;
			wordStarted = true;
			if (next === "\n") {
				index++;
				continue;
			}
			delimiter += next;
			index++;
			continue;
		}
		if (isWhitespace(character) || ";&|<>".includes(character)) break;
		delimiter += character;
		wordStarted = true;
	}

	if (!wordStarted || quote !== undefined) return undefined;
	return { delimiter, stripTabs, expands: !quoted, nextIndex: index };
}

function stripHereDocumentTabs(body: string): string {
	return body
		.split("\n")
		.map((line) => line.replace(/^\t+/u, ""))
		.join("\n");
}

function collectHereDocumentExecutionSubstitutions(body: string): {
	executionSubstitutions: ShellExecutionSubstitution[];
	reason?: string;
} {
	const executionSubstitutions: ShellExecutionSubstitution[] = [];
	for (let index = 0; index < body.length; index++) {
		const character = body[index]!;
		if (character === "\\") {
			const next = body[index + 1];
			if (next === "\\" || next === "$" || next === "`" || next === "\n") index++;
			continue;
		}
		if (character === "$" && body[index + 1] === "(") {
			const endIndex = findParenthesizedSubstitutionEnd(body, index);
			if (endIndex < 0) {
				return { executionSubstitutions, reason: "Shell 替换结构没有闭合" };
			}
			executionSubstitutions.push({ kind: "command", body: body.slice(index + 2, endIndex) });
			index = endIndex;
			continue;
		}
		if (character === "`") {
			const endIndex = findBacktickSubstitutionEnd(body, index);
			if (endIndex < 0) {
				return { executionSubstitutions, reason: "Shell 替换结构没有闭合" };
			}
			executionSubstitutions.push({ kind: "backtick", body: body.slice(index + 1, endIndex) });
			index = endIndex;
		}
	}
	return { executionSubstitutions };
}

function consumePendingHereDocuments(
	command: string,
	bodyStartIndex: number,
	pendingHereDocuments: readonly PendingHereDocument[],
): ConsumedHereDocuments {
	const executionSubstitutions: ShellExecutionSubstitution[] = [];
	let nextIndex = bodyStartIndex;
	let reason: string | undefined;

	for (const hereDocument of pendingHereDocuments) {
		const documentBodyStart = nextIndex;
		let bodyEnd = command.length;
		let delimiterFound = false;
		while (nextIndex < command.length) {
			const lineEnd = command.indexOf("\n", nextIndex);
			const contentEnd = lineEnd < 0 ? command.length : lineEnd;
			const line = command.slice(nextIndex, contentEnd);
			const comparableLine = hereDocument.stripTabs ? line.replace(/^\t+/u, "") : line;
			if (comparableLine === hereDocument.delimiter) {
				bodyEnd = nextIndex;
				nextIndex = lineEnd < 0 ? command.length : lineEnd + 1;
				delimiterFound = true;
				break;
			}
			nextIndex = lineEnd < 0 ? command.length : lineEnd + 1;
		}

		const rawBody = command.slice(documentBodyStart, bodyEnd);
		if (hereDocument.expands) {
			const body = hereDocument.stripTabs ? stripHereDocumentTabs(rawBody) : rawBody;
			const collected = collectHereDocumentExecutionSubstitutions(body);
			executionSubstitutions.push(...collected.executionSubstitutions);
			reason ??= collected.reason;
		}
		if (!delimiterFound) {
			reason ??= `Heredoc delimiter ${hereDocument.delimiter} 没有闭合`;
			break;
		}
	}

	return { nextIndex, executionSubstitutions, ...(reason === undefined ? {} : { reason }) };
}

/**
 * Split a raw Bash tool command into sequential command segments on `;`,
 * newline, `&&`, `||`, `|` and background `&`, following the same quote,
 * escape, and comment rules as the word lexer.
 *
 * `&>` / `&>>` redirections and file-descriptor duplication (`2>&1`, `<&0`,
 * `2>&-`) are not command boundaries and are never reported as background
 * execution. Real background execution (`cmd &`) sets hasBackgroundExecution.
 *
 * A `#` comment (outside quotes, unescaped, at the start of a word) swallows
 * everything up to the next newline, so control operators inside comments
 * never split segments.
 */
export function splitShellCommandSegments(command: string): ShellCommandScanResult {
	const segments: ShellCommandSegment[] = [];
	const executionSubstitutions: ShellExecutionSubstitution[] = [];
	const pendingHereDocuments: PendingHereDocument[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let hasBackgroundExecution = false;
	let hasGroupingSyntax = false;
	let atWordStart = true;
	let reason: string | undefined;
	let consumedHereDocumentAtEnd = false;

	const pushSegment = (): boolean => {
		const text = current.trim();
		current = "";
		atWordStart = true;
		if (!text) return false;
		hasGroupingSyntax ||= startsWithUnsupportedCompoundMarker(text);
		segments.push({ text, hasGroupingSyntax });
		hasGroupingSyntax = false;
		return true;
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;

		if (quote === "single") {
			current += character;
			if (character === "'") quote = undefined;
			continue;
		}

		if (character === "\\") {
			current += character;
			const next = command[index + 1];
			if (next === "\n") {
				current += next;
				index++;
				continue;
			}
			if (next !== undefined) {
				current += next;
				index++;
			}
			atWordStart = false;
			continue;
		}

		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				current += character;
				atWordStart = false;
				continue;
			}
			if (character === "$" && command[index + 1] === "(") {
				const endIndex = findParenthesizedSubstitutionEnd(command, index);
				if (endIndex < 0) {
					current += command.slice(index);
					reason = "Shell 替换结构没有闭合";
					break;
				}
				executionSubstitutions.push({ kind: "command", body: command.slice(index + 2, endIndex) });
				current += command.slice(index, endIndex + 1);
				index = endIndex;
				atWordStart = false;
				continue;
			}
			if (character === "`") {
				const endIndex = findBacktickSubstitutionEnd(command, index);
				if (endIndex < 0) {
					current += command.slice(index);
					reason = "Shell 替换结构没有闭合";
					break;
				}
				executionSubstitutions.push({ kind: "backtick", body: command.slice(index + 1, endIndex) });
				current += command.slice(index, endIndex + 1);
				index = endIndex;
				atWordStart = false;
				continue;
			}
			current += character;
			atWordStart = false;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character === "'" ? "single" : "double";
			current += character;
			atWordStart = false;
			continue;
		}
		if (character === "<" && command[index - 1] !== "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
			const hereDocument = parseHereDocumentRedirect(command, index);
			if (hereDocument) {
				pendingHereDocuments.push(hereDocument);
				current += command.slice(index, hereDocument.nextIndex);
				index = hereDocument.nextIndex - 1;
				atWordStart = false;
				continue;
			}
		}
		if (character === "`") {
			const endIndex = findBacktickSubstitutionEnd(command, index);
			if (endIndex < 0) {
				current += command.slice(index);
				reason = "Shell 替换结构没有闭合";
				break;
			}
			executionSubstitutions.push({ kind: "backtick", body: command.slice(index + 1, endIndex) });
			current += command.slice(index, endIndex + 1);
			index = endIndex;
			atWordStart = false;
			continue;
		}
		if ((character === "$" || character === "<" || character === ">") && command[index + 1] === "(") {
			const endIndex = findParenthesizedSubstitutionEnd(command, index);
			if (endIndex < 0) {
				current += command.slice(index);
				reason = "Shell 替换结构没有闭合";
				break;
			}
			const kind: ShellExecutionSubstitutionKind =
				character === "$" ? "command" : character === "<" ? "process-input" : "process-output";
			executionSubstitutions.push({ kind, body: command.slice(index + 2, endIndex) });
			current += command.slice(index, endIndex + 1);
			index = endIndex;
			atWordStart = false;
			continue;
		}

		// Word-start comment: skip everything up to the next newline.
		if (character === "#" && atWordStart) {
			while (index + 1 < command.length && command[index + 1] !== "\n") index++;
			continue;
		}

		// File-descriptor duplication (`2>&1`, `<&0`, `2>&-`) only re-routes an
		// existing stream and must not be mistaken for background execution.
		const descriptorRedirect = /^\d*[<>]&(?:\d+|-)(?=\s|[;&|]|$)/u.exec(command.slice(index));
		if (descriptorRedirect) {
			current += descriptorRedirect[0];
			index += descriptorRedirect[0].length - 1;
			atWordStart = true;
			continue;
		}

		if (character === "&") {
			if (command[index + 1] === "&") {
				if (!pushSegment()) reason ??= "命令为空或复合命令结构无效";
				index++;
				continue;
			}
			if (command[index + 1] === ">") {
				// `&>` / `&>>` redirect both streams; not background execution.
				current += `${character}>`;
				if (command[index + 2] === ">") {
					current += ">";
					index += 2;
				} else {
					index++;
				}
				atWordStart = true;
				continue;
			}
			if (!pushSegment()) reason ??= "命令为空或复合命令结构无效";
			hasBackgroundExecution = true;
			continue;
		}
		if (character === "|") {
			const operator = command[index + 1] === "|" ? "||" : "|";
			if (!pushSegment()) reason ??= "命令为空或复合命令结构无效";
			if (operator === "||") index++;
			continue;
		}
		if (character === ";" || character === "\n") {
			if (!pushSegment()) reason ??= "命令为空或复合命令结构无效";
			if (character === "\n" && pendingHereDocuments.length > 0) {
				const consumed = consumePendingHereDocuments(command, index + 1, pendingHereDocuments);
				executionSubstitutions.push(...consumed.executionSubstitutions);
				reason ??= consumed.reason;
				pendingHereDocuments.length = 0;
				consumedHereDocumentAtEnd = consumed.nextIndex === command.length;
				index = consumed.nextIndex - 1;
			}
			continue;
		}
		if (character === "(" || character === ")" || character === "{" || character === "}") {
			hasGroupingSyntax = true;
			current += character;
			atWordStart = false;
			continue;
		}
		if (character === ">" || character === "<") {
			current += character;
			atWordStart = true;
			continue;
		}
		if (isWhitespace(character)) {
			current += character;
			atWordStart = true;
			continue;
		}
		current += character;
		atWordStart = false;
	}
	if (pendingHereDocuments.length > 0) {
		const consumed = consumePendingHereDocuments(command, command.length, pendingHereDocuments);
		executionSubstitutions.push(...consumed.executionSubstitutions);
		reason ??= consumed.reason;
	}

	if (quote !== undefined && reason === undefined) reason = "引号没有闭合";
	if (!pushSegment() && !consumedHereDocumentAtEnd) reason ??= "命令为空或复合命令结构无效";
	return { segments, hasBackgroundExecution, executionSubstitutions, ...(reason === undefined ? {} : { reason }) };
}

/**
 * Strip the static Bash execution prefixes this parser understands: any number
 * of `!` pipeline negations plus `time` / `time -p`. They only affect pipeline
 * exit status or timing, so the real executable behind them stays visible.
 *
 * `time` followed by any other static option is not understood statically; the
 * remaining words are still returned but hasUnsupportedPrefix is set so
 * consumers fail closed instead of degrading to the generic opaque policy.
 */
export function stripStaticShellPrefixes(words: readonly ShellWordToken[]): ShellPrefixStripResult {
	let index = 0;
	let hasUnsupportedPrefix = false;
	while (index < words.length) {
		const token = words[index]!;
		if (token.hasDynamicExpansion) break;
		if (token.value === "!") {
			index++;
			continue;
		}
		if (token.value === "time") {
			const next = words[index + 1];
			if (next && !next.hasDynamicExpansion && next.value === "-p") {
				index += 2;
				continue;
			}
			if (next && !next.hasDynamicExpansion && next.value.startsWith("-")) {
				hasUnsupportedPrefix = true;
				index += 2;
				continue;
			}
			index++;
			continue;
		}
		break;
	}
	return { remainingWords: words.slice(index), hasUnsupportedPrefix };
}
