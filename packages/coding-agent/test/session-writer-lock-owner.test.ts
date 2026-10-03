import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSessionBridgeDescriptor } from "../src/session/bridge/descriptor.ts";
import { SessionManager, setMirrorSessionsAllowed } from "../src/session/manager/index.ts";

const roots: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	setMirrorSessionsAllowed(false);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Lets the lock heartbeat's file system calls finish; only the timers are faked. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("Session writer lock owner marker", () => {
	it("shares a lease through a directory alias in the same process, including an unflushed chat", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-writer-alias-"));
		roots.push(root);
		vi.useFakeTimers({ toFake: ["Date"] });
		const sessions = join(root, "sessions");
		const alias = join(root, "alias");
		const first = SessionManager.create(root, sessions, { id: "alias" });
		symlinkSync(sessions, alias, process.platform === "win32" ? "junction" : "dir");
		const second = SessionManager.create(root, alias, { id: "alias" });
		try {
			expect(first.acquireWriterLock()).toBe("owner");
			expect(second.acquireWriterLock()).toBe("owner");
			first.releaseWriterLock();
			expect(existsSync(`${second.getSessionFile()}.lock`)).toBe(true);
		} finally {
			first.releaseWriterLock();
			second.releaseWriterLock();
		}
		expect(existsSync(`${first.getSessionFile()}.lock`)).toBe(false);
	});

	it("does not follow a leftover bridge belonging to a different lock owner", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-writer-bridge-"));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, "sessions"), { id: "bridge" });
		const file = manager.getSessionFile()!;
		mkdirSync(`${file}.lock`);
		writeFileSync(
			`${file}.lock.owner`,
			JSON.stringify({ pid: process.pid, token: "held", lockMtimeMs: statSync(`${file}.lock`).mtimeMs }),
		);
		writeSessionBridgeDescriptor(file, { pid: process.pid + 1, port: 12345, token: "old", startedAt: 0 });
		vi.spyOn(process, "kill").mockReturnValue(true);
		setMirrorSessionsAllowed(true);
		expect(() => manager.acquireWriterLock()).toThrow("already active");
		expect(manager.isMirror()).toBe(false);
		expect(existsSync(`${file}.lock`)).toBe(true);
	});

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
