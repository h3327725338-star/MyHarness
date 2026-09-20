import { fauxAssistantMessage, type Model } from "@myharness/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compact, DEFAULT_COMPACTION_SETTINGS } from "../src/context/compact/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));
vi.mock("@myharness/ai/compat", async (original) => ({
	...(await original<typeof import("@myharness/ai/compat")>()),
	completeSimple: completeSimpleMock,
}));
const model: Model<"anthropic-messages"> = {
	id: "compact",
	name: "Compact",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const preparation = {
	firstKeptEntryId: "entry",
	messagesToSummarize: [{ role: "user" as const, content: "task", timestamp: 1 }],
	tokensBefore: 100,
	settings: DEFAULT_COMPACTION_SETTINGS,
};
describe("Compact thinking adapter", () => {
	beforeEach(() => completeSimpleMock.mockReset().mockResolvedValue(fauxAssistantMessage("summary")));
	it.each(["off", "medium"] as const)("passes supported effort %s without a summary output target", async (effort) => {
		const result = await compact(preparation, model, "key", undefined, undefined, undefined, effort);
		expect(result.summary).toBe("summary");
		expect(completeSimpleMock.mock.calls[0][2].reasoning).toBe(effort === "off" ? undefined : effort);
		expect(completeSimpleMock.mock.calls[0][2].maxTokens).toBeUndefined();
	});
	it("does not send effort to a non-reasoning model", async () => {
		await compact(preparation, { ...model, reasoning: false }, "key", undefined, undefined, undefined, "high");
		expect(completeSimpleMock.mock.calls[0][2].reasoning).toBeUndefined();
	});
	it("clamps effort to the configured model capabilities", async () => {
		await compact(
			preparation,
			{ ...model, thinkingLevelMap: { high: null, xhigh: null, max: null } },
			"key",
			undefined,
			undefined,
			undefined,
			"max",
		);
		expect(completeSimpleMock.mock.calls[0][2].reasoning).toBe("medium");
	});
	it("uses session base instructions, native history, and no tools", async () => {
		await compact(
			preparation,
			model,
			"key",
			undefined,
			"focus",
			undefined,
			"off",
			undefined,
			undefined,
			"session instructions",
		);
		const context = completeSimpleMock.mock.calls[0][1];
		expect(context.systemPrompt).toBe("session instructions");
		expect(context.tools).toBeUndefined();
		expect(context.messages).toHaveLength(2);
	});
});
