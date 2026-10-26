// Derived Google Drive sync status: every number the page shows is computed once here, so the badge, the summary,
// the counters and the footer can never disagree. Pure data in, text out; no DOM and no page state.
import { t } from "./i18n.js";

/**
 * `decisions` needs the user to choose something (file conflicts, blocked folders, unbound folders); `unresolved`
 * adds the informational leftovers (copies kept for review, background issues).
 */
export function deriveSync(status) {
	const files = status?.files ?? null;
	const workspaces = files?.workspaces ?? [];
	const fileConflicts = files?.conflicts ?? [];
	const review = status?.conflicts ?? [];
	const issues = status?.issues ?? [];
	// A local workspace that already got its managed copy on this device needs no restore card.
	const managedIds = new Set(workspaces.filter((item) => item.managed).map((item) => item.workspaceId));
	const pendingBindings = (status?.pendingBindings ?? []).filter((item) => !managedIds.has(item.workspaceId));
	const blocked = workspaces.filter(
		(item) => item.state === "blocked" || item.state === "error" || item.incomplete === true,
	);
	const filePending = workspaces.reduce(
		(total, item) => total + (item.pendingUploads ?? 0) + (item.pendingDownloads ?? 0),
		0,
	);
	const up = Number(status?.pendingUploads) || 0;
	const down = Number(status?.pendingDownloads) || 0;
	const decisions = fileConflicts.length + blocked.length + pendingBindings.length;
	return {
		files,
		workspaces,
		fileConflicts,
		review,
		issues,
		pendingBindings,
		blocked,
		filePending,
		up,
		down,
		decisions,
		unresolved: decisions + review.length + issues.length,
	};
}

export function connectionBadge(status, sync) {
	if (!status.connected) return { cls: "", text: t("Not connected") };
	if (status.phase === "authorizing") return { cls: "warn", text: t("Waiting for Google") };
	if (status.phase === "error") return { cls: "danger", text: t("Needs attention") };
	if (status.phase === "locked") return { cls: "warn", text: t("Another process") };
	if (status.paused) return { cls: "warn", text: t("Paused") };
	if (!status.enabled) return { cls: "", text: t("Connected, sync off") };
	// A connection that works says nothing about the files: conflicts, blocked deletions or a failed pass must not be
	// covered by a green "Syncing" badge. Every warn/danger case here matches a non-zero count in the summary.
	if (status.lastError || sync.blocked.length > 0) return { cls: "danger", text: t("Needs attention") };
	if (sync.decisions > 0) return { cls: "warn", text: t("Needs your decision") };
	if (sync.unresolved > 0) return { cls: "warn", text: t("Review needed") };
	return { cls: "ok", text: t("Syncing") };
}

/** The one state line of the summary: connection first, then what needs the user, then what is moving. */
export function stateLine(status, sync) {
	if (!status.connected) return t("Not connected");
	if (status.phase === "authorizing") return t("Waiting for Google");
	if (status.phase === "error" || status.lastError) return t("Needs attention");
	if (status.phase === "locked") return t("Another process");
	if (status.paused) return t("Paused");
	if (!status.enabled) return t("Connected, sync off");
	if (sync.blocked.length > 0) return t("Needs attention");
	if (sync.decisions > 0) return t("Needs your decision");
	if (sync.unresolved > 0) return t("Finished, but open items: {count}.", { count: sync.unresolved });
	if (sync.up > 0 || sync.down > 0 || status.phase === "uploading" || status.phase === "downloading") {
		return t("Syncing");
	}
	return t("Up to date");
}

/** Where the footer "Review" button jumps: the first section that holds something to decide. */
export function reviewTarget(sync) {
	if (sync.fileConflicts.length > 0) return "sync-conflicts";
	if (sync.blocked.length > 0) return "sync-files";
	if (sync.pendingBindings.length > 0) return "sync-bindings";
	if (sync.review.length > 0) return "sync-review";
	// Background issues (a skipped pass, a stuck check) have no card of their own: their notice lives in the status
	// card, and pointing at a card that is not rendered would make the button look dead.
	if (sync.issues.length > 0) return "sync-issues";
	return "";
}

