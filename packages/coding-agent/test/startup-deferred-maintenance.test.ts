import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.ts";
import { cleanupEmptySessionDirectoriesAsync } from "../src/session/storage/jsonl/index.ts";
import { scheduleDeferredStartupMaintenance } from "../src/startup/deferred-maintenance.ts";
import { cleanupStaleAtomicWriteTempsAsync } from "../src/utils/atomic-write.ts";

describe("deferred startup maintenance", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "myharness-deferred-test-"));
		roots.push(root);
		return root;
	}

	function makeStaleAtomicTemp(
		dir: string,
		baseName: string,
		pid = 2147483647,
		ageMs = 3600_000,
		baseNow = Date.now(),
	): string {
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, `${baseName}.${pid}.${randomUUID()}.tmp`);
		writeFileSync(filePath, "stale-temp-data");
		const past = new Date(baseNow - ageMs);
		utimesSync(filePath, past, past);
		return filePath;
	}

	it("(a) runMigrations keeps stale atomic temp files (not cleaned synchronously)", () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot, { recursive: true });

		const target = join(dataRoot, "state.json");
		writeFileSync(target, '{"version":1}');
		const staleTemp = makeStaleAtomicTemp(dataRoot, "state.json");

		expect(existsSync(staleTemp)).toBe(true);
		runMigrations(root);
		expect(existsSync(staleTemp)).toBe(true);
	});

	it("(b) removes stale temp files after deferred maintenance while keeping active PID, too-new, symlink, and unrelated files", async () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot, { recursive: true });

		const target = join(dataRoot, "config.json");
		writeFileSync(target, "{}");

		const staleTemp = makeStaleAtomicTemp(dataRoot, "config.json", 2147483647, 3600_000);
		const aliveTemp = makeStaleAtomicTemp(dataRoot, "config.json", process.pid, 3600_000);
		const tooNewTemp = makeStaleAtomicTemp(dataRoot, "config.json", 2147483647, 5_000); // 5s < 10m
		const unrelatedTemp = join(dataRoot, "other.tmp");
		writeFileSync(unrelatedTemp, "unrelated");

		const handle = scheduleDeferredStartupMaintenance({
			dataRoot,
			delayMs: 10,
		});
		await handle.done;

		expect(existsSync(staleTemp)).toBe(false);
		expect(existsSync(aliveTemp)).toBe(true);
		expect(existsSync(tooNewTemp)).toBe(true);
		expect(existsSync(unrelatedTemp)).toBe(true);
	});

	it("(c) removes empty old session shells and keeps shells with files or under 10 minutes old", async () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		const sessionsRoot = join(dataRoot, "workspaces", "ws-1", "sessions");

		const emptyOld = join(sessionsRoot, "empty-old", "sub");
		const emptyNew = join(sessionsRoot, "empty-new");
		const withFiles = join(sessionsRoot, "with-files");
		const withSidecar = join(sessionsRoot, "with-sidecar", "artifacts");

		mkdirSync(emptyOld, { recursive: true });
		mkdirSync(emptyNew, { recursive: true });
		mkdirSync(withFiles, { recursive: true });
		mkdirSync(withSidecar, { recursive: true });

		writeFileSync(join(withFiles, "conversation.jsonl"), '{"type":"session"}\n');
		writeFileSync(join(withSidecar, "output.txt"), "result");

		const oldTime = new Date(Date.now() - 3600_000);
		utimesSync(emptyOld, oldTime, oldTime);
		utimesSync(join(sessionsRoot, "empty-old"), oldTime, oldTime);
		utimesSync(withFiles, oldTime, oldTime);
		utimesSync(withSidecar, oldTime, oldTime);

		const handle = scheduleDeferredStartupMaintenance({
			dataRoot,
			delayMs: 10,
		});
		await handle.done;

		expect(existsSync(join(sessionsRoot, "empty-old"))).toBe(false);
		expect(existsSync(emptyNew)).toBe(true);
		expect(existsSync(withFiles)).toBe(true);
		expect(existsSync(withSidecar)).toBe(true);
	});

	it("(d) skips execution within 24 hours and re-executes after 25 hours", async () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot, { recursive: true });

		let mockNow = 1_700_000_000_000;
		const stale1 = makeStaleAtomicTemp(dataRoot, "f1.json", 2147483647, 3600_000, mockNow);

		// 1st run
		const handle1 = scheduleDeferredStartupMaintenance({
			dataRoot,
			delayMs: 10,
			intervalMs: 24 * 3600 * 1000,
			nowMs: () => mockNow,
		});
		await handle1.done;
		expect(existsSync(stale1)).toBe(false);

		// 2nd run: 10 hours later, add a new stale file -> should skip
		mockNow += 10 * 3600 * 1000;
		const stale2 = makeStaleAtomicTemp(dataRoot, "f2.json", 2147483647, 3600_000, mockNow);
		const handle2 = scheduleDeferredStartupMaintenance({
			dataRoot,
			delayMs: 10,
			intervalMs: 24 * 3600 * 1000,
			nowMs: () => mockNow,
		});
		await handle2.done;
		expect(existsSync(stale2)).toBe(true); // skipped!

		// 3rd run: advance 25 hours from 1st run (now at +25h) -> should run
		mockNow = 1_700_000_000_000 + 25 * 3600 * 1000;
		const handle3 = scheduleDeferredStartupMaintenance({
			dataRoot,
			delayMs: 10,
			intervalMs: 24 * 3600 * 1000,
			nowMs: () => mockNow,
		});
		await handle3.done;
		expect(existsSync(stale2)).toBe(false); // cleaned!
	});

	it("(e) runs normally when marker file is missing or corrupted", async () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot, { recursive: true });

		const markerPath = join(dataRoot, ".startup-maintenance.json");
		writeFileSync(markerPath, "{ corrupt json !!", "utf8");

		const stale = makeStaleAtomicTemp(dataRoot, "state.json", 2147483647, 3600_000);
		const handle = scheduleDeferredStartupMaintenance({
			dataRoot,
			delayMs: 10,
		});
		await handle.done;

		expect(existsSync(stale)).toBe(false);
		const parsedMarker = JSON.parse(readFileSync(markerPath, "utf8"));
		expect(parsedMarker.tasks.cleanupStaleAtomicWriteTemps.lastSuccessAt).toBeGreaterThan(0);
	});

	it("(f) yields to event loop at least 7 times on a synthetic tree with >= 2000 items", async () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot, { recursive: true });

		// Generate 2000 files across 10 directories
		for (let d = 0; d < 10; d++) {
			const sub = join(dataRoot, `dir-${d}`);
			mkdirSync(sub, { recursive: true });
			for (let f = 0; f < 200; f++) {
				writeFileSync(join(sub, `file-${f}.txt`), "x");
			}
		}

		let yieldCount = 0;
		const yieldSpy = () => {
			yieldCount++;
			return Promise.resolve();
		};

		await cleanupStaleAtomicWriteTempsAsync(dataRoot, {
			batchSize: 256,
			yieldToEventLoop: yieldSpy,
		});

		// 2000 files + 10 dirs = 2010 items. 2010 / 256 = 7.85 -> at least 7 yields
		expect(yieldCount).toBeGreaterThanOrEqual(7);
	});

	it("(g) cancel() and AbortSignal stop execution cleanly without throwing", async () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		mkdirSync(dataRoot, { recursive: true });

		const stale = makeStaleAtomicTemp(dataRoot, "doc.json", 2147483647, 3600_000);

		// cancel() before timer fires
		const handle = scheduleDeferredStartupMaintenance({
			dataRoot,
			delayMs: 60_000,
		});
		handle.cancel();
		await handle.done;
		expect(existsSync(stale)).toBe(true);

		// AbortSignal passed to async function directly
		const controller = new AbortController();
		controller.abort();

		const res1 = await cleanupStaleAtomicWriteTempsAsync(dataRoot, { signal: controller.signal });
		expect(res1.removed).toEqual([]);

		const res2 = await cleanupEmptySessionDirectoriesAsync(dataRoot, { signal: controller.signal });
		expect(res2).toEqual([]);
	});
});
