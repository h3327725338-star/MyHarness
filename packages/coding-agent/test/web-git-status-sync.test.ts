import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

it("ignores obsolete Git status responses independently for each Chat", async () => {
	const source = readFileSync(new URL("../web/js/store.js", import.meta.url), "utf8");
	const start = source.indexOf("const gitStatusRequests = new Map();");
	const code = source
		.slice(start, source.indexOf("\nexport async function refreshAll()", start))
		.replace("export ", "");
	const requests: { slot: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
	const counts = new Map<string, number | null>();
	let updatingSlot = "";
	const context = vm.createContext({
		targetSlot: null,
		activeSlot: "a",
		api: (_path: string, { slot }: { slot: string }) =>
			new Promise((resolve, reject) => requests.push({ slot, resolve, reject })),
		runFor: (slot: string, fn: () => void) => {
			updatingSlot = slot;
			fn();
		},
		set: ({ gitStatus }: { gitStatus: { preview: { total: number } } | null }) =>
			counts.set(updatingSlot, gitStatus?.preview.total ?? null),
	});
	vm.runInContext(code, context);
	const old = context.loadGitStatus();
	const latest = context.loadGitStatus();
	context.activeSlot = "b";
	const other = context.loadGitStatus();
	requests[1]!.resolve({ preview: { total: 0 } });
	await latest;
	requests[0]!.resolve({ preview: { total: 1 } });
	await old;
	expect(counts.get("a")).toBe(0);
	requests[2]!.resolve({ preview: { total: 3 } });
	await other;
	expect(counts.get("b")).toBe(3);
	const oldFailure = context.loadGitStatus();
	const newSuccess = context.loadGitStatus();
	requests[4]!.resolve({ preview: { total: 0 } });
	await newSuccess;
	requests[3]!.reject(new Error("old request failed"));
	await oldFailure;
	expect(counts.get("b")).toBe(0);
});
