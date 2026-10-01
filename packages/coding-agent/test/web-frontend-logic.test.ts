import { describe, expect, it } from "vitest";

// The Web UI is plain ES modules served as-is; its pure logic modules are testable directly.
// They are loaded through a computed URL because they are browser modules, not TypeScript.
const webDir = new URL("../web/js/", import.meta.url);
const { parsePatch } = await import(new URL("diff-parse.js", webDir).href);
const { buildTurns, describeAction, groupSteps, turnOutcome } = await import(new URL("turns.js", webDir).href);
const models = await import(new URL("provider-models.js", webDir).href);
const { ansiSegments, fmtDuration, modelEfforts, relTime, searchModels, shellOutcome, shortPath, stripAnsi } =
	await import(new URL("util.js", webDir).href);
const { byUsage, rankSearch, searchTier } = await import(new URL("search.js", webDir).href);

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

describe("Web UI: model picker", () => {
	const providers = [
		{
			id: "openrouter",
			name: "OpenRouter",
			models: [
				{ id: "anthropic/claude-x", name: "Claude X" },
				{ id: "qwen/qwen3-coder", name: "Qwen3 Coder" },
			],
		},
		{ id: "local", name: "Local", models: [{ id: "llama-3.1-8b", name: "" }] },
	];
	const ids = (rows: any[]) => rows.map((row) => `${row.provider.id}/${row.model.id}`);

	it("lists every model in one flat list and matches any part of the provider ID or model ID", () => {
		expect(ids(searchModels(providers, "coder"))).toEqual(["openrouter/qwen/qwen3-coder"]);
		expect(ids(searchModels(providers, "3.1"))).toEqual(["local/llama-3.1-8b"]);
		expect(ids(searchModels(providers, "OPENROUTER"))).toHaveLength(2);
		expect(ids(searchModels(providers, "open claude"))).toEqual(["openrouter/anthropic/claude-x"]);
		expect(ids(searchModels(providers, "local/llama"))).toEqual(["local/llama-3.1-8b"]);
		expect(searchModels(providers, "nothing-like-this")).toEqual([]);
		// No provider groups: an empty search is every model, in the given order.
		expect(ids(searchModels(providers, "  "))).toEqual([
			"openrouter/anthropic/claude-x",
			"openrouter/qwen/qwen3-coder",
			"local/llama-3.1-8b",
		]);
	});

	it("ranks models by relevance: an exact name, then a prefix, then a part of the name", () => {
		const list = [
			{
				id: "p",
				name: "P",
				models: [{ id: "x-gpt-5-mini" }, { id: "gpt-5-mini" }, { id: "gpt-5" }, { id: "other" }],
			},
		];
		expect(ids(searchModels(list, "GPT-5"))).toEqual(["p/gpt-5", "p/gpt-5-mini", "p/x-gpt-5-mini"]);
	});

	it("offers an effort menu only for a model with efforts to choose between", () => {
		expect(modelEfforts({ reasoning: true, thinkingLevels: ["off", "low", "high"] })).toEqual(["off", "low", "high"]);
		expect(modelEfforts({ reasoning: true, thinkingLevels: ["off"] })).toEqual([]);
		expect(modelEfforts({ reasoning: false, thinkingLevels: ["off", "low"] })).toEqual([]);
		expect(modelEfforts(undefined)).toEqual([]);
	});
});

