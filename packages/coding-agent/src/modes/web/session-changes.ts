import type { SessionEntry } from "../../session/types.ts";
import type { FileChangeSummary, RunChangeCardFile } from "./changes.ts";
import { RUN_CHANGES_ENTRY, runChangesToWire } from "./wire.ts";

export interface SessionFileDiff {
	entryId: string;
	runId: number;
	timestamp: string;
	summary: FileChangeSummary;
	patch?: string;
}

/** Historical edits on the current branch, not a net diff or a claim about uncommitted ownership. */
export function collectSessionChanges(entries: readonly SessionEntry[]): {
	files: FileChangeSummary[];
	diffs: Map<string, SessionFileDiff[]>;
} {
	const files = new Map<string, FileChangeSummary>();
	const diffs = new Map<string, SessionFileDiff[]>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== RUN_CHANGES_ENTRY) continue;
		const wire = runChangesToWire(entry.id, Date.parse(entry.timestamp), entry.data);
		if (wire?.kind !== "runChanges") continue;
		const card = entry.data as { files: RunChangeCardFile[] };
		for (const file of wire.files) {
			const saved = card.files.find((candidate) => candidate?.path === file.path);
			if (!saved) continue;
			const summary: FileChangeSummary = {
				path: file.path,
				status: saved.status,
				...(file.oldPath ? { oldPath: file.oldPath } : {}),
				additions: file.additions,
				deletions: file.deletions,
				binary: file.binary,
				...(file.unavailable ? { unavailable: file.unavailable } : {}),
				...(saved.patchOmitted
					? { unavailable: "The diff of this file was too large to keep with the chat." }
					: {}),
			};
			const previous = files.get(file.path);
			files.set(file.path, {
				...summary,
				additions: (previous?.additions ?? 0) + summary.additions,
				deletions: (previous?.deletions ?? 0) + summary.deletions,
				binary: !!previous?.binary || summary.binary,
				...(previous?.unavailable || summary.unavailable
					? { unavailable: previous?.unavailable || summary.unavailable }
					: {}),
			});
			const history = diffs.get(file.path) ?? [];
			history.push({
				entryId: entry.id,
				runId: wire.runId,
				timestamp: entry.timestamp,
				summary,
				...(typeof saved.patch === "string" && !saved.patchOmitted ? { patch: saved.patch } : {}),
			});
			diffs.set(file.path, history);
		}
	}
	return { files: [...files.values()], diffs };
}
