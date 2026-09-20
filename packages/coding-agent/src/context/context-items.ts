/**
 * Core Context Items (Task 9).
 *
 * "Add to Context" is a host-side user action. The host expresses what the
 * user selected (file / range / diff / comment); the Core decides how it is
 * serialized into the agent input and validates provenance at prompt
 * submission time (paths, ranges, and snapshot hashes are re-checked against
 * the real filesystem / Git layer so a context item can never become a file
 * access bypass).
 *
 * Context items are typed, serialization-safe DTOs. No markup.
 */

import { formatPathRelativeToCwdOrAbsolute } from "../utils/paths.ts";
import { type FileDiff, type FileDiffLine, getFileDiff } from "./file-diff.ts";
import { type FilePreviewLine, type FilePreviewTruncation, hashText, previewFile } from "./file-presentation.ts";

/** Custom message type used to persist a context attachment in the session. */
export const CONTEXT_ATTACHMENT_CUSTOM_TYPE = "context_attachment";

// ---------------------------------------------------------------------------
// Context item DTOs
// ---------------------------------------------------------------------------

export interface FileContextItem {
	kind: "file";
	/** Path as the user provided it (resolved against the session cwd). */
	path: string;
	/** 1-based inclusive range; undefined = whole file. */
	startLine?: number;
	endLine?: number;
	/** Snapshot lines exactly as shown to the user. */
	lines: FilePreviewLine[];
	/** Exact model-visible text (LF-joined, trailing CR stripped). */
	contentText: string;
	/** sha256 of `contentText` (snapshot provenance). */
	contentHash: string;
	truncated: boolean;
	truncation?: FilePreviewTruncation;
	/** Total line count of the file at snapshot time. */
	lineCount: number;
	snapshotAt: number;
}

export interface DiffContextItem {
	kind: "diff";
	path: string;
	/** The full structured diff snapshot the user saw. */
	diff: Extract<FileDiff, { status: "diff" }>;
	snapshotAt: number;
}

export type CommentAnchor =
	| { type: "file"; path: string; startLine: number; endLine: number }
	| { type: "diff"; path: string; hunkIndex: number; lines: FileDiffLine[] };

export interface CommentContextItem {
	kind: "comment";
	/** User comment text (plain text). */
	text: string;
	anchor: CommentAnchor;
	/** Snapshot text of the anchored content. */
	anchorText: string;
	/** sha256 of `anchorText`. */
	anchorHash: string;
	snapshotAt: number;
}

export type ContextItem = FileContextItem | DiffContextItem | CommentContextItem;

