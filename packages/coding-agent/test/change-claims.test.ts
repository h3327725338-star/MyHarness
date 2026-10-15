import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeClaimRegistry, selectForeignChanges } from "../src/modes/web/change-claims.ts";
import { ChangeTracker } from "../src/modes/web/changes.ts";
import { pathIdentityKey } from "../src/utils/paths.ts";

const temporaryDirectories: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temporaryDirectories.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("change claim registry", () => {
	it("matches only another session's claims inside the window", () => {
		const dir = createTempDir("myharness-claims-window-");
		const now = Date.now();
		const file = path.join(dir, "a.ts");
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: file, at: now, tool: "edit" });
		expect(registry.foreignClaim(file, "A", now - 1, now + 1)).toBe(true);
		expect(registry.foreignClaim(file, "A", now + 1, now + 1_000)).toBe(false);
		expect(registry.foreignClaim(file, "A", now - 1_000, now - 1)).toBe(false);
		// The session's own claim is not foreign, and an unknown path has no claim at all.
		expect(registry.foreignClaim(file, "B", now - 1_000, now + 1_000)).toBe(false);
		expect(registry.foreignClaim(path.join(dir, "other.ts"), "A", now - 1_000, now + 1_000)).toBe(false);
	});

	it("bounds shell coverage per session", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 100, endedAt: now + 100 });
		expect(registry.foreignShellCovers(now, "A")).toBe(true);
		expect(registry.foreignShellCovers(now - 200, "A")).toBe(false);
		expect(registry.foreignShellCovers(now + 200, "A")).toBe(false);
		expect(registry.ownShellCovers("B", now)).toBe(true);
		expect(registry.ownShellCovers("A", now)).toBe(false);
	});

	it("lists the candidates another session changed since a point in time", () => {
		const dir = createTempDir("myharness-claims-since-");
		const now = Date.now();
		const claimed = path.join(dir, "claimed.ts");
		const shelled = path.join(dir, "shelled.ts");
		const untouched = path.join(dir, "untouched.ts");
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: claimed, at: now, tool: "write" });
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 1_000, endedAt: now + 1_000 });
		const candidates = [
			{ path: claimed, modifiedAt: undefined },
			{ path: shelled, modifiedAt: now },
			// Written before the other session's shell window: nothing explains it.
			{ path: untouched, modifiedAt: now - 5_000 },
		];
		expect(registry.foreignChangedSince(candidates, "A", now - 5_000).map((candidate) => candidate.path)).toEqual([
			claimed,
			shelled,
		]);
		// Nothing of it happened after a later point in time, and own records never count.
		expect(registry.foreignChangedSince(candidates, "A", now + 5_000)).toEqual([]);
		expect(registry.foreignChangedSince(candidates, "B", now - 5_000)).toEqual([]);
	});

	it("drops records older than the retention window", () => {
		const dir = createTempDir("myharness-claims-prune-");
		const now = Date.now();
		const file = path.join(dir, "a.ts");
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: file, at: now, tool: "edit" });
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 100, endedAt: now });
		registry.prune(now + 31 * DAY_MS);
		expect(registry.foreignClaim(file, "A", 0, Number.POSITIVE_INFINITY)).toBe(false);
		expect(registry.foreignShellCovers(now - 50, "A")).toBe(false);
	});
});

describe("selectForeignChanges", () => {
	const baseDir = createTempDir("myharness-claims-select-");

	it("drops another session's claimed files and never this run's own files", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.record({ sessionKey: "B", runId: 1, path: path.join(baseDir, "other.ts"), at: now, tool: "edit" });
		registry.record({ sessionKey: "B", runId: 1, path: path.join(baseDir, "mine.ts"), at: now, tool: "edit" });
		const ownPaths = new Set([pathIdentityKey(path.join(baseDir, "mine.ts"))]);
		const dropped = selectForeignChanges(
			[
				{ path: "mine.ts", status: "modified" },
				{ path: "other.ts", status: "modified" },
			],
			{
				registry,
				sessionKey: "A",
				ownPaths,
				from: now - 1_000,
				to: now + 1_000,
				baseDir,
				modifiedAt: () => undefined,
			},
		);
		expect(dropped).toEqual(["other.ts"]);
	});

	it("keeps changes with no explanation and claims outside the run window", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.record({
			sessionKey: "B",
			runId: 1,
			path: path.join(baseDir, "before.ts"),
			at: now - 5_000,
			tool: "edit",
		});
		const dropped = selectForeignChanges(
			[
				{ path: "before.ts", status: "modified" },
				{ path: "unexplained.ts", status: "modified" },
			],
			{
				registry,
				sessionKey: "A",
				ownPaths: new Set(),
				from: now - 1_000,
				to: now + 1_000,
				baseDir,
				modifiedAt: () => now,
			},
		);
		expect(dropped).toEqual([]);
	});

	it("attributes an unrecorded file by another session's shell window", () => {
		const now = Date.now();
		const registry = new ChangeClaimRegistry();
		registry.recordShell({ sessionKey: "B", runId: 1, startedAt: now - 1_000, endedAt: now + 1_000 });
		const select = (modifiedAt: number | undefined, status = "modified", ownShell = false) => {
			const withOwn = new ChangeClaimRegistry();
			if (ownShell) {
				withOwn.recordShell({ sessionKey: "A", runId: 1, startedAt: now - 500, endedAt: now + 500 });
			}
			return selectForeignChanges([{ path: "file.ts", status }], {
				registry: ownShell ? withOwn : registry,
				sessionKey: "A",
				ownPaths: new Set(),
				from: now - 1_000,
				to: now + 1_000,
				baseDir,
				modifiedAt: () => modifiedAt,
			});
		};
		expect(select(now)).toEqual(["file.ts"]);
		// Before the foreign window, outside the run window, or covered by this session's own shell window: kept.
		expect(select(now - 2_000)).toEqual([]);
		expect(select(now - 10_000)).toEqual([]);
		expect(select(undefined)).toEqual([]);
		expect(select(now, "modified", true)).toEqual([]);
		// A deleted file has no write time to place: it stays unless someone claimed it directly.
		expect(select(now, "deleted")).toEqual([]);
	});
});

