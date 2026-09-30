import { describe, expect, it } from "vitest";

// The Web UI is plain ES modules served as-is; its pure logic modules are testable directly.
// They are loaded through a computed URL because they are browser modules, not TypeScript.
const webDir = new URL("../web/js/", import.meta.url);
const { parsePatch } = await import(new URL("diff-parse.js", webDir).href);
const { buildTurns, describeAction, groupSteps, turnOutcome } = await import(new URL("turns.js", webDir).href);
const models = await import(new URL("provider-models.js", webDir).href);
const { ansiSegments, fmtDuration, relTime, shellOutcome, shortPath, stripAnsi } = await import(
	new URL("util.js", webDir).href
);

const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
	kind: "assistant",
	ts: 1,
	blocks,
	stopReason: "stop",
	provider: "p",
	model: "m",
	final: true,
	...extra,
});

describe("Web UI: action descriptions", () => {
	it("describes tool calls in plain language and keeps the raw facts", () => {
		const read = describeAction(
			{ id: "1", name: "read", args: { path: "C:\\proj\\src\\a.ts", offset: 5, limit: 10 } },
			{ isError: false },
			undefined,
			"C:\\proj",
		);
		expect(read).toMatchObject({ kind: "read", verb: "Read", target: "src/a.ts", status: "done" });
		const failing = describeAction(
			{ id: "2", name: "bash", args: { command: "npm test\nsecond" } },
			{ isError: true, details: { exitCode: 1 } },
			undefined,
			"C:\\proj",
		);
		expect(failing).toMatchObject({ kind: "run", verb: "Failed to run", target: "npm test", isError: true });
		const running = describeAction(
			{ id: "3", name: "grep", args: { pattern: "TODO", path: "src" } },
			undefined,
			{ status: "running" },
			"C:\\proj",
		);
		expect(running).toMatchObject({ kind: "search", verb: "Searching", status: "running" });
		const edit = describeAction(
			{ id: "4", name: "edit", args: { path: "a.ts" } },
			{ isError: false, details: { patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" } },
			undefined,
			"",
		);
		expect(edit.extra).toEqual({ additions: 2, deletions: 1 });
	});
});

describe("Web UI: turns", () => {
	it("folds intermediate steps and keeps only the final answer as reading text", () => {
		const items = [
			{ kind: "user", ts: 1, text: "fix it", images: [] },
			assistant(
				[
					{ type: "text", text: "Let me look." },
					{ type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
				],
				{ stopReason: "toolUse", ts: 2 },
			),
			{ kind: "toolResult", ts: 3, toolCallId: "c1", toolName: "read", text: "content", images: [], isError: false },
			assistant([{ type: "text", text: "Fixed." }], { ts: 4 }),
		];
		const [turn] = buildTurns(items, { cwd: "", toolRuns: {} });
		expect(turn.final.text).toBe("Fixed.");
		expect(turn.steps.map((s: any) => s.type)).toEqual(["note", "action"]);
		expect(turn.stats.actions).toBe(1);
		expect(turnOutcome(turn, { run: undefined, live: false, waiting: false })).toBe("completed");
	});

	it("never reports an aborted or failed turn as completed, and separates partial from failed", () => {
		const aborted = buildTurns(
			[{ kind: "user", ts: 1, text: "x", images: [] }, assistant([], { stopReason: "aborted", ts: 2 })],
			{ cwd: "", toolRuns: {} },
		)[0];
		expect(turnOutcome(aborted, { live: false, waiting: false })).toBe("cancelled");
		const failedNoEdits = buildTurns(
			[{ kind: "user", ts: 1, text: "x", images: [] }, assistant([], { stopReason: "error", error: "boom", ts: 2 })],
			{ cwd: "", toolRuns: {} },
		)[0];
		expect(turnOutcome(failedNoEdits, { live: false, waiting: false })).toBe("failed");
		expect(failedNoEdits.error.message).toBe("boom");
		const withEdit = buildTurns(
			[
				{ kind: "user", ts: 1, text: "x", images: [] },
				assistant([{ type: "toolCall", id: "w", name: "write", args: { path: "n.txt", content: "a" } }], {
					stopReason: "toolUse",
					ts: 2,
				}),
				{ kind: "toolResult", ts: 3, toolCallId: "w", toolName: "write", text: "ok", images: [], isError: false },
				assistant([], { stopReason: "error", error: "boom", ts: 4 }),
			],
			{ cwd: "", toolRuns: {} },
		)[0];
		expect(turnOutcome(withEdit, { live: false, waiting: false })).toBe("partial");
		expect(turnOutcome(failedNoEdits, { live: false, waiting: true })).toBe("waiting");
		expect(turnOutcome(failedNoEdits, { live: true, waiting: false })).toBe("running");
	});

	it("uses the authoritative run record when present and groups same-kind actions", () => {
		const turn = buildTurns(
			[
				{ kind: "user", ts: 1, text: "x", images: [] },
				assistant(
					[
						{ type: "toolCall", id: "a", name: "read", args: { path: "1.ts" } },
						{ type: "toolCall", id: "b", name: "read", args: { path: "2.ts" } },
						{ type: "toolCall", id: "c", name: "bash", args: { command: "ls" } },
					],
					{ stopReason: "toolUse", ts: 2 },
				),
			],
			{ cwd: "", toolRuns: { a: { status: "running" } } },
		)[0];
		const groups = groupSteps(turn.steps);
		expect(groups.map((g: any) => `${g.kind}:${g.actions.length}`)).toEqual(["read:2", "run:1"]);
		expect(turnOutcome(turn, { run: { outcome: "failed" }, live: false, waiting: false })).toBe("failed");
	});
});

describe("Web UI: reasoning steps", () => {
	it("skips empty reasoning, merges consecutive reasoning blocks and keeps real reasoning", () => {
		const items = [
			{ kind: "user", ts: 1, text: "x", images: [] },
			assistant(
				[
					{ type: "thinking", text: "" },
					{ type: "thinking", text: "First part." },
					{ type: "thinking", text: "Second part." },
					{ type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
				],
				{ stopReason: "toolUse", ts: 2 },
			),
			{ kind: "toolResult", ts: 3, toolCallId: "c1", toolName: "read", text: "content", images: [], isError: false },
			assistant(
				[
					{ type: "thinking", text: "After the tool." },
					{ type: "text", text: "Done." },
				],
				{ ts: 4 },
			),
		];
		const [turn] = buildTurns(items, { cwd: "", toolRuns: {} });
		const thinking = turn.steps.filter((s: any) => s.type === "thinking");
		expect(thinking).toHaveLength(2);
		expect(thinking[0].text).toContain("First part.");
		expect(thinking[0].text).toContain("Second part.");
		expect(thinking[1].text).toBe("After the tool.");
	});
});

describe("Web UI: diff parsing and utilities", () => {
	it("parses hunks with correct line numbers", () => {
		const hunks = parsePatch("--- a/x\n+++ b/x\n@@ -3,3 +3,3 @@ fn\n keep\n-old\n+new\n tail\n");
		expect(hunks).toHaveLength(1);
		expect(hunks[0].lines.map((l: any) => `${l.type}:${l.oldNo ?? "-"}:${l.newNo ?? "-"}`)).toEqual([
			"ctx:3:3",
			"del:4:-",
			"add:-:4",
			"ctx:5:5",
		]);
	});

	it("tells a user-stopped or timed-out shell command from an ordinary failure", () => {
		expect(shellOutcome({ text: "partial\nCommand aborted" })).toBe("cancelled");
		expect(shellOutcome({ text: "Command timed out after 90 seconds" })).toBe("timeout");
		expect(shellOutcome({ text: "npm ERR!", details: { exitCode: 1 } })).toBeNull();
		const stopped = describeAction(
			{ id: "1", name: "bash", args: { command: "sleep 40" } },
			{ isError: true, text: "Command aborted" },
			undefined,
			"",
		);
		expect(stopped).toMatchObject({ status: "cancelled", isError: false, verb: "Stopped" });
	});

	it("formats paths, durations, relative times and ANSI text", () => {
		expect(shortPath("C:\\Proj\\src\\a.ts", "c:/proj")).toBe("src/a.ts");
		expect(fmtDuration(32_000)).toBe("32s");
		expect(fmtDuration(125_000)).toBe("2m 5s");
		expect(relTime(Date.now() - 5 * 60_000)).toBe("5m");
		expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
		const segments = ansiSegments("a\u001b[1;31mb\u001b[0mc");
		expect(segments.map((s: any) => s.text)).toEqual(["a", "b", "c"]);
		expect(segments[1].style.color).toBeTruthy();
	});
});

describe("Web UI: provider model catalog", () => {
	const draft = (patch: Record<string, unknown> = {}) => ({
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		auth: "key",
		apiKey: "",
		...patch,
	});

	it("turns a catalog model into a form model with only the stated fields and its listed thinking levels", () => {
		const seeded = models.seedFromDetected({
			id: "reason-b",
			name: "Reason B",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
			thinkingLevelMap: { minimal: null, medium: null, xhigh: "xhigh" },
		});
		expect(seeded).toMatchObject({
			id: "reason-b",
			name: "Reason B",
			reasoning: true,
			image: true,
			contextWindow: "200000",
		});
		// Not stated by the catalog: keeps the usual default and is not marked as detected.
		expect(seeded.maxTokens).toBe(String(models.DEFAULT_MAX_TOKENS));
		expect(seeded.detected).toEqual({ reasoning: true, input: true, contextWindow: true, levels: true });
		expect(seeded.levels).toMatchObject({
			off: true,
			minimal: false,
			low: true,
			medium: false,
			high: true,
			xhigh: true,
			max: false,
		});
		expect(models.buildModel(seeded)).toMatchObject({
			id: "reason-b",
			reasoning: true,
			thinkingLevelMap: { minimal: null, medium: null, xhigh: "xhigh" },
		});
	});

	it("does not invent a level map for a model whose catalog lists none", () => {
		const built = models.buildModel(models.seedFromDetected({ id: "m", reasoning: true }));
		expect(built.reasoning).toBe(true);
		expect(built.thinkingLevelMap).toBeUndefined();
	});

	it("ticks and unticks catalog models without touching models the catalog does not list", () => {
		const own = models.modelDraft({ id: "own", contextWindow: 1000 });
		const found = { id: "a", name: "a" };
		const ticked = models.toggleCatalogModel([own], found, true);
		expect(ticked.map((m: any) => m.id)).toEqual(["own", "a"]);
		expect(models.toggleCatalogModel(ticked, found, true)).toBe(ticked);
		const unticked = models.toggleCatalogModel(ticked, found, false);
		expect(unticked.map((m: any) => m.id)).toEqual(["own"]);
		expect(unticked[0].contextWindow).toBe("1000");
		// A blank placeholder card is dropped when the first real model arrives.
		expect(models.toggleCatalogModel([models.modelDraft()], found, true).map((m: any) => m.id)).toEqual(["a"]);
	});

	it("proposes only what the catalog states and applies exactly that", () => {
		const current = models.modelDraft({
			id: "m",
			name: "Mine",
			contextWindow: 1000,
			maxTokens: 500,
			reasoning: true,
		});
		expect(models.detectedChanges(current, { id: "m", name: "m" })).toEqual([]);
		const found = { id: "m", name: "m", contextWindow: 2000, thinkingLevelMap: { low: null } };
		expect(models.detectedChanges(current, found).map((c: any) => c.field)).toEqual(["contextWindow", "levels"]);
		const next = models.applyDetected(current, found);
		expect(next).toMatchObject({ name: "Mine", contextWindow: "2000", maxTokens: "500", reasoning: true });
		expect(next.levels.low).toBe(false);
		expect(models.detectedChanges(next, found)).toEqual([]);
	});

	it("asks the endpoint on its own only when the connection is complete", () => {
		expect(models.connectionReady(draft(), { hasStoredKey: false })).toBe(false);
		expect(models.connectionReady(draft({ apiKey: "sk-x" }), { hasStoredKey: false })).toBe(true);
		expect(models.connectionReady(draft(), { hasStoredKey: true })).toBe(true);
		expect(models.connectionReady(draft({ auth: "none" }), { hasStoredKey: false })).toBe(true);
		expect(models.connectionReady(draft({ baseUrl: "api.example.com", auth: "none" }), { hasStoredKey: false })).toBe(
			false,
		);
		expect(models.connectionReady(draft({ baseUrl: "ftp://x", auth: "none" }), { hasStoredKey: false })).toBe(false);
		expect(models.connectionSignature(draft({ apiKey: "a" }))).not.toBe(
			models.connectionSignature(draft({ apiKey: "b" })),
		);
	});
});

describe("Web UI: shared slash-command registry", () => {
	it("gives every built-in command the registry offers to the Web a way to run, and nothing else", async () => {
		const { BUILTIN_COMMAND_KINDS } = await import(new URL("builtin-commands.js", webDir).href);
		const { builtinSlashCommandsFor, findBuiltinSlashCommand } = await import("../src/cli/slash-commands.ts");
		const web = builtinSlashCommandsFor("web").map((command) => command.name);
		expect([...web].sort()).toEqual(Object.keys(BUILTIN_COMMAND_KINDS).sort());
		expect(new Set(Object.values(BUILTIN_COMMAND_KINDS))).toEqual(new Set(["panel", "action", "prompt"]));
		// Everything the terminal UI offers is also there for the Web (the Web adds panels of its own on top).
		for (const command of builtinSlashCommandsFor("cli")) expect(web).toContain(command.name);
		// An alias resolves to its command.
		expect(findBuiltinSlashCommand("setting")?.name).toBe("settings");
	});

	it("starts a model without declared reasoning with no effort levels assumed, only off", () => {
		const unknown = models.modelDraft({ id: "new-model" });
		expect(
			Object.entries(unknown.levels)
				.filter(([, on]) => on)
				.map(([level]) => level),
		).toEqual(["off"]);
		const declared = models.modelDraft({ id: "m", reasoning: true, thinkingLevelMap: { minimal: null, low: null } });
		expect(declared.levels.minimal).toBe(false);
		expect(declared.levels.medium).toBe(true);
	});
});
