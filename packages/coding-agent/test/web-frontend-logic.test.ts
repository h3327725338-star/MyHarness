import { describe, expect, it } from "vitest";

// The Web UI is plain ES modules served as-is; its pure logic modules are testable directly.
// They are loaded through a computed URL because they are browser modules, not TypeScript.
const webDir = new URL("../web/js/", import.meta.url);
const { parsePatch } = await import(new URL("diff-parse.js", webDir).href);
const { buildTurns, changeTotals, describeAction, groupLabel, groupSteps, turnOutcome, turnSegments, webStats } =
	await import(new URL("turns.js", webDir).href);
const models = await import(new URL("provider-models.js", webDir).href);
const {
	ansiSegments,
	fmtDuration,
	fmtCost,
	fmtTokens,
	looseStrong,
	modelEfforts,
	relTime,
	searchModels,
	shellOutcome,
	shortPath,
	stripAnsi,
	taskWorkLine,
	tokensToUnit,
	unitToTokens,
} = await import(new URL("util.js", webDir).href);
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

describe("Web UI: list presence ordering", () => {
	it("places new rows first immediately while retaining exiting neighbours", async () => {
		const { reconcileRows } = await import(new URL("list-presence.js", webDir).href);
		const old = [{ path: "old-draft" }, { path: "history" }, { path: "last" }];
		const current = [{ path: "new-draft" }, { path: "history", name: "updated" }];
		expect(reconcileRows(old, current)).toEqual([current[0], old[0], current[1], old[2]]);
		expect(reconcileRows(current, current)).toEqual(current);
		expect(reconcileRows(old, [])).toEqual(old);
	});
});

describe("Web UI: chat order in the sidebar", () => {
	it("keeps a new blank chat first, then pinned, running and most recently active chats", async () => {
		const { orderChats } = await import(new URL("chat-order.js", webDir).href);
		const list = [
			{ path: "old", modified: 100 },
			{ path: "pinned", modified: 50, pinned: true },
			{ path: "busy", modified: 10 },
			{ path: "touched", modified: 20 },
			{ path: "blank", modified: 0, empty: true },
		];
		const slots: Record<string, unknown> = { busy: { active: true }, touched: { lastActivityAt: 500 } };
		const ordered = orderChats(list, (info: any) => slots[info.path], { now: 1000 });
		expect(ordered.map((info: any) => info.path)).toEqual(["blank", "pinned", "busy", "touched", "old"]);
		// The time a row shows follows its last activity; untouched rows keep their object.
		expect(ordered.find((info: any) => info.path === "touched").modified).toBe(500);
		expect(ordered.find((info: any) => info.path === "old")).toBe(list[0]);
		// The archive never lifts pinned chats.
		expect(orderChats(list, () => undefined, { pins: false, now: 1000 }).map((info: any) => info.path)).toEqual([
			"blank",
			"old",
			"pinned",
			"touched",
			"busy",
		]);
	});
});

describe("Web UI: Commit repair containment", () => {
	const marker = { kind: "custom", id: "repair", ts: 2, customType: "git-commit-repair", display: false };
	const user = { kind: "user", ts: 1, text: "task", images: [] };
	const reply = assistant([{ type: "text", text: "task done" }]);
	const repair = assistant([{ type: "toolCall", id: "read-1", name: "read", args: { path: "a.ts" } }], { ts: 3 });
	const result = { kind: "toolResult", ts: 4, toolCallId: "read-1", toolName: "read", text: "source", isError: false };
	it("keeps live repair tools out of the original task turn", () => {
		const turns = buildTurns([user, reply, marker, repair, result], { toolRuns: {} });
		expect(turns).toHaveLength(2);
		expect(turns[0].final.text).toBe("task done");
		expect(turns[0].stats.actions).toBe(0);
		expect(turns[1].standalone.kind).toBe("gitRepair");
		expect(turns[1].standalone.turns[0].steps[0].result.text).toBe("source");
	});
	it.each(["ok", "error"])("updates the repair card in place on %s and survives replay", (tone) => {
		const live = buildTurns([user, reply, marker, repair, result], { toolRuns: {} });
		const turns = buildTurns(
			[
				user,
				reply,
				marker,
				repair,
				result,
				{ kind: "gitStatus", id: "git", ts: 5, result: { tone } },
				{ ...user, ts: 6, text: "next" },
			],
			{ toolRuns: {} },
			live,
		);
		expect(turns).toHaveLength(3);
		expect(turns[1].key).toBe(live[1].key);
		expect(turns[1].standalone.kind).toBe("gitStatus");
		expect(turns[1].standalone.result.tone).toBe(tone);
		expect(turns[1].standalone.repairTurns[0].stats.reads).toBe(1);
		expect(turns[2].user.text).toBe("next");
	});
	it("does not absorb a later user task when a repair has no recorded outcome", () => {
		const turns = buildTurns([marker, repair, result, { ...user, ts: 6 }], { toolRuns: {} });
		expect(turns).toHaveLength(2);
		expect(turns[0].standalone.turns[0].stats.actions).toBe(1);
		expect(turns[1].user).toEqual({ ...user, ts: 6 });
	});
});

