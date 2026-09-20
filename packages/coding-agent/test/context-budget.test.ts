import type { AssistantMessage } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/context/compact/index.ts";
import {
	ContextBudgetBlockedError,
	computeContextBudgetSnapshot,
	estimateActiveContextTokensCanonical,
	resolveContextRuntimePolicy,
} from "../src/context/context-budget.ts";
import { getCompactionSettingsForContextWindow } from "../src/context/context-window.ts";

function assistant(partial: {
	timestamp: number;
	content?: string;
	input?: number;
	output?: number;
	totalTokens?: number;
	stopReason?: "stop" | "error" | "aborted";
}): AssistantMessage {
	const input = partial.input ?? 100;
	const output = partial.output ?? 50;
	return {
		role: "assistant",
		content: [{ type: "text", text: partial.content ?? "response" }],
		api: "anthropic-messages",
		provider: "faux",
		model: "test",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: partial.totalTokens ?? input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: partial.stopReason ?? "stop",
		timestamp: partial.timestamp,
	};
}

function user(text: string, timestamp: number) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
}

function toolResult(text: string, timestamp: number) {
	return {
		role: "toolResult" as const,
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp,
	};
}

const SYSTEM = "You are a test assistant.";

describe("estimateActiveContextTokensCanonical", () => {
	it("uses a valid provider usage anchor plus trailing messages", () => {
		const messages = [
			user("hello", 1000),
			assistant({ timestamp: 2000, input: 180_000, output: 0, totalTokens: 180_000 }),
			toolResult("x".repeat(160_000), 3000),
		];
		const estimate = estimateActiveContextTokensCanonical(messages, { systemPrompt: SYSTEM, tools: [] });
		expect(estimate.usageSource).toBe("provider-anchor");
		expect(estimate.anchorIndex).toBe(1);
		expect(estimate.anchorTokens).toBe(180_000);
		// trailing toolResult ≈ 40k tokens (chars/4)
		expect(estimate.trailingTokens).toBe(40_000);
		expect(estimate.tokens).toBe(220_000);
	});

	it("ignores a pre-compaction usage anchor and falls back to a full estimate", () => {
		const messages = [
			assistant({ timestamp: 1000, input: 220_000, output: 0, totalTokens: 220_000 }),
			toolResult("y".repeat(40_000), 2000),
		];
		const estimate = estimateActiveContextTokensCanonical(messages, {
			systemPrompt: SYSTEM,
			tools: [],
			latestCompactionTimestamp: 1500,
		});
		expect(estimate.usageSource).toBe("post-compaction-estimated");
		expect(estimate.anchorIndex).toBeNull();
		// The stale 220k anchor must not be adopted; the estimate is the small
		// full-context value of the messages themselves.
		expect(estimate.tokens).toBeGreaterThan(0);
		expect(estimate.tokens).toBeLessThan(220_000);
	});

	it("estimates the full context when no provider anchor exists", () => {
		const messages = [user("a".repeat(100_000), 1000)];
		const estimate = estimateActiveContextTokensCanonical(messages, { systemPrompt: SYSTEM, tools: [] });
		expect(estimate.usageSource).toBe("estimated");
		expect(estimate.anchorIndex).toBeNull();
		// system prompt + 100k chars /4
		expect(estimate.tokens).toBeGreaterThanOrEqual(25_000);
	});

	it("does not anchor on aborted or error assistant messages", () => {
		const messages = [
			assistant({ timestamp: 1000, input: 0, output: 0, totalTokens: 0, stopReason: "error" }),
			user("b".repeat(40_000), 2000),
		];
		const estimate = estimateActiveContextTokensCanonical(messages, { systemPrompt: SYSTEM, tools: [] });
		expect(estimate.usageSource).toBe("estimated");
		expect(estimate.anchorIndex).toBeNull();
	});
});

