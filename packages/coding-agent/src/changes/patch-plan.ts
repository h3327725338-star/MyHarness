/**
 * A unified patch written by the model: exact-text replacements in existing files and new files, planned over
 * several files at once. Edits use the same matching as the edit tool (unique, non-overlapping, matched against
 * the original), so a plan means the same thing whichever tool carries it.
 */

import { readFile } from "node:fs/promises";
import { applyEditsToNormalizedContent, normalizeToLF, restoreLineEndings } from "../tools/files/edit-diff.ts";
import {
	type BuiltChangeset,
	buildChangeset,
	type ChangeSource,
	type ModifiedFileChange,
	type NewFileChange,
} from "./changeset.ts";
import { ChangeControlError } from "./errors.ts";
import { resolveScopedFile } from "./path-scope.ts";
import { decodeTextFile, sha256 } from "./text-file.ts";

export interface PatchEdit {
	readonly oldText: string;
	readonly newText: string;
}

export type PatchChange =
	| { readonly path: string; readonly edits: readonly PatchEdit[] }
	| { readonly path: string; readonly content: string };

export const MAX_PATCH_FILES = 50;
export const MAX_PATCH_EDITS_PER_FILE = 200;
export const MAX_PATCH_NEW_FILE_BYTES = 1_000_000;

export interface PlanPatchOptions {
	readonly workspaceRoot: string;
	readonly description: string;
	readonly source?: ChangeSource;
	readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
}

function isCreate(change: PatchChange): change is { readonly path: string; readonly content: string } {
	return "content" in change;
}

export async function planPatch(changes: readonly PatchChange[], options: PlanPatchOptions): Promise<BuiltChangeset> {
	if (changes.length === 0) throw new ChangeControlError("INVALID_EDIT", "the patch has no changes");
	if (changes.length > MAX_PATCH_FILES) {
		throw new ChangeControlError("INVALID_EDIT", `a patch changes at most ${MAX_PATCH_FILES} files; split it`);
	}
	const read = options.readFile ?? ((absolutePath: string) => readFile(absolutePath));
	const modified: ModifiedFileChange[] = [];
	const created: NewFileChange[] = [];

	for (const change of changes) {
		const scoped = await resolveScopedFile(options.workspaceRoot, change.path);
		if (isCreate(change)) {
			if (scoped.exists) {
				throw new ChangeControlError(
					"EDIT_CONFLICT",
					`${scoped.path} already exists; change it with edits instead of creating it`,
					{ paths: [scoped.path] },
				);
			}
			if (Buffer.byteLength(change.content, "utf8") > MAX_PATCH_NEW_FILE_BYTES) {
				throw new ChangeControlError("INVALID_EDIT", `${scoped.path} is larger than a patch may create`, {
					paths: [scoped.path],
				});
			}
			created.push({ path: scoped.path, absolutePath: scoped.absolutePath, key: scoped.key, text: change.content });
			continue;
		}
		if (!scoped.exists) {
			throw new ChangeControlError("INVALID_EDIT", `${scoped.path} does not exist; create it with content instead`, {
				paths: [scoped.path],
			});
		}
		if (change.edits.length === 0) {
			throw new ChangeControlError("INVALID_EDIT", `${scoped.path} has no edits`, { paths: [scoped.path] });
		}
		if (change.edits.length > MAX_PATCH_EDITS_PER_FILE) {
			throw new ChangeControlError(
				"INVALID_EDIT",
				`${scoped.path} has more than ${MAX_PATCH_EDITS_PER_FILE} edits`,
				{
					paths: [scoped.path],
				},
			);
		}
		const bytes = await read(scoped.absolutePath);
		const decoded = decodeTextFile(bytes, scoped.path);
		const hasLineBreak = decoded.text.includes("\n") || decoded.text.includes("\r");
		if (hasLineBreak && (decoded.eol === undefined || decoded.eol === "\r")) {
			throw new ChangeControlError(
				"UNSUPPORTED_FILE",
				`${scoped.path} mixes line endings (or uses bare CR); a patch cannot keep them intact`,
				{ paths: [scoped.path] },
			);
		}
		const ending = decoded.eol === "\r\n" ? "\r\n" : "\n";
		let afterText: string;
		try {
			const { newContent } = applyEditsToNormalizedContent(
				normalizeToLF(decoded.text),
				change.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
				scoped.path,
			);
			afterText = restoreLineEndings(newContent, ending);
		} catch (cause) {
			throw new ChangeControlError("INVALID_EDIT", cause instanceof Error ? cause.message : String(cause), {
				paths: [scoped.path],
				cause,
			});
		}
		modified.push({
			path: scoped.path,
			absolutePath: scoped.absolutePath,
			key: scoped.key,
			baseHash: sha256(bytes),
			baseSize: bytes.length,
			format: { bom: decoded.bom, eol: decoded.eol },
			beforeText: decoded.text,
			afterText,
		});
	}
	return buildChangeset({
		workspaceRoot: options.workspaceRoot,
		description: options.description,
		source: options.source ?? "patch",
		modified,
		created,
	});
}
