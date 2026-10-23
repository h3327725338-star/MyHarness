import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// actions.js reaches the store and browser-only modules; mock those two like web-export-replay-unit.test.ts does.
vi.mock("../web/js/ui.js", () => ({
	html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		type: "vnode",
		strings: Array.from(strings),
		values,
	}),
	Icon: (props?: { name?: string; size?: number }) => ({ type: "icon", name: props?.name, size: props?.size }),
}));

vi.mock("/vendor/preact-hooks.js", () => ({
	useLayoutEffect: () => {},
	useRef: (init: unknown) => ({ current: init }),
	useState: (init: unknown) => [init, () => {}],
}));

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
	splitFirstSentence,
	stripAnsi,
	storedToUnitValue,
	taskWorkLine,
	tokensToUnit,
	unitToTokens,
	unitValueToStored,
} = await import(new URL("util.js", webDir).href);
const { byUsage, rankSearch, searchTier } = await import(new URL("search.js", webDir).href);
const { createSseWatchdog, isDeadStream } = await import(new URL("sse-watchdog.js", webDir).href);
const { exportTooLargeMessage } = await import(new URL("actions.js", webDir).href);

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

describe("Web UI: numberUnit fields (retry attempts, HTTP idle timeout)", () => {
	const timeoutUnits = [
		{ value: "minutes", label: "minutes", multiplier: 60_000 },
		{ value: "seconds", label: "seconds", multiplier: 1_000 },
		{ value: "disabled", label: "Disabled", fixed: 0 },
	];
	const retryUnits = [
		{ value: "times", label: "times" },
		{ value: "unlimited", label: "Unlimited", fixed: "unlimited" },
	];

	it("shows the stored value in the largest unit that fits it exactly", () => {
		expect(storedToUnitValue(300_000, timeoutUnits).typed).toBe("5");
		expect(storedToUnitValue(300_000, timeoutUnits).unit.value).toBe("minutes");
		expect(storedToUnitValue(30_000, timeoutUnits).unit.value).toBe("seconds");
		expect(storedToUnitValue(30_000, timeoutUnits).typed).toBe("30");
		// A value no whole unit fits (an old hand-edited settings.json) falls back to the finest unit.
		expect(storedToUnitValue(45_500, timeoutUnits).typed).toBe("45.5");
	});

	it("reads fixed units (unlimited, disabled) back as no-number choices", () => {
		expect(storedToUnitValue(0, timeoutUnits).unit.value).toBe("disabled");
		expect(storedToUnitValue(0, timeoutUnits).typed).toBe("");
		expect(storedToUnitValue("unlimited", retryUnits).unit.value).toBe("unlimited");
		expect(storedToUnitValue(3, retryUnits).typed).toBe("3");
	});

	it("accepts only whole typed numbers whose stored value is inside the range", () => {
		expect(unitValueToStored("5", timeoutUnits[0], 0, 2_147_483_647)).toBe(300_000);
		expect(unitValueToStored("30", timeoutUnits[1], 0, 2_147_483_647)).toBe(30_000);
		expect(unitValueToStored("3", retryUnits[0], 0, Number.MAX_SAFE_INTEGER)).toBe(3);
		expect(unitValueToStored("0", retryUnits[0], 0, Number.MAX_SAFE_INTEGER)).toBe(0);
		expect(unitValueToStored("2.5", retryUnits[0], 0, Number.MAX_SAFE_INTEGER)).toBeUndefined();
		expect(unitValueToStored("-1", retryUnits[0], 0, Number.MAX_SAFE_INTEGER)).toBeUndefined();
		expect(unitValueToStored("", retryUnits[0], 0, Number.MAX_SAFE_INTEGER)).toBeUndefined();
		// 99999999 minutes is past what any timer can wait: it must be refused, not stored.
		expect(unitValueToStored("99999999", timeoutUnits[0], 0, 2_147_483_647)).toBeUndefined();
	});
});