describe("run change cards keep only this session's files", () => {
	it("drops files another session changed through its own file tools", () => {
		const dir = createTempDir("myharness-claims-card-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		const b = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "B" });
		writeFileSync(path.join(dir, "other.ts"), "before\n");
		writeFileSync(path.join(dir, "mine.ts"), "before\n");
		a.beginRun(1);
		b.beginRun(1);
		writeFileSync(path.join(dir, "other.ts"), "after\n");
		b.captureBefore(1, "t1", "edit", { path: "other.ts" });
		b.recordToolOp(1, "t1", "edit", true);
		// The other session even touched this session's file: the run's own operation still wins.
		b.captureBefore(1, "t2", "edit", { path: "mine.ts" });
		b.recordToolOp(1, "t2", "edit", true);
		a.captureBefore(1, "ta", "edit", { path: "mine.ts" });
		a.recordToolOp(1, "ta", "edit", true);
		const record = a.finishRun(
			1,
			{
				status: "known",
				changes: [
					{ path: "other.ts", status: "modified" },
					{ path: "mine.ts", status: "modified" },
				],
			},
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["mine.ts"]);
	});

	it("does not treat a failed operation as a claim", () => {
		const dir = createTempDir("myharness-claims-failed-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		const b = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "B" });
		a.beginRun(1);
		b.beginRun(1);
		b.captureBefore(1, "t1", "edit", { path: "other.ts" });
		b.recordToolOp(1, "t1", "edit", false);
		const record = a.finishRun(
			1,
			{ status: "known", changes: [{ path: "other.ts", status: "modified" }] },
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["other.ts"]);
	});

	it("attributes unrecorded files by another session's shell window and keeps its own", async () => {
		const dir = createTempDir("myharness-claims-shell-");
		const registry = new ChangeClaimRegistry();
		const a = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "A" });
		const b = new ChangeTracker(dir, { changeClaims: registry, sessionKey: () => "B" });
		a.beginRun(1);
		b.beginRun(1);

		// The tracker publishes a real window for a shell call; it covers the moment between start and end.
		b.recordShellStart(1, "shell-1");
		const during = Date.now();
		b.recordShellEnd(1, "shell-1");
		expect(registry.foreignShellCovers(during, "A")).toBe(true);

		// A file written inside another session's shell window is its change, not this run's. A file whose last
		// write also falls inside this session's own shell window stays (both sessions worked at that moment).
		const base = Date.now() + 20;
		writeFileSync(path.join(dir, "generated.ts"), "x\n");
		utimesSync(path.join(dir, "generated.ts"), new Date(base), new Date(base));
		writeFileSync(path.join(dir, "built.ts"), "y\n");
		utimesSync(path.join(dir, "built.ts"), new Date(base + 30), new Date(base + 30));
		registry.recordShell({ sessionKey: "B", runId: 2, startedAt: base - 500, endedAt: base + 500 });
		registry.recordShell({ sessionKey: "A", runId: 1, startedAt: base + 10, endedAt: base + 60 });
		await new Promise((resolve) => setTimeout(resolve, 120));

		const record = a.finishRun(
			1,
			{
				status: "known",
				changes: [
					{ path: "generated.ts", status: "modified" },
					{ path: "built.ts", status: "modified" },
				],
			},
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["built.ts"]);
	});

	it("keeps the detected changes unchanged when no registry is wired", () => {
		const dir = createTempDir("myharness-claims-none-");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(1);
		const record = tracker.finishRun(
			1,
			{ status: "known", changes: [{ path: "a.ts", status: "modified" }] },
			undefined,
		);
		expect(record?.changes.map((change) => change.path)).toEqual(["a.ts"]);
	});
});