export interface ContextItemSummary {
	kind: ContextItem["kind"];
	path: string;
	label: string;
	startLine?: number;
	endLine?: number;
	truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Formatting (Core decides how context enters the agent input)
// ---------------------------------------------------------------------------

function describeRange(startLine: number | undefined, endLine: number | undefined): string {
	if (startLine === undefined) return "whole file";
	if (endLine === undefined) return `line ${startLine}`;
	return `lines ${startLine}-${endLine}`;
}

export function formatContextItemsForPrompt(
	items: ContextItem[],
	cwd: string,
): { text: string; summaries: ContextItemSummary[] } {
	const blocks: string[] = [];
	const summaries: ContextItemSummary[] = [];

	for (const item of items) {
		const displayPath = formatPathRelativeToCwdOrAbsolute(
			item.kind === "comment" ? item.anchor.path : item.path,
			cwd,
		);
		switch (item.kind) {
			case "file": {
				const rangeLabel = describeRange(item.startLine, item.endLine);
				blocks.push(
					["[File context]", `Path: ${displayPath}`, `Lines: ${rangeLabel}`, "", item.contentText].join("\n"),
				);
				summaries.push({
					kind: "file",
					path: displayPath,
					label: `${displayPath} · ${rangeLabel}`,
					startLine: item.startLine,
					endLine: item.endLine,
					truncated: item.truncated,
				});
				break;
			}
			case "diff": {
				blocks.push(
					["[Diff context]", `Path: ${displayPath}`, "", item.diff.unified.replace(/\n$/, "")].join("\n"),
				);
				summaries.push({ kind: "diff", path: displayPath, label: `diff · ${displayPath}` });
				break;
			}
			case "comment": {
				const anchorDescription =
					item.anchor.type === "file"
						? describeRange(item.anchor.startLine, item.anchor.endLine)
						: `diff hunk ${item.anchor.hunkIndex + 1}`;
				blocks.push(
					[
						"[User comment]",
						`Path: ${displayPath}`,
						`Lines: ${anchorDescription}`,
						"",
						"Comment:",
						item.text,
						"",
						"Anchored content:",
						item.anchorText,
					].join("\n"),
				);
				summaries.push({
					kind: "comment",
					path: displayPath,
					label: `comment · ${displayPath} · ${anchorDescription}`,
					startLine: item.anchor.type === "file" ? item.anchor.startLine : undefined,
					endLine: item.anchor.type === "file" ? item.anchor.endLine : undefined,
				});
				break;
			}
		}
	}

	return { text: blocks.join("\n\n"), summaries };
}

// ---------------------------------------------------------------------------
// Provenance validation (prompt submission time)
// ---------------------------------------------------------------------------

export type ContextValidationResult =
	| { ok: true }
	| { ok: false; code: "stale" | "invalid"; message: string; staleIndexes: number[] };

/** Defensive cap on a single context payload accepted from the host. */
const MAX_CONTEXT_TEXT_BYTES = 1024 * 1024;

function sameDiffLine(a: FileDiffLine, b: FileDiffLine): boolean {
	return a.kind === b.kind && a.oldLine === b.oldLine && a.newLine === b.newLine && a.text === b.text;
}

/**
 * Validate context items against the real filesystem / Git layer immediately
 * before a prompt is sent. Every file/diff/comment snapshot must still match
 * what the Core can read right now; stale snapshots are reported by index so
 * the host can offer a refresh instead of silently resending old content.
 *
 * Also rejects malformed paths/ranges and oversized payloads (the host is not
 * trusted to have validated them).
 */
export async function validateContextItems(items: ContextItem[], cwd: string): Promise<ContextValidationResult> {
	const staleIndexes: number[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const itemPath = item.kind === "comment" ? item.anchor.path : item.path;
		if (typeof itemPath !== "string" || itemPath.trim().length === 0) {
			return {
				ok: false,
				code: "invalid",
				message: `Context item ${index + 1} has an invalid path.`,
				staleIndexes: [],
			};
		}

		switch (item.kind) {
			case "file": {
				const outcome = await previewFile({
					path: item.path,
					cwd,
					startLine: item.startLine,
					endLine: item.endLine,
				});
				if (!outcome.ok) {
					return { ok: false, code: "invalid", message: outcome.message, staleIndexes: [] };
				}
				// Reject oversized payloads before any stale comparison (host is untrusted).
				if (Buffer.byteLength(item.contentText, "utf-8") > MAX_CONTEXT_TEXT_BYTES) {
					return {
						ok: false,
						code: "invalid",
						message: `Context item ${index + 1} exceeds the size limit.`,
						staleIndexes: [],
					};
				}
				if (outcome.contentHash !== item.contentHash) {
					staleIndexes.push(index);
					continue;
				}
				break;
			}
			case "diff": {
				const outcome = await getFileDiff({ path: item.path, cwd });
				if (!outcome.ok || outcome.diff.status !== "diff") {
					return {
						ok: false,
						code: "invalid",
						message: `Diff context for ${item.path} is no longer available.`,
						staleIndexes: [],
					};
				}
				if (outcome.diff.diffHash !== item.diff.diffHash) {
					staleIndexes.push(index);
				}
				break;
			}
			case "comment": {
				if (typeof item.text !== "string" || item.text.trim().length === 0) {
					return {
						ok: false,
						code: "invalid",
						message: `Comment context item ${index + 1} has no text.`,
						staleIndexes: [],
					};
				}
				if (item.anchor.type === "file") {
					const outcome = await previewFile({
						path: item.anchor.path,
						cwd,
						startLine: item.anchor.startLine,
						endLine: item.anchor.endLine,
					});
					if (!outcome.ok) {
						return { ok: false, code: "invalid", message: outcome.message, staleIndexes: [] };
					}
					if (outcome.contentHash !== item.anchorHash) {
						staleIndexes.push(index);
					}
				} else {
					const outcome = await getFileDiff({ path: item.anchor.path, cwd });
					if (!outcome.ok || outcome.diff.status !== "diff") {
						return {
							ok: false,
							code: "invalid",
							message: `Comment anchor diff for ${item.anchor.path} is no longer available.`,
							staleIndexes: [],
						};
					}
					const hunk = outcome.diff.hunks[item.anchor.hunkIndex];
					const matches =
						hunk !== undefined &&
						item.anchor.lines.length === hunk.lines.length &&
						item.anchor.lines.every((line, i) => sameDiffLine(line, hunk.lines[i]));
					if (!matches) {
						staleIndexes.push(index);
					}
				}
				break;
			}
		}
	}

	if (staleIndexes.length > 0) {
		return {
			ok: false,
			code: "stale",
			message: "Some context items changed since they were added. Refresh them and try again.",
			staleIndexes,
		};
	}
	return { ok: true };
}

/** Convenience: build a file context item from a Core preview snapshot. */
export function fileContextItemFromPreview(preview: {
	path: string;
	lines: FilePreviewLine[];
	contentText: string;
	contentHash: string;
	truncated: boolean;
	truncation?: FilePreviewTruncation;
	lineCount: number;
	shownStartLine?: number;
	shownEndLine?: number;
}): FileContextItem {
	return {
		kind: "file",
		path: preview.path,
		startLine: preview.shownStartLine,
		endLine: preview.shownEndLine,
		lines: preview.lines,
		contentText: preview.contentText,
		contentHash: preview.contentHash,
		truncated: preview.truncated,
		truncation: preview.truncation,
		lineCount: preview.lineCount,
		snapshotAt: Date.now(),
	};
}

export { hashText };
