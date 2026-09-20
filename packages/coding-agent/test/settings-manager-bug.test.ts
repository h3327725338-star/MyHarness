import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSettingsStorage, SettingsManager } from "../src/config/settings/index.ts";

/**
 * Tests for the fix to a bug where external file changes to arrays were overwritten.
 *
 * The bug scenario was:
 * 1. MyHarness starts with settings.json containing packages: ["npm:some-pkg"]
 * 2. User externally edits file to packages: []
 * 3. User changes an unrelated setting (e.g., theme) via UI
 * 4. save() would overwrite packages back to ["npm:some-pkg"] from stale in-memory state
 *
 * The fix tracks which fields were explicitly modified during the session, and only
 * those fields override file values during save().
 */
describe("SettingsManager - External Edit Preservation", () => {
	const testDir = join(process.cwd(), "test-settings-bug-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".myharness"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should preserve file changes to packages array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		// Initial state: packages has one item
		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				packages: ["npm:myharness-mcp-adapter"],
			}),
		);

		// MyHarness starts up, loads settings into memory
		const manager = SettingsManager.create(projectDir, agentDir);

		// At this point, globalSettings.packages = ["npm:myharness-mcp-adapter"]
		expect(manager.getPackages()).toEqual(["npm:myharness-mcp-adapter"]);

		// User externally edits settings.json to remove the package
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.packages = []; // User wants to remove this!
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// Verify file was changed
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).packages).toEqual([]);

		// User changes an UNRELATED setting via UI (this triggers save)
		manager.setTheme("light");
		await manager.flush();

		// With the fix, packages should be preserved as [] (not reverted to startup value)
		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		expect(savedSettings.packages).toEqual([]);
		expect(savedSettings.theme).toBe("light");
	});

	it("should preserve file changes to extensions array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				extensions: ["/old/extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		// User externally updates extensions
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.extensions = ["/new/extension.ts"];
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// Change unrelated setting
		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		// With the fix, extensions should be preserved (not reverted to startup value)
		expect(savedSettings.extensions).toEqual(["/new/extension.ts"]);
	});

	it("should preserve external project settings changes when updating unrelated project field", async () => {
		const projectSettingsPath = join(projectDir, ".myharness", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./old-extension.ts"],
				prompts: ["./old-prompt.md"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.prompts = ["./new-prompt.md"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./updated-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.prompts).toEqual(["./new-prompt.md"]);
		expect(savedProjectSettings.extensions).toEqual(["./updated-extension.ts"]);
	});

	it("should let in-memory project changes override external changes for the same project field", async () => {
		const projectSettingsPath = join(projectDir, ".myharness", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./initial-extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.extensions = ["./external-extension.ts"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./in-memory-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.extensions).toEqual(["./in-memory-extension.ts"]);
	});
});

describe("FileSettingsStorage - write lock and atomics", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "myharness-settings-lock-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("re-runs the read-modify-write under the lock instead of clobbering a concurrent writer", () => {
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		const storage = new FileSettingsStorage(tempDir, agentDir);
		const observedInputs: Array<string | undefined> = [];

		storage.withLock("global", (current) => {
			observedInputs.push(current);
			if (observedInputs.length === 1) {
				// Simulate another process creating the file between the unlocked probe
				// and this writer acquiring the lock.
				mkdirSync(agentDir, { recursive: true });
				writeFileSync(settingsPath, JSON.stringify({ concurrent: true }));
				return JSON.stringify({ mine: true });
			}
			return JSON.stringify({ ...JSON.parse(current ?? "{}"), mine: true });
		});

		// Both writers survive: the second pass merged against the concurrent content.
		expect(observedInputs).toEqual([undefined, JSON.stringify({ concurrent: true })]);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ concurrent: true, mine: true });
	});

	it("does not create directories or locks for read-only access", () => {
		const agentDir = join(tempDir, "missing-agent");
		const storage = new FileSettingsStorage(tempDir, agentDir);

		storage.withLock("global", () => undefined);

		expect(existsSync(agentDir)).toBe(false);
	});

	it("invokes a read-only callback exactly once whether or not the file exists", () => {
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		const storage = new FileSettingsStorage(tempDir, agentDir);

		let absentCalls = 0;
		storage.withLock("global", () => {
			absentCalls += 1;
			return undefined;
		});
		expect(absentCalls).toBe(1);

		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

		const observed: Array<string | undefined> = [];
		storage.withLock("global", (current) => {
			observed.push(current);
			return undefined;
		});
		expect(observed).toEqual([JSON.stringify({ theme: "dark" })]);
	});

	it("invokes a write callback exactly once when the settings file already exists", () => {
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
		const storage = new FileSettingsStorage(tempDir, agentDir);

		let calls = 0;
		storage.withLock("global", (current) => {
			calls += 1;
			return JSON.stringify({ ...JSON.parse(current ?? "{}"), hideThinkingBlock: true });
		});

		expect(calls).toBe(1);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark", hideThinkingBlock: true });
	});

	it("writes settings atomically without leaving temporary files behind", () => {
		const agentDir = join(tempDir, "agent");
		const storage = new FileSettingsStorage(tempDir, agentDir);

		storage.withLock("global", () => JSON.stringify({ theme: "dark" }));

		expect(readdirSync(agentDir)).toEqual(["settings.json"]);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({ theme: "dark" });
	});
});