describe("resolveContextRuntimePolicy", () => {
	it("caps the configured window by the model metadata (min semantics)", () => {
		const policy = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: 512_000,
			modelWindow: 1_000_000,
			modelMaxOutput: 8192,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: false,
		});
		expect(policy.effectiveWindow).toBe(512_000);
		expect(policy.windowSource).toBe("min-configured-model");
		// reserve = max(16384, 15% of 512k, 8192+1024) = 76800
		expect(policy.reserveTokens).toBe(25_600);
		expect(policy.budgetLimit).toBe(512_000 - 25_600);
	});

	it("uses the CLI override and reports it as the window source", () => {
		const policy = resolveContextRuntimePolicy({
			role: "subagent",
			configuredContextWindow: 256_000,
			modelWindow: 1_000_000,
			modelMaxOutput: 8192,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: true,
		});
		expect(policy.effectiveWindow).toBe(256_000);
		expect(policy.windowSource).toBe("cli");
	});

	it("reports settings-only and model-only sources", () => {
		const settingsOnly = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: 128_000,
			modelWindow: 0,
			modelMaxOutput: 8192,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: false,
		});
		expect(settingsOnly.windowSource).toBe("settings");
		expect(settingsOnly.effectiveWindow).toBe(128_000);

		const modelOnly = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: undefined,
			modelWindow: 200_000,
			modelMaxOutput: 8192,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: false,
		});
		expect(modelOnly.windowSource).toBe("model");
		expect(modelOnly.effectiveWindow).toBe(200_000);
	});
});

describe("computeContextBudgetSnapshot", () => {
	const policy = resolveContextRuntimePolicy({
		role: "main",
		configuredContextWindow: 256_000,
		modelWindow: 256_000,
		modelMaxOutput: 16_384,
		compactionSettings: DEFAULT_COMPACTION_SETTINGS,
		autoCompactEnabled: true,
		configuredViaCli: false,
	});
	// 15% of 256k = 38400 ; maxTokens+1024 = 17408 ; base 16384 → reserve 38400 → limit 217600
	expect(policy.reserveTokens).toBe(12_800);
	expect(policy.budgetLimit).toBe(243_200);

	it("is not over budget below the limit", () => {
		const snapshot = computeContextBudgetSnapshot(policy, {
			tokens: 200_000,
			usageSource: "provider-anchor",
			anchorIndex: 1,
		});
		expect(snapshot.overBudget).toBe(false);
		expect(snapshot.percent).toBeCloseTo(78.125, 1);
	});

	it("uses >= semantics at the budget limit (boundary)", () => {
		const atLimit = computeContextBudgetSnapshot(policy, {
			tokens: policy.budgetLimit,
			usageSource: "provider-anchor",
			anchorIndex: 1,
		});
		expect(atLimit.overBudget).toBe(true);
	});

	it("reports over budget and an unclamped percent past the window", () => {
		const over = computeContextBudgetSnapshot(policy, {
			tokens: 274_000,
			usageSource: "provider-anchor",
			anchorIndex: 1,
		});
		expect(over.overBudget).toBe(true);
		expect(over.percent).toBe(107.03125);
		expect(over.percent).toBeGreaterThan(100);
	});

	it("carries the auto-compact flag and usage source", () => {
		const disabled = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: 256_000,
			modelWindow: 256_000,
			modelMaxOutput: 16_384,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: false,
			configuredViaCli: false,
		});
		const snapshot = computeContextBudgetSnapshot(disabled, {
			tokens: 230_000,
			usageSource: "provider-anchor",
			anchorIndex: 1,
		});
		expect(snapshot.autoCompactEnabled).toBe(false);
		expect(snapshot.overBudget).toBe(false);
	});
});

