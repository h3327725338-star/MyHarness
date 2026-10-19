/**
 * Cross-session attribution for workspace changes.
 *
 * Several conversations can be open on the same workspace at the same time, and
 * they share one filesystem and one Git state. A run's final change detection
 * compares the workspace against its baseline, so it sees "what changed", not
 * "who changed it": without a record of what each conversation did itself, a
 * change card picks up files another conversation wrote in the same window.
 *
 * Every session records here what it changed itself - direct file operations
 * (edit / write / apply_patch) and the windows during which it ran shell
 * commands, which change files opaquely. A finished run then drops the files
 * another session's record explains, an undo lists the files it would roll
 * back that another conversation changed, and the Changes panel asks who changed
 * an uncommitted file last (see session-ownership.ts).
 *
 * The registry is process-local: it knows the sessions of this app instance.
 * Another MyHarness process, or any unrelated program, on the same workspace
 * leaves no record; its changes stay in the change list as unattributed ones.
 */

import { resolve } from "node:path";
import { pathIdentityKey } from "../../utils/paths.ts";

export interface ChangeClaim {
	sessionKey: string;
	runId: number;
	/** Absolute path of the file this session changed. */
	path: string;
	at: number;
	/** The tool that made the change, for diagnostics only. */
	tool: string;
}

export interface ShellWindow {
	sessionKey: string;
	runId: number;
	startedAt: number;
	endedAt: number;
}

/** Records stay long enough to explain an old checkpoint's undo; the age window bounds memory. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const PRUNE_CLAIM_COUNT = 50_000;

export class ChangeClaimRegistry {
	private readonly claims = new Map<string, ChangeClaim[]>();
	private shellWindows: ShellWindow[] = [];
	private claimCount = 0;
	private lastPruneAt = 0;

	record(claim: ChangeClaim): void {
		const key = pathIdentityKey(claim.path);
		const list = this.claims.get(key);
		if (list) list.push(claim);
		else this.claims.set(key, [claim]);
		this.claimCount += 1;
		this.maybePrune();
	}

	recordShell(window: ShellWindow): void {
		this.shellWindows.push(window);
		this.maybePrune();
	}

	/** The newest direct change of `path` on record, whoever made it, or undefined when nobody recorded one. */
	latestClaim(path: string): ChangeClaim | undefined {
		const list = this.claims.get(pathIdentityKey(path));
		if (!list || list.length === 0) return undefined;
		let latest = list[0];
		for (const claim of list) if (claim.at > latest.at) latest = claim;
		return latest;
	}

	/** The shell windows of any session that cover `at`; a command run then may have written the file. */
	windowsCovering(at: number): ShellWindow[] {
		return this.shellWindows.filter((window) => window.startedAt <= at && at <= window.endedAt);
	}

	/** Whether a session other than `sessionKey` claimed `path` at a time inside [from, to]. */
	foreignClaim(path: string, sessionKey: string, from: number, to: number): boolean {
		const list = this.claims.get(pathIdentityKey(path));
		if (!list) return false;
		for (const claim of list) {
			if (claim.sessionKey !== sessionKey && claim.at >= from && claim.at <= to) return true;
		}
		return false;
	}

	/** Whether a shell window of another session covers `at`. */
	foreignShellCovers(at: number, sessionKey: string): boolean {
		return this.shellWindows.some(
			(window) => window.sessionKey !== sessionKey && window.startedAt <= at && at <= window.endedAt,
		);
	}

	/** Whether a shell window of this session covers `at`. */
	ownShellCovers(sessionKey: string, at: number): boolean {
		return this.shellWindows.some(
			(window) => window.sessionKey === sessionKey && window.startedAt <= at && at <= window.endedAt,
		);
	}

	/**
	 * The candidates another session changed at or after `since` - by a direct
	 * file operation or inside one of its shell windows. Used before an undo:
	 * rolling the workspace back to an old checkpoint takes these changes with it.
	 */
	foreignChangedSince<T extends { path: string; modifiedAt?: number }>(
		candidates: readonly T[],
		sessionKey: string,
		since: number,
	): T[] {
		const foreign: T[] = [];
		for (const candidate of candidates) {
			if (this.foreignClaim(candidate.path, sessionKey, since, Number.POSITIVE_INFINITY)) {
				foreign.push(candidate);
				continue;
			}
			const at = candidate.modifiedAt;
			if (at !== undefined && at >= since && this.foreignShellCovers(at, sessionKey)) foreign.push(candidate);
		}
		return foreign;
	}

	private maybePrune(): void {
		const now = Date.now();
		if (
			this.claimCount <= PRUNE_CLAIM_COUNT &&
			this.shellWindows.length <= PRUNE_CLAIM_COUNT &&
			now - this.lastPruneAt < PRUNE_INTERVAL_MS
		) {
			return;
		}
		this.prune(now);
	}

	/** Drop records older than the retention window. */
	prune(now = Date.now()): void {
		this.lastPruneAt = now;
		const floor = now - RETENTION_MS;
		let count = 0;
		for (const [key, list] of this.claims) {
			const kept = list.filter((claim) => claim.at >= floor);
			count += kept.length;
			if (kept.length === 0) this.claims.delete(key);
			else if (kept.length !== list.length) this.claims.set(key, kept);
		}
		this.claimCount = count;
		this.shellWindows = this.shellWindows.filter((window) => window.endedAt >= floor);
	}
}

export interface AttributableChange {
	path: string;
	status: string;
}

export interface ForeignChangeSelection {
	registry: ChangeClaimRegistry;
	/** Identity of the session whose run is being attributed. */
	sessionKey: string;
	/** Identity keys of the files this run changed itself (successful file tool operations). */
	ownPaths: ReadonlySet<string>;
	/** The run's window. */
	from: number;
	to: number;
	/** Directory the change paths are relative to. */
	baseDir: string;
	/** Last write time of a file on disk, undefined when it cannot be read. */
	modifiedAt: (absolutePath: string) => number | undefined;
}

/**
 * Which of a run's detected changes another session explains: a direct file
 * operation it recorded inside the run's window, or - for a change no session
 * recorded directly - a file whose last write falls inside another session's
 * shell window and outside every shell window of this session. Files this run
 * changed itself are never dropped, and a change with no explanation stays.
 */
export function selectForeignChanges(
	changes: readonly AttributableChange[],
	selection: ForeignChangeSelection,
): string[] {
	const dropped: string[] = [];
	for (const change of changes) {
		const absolute = resolve(selection.baseDir, change.path);
		if (selection.ownPaths.has(pathIdentityKey(absolute))) continue;
		if (selection.registry.foreignClaim(absolute, selection.sessionKey, selection.from, selection.to)) {
			dropped.push(change.path);
			continue;
		}
		if (change.status === "deleted") continue;
		const at = selection.modifiedAt(absolute);
		if (
			at !== undefined &&
			at >= selection.from &&
			at <= selection.to &&
			selection.registry.foreignShellCovers(at, selection.sessionKey) &&
			!selection.registry.ownShellCovers(selection.sessionKey, at)
		) {
			dropped.push(change.path);
		}
	}
	return dropped;
}
