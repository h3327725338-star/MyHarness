/**
 * Trust full-name ranges against disk, or minimal ranges only when their surrounding identifier uniquely
 * reconstructs the requested old and new names. Full-name server edits may include alias-preserving syntax.
 */

import { ChangeControlError } from "./errors.ts";
import type { DecodedFileEdit } from "./workspace-edit.ts";

const SHOWN_PROBLEMS = 5;

function quoted(text: string): string {
	const shown = text.length > 40 ? `${text.slice(0, 37)}...` : text;
	return JSON.stringify(shown);
}

export function verifyRenameEdits(
	files: readonly DecodedFileEdit[],
	oldName: string,
	newName?: string,
): { replacements: number } {
	let replacements = 0;
	const problems: string[] = [];
	for (const file of files) {
		for (const edit of file.edits) {
			replacements++;
			if (edit.oldText === oldName) continue;
			// Roslyn may emit a minimal edit that leaves a shared prefix/suffix unchanged.
			// Accept only when the surrounding full token exactly reconstructs both names.
			let matches = 0;
			if (newName !== undefined && /^[\p{L}\p{N}_$]+$/u.test(oldName)) {
				for (let prefix = 0; prefix <= oldName.length - edit.oldText.length; prefix++) {
					const start = edit.start - prefix;
					const end = start + oldName.length;
					if (start < 0 || end > file.beforeText.length || edit.end > end) continue;
					if (file.beforeText.slice(start, end) !== oldName) continue;
					if (
						/[\p{L}\p{N}_$]/u.test(file.beforeText[start - 1] ?? "") ||
						/[\p{L}\p{N}_$]/u.test(file.beforeText[end] ?? "")
					)
						continue;
					if (
						file.beforeText.slice(start, edit.start) + edit.newText + file.beforeText.slice(edit.end, end) ===
						newName
					)
						matches++;
				}
			}
			if (matches !== 1)
				problems.push(
					`${file.path}: the edit replaces ${quoted(edit.oldText)}, not a verified rename of ${quoted(oldName)}`,
				);
		}
	}
	if (replacements === 0) {
		throw new ChangeControlError("INVALID_EDIT", "the rename edit changes nothing");
	}
	if (problems.length > 0) {
		const more = problems.length > SHOWN_PROBLEMS ? ` (and ${problems.length - SHOWN_PROBLEMS} more)` : "";
		throw new ChangeControlError(
			"SNAPSHOT_STALE",
			`the language server's rename does not match the files on disk${more}: ${problems.slice(0, SHOWN_PROBLEMS).join("; ")}. ` +
				"It may be working from an older version of them. Nothing was changed.",
			{ paths: [...new Set(files.map((file) => file.path))] },
		);
	}
	return { replacements };
}
