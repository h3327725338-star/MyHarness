/**
 * "What did the agent change" for the Web UI.
 *
 * Facts come from the existing change-detection layer (Git checkpoint, workspace
 * baseline, edit/write tool snapshots). This module only turns those facts into
 * per-file unified diffs; it never guesses content it cannot observe.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { GitCheckpoint } from "../../git/checkpoints/checkpoint.ts";
import { runGit, runGitSync } from "../../git/repository/command.ts";
import { inspectGitRepositoryAsync } from "../../git/repository/integration.ts";
import type { ReviewChange, ReviewChangeStatus } from "../../git/repository/review-types.ts";
import type { ChangeDetectionResult, GitTaskChangeSummary } from "../../git/repository/workspace-changes.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES_PER_RUN = 64 * 1024 * 1024;
const MAX_FILES_WITH_STATS = 300;
/** Diffs kept with a task's change card in the session: larger ones (per file, or all together) are left out. */
const MAX_CARD_PATCH_CHARS = 200_000;
const MAX_CARD_PATCH_CHARS_PER_RUN = 1_000_000;

export type ChangeScope = "session" | "run" | "worktree";

export interface FileChangeSummary {
	path: string;
	status: ReviewChangeStatus;
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
	/** Why the content diff cannot be shown (status is still real). */
	unavailable?: string;
}

/** One file of a task's change card: its summary and, while it fits the budget, its diff. */
export interface RunChangeCardFile extends FileChangeSummary {
	patch?: string;
	/** The file has a text diff, but it was too large to keep with the card. */
	patchOmitted?: boolean;
}

export interface RunChangeRecord {
	runId: number;
	startedAt: number;
	endedAt?: number;
	/** known: the change list is authoritative. indeterminate: it may be incomplete. */
	reliability: "known" | "indeterminate" | "pending";
	reason?: string;
	changes: ReviewChange[];
	git?: GitTaskChangeSummary;
	checkpointId?: string;
	checkpointStatus?: string;
	/** Tool-level file operations observed during the run (edit/write), independent of final detection. */
	toolFileOps: Array<{ path: string; tool: "edit" | "write"; ok: boolean }>;
	bashRuns: number;
}

interface Snapshot {
	/** null: the file did not exist before the first edit/write of this run. */
	before: string | null;
	binary: boolean;
}

function toRelative(cwd: string, absolute: string): string | undefined {
	const relative = path.relative(path.resolve(cwd), path.resolve(absolute));
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
	const length = Math.min(buffer.length, 8000);
	for (let index = 0; index < length; index++) {
		if (buffer[index] === 0) return true;
	}
	return false;
}

function readTextIfSmall(file: string): { text: string | null; binary: boolean; tooLarge: boolean } {
	try {
		if (!existsSync(file)) return { text: null, binary: false, tooLarge: false };
		const stat = statSync(file);
		if (!stat.isFile()) return { text: null, binary: false, tooLarge: false };
		if (stat.size > MAX_TEXT_BYTES) return { text: null, binary: false, tooLarge: true };
		const buffer = readFileSync(file);
		if (looksBinary(buffer)) return { text: null, binary: true, tooLarge: false };
		return { text: buffer.toString("utf8"), binary: false, tooLarge: false };
	} catch {
		return { text: null, binary: false, tooLarge: false };
	}
}