describe("Web UI: provider model catalog", () => {
	const draft = (patch: Record<string, unknown> = {}) => ({
		baseUrl: "https://relay.test/v1",
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
			thinkingSource: "catalog",
		});
		expect(seeded).toMatchObject({
			id: "reason-b",
			name: "Reason B",
			reasoning: true,
			image: true,
			contextWindow: "200",
		});
		// Not stated by the catalog: keeps the usual default and is not marked as detected.
		expect(seeded.maxTokens).toBe(models.toK(models.DEFAULT_MAX_TOKENS));
		expect(seeded.detected).toEqual({
			reasoning: true,
			input: true,
			contextWindow: true,
			levels: true,
			levelsSource: "catalog",
		});
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

	it("seeds a probed model with its confirmed levels and remembers the per-level statuses", () => {
		const seeded = models.seedFromDetected({
			id: "probed",
			reasoning: true,
			thinkingSource: "probe",
			thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
			thinkingLevelStatus: { minimal: "unsupported", low: "supported", high: "unverified", xhigh: "unknown" },
		});
		expect(seeded.detected).toMatchObject({ levels: true, levelsSource: "probe" });
		expect(models.levelStatus(seeded, "high")).toBe("unverified");
		expect(seeded.levels).toMatchObject({ minimal: false, low: true, high: true, xhigh: true });
		expect(models.buildModel(seeded).thinkingLevelStatus).toEqual({
			minimal: "unsupported",
			low: "supported",
			high: "unverified",
			xhigh: "unknown",
		});
	});

	it("does not invent a level map for a model whose catalog lists none", () => {
		const built = models.buildModel(models.seedFromDetected({ id: "m", reasoning: true }));
		expect(built.reasoning).toBe(true);
		expect(built.thinkingLevelMap).toBeUndefined();
	});

	it("reads the Model IDs to detect from free text", () => {
		expect(models.parseModelIds(" gpt-5, deepseek-chat\nqwen3 ，gpt-5;; ")).toEqual([
			"gpt-5",
			"deepseek-chat",
			"qwen3",
		]);
		expect(models.parseModelIds("   ")).toEqual([]);
	});

	it("adds a detected new ID and updates only what the detection settled, leaving other models alone", () => {
		const own = models.modelDraft({ id: "own", contextWindow: 1000 });
		const current = models.modelDraft({
			id: "m",
			name: "Mine",
			contextWindow: 1000,
			maxTokens: 500,
			reasoning: true,
			input: ["text"],
		});
		const result = models.applyDetection(
			[own, current],
			[
				{
					id: "m",
					name: "catalog name",
					contextWindow: 2000,
					thinkingLevelMap: { low: null },
					thinkingSource: "catalog",
				},
				{ id: "new", name: "new" },
			],
		);
		expect(result.models.map((m: any) => m.id)).toEqual(["own", "m", "new"]);
		expect(result.added.map((m: any) => m.id)).toEqual(["new"]);
		expect(result.updated).toEqual(["m"]);
		// Not specified: the very same object.
		expect(result.models[0]).toBe(own);
		const updated = result.models[1];
		// The display name is not a capability; max output and images were not stated, so they stay.
		expect(updated).toMatchObject({
			name: "Mine",
			contextWindow: "2",
			maxTokens: "0.5",
			image: false,
			reasoning: true,
		});
		expect(updated.levels.low).toBe(false);
		expect(updated.detected).toMatchObject({ contextWindow: true, levels: true });
		expect(updated.detected.maxTokens).toBeUndefined();
	});

	it("takes only confirmed probe levels and keeps the others as they were", () => {
		const current = models.modelDraft({ id: "m", reasoning: true, thinkingLevelMap: { minimal: null } });
		const next = models.updateFromDetection(current, {
			id: "m",
			reasoning: true,
			thinkingSource: "probe",
			thinkingLevelStatus: { minimal: "supported", low: "unsupported", high: "unverified", xhigh: "unknown" },
		});
		expect(next.levels).toMatchObject({ minimal: true, low: false, medium: true, high: true, xhigh: false });
		expect(models.buildModel(next).thinkingLevelStatus).toEqual({
			minimal: "supported",
			low: "unsupported",
			high: "unverified",
			xhigh: "unknown",
		});
		// A detection that settled nothing changes nothing.
		const plain = models.modelDraft({ id: "p", contextWindow: 4000 });
		const same = models.updateFromDetection(plain, { id: "p", name: "p" });
		expect(same).toMatchObject({ contextWindow: "4", reasoning: false, image: false, levels: plain.levels });
	});

	it("edits token counts in K (1K = 1000) and stores the exact token count", () => {
		expect(models.toK(128000)).toBe("128");
		expect(models.toK(131072)).toBe("131.072");
		expect(models.toK(1500)).toBe("1.5");
		expect(models.fmtK(128000)).toBe("128K");
		expect(models.fmtK(131072)).toBe("131.072K");
		expect(models.fromK("128")).toBe(128000);
		expect(models.fromK(" 131.072 ")).toBe(131072);
		expect(models.fromK("0.5")).toBe(500);
		for (const bad of ["", "0", "1.2345", "-1", "12K", "abc", "1e3"]) expect(models.fromK(bad)).toBeUndefined();
		const draft = models.modelDraft({ id: "m", contextWindow: 131072, maxTokens: 8192 });
		expect(draft).toMatchObject({ contextWindow: "131.072", maxTokens: "8.192" });
		expect(models.buildModel({ ...draft, contextWindow: "200" })).toMatchObject({
			contextWindow: 200000,
			maxTokens: 8192,
		});
	});

	it("detects only once the connection is complete", () => {
		expect(models.connectionReady(draft(), { hasStoredKey: false })).toBe(false);
		expect(models.connectionReady(draft({ apiKey: "sk-x" }), { hasStoredKey: false })).toBe(true);
		expect(models.connectionReady(draft(), { hasStoredKey: true })).toBe(true);
		expect(models.connectionReady(draft({ auth: "config" }), { hasStoredKey: false })).toBe(true);
		expect(
			models.connectionReady(draft({ baseUrl: "api.example.com", auth: "config" }), { hasStoredKey: false }),
		).toBe(false);
		expect(models.connectionReady(draft({ baseUrl: "ftp://x", auth: "config" }), { hasStoredKey: false })).toBe(
			false,
		);
		// Nothing typed, or the example address shown in the empty field: not a connection.
		expect(models.connectionReady(draft({ baseUrl: "", auth: "config" }), { hasStoredKey: true })).toBe(false);
		expect(
			models.connectionReady(draft({ baseUrl: models.BASE_URL_EXAMPLE, auth: "config" }), { hasStoredKey: true }),
		).toBe(false);
	});

	it("never takes the example Base URL for a real one", () => {
		expect(models.baseUrlProblem("")).toBe("missing");
		expect(models.baseUrlProblem("   ")).toBe("missing");
		expect(models.baseUrlProblem("https://api.example.com/v1")).toBe("example");
		expect(models.baseUrlProblem(" HTTPS://API.example.com/v1/ ")).toBe("example");
		expect(models.baseUrlProblem("api.myhost.com")).toBe("invalid");
		expect(models.baseUrlProblem("https://relay.myhost.com/v1")).toBe("");
		expect(models.baseUrlProblem("http://127.0.0.1:11434/v1")).toBe("");
	});

	it("restores the saved way to authenticate, and keeps models.json for entries from before it was saved", () => {
		expect(models.authModeOf({ authMode: "config", apiKey: "x" })).toBe("config");
		expect(models.authModeOf({ authMode: "config" })).toBe("config");
		expect(models.authModeOf({ authMode: "apiKey", apiKey: "test left in the file" })).toBe("key");
		expect(models.authModeOf({ apiKey: "MY_ENV_VAR" })).toBe("config");
		expect(models.authModeOf({ apiKey: "local" })).toBe("config");
		expect(models.authModeOf({})).toBe("key");
	});
});

