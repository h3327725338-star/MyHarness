import { describe, expect, it } from "vitest";
import { rankByUsage } from "../src/providers/models/usage-ranking.ts";

describe("rankByUsage", () => {
	it("ranks higher usage first and preserves the original order for ties", () => {
		const items = [{ id: "settings" }, { id: "model" }, { id: "new" }, { id: "compact" }];

		expect(rankByUsage(items, (item) => item.id, { compact: 4, model: 2, settings: 2 })).toEqual([
			{ id: "compact" },
			{ id: "settings" },
			{ id: "model" },
			{ id: "new" },
		]);
	});

	it("does not mutate the original list", () => {
		const items = ["settings", "model", "new"];
		rankByUsage(items, (item) => item, { new: 3 });
		expect(items).toEqual(["settings", "model", "new"]);
	});
});
