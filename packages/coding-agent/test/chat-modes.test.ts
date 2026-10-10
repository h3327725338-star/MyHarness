import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { ModeStateStore } from "../src/session/mode-state.ts";
import { buildSystemPrompt } from "../src/system-prompts/composer/index.ts";

// The fixtures below need a writable artifacts root. This file owns its own
// temporary root so it passes under a plain `npm test`, and restores whatever
// values the environment had before.
const originalEnv = {
	MYHARNESS_ARTIFACTS_DIR: process.env.MYHARNESS_ARTIFACTS_DIR,
	MYHARNESS_TEMP_DIR: process.env.MYHARNESS_TEMP_DIR,
};
let fixtureRoot = "";

function fixture(name: string): string {
	const root = process.env.MYHARNESS_ARTIFACTS_DIR;
	if (!root) throw new Error("MYHARNESS_ARTIFACTS_DIR is required for isolated fixtures");
	const path = join(root, "tests", `chat-modes-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(path, { recursive: true });
	return path;
}

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "chat-modes-artifacts-"));
	mkdirSync(join(fixtureRoot, "temp"), { recursive: true });
	process.env.MYHARNESS_ARTIFACTS_DIR = fixtureRoot;
	process.env.MYHARNESS_TEMP_DIR = join(fixtureRoot, "temp");
});

afterAll(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("chat modes", () => {
	it("defaults old sessions to Coding and preserves General through new and fork", () => {
		const path = fixture("session");
		const legacy = join(path, "legacy.jsonl");
		writeFileSync(
			legacy,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: new Date().toISOString(), cwd: path })}\n`,
		);
		expect(SessionManager.open(legacy).getMode()).toBe("coding");
		const general = SessionManager.create(path, path, { mode: "general" });
		general.ensureSaved();
		expect(SessionManager.open(general.getSessionFile()!).getMode()).toBe("general");
		expect(SessionManager.createLike(general, path).getMode()).toBe("general");
		general.newSession();
		expect(general.getMode()).toBe("general");
		const user = general.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		general.createBranchedSession(user);
		expect(general.getMode()).toBe("general");
	});
	it("keeps Workspace registrations independent while sharing identity", () => {
		const path = fixture("workspace");
		const store = WorkspaceStore.create(path, join(path, "data"));
		const coding = store.add(path).workspace!;
		expect(store.list("general")).toEqual([]);
		const general = store.add(path, path, true, "general").workspace!;
		expect(general.workspaceId).toBe(coding.workspaceId);
		expect(store.remove(coding.workspaceId, "coding")).toBe(true);
		expect(store.list("coding")).toEqual([]);
		expect(store.list("general")).toHaveLength(1);
		const reopened = WorkspaceStore.create(path, join(path, "data"));
		expect(reopened.list("coding")).toEqual([]);
		expect(reopened.list("general")[0].workspaceId).toBe(coding.workspaceId);
	});
	it("restores both modes and attachments across new store instances", () => {
		const path = fixture("state");
		const store = new ModeStateStore(path);
		store.update("coding", { lastSessionFile: "coding.jsonl", model: { provider: "p", id: "coding" } });
		store.update("general", { lastSessionFile: "general.jsonl", model: { provider: "p", id: "general" } });
		store.setDraft("general", "chat", { text: "unfinished", attachments: [{ path: "attachment.txt" }] });
		store.setPersonalPrompt("general", "my preference");
		store.setPersonalPrompt("coding", "coding preference");
		const reopened = new ModeStateStore(path);
		expect(reopened.get("coding").model?.id).toBe("coding");
		expect(reopened.get("general").drafts.chat.attachments).toEqual([{ path: "attachment.txt" }]);
		expect(reopened.getPersonalPrompt("general")).toBe("my preference");
		expect(reopened.getPersonalPrompt("coding")).toBe("coding preference");
		store.setPersonalPrompt("coding", "");
		expect(reopened.getPersonalPrompt("general")).toBe("my preference");
		expect(reopened.getPersonalPrompt("coding")).toBe("");
		store.setDraft("general", "chat", null);
		expect(reopened.get("general").drafts.chat).toBeUndefined();
	});
	it("defaults the Coding personal prompt to empty for older state files", () => {
		const path = fixture("legacy-prompt");
		const emptyMode = { lastSessionFile: null, model: null, drafts: {} };
		writeFileSync(
			join(path, "chat-mode-state.json"),
			JSON.stringify({ version: 1, coding: emptyMode, general: emptyMode, generalPersonalPrompt: "legacy" }),
		);
		const store = new ModeStateStore(path);
		expect(store.getPersonalPrompts()).toEqual({ coding: "", general: "legacy" });
		store.setPersonalPrompt("coding", "added later");
		expect(new ModeStateStore(path).getPersonalPrompts()).toEqual({ coding: "added later", general: "legacy" });
	});
	it("does not overwrite damaged persisted state", () => {
		const path = fixture("damaged");
		const file = join(path, "chat-mode-state.json");
		writeFileSync(file, "invalid json");
		expect(() => new ModeStateStore(path).setPersonalPrompt("general", "replace")).toThrow();
		expect(readFileSync(file, "utf8")).toBe("invalid json");
	});
	it("shares tools and project rules while each mode gets only its own personal prompt first", () => {
		const base = {
			cwd: "/project",
			selectedTools: ["read", "write"],
			contextFiles: [{ path: "/project/AGENTS.md", content: "PROJECT_RULE" }],
			personalPrompts: { coding: "PERSONAL_CODING", general: "PERSONAL_GENERAL" },
		};
		const coding = buildSystemPrompt({ ...base, mode: "coding" });
		const general = buildSystemPrompt({ ...base, mode: "general" });
		expect(coding).toContain("software engineering assistant");
		expect(coding).toContain("PERSONAL_CODING");
		expect(coding).not.toContain("PERSONAL_GENERAL");
		expect(general).not.toContain("software engineering assistant");
		expect(general).toContain("PERSONAL_GENERAL");
		expect(general).not.toContain("PERSONAL_CODING");
		for (const prompt of [coding, general]) {
			expect(prompt).toContain("PROJECT_RULE");
			// Highest priority: the personal block precedes the built-in core policy and everything after it.
			expect(prompt.indexOf("<user_personalization")).toBeLessThan(prompt.indexOf("<global_core_policy>"));
		}
		const none = buildSystemPrompt({ ...base, personalPrompts: undefined, mode: "general" });
		expect(none).not.toContain("<user_personalization");
	});
});
