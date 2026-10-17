import { spawn } from "node:child_process";
import { win32 as windowsPath } from "node:path";
import { createInterface } from "node:readline";
import { killProcessTreeAndWait } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { LANGUAGE_BY_EXTENSION } from "../language.ts";
import { normalizeWorkspaceRelativePath } from "../path-semantics.ts";

/**
 * Text search used by the workflow operations. It is ripgrep over the live
 * workspace on every call (gitignore respected, binary files skipped), so it
 * never answers from a stale index. Results are lexical evidence only: they
 * say where text occurs, not what it means.
 */

/** Extensions of languages whose files can hold reusable code (data formats excluded). */
const NON_CODE_LANGUAGES = new Set(["json", "yaml", "xml"]);

export const CODE_FILE_GLOBS: readonly string[] = Object.freeze(
	Object.entries(LANGUAGE_BY_EXTENSION)
		.filter(([, language]) => !NON_CODE_LANGUAGES.has(language))
		.map(([extension]) => `*${extension}`),
);

export interface LexicalMatch {
	/** Workspace-relative POSIX path. */
	readonly path: string;
	/** 0-based line. */
	readonly line: number;
	/** The matched line without its terminator. */
	readonly text: string;
	/** Matched substrings with 0-based UTF-16 columns on the line. */
	readonly submatches: ReadonlyArray<{ readonly text: string; readonly start: number; readonly end: number }>;
}

