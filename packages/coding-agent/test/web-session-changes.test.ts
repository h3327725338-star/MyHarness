import { describe, expect, it } from "vitest";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import { collectSessionChanges } from "../src/modes/web/session-changes.ts";
import type { SessionEntry } from "../src/session/types.ts";

function card(id: string, runId: number, files: unknown[]): Extract<SessionEntry, { type: "custom" }> {
	return {
		type: "custom",
		customType: "web-run-changes",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		data: { runId, files },
	};
}
const file = (path: string, patch: string, additions = 1) => ({
	path,
	status: "modified",
	additions,
	deletions: 1,
	binary: false,
	patch,
});

describe("conversation change review", () => {
	it("restores all saved edits, deduplicates paths and keeps diffs separate even when run IDs repeat", () => {
		const entries = [
			card("a", 1, [file("a.ts", "first")]),
			card("b", 1, [file("a.ts", "second", 2), file("b.ts", "third")]),
		];
		const restored = collectSessionChanges(JSON.parse(JSON.stringify(entries)));
		expect(restored.files).toHaveLength(2);
		expect(restored.files[0]).toMatchObject({ path: "a.ts", additions: 3, deletions: 2 });
		expect(restored.diffs.get("a.ts")?.map((part) => [part.entryId, part.patch])).toEqual([
			["a", "first"],
			["b", "second"],
		]);
		// A later read-only turn has no change card and must not replace the history.
		expect(collectSessionChanges([...entries, { ...card("question", 2, []), customType: "other" }]).files).toEqual(
			restored.files,
		);
	});
	it("handles missing or malformed old cards without inventing changes, and marks omitted diffs", () => {
		expect(collectSessionChanges([card("empty", 1, [null, {}])]).files).toEqual([]);
		const result = collectSessionChanges([card("large", 1, [{ ...file("a.ts", "not saved"), patchOmitted: true }])]);
		expect(result.files[0].unavailable).toContain("too large");
		expect(result.diffs.get("a.ts")?.[0].patch).toBeUndefined();
	});
	it("serves persisted conversation records with no live tracker after restart, and isolates the selected branch", async () => {
		let branch = [card("saved", 9, [file("a.ts", "saved diff")])];
		const routes = new Map<string, (context: { url: URL }) => unknown>();
		registerFileRoutes(
			{
				route: (_method: string, route: string, handler: (context: { url: URL }) => unknown) =>
					routes.set(route, handler),
			} as never,
			{ session: { sessionManager: { getBranch: () => branch } } } as never,
		);
		const request = (route: string, query: string) =>
			routes.get(route)!({ url: new URL(`http://localhost${route}?${query}`) });
		expect(await request("/api/changes", "scope=session")).toMatchObject({
			scope: "session",
			total: 1,
			files: [{ path: "a.ts" }],
		});
		expect(await request("/api/changes/diff", "scope=session&path=a.ts")).toMatchObject({
			history: [{ entryId: "saved", patch: "saved diff" }],
		});
		branch = [];
		expect(await request("/api/changes", "scope=session")).toMatchObject({ total: 0, files: [] });
		await expect(request("/api/changes/diff", "scope=session&path=a.ts")).rejects.toThrow("No such change");
	});
});
