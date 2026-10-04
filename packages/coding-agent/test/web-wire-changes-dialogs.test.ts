import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeTracker, countPatchLines, makePatch } from "../src/modes/web/changes.ts";
import { WebDialogBridge } from "../src/modes/web/dialogs.ts";
import {
	editChangePreview,
	entriesToWire,
	messageToWire,
	sanitizeDetails,
	toWireModel,
} from "../src/modes/web/wire.ts";
import type { SessionEntry } from "../src/session/types.ts";

describe("web wire format", () => {
	it("projects previews only for live updates, even when the provider initializes stopReason to stop", () => {
		const message = {
			role: "assistant",
			timestamp: 1,
			stopReason: "stop",
			content: [
				{ type: "toolCall", id: "e", name: "edit", arguments: { edits: [{ oldText: "old", newText: "new" }] } },
			],
		} as never;
		expect(messageToWire(message, { streaming: true })).toMatchObject({
			blocks: [{ changePreview: { additions: 1, deletions: 1 } }],
		});
		const historical = messageToWire(message);
		if (historical?.kind !== "assistant") throw new Error("expected assistant");
		expect(historical.blocks[0]).not.toHaveProperty("changePreview");
	});
	it("counts received edit text only, retaining unchanged lines and bounding streamed work", () => {
		expect(editChangePreview("edit", { edits: [{ oldText: "same\nold\n", newText: "same\nnew\nmore\n" }] })).toEqual({
			additions: 2,
			deletions: 1,
		});
		expect(editChangePreview("edit", { edits: [{ oldText: "old", newText: "n" }] })).toEqual({
			additions: 1,
			deletions: 1,
		});
		expect(editChangePreview("edit", { edits: [{ oldText: "old" }] })).toBeUndefined();
		expect(editChangePreview("write", { content: "new" })).toBeUndefined();
		expect(editChangePreview("edit", { edits: [{ oldText: "a".repeat(65_000), newText: "b" }] })).toBeUndefined();
	});
	it("restores UI-only Git records from existing Session custom entries", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom",
				customType: "web-git-status",
				id: "git1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				data: { tone: "ok", title: "Commit succeeded", hash: "abc1234" },
			},
		];
		expect(entriesToWire(entries)).toMatchObject([{ kind: "gitStatus", id: "git1", result: { hash: "abc1234" } }]);
	});
	it("projects assistant messages with thinking, text and tool calls", () => {
		const item = messageToWire(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				],
				api: "openai-completions",
				provider: "p",
				model: "m",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
				},
				stopReason: "toolUse",
				timestamp: 10,
			} as never,
			{ id: "e1" },
		);
		expect(item).toMatchObject({ kind: "assistant", id: "e1", stopReason: "toolUse", model: "m" });
		if (item?.kind !== "assistant") throw new Error("expected assistant");
		expect(item.blocks.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(item.usage?.cost).toBe(0.5);
	});

	it("recovers built-in prompt commands and skill blocks for display", () => {
		const workflow = messageToWire({
			role: "user",
			content: [
				{
					type: "text",
					text: "The user explicitly selected **Workflow mode**.\n\n<user_task>\nfind bugs\n</user_task>\n\nMode requirements",
				},
			],
			timestamp: 1,
		} as never);
		expect(workflow).toMatchObject({ kind: "user", text: "find bugs", command: { name: "workflow" } });
		const skill = messageToWire({
			role: "user",
			content: [{ type: "text", text: '<skill name="x" location="/s/x.md">\nbody\n</skill>\n\ndo it' }],
			timestamp: 1,
		} as never);
		expect(skill).toMatchObject({ kind: "user", text: "do it", skill: { name: "x" } });
	});

	it("turns compaction entries into markers instead of replaying history and drops empty details", () => {
		const entries = [
			{
				type: "compaction",
				id: "c",
				parentId: null,
				timestamp: new Date(5).toISOString(),
				summary: "s",
				tokensBefore: 99,
			},
			{
				type: "message",
				id: "m",
				parentId: "c",
				timestamp: new Date(6).toISOString(),
				message: { role: "user", content: "yo", timestamp: 6 },
			},
		] as unknown as SessionEntry[];
		const items = entriesToWire(entries);
		expect(items.map((item) => item.kind)).toEqual(["compaction", "user"]);
		expect(sanitizeDetails(undefined)).toBeUndefined();
		expect(sanitizeDetails({ a: 1 })).toEqual({ a: 1 });
		expect(sanitizeDetails({ big: "x".repeat(500_000) })).toEqual({
			truncatedDetails: true,
			originalChars: expect.any(Number),
		});
	});
});

describe("web wire model", () => {
	const model = (reasoning: boolean, thinkingLevelMap?: Record<string, string | null>) =>
		({
			provider: "p",
			id: "m",
			name: "M",
			api: "openai-completions",
			baseUrl: "https://x.example/v1",
			reasoning,
			thinkingLevelMap,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		}) as never;

	it("sends each model's own thinking efforts, none for a model that does not reason", () => {
		expect(toWireModel(model(false)).thinkingLevels).toEqual(["off"]);
		const limited = toWireModel(model(true, { minimal: null, low: null, medium: null, high: "high", off: null }));
		expect(limited.thinkingLevels).toEqual(["high"]);
		// Reasoning without any named effort offers only "off", so the Composer has nothing to choose and hides the selector.
		expect(toWireModel(model(true, { minimal: null, low: null, medium: null, high: null })).thinkingLevels).toEqual([
			"off",
		]);
	});
});