export interface LexicalSearchOptions {
	readonly workspaceRoot: string;
	/** Regular expressions (ripgrep syntax), or literal strings when `fixedStrings`. */
	readonly patterns: readonly string[];
	readonly fixedStrings?: boolean;
	readonly ignoreCase?: boolean;
	readonly wordRegexp?: boolean;
	/** Include globs; default: every file ripgrep searches. */
	readonly globs?: readonly string[];
	/** Workspace-relative directory or file to search; default: the workspace root. */
	readonly path?: string;
	readonly maxCountPerFile?: number;
	/** Stop after this many matching lines in total and report `truncated`. */
	readonly maxMatches?: number;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface LexicalSearchResult {
	readonly matches: readonly LexicalMatch[];
	readonly truncated: boolean;
	/** Set when the search could not run or failed; matches are then empty or incomplete. */
	readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function utf8ColumnToUtf16(lineText: string, byteOffset: number): number {
	return Buffer.from(lineText, "utf8").subarray(0, byteOffset).toString("utf8").length;
}

function stripTerminator(text: string): string {
	return text.replace(/\r?\n$/, "").replace(/\r$/, "");
}

function decodeRgText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { text?: unknown; bytes?: unknown };
	if (typeof record.text === "string") return record.text;
	if (typeof record.bytes === "string") return Buffer.from(record.bytes, "base64").toString("utf8");
	return undefined;
}

async function runRipgrep(
	args: readonly string[],
	cwd: string,
	onLine: (line: string) => boolean,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ truncated: boolean; error?: string }> {
	const rgPath = await ensureTool("rg", true);
	if (!rgPath) return { truncated: false, error: "ripgrep (rg) is not available" };
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
	return new Promise((resolve, reject) => {
		const child = spawn(rgPath, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stopped = false;
		let truncated = false;
		let stderr = "";
		let settled = false;
		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			if (child.pid !== undefined) void killProcessTreeAndWait(child.pid).catch(() => undefined);
		};
		const timer = setTimeout(() => {
			truncated = true;
			stop();
		}, timeoutMs);
		const onAbort = (): void => stop();
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (outcome: { truncated: boolean; error?: string } | Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		const reader = createInterface({ input: child.stdout });
		reader.on("line", (line) => {
			if (stopped) return;
			if (!onLine(line)) {
				truncated = true;
				stop();
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4_000) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => finish({ truncated, error: `ripgrep failed to start: ${error.message}` }));
		child.on("close", (code) => {
			if (signal?.aborted) {
				finish(new DOMException("The operation was aborted", "AbortError"));
				return;
			}
			// Exit code 1 means "no match"; 2 can still carry partial results (unreadable files).
			if (code === 0 || code === 1 || stopped) finish({ truncated });
			else finish({ truncated, error: stderr.trim() || `ripgrep exited with code ${code}` });
		});
	});
}

function baseArgs(options: Pick<LexicalSearchOptions, "globs">): string[] {
	const args: string[] = ["--color=never"];
	for (const glob of options.globs ?? []) args.push("--glob", glob);
	// The workflow never reports from inside version-control metadata.
	args.push("--glob", "!.git/**");
	return args;
}

function searchTarget(path: string | undefined): string {
	if (path === undefined || path.trim() === "" || path === ".") return ".";
	return path;
}

/** Search the live workspace. Paths in the result are workspace-relative POSIX paths. */
export async function searchWorkspaceText(options: LexicalSearchOptions): Promise<LexicalSearchResult> {
	if (options.patterns.length === 0) return { matches: [], truncated: false };
	const args = [...baseArgs(options), "--json", "--line-number", "--max-columns", "400"];
	if (options.fixedStrings) args.push("--fixed-strings");
	if (options.ignoreCase) args.push("--ignore-case");
	if (options.wordRegexp) args.push("--word-regexp");
	if (options.maxCountPerFile !== undefined) args.push("--max-count", String(options.maxCountPerFile));
	for (const pattern of options.patterns) args.push("-e", pattern);
	args.push("--", searchTarget(options.path));
	const maxMatches = options.maxMatches ?? 20_000;
	const matches: LexicalMatch[] = [];
	const outcome = await runRipgrep(
		args,
		options.workspaceRoot,
		(line) => {
			let event: { type?: unknown; data?: Record<string, unknown> };
			try {
				event = JSON.parse(line);
			} catch {
				return true;
			}
			if (event.type !== "match" || !event.data) return true;
			const filePath = decodeRgText(event.data.path);
			const lineText = decodeRgText(event.data.lines);
			const lineNumber = event.data.line_number;
			if (filePath === undefined || lineText === undefined || typeof lineNumber !== "number") return true;
			const text = stripTerminator(lineText);
			const submatches: Array<{ text: string; start: number; end: number }> = [];
			if (Array.isArray(event.data.submatches)) {
				for (const submatch of event.data.submatches as Array<Record<string, unknown>>) {
					const matchText = decodeRgText(submatch.match);
					if (matchText === undefined || typeof submatch.start !== "number" || typeof submatch.end !== "number") {
						continue;
					}
					submatches.push({
						text: matchText,
						start: utf8ColumnToUtf16(text, submatch.start),
						end: utf8ColumnToUtf16(text, submatch.end),
					});
				}
			}
			matches.push({
				path: normalizeWorkspaceRelativePath(filePath.replace(/^\.[\\/]/, "")),
				line: lineNumber - 1,
				text,
				submatches,
			});
			return matches.length < maxMatches;
		},
		options.signal,
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	return { matches, truncated: outcome.truncated, ...(outcome.error ? { error: outcome.error } : {}) };
}

export interface WorkspaceFileListing {
	readonly files: readonly string[];
	readonly truncated: boolean;
	readonly error?: string;
}

/** List the files ripgrep would search (gitignore respected). */
export async function listWorkspaceFiles(options: {
	readonly workspaceRoot: string;
	readonly globs?: readonly string[];
	readonly path?: string;
	readonly maxFiles?: number;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}): Promise<WorkspaceFileListing> {
	const args = [...baseArgs(options), "--files", "--", searchTarget(options.path)];
	const maxFiles = options.maxFiles ?? 200_000;
	const files: string[] = [];
	const outcome = await runRipgrep(
		args,
		options.workspaceRoot,
		(line) => {
			if (line.trim() !== "") files.push(normalizeWorkspaceRelativePath(line.replace(/^\.[\\/]/, "")));
			return files.length < maxFiles;
		},
		options.signal,
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	return { files, truncated: outcome.truncated, ...(outcome.error ? { error: outcome.error } : {}) };
}

/** Language id of a workspace path by extension (same table the language servers use). */
export function languageOfPath(path: string): string | undefined {
	return LANGUAGE_BY_EXTENSION[windowsPath.extname(path).toLowerCase()];
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