export function countPatchLines(patch: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

export function makePatch(
	pathName: string,
	oldText: string | null,
	newText: string | null,
	oldPathName = pathName,
): string {
	const patch = createTwoFilesPatch(
		oldText === null ? "/dev/null" : `a/${oldPathName}`,
		newText === null ? "/dev/null" : `b/${pathName}`,
		oldText ?? "",
		newText ?? "",
		"",
		"",
		{ context: 3 },
	);
	// createTwoFilesPatch prefixes an "Index:" banner; drop it so the patch starts at the file headers.
	const start = patch.indexOf("---");
	return start > 0 ? patch.slice(start) : patch;
}

function gitShow(repositoryRoot: string, spec: string): { text: string | null; binary: boolean } {
	const result = runGitSync(["show", spec], { cwd: repositoryRoot, timeoutMs: 20_000, preserveOutput: true });
	if (!result.ok) return { text: null, binary: false };
	if (result.stdout.includes("\u0000")) return { text: null, binary: true };
	return { text: result.stdout, binary: false };
}

async function gitShowAsync(repositoryRoot: string, spec: string): Promise<{ text: string | null; binary: boolean }> {
	const result = await runGit(["show", spec], {
		cwd: repositoryRoot,
		timeoutMs: 20_000,
		env: { GIT_OPTIONAL_LOCKS: "0" },
	});
	if (!result.ok) return { text: null, binary: false };
	if (result.stdout.includes("\u0000")) return { text: null, binary: true };
	return { text: result.stdout, binary: false };
}

/** Tracks per-run tool snapshots and produces file diffs. One instance per runtime cwd. */
export class ChangeTracker {
	private cwd: string;
	private readonly runs = new Map<number, RunChangeRecord>();
	private readonly snapshots = new Map<number, Map<string, Snapshot>>();
	private readonly snapshotBytes = new Map<number, number>();
	private readonly checkpoints = new Map<number, GitCheckpoint>();
	private readonly pendingBefore = new Map<string, { runId: number; rel: string }>();

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	reset(): void {
		this.runs.clear();
		this.snapshots.clear();
		this.snapshotBytes.clear();
		this.pendingBefore.clear();
		this.checkpoints.clear();
	}

	beginRun(runId: number): RunChangeRecord {
		const record: RunChangeRecord = {
			runId,
			startedAt: Date.now(),
			reliability: "pending",
			changes: [],
			toolFileOps: [],
			bashRuns: 0,
		};
		this.runs.set(runId, record);
		this.snapshots.set(runId, new Map());
		this.snapshotBytes.set(runId, 0);
		// Keep memory bounded: only the most recent runs retain snapshots.
		const ids = [...this.runs.keys()].sort((a, b) => a - b);
		while (ids.length > 12) {
			const drop = ids.shift()!;
			this.runs.delete(drop);
			this.snapshots.delete(drop);
			this.snapshotBytes.delete(drop);
			this.checkpoints.delete(drop);
		}
		return record;
	}

	getRun(runId: number): RunChangeRecord | undefined {
		return this.runs.get(runId);
	}

	/** Live status of the checkpoint recorded for a run ("restored" after Undo). */
	checkpointStatus(runId: number): string | undefined {
		return this.checkpoints.get(runId)?.status;
	}

	latestRunId(): number | undefined {
		const ids = [...this.runs.keys()];
		return ids.length ? Math.max(...ids) : undefined;
	}

	listRuns(): RunChangeRecord[] {
		return [...this.runs.values()].sort((a, b) => b.runId - a.runId);
	}

	/** Capture the file's content before an edit/write executes (first touch per run wins). */
	captureBefore(runId: number, toolCallId: string, tool: "edit" | "write", args: { path?: unknown }): void {
		if (typeof args?.path !== "string") return;
		const absolute = path.resolve(this.cwd, args.path);
		const rel = toRelative(this.cwd, absolute);
		if (!rel) return;
		this.pendingBefore.set(toolCallId, { runId, rel });
		const snapshots = this.snapshots.get(runId);
		if (!snapshots || snapshots.has(rel)) return;
		const read = readTextIfSmall(absolute);
		if (read.tooLarge) return;
		const size = read.text ? Buffer.byteLength(read.text) : 0;
		const total = (this.snapshotBytes.get(runId) ?? 0) + size;
		if (total > MAX_SNAPSHOT_BYTES_PER_RUN) return;
		this.snapshotBytes.set(runId, total);
		snapshots.set(rel, { before: read.text, binary: read.binary });
		void tool;
	}

	recordToolOp(runId: number, toolCallId: string, tool: "edit" | "write", ok: boolean): void {
		const pending = this.pendingBefore.get(toolCallId);
		this.pendingBefore.delete(toolCallId);
		const record = this.runs.get(runId);
		if (!record || !pending) return;
		record.toolFileOps.push({ path: pending.rel, tool, ok });
	}

	recordBash(runId: number): void {
		const record = this.runs.get(runId);
		if (record) record.bashRuns += 1;
	}

	finishRun(
		runId: number,
		detection: ChangeDetectionResult | undefined,
		checkpoint: GitCheckpoint | undefined,
	): RunChangeRecord | undefined {
		const record = this.runs.get(runId);
		if (!record) return undefined;
		record.endedAt = Date.now();
		if (detection) {
			record.reliability = detection.status;
			record.changes = [...detection.changes];
			if (detection.status === "indeterminate") record.reason = detection.reason;
			record.git = detection.git;
			this.mergeToolChanges(runId, record);
		} else {
			// Fall back to observed edit/write operations so the run still reports real file writes.
			record.reliability = "indeterminate";
			record.reason = "Final change detection was unavailable; showing files touched by edit/write only.";
			this.mergeToolChanges(runId, record);
		}
		if (checkpoint) {
			this.checkpoints.set(runId, checkpoint);
			record.checkpointId = checkpoint.id;
			record.checkpointStatus = checkpoint.status;
		}
		return record;
	}

	/**
	 * edit/write calls are observed directly (before/after content). Final change detection does not
	 * cover them when Git integration is off and no shell command ran, so add the net effect here.
	 */
	private mergeToolChanges(runId: number, record: RunChangeRecord): void {
		const known = new Set(record.changes.map((change) => change.path));
		const snapshots = this.snapshots.get(runId);
		for (const op of record.toolFileOps) {
			if (!op.ok || known.has(op.path)) continue;
			const snapshot = snapshots?.get(op.path);
			const absolute = path.resolve(this.cwd, op.path);
			const exists = existsSync(absolute);
			if (!snapshot) {
				known.add(op.path);
				record.changes.push({ path: op.path, status: exists ? "modified" : "deleted" });
				continue;
			}
			const after = readTextIfSmall(absolute);
			if (snapshot.before === null && !exists) continue;
			if (snapshot.before !== null && after.text === snapshot.before && exists) continue;
			known.add(op.path);
			record.changes.push({
				path: op.path,
				status: snapshot.before === null ? "added" : exists ? "modified" : "deleted",
			});
		}
	}

	private beforeFor(
		runId: number,
		change: ReviewChange,
		checkpoint: GitCheckpoint | undefined,
	): { text: string | null; binary: boolean; known: boolean } {
		const snapshot = this.snapshots.get(runId)?.get(change.path);
		if (snapshot) return { text: snapshot.before, binary: snapshot.binary, known: true };
		if (checkpoint?.worktreeTree) {
			const repoRelative = toRelative(
				checkpoint.repositoryRoot,
				path.resolve(this.cwd, change.oldPath ?? change.path),
			);
			if (repoRelative) {
				const shown = gitShow(checkpoint.repositoryRoot, `${checkpoint.worktreeTree}:${repoRelative}`);
				if (shown.binary) return { text: null, binary: true, known: true };
				if (shown.text !== null) return { text: shown.text, binary: false, known: true };
				// Not in the baseline tree: the file was created during the run.
				if (change.status === "added") return { text: null, binary: false, known: true };
			}
		}
		if (change.status === "added") return { text: null, binary: false, known: true };
		return { text: null, binary: false, known: false };
	}

	/** Compute the diff for one file of a run. */
	diffForRunFile(
		runId: number,
		filePath: string,
		checkpoint: GitCheckpoint | undefined,
	): { summary: FileChangeSummary; patch?: string } | undefined {
		const record = this.runs.get(runId);
		const change = record?.changes.find((candidate) => candidate.path === filePath);
		if (!record || !change) return undefined;
		const summary: FileChangeSummary = {
			path: change.path,
			status: change.status,
			...(change.oldPath ? { oldPath: change.oldPath } : {}),
			additions: 0,
			deletions: 0,
			binary: false,
		};
		const absolute = path.resolve(this.cwd, change.path);
		const before = this.beforeFor(runId, change, this.checkpoints.get(runId) ?? checkpoint);
		const after =
			change.status === "deleted" ? { text: null, binary: false, tooLarge: false } : readTextIfSmall(absolute);
		if (before.binary || after.binary) {
			summary.binary = true;
			return { summary };
		}
		if (after.tooLarge) {
			summary.unavailable = "File is larger than 2 MB; content diff skipped.";
			return { summary };
		}
		if (!before.known) {
			summary.unavailable =
				(this.checkpoints.get(runId) ?? checkpoint)
					? "The file's content before the task could not be read from the Git checkpoint."
					: "No Git checkpoint: the pre-task content of files changed by shell commands is not recorded.";
			return { summary };
		}
		const patch = makePatch(change.path, before.text, after.text, change.oldPath ?? change.path);
		const counts = countPatchLines(patch);
		summary.additions = counts.additions;
		summary.deletions = counts.deletions;
		return { summary, patch };
	}

	summariseRun(runId: number, checkpoint: GitCheckpoint | undefined): FileChangeSummary[] {
		const record = this.runs.get(runId);
		if (!record) return [];
		return record.changes.slice(0, MAX_FILES_WITH_STATS).map((change, index) => {
			const diff = this.diffForRunFile(runId, change.path, checkpoint);
			void index;
			return (
				diff?.summary ?? {
					path: change.path,
					status: change.status,
					additions: 0,
					deletions: 0,
					binary: false,
				}
			);
		});
	}

	/**
	 * What a finished run changed, as its change card keeps it: every file with its counts and its diff as it is at this
	 * moment. Later runs change the same files again, so the diff is taken now and not when the card is opened.
	 */
	runChangeCard(runId: number, checkpoint: GitCheckpoint | undefined): RunChangeCardFile[] {
		const record = this.runs.get(runId);
		if (!record) return [];
		let kept = 0;
		return record.changes.slice(0, MAX_FILES_WITH_STATS).map((change): RunChangeCardFile => {
			const diff = this.diffForRunFile(runId, change.path, checkpoint);
			if (!diff) return { path: change.path, status: change.status, additions: 0, deletions: 0, binary: false };
			if (!diff.patch) return diff.summary;
			if (diff.patch.length > MAX_CARD_PATCH_CHARS || kept + diff.patch.length > MAX_CARD_PATCH_CHARS_PER_RUN) {
				return { ...diff.summary, patchOmitted: true };
			}
			kept += diff.patch.length;
			return { ...diff.summary, patch: diff.patch };
		});
	}

	// ---------------------------------------------------------------------
	// Working tree (all uncommitted changes versus HEAD)
	// ---------------------------------------------------------------------

	// The working-tree view runs Git asynchronously: a large or slow repository must not stall the Web server.
	async listWorktreeChanges(): Promise<{ repositoryRoot?: string; changes: ReviewChange[]; error?: string }> {
		const state = await inspectGitRepositoryAsync(this.cwd);
		if (!state.isRepository || !state.root) {
			return {
				changes: [],
				error: state.gitAvailable ? "The workspace is not a Git repository." : "Git is not available.",
			};
		}
		const result = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			cwd: state.root,
			timeoutMs: 30_000,
			env: { GIT_OPTIONAL_LOCKS: "0" },
		});
		if (!result.ok) return { repositoryRoot: state.root, changes: [], error: result.stderr || result.error };
		const changes: ReviewChange[] = [];
		const fields = result.stdout.split("\u0000");
		for (let index = 0; index < fields.length; index++) {
			const field = fields[index];
			if (field.length < 4) continue;
			const x = field[0];
			const y = field[1];
			let file = field.slice(3);
			let oldPath: string | undefined;
			if (x === "R" || x === "C") {
				oldPath = fields[++index];
			}
			const absolute = path.join(state.root, file);
			const rel = toRelative(this.cwd, absolute);
			if (!rel) continue;
			file = rel;
			let status: ReviewChangeStatus = "modified";
			if (x === "?" || x === "A" || y === "A") status = "added";
			else if (x === "D" || y === "D") status = "deleted";
			else if (x === "R") status = "renamed";
			const oldRel = oldPath ? toRelative(this.cwd, path.join(state.root, oldPath)) : undefined;
			changes.push({ path: file, status, ...(oldRel ? { oldPath: oldRel } : {}) });
		}
		return { repositoryRoot: state.root, changes };
	}

	async diffForWorktreeFile(
		repositoryRoot: string,
		change: ReviewChange,
	): Promise<{ summary: FileChangeSummary; patch?: string }> {
		const summary: FileChangeSummary = {
			path: change.path,
			status: change.status,
			...(change.oldPath ? { oldPath: change.oldPath } : {}),
			additions: 0,
			deletions: 0,
			binary: false,
		};
		const beforePath = toRelative(repositoryRoot, path.resolve(this.cwd, change.oldPath ?? change.path));
		const before =
			change.status === "added" || !beforePath
				? { text: null, binary: false }
				: await gitShowAsync(repositoryRoot, `HEAD:${beforePath}`);
		const after =
			change.status === "deleted"
				? { text: null, binary: false, tooLarge: false }
				: readTextIfSmall(path.resolve(this.cwd, change.path));
		if (before.binary || after.binary) {
			summary.binary = true;
			return { summary };
		}
		if (after.tooLarge) {
			summary.unavailable = "File is larger than 2 MB; content diff skipped.";
			return { summary };
		}
		const patch = makePatch(change.path, before.text, after.text, change.oldPath ?? change.path);
		const counts = countPatchLines(patch);
		summary.additions = counts.additions;
		summary.deletions = counts.deletions;
		return { summary, patch };
	}
}
