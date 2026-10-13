import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage, SettingsManager } from "../src/config/settings/index.ts";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("settings write scheduling", () => {
	it("coalesces saves in a fixed 175ms window and flush bypasses it", async () => {
		vi.useFakeTimers();
		let current: string | undefined;
		let writes = 0;
		const storage = {
			withLock(_scope: unknown, fn: (value: string | undefined) => string | undefined) {
				const next = fn(current);
				if (next !== undefined) {
					current = next;
					writes++;
				}
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		manager.setTheme("dark");
		manager.setTheme("light");
		expect(writes).toBe(0);
		await vi.advanceTimersByTimeAsync(174);
		expect(writes).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(writes).toBe(1);
		expect(JSON.parse(current!).theme).toBe("light");
		manager.setTheme("dark");
		await manager.flush();
		expect(writes).toBe(2);
		expect(JSON.parse(current!).theme).toBe("dark");
	});

	it("retries a contended file lock without blocking timers, preserving concurrent content", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-settings-async-"));
		roots.push(root);
		const agent = join(root, "agent");
		mkdirSync(agent);
		const path = join(agent, "settings.json");
		writeFileSync(path, JSON.stringify({ external: true }));
		const release = await lockfile.lock(path, { realpath: false });
		let responsive = false;
		const unlock = setTimeout(() => {
			responsive = true;
			void release();
		}, 35);
		try {
			const storage = new FileSettingsStorage(root, agent);
			await storage.withLockAsync("global", (current) => JSON.stringify({ ...JSON.parse(current!), mine: true }));
			expect(responsive).toBe(true);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ external: true, mine: true });
		} finally {
			clearTimeout(unlock);
		}
	});
});
