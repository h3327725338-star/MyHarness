/**
 * Applying a changeset: controlled batch commit with exact recovery.
 *
 * The file system gives no atomic change of several files. What this executor promises instead:
 *   - every file is checked against the hash the plan was computed from, under locks that exclude other
 *     sessions of this process (the mutation queue) and other processes (lock directories), before and again
 *     immediately before it is replaced;
 *   - before the first write a journal names every file with its before and after hash and keeps a before image;
 *   - when anything fails or is cancelled, files this changeset wrote are restored from the before images, but
 *     only while they still hold exactly what this changeset wrote. A file somebody else changed since is left
 *     alone and reported (RECOVERY_CONFLICT) — never overwritten;
 *   - after a crash the journal says what was in flight; `recover` finishes the rollback the same way, and new
 *     changesets over the same files are refused until it has.
 * Observers can briefly see some files changed and others not; this is a recoverable batch, not a transaction.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueues } from "../tools/files/file-mutation-queue.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import type { ChangeStore, Journal, JournalEntry, MutationPermit } from "./change-store.ts";
import type { Changeset, PlannedFile } from "./changeset.ts";
import { ChangeControlError } from "./errors.ts";
import { resolveScopedFile } from "./path-scope.ts";
import { acquireProcessLocks, type HeldLocks, type ProcessLockOptions } from "./process-lock.ts";
import { sha256 } from "./text-file.ts";

/** File operations the executor performs; tests replace them to inject faults. */
export interface ChangeFs {
	read(absolutePath: string): Promise<Buffer | undefined>;
	write(absolutePath: string, bytes: Uint8Array): Promise<void>;
	remove(absolutePath: string): Promise<void>;
}

