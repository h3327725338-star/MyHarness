import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getSettingsFilePaths, getTrustStorePath } from "../src/config/paths/index.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/config/settings/index.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(relativePath: string): string {
	return readFileSync(join(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

describe("Phase 6 config boundaries", () => {
	it("separates settings coordination from storage, migration, trust, and paths", () => {
		const manager = readSource("packages/coding-agent/src/config/settings/manager.ts");
		const storage = readSource("packages/coding-agent/src/config/settings/storage.ts");
		const migrations = readSource("packages/coding-agent/src/config/settings/migrations.ts");
		const trust = readSource("packages/coding-agent/src/config/trust/index.ts");
		const paths = readSource("packages/coding-agent/src/config/paths/index.ts");

		expect(manager).toContain("./storage.ts");
		expect(manager).toContain("./migrations.ts");
		expect(manager).toContain("./defaults.ts");
		expect(manager).toContain("../trust/index.ts");
		expect(manager).not.toMatch(/from ["'](?:node:)?fs["']/);
		expect(manager).not.toContain("proper-lockfile");
		expect(manager).not.toContain("writeFileAtomicallySync");
		expect(manager).not.toMatch(/(?:frontend|modes\/interactive|myharness-tui)/);
		expect(storage).toContain("proper-lockfile");
		expect(storage).toContain("writeFileAtomicallySync");
		expect(migrations).toContain("queueMode");
		expect(trust).toContain("ProjectTrustStore");
		expect(paths).toContain("getSettingsFilePaths");
		expect(paths).toContain("getTrustStorePath");
	});

	it("preserves global/project precedence and the trust gate through the new modules", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ theme: "global", outputPad: 0 }));
		storage.withLock("project", () => JSON.stringify({ theme: "project" }));

		const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });
		expect(manager.getTheme()).toBe("project");
		expect(manager.getOutputPad()).toBe(0);

		manager.setProjectTrusted(false);
		expect(manager.getTheme()).toBe("global");
		expect(() => manager.setProjectTrusted(true)).not.toThrow();
	});

	it("keeps the established settings and trust file locations", () => {
		const paths = getSettingsFilePaths("C:/workspace", "C:/agent");
		expect(paths.global.replaceAll("\\", "/")).toBe("C:/agent/settings.json");
		expect(paths.project.replaceAll("\\", "/")).toBe("C:/workspace/.myharness/settings.json");
		expect(getTrustStorePath("C:/agent").replaceAll("\\", "/")).toBe("C:/agent/trust.json");
	});
});