describe("normal auto-compact threshold (90% of the raw effective window)", () => {
	const effective = 131072;
	const threshold = Math.floor(effective * 0.9);

	function policyWith(maxOutput: number) {
		return resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: effective,
			modelWindow: effective,
			modelMaxOutput: maxOutput,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: false,
		});
	}

	function snapshotFor(tokens: number, maxOutput = 16_384) {
		return computeContextBudgetSnapshot(policyWith(maxOutput), {
			tokens,
			usageSource: "estimated",
			anchorIndex: null,
		});
	}

	it("triggers exactly at 90% and never below", () => {
		expect(threshold).toBe(117_964);
		expect(snapshotFor(Math.floor(effective * 0.84)).shouldAutoCompact).toBe(false); // 84.0%
		expect(snapshotFor(Math.floor(effective * 0.849)).shouldAutoCompact).toBe(false); // 84.9%
		expect(snapshotFor(threshold).shouldAutoCompact).toBe(true); // 85.0%
		expect(snapshotFor(Math.floor(effective * 0.91)).shouldAutoCompact).toBe(true); // 86%
		expect(snapshotFor(Math.floor(effective * 0.99)).shouldAutoCompact).toBe(true); // 99%
	});

	it("is independent of model.maxTokens", () => {
		for (const maxOutput of [4 * 1024, 16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024]) {
			const policy = policyWith(maxOutput);
			expect(policy.autoCompactThresholdTokens).toBe(threshold);
			const snapshot = computeContextBudgetSnapshot(policy, {
				tokens: threshold,
				usageSource: "estimated",
				anchorIndex: null,
			});
			expect(snapshot.shouldAutoCompact).toBe(true);
			// The provider hard gate may be stricter, never looser than 90%.
			expect(snapshot.budgetLimit).toBeGreaterThanOrEqual(threshold);
		}
	});

	it("scales across all built-in window presets", () => {
		for (const window of [32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024]) {
			const policy = resolveContextRuntimePolicy({
				role: "main",
				configuredContextWindow: window,
				modelWindow: window,
				modelMaxOutput: 16_384,
				compactionSettings: DEFAULT_COMPACTION_SETTINGS,
				autoCompactEnabled: true,
				configuredViaCli: false,
			});
			expect(policy.autoCompactThresholdTokens).toBe(Math.floor(window * 0.9));
		}
	});

	it("keeps raw token math for the 512K preset while the UI may show 512K", () => {
		const policy = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: 524_288,
			modelWindow: 524_288,
			modelMaxOutput: 16_384,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: false,
		});
		expect(policy.autoCompactThresholdTokens).toBe(471_859); // floor(524288 * 0.9)
		const snapshot = computeContextBudgetSnapshot(policy, {
			tokens: 124_780,
			usageSource: "estimated",
			anchorIndex: null,
		});
		expect(snapshot.percent).toBeCloseTo((124_780 / 524_288) * 100, 10);
		expect(snapshot.shouldAutoCompact).toBe(false);
	});
});

describe("ContextBudgetBlockedError", () => {
	it("carries a structured reason and a readable, budget-oriented message", () => {
		const policy = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: 256_000,
			modelWindow: 256_000,
			modelMaxOutput: 16_384,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: false,
			configuredViaCli: false,
		});
		const snapshot = computeContextBudgetSnapshot(policy, {
			tokens: 230_000,
			usageSource: "provider-anchor",
			anchorIndex: 1,
		});
		const error = new ContextBudgetBlockedError("auto-compact-disabled", snapshot);
		expect(error.name).toBe("ContextBudgetBlockedError");
		expect(error.reason).toBe("auto-compact-disabled");
		expect(error.snapshot).toBe(snapshot);
		expect(error.message).toContain("safe budget");
		expect(error.message).toContain("Auto Compact is disabled");
	});

	it("maps every blocked reason to a message that mentions the safe budget", () => {
		const policy = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: 256_000,
			modelWindow: 256_000,
			modelMaxOutput: 16_384,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: false,
		});
		const snapshot = computeContextBudgetSnapshot(policy, {
			tokens: 230_000,
			usageSource: "provider-anchor",
			anchorIndex: 1,
		});
		const reasons = [
			"auto-compact-disabled",
			"nothing-to-compact",
			"compaction-failed",
			"compaction-cancelled",
			"compaction-in-progress",
			"compaction-unchanged",
			"still-over-budget",
		] as const;
		for (const reason of reasons) {
			const error = new ContextBudgetBlockedError(reason, snapshot);
			expect(error.message).toContain("safe budget");
		}
	});
});

// Keep a direct reference to the reserve resolver so the test fails loudly if
// the runtime reserve algorithm drifts from what the snapshot policy uses.
describe("runtime reserve consistency", () => {
	it("uses the same dynamically computed reserve as getCompactionSettingsForContextWindow", () => {
		const configured = getCompactionSettingsForContextWindow(DEFAULT_COMPACTION_SETTINGS, 256_000, 16_384);
		const policy = resolveContextRuntimePolicy({
			role: "main",
			configuredContextWindow: 256_000,
			modelWindow: 256_000,
			modelMaxOutput: 16_384,
			compactionSettings: DEFAULT_COMPACTION_SETTINGS,
			autoCompactEnabled: true,
			configuredViaCli: false,
		});
		expect(policy.reserveTokens).toBe(configured.reserveTokens);
		expect(policy.reserveTokens).toBe(12_800);
	});
});