describe("Web UI: completion status", () => {
	it("labels only the actual phase and keeps unknown phases neutral", async () => {
		const { completionLabel } = await import(new URL("completion-status.js", webDir).href);
		expect(completionLabel({ phase: "changes" })).toBe("Checking this task's file changes");
		expect(completionLabel({ phase: "records" })).toBe("Saving task records");
		expect(completionLabel({ phase: "memory" })).toBe("Organizing long-term memory");
		expect(completionLabel({})).toBe("Finalizing task records");
	});
	it("waits 500ms once per task, not again on a phase change or old snapshot", async () => {
		const { completionDelay } = await import(new URL("completion-status.js", webDir).href);
		expect(completionDelay({ startedAt: 1000 }, 1000)).toBe(500);
		expect(completionDelay({ startedAt: 1000, phase: "memory" }, 1300)).toBe(200);
		expect(completionDelay({ startedAt: 1000 }, 1500)).toBe(0);
		expect(completionDelay({ startedAt: 1000 }, 2000)).toBe(0);
		expect(completionDelay({ startedAt: 2000 }, 1000)).toBe(500);
	});
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

describe("Web UI: Coding / General modes", () => {
	it("maps composer attachments to saved drafts and back without uploading again", async () => {
		const { draftFromServer, draftToServer } = await import(new URL("chat-modes.js", webDir).href);
		const image = { name: "a.png", mimeType: "image/png", data: "AAA", url: "data:image/png;base64,AAA" };
		const file = { name: "doc.txt", path: "C:/uploads/doc.txt" };
		const saved = draftToServer({ text: "中文草稿", images: [image, file] });
		expect(saved).toEqual({
			text: "中文草稿",
			attachments: [
				{ kind: "image", name: "a.png", mimeType: "image/png", data: "AAA" },
				{ kind: "file", name: "doc.txt", path: "C:/uploads/doc.txt" },
			],
		});
		expect(draftFromServer(JSON.parse(JSON.stringify(saved)))).toEqual({ text: "中文草稿", images: [image, file] });
		expect(draftFromServer({ text: "x", attachments: [null, { unknown: true }] })).toEqual({ text: "x", images: [] });
		expect(draftFromServer(undefined)).toBeNull();
	});

	it("summarizes the other mode's tasks from slot status without its own state machine", async () => {
		const { chatModeOf, expandedKey, modeSignal, modeTasks, slotSignal, taskCounts } = await import(
			new URL("chat-modes.js", webDir).href
		);
		expect(chatModeOf(undefined)).toBe("coding");
		expect(chatModeOf("general")).toBe("general");
		expect(expandedKey("coding")).toBe("expanded");
		expect(expandedKey("general")).toBe("expandedGeneral");
		const slot = (id: string, mode: string | undefined, patch: object) => ({
			slot: id,
			mode,
			active: false,
			waiting: false,
			completion: false,
			unread: false,
			lastOutcome: null,
			lastActivityAt: 0,
			...patch,
		});
		const slots = [
			slot("a", "general", { unread: true, lastOutcome: "completed", lastActivityAt: 2 }),
			slot("b", "general", { active: true }),
			slot("c", "general", { unread: true, lastOutcome: "failed" }),
			slot("d", "general", { waiting: true, active: true }),
			slot("e", "general", { lastOutcome: "completed" }),
			slot("f", undefined, { unread: true, lastOutcome: "failed" }),
			slot("g", "general", { unread: true, lastOutcome: "completed", lastActivityAt: 5 }),
		];
		expect(slotSignal(slots[4])).toBeNull();
		const tasks = modeTasks(slots, "general", "g");
		expect(tasks.map((task: any) => [task.slot.slot, task.signal])).toEqual([
			["d", "waiting"],
			["c", "failed"],
			["b", "running"],
			["a", "completed"],
		]);
		expect(taskCounts(tasks)).toEqual({ waiting: 1, failed: 1, completed: 1 });
		expect(modeSignal(slots, "coding")).toBe("failed");
		expect(modeSignal([], "general")).toBeNull();
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

	it("keeps a saved empty chat first while it is the chat on screen", async () => {
		const { orderChats } = await import(new URL("chat-order.js", webDir).href);
		const list = [
			{ path: "recent", modified: 900 },
			{ path: "pinned", modified: 950, pinned: true },
			{ path: "saved-new", modified: 100, blank: true },
			{ path: "left-blank", modified: 50, blank: true },
		];
		// Once the server wrote the new chat's setup it arrives as a blank row; the first place follows the chat on
		// screen instead of its (older) creation time, so typing in it does not drop it below chats used since.
		const onScreen = (info: any) => info.path === "saved-new";
		expect(orderChats(list, () => undefined, { onScreen, now: 1000 }).map((info: any) => info.path)).toEqual([
			"saved-new",
			"pinned",
			"recent",
			"left-blank",
		]);
		// A blank chat that is not the one on screen keeps sorting by its own time.
		expect(
			orderChats(list, () => undefined, { onScreen: () => false, now: 1000 }).map((info: any) => info.path),
		).toEqual(["pinned", "recent", "saved-new", "left-blank"]);
	});
});

describe("Web UI: blank chats left behind", () => {
	it("hides a saved blank chat once nothing keeps it on the list, and never one that holds anything", async () => {
		const { isLeftBlank } = await import(new URL("chat-order.js", webDir).href);
		const blank = { path: "b", blank: true };
		expect(isLeftBlank(blank)).toBe(true);
		expect(isLeftBlank(blank, { slot: { hasContent: false, firstMessage: "", active: false } })).toBe(true);
		// What keeps it: it is on screen, pinned or named, holds a draft, or is open with something in it.
		expect(isLeftBlank(blank, { current: true })).toBe(false);
		expect(isLeftBlank({ ...blank, pinned: true })).toBe(false);
		expect(isLeftBlank({ ...blank, name: "Plan" })).toBe(false);
		expect(isLeftBlank(blank, { draft: true })).toBe(false);
		for (const content of [
			{ hasContent: true },
			{ firstMessage: "hi" },
			{ name: "x" },
			{ active: true },
			{ completion: true },
			{ waiting: true },
		]) {
			expect(isLeftBlank(blank, { slot: content }), JSON.stringify(content)).toBe(false);
		}
		// Only the server says a chat is blank: a chat without messages may still hold operation cards, and an older server sends no flag.
		expect(isLeftBlank({ path: "m", messageCount: 0 })).toBe(false);
		expect(isLeftBlank({ path: "m", blank: false })).toBe(false);
	});

	it("counts a saved draft only when it holds text or an attachment", async () => {
		const { draftHasContent } = await import(new URL("chat-modes.js", webDir).href);
		expect(draftHasContent(undefined)).toBe(false);
		expect(draftHasContent({ text: "  \n", attachments: [] })).toBe(false);
		expect(draftHasContent({ text: "hello", attachments: [] })).toBe(true);
		expect(draftHasContent({ text: "", attachments: [{ kind: "file", name: "a", path: "p" }] })).toBe(true);
	});

	it("keeps rows that left in place by their own key, for lists of workspaces and toasts too", async () => {
		const { reconcileRows } = await import(new URL("list-presence.js", webDir).href);
		const old = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const current = [{ id: "a" }, { id: "c" }, { id: "d" }];
		expect(reconcileRows(old, current, "id").map((row: any) => row.id)).toEqual(["a", "b", "c", "d"]);
	});
});

describe("Web UI: bookmark labels in the transcript wire", () => {
	it("ignores label items so they never open a turn or change the turn list", () => {
		const user = { kind: "user", ts: 1, text: "task", images: [] };
		const reply = assistant([{ type: "text", text: "task done" }]);
		const label = { kind: "label", id: "l1", ts: 3, targetId: "a", label: "keep" };
		const plain = buildTurns([user, reply], { toolRuns: {} });
		const withLabel = buildTurns([label, user, reply, label], { toolRuns: {} });
		expect(withLabel).toHaveLength(plain.length);
		expect(withLabel[0].items).toHaveLength(plain[0].items.length);
	});
});

describe("Web UI: turn keys stay with their entry, never their position", () => {
	it("gives the same turn one key in the tail preview and in the full transcript", () => {
		const first = { kind: "user", id: "u-1", ts: 1, text: "first task", images: [] };
		const firstReply = assistant([{ type: "text", text: "first answer" }], { ts: 2 });
		const second = { kind: "user", id: "u-2", ts: 10, text: "second task", images: [] };
		const secondReply = assistant([{ type: "text", text: "second answer" }], { ts: 11 });
		const full = buildTurns([first, firstReply, second, secondReply], { toolRuns: {} });
		// A cold load of a long session paints the tail window first (web/js/transcript.js): the same turns built from
		// that slice must carry the same keys, or replacing the preview with the full build remounts them.
		const tail = buildTurns([second, secondReply], { toolRuns: {} });
		expect(tail.map((turn: { key: string }) => turn.key)).toEqual([full[1].key]);
	});

	it("keeps the key when a reload stamps the entry with its own timestamp", () => {
		// The streamed item carries the message time, a reload the entry time; both name the same entry, so the entry id
		// must decide the key and neither timestamp may move it.
		const card = {
			kind: "runChanges",
			id: "rc-7",
			runId: 1,
			files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, binary: false }],
		};
		const live = buildTurns(
			[
				{ kind: "user", id: "e-5", ts: 500, text: "ask", images: [] },
				{ ...card, ts: 501 },
			],
			{ toolRuns: {} },
		);
		const reloaded = buildTurns(
			[
				{ kind: "user", id: "e-5", ts: 480, text: "ask", images: [] },
				{ ...card, ts: 999 },
			],
			{ toolRuns: {} },
		);
		expect(reloaded.map((turn: { key: string }) => turn.key)).toEqual(live.map((turn: { key: string }) => turn.key));
	});

	it("keeps every key when an older page is prepended above", () => {
		const card = {
			kind: "runChanges",
			id: "rc-1",
			ts: 3,
			runId: 1,
			files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, binary: false }],
		};
		const head = { kind: "user", id: "u-1", ts: 2, text: "first task", images: [] };
		const headReply = assistant([{ type: "text", text: "first answer" }], { ts: 4 });
		const items = [
			head,
			headReply,
			card,
			{ kind: "gitStatus", id: "g-1", ts: 5, result: { tone: "ok", title: "Commit succeeded" } },
			{ kind: "user", id: "u-2", ts: 10, text: "second task", images: [] },
			assistant([{ type: "text", text: "second answer" }], { ts: 11 }),
		];
		const window = buildTurns(items, { toolRuns: {} });
		const older = [
			{ kind: "user", id: "u-0", ts: 1, text: "older task", images: [] },
			assistant([{ type: "text", text: "older answer" }], { ts: 1 }),
		];
		const paged = buildTurns([...older, ...items], { toolRuns: {} });
		expect(paged.slice(1).map((turn: { key: string }) => turn.key)).toEqual(
			window.map((turn: { key: string }) => turn.key),
		);
	});

	it("reuses the preview's turn objects when the full build takes over", () => {
		const user = { kind: "user", id: "u-1", ts: 10, text: "task", images: [] };
		const reply = assistant([{ type: "text", text: "done" }], { ts: 11 });
		const preview = buildTurns([user, reply], { toolRuns: {} });
		const full = buildTurns(
			[assistant([{ type: "text", text: "earlier" }], { ts: 1 }), user, reply],
			{ toolRuns: {} },
			preview,
		);
		expect(full[1]).toBe(preview[0]);
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
	it("shows edit counts only from the real diff, never from streamed arguments", () => {
		const call = { name: "edit", args: { path: "file.txt" } };
		// Before the tool runs there is nothing to count: no estimated extra, just the preparing wording.
		expect(describeAction(call, undefined, undefined, "")).toMatchObject({
			verb: "Preparing changes",
			phase: "generating",
		});
		expect(describeAction(call, undefined, undefined, "").extra).toBeUndefined();
		expect(describeAction(call, undefined, { status: "running" }, "")).toMatchObject({
			verb: "Applying changes",
			phase: "applying",
		});
		// A leftover changePreview on an old call object is ignored: only real patch data counts.
		const stale = { ...call, changePreview: { additions: 9, deletions: 9 } };
		expect(describeAction(stale, undefined, { status: "running" }, "").extra).toBeUndefined();
		expect(
			describeAction(
				call,
				undefined,
				{ status: "running", partialDetails: { patch: "@@ -1 +1 @@\n-old\n+new\n" } },
				"",
			),
		).toMatchObject({ extra: { additions: 1, deletions: 1 } });
		expect(
			describeAction(stale, { isError: false, details: { patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" } }, undefined, ""),
		).toMatchObject({
			extra: { additions: 2, deletions: 1 },
		});
		expect(describeAction(call, { isError: true }, undefined, "").extra).toBeUndefined();
	});
	it("reads running file change details and drops counts on failure", () => {
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

	it("never shows an unconfirmed local message as unanswered, but still flags a confirmed one with no reply", () => {
		const turnOf = (user: Record<string, unknown>) =>
			buildTurns([{ kind: "user", ts: 1, text: "x", images: [], ...user }], { cwd: "", toolRuns: {} })[0];
		const idle = { run: undefined, live: false, waiting: false };
		expect(turnOutcome(turnOf({ pending: true, clientMessageId: "c1" }), idle)).toBe("running");
		expect(turnOutcome(turnOf({ id: "u1" }), idle)).toBe("unanswered");
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

describe("Web UI: process summary status", () => {
	it("keeps earlier blocks neutral for every task outcome, including failed local actions", async () => {
		const { processSummaryState } = await import(new URL("process-summary.js", webDir).href);
		for (const outcome of ["running", "completed", "failed", "partial", "cancelled", "waiting"]) {
			const summary = processSummaryState({
				last: false,
				running: outcome === "running",
				outcome,
				stats: { actions: 7, files: 1, failedActions: 1 },
				duration: 5000,
				changeCount: 2,
			});
			expect(summary).toEqual({ live: false, icon: "list", label: "7 actions", outcome: "neutral" });
		}
		expect(processSummaryState({ last: false, stats: { actions: 0 } }).label).toBe("Reasoning");
	});

	it("does not show the Chinese completion label on earlier blocks", async () => {
		const { processSummaryState } = await import(new URL("process-summary.js", webDir).href);
		const { getLang, setLang } = await import(new URL("lang.js", webDir).href);
		const previous = getLang();
		try {
			setLang("zh-CN");
			expect(
				processSummaryState({ last: false, running: true, outcome: "running", stats: { actions: 7 } }).label,
			).toBe("7 个操作");
			expect(
				processSummaryState({ last: true, outcome: "completed", stats: { actions: 8 }, duration: 0 }).label,
			).toBe("已完成 · 8 个操作");
		} finally {
			setLang(previous);
		}
	});

	it("reserves live activity and whole-task results for the last block", async () => {
		const { processSummaryState } = await import(new URL("process-summary.js", webDir).href);
		const props = { last: true, stats: { actions: 8 }, changeCount: 2, duration: 5000 };
		expect(processSummaryState({ ...props, running: true, outcome: "running" })).toMatchObject({
			live: true,
			label: "",
			outcome: "running",
		});
		expect(processSummaryState({ ...props, running: true, compacting: true, outcome: "running" })).toMatchObject({
			live: false,
			icon: "clock",
			outcome: "running",
		});
		expect(processSummaryState({ ...props, outcome: "completed" })).toEqual({
			live: false,
			icon: "checkCircle",
			label: "Worked for 5s · 8 actions · 2 files changed",
			outcome: "completed",
		});
		for (const [outcome, icon] of [
			["failed", "alertCircle"],
			["partial", "alertTriangle"],
			["cancelled", "stopCircle"],
			["waiting", "clock"],
			["unanswered", "alertTriangle"],
		]) {
			expect(processSummaryState({ ...props, outcome })).toMatchObject({ live: false, icon, outcome });
		}
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

	it("keeps the detection notice in step with the models still in the form", () => {
		const own = models.modelDraft({ id: "own" });
		const current = models.modelDraft({ id: "m", contextWindow: 1000 });
		const found = [
			{ id: "m", contextWindow: 2000, thinkingSource: "unconfirmed" },
			{ id: "new", name: "new" },
		];
		const summary = models.applyDetection([own, current], found);
		const record = models.detectRecord(summary, found, {
			unlisted: ["new"],
			listError: { code: "timeout" },
		});
		expect(record.touched.map((entry: any) => [entry.id, entry.added])).toEqual([
			["m", false],
			["new", true],
		]);
		// Nothing removed yet: everything the detection did is still reported.
		expect(models.detectOutcome(record, summary.models)).toMatchObject({
			total: 2,
			added: 1,
			updated: 1,
			unlisted: ["new"],
			listError: { code: "timeout" },
		});
		// Removing a model the detection did not touch says nothing about this detection.
		expect(
			models.detectOutcome(
				record,
				summary.models.filter((entry: any) => entry.uid !== own.uid),
			),
		).toMatchObject({
			total: 2,
			added: 1,
		});
		// Removing the model it added drops that part of the summary and the warnings naming it.
		const withoutAdded = summary.models.filter((entry: any) => entry.id !== "new");
		expect(models.detectOutcome(record, withoutAdded)).toMatchObject({
			total: 1,
			added: 0,
			updated: 1,
			unlisted: [],
		});
		// Removing every model it produced leaves nothing to report, even with other models still in the list.
		expect(models.detectOutcome(record, [current, own])).toMatchObject({ total: 1, added: 0, updated: 1 });
		expect(models.detectOutcome(record, [own])).toBeNull();
		expect(models.detectOutcome(record, [])).toBeNull();
		expect(models.detectOutcome(null, summary.models)).toBeNull();
	});

	it("names a removed Model ID in no warning of a detection that is still reported", () => {
		const found = [{ id: "a" }, { id: "b" }];
		const summary = models.applyDetection([], found);
		const record = models.detectRecord(summary, found, { unlisted: ["a", "b"] });
		const kept = summary.models.filter((entry: any) => entry.id !== "a");
		expect(models.detectOutcome(record, kept)).toMatchObject({ total: 1, added: 1, unlisted: ["b"] });
		// An ID the detection never reached a model for is not reported either.
		expect(models.detectRecord(summary, found, { unlisted: ["missing"] }).unlisted).toEqual([]);
	});

	it("leaves a model alone when a detection states nothing about it", () => {
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

describe("SSE reconnect watchdog", () => {
	const fakeTimers = () => {
		const queue: Array<{ at: number; run: () => void }> = [];
		let now = 0;
		return {
			setTimeoutFn: (run: () => void, ms: number) => {
				const item = { at: now + ms, run };
				queue.push(item);
				return item;
			},
			clearTimeoutFn: (handle: unknown) => {
				const index = queue.indexOf(handle as { at: number; run: () => void });
				if (index >= 0) queue.splice(index, 1);
			},
			advance(ms: number) {
				now += ms;
				for (const item of [...queue]) {
					if (item.at <= now) {
						queue.splice(queue.indexOf(item), 1);
						item.run();
					}
				}
			},
		};
	};

	it("recognizes streams that will never produce events again", () => {
		expect(isDeadStream(null)).toBe(true);
		expect(isDeadStream(undefined)).toBe(true);
		expect(isDeadStream({ readyState: 2 })).toBe(true); // EventSource.CLOSED
		expect(isDeadStream({ readyState: 0 })).toBe(false); // CONNECTING: the browser still retries
		expect(isDeadStream({ readyState: 1 })).toBe(false); // OPEN
	});

	it("rebuilds only a permanently failed stream, once, after the delay", () => {
		let closed = true;
		let rebuilds = 0;
		const timers = fakeTimers();
		const dog = createSseWatchdog({ isClosed: () => closed, rebuild: () => rebuilds++, ...timers });
		dog.watch(); // not closed? it is closed
		closed = false;
		dog.watch(); // an alive stream is left to the browser's own retry
		expect(rebuilds).toBe(0);
		closed = true;
		timers.advance(3000);
		expect(rebuilds).toBe(1);
		dog.watch();
		closed = true;
		timers.advance(3000);
		expect(rebuilds).toBe(2);
	});

	it("skips the rebuild when a healthy stream reopened before the timer, and revive acts at once", () => {
		let closed = true;
		let rebuilds = 0;
		const timers = fakeTimers();
		const dog = createSseWatchdog({ isClosed: () => closed, rebuild: () => rebuilds++, ...timers });
		dog.watch();
		closed = false; // the browser's own retry won
		timers.advance(3000);
		expect(rebuilds).toBe(0);
		closed = true;
		dog.revive();
		expect(rebuilds).toBe(1);
	});

	it("revive cancels a pending timer so the rebuild happens exactly once", () => {
		let rebuilds = 0;
		const timers = fakeTimers();
		const dog = createSseWatchdog({ isClosed: () => true, rebuild: () => rebuilds++, ...timers });
		dog.watch();
		dog.revive();
		timers.advance(10_000);
		expect(rebuilds).toBe(1);
	});
});

describe("Web UI: export too large (413) message", () => {
	const tooLarge = { code: "export_too_large", bytes: 33_554_432, limit: 31_457_280 };

	it("shows the size and the limit in MiB with one decimal, in English and Chinese", async () => {
		const { setLang } = await import(new URL("lang.js", webDir).href);
		const previous = (await import(new URL("lang.js", webDir).href)).getLang();
		try {
			setLang("en");
			expect(exportTooLargeMessage(413, tooLarge)).toBe(
				"This conversation is too large to export (32.0 MiB, limit 30.0 MiB). Start a new chat and export that one, or copy the conversation's .jsonl file from the data folder.",
			);
			setLang("zh-CN");
			expect(exportTooLargeMessage(413, tooLarge)).toBe(
				"这段对话太大，无法导出（32.0 MiB，上限 30.0 MiB）。请新开一个对话再导出，或从数据目录里直接复制该对话的 .jsonl 文件。",
			);
		} finally {
			setLang(previous);
		}
	});

	it("leaves every other failure to the existing wording", () => {
		expect(exportTooLargeMessage(500, tooLarge)).toBeNull();
		expect(exportTooLargeMessage(413, { error: "boom" })).toBeNull();
		expect(exportTooLargeMessage(413, { ...tooLarge, bytes: "32 MiB" })).toBeNull();
		expect(exportTooLargeMessage(413, { ...tooLarge, limit: Number.NaN })).toBeNull();
		expect(exportTooLargeMessage(413, undefined)).toBeNull();
		expect(exportTooLargeMessage(413, "not json")).toBeNull();
	});
});

describe("Web UI: actions.js closeCommand", () => {
	let origDoc: unknown;
	let origMatchMedia: unknown;
	let focusMock: ReturnType<typeof vi.fn>;
	let querySelectorMock: ReturnType<typeof vi.fn>;
	let setViewSpy: ReturnType<typeof vi.spyOn>;
	let store: {
		state: { view: Record<string, unknown> };
		setView: (patch: Record<string, unknown>) => void;
	};
	let actions: {
		closeCommand: () => void;
	};

	beforeAll(async () => {
		store = await import(new URL("store.js", webDir).href);
		actions = await import(new URL("actions.js", webDir).href);
	});

	beforeEach(() => {
		origDoc = (globalThis as Record<string, unknown>).document;
		origMatchMedia = (globalThis as Record<string, unknown>).matchMedia;
		focusMock = vi.fn();
		querySelectorMock = vi.fn((sel: string) => (sel === ".composer-input" ? { focus: focusMock } : null));
		(globalThis as Record<string, unknown>).document = {
			documentElement: { dataset: {}, style: { getPropertyValue: () => "", setProperty: vi.fn() } },
			querySelector: querySelectorMock,
		};
		(globalThis as Record<string, unknown>).matchMedia = vi.fn().mockReturnValue({ matches: false });
		setViewSpy = vi.spyOn(store, "setView");
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		setViewSpy.mockRestore();
		if (origDoc === undefined) {
			delete (globalThis as Record<string, unknown>).document;
		} else {
			(globalThis as Record<string, unknown>).document = origDoc;
		}
		if (origMatchMedia === undefined) {
			delete (globalThis as Record<string, unknown>).matchMedia;
		} else {
			(globalThis as Record<string, unknown>).matchMedia = origMatchMedia;
		}
		store.state.view.cmd = null;
	});

	it("clears command palette and restores focus to composer input when command palette is open", () => {
		store.state.view.cmd = { name: "test-cmd", arg: "hello" };

		actions.closeCommand();

		expect(setViewSpy).toHaveBeenCalledTimes(1);
		expect(setViewSpy).toHaveBeenCalledWith({ cmd: null });
		expect(store.state.view.cmd).toBeNull();
		expect(querySelectorMock).not.toHaveBeenCalled();

		vi.runAllTimers();

		expect(querySelectorMock).toHaveBeenCalledWith(".composer-input");
		expect(focusMock).toHaveBeenCalledTimes(1);
	});

	it("does nothing and does not throw when command palette is null", () => {
		store.state.view.cmd = null;

		expect(() => actions.closeCommand()).not.toThrow();
		expect(setViewSpy).not.toHaveBeenCalled();

		vi.runAllTimers();

		expect(querySelectorMock).not.toHaveBeenCalled();
		expect(focusMock).not.toHaveBeenCalled();
	});

	it("does nothing and does not throw when command palette is undefined", () => {
		store.state.view.cmd = undefined;

		expect(() => actions.closeCommand()).not.toThrow();
		expect(setViewSpy).not.toHaveBeenCalled();

		vi.runAllTimers();

		expect(querySelectorMock).not.toHaveBeenCalled();
		expect(focusMock).not.toHaveBeenCalled();
	});

	it("does not throw when composer-input element is not found on document", () => {
		store.state.view.cmd = { name: "test-cmd", arg: "" };
		querySelectorMock.mockReturnValue(null);

		actions.closeCommand();

		expect(setViewSpy).toHaveBeenCalledWith({ cmd: null });
		expect(() => vi.runAllTimers()).not.toThrow();
		expect(querySelectorMock).toHaveBeenCalledWith(".composer-input");
	});
});

describe("Web UI: actions.js removeWorkspace drops the row before the server answers", () => {
	let store: any;
	let actions: any;
	let removeWorkspace: (id: string, name: string) => Promise<unknown>;
	let resolveConfirm: (value: unknown) => void;
	let release: ((value: unknown) => void) | undefined;
	let releaseList: ((value: unknown) => void) | undefined;
	let origDoc: unknown;
	let origMatchMedia: unknown;

	const reply = (data: unknown, ok = true, status = 200) => ({
		ok,
		status,
		async text() {
			return JSON.stringify(data);
		},
	});
	const flush = async () => {
		for (let i = 0; i < 8; i += 1) await Promise.resolve();
	};
	const rowIds = () => store.state.workspaces.list.map((workspace: { id: string }) => workspace.id);

	beforeAll(async () => {
		store = await import(new URL("store.js", webDir).href);
		actions = await import(new URL("actions.js", webDir).href);
		removeWorkspace = actions.actions.removeWorkspace;
		resolveConfirm = actions.resolveConfirm;
	});

	beforeEach(() => {
		// setView() funnels through applyAppearance(), which reads the live document and the colour-scheme query.
		origDoc = (globalThis as Record<string, unknown>).document;
		origMatchMedia = (globalThis as Record<string, unknown>).matchMedia;
		(globalThis as Record<string, unknown>).document = {
			documentElement: { dataset: {}, style: { getPropertyValue: () => "", setProperty: vi.fn() } },
		};
		(globalThis as Record<string, unknown>).matchMedia = vi.fn().mockReturnValue({ matches: false });
		// savePrefs() arms a shared-prefs timer; fake timers keep it from firing into the next test's fetch stub.
		vi.useFakeTimers();
		store.state.view.chatMode = "general";
		store.state.workspaces = {
			list: [
				{ id: "w1", name: "One", rootPath: "C:/one" },
				{ id: "w2", name: "Two", rootPath: "C:/two" },
			],
			loaded: true,
			currentPath: null,
			currentSessionFile: null,
			sessions: {},
			unbound: [],
			errors: {},
		};
		release = undefined;
		releaseList = undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((input: unknown) => {
				const { pathname } = new URL(String(input), "http://127.0.0.1");
				if (pathname === "/api/workspaces/remove")
					return new Promise((resolve) => {
						release = resolve;
					});
				if (pathname === "/api/workspaces")
					return new Promise((resolve) => {
						releaseList = resolve;
					});
				return Promise.resolve(reply({ sessions: [] }));
			}),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		if (origDoc === undefined) delete (globalThis as Record<string, unknown>).document;
		else (globalThis as Record<string, unknown>).document = origDoc;
		if (origMatchMedia === undefined) delete (globalThis as Record<string, unknown>).matchMedia;
		else (globalThis as Record<string, unknown>).matchMedia = origMatchMedia;
		store.state.workspaces = {
			list: [],
			loaded: false,
			currentPath: null,
			currentSessionFile: null,
			sessions: {},
			unbound: undefined,
			errors: {},
		};
	});

	it("removes the row at once and keeps the server's list afterwards", async () => {
		const run = removeWorkspace("w1", "One");
		await flush();
		resolveConfirm({ deleteArtifacts: false });
		await flush();
		// The row is gone while the removal is still in flight.
		expect(rowIds()).toEqual(["w2"]);
		expect(release).toBeDefined();
		release!(reply({ ok: true }));
		await flush();
		releaseList!(
			reply({
				workspaces: [{ id: "w2", name: "Two", rootPath: "C:/two" }],
				currentPath: null,
				currentSessionFile: null,
			}),
		);
		await run;
		expect(rowIds()).toEqual(["w2"]);
	});

	it("puts the row back when the server refuses the removal", async () => {
		const run = removeWorkspace("w1", "One");
		await flush();
		resolveConfirm(true);
		await flush();
		expect(rowIds()).toEqual(["w2"]);
		release!(reply({ error: "Could not save the workspace list." }, false, 500));
		await flush();
		// Restored before the refreshed list arrives: the sidebar never keeps a row the server refused.
		expect(rowIds()).toEqual(["w1", "w2"]);
		releaseList!(
			reply({
				workspaces: [
					{ id: "w1", name: "One", rootPath: "C:/one" },
					{ id: "w2", name: "Two", rootPath: "C:/two" },
				],
				currentPath: null,
				currentSessionFile: null,
			}),
		);
		await run;
		expect(rowIds()).toEqual(["w1", "w2"]);
	});
});

describe("Web UI: store.js first-screen ordering of the unbound and archived lists", () => {
	let bootStore: any;
	let calls: string[];
	let snapPayload: () => unknown;

	const freshLists = () => ({
		list: [],
		loaded: false,
		currentPath: null,
		currentSessionFile: null,
		sessions: {},
		unbound: undefined,
		archived: undefined,
		errors: {},
		loading: false,
	});

	beforeAll(async () => {
		bootStore = await import(new URL("store.js", webDir).href);
	});

	beforeEach(async () => {
		vi.useFakeTimers();
		// No requestIdleCallback in Node: the deferred loads take the fallback timer path.
		delete (globalThis as Record<string, unknown>).requestIdleCallback;
		calls = [];
		snapPayload = () => ({
			slot: "t1",
			mode: "coding",
			session: { id: "t1", file: "C:/p/t1.jsonl", persisted: true, name: "Bound chat" },
			workspace: { id: "w", rootPath: "C:/p" },
			flags: {},
			queue: { steering: [], followUp: [] },
			dialogs: [],
			surface: { widgets: {}, statuses: {} },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (path: string) => {
				const key = String(path);
				calls.push(key);
				const url = new URL(key, "http://127.0.0.1");
				const pathname = url.pathname;
				let data: unknown = {};
				if (pathname === "/api/state") data = snapPayload();
				else if (pathname === "/api/transcript") data = { items: [] };
				else if (pathname === "/api/workspaces")
					data = { workspaces: [], currentPath: "C:/p", currentSessionFile: "C:/p/t1.jsonl" };
				else if (pathname === "/api/sessions/unbound") data = { sessions: [] };
				else if (pathname === "/api/sessions/archived") data = { sessions: [] };
				else if (pathname === "/api/workspaces/sessions") data = { sessions: [] };
				return {
					ok: true,
					status: 200,
					async text() {
						return JSON.stringify(data);
					},
				};
			}),
		);
		for (const mode of ["coding", "general"]) {
			bootStore.state.view.chatMode = mode;
			bootStore.state.workspaces = freshLists();
		}
		bootStore.state.view.chatMode = "coding";
		bootStore.state.view.expanded = undefined;
		bootStore.state.view.expandedGeneral = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const unboundCalls = () => calls.filter((c) => c.startsWith("/api/sessions/unbound"));
	const archivedCalls = () => calls.filter((c) => c.startsWith("/api/sessions/archived"));

	it("asks for the unbound list with the open General group and defers the archived one to a quiet page", async () => {
		await bootStore.refreshSlot("t1"); // the chat on screen is read and bound to a workspace
		bootStore.state.view.expanded = {}; // General is open (nothing stored means open)
		await bootStore.loadWorkspaces("coding", "t1");
		expect(unboundCalls().length).toBe(1); // content of the open group is needed now: no waiting
		expect(archivedCalls().length).toBe(0);
		await vi.advanceTimersByTimeAsync(2_400);
		expect(archivedCalls().length).toBe(0);
		await vi.advanceTimersByTimeAsync(300);
		expect(archivedCalls().length).toBe(1);
	});

	it("defers both lists when the General group is collapsed, then loads each exactly once", async () => {
		await bootStore.refreshSlot("t1");
		bootStore.state.view.expanded = { "<general>": false };
		await bootStore.loadWorkspaces("coding", "t1");
		expect(unboundCalls().length).toBe(0);
		expect(archivedCalls().length).toBe(0);
		await bootStore.loadWorkspaces("coding", "t1"); // a second workspace load while the first still waits joins it
		await vi.advanceTimersByTimeAsync(2_600);
		expect(unboundCalls().length).toBe(1);
		expect(archivedCalls().length).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(unboundCalls().length).toBe(1);
		expect(archivedCalls().length).toBe(1);
	});

	it("loads the unbound list at once when the chat on screen belongs to no workspace", async () => {
		snapPayload = () => ({
			slot: "t1",
			mode: "coding",
			session: { id: "t1", file: "C:/fixture/u1.jsonl", persisted: true, name: "Unbound chat" },
			workspace: null,
			flags: {},
			queue: { steering: [], followUp: [] },
			dialogs: [],
			surface: { widgets: {}, statuses: {} },
		});
		await bootStore.refreshSlot("t1");
		bootStore.state.view.expanded = { "<general>": false }; // collapsed, but the chat on screen lives in that list
		await bootStore.loadWorkspaces("coding", "t1");
		expect(unboundCalls().length).toBe(1);
		expect(archivedCalls().length).toBe(0);
		await vi.advanceTimersByTimeAsync(2_600);
		expect(archivedCalls().length).toBe(1);
	});

	it("does not ask again on idle for a list the user already loaded by opening the group", async () => {
		await bootStore.refreshSlot("t1");
		bootStore.state.view.expanded = { "<general>": false };
		await bootStore.loadWorkspaces("coding", "t1");
		await bootStore.loadUnbound("coding"); // the sidebar's expand path read the list
		expect(unboundCalls().length).toBe(1);
		await vi.advanceTimersByTimeAsync(2_600);
		expect(unboundCalls().length).toBe(1);
		expect(archivedCalls().length).toBe(1);
	});
});

describe("Web UI: applyAppearance writes <html> only when a value changed", () => {
	let store: any;
	let lang: any;
	let root: any;
	let writes: string[];
	let savedView: Record<string, unknown>;
	let savedLang: string;

	// Minimal documentElement stub with DOM-like read-back: an unset dataset key reads
	// `undefined`, a key written as "" reads "" (the attribute exists), like a real browser.
	const freshRoot = () => {
		writes = [];
		const attrs: Record<string, string> = {};
		const vars: Record<string, string> = {};
		let langValue = "";
		return {
			get lang() {
				return langValue;
			},
			set lang(v: string) {
				writes.push("lang");
				langValue = String(v);
			},
			dataset: new Proxy(
				{},
				{
					get: (_t, k: string) => (k in attrs ? attrs[k] : undefined),
					set: (_t, k: string, v: unknown) => {
						writes.push(`data-${k}`);
						attrs[k] = String(v);
						return true;
					},
				},
			),
			style: {
				getPropertyValue: (name: string) => vars[name] ?? "",
				setProperty: (name: string, v: string) => {
					writes.push(name);
					vars[name] = String(v);
				},
			},
		};
	};

	beforeAll(async () => {
		store = await import(new URL("store.js", webDir).href);
		lang = await import(new URL("lang.js", webDir).href);
	});

	beforeEach(() => {
		savedView = {
			theme: store.state.view.theme,
			colorThemes: { ...store.state.view.colorThemes },
			chatMode: store.state.view.chatMode,
			motion: store.state.view.motion,
			readWidth: store.state.view.readWidth,
			sidebarW: store.state.view.sidebarW,
			panelW: store.state.view.panelW,
			lang: store.state.view.lang,
		};
		savedLang = lang.getLang();
		store.state.view.theme = "dark";
		store.state.view.colorThemes = { coding: "classic", general: "classic" };
		store.state.view.chatMode = "coding";
		store.state.view.motion = "system";
		store.state.view.readWidth = "auto";
		store.state.view.sidebarW = 272;
		store.state.view.panelW = 560;
		store.state.view.lang = "en";
		root = freshRoot();
		vi.stubGlobal("document", { documentElement: root });
		vi.stubGlobal("matchMedia", () => ({ matches: false }));
	});

	afterEach(() => {
		Object.assign(store.state.view, { ...savedView, colorThemes: { ...(savedView.colorThemes as object) } });
		lang.setLang(savedLang);
		vi.unstubAllGlobals();
	});

	it("writes every appearance value once, then writes nothing when called again unchanged", () => {
		store.applyAppearance();
		expect(writes.length).toBeGreaterThan(0);
		writes = [];
		store.applyAppearance();
		expect(writes).toEqual([]);
	});

	it("writes exactly the one value that changed", () => {
		store.applyAppearance();
		writes = [];
		store.state.view.sidebarW = 300;
		store.applyAppearance();
		expect(writes).toEqual(["--sidebar-w"]);
		writes = [];
		store.state.view.lang = "zh-CN";
		store.applyAppearance();
		expect(writes).toEqual(["lang"]);
	});

	it("keeps the system-motion empty-string shape: writes it once, then skips it", () => {
		store.applyAppearance(); // motion=system writes data-motion=""
		expect(root.dataset.motion).toBe("");
		writes = [];
		store.applyAppearance();
		expect(writes).toEqual([]);
		store.state.view.motion = "off";
		store.applyAppearance();
		expect(writes).toEqual(["data-motion"]);
		expect(root.dataset.motion).toBe("off");
		writes = [];
		store.state.view.motion = "system";
		store.applyAppearance();
		expect(writes).toEqual(["data-motion"]);
		expect(root.dataset.motion).toBe("");
	});

	it("setLang does not touch documentElement.lang when the language is unchanged", () => {
		store.applyAppearance();
		writes = [];
		lang.setLang("en");
		expect(writes).toEqual([]);
		lang.setLang("zh-CN");
		expect(writes).toEqual(["lang"]);
		expect(root.lang).toBe("zh-CN");
	});
});

describe("Web UI: cross-session turns cache (store.js bag + turns.js hit check)", () => {
	let cacheStore: any;
	let turnsLib: {
		buildTurns: (...a: unknown[]) => unknown[];
		cachedTurns: (...a: unknown[]) => unknown[] | null;
		turnsProbe: { builds: number };
	};

	beforeAll(async () => {
		cacheStore = await import(new URL("store.js", webDir).href);
		turnsLib = await import(new URL("turns.js", webDir).href);
	});

	const user = { kind: "user", id: "cu-1", ts: 1, text: "task", images: [] };
	const reply = assistant([{ type: "text", text: "done" }]);

	// Mirrors the Transcript useMemo body exactly: hit the bag cache first, build and store on a miss.
	const computeTurns = (slot: string, items: unknown[], toolRuns: unknown, cwd: string) => {
		const cached = turnsLib.cachedTurns(cacheStore.getTurnsCache(slot), items, toolRuns, cwd);
		if (cached) return cached;
		const built = turnsLib.buildTurns(items, { cwd, toolRuns });
		cacheStore.setTurnsCache({ items, toolRuns, cwd, turns: built }, slot);
		return built;
	};

	it("① a second call with the same references serves the cache without running buildTurns", () => {
		const items = [user, reply];
		const toolRuns = {};
		const buildsBefore = turnsLib.turnsProbe.builds;
		const first = computeTurns("cache-s1", items, toolRuns, "/w");
		const second = computeTurns("cache-s1", items, toolRuns, "/w");
		expect(turnsLib.turnsProbe.builds - buildsBefore).toBe(1);
		expect(second).toBe(first);
	});

	it("② a changed items/toolRuns reference (or cwd) rebuilds and refreshes the cache", () => {
		const items = [user, reply];
		const toolRuns = {};
		const buildsBefore = turnsLib.turnsProbe.builds;
		const first = computeTurns("cache-s2", items, toolRuns, "/w");
		const grown = [...items, assistant([{ type: "text", text: "more" }])];
		const afterItems = computeTurns("cache-s2", grown, toolRuns, "/w");
		expect(turnsLib.turnsProbe.builds - buildsBefore).toBe(2);
		expect(afterItems).not.toBe(first);
		const servedAgain = computeTurns("cache-s2", grown, toolRuns, "/w");
		expect(servedAgain).toBe(afterItems);
		expect(turnsLib.turnsProbe.builds - buildsBefore).toBe(2);
		const afterRuns = computeTurns("cache-s2", grown, { t1: { status: "running" } }, "/w");
		expect(turnsLib.turnsProbe.builds - buildsBefore).toBe(3);
		const afterCwd = computeTurns("cache-s2", grown, { t1: { status: "running" } }, "/other");
		expect(turnsLib.turnsProbe.builds - buildsBefore).toBe(4);
		expect(afterCwd).not.toBe(afterRuns);
	});

	it("② items reference change alone misses even when the array content is identical", () => {
		const items = [user, reply];
		const toolRuns = {};
		computeTurns("cache-s3", items, toolRuns, "/w");
		const buildsBefore = turnsLib.turnsProbe.builds;
		expect(turnsLib.cachedTurns(cacheStore.getTurnsCache("cache-s3"), [...items], toolRuns, "/w")).toBeNull();
		expect(turnsLib.turnsProbe.builds - buildsBefore).toBe(0);
		expect(turnsLib.cachedTurns(cacheStore.getTurnsCache("cache-s3"), items, toolRuns, "/w")).not.toBeNull();
	});

	it("③ exceeding the cap evicts the least recently used sessions first", () => {
		const cap = cacheStore.TURNS_CACHE_MAX as number;
		expect(cap).toBe(16);
		// Start from a clean cap: drop the entries the earlier cases in this block left behind.
		for (const slot of ["cache-s1", "cache-s2", "cache-s3"]) cacheStore.setTurnsCache(null, slot);
		const items = [user, reply];
		for (let i = 1; i <= cap + 1; i += 1) {
			const slot = `cache-lru-s${i}`;
			cacheStore.setTurnsCache({ items, toolRuns: {}, cwd: "/w", turns: [slot] }, slot);
		}
		// The oldest (s1) lost its entry; everything newer still has it. One entry per session, never the active session's fresh write.
		expect(cacheStore.getTurnsCache("cache-lru-s1")).toBeNull();
		for (let i = 2; i <= cap + 1; i += 1) expect(cacheStore.getTurnsCache(`cache-lru-s${i}`)).not.toBeNull();
		// Touch s2 so it becomes the most recent, then add another session: s3 is the new oldest and must lose its entry.
		cacheStore.getTurnsCache("cache-lru-s2");
		cacheStore.setTurnsCache({ items, toolRuns: {}, cwd: "/w", turns: ["extra"] }, "cache-lru-extra");
		expect(cacheStore.getTurnsCache("cache-lru-s3")).toBeNull();
		expect(cacheStore.getTurnsCache("cache-lru-s2")).not.toBeNull();
		expect(cacheStore.getTurnsCache("cache-lru-extra")).not.toBeNull();
		// Writing null clears one session's entry without touching the cap.
		cacheStore.setTurnsCache(null, "cache-lru-s4");
		expect(cacheStore.getTurnsCache("cache-lru-s4")).toBeNull();
	});
});

describe("Web UI: paged transcript client (store.js loadTranscript/fetchMoreTranscript, W175)", () => {
	let pageStore: {
		loadTranscript: (slot: string, options?: { limit?: number }) => Promise<unknown>;
		refreshSlot: (slot: string, options?: { full?: boolean }) => Promise<void>;
		fetchMoreTranscript: (slot: string) => Promise<string>;
		appendStreamedItem: (item: unknown, slot?: string) => void;
		addPendingMessage: (clientMessageId: string, text: string, images?: unknown[], slot?: string) => void;
		inSlot: <T>(slot: string, run: () => T) => T;
		state: Record<string, unknown>;
		TRANSCRIPT_FIRST_PAGE: number;
	};
	let fetchCalls: { url: string; slot: string | null }[];
	let handler: ((url: string) => unknown | Promise<unknown>) | null;
	let realFetch: unknown;

	const tItem = (id: string) => ({ kind: "user", id, ts: 1, text: `msg ${id}`, images: [] });
	const range = (from: number, to: number) => {
		const out: ReturnType<typeof tItem>[] = [];
		for (let i = from; i < to; i += 1) out.push(tItem(`w175-${i}`));
		return out;
	};
	const bagState = (slot: string) =>
		pageStore.inSlot(slot, () => ({
			items: pageStore.state.items as { id?: string }[],
			hasMore: pageStore.state.transcriptHasMore as boolean,
			cursor: pageStore.state.transcriptCursor as string | null,
			fetching: pageStore.state.transcriptFetching as boolean,
		}));

	beforeAll(async () => {
		pageStore = await import(new URL("store.js", webDir).href);
	});

	beforeEach(() => {
		fetchCalls = [];
		handler = null;
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
			fetchCalls.push({ url: String(url), slot: init?.headers?.["x-myharness-slot"] ?? null });
			if (!handler) throw new Error("no fetch handler");
			const body = await handler(String(url));
			return new Response(JSON.stringify(body), { status: 200 });
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch as typeof fetch;
		handler = null;
	});

	it("① the first screen passes limit=400 and keeps the paging cursor", async () => {
		expect(pageStore.TRANSCRIPT_FIRST_PAGE).toBe(400);
		handler = (url: string) => {
			expect(url).toBe(`/api/transcript?images=ref&limit=${pageStore.TRANSCRIPT_FIRST_PAGE}`);
			return { items: range(60, 100), hasMore: true, nextCursor: "w175-60" };
		};
		await pageStore.loadTranscript("page-s1", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		expect(fetchCalls).toEqual([
			{ url: `/api/transcript?images=ref&limit=${pageStore.TRANSCRIPT_FIRST_PAGE}`, slot: "page-s1" },
		]);
		const bag = bagState("page-s1");
		expect(bag.items.map((entry) => entry.id)).toEqual(range(60, 100).map((entry) => entry.id));
		expect(bag.hasMore).toBe(true);
		expect(bag.cursor).toBe("w175-60");
		expect(bag.fetching).toBe(false);
	});

	it("keeps a message sent during compaction on screen across the reload, and drops it once the server has it", async () => {
		handler = () => ({ items: range(0, 3) });
		await pageStore.loadTranscript("page-compact");
		pageStore.addPendingMessage("client-1", "sent while compacting", [], "page-compact");
		// compaction_end reloads the transcript before the server has taken the message.
		handler = () => ({ items: [...range(0, 2), { kind: "compaction", id: "c1", ts: 5 }] });
		await pageStore.loadTranscript("page-compact");
		const during = bagState("page-compact").items as { kind?: string; text?: string; pending?: boolean }[];
		expect(during.map((entry) => entry.kind)).toEqual(["user", "user", "compaction", "user"]);
		expect(during.at(-1)).toMatchObject({ pending: true, text: "sent while compacting" });
		// Once the server holds it, a reload shows it exactly once.
		handler = () => ({
			items: [
				...range(0, 2),
				{ kind: "compaction", id: "c1", ts: 5 },
				{ kind: "user", id: "u9", ts: Date.now(), text: "sent while compacting", images: [] },
			],
		});
		await pageStore.loadTranscript("page-compact");
		const after = bagState("page-compact").items as { text?: string; pending?: boolean }[];
		const copies = after.filter((entry) => entry.text === "sent while compacting");
		expect(copies).toHaveLength(1);
		expect(copies[0].pending).toBeUndefined();
	});

	it("② the default load stays full (no query) and reads as complete", async () => {
		handler = (url: string) => {
			expect(url).toBe("/api/transcript?images=ref");
			return { items: range(0, 10) };
		};
		await pageStore.loadTranscript("page-s2");
		const bag = bagState("page-s2");
		expect(bag.items).toHaveLength(10);
		expect(bag.hasMore).toBe(false);
		expect(bag.cursor).toBeNull();
	});

	it("③ an old server (no paging fields) reads as complete even when limit was sent", async () => {
		handler = () => ({ items: range(0, 5) });
		await pageStore.loadTranscript("page-s3", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		const bag = bagState("page-s3");
		expect(bag.items).toHaveLength(5);
		expect(bag.hasMore).toBe(false);
		expect(bag.cursor).toBeNull();
	});

	it("④ fetch-more prepends with dedupe, merges tool runs and moves the cursor", async () => {
		handler = () => ({ items: range(60, 100), hasMore: true, nextCursor: "w175-60" });
		await pageStore.loadTranscript("page-s4", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		handler = (url: string) => {
			expect(url).toBe("/api/transcript?images=ref&limit=400&before=w175-60");
			// Five entries overlap the window head (a tolerant server resent the boundary); the rest is older.
			return {
				items: [
					...range(60, 65),
					...range(20, 60),
					{
						kind: "toolResult",
						id: "w175-t1",
						ts: 1,
						toolCallId: "c-old",
						toolName: "ls",
						text: "x",
						images: [],
						isError: false,
					},
				],
				hasMore: true,
				nextCursor: "w175-60",
			};
		};
		const result = await pageStore.fetchMoreTranscript("page-s4");
		expect(result).toBe("ok");
		const bag = bagState("page-s4");
		const ids = bag.items.map((entry) => entry.id);
		expect(ids).toHaveLength(40 + 40 + 1);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice(0, 40)).toEqual(range(20, 60).map((entry) => entry.id));
		expect(ids.slice(-40)).toEqual(range(60, 100).map((entry) => entry.id));
		expect(bag.hasMore).toBe(true);
		expect(bag.cursor).toBe("w175-60");
		const runs = pageStore.inSlot("page-s4", () => pageStore.state.toolRuns as Record<string, { status: string }>);
		expect(runs["c-old"]).toMatchObject({ status: "done" });
		// The server-sent tool run must not overwrite a newer live state for the same call id.
		handler = () => ({ items: range(0, 20), hasMore: false, nextCursor: null });
		await pageStore.fetchMoreTranscript("page-s4");
		expect(bagState("page-s4").hasMore).toBe(false);
		expect(bagState("page-s4").cursor).toBeNull();
		const callsBefore = fetchCalls.length;
		expect(await pageStore.fetchMoreTranscript("page-s4")).toBe("done");
		expect(fetchCalls.length).toBe(callsBefore);
	});

	it("⑤ a reload in flight drops the older page as stale", async () => {
		handler = () => ({ items: range(60, 100), hasMore: true, nextCursor: "w175-60" });
		await pageStore.loadTranscript("page-s5", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		let release!: (body: unknown) => void;
		handler = () =>
			new Promise<unknown>((resolve) => {
				release = resolve;
			});
		const fetching = pageStore.fetchMoreTranscript("page-s5");
		handler = () => ({ items: range(0, 100) });
		await pageStore.loadTranscript("page-s5");
		release({ items: range(20, 60), hasMore: true, nextCursor: "w175-20" });
		expect(await fetching).toBe("stale");
		const bag = bagState("page-s5");
		expect(bag.items.map((entry) => entry.id)).toEqual(range(0, 100).map((entry) => entry.id));
		expect(bag.hasMore).toBe(false);
	});

	it("⑥ a second fetch-more while one is in flight sends no second request", async () => {
		handler = () => ({ items: range(60, 100), hasMore: true, nextCursor: "w175-60" });
		await pageStore.loadTranscript("page-s6", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		let release!: (body: unknown) => void;
		handler = () =>
			new Promise<unknown>((resolve) => {
				release = resolve;
			});
		const first = pageStore.fetchMoreTranscript("page-s6");
		expect(await pageStore.fetchMoreTranscript("page-s6")).toBe("fetching");
		expect(fetchCalls.filter((call) => call.url.includes("before="))).toHaveLength(1);
		release({ items: range(20, 60), hasMore: false, nextCursor: null });
		expect(await first).toBe("ok");
		expect(bagState("page-s6").items).toHaveLength(80);
	});

	it("⑦ a fully duplicated page falls back to one full reload", async () => {
		handler = () => ({ items: range(60, 100), hasMore: true, nextCursor: "w175-60" });
		await pageStore.loadTranscript("page-s7", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		handler = (url: string) =>
			url.includes("before=")
				? { items: range(60, 100), hasMore: true, nextCursor: "w175-60" }
				: { items: range(0, 100) };
		expect(await pageStore.fetchMoreTranscript("page-s7")).toBe("refreshed");
		expect(fetchCalls.some((call) => call.url === "/api/transcript?images=ref")).toBe(true);
		const bag = bagState("page-s7");
		expect(bag.items).toHaveLength(100);
		expect(bag.hasMore).toBe(false);
	});

	it("⑧ two failures in a row for one cursor fall back to one full reload", async () => {
		handler = () => ({ items: range(60, 100), hasMore: true, nextCursor: "w175-60" });
		await pageStore.loadTranscript("page-s8", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		let failures = 0;
		handler = (url: string) => {
			if (url.includes("before=") && failures < 2) {
				failures += 1;
				throw new Error("network down");
			}
			return { items: range(0, 100) };
		};
		expect(await pageStore.fetchMoreTranscript("page-s8")).toBe("error");
		expect(bagState("page-s8").hasMore).toBe(true);
		expect(await pageStore.fetchMoreTranscript("page-s8")).toBe("refreshed");
		expect(fetchCalls.some((call) => call.url === "/api/transcript?images=ref")).toBe(true);
		expect(bagState("page-s8").items).toHaveLength(100);
		expect(bagState("page-s8").hasMore).toBe(false);
	});

	it("⑨ streamed output during a fetch drops the page for a full reload", async () => {
		handler = () => ({ items: range(60, 100), hasMore: true, nextCursor: "w175-60" });
		await pageStore.loadTranscript("page-s9", { limit: pageStore.TRANSCRIPT_FIRST_PAGE });
		let release!: (body: unknown) => void;
		handler = (url: string) =>
			url.includes("before=")
				? new Promise<unknown>((resolve) => {
						release = resolve;
					})
				: { items: range(0, 101) };
		const fetching = pageStore.fetchMoreTranscript("page-s9");
		pageStore.appendStreamedItem(tItem("w175-live"), "page-s9");
		release({ items: range(20, 60), hasMore: false, nextCursor: null });
		expect(await fetching).toBe("refreshed");
		expect(fetchCalls.some((call) => call.url === "/api/transcript?images=ref")).toBe(true);
		expect(bagState("page-s9").items).toHaveLength(101);
	});

	it("⑩ refreshSlot pages by default and loads fully when asked", async () => {
		const seen: string[] = [];
		handler = (url: string) => {
			seen.push(url);
			if (url.startsWith("/api/transcript")) return { items: range(0, 3), hasMore: false, nextCursor: null };
			return {
				slot: "page-s10",
				flags: {},
				session: {},
				thinking: {},
				queue: { steering: [], followUp: [] },
				dialogs: [],
				surface: {},
			};
		};
		await pageStore.refreshSlot("page-s10");
		expect(seen).toContain(`/api/transcript?images=ref&limit=${pageStore.TRANSCRIPT_FIRST_PAGE}`);
		seen.length = 0;
		await pageStore.refreshSlot("page-s10b", { full: true });
		expect(seen).toContain("/api/transcript?images=ref");
		expect(seen.some((url) => url.includes("limit="))).toBe(false);
	});
});

describe("Web UI: failed-turn text folds to its first sentence", () => {
	it("shows the cause of an explained provider error and keeps the advice and raw text for Details", () => {
		const cause = "模型请求失败：模型服务暂时不可用（网关返回 503）。";
		const advice = "这通常是服务商一侧的临时故障。请稍后再试。";
		const raw = "原始信息：503 Service Unavailable";
		const [lead, rest] = splitFirstSentence(`${cause}${advice}\n${raw}`);
		expect(lead).toBe(cause);
		expect(rest).toBe(`${advice}\n${raw}`);
		// Nothing is dropped: the two parts hold the whole text.
		expect(lead + rest).toBe(`${cause}${advice}\n${raw}`);
	});

	it("splits English sentences and line breaks, and leaves one-sentence text whole", () => {
		expect(splitFirstSentence("Failed. Try again later.")).toEqual(["Failed.", "Try again later."]);
		expect(splitFirstSentence("Request failed: 500\nbody")).toEqual(["Request failed: 500", "body"]);
		expect(splitFirstSentence("Connection error.")).toEqual(["Connection error.", ""]);
		expect(splitFirstSentence("terminated")).toEqual(["terminated", ""]);
		expect(splitFirstSentence("v1.2 failed")).toEqual(["v1.2 failed", ""]);
		expect(splitFirstSentence("\nonly a second line")).toEqual(["\nonly a second line", ""]);
		expect(splitFirstSentence(undefined)).toEqual(["", ""]);
	});
});