export const defaultChangeFs: ChangeFs = {
	async read(absolutePath) {
		try {
			return await readFile(absolutePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	},
	async write(absolutePath, bytes) {
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFileAtomically(absolutePath, bytes);
	},
	remove: (absolutePath) => rm(absolutePath, { force: true }),
};

export interface ChangeExecutorOptions {
	readonly store: ChangeStore;
	readonly workspaceRoot: string;
	readonly fs?: ChangeFs;
	readonly lock?: Pick<ProcessLockOptions, "timeoutMs" | "staleMs">;
	/** Called once after a changeset is committed, while its files are still locked. */
	readonly onCommitted?: (changeset: Changeset) => void | Promise<void>;
}

export interface AppliedFile {
	readonly path: string;
	readonly operation: PlannedFile["operation"];
	readonly beforeHash: string | null;
	readonly afterHash: string;
}

export interface ApplyResult {
	readonly changesetId: string;
	readonly status: "committed";
	readonly files: readonly AppliedFile[];
	/** Cancellation arrived, but every file had already been written; nothing was rolled back. */
	readonly committedAfterCancel: boolean;
	/** The change is committed; a follow-up (index refresh, notifications) failed with this message. */
	readonly observerError?: string;
}

export interface RecoveryReport {
	readonly changesetId: string;
	readonly outcome: "rolled_back" | "recovery_conflict" | "in_progress";
	readonly restored: readonly string[];
	readonly conflicts: readonly string[];
}

export interface ApplyOptions {
	readonly permitId: string;
	readonly signal?: AbortSignal;
	readonly now?: number;
}

function sameFiles(permit: MutationPermit, changeset: Changeset): boolean {
	if (permit.files.length !== changeset.files.length) return false;
	return changeset.files.every((file, index) => {
		const granted = permit.files[index];
		return (
			granted !== undefined &&
			granted.path === file.path &&
			granted.baseHash === file.baseHash &&
			granted.afterHash === file.afterHash
		);
	});
}

/** The permit grants exactly this changeset, with these files and these hashes, now. */
export function checkPermit(permit: MutationPermit | undefined, changeset: Changeset, now: number): MutationPermit {
	if (!permit) throw new ChangeControlError("PERMIT_REQUIRED", "this change needs an approved permit");
	if (permit.changesetId !== changeset.id || !sameFiles(permit, changeset)) {
		throw new ChangeControlError("PERMIT_INVALID", "the permit was issued for a different change");
	}
	if (permit.workspaceRoot.toLowerCase() !== changeset.workspaceRoot.toLowerCase()) {
		throw new ChangeControlError("PERMIT_INVALID", "the permit was issued for a different workspace");
	}
	if (permit.expiresAt <= now) throw new ChangeControlError("PERMIT_INVALID", "the permit has expired");
	return permit;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ChangeExecutor {
	private readonly store: ChangeStore;
	private readonly workspaceRoot: string;
	private readonly fs: ChangeFs;
	private readonly lockOptions: Pick<ProcessLockOptions, "timeoutMs" | "staleMs">;
	private readonly onCommitted: ChangeExecutorOptions["onCommitted"];

	constructor(options: ChangeExecutorOptions) {
		this.store = options.store;
		this.workspaceRoot = options.workspaceRoot;
		this.fs = options.fs ?? defaultChangeFs;
		this.lockOptions = options.lock ?? {};
		this.onCommitted = options.onCommitted;
	}

	// --- apply ------------------------------------------------------------------------------------------------

	async apply(changesetId: string, options: ApplyOptions): Promise<ApplyResult> {
		const now = options.now ?? Date.now();
		const built = await this.store.loadChangeset(changesetId);
		if (!built) throw new ChangeControlError("NOT_FOUND", `no stored changeset ${changesetId}; preview it again`);
		const changeset = built.changeset;
		checkPermit(this.store.loadPermit(options.permitId), changeset, now);
		if (changeset.workspaceRoot.toLowerCase() !== this.workspaceRoot.toLowerCase()) {
			throw new ChangeControlError("PERMIT_INVALID", "the changeset belongs to a different workspace");
		}
		if (changeset.files.length === 0) {
			throw new ChangeControlError("INVALID_EDIT", "the changeset has no file changes");
		}
		if (options.signal?.aborted) throw new ChangeControlError("CANCELLED", "cancelled before anything was changed");

		await this.refuseWhileRecoveryPending(changeset);
		if (!(await this.store.consumePermit(options.permitId))) {
			throw new ChangeControlError("PERMIT_INVALID", "the permit was already used; request a new approval");
		}

		let touched = false;
		try {
			return await withFileMutationQueues(
				changeset.files.map((file) => file.absolutePath),
				async () => {
					const held = await acquireProcessLocks(
						changeset.files.map((file) => file.key),
						{ lockRoot: this.store.lockRoot, ...this.lockOptions, signal: options.signal },
					);
					try {
						return await this.commit(changeset, built.content.after, held, options.signal, () => {
							touched = true;
						});
					} finally {
						await held.release();
					}
				},
				{ signal: options.signal },
			);
		} catch (error) {
			// Nothing was written: the approval is still good for exactly this change.
			if (!touched) this.store.releasePermit(options.permitId);
			if (!touched && options.signal?.aborted && !(error instanceof ChangeControlError)) {
				throw new ChangeControlError("CANCELLED", "cancelled while waiting for the files to be free", {
					cause: error,
				});
			}
			throw error;
		}
	}

	private async commit(
		changeset: Changeset,
		after: ReadonlyMap<string, Buffer>,
		held: HeldLocks,
		signal: AbortSignal | undefined,
		markTouched: () => void,
	): Promise<ApplyResult> {
		const states = await this.preflight(changeset);
		const journal: Journal = {
			version: 1,
			changesetId: changeset.id,
			workspaceRoot: changeset.workspaceRoot,
			owner: { pid: process.pid, startedAt: Date.now() },
			state: "applying",
			updatedAt: Date.now(),
			entries: changeset.files.map((file, index) => ({
				index,
				path: file.path,
				absolutePath: file.absolutePath,
				key: file.key,
				operation: file.operation,
				beforeHash: file.baseHash,
				afterHash: file.afterHash,
				state: "pending",
			})),
		};
		for (const [index, current] of states.entries()) {
			if (current) await this.store.writeBefore(changeset.id, index, current);
		}
		await this.store.writeJournal(journal);

		let failure: unknown;
		for (const entry of journal.entries) {
			try {
				if (signal?.aborted) {
					throw new ChangeControlError("CANCELLED", "cancelled while the change was being applied");
				}
				const compromised = held.compromised();
				if (compromised) {
					throw new ChangeControlError("LOCK_TIMEOUT", "a lock on the files was lost while changing them", {
						cause: compromised,
					});
				}
				const file = changeset.files[entry.index] as PlannedFile;
				await this.verifyBase(file);
				markTouched();
				await this.fs.write(file.absolutePath, after.get(file.path) as Buffer);
				const written = await this.fs.read(file.absolutePath);
				if (!written || sha256(written) !== file.afterHash) {
					throw new ChangeControlError("EDIT_CONFLICT", `${file.path} does not hold the written content`, {
						paths: [file.path],
					});
				}
				entry.state = "committed";
				await this.store.writeJournal(journal);
			} catch (error) {
				failure = error;
				break;
			}
		}

		if (failure === undefined) return this.finishCommitted(changeset, journal, signal?.aborted === true);

		const report = await this.rollback(journal);
		if (report.conflicts.length > 0) {
			throw new ChangeControlError(
				"RECOVERY_CONFLICT",
				`the change failed (${describe(failure)}) and ${report.conflicts.join(", ")} could not be restored because ` +
					"it changed since; nothing else was touched. Resolve it by hand, then recover",
				{ paths: report.conflicts, cause: failure },
			);
		}
		if (failure instanceof ChangeControlError) {
			const note = report.restored.length > 0 ? "; changes already written were rolled back" : "";
			throw new ChangeControlError(failure.code, `${failure.message}${note}`, {
				paths: failure.paths,
				cause: failure,
			});
		}
		throw failure;
	}

	private async finishCommitted(changeset: Changeset, journal: Journal, cancelled: boolean): Promise<ApplyResult> {
		journal.state = "committed";
		await this.store.writeJournal(journal);
		this.store.removeBefore(changeset.id);
		let observerError: string | undefined;
		try {
			await this.onCommitted?.(changeset);
		} catch (error) {
			observerError = describe(error);
		}
		return {
			changesetId: changeset.id,
			status: "committed",
			files: changeset.files.map((file) => ({
				path: file.path,
				operation: file.operation,
				beforeHash: file.baseHash,
				afterHash: file.afterHash,
			})),
			committedAfterCancel: cancelled,
			...(observerError === undefined ? {} : { observerError }),
		};
	}

	/** Every file must still be what the plan started from; returns the current bytes of files that exist. */
	private async preflight(changeset: Changeset): Promise<Array<Buffer | undefined>> {
		const states: Array<Buffer | undefined> = [];
		for (const file of changeset.files) {
			const scoped = await resolveScopedFile(this.workspaceRoot, file.absolutePath);
			if (scoped.key !== file.key || scoped.absolutePath.toLowerCase() !== file.absolutePath.toLowerCase()) {
				throw new ChangeControlError("EDIT_CONFLICT", `${file.path} now resolves to a different file`, {
					paths: [file.path],
				});
			}
			const current = await this.fs.read(file.absolutePath);
			if (file.operation === "create") {
				if (current) {
					throw new ChangeControlError("EDIT_CONFLICT", `${file.path} was created since the change was planned`, {
						paths: [file.path],
					});
				}
			} else if (!current || sha256(current) !== file.baseHash) {
				throw new ChangeControlError(
					"EDIT_CONFLICT",
					`${file.path} changed since the change was planned; preview it again`,
					{ paths: [file.path] },
				);
			}
			states.push(current);
		}
		return states;
	}

	/** The second compare-and-swap, immediately before the file is replaced. */
	private async verifyBase(file: PlannedFile): Promise<void> {
		const current = await this.fs.read(file.absolutePath);
		const ok =
			file.operation === "create"
				? current === undefined
				: current !== undefined && sha256(current) === file.baseHash;
		if (!ok) {
			throw new ChangeControlError("EDIT_CONFLICT", `${file.path} was changed by someone else while applying`, {
				paths: [file.path],
			});
		}
	}

	// --- rollback and recovery ----------------------------------------------------------------------------------

	/** Restore what this journal wrote, entry by entry, only where the file still holds this journal's content. */
	private async rollback(journal: Journal): Promise<{ restored: string[]; conflicts: string[] }> {
		const restored: string[] = [];
		const conflicts: string[] = [];
		for (const entry of [...journal.entries].reverse()) {
			const outcome = await this.restoreEntry(journal, entry);
			if (outcome === "restored") restored.push(entry.path);
			else if (outcome === "conflict") conflicts.push(entry.path);
		}
		journal.state = conflicts.length > 0 ? "recovery_conflict" : "rolled_back";
		journal.note = conflicts.length > 0 ? `not restored: ${conflicts.join(", ")}` : undefined;
		await this.store.writeJournal(journal);
		if (conflicts.length === 0) this.store.removeBefore(journal.changesetId);
		return { restored, conflicts };
	}

	/**
	 * Put one file back, but only if it still holds what this changeset wrote. An atomic write leaves a file at
	 * its before or its after content, never in between, so any other content on an entry this changeset did not
	 * write yet is somebody else's and stays; on an entry it did write, other content means the person changed
	 * the file since, and that is reported as a conflict instead of being overwritten.
	 */
	private async restoreEntry(journal: Journal, entry: JournalEntry): Promise<"restored" | "untouched" | "conflict"> {
		const writtenByUs = entry.state === "committed" || entry.state === "conflict";
		const current = await this.fs.read(entry.absolutePath);
		const currentHash = current ? sha256(current) : null;
		if (currentHash === entry.beforeHash) {
			if (writtenByUs) entry.state = "restored";
			return "untouched";
		}
		if (currentHash !== entry.afterHash) {
			if (!writtenByUs) return "untouched";
			entry.state = "conflict";
			return "conflict";
		}
		if (entry.operation === "create") {
			await this.fs.remove(entry.absolutePath);
		} else {
			const before = await this.store.readBefore(journal.changesetId, entry.index);
			if (sha256(before) !== entry.beforeHash) {
				entry.state = "conflict";
				return "conflict";
			}
			await this.fs.write(entry.absolutePath, before);
		}
		entry.state = "restored";
		return "restored";
	}

	/**
	 * A crashed or conflicted journal over any of this changeset's files blocks it. A journal whose
	 * owner is still running (its locks are held) is not ours to judge: the locks order us behind it.
	 */
	private async refuseWhileRecoveryPending(changeset: Changeset): Promise<void> {
		const wanted = new Set(changeset.files.map((file) => file.key));
		for (const journal of this.store.listJournals()) {
			if (journal.state === "committed" || journal.state === "rolled_back") continue;
			if (!journal.entries.some((entry) => wanted.has(entry.key))) continue;
			const report = await this.recoverJournal(journal);
			if (report.outcome === "recovery_conflict") {
				throw new ChangeControlError(
					"RECOVERY_CONFLICT",
					`an unfinished change (${journal.changesetId}) could not be restored for ${report.conflicts.join(", ")}; ` +
						"resolve those files by hand, then recover it",
					{ paths: report.conflicts },
				);
			}
		}
	}

	/** Finish or re-check every unfinished journal of this workspace. */
	async recover(): Promise<RecoveryReport[]> {
		const reports: RecoveryReport[] = [];
		for (const journal of this.store.listJournals()) {
			if (journal.state === "committed" || journal.state === "rolled_back") continue;
			reports.push(await this.recoverJournal(journal));
		}
		return reports;
	}

	private async recoverJournal(journal: Journal): Promise<RecoveryReport> {
		let held: HeldLocks;
		try {
			held = await acquireProcessLocks(
				journal.entries.map((entry) => entry.key),
				{ lockRoot: this.store.lockRoot, ...this.lockOptions, timeoutMs: 0 },
			);
		} catch (error) {
			if (error instanceof ChangeControlError && error.code === "LOCK_TIMEOUT") {
				return { changesetId: journal.changesetId, outcome: "in_progress", restored: [], conflicts: [] };
			}
			throw error;
		}
		try {
			return await withFileMutationQueues(
				journal.entries.map((entry) => entry.absolutePath),
				async () => {
					const { restored, conflicts } = await this.rollback(journal);
					return {
						changesetId: journal.changesetId,
						outcome: conflicts.length > 0 ? ("recovery_conflict" as const) : ("rolled_back" as const),
						restored,
						conflicts,
					};
				},
			);
		} finally {
			await held.release();
		}
	}
}
