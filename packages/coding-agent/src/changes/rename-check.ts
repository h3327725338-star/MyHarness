/**
 * A rename edit is only trusted when every range it replaces holds the name being renamed in the file as it is on
 * disk. A server that worked from an older version of a file, or a position that does not line up, would otherwise
 * replace unrelated text with the new name.
 */

import { ChangeControlError } from "./errors.ts";
import type { DecodedFileEdit } from "./workspace-edit.ts";

const SHOWN_PROBLEMS = 5;

function quoted(text: string): string {
	const shown = text.length > 40 ? `${text.slice(0, 37)}...` : text;
	return JSON.stringify(shown);
}

export function verifyRenameEdits(files: readonly DecodedFileEdit[], oldName: string): { replacements: number } {
	let replacements = 0;
	const problems: string[] = [];
	for (const file of files) {
		for (const edit of file.edits) {
			replacements++;
			if (edit.oldText !== oldName) {
				problems.push(`${file.path}: the edit replaces ${quoted(edit.oldText)}, not ${quoted(oldName)}`);
			}
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
