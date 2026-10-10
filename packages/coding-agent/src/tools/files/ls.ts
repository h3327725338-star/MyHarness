import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@myharness/agent-core";
import nodePath from "path";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { pathExists, resolveToCwd } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { FULL_TEXT_OUTPUT } from "../tool-result-persistence.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

/** How many `stat` calls the ls tool keeps in flight at once. */
const STAT_CONCURRENCY = 32;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/** `limit` is a count of entries: clamp nonsense values (0, negatives, NaN, fractions) to a sane range. */
function resolveEntryLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_LIMIT;
	}
	return Math.max(1, Math.floor(limit));
}

/**
 * Stat entries in bounded concurrent batches, preserving the input order.
 * Returns the display label for each entry (`name`, or `name/` for directories) and
 * `undefined` for entries that cannot be stat'd, so callers keep the original order
 * and the original "skip what we cannot stat" behaviour.
 */
async function statEntriesInBatches(
	entries: Array<{ name: string; fullPath: string }>,
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean },
	isAborted: () => boolean,
): Promise<Array<string | undefined>> {
	const labels: Array<string | undefined> = [];
	for (let start = 0; start < entries.length; start += STAT_CONCURRENCY) {
		if (isAborted()) break;
		const batch = entries.slice(start, start + STAT_CONCURRENCY);
		const settled = await Promise.all(
			batch.map(async (entry): Promise<string | undefined> => {
				try {
					const entryStat = await stat(entry.fullPath);
					return entryStat.isDirectory() ? `${entry.name}/` : entry.name;
				} catch {
					// Skip entries we cannot stat.
					return undefined;
				}
			}),
		);
		labels.push(...settled);
	}
	return labels;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	operations?: LsOperations;
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): BusinessToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "ls",
		description: `Lists directory contents. Returns entries in alphabetical order with directories suffixed with "/". Includes hidden files. Output is capped at ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB, whichever is reached first.`,
		promptSnippet: loadSystemPrompt("tools/ls/snippet.md"),
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", cwd);
						const effectiveLimit = resolveEntryLimit(limit);

						// Check if path exists.
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// Check if path is a directory.
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						// Read directory entries.
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`Cannot read directory: ${e.message}`));
							return;
						}

						// Sort alphabetically, case-insensitive.
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// Format entries with directory indicators. The whole listing is
						// stat'd (in bounded concurrent batches, order preserved) so the
						// entries past `limit` can still be written to the persisted full
						// output instead of disappearing.
						const formatted = await statEntriesInBatches(
							entries.map((entry) => ({ name: entry, fullPath: nodePath.join(dirPath, entry) })),
							(absolutePath) => ops.stat(absolutePath),
							() => Boolean(signal?.aborted),
						);
						const results = formatted.filter((entry): entry is string => entry !== undefined);

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						const entryLimitReached = results.length > effectiveLimit;
						const rawOutput = results.slice(0, effectiveLimit).join("\n");
						// Apply byte truncation. There is no separate line limit because entry count is already capped.
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: LsToolDetails = {};
						// Build actionable notices for truncation and entry limits.
						const notices: string[] = [];
						if (entryLimitReached) {
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							details.entryLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						const result = {
							content: [{ type: "text" as const, text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						};
						if (entryLimitReached || truncation.truncated) {
							Object.assign(result, { [FULL_TEXT_OUTPUT]: results.join("\n") });
						}
						resolve(result);
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
