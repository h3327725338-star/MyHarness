/**
 * A commit that repairs its own pre-commit failures runs one round at a time, each round announced by a hidden
 * `git-commit-repair` message. Every round keeps its own card, and a card that has no outcome of its own must not
 * look like it is still working.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The Web UI is plain ES modules; its components are testable directly, like web-transcript-preview.test.ts does.
// Components stay unmounted references, so a tree records which of them the strip asked for.
const named = (mockName: string) => Object.assign(() => null, { mockName });
vi.mock("../web/js/ui.js", () => ({
	html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		type: "vnode",
		strings: Array.from(strings),
		values,
	}),
	Icon: named("icon"),
	Spinner: named("spinner"),
	Collapse: named("collapse"),
	useState: (init: unknown) => [init, () => {}],
}));
vi.mock("../web/js/actions.js", () => ({ actions: { send: () => {} } }));
vi.mock("../web/js/store.js", () => ({ post: () => Promise.resolve({}) }));
vi.mock("/vendor/preact-hooks.js", () => ({
	useLayoutEffect: () => {},
	useRef: (init: unknown) => ({ current: init }),
	useState: (init: unknown) => [init, () => {}],
}));

const webDir = new URL("../web/js/", import.meta.url);
const { buildTurns } = await import(new URL("turns.js", webDir).href);
const { GitRecord } = await import(new URL("git-record.js", webDir).href);
const lang = await import(new URL("lang.js", webDir).href);

const ctx = { toolRuns: {}, cwd: "/w" };
const repairMessage = (round: number) => ({
	kind: "custom",
	customType: "git-commit-repair",
	display: false,
	id: `repair-${round}`,
	ts: round * 100,
});
const repairAnswer = (round: number) => ({
	kind: "assistant",
	id: `answer-${round}`,
	ts: round * 100 + 1,
	model: "m",
	stopReason: "stop",
	final: `round ${round} done`,
	blocks: [{ type: "text", text: `round ${round} done` }],
});
const commitRecord = {
	kind: "gitStatus",
	id: "commit-1",
	ts: 999,
	result: { tone: "ok", title: "Commit succeeded", hash: "abc1234", detail: "feat: x", lines: "feat: x" },
};

type Node = unknown;
/** The part of a built turn these tests read; `turns.js` is plain JavaScript, so the shape is declared here. */
type RepairTurn = { standalone?: { kind?: string } };
/** Every component type and every piece of text a rendered tree contains. */
function inspect(node: Node, out: { types: string[]; text: string } = { types: [], text: "" }): typeof out {
	if (node == null) return out;
	if (Array.isArray(node)) {
		for (const child of node) inspect(child, out);
		return out;
	}
	if (typeof node !== "object") return out;
	const value = node as { type?: unknown; strings?: unknown; values?: unknown; children?: unknown };
	if (value.type === "vnode") {
		out.text += (value.strings as string[]).join("");
		for (const child of (value.values as Node[]) ?? []) {
			if (typeof child === "string" || typeof child === "number") out.text += String(child);
			if (typeof child === "function" && "mockName" in child) out.types.push(String(child.mockName));
			inspect(child, out);
		}
		return out;
	}
	if (typeof value.type === "string") {
		out.types.push(value.type);
		inspect(value.children as Node, out);
	}
	return out;
}

describe("Web UI: a commit's repair rounds", () => {
	beforeEach(() => {
		lang.setLang("en");
	});

	it("keeps every round on its own card with the steps that round ran", () => {
		const turns = buildTurns([repairMessage(1), repairAnswer(1), repairMessage(2), repairAnswer(2)], ctx);
		const cards = turns.filter((turn: RepairTurn) => turn.standalone?.kind === "gitRepair");
		expect(cards).toHaveLength(2);
		expect(cards[0].standalone.turns).toHaveLength(1);
		expect(cards[0].standalone.turns[0].final?.text).toBe("round 1 done");
		expect(cards[1].standalone.turns).toHaveLength(1);
		expect(cards[1].standalone.turns[0].final?.text).toBe("round 2 done");
	});

	it("lets the commit's own record close the last round and leaves earlier rounds intact", () => {
		const turns = buildTurns(
			[repairMessage(1), repairAnswer(1), repairMessage(2), repairAnswer(2), commitRecord],
			ctx,
		);
		expect(turns[0].standalone?.kind).toBe("gitRepair");
		expect(turns[0].standalone?.turns?.[0]?.final?.text).toBe("round 1 done");
		const record = turns[1].standalone;
		expect(record?.kind).toBe("gitStatus");
		expect(record?.result?.hash).toBe("abc1234");
		expect(record?.repairTurns?.[0]?.final?.text).toBe("round 2 done");
	});

	it("stops a round that has no outcome of its own instead of showing it as still working", () => {
		const finished = inspect(GitRecord({ result: undefined, task: undefined, children: null, activity: undefined }));
		expect(finished.types).not.toContain("spinner");
		expect(finished.text).toContain("Repair finished");

		const running = inspect(GitRecord({ result: undefined, task: { activity: "Repairing (2/3)" }, children: null }));
		expect(running.types).toContain("spinner");
	});

	it("says the same thing in Chinese", () => {
		lang.setLang("zh-CN");
		const finished = inspect(GitRecord({ result: undefined, task: undefined, children: null }));
		expect(finished.text).toContain("修复已结束");
		lang.setLang("en");
	});
});
