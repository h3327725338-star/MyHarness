import type { AgentMessage } from "@myharness/agent-core";
import { describe, expect, it } from "vitest";
import { buildContextBreakdown } from "../src/context/context-breakdown.ts";
import type { ContextBudgetSnapshot } from "../src/context/context-budget.ts";

const budget: ContextBudgetSnapshot = {
	role: "main",
	configuredWindow: undefined,
	modelWindow: 200_000,
	effectiveWindow: 200_000,
	reserveTokens: 16_000,
	autoCompactThresholdTokens: 180_000,
	budgetLimit: 190_000,
	activeTokens: 40_000,
	percent: 20,
	overBudget: false,
	shouldAutoCompact: false,
	autoCompactEnabled: true,
	usageSource: "provider-anchor",
	windowSource: "model",
} as ContextBudgetSnapshot;

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;

describe("Web UI: context breakdown", () => {
	it("measures each category from the real inputs and leaves absent ones at zero", () => {
		const skillsText = "Skills: use the docs skill when asked about documentation. ".repeat(20);
		const projectText = "Project rule: keep answers short. ".repeat(30);
		const systemPrompt = `You are MyHarness. ${"Follow the rules. ".repeat(50)}${projectText}${skillsText}`;
		const result = buildContextBreakdown({
			budget,
			systemPrompt,
			contextFiles: [{ content: projectText }],
			skillsPromptText: skillsText,
			memoryPolicyText: "",
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
					extension: false,
				},
				{ name: "ext_tool", description: "From an extension", parameters: { type: "object" }, extension: true },
				{ name: "lazy", description: "Loaded on demand", parameters: { type: "object" }, extension: false },
			],
			deferredTools: ["lazy"],
			messages: [user("hello there, please read the file"), user("and summarise it")],
		});

		const byId = Object.fromEntries(result.categories.map((category) => [category.id, category]));
		expect(byId.systemPrompt.tokens).toBeGreaterThan(0);
		expect(byId.projectInstructions.tokens).toBeGreaterThan(0);
		expect(byId.projectInstructions.count).toBe(1);
		expect(byId.skills.tokens).toBeGreaterThan(0);
		expect(byId.memoryPolicy.tokens).toBe(0);
		expect(byId.builtinTools.count).toBe(1);
		expect(byId.extensionTools.count).toBe(1);
		expect(byId.userMessages.count).toBe(2);
		expect(byId.assistantMessages.tokens).toBe(0);
		expect(result.deferredTools).toEqual(["lazy"]);
		// Deferred tool definitions are not part of the request, so they are not counted.
		expect(result.topTools.map((tool) => tool.name)).not.toContain("lazy");
		expect(result.measured).toBe(result.categories.reduce((sum, category) => sum + category.tokens, 0));
	});

	it("takes used, window, reserve and remaining from the budget snapshot", () => {
		const result = buildContextBreakdown({
			budget,
			systemPrompt: "",
			contextFiles: [],
			skillsPromptText: "",
			memoryPolicyText: "",
			tools: [],
			messages: [],
		});
		expect(result).toMatchObject({ window: 200_000, used: 40_000, reserved: 16_000, percent: 20, free: 144_000 });
		expect(result.autoCompactEnabled).toBe(true);
	});

	it("never reports negative remaining space when the context is over the window", () => {
		const result = buildContextBreakdown({
			budget: { ...budget, activeTokens: 250_000, percent: 125 },
			systemPrompt: "",
			contextFiles: [],
			skillsPromptText: "",
			memoryPolicyText: "",
			tools: [],
			messages: [],
		});
		expect(result.free).toBe(0);
		expect(result.percent).toBe(125);
	});
});