describe("ChangeTracker", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("counts additions and deletions from a unified patch", () => {
		const patch = makePatch("a.txt", "one\ntwo\n", "one\nTWO\nthree\n");
		expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 1 });
		expect(patch.startsWith("--- a/a.txt")).toBe(true);
	});

	it("reports the net effect of edit/write tool calls without Git, using pre-task snapshots", () => {
		dir = mkdtempSync(join(tmpdir(), "myharness-web-changes-"));
		writeFileSync(join(dir, "old.txt"), "before\n");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(1);
		tracker.captureBefore(1, "t1", "edit", { path: "old.txt" });
		writeFileSync(join(dir, "old.txt"), "after\n");
		tracker.recordToolOp(1, "t1", "edit", true);
		tracker.captureBefore(1, "t2", "write", { path: "new.txt" });
		writeFileSync(join(dir, "new.txt"), "fresh\n");
		tracker.recordToolOp(1, "t2", "write", true);
		// A write that leaves content unchanged is not a change.
		writeFileSync(join(dir, "same.txt"), "same\n");
		tracker.captureBefore(1, "t3", "write", { path: "same.txt" });
		tracker.recordToolOp(1, "t3", "write", true);
		tracker.finishRun(1, { status: "known", changes: [] }, undefined);
		const record = tracker.getRun(1);
		expect(record?.changes.map((change) => `${change.path}:${change.status}`).sort()).toEqual([
			"new.txt:added",
			"old.txt:modified",
		]);
		const modified = tracker.diffForRunFile(1, "old.txt", undefined);
		expect(modified?.summary).toMatchObject({ additions: 1, deletions: 1 });
		expect(modified?.patch).toContain("-before");
		const added = tracker.diffForRunFile(1, "new.txt", undefined);
		expect(added?.summary).toMatchObject({ additions: 1, deletions: 0, status: "added" });
	});

	it("refuses to invent a diff when the pre-task content is unknown", () => {
		dir = mkdtempSync(join(tmpdir(), "myharness-web-changes-"));
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "shell.txt"), "made by a shell command\n");
		const tracker = new ChangeTracker(dir);
		tracker.beginRun(2);
		tracker.finishRun(2, { status: "known", changes: [{ path: "sub/shell.txt", status: "modified" }] }, undefined);
		const result = tracker.diffForRunFile(2, "sub/shell.txt", undefined);
		expect(result?.patch).toBeUndefined();
		expect(result?.summary.unavailable).toMatch(/not recorded|could not be read/);
	});
});

describe("WebDialogBridge", () => {
	it("keeps a dialog pending until it is answered", async () => {
		const bridge = new WebDialogBridge();
		let changes = 0;
		bridge.onDialogsChanged = () => {
			changes++;
		};
		const pending = bridge.ask("select", { title: "Pick", options: ["a", "b"] });
		expect(bridge.requests).toHaveLength(1);
		expect(bridge.respond(bridge.requests[0].id, "b")).toBe(true);
		await expect(pending).resolves.toBe("b");
		expect(bridge.requests).toHaveLength(0);
		expect(changes).toBe(2);
		expect(bridge.respond("gone", "x")).toBe(false);
	});

	it("resolves confirm dialogs to false when dismissed, timed out or aborted", async () => {
		const bridge = new WebDialogBridge();
		const timed = bridge.ask("confirm", { title: "t" }, { timeout: 20 });
		await expect(timed).resolves.toBe(false);
		const controller = new AbortController();
		const aborted = bridge.ask("confirm", { title: "t" }, { signal: controller.signal });
		controller.abort();
		await expect(aborted).resolves.toBe(false);
		const dismissed = bridge.ask("confirm", { title: "t" });
		bridge.dismissAll();
		await expect(dismissed).resolves.toBe(false);
		const input = bridge.ask("input", { title: "t" });
		bridge.dismissAll();
		await expect(input).resolves.toBeUndefined();
	});

	it("exposes a real ExtensionUIContext for dialogs and status", async () => {
		const bridge = new WebDialogBridge();
		const ui = bridge.createExtensionUiContext({ getAllThemes: () => [] });
		const answer = ui.confirm("Allow?", "rm -rf x");
		expect(bridge.requests[0]).toMatchObject({ kind: "confirm", title: "Allow?", message: "rm -rf x" });
		bridge.respond(bridge.requests[0].id, true);
		await expect(answer).resolves.toBe(true);
		ui.setStatus("k", "busy");
		expect(bridge.surfaceState.statuses).toEqual({ k: "busy" });
		ui.setStatus("k", undefined);
		expect(bridge.surfaceState.statuses).toEqual({});
	});
});
