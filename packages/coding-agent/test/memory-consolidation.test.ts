import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AutoMemoryManager } from "../src/agent/runtime/auto-memory.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { SessionEntry } from "../src/session/types.ts";

const roots: string[] = [];
const managers: AutoMemoryManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "consolidation-"));
	roots.push(root);
	let operations: unknown[] = [];
	let fail = false;
	const runner = vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
		if (systemPrompt.includes("merge duplicates")) return fail ? "invalid" : '{"operations":[]}';
		return JSON.stringify({ operations });
	});
	const options = {
		cwd: root,
		dataRoot: join(root, "data"),
		agentDir: join(root, "agent"),
		workspaceId: "workspace",
		sessionId: "one",
		persisted: true,
		settingsManager: SettingsManager.inMemory({ autoMemory: { enabled: true, provider: "test", model: "test" } }),
		modelRunner: runner,
	};
	const create = () => {
		const manager = new AutoMemoryManager(options);
		managers.push(manager);
		return manager;
	};
	const state = () =>
		JSON.parse(readFileSync(join(options.dataRoot, "memory/state.json"), "utf8")).consolidation.workspace;
	const change = (count: number) => {
		operations = Array.from({ length: count }, (_, i) => ({
			action: "upsert",
			scope: "workspace",
			type: "project",
			name: `item-${i}`,
			description: "test",
			content: `body-${i}`,
		}));
	};
	const entry = (id: string) =>
		[
			{ type: "message", id, message: { role: "user", content: "remember", timestamp: Date.now() } },
		] as unknown as SessionEntry[];
	return {
		create,
		state,
		change,
		entry,
		runner,
		fail: () => {
			fail = true;
		},
	};
}
it("consolidates immediately after five real changes in one conversation", async () => {
	const f = fixture();
	const m = f.create();
	f.change(5);
	expect(await m.runExtraction(f.entry("a"))).toBe(true);
	expect(f.runner).toHaveBeenCalledTimes(2);
	expect(f.state().pendingChanges).toBe(0);
});
it("does not count unchanged writes or reset the first-change time, and resumes after restart", async () => {
	vi.useFakeTimers();
	const f = fixture();
	let m = f.create();
	f.change(1);
	await m.runExtraction(f.entry("a"));
	const since = f.state().pendingSince;
	vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
	await m.runExtraction(f.entry("b"));
	expect(f.state().pendingChanges).toBe(1);
	expect(f.state().pendingSince).toBe(since);
	m.dispose();
	vi.setSystemTime(Date.now() + 60 * 60 * 1000);
	m = f.create();
	await vi.advanceTimersByTimeAsync(1500);
	await vi.waitFor(() => expect(f.state().pendingChanges).toBe(0));
	expect(f.runner).toHaveBeenCalledTimes(3);
});
it("runs at three hours without another message and counts real updates", async () => {
	vi.useFakeTimers();
	const f = fixture();
	const m = f.create();
	f.change(1);
	await m.runExtraction(f.entry("a"));
	await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000 - 30_000);
	expect(f.runner).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(30_000);
	await vi.waitFor(() => expect(f.state().pendingChanges).toBe(0));
	expect(f.runner).toHaveBeenCalledTimes(2);
	f.change(2);
	await m.runExtraction(f.entry("b"));
	expect(f.state().pendingChanges).toBe(1);
});

it("retains due work after failure and skips consolidation when there are no changes", async () => {
	const f = fixture();
	const m = f.create();
	await m.runConsolidation();
	expect(f.runner).not.toHaveBeenCalled();
	f.change(1);
	await m.runExtraction(f.entry("a"));
	f.fail();
	expect(await m.runConsolidation(true)).toBe(false);
	expect(f.state().pendingChanges).toBe(1);
	expect(m.getMaintenanceStatus().phase).toBe("warning");
});
