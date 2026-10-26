import { describe, expect, it } from "vitest";

const { connectionBadge, deriveSync, footLine, progressText, reviewTarget, reviewTitle, stateLine } = await import(
	new URL("../web/js/sync-status.js", import.meta.url).href
);

function status(patch: Record<string, unknown> = {}) {
	return {
		connected: true,
		enabled: true,
		paused: false,
		phase: "idle",
		lastError: null,
		pendingUploads: 0,
		pendingDownloads: 0,
		conflicts: [],
		issues: [],
		pendingBindings: [],
		manual: null,
		files: { workspaces: [], conflicts: [], issues: [] },
		...patch,
	};
}

describe("Google Drive settings status", () => {
	it("stays green and says up to date when every count is zero", () => {
		const view = deriveSync(status());
		expect(view.decisions).toBe(0);
		expect(view.unresolved).toBe(0);
		expect(connectionBadge(status(), view)).toEqual({ cls: "ok", text: "Syncing" });
		expect(stateLine(status(), view)).toBe("Up to date");
		expect(footLine({ kind: "sync", state: "done", stage: "upload", done: 1, total: 1 }, status(), view)).toEqual({
			text: "Sync finished.",
		});
	});

	it("names a kept copy in the footer instead of claiming everything finished", () => {
		const withCopy = status({
			conflicts: [{ id: "c1", key: "memory:memory/profile.md", kind: "memory", reason: "both-modified" }],
		});
		const view = deriveSync(withCopy);
		expect(view.decisions).toBe(0);
		expect(connectionBadge(withCopy, view).text).toBe("Review needed");
		expect(stateLine(withCopy, view)).toBe("Finished, but open items: 1.");
		const foot = footLine({ kind: "sync", state: "done", stage: "upload", done: 1, total: 1 }, withCopy, view);
		expect(foot.text).toBe("Kept for review: 1");
		expect(foot.target).toBe("sync-review");
		expect(foot.review).toBe(true);
	});

	it("separates a decision from ordinary transfer counts", () => {
		const conflict = status({
			files: {
				workspaces: [],
				conflicts: [{ id: "f1", workspaceId: "ws1", path: "a.html" }],
				issues: [],
			},
		});
		const view = deriveSync(conflict);
		expect(view.decisions).toBe(1);
		expect(connectionBadge(conflict, view).text).toBe("Needs your decision");
		const foot = footLine({ kind: "sync", state: "done", stage: "upload", done: 0, total: 0 }, conflict, view);
		expect(foot.text).toBe("Waiting for your decision: 1");
		expect(foot.target).toBe("sync-conflicts");
	});

	it("shows a blocked folder as a problem even without a file conflict", () => {
		const blocked = status({
			files: {
				workspaces: [{ workspaceId: "ws1", state: "blocked", pendingUploads: 0, pendingDownloads: 0 }],
				conflicts: [],
				issues: [],
			},
		});
		const view = deriveSync(blocked);
		expect(view.blocked).toHaveLength(1);
		expect(connectionBadge(blocked, view).text).toBe("Needs attention");
		expect(stateLine(blocked, view)).toBe("Needs attention");
		expect(reviewTarget(view)).toBe("sync-files");
	});

	it("points the footer button at a section that exists", () => {
		const bindings = deriveSync(status({ pendingBindings: [{ workspaceId: "ws2", name: "OS", path: "C:/x" }] }));
		expect(reviewTarget(bindings)).toBe("sync-bindings");
		expect(footLine({ kind: "sync", state: "done" }, status(), bindings).target).toBe("sync-bindings");

		// Copies kept for review have their own card; background issues have a notice inside the status card, never a
		// card of their own, so the button must not point at one that is not rendered.
		const copies = deriveSync(status({ conflicts: [{ id: "c1", kind: "memory", reason: "both-modified" }] }));
		expect(reviewTarget(copies)).toBe("sync-review");
		const issueOnly = status({ issues: [{ key: "issue:1", reason: "stuck", detail: "skipped" }] });
		expect(reviewTarget(deriveSync(issueOnly))).toBe("sync-issues");
		expect(footLine({ kind: "sync", state: "done" }, issueOnly, deriveSync(issueOnly)).target).toBe("sync-issues");
	});

	it("never shows a warning badge for a pause or a plain transfer", () => {
		const transfer = status({ phase: "uploading", pendingUploads: 2, pendingDownloads: 1 });
		const view = deriveSync(transfer);
		expect(connectionBadge(transfer, view)).toEqual({ cls: "ok", text: "Syncing" });
		expect(stateLine(transfer, view)).toBe("Syncing");
		expect(footLine(null, transfer, view).text).toBe("Syncing: 2 waiting to upload, 1 waiting to download.");
		const paused = status({ paused: true });
		expect(connectionBadge(paused, deriveSync(paused)).text).toBe("Paused");
	});

	it("drops a binding the managed copy already covers", () => {
		const managed = status({
			pendingBindings: [{ workspaceId: "ws1", name: "OS", path: "C:/placeholder" }],
			files: {
				workspaces: [{ workspaceId: "ws1", managed: true, state: "waiting" }],
				conflicts: [],
				issues: [],
			},
		});
		expect(deriveSync(managed).pendingBindings).toHaveLength(0);
	});

	it("titles a review entry by kind and reason", () => {
		expect(reviewTitle({ kind: "memory", reason: "both-modified" })).toBe("Memories · Changed on both computers");
		expect(reviewTitle({ kind: "session", reason: "deleted-remotely" })).toBe(
			"Session · Deleted elsewhere, changed here",
		);
	});

	it("counts an automatic pass live, and a manual run waiting for it shows the same count", () => {
		const moving = status({
			phase: "downloading",
			pendingDownloads: 212,
			progress: { stage: "download", done: 37, total: 212 },
		});
		expect(progressText(moving, "download")).toBe("37 / 212");
		expect(progressText(moving, "upload")).toBe("");
		expect(footLine(null, moving, deriveSync(moving))).toEqual({ text: "Downloading… 37 / 212", spinning: true });
		const waiting = footLine(
			{ kind: "download", state: "running", stage: "waiting", done: 0, total: 0 },
			moving,
			deriveSync(moving),
		);
		expect(waiting).toEqual({ text: "Downloading… 37 / 212", spinning: true });
	});

	it("names the download step: reading the change lists first, then downloading what they name", () => {
		const reading = status({
			phase: "downloading",
			progress: { stage: "download", step: "read", done: 120, total: 5534 },
		});
		expect(footLine(null, reading, deriveSync(reading))).toEqual({
			text: "Reading changes from Drive… 120 / 5534",
			spinning: true,
		});
		const applying = status({
			phase: "downloading",
			progress: { stage: "download", step: "apply", done: 3, total: 900 },
		});
		const manual = { kind: "download", state: "running", stage: "download", done: 3, total: 900 };
		expect(footLine(manual, applying, deriveSync(applying))).toEqual({
			text: "Downloading… 3 / 900",
			spinning: true,
		});
	});
});
