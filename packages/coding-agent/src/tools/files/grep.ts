import { readFile as fsReadFile, stat as fsStat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { AgentTool } from "@myharness/agent-core";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { killProcessTreeAndWait } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { resolveToCwd } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { FULL_TEXT_OUTPUT } from "../tool-result-persistence.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "../truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Whether to ignore case (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat the pattern as a literal string instead of a regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of context lines to show around each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

// Windows CreateProcess 命令行总长上限约 32767 字符。超长 pattern 原样写入
// 临时文件后通过 rg -f 传入（内容完整保留），避免超长命令行触发 ENAMETOOLONG。
const MAX_PATTERN_BYTES = 8 * 1024;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): BusinessToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Searches file contents for a pattern. Returns matching lines, file paths, and line numbers. Respects .gitignore. Output is capped at ${DEFAULT_LIMIT} matches with no byte cap; overlong lines are truncated to ${GREP_MAX_LINE_LENGTH} characters.`,
		promptSnippet: loadSystemPrompt("tools/grep/snippet.md"),
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const patternBytes = Buffer.byteLength(pattern, "utf8");
						const usePatternFile = patternBytes > MAX_PATTERN_BYTES;
						if (usePatternFile && pattern.includes("\n")) {
							settle(() =>
								reject(
									new Error(
										`Pattern too long (${patternBytes} bytes, max ${MAX_PATTERN_BYTES}) and contains newlines; please shorten the pattern`,
									),
								),
							);
							return;
						}
						let patternDir: string | undefined;
						if (usePatternFile) {
							// 超长 pattern 写入临时文件后经 rg -f 传入，完整保留，不经过命令行。
							try {
								patternDir = await mkdtemp(path.join(tmpdir(), "myharness-grep-pattern-"));
								await writeFile(path.join(patternDir, "pattern.txt"), pattern, "utf8");
							} catch (error) {
								if (patternDir) {
									await rm(patternDir, { recursive: true, force: true }).catch(() => {});
								}
								throw error;
							}
						}

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						// A leading dash is often a command-line-looking literal (for example
						// "--pre=C:\path"). Passing it as a regex makes Windows backslashes
						// form invalid escapes such as \U. The "--" separator already prevents
						// option injection; fixed-string mode preserves the intended search text.
						if (literal || pattern.startsWith("-")) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						if (usePatternFile) {
							args.push("-f", path.join(patternDir!, "pattern.txt"), "--", searchPath);
						} else {
							args.push("--", pattern, searchPath);
						}

						const child = spawn(rgPath, args, {
							stdio: ["ignore", "pipe", "pipe"],
							detached: process.platform !== "win32",
							windowsHide: true,
						});
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let abortRequested = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
							if (patternDir) {
								void rm(patternDir, { recursive: true, force: true }).catch(() => {});
							}
						};
						let terminationPromise: Promise<boolean> | undefined;
						const stopChild = (): Promise<boolean> => {
							if (terminationPromise) return terminationPromise;
							terminationPromise = !child.pid
								? Promise.resolve(true)
								: killProcessTreeAndWait(child.pid).catch(() => false);
							return terminationPromise;
						};
						const onAbort = () => {
							abortRequested = true;
							aborted = true;
							void stopChild().then(
								(stopped) =>
									settle(() =>
										reject(
											new Error(
												stopped
													? "Operation aborted"
													: "process tree did not terminate within the cancellation deadline",
											),
										),
									),
								() => settle(() => reject(new Error("Operation aborted"))),
							);
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (
							filePath: string,
							lineNumber: number,
							truncateLines: boolean,
						): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								const rendered = truncateLines
									? truncateLine(sanitized)
									: { text: sanitized, wasTruncated: false };
								if (rendered.wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${rendered.text}`);
								else block.push(`${relativePath}-${current}- ${rendered.text}`);
							}
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
						rl.on("line", (line) => {
							if (!line.trim()) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText });
							}
						});

						child.on("error", (error) => {
							if (abortRequested) return;
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (abortRequested || aborted) {
								return;
							}
							if (code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							const fullOutputLines: string[] = [];
							for (let index = 0; index < matches.length; index++) {
								const match = matches[index];
								const includeInPreview = index < effectiveLimit;
								if (contextValue === 0 && match.lineText !== undefined) {
									const relativePath = formatPath(match.filePath);
									const sanitized = match.lineText
										.replace(/\r\n/g, "\n")
										.replace(/\r/g, "")
										.replace(/\n$/, "");
									fullOutputLines.push(`${relativePath}:${match.lineNumber}: ${sanitized}`);
									if (includeInPreview) {
										const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
										if (wasTruncated) linesTruncated = true;
										outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
									}
								} else {
									fullOutputLines.push(...(await formatBlock(match.filePath, match.lineNumber, false)));
									if (includeInPreview) {
										outputLines.push(...(await formatBlock(match.filePath, match.lineNumber, true)));
									}
								}
							}

							matchLimitReached = matches.length > effectiveLimit;
							const rawOutput = fullOutputLines.join("\n");
							const previewOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(previewOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							const result = {
								content: [{ type: "text" as const, text: output }],
								details: Object.keys(details).length > 0 ? details : undefined,
							};
							if (matchLimitReached || truncation.truncated || linesTruncated) {
								Object.assign(result, { [FULL_TEXT_OUTPUT]: rawOutput });
							}
							settle(() => resolve(result));
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
