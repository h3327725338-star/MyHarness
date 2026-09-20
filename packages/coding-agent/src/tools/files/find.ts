import { createInterface } from "node:readline";
import type { AgentTool } from "@myharness/agent-core";
import { spawn } from "child_process";
import { minimatch } from "minimatch";
import path from "path";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { killProcessTreeAndWait } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { pathExists, resolveToCwd } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { FULL_TEXT_OUTPUT } from "../tool-result-persistence.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../truncate.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern for matching files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

function validateGlobPattern(pattern: string): void {
	let inCharacterClass = false;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === "[" && !inCharacterClass) {
			inCharacterClass = true;
		} else if (char === "]" && inCharacterClass) {
			inCharacterClass = false;
		}
	}
	if (inCharacterClass) {
		throw new Error("Invalid glob pattern: unterminated character class");
	}
}

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): BusinessToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Searches for files by glob pattern. Returns file paths relative to the search directory. Respects .gitignore. Output is capped at ${DEFAULT_LIMIT} results with no byte cap.`,
		promptSnippet: loadSystemPrompt("tools/find/snippet.md"),
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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
				let abortRequested = false;
				let stopChild: (() => Promise<boolean>) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					abortRequested = true;
					const termination = stopChild?.();
					if (!termination) {
						settle(() => reject(new Error("Operation aborted")));
						return;
					}
					void termination.then(
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

				(async () => {
					try {
						validateGlobPattern(pattern);
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: Number.MAX_SAFE_INTEGER,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							// Relativize paths against the search root for stable output.
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
								return toPosixPath(path.relative(searchPath, p));
							});
							const resultLimitReached = relativized.length > effectiveLimit;
							const rawOutput = relativized.join("\n");
							const previewOutput = relativized.slice(0, effectiveLimit).join("\n");
							const truncation = truncateHead(previewOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							const result = {
								content: [{ type: "text" as const, text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							};
							if (resultLimitReached || truncation.truncated) {
								Object.assign(result, { [FULL_TEXT_OUTPUT]: rawOutput });
							}
							settle(() => resolve(result));
							return;
						}

						// Default implementation uses fd.
						const fdPath = await ensureTool("fd", true);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}

						const args: string[] = ["--glob", "--color=never", "--hidden"];

						// fd normally ignores .gitignore outside git repos, so keep --no-require-git
						// there. Inside repos, use fd's default git-aware behavior so parent
						// .gitignore rules stop at nested repo boundaries:
						// https://github.com/h3327725338-star/MyHarness/issues/5960
						let insideGitRepo = false;
						for (let current = searchPath; ; ) {
							if (await pathExists(path.join(current, ".git"))) {
								insideGitRepo = true;
								break;
							}
							const parent = path.dirname(current);
							if (parent === current) break;
							current = parent;
						}
						if (!insideGitRepo) args.push("--no-require-git");
						// Ask fd for all candidates and apply the user glob to normalized
						// relative POSIX paths ourselves. fd's --full-path matching receives
						// backslash-separated absolute paths on Windows, so slash-based globs
						// such as src/**/*.spec.ts otherwise silently fail there.
						args.push("--", "*", searchPath);

						const child = spawn(fdPath, args, {
							stdio: ["ignore", "pipe", "pipe"],
							detached: process.platform !== "win32",
							windowsHide: true,
						});
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						const lines: string[] = [];

						let terminationPromise: Promise<boolean> | undefined;
						stopChild = () => {
							if (terminationPromise) return terminationPromise;
							terminationPromise = !child.pid
								? Promise.resolve(true)
								: killProcessTreeAndWait(child.pid).catch(() => false);
							return terminationPromise;
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							if (abortRequested) return;
							cleanup();
							settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();
							if (abortRequested || signal?.aborted) {
								return;
							}
							const output = lines.join("\n");
							if (code !== 0) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
								let relativePath = line;
								if (line.startsWith(searchPath)) {
									relativePath = line.slice(searchPath.length + 1);
								} else {
									relativePath = path.relative(searchPath, line);
								}
								if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
								const normalizedRelativePath = toPosixPath(relativePath);
								if (
									minimatch(normalizedRelativePath, pattern, {
										dot: true,
										matchBase: !pattern.includes("/"),
									})
								) {
									relativized.push(normalizedRelativePath);
								}
							}

							if (relativized.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							const resultLimitReached = relativized.length > effectiveLimit;
							const rawOutput = relativized.join("\n");
							const previewOutput = relativized.slice(0, effectiveLimit).join("\n");
							const truncation = truncateHead(previewOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							const result = {
								content: [{ type: "text" as const, text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							};
							if (resultLimitReached || truncation.truncated) {
								Object.assign(result, { [FULL_TEXT_OUTPUT]: rawOutput });
							}
							settle(() => resolve(result));
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
