import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage, SettingsManager, type SettingsScope } from "../src/config/settings/index.ts";
import type { SettingsStorage } from "../src/config/settings/storage.ts";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project folder and an agent folder whose global settings.json holds `settings`. */
function settingsFolders(settings: object): { root: string; agent: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), "myharness-settings-lock-"));
	roots.push(root);
	const agent = join(root, "agent");
	mkdirSync(agent);
	const path = join(agent, "settings.json");
	writeFileSync(path, JSON.stringify(settings));
	return { root, agent, path };
}

/** Settings held in memory whose writes fail while `failing` returns true. */
function failingStorage(failing: () => boolean): { storage: SettingsStorage; files: Record<SettingsScope, string> } {
	const files: Record<SettingsScope, string> = { global: JSON.stringify({ theme: "dark" }), project: "{}" };
	const storage: SettingsStorage = {
		withLock(scope, fn) {
			const next = fn(files[scope]);
			if (next !== undefined) files[scope] = next;
		},
		async withLockAsync(scope, fn) {
			if (failing()) throw new Error("Lock file is already being held");
			const next = fn(files[scope]);
			if (next !== undefined) files[scope] = next;
		},
	};
	return { storage, files };
}

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

	it("lets the chats of one server take turns on the settings file instead of contending for its lock", async () => {
		const { root, agent, path } = settingsFolders({ theme: "dark" });
		// How many of this process's writes are trying for or holding the file's lock at the same moment. Contending
		// writes used to give up after 200 ms, so how many failed depended on how fast the disk was.
		let trying = 0;
		let mostAtOnce = 0;
		const lock = lockfile.lock;
		const spy = vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			mostAtOnce = Math.max(mostAtOnce, ++trying);
			try {
				const release = await lock(file, options);
				return async () => {
					await release();
					trying--;
				};
			} catch (error) {
				trying--;
				throw error;
			}
		});
		try {
			// One settings manager per chat, as in the Web UI server, all writing at the same moment.
			const managers = Array.from({ length: 8 }, () => SettingsManager.create(root, agent));
			for (const [index, manager] of managers.entries()) manager.setLastChangelogVersion(`1.0.${index}`);
			const unsaved = await Promise.all(managers.map((manager) => manager.flush()));
			expect(unsaved.flat()).toEqual([]);
			expect(managers.flatMap((manager) => manager.getErrors())).toEqual([]);
			expect(mostAtOnce).toBe(1);
			expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("dark");
		} finally {
			spy.mockRestore();
		}
	});

	it("reads the settings while another process holds the lock instead of starting without them", async () => {
		const { root, agent, path } = settingsFolders({ theme: "dark" });
		const release = await lockfile.lock(path, { realpath: false });
		let manager: SettingsManager;
		try {
			manager = SettingsManager.create(root, agent);
		} finally {
			await release();
		}
		expect(manager.getErrors()).toEqual([]);
		expect(manager.getTheme()).toBe("dark");
		// Its saves are not held back either.
		manager.setTheme("light");
		expect(await manager.flush()).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("light");
	});

	it("takes over a lock left behind by a process that died instead of failing the save", async () => {
		const { root, agent, path } = settingsFolders({ theme: "dark" });
		const manager = SettingsManager.create(root, agent);
		// Nobody refreshes this lock any more: it turns stale 10 seconds after its last refresh, about half a second from
		// now, which is longer than saves used to wait for the lock.
		mkdirSync(`${path}.lock`);
		const lastRefresh = new Date(Date.now() - 9_500);
		utimesSync(`${path}.lock`, lastRefresh, lastRefresh);
		manager.setTheme("light");
		expect(await manager.flush()).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("light");
	});

	it("keeps a change whose write failed, reports it from flush and writes it again on the next flush", async () => {
		let failures = 2;
		const { storage, files } = failingStorage(() => failures-- > 0);
		const manager = SettingsManager.fromStorage(storage);
		manager.setTheme("light");
		const unsaved = await manager.flush();
		expect(unsaved.map((entry) => [entry.scope, entry.error.message])).toEqual([
			["global", "Lock file is already being held"],
		]);
		// In use here, but not in the file.
		expect(manager.getTheme()).toBe("light");
		expect(JSON.parse(files.global).theme).toBe("dark");
		// Every flush writes it again; the same failure is listed once.
		expect(await manager.flush()).toHaveLength(1);
		expect(manager.getErrors()).toHaveLength(1);
		expect(await manager.flush()).toEqual([]);
		expect(JSON.parse(files.global).theme).toBe("light");
	});

	it("keeps a change whose write failed through a reload, on top of what another chat saved", async () => {
		let failing = true;
		const { storage, files } = failingStorage(() => failing);
		const manager = SettingsManager.fromStorage(storage);
		manager.setTheme("light");
		expect(await manager.flush()).toHaveLength(1);
		// Another chat saves a setting of its own, and this one reads the file again.
		files.global = JSON.stringify({ theme: "dark", lastChangelogVersion: "2.0.0" });
		await manager.reload();
		expect(manager.getTheme()).toBe("light");
		expect(manager.getLastChangelogVersion()).toBe("2.0.0");
		failing = false;
		expect(await manager.flush()).toEqual([]);
		expect(JSON.parse(files.global)).toEqual({ theme: "light", lastChangelogVersion: "2.0.0" });
	});

	it("reports a change held back because the settings file could not be read", async () => {
		const { root, agent, path } = settingsFolders({});
		writeFileSync(path, "{ not json");
		const manager = SettingsManager.create(root, agent);
		manager.setTheme("light");
		expect((await manager.flush()).map((entry) => entry.scope)).toEqual(["global"]);
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});
});
