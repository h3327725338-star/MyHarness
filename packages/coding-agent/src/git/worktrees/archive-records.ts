/**
 * Finished copies are archived instead of deleted.
 *
 * A copy (Git worktree) that nobody works in any more keeps its folder, its commits and any uncommitted files right
 * where they are; only the copy list stops showing it as active. Nothing in this module removes a directory or deletes
 * a branch. Releasing a branch means detaching a clean copy, which keeps the commit reachable through the copy's own
 * HEAD, and the branch name is stored here so restoring can check it out again.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import { worktreeId } from "./display-name.ts";

/** Why a copy exists. Written when the copy is created, so archiving never has to guess afterwards. */
export type WorktreeOrigin = "manual" | "subagent" | "external";

/** Generated branch prefix of a delegated sub-agent copy; older copies have no record, only this name. */
export const SUBAGENT_BRANCH_PREFIX = "myharness-subagent-";

export interface WorktreeArchiveRecord {
	/** Absolute copy path this record describes; kept inside the file so stale records can be pruned. */
	path: string;
	origin?: WorktreeOrigin;
	/** ISO timestamp of the archive step; absent while the copy is an active copy. */
	archivedAt?: string;
	/** Machine key of the reason: `subagent`, `temporary` or `manual`. */
	reason?: string;
	/** Branch the copy was on when it was archived, so restoring can check it out again. */
	branch?: string;
	/**
	 * Last time the branch was checked and deliberately kept because the copy still held files. Rechecking every copy
	 * that still has work on every open would cost one `git status` each; this keeps it to once per window.
	 */
	branchKeptAt?: string;
}

/** Whether `target` is `parent` itself or lies below it. Pure lexical check, no filesystem access. */
export function isInsideDirectory(target: string, parent: string): boolean {
	if (!target || !parent) return false;
	const inside = relative(resolvePath(parent), resolvePath(target));
	return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

export interface AutoArchiveCandidate {
	path: string;
	branch?: string;
	isMain: boolean;
	record?: WorktreeArchiveRecord;
	/** OS temporary directory, passed in so the rule stays pure and testable. */
	tempDir: string;
}

/**
 * Reason key when a copy should be archived automatically, or `undefined` when it stays an active copy.
 *
 * - Copies this app created on purpose are never archived behind the user's back.
 * - Sub-agent copies are archived as soon as their task is over.
 * - Copies without any record were created before origins were recorded: a detached one, or one that sits in the OS
 *   temporary directory, is a leftover from a script run. Anything else may be a copy the user works in.
 */
export function autoArchiveReason(candidate: AutoArchiveCandidate): "subagent" | "temporary" | undefined {
	if (candidate.isMain || candidate.record?.archivedAt) return undefined;
	const origin = candidate.record?.origin;
	if (origin === "manual") return undefined;
	if (origin === "subagent") return "subagent";
	if (origin === "external") return "temporary";
	// Sub-agent copies created before origins were recorded still carry their generated branch name.
	if (candidate.branch?.startsWith(SUBAGENT_BRANCH_PREFIX)) return "subagent";
	if (!candidate.branch || isInsideDirectory(candidate.path, candidate.tempDir)) return "temporary";
	return undefined;
}

function parseRecord(text: string): WorktreeArchiveRecord | undefined {
	const data = JSON.parse(text) as Partial<WorktreeArchiveRecord>;
	if (typeof data.path !== "string" || !data.path) return undefined;
	const origin =
		data.origin === "manual" || data.origin === "subagent" || data.origin === "external" ? data.origin : undefined;
	return {
		path: data.path,
		origin,
		archivedAt: typeof data.archivedAt === "string" ? data.archivedAt : undefined,
		reason: typeof data.reason === "string" ? data.reason : undefined,
		branch: typeof data.branch === "string" ? data.branch : undefined,
		branchKeptAt: typeof data.branchKeptAt === "string" ? data.branchKeptAt : undefined,
	};
}

/**
 * Archive state per copy, one small JSON file under `<agentDir>/worktrees/archive`, next to the merged records.
 * Writes are atomic (temporary file plus rename) so a crash never leaves half a record behind.
 */
export class WorktreeArchiveRecords {
	private readonly agentDir: string;
	constructor(agentDir: string) {
		this.agentDir = resolvePath(agentDir);
	}

	get(path: string): WorktreeArchiveRecord | undefined {
		const file = this.file(path);
		if (!existsSync(file)) return undefined;
		try {
			const record = parseRecord(readFileSync(file, "utf8"));
			return record ? { ...record, path: resolvePath(path) } : undefined;
		} catch {
			return undefined;
		}
	}

	/** Merge `patch` into the stored record; a `undefined` value clears that field. */
	update(path: string, patch: Partial<Omit<WorktreeArchiveRecord, "path">>): WorktreeArchiveRecord {
		const merged: WorktreeArchiveRecord = { path: resolvePath(path), ...this.get(path), ...patch };
		const cleaned: WorktreeArchiveRecord = { path: merged.path };
		if (merged.origin) cleaned.origin = merged.origin;
		if (merged.archivedAt) cleaned.archivedAt = merged.archivedAt;
		if (merged.reason) cleaned.reason = merged.reason;
		if (merged.branch) cleaned.branch = merged.branch;
		if (merged.branchKeptAt) cleaned.branchKeptAt = merged.branchKeptAt;
		this.write(path, cleaned);
		return cleaned;
	}

	remove(path: string): void {
		const file = this.file(path);
		if (!existsSync(file)) return;
		try {
			unlinkSync(file);
		} catch {
			// A record that cannot be removed is harmless: the copy it describes is gone.
		}
	}

	/**
	 * Drop records whose copy no longer exists. Deleting a copy can happen here or through Git commands the app never
	 * sees; a leftover record would otherwise mark a later copy at the same path as archived.
	 */
	prune(): void {
		const dir = join(this.agentDir, "worktrees", "archive");
		if (!existsSync(dir)) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const file = join(dir, entry);
			let record: WorktreeArchiveRecord | undefined;
			try {
				record = parseRecord(readFileSync(file, "utf8"));
			} catch {
				record = undefined;
			}
			if (record && existsSync(record.path)) continue;
			try {
				unlinkSync(file);
			} catch {
				// Leaving one stale file behind only costs a read on the next prune.
			}
		}
	}

	private write(path: string, record: WorktreeArchiveRecord): void {
		const file = this.file(path);
		mkdirSync(join(this.agentDir, "worktrees", "archive"), { recursive: true });
		const temporary = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
		renameSync(temporary, file);
	}

	private file(path: string): string {
		return join(this.agentDir, "worktrees", "archive", `${worktreeId(path)}.json`);
	}
}