describe("Web UI: permanent Git records and unknown pricing", () => {
	it("keeps consecutive Git outcomes as independent transcript entries", () => {
		const result = { tone: "ok", title: "Commit succeeded", hash: "abc1234" };
		const turns = buildTurns([
			{ kind: "user", ts: 1, text: "fix", images: [] },
			assistant([{ type: "text", text: "done" }]),
			{ kind: "gitStatus", id: "g1", ts: 2, result },
			{ kind: "gitStatus", id: "g2", ts: 3, result: { tone: "error", title: "Commit failed" } },
		]);
		expect(turns.slice(-2).map((turn: { standalone: { id: string } }) => turn.standalone.id)).toEqual(["g1", "g2"]);
	});
	it("does not present missing pricing as a zero-dollar charge", () => {
		for (const value of [undefined, null, 0, Number.NaN]) expect(fmtCost(value)).toBe("—");
		expect(fmtCost(0.5)).toBe("$0.500");
		expect(fmtCost(0.5, "CNY")).toBe("¥0.500");
	});
	it("writes token counts with K / M and exactly one decimal", () => {
		expect(fmtTokens(187_652)).toBe("187.7K");
		expect(fmtTokens(27_100)).toBe("27.1K");
		expect(fmtTokens(128_000)).toBe("128.0K");
		expect(fmtTokens(11_643_776)).toBe("11.6M");
		expect(fmtTokens(999_960)).toBe("1.0M");
		expect(fmtTokens(950)).toBe("950");
		expect(fmtTokens(undefined)).toBe("—");
		expect(fmtTokens(null)).toBe("—");
		expect(fmtTokens(Number.NaN)).toBe("—");
		expect(fmtTokens(Number.POSITIVE_INFINITY)).toBe("—");
		expect(fmtTokens(0)).toBe("0"); // An explicitly reported zero is not missing.
		expect(fmtTokens(179_968)).toBe("180.0K");
		expect(fmtTokens(304_325)).toBe("304.3K");
		expect(fmtTokens(13_284_352)).toBe("13.3M");
	});
	it("keeps the change card of a finished task inside its turn, one card per task", () => {
		const card = (id: string, path: string) => ({
			kind: "runChanges",
			id,
			ts: 5,
			runId: 1,
			files: [{ path, status: "modified", additions: 1, deletions: 0, binary: false }],
		});
		const turns = buildTurns([
			{ kind: "user", ts: 1, text: "first", images: [] },
			assistant([{ type: "text", text: "done" }]),
			card("c1", "a.ts"),
			{ kind: "user", ts: 10, text: "second", images: [] },
			assistant([{ type: "text", text: "done again" }]),
			card("c2", "b.ts"),
		]);
		expect(turns).toHaveLength(2);
		expect(
			turns.map((turn: { changes: { id: string; files: Array<{ path: string }> } }) => [
				turn.changes.id,
				turn.changes.files[0].path,
			]),
		).toEqual([
			["c1", "a.ts"],
			["c2", "b.ts"],
		]);
	});
});