/**
 * The line under the action buttons: what the last manual run is doing, how far, or why it stopped — naming the real
 * breakdown instead of "the pass finished, N items are still waiting". A stale "finished" never hides open items.
 */
export function footLine(manual, status, sync) {
	const moving = status?.progress && status.progress.total > 0 ? status.progress : null;
	if (manual?.state === "running") {
		if (moving && (manual.stage === "waiting" || manual.stage === moving.stage)) {
			// The pass the run waits for (or the run itself) counts its own work, step by step: show that.
			return { text: `${movingText(moving)} ${progressText(status, moving.stage)}`, spinning: true };
		}
		if (manual.stage === "waiting") {
			const phase = status?.phase;
			if (phase === "downloading") {
				return {
					text: t("Waiting for the current sync pass to finish (downloading, {count} left).", {
						count: Number(status?.pendingDownloads) || 0,
					}),
				};
			}
			if (phase === "uploading") {
				return {
					text: t("Waiting for the current sync pass to finish (uploading, {count} changes left).", {
						count: Number(status?.pendingUploads) || 0,
					}),
				};
			}
			return { text: t("Waiting for the current sync pass to finish…") };
		}
		const progress = manual.total > 0 ? ` ${manual.done} / ${manual.total}` : "";
		return {
			text: manual.stage === "upload" ? `${t("Uploading…")}${progress}` : `${t("Downloading…")}${progress}`,
			spinning: true,
		};
	}
	if (manual?.state === "failed") {
		return { text: `${t("Failed")}: ${t(manual.error || "The operation failed.")}`, tone: "danger" };
	}
	if (sync.decisions > 0) {
		return {
			text: t("Waiting for your decision: {count}", { count: sync.decisions }),
			tone: "warn",
			review: true,
			reviewCount: sync.decisions,
			target: reviewTarget(sync),
		};
	}
	if (sync.unresolved > 0) {
		// Copies kept for review are not a transfer in progress and not a decision that blocks sync; say so instead of
		// finishing with a sentence that hides them.
		return {
			text: t("Kept for review: {count}", { count: sync.unresolved }),
			tone: "warn",
			review: true,
			reviewCount: sync.unresolved,
			target: reviewTarget(sync),
		};
	}
	if (moving) {
		// An automatic pass moving a backlog: the same live count a manual run shows.
		return { text: `${movingText(moving)} ${progressText(status, moving.stage)}`, spinning: true };
	}
	const waiting = sync.up + sync.down + sync.filePending + (manual?.remainingDownloads ?? 0);
	if (waiting > 0 || status?.phase === "uploading" || status?.phase === "downloading") {
		let text = t("Syncing: {up} waiting to upload, {down} waiting to download.", { up: sync.up, down: sync.down });
		if (sync.filePending > 0) text += ` ${t("{count} workspace files are still moving.", { count: sync.filePending })}`;
		return { text };
	}
	if (!manual) return null;
	return { text: manual.kind === "download" ? t("Download finished.") : t("Sync finished.") };
}

/**
 * What the pass in flight is doing. A download first reads the change lists of new batches, then fetches and writes
 * what they name; the two steps count different things, so each says which one it is.
 */
export function movingText(moving) {
	if (moving?.stage === "upload") return t("Uploading…");
	return moving?.step === "read" ? t("Reading changes from Drive…") : t("Downloading…");
}

/** "12 / 240" for the pass in flight in one stage, or "" when that stage is not moving. */
export function progressText(status, stage) {
	const progress = status?.progress;
	if (!progress || progress.stage !== stage || !(progress.total > 0)) return "";
	return `${Math.min(progress.done, progress.total)} / ${progress.total}`;
}

/** A kept-for-review entry is keyed `${kind}:${id}`: show what it is and why it was kept, not the bare key. */
export function reviewTitle(conflict) {
	const kind =
		{ memory: t("Memories"), session: t("Session"), file: t("Files"), workspace: t("Workspace") }[conflict.kind] ||
		conflict.kind;
	const reason =
		conflict.reason === "deleted-locally"
			? t("Deleted here, re-created elsewhere")
			: conflict.reason === "deleted-remotely"
				? t("Deleted elsewhere, changed here")
				: t("Changed on both computers");
	return `${kind} · ${reason}`;
}
