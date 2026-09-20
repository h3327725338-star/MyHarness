import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("SettingsManager project override APIs", () => {
	it("persists project code intelligence overrides through the project scope", async () => {
		const cwd = createTempDir("myharness-project-override-cwd-");
		const agentDir = createTempDir("myharness-project-override-agent-");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ codeIntelligence: { enabled: true } }));
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

		expect(settingsManager.getCodeIntelligenceSettings().enabled).toBe(true);
		settingsManager.setProjectCodeIntelligenceSettings({ enabled: false });
		await settingsManager.flush();

		const projectFile = JSON.parse(readFileSync(join(cwd, ".myharness", "settings.json"), "utf-8"));
		expect(projectFile).toEqual({ codeIntelligence: { enabled: false } });
		expect(settingsManager.getCodeIntelligenceSettings().enabled).toBe(false);
		// Global file is untouched.
		const globalFile = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(globalFile.codeIntelligence?.enabled).toBe(true);
	});

	it("resetProjectSettings removes the override and falls back to the global value", async () => {
		const cwd = createTempDir("myharness-project-override-cwd-");
		const agentDir = createTempDir("myharness-project-override-agent-");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ codeIntelligence: { enabled: true } }));
		mkdirSync(join(cwd, ".myharness"), { recursive: true });
		writeFileSync(join(cwd, ".myharness", "settings.json"), JSON.stringify({ codeIntelligence: { enabled: false } }));
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

		expect(settingsManager.getCodeIntelligenceSettings().enabled).toBe(false);
		settingsManager.resetProjectSettings(["codeIntelligence"]);
		await settingsManager.flush();

		const projectFile = JSON.parse(readFileSync(join(cwd, ".myharness", "settings.json"), "utf-8"));
		expect(projectFile.codeIntelligence).toBeUndefined();
		expect(settingsManager.getCodeIntelligenceSettings().enabled).toBe(true);
	});

	it("resetProjectSettings refuses to write when the project is untrusted", () => {
		const cwd = createTempDir("myharness-project-override-cwd-");
		const agentDir = createTempDir("myharness-project-override-agent-");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

		expect(() => settingsManager.resetProjectSettings(["codeIntelligence"])).toThrow("Project is not trusted");
	});

	it("resetProjectSettings with no fields is a no-op", () => {
		const cwd = createTempDir("myharness-project-override-cwd-");
		const agentDir = createTempDir("myharness-project-override-agent-");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

		expect(() => settingsManager.resetProjectSettings([])).not.toThrow();
		expect(settingsManager.getProjectSettings()).toEqual({});
	});

	it("getErrors is a non-destructive view of tracked errors", async () => {
		const cwd = createTempDir("myharness-project-override-cwd-");
		const agentDir = createTempDir("myharness-project-override-agent-");
		writeFileSync(join(agentDir, "settings.json"), "{ invalid json");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

		const first = settingsManager.getErrors();
		expect(first).toHaveLength(1);
		const second = settingsManager.getErrors();
		expect(second).toHaveLength(1);
		expect(second[0].scope).toBe("global");
		expect(second[0].error.message.length).toBeGreaterThan(0);
		// drainErrors still clears afterwards.
		expect(settingsManager.drainErrors()).toHaveLength(1);
		expect(settingsManager.getErrors()).toEqual([]);
	});
});
