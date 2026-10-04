import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import { WorktreeDisplayNames, worktreeId } from "../src/git/worktrees/display-name.ts";

describe("copy metadata", () => {
	it("persists display names without changing branch identity; supports detached copies and Unicode", () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "copy-name-"));
		const names = new WorktreeDisplayNames(root);
		const copy = { path: join(root, "detached-copy"), branch: undefined };
		expect(names.label(copy)).toBe("detached-copy");
		names.set(copy.path, "修复菜单 Menu fix");
		expect(new WorktreeDisplayNames(root).label(copy)).toBe("修复菜单 Menu fix");
		expect(copy.branch).toBeUndefined();
		expect(worktreeId(copy.path)).toBe(worktreeId(copy.path));
		expect(() => names.set(copy.path, " ")).toThrow();
		expect(() => names.set(copy.path, "a".repeat(81))).toThrow();
	});
	it("keeps copy and main exit delays independent and persists them", async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "copy-settings-"));
		const settings = SettingsManager.create(root, join(root, "agent"));
		expect(settings.getWorktreeShutdownGraceSeconds()).toBe(10);
		settings.setWebShutdownGraceSeconds(30);
		expect(settings.getWorktreeShutdownGraceSeconds()).toBe(10);
		settings.setWorktreeShutdownGraceSeconds(60);
		await settings.flush();
		const reloaded = SettingsManager.create(root, join(root, "agent"));
		expect(reloaded.getWebShutdownGraceSeconds()).toBe(30);
		expect(reloaded.getWorktreeShutdownGraceSeconds()).toBe(60);
		expect(() => reloaded.setWorktreeShutdownGraceSeconds(3601)).toThrow();
	});
});