describe("Web UI: action descriptions", () => {
	it("reads running file change details and drops previews on failure", () => {
		for (const name of ["edit", "write"]) {
			const call = { name, args: { path: "file.txt" } };
			const run = {
				status: "running",
				partialDetails: { patch: "@@ -1 +1 @@\n-old\n+new\n", additions: 1, deletions: 1 },
			};
			expect(describeAction(call, undefined, run, "")).toMatchObject({
				status: "running",
				extra: { additions: 1, deletions: 1 },
			});
			expect(describeAction(call, { isError: true }, run, "").extra).toBeUndefined();
		}
	});
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
		const call = { id: "4", name: "edit", args: { path: "a.ts" } };
		const diff = "@@ -1 +1,2 @@\n-a\n+b\n+c\n";
		expect(describeAction(call, { details: { diff } }, undefined, "").extra).toEqual(edit.extra);
		expect(describeAction(call, undefined, { status: "running", partialDetails: { diff } }, "").extra).toEqual(
			edit.extra,
		);
		expect(
			describeAction(
				{ ...call, name: "write" },
				undefined,
				{ status: "running", partialDetails: { additions: 3, deletions: 2 } },
				"",
			).extra,
		).toEqual({ additions: 3, deletions: 2 });
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

describe("Web UI: reasoning and answer segments", () => {
	it("opens a new process block after text the model wrote, and keeps the final answer last", () => {
		const items = [
			{ kind: "user", ts: 1, text: "go", images: [] },
			assistant(
				[
					{ type: "thinking", text: "Plan it." },
					{ type: "text", text: "First I list the folder." },
					{ type: "toolCall", id: "c1", name: "ls", args: { path: "." } },
				],
				{ stopReason: "toolUse", ts: 2 },
			),
			{ kind: "toolResult", ts: 3, toolCallId: "c1", toolName: "ls", text: "a", images: [], isError: false },
			assistant(
				[
					{ type: "text", text: "It is almost empty." },
					{ type: "thinking", text: "Look one level up." },
					{ type: "toolCall", id: "c2", name: "ls", args: { path: ".." } },
				],
				{ stopReason: "toolUse", ts: 4 },
			),
			{ kind: "toolResult", ts: 5, toolCallId: "c2", toolName: "ls", text: "b", images: [], isError: false },
			assistant([{ type: "text", text: "Done." }], { ts: 6 }),
		];
		const [turn] = buildTurns(items, { cwd: "", toolRuns: {} });
		const segments = turnSegments(turn);
		expect(
			segments.map((s: any) =>
				s.type === "text" ? `text:${s.step.text}` : `process:${s.steps.map((x: any) => x.type).join("+")}`,
			),
		).toEqual([
			"process:thinking",
			"text:First I list the folder.",
			"process:action",
			"text:It is almost empty.",
			"process:thinking+action",
		]);
		expect(segments.filter((s: any) => s.type === "process").map((s: any) => s.stats.actions)).toEqual([0, 1, 1]);
		// The whole turn is still one piece: every step is counted and the answer follows the last block.
		expect(turn.stats.actions).toBe(2);
		expect(turn.final.text).toBe("Done.");
		// Block keys follow their first step, so a block keeps its open or folded state while later output arrives.
		const [again] = buildTurns(items.slice(0, 4), { cwd: "", toolRuns: {} });
		expect(turnSegments(again)[2].key).toBe(segments[2].key);
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

	it("takes ** next to punctuation as bold where the standard Markdown rules leave it as text", () => {
		// Each: the text from the opening **, the character before it, and the bold content expected (null = standard rules).
		const cases: Array<[string, string, string | null]> = [
			["**\u201c\u91cd\u70b9\u201d**\u5185\u5bb9", "\u662f", "\u201c\u91cd\u70b9\u201d"],
			["**\u6807\u9898\uff1a**\u540e\u9762", "", "\u6807\u9898\uff1a"],
			["**\uff08\u91cd\u8981\uff09**\u5982\u4e0b", "\u8bba", "\uff08\u91cd\u8981\uff09"],
			['**"quoted"**text', "a", '"quoted"'],
			["**`code`**after", "a", "`code`"],
			["**a *b* c:**d", "", "a *b* c:"],
			["**first:**x **second**", "", "first:"],
			["**plain** text", "", null],
			["** spaced **", "", null],
			["**unclosed: text", "", null],
			["**x:**", "*", null],
			["***both:***", "", null],
			["*one:*", "", null],
		];
		for (const [src, before, expected] of cases) {
			expect(looseStrong(src, before)?.text ?? null, src).toBe(expected);
		}
		expect(looseStrong("**\u6807\u9898\uff1a**\u540e\u9762", "")?.raw).toBe("**\u6807\u9898\uff1a**");
	});

	it("writes what a finished task did for its notification", () => {
		expect(taskWorkLine(undefined)).toBe("");
		expect(taskWorkLine({ edited: [], read: 0, commands: 0, searches: 0, webPages: 0, otherTools: 0 })).toBe("");
		expect(
			taskWorkLine({
				edited: ["src/a.ts", "C:\\proj\\b.ts"],
				read: 5,
				commands: 1,
				searches: 2,
				webPages: 3,
				otherTools: 1,
			}),
		).toBe(
			"Edited 2 files (a.ts, b.ts) \u00b7 ran 1 command \u00b7 read 5 files \u00b7 2 web searches \u00b7 3 pages opened \u00b7 1 tool call",
		);
		expect(taskWorkLine({ edited: ["a", "b", "c", "d"], read: 0, commands: 0 })).toBe(
			"Edited 4 files (a, b, c, \u2026)",
		);
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
	it("round-trips pricing currency and tiers without detection overwriting them", () => {
		const cost = {
			currency: "CNY",
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 0.5,
			tiers: [{ inputTokensAbove: 200000, input: 3, output: 4, cacheRead: 0.2, cacheWrite: 1 }],
		};
		const draft = models.modelDraft({ id: "priced", cost });
		expect(models.buildModel(draft).cost).toEqual(cost);
		const detected = models.updateFromDetection(draft, { id: "priced", contextWindow: 256000 });
		expect(models.buildModel(detected).cost).toEqual(cost);
		expect(models.buildModel({ ...draft, pricing: null }).cost).toBeUndefined();
	});
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
		expect(models.fmtK(128000)).toBe("128.0K");
		expect(models.fmtK(131072)).toBe("131.1K");
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
		const { settingsMenuFor } = await import("../src/startup/settings-menu.ts");
		const { SETTINGS_MENU_SETTING } = await import("../src/modes/web/routes-settings.ts");
		const web = settingsMenuFor("web").map((item) => item.id);
		const openable = [...Object.keys(SETTINGS_MENU_SETTING), ...Object.keys(SETTINGS_MENU_PAGES)];
		expect(new Set(openable).size).toBe(openable.length);
		expect([...openable].sort()).toEqual([...web].sort());
	});
});

describe("Web UI: shared slash-command registry", () => {
	it("gives every built-in command the registry offers to the Web a way to run, and nothing else", async () => {
		const { BUILTIN_COMMAND_KINDS } = await import(new URL("builtin-commands.js", webDir).href);
		const { builtinSlashCommandsFor, findBuiltinSlashCommand } = await import("../src/startup/slash-commands.ts");
		const web = builtinSlashCommandsFor("web").map((command) => command.name);
		expect([...web].sort()).toEqual(Object.keys(BUILTIN_COMMAND_KINDS).sort());
		expect(new Set(Object.values(BUILTIN_COMMAND_KINDS))).toEqual(new Set(["panel", "action", "prompt"]));
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

describe("Web UI: effort names an API accepts versus the levels a model runs", () => {
	const deepseek = { raw: { thinkingLevelAliases: { ultra: "max", medium: "high", minimal: "low", xhigh: "high" } } };

	it("offers every level except the names the documentation says only run as another level", () => {
		expect(models.offeredLevels({ raw: {} })).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(models.offeredLevels(deepseek)).toEqual(["off", "low", "high", "max"]);
		// The aliases are listed in the order of the levels, not in the order they were stored.
		expect(models.aliasPairs(deepseek)).toEqual([
			["minimal", "low"],
			["medium", "high"],
			["xhigh", "high"],
			["ultra", "max"],
		]);
		expect(models.aliasPairs({ raw: {} })).toEqual([]);
	});

	it("marks only a level no check could settle as unconfirmed", () => {
		const probed = {
			raw: {
				thinkingLevelStatus: { minimal: "unknown", low: "supported", medium: "unverified", high: "unsupported" },
			},
		};
		expect(models.levelUnconfirmed(probed, "minimal")).toBe(true);
		expect(models.levelUnconfirmed(probed, "medium")).toBe(true);
		expect(models.levelUnconfirmed(probed, "low")).toBe(false);
		expect(models.levelUnconfirmed(probed, "high")).toBe(false);
		// No test result at all is not "unconfirmed": nothing was tried.
		expect(models.levelUnconfirmed({ raw: {} }, "minimal")).toBe(false);
	});
});

describe("Web UI: counts typed in a unit", () => {
	it("shows an exact token count as the number in front of its unit and reads it back unchanged", () => {
		expect(tokensToUnit(262144, 1024)).toBe("256");
		expect(tokensToUnit(200000, 1024)).toBe("195.3125");
		expect(tokensToUnit(131072, 1000)).toBe("131.072");
		expect(tokensToUnit(undefined, 1024)).toBe("");
		expect(tokensToUnit(0, 1024)).toBe("");
		expect(unitToTokens("256", 1024)).toBe(262144);
		expect(unitToTokens("195.3125", 1024)).toBe(200000);
		expect(unitToTokens(" 1.5 ", 1000)).toBe(1500);
	});

	it("accepts nothing but a positive number that makes a whole number of tokens", () => {
		for (const text of ["", " ", "0", "-3", "12abc", "1e3", "abc", "0.0001", "1,5"]) {
			expect(unitToTokens(text, 1024), JSON.stringify(text)).toBeUndefined();
		}
	});
});

describe("Web UI: what the agent really did on the web and in files", () => {
	const searchCall = (id: string, results: number, pages: number) =>
		describeAction(
			{ id, name: "web_search", args: { query: `q${id}` } },
			{
				isError: false,
				details: {
					results: Array.from({ length: results }, (_, i) => ({ url: `https://example.test/${i}` })),
					pages: Array.from({ length: pages }, (_, i) => ({ url: `https://example.test/p${i}` })),
				},
			},
			undefined,
			"",
		);
	const fetchCall = (id: string, pages: number) =>
		describeAction(
			{ id, name: "web_fetch", args: { url: "https://example.test/" } },
			{
				isError: false,
				details: { pages: Array.from({ length: pages }, (_, i) => ({ url: `https://example.test/p${i}` })) },
			},
			undefined,
			"",
		);
	const step = (action: { kind: string }, name: string, key: string) => ({
		type: "action",
		key,
		call: { name },
		...action,
	});

	it("sums searching rounds, returned results and opened pages from the results of the calls", () => {
		const calls = [
			step(searchCall("1", 10, 1), "web_search", "a"),
			step(searchCall("2", 8, 2), "web_search", "b"),
			step(fetchCall("3", 0), "web_fetch", "c"),
		];
		expect(webStats(calls)).toEqual({ rounds: 2, returned: 18, opened: 3 });
		// Reading a page is part of the same web aggregate, whichever tool did it.
		const groups = groupSteps(calls);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ type: "group", kind: "web" });
		expect(groupLabel("web", groups[0].actions)).toBe("2 search rounds · 18 results returned · 3 pages opened");
		// Without a search only the pages that were opened are named.
		expect(groupLabel("web", [step(fetchCall("4", 3), "web_fetch", "d")])).toBe("Opened 3 web pages");
	});

	it("counts nothing for a call that has no result yet", () => {
		const running = describeAction(
			{ id: "9", name: "web_search", args: { query: "z" } },
			undefined,
			{ status: "running" },
			"",
		);
		// Nothing is made up for it: the row shows the plain "searching" state until the tool's own numbers arrive.
		expect(running).toMatchObject({ status: "running", verb: "Searching the web" });
		expect(running.web).toBeUndefined();
	});

	it("shows the lines a write really added and removed, and sums a group only when every row has a real count", () => {
		const created = describeAction(
			{ id: "w1", name: "write", args: { path: "a.txt", content: "x\ny\n" } },
			{ isError: false, details: { created: true, additions: 2, deletions: 0 } },
			undefined,
			"",
		);
		const overwritten = describeAction(
			{ id: "w2", name: "write", args: { path: "b.txt", content: "x" } },
			{ isError: false, details: { additions: 3, deletions: 1 } },
			undefined,
			"",
		);
		const uncounted = describeAction(
			{ id: "w3", name: "write", args: { path: "c.bin", content: "x" } },
			{ isError: false },
			undefined,
			"",
		);
		expect(created.extra).toEqual({ additions: 2, deletions: 0 });
		expect(uncounted.extra).toBeUndefined();
		expect(changeTotals([created, overwritten])).toEqual({ additions: 5, deletions: 1 });
		expect(changeTotals([created, uncounted])).toEqual(created.extra);
	});
});

describe("Web UI: the composer draft drawn as Markdown", async () => {
	const { deletionRange, draftLines, lineAt, renderDraft } = await import(new URL("draft-markdown.js", webDir).href);
	const plainText = (html: string) =>
		html
			.replace(/<br>/g, "")
			.replace(/<[^>]+>/g, "")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&quot;", '"')
			.replaceAll("&#39;", "'")
			.replaceAll("&amp;", "&");

	it("keeps every character of the source, in order, one block per line", () => {
		const source =
			"# Title **bold**\n\n- item with `code <b>`\n1. first\n> quote _em_\n```ts\nconst a = 1 < 2;\n```\n---\n[link](https://x.y) ~~gone~~ snake_case_name * a & b";
		const lines = draftLines(source);
		expect(lines.length).toBe(source.split("\n").length);
		expect(lines.map((line: { html: string }) => plainText(line.html)).join("\n")).toBe(source);
		expect(renderDraft(source).match(/<div class="dline/g)?.length).toBe(source.split("\n").length);
	});

	it("formats headings, lists, bold, inline code and fenced code, and marks the syntax", () => {
		const [heading, , item, numbered, quote, fence, code, fenceEnd, rule] = draftLines(
			"## Plan\n\n- **do** `it`\n2. next\n> said\n```\n**not bold**\n```\n***",
		);
		expect(heading.cls).toBe("dline-h dline-h2");
		expect(heading.html).toBe('<span class="md-mk">## </span>Plan');
		expect(item.cls).toBe("dline-li");
		expect(item.html).toContain('<strong><span class="md-mk">**</span>do<span class="md-mk">**</span></strong>');
		expect(item.html).toContain(
			'<code class="md-code"><span class="md-mk">`</span>it<span class="md-mk">`</span></code>',
		);
		expect(numbered.cls).toBe("dline-li dline-ol");
		expect(quote.cls).toBe("dline-quote");
		expect(fence.cls).toBe("dline-fence");
		expect(code).toEqual({ cls: "dline-code", html: "**not bold**" });
		expect(fenceEnd.cls).toBe("dline-fence dline-fence-end");
		expect(rule.cls).toBe("dline-hr");
		// Underscores inside a word are not emphasis; unclosed marks stay plain text.
		expect(draftLines("snake_case_name **open")[0].html).toBe("snake_case_name **open");
	});

	it("marks the caret's line as active and finds lines by offset", () => {
		expect(renderDraft("a\nb", 1)).toBe('<div class="dline">a</div><div class="dline active">b</div>');
		expect(renderDraft("")).toBe('<div class="dline"><br></div>');
		expect(lineAt("a\nbc\nd", 0)).toBe(0);
		expect(lineAt("a\nbc\nd", 2)).toBe(1);
		expect(lineAt("a\nbc\nd", 6)).toBe(2);
	});

	it("deletes one character, a word, or to the line edge, and a line break at an edge", () => {
		const text = "hello world\nnext 👍🏽 x";
		expect(deletionRange(text, 5, "deleteContentBackward")).toEqual([4, 5]);
		expect(deletionRange(text, 12, "deleteContentBackward")).toEqual([11, 12]);
		expect(deletionRange(text, 11, "deleteContentForward")).toEqual([11, 12]);
		expect(deletionRange(text, 11, "deleteWordBackward")).toEqual([6, 11]);
		expect(deletionRange(text, 0, "deleteWordForward")).toEqual([0, 5]);
		expect(deletionRange(text, 8, "deleteSoftLineBackward")).toEqual([0, 8]);
		const emoji = text.indexOf("👍");
		expect(deletionRange(text, emoji + 4, "deleteContentBackward")).toEqual([emoji, emoji + 4]);
		expect(deletionRange(text, 0, "deleteContentBackward")).toEqual([0, 0]);
	});
});