describe("Web UI: search ranking", () => {
	const commands = [
		{ name: "GitHub Connect", description: "connect", uses: 9 },
		{ name: "Git", description: "local versions", uses: 0 },
		{ name: "Settings", description: "git and other options", uses: 50 },
		{ name: "Legit", description: "", uses: 99 },
	];
	const search = (query: string) =>
		rankSearch(commands, query, {
			names: (c: any) => c.name,
			keywords: (c: any) => c.description,
			usage: (c: any) => c.uses,
		}).map((c: any) => c.name);

	it("puts relevance before usage: exact name, name prefix, part of the name, then the description", () => {
		expect(search("git")).toEqual(["Git", "GitHub Connect", "Legit", "Settings"]);
		expect(search("GIT")).toEqual(search("git"));
		expect(search("nothing-like-this")).toEqual([]);
		expect(searchTier("git", "Git")).toBe(0);
		expect(searchTier("git", "GitHub Connect")).toBe(1);
		expect(searchTier("git", "Legit")).toBe(2);
		expect(searchTier("git", "Settings", "git and other options")).toBe(3);
	});

	it("uses the usage count only between equally relevant candidates, then keeps the given order", () => {
		const items = [
			{ name: "model-a", uses: 1 },
			{ name: "model-b", uses: 7 },
			{ name: "model-c", uses: 1 },
			{ name: "model", uses: 0 },
		];
		const names = (list: any[]) => list.map((item) => item.name);
		const options = { names: (item: any) => item.name, usage: (item: any) => item.uses };
		expect(names(rankSearch(items, "model", options))).toEqual(["model", "model-b", "model-a", "model-c"]);
		// An empty search keeps the list as given (it arrives ordered by usage).
		expect(names(rankSearch(items, "", options))).toEqual(["model-a", "model-b", "model-c", "model"]);
		expect(names(byUsage(items, (item: any) => item.uses))).toEqual(["model-b", "model-a", "model-c", "model"]);
	});
});

describe("Web UI: shared /settings menu", () => {
	it("can open every row the menu offers to the Web, and defines no row of its own", async () => {
		const { SETTINGS_MENU_PAGES } = await import(new URL("settings-menu.js", webDir).href);
		const { settingsMenuFor } = await import("../src/cli/settings-menu.ts");
		const { SETTINGS_MENU_SETTING } = await import("../src/modes/web/routes-settings.ts");
		const web = settingsMenuFor("web").map((item) => item.id);
		const openable = [...Object.keys(SETTINGS_MENU_SETTING), ...Object.keys(SETTINGS_MENU_PAGES)];
		expect(new Set(openable).size).toBe(openable.length);
		expect([...openable].sort()).toEqual([...web].sort());
		// Everything in the terminal's menu is in the Web's, except what only a terminal has.
		const terminalOnly = ["theme"];
		for (const item of settingsMenuFor("cli")) {
			if (!terminalOnly.includes(item.id)) expect(web).toContain(item.id);
		}
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

	it("keeps every standard effort level selectable for a model whose levels nobody confirmed", () => {
		const unknown = models.modelDraft({ id: "new-model" });
		// Only a level confirmed unsupported is hidden; xhigh / max are opt-in in the runtime and stay off until stated.
		expect(
			Object.entries(unknown.levels)
				.filter(([, on]) => on)
				.map(([level]) => level),
		).toEqual(["off", "minimal", "low", "medium", "high"]);
		const declared = models.modelDraft({ id: "m", reasoning: true, thinkingLevelMap: { minimal: null, low: null } });
		expect(declared.levels.minimal).toBe(false);
		expect(declared.levels.medium).toBe(true);
	});
});
