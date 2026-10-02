import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/session/manager/index.ts";

const roots: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Lets the lock heartbeat's file system calls finish; only the timers are faked. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("Session writer lock owner marker", () => {
	it("follows the lock heartbeat, so a session that was open for a long time is still recoverable after a hard kill", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-writer-lock-"));
		roots.push(root);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		const manager = SessionManager.create(root, join(root, "sessions", "long"), { id: "long" });
		manager.acquireWriterLock();
		const lockPath = `${manager.getSessionFile()}.lock`;
		const marker = () =>
			JSON.parse(readFileSync(`${lockPath}.owner`, "utf8")) as { lockMtimeMs: number; token: string };
		const first = marker();

		// 15 minutes: longer than the stale window after which a marker that never moved was no longer trusted.
		for (let i = 0; i < 30; i++) {
			await vi.advanceTimersByTimeAsync(30_000);
			await settle();
		}

		const lockMtimeMs = statSync(lockPath).mtimeMs;
		expect(lockMtimeMs - first.lockMtimeMs).toBeGreaterThan(10 * 60 * 1000);
		expect(marker().token).toBe(first.token);
		expect(Math.abs(lockMtimeMs - marker().lockMtimeMs)).toBeLessThan(60_000);

		manager.releaseWriterLock();
	});
});
