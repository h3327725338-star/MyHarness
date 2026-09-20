import type { AgentMessage } from "@myharness/agent-core";
import { describe, expect, it } from "vitest";
import {
	CONTEXT_WINDOW_PRESETS,
	estimateActiveContextTokens,
	formatContextWindow,
	getCompactionSettingsForContextWindow,
	MAX_CONTEXT_WINDOW_TOKENS,
	normalizeContextWindowSettings,
	parseContextWindowInput,
	resolveEffectiveContextWindow,
} from "../src/context/context-window.ts";

describe("context window policy", () => {
	it("uses binary units for the built-in presets", () => {
		expect(CONTEXT_WINDOW_PRESETS).toEqual([32768, 65536, 131072, 262144, 524288, 1048576]);
		expect(parseContextWindowInput("256K")).toEqual({ value: 262144 });
		expect(parseContextWindowInput("1M")).toEqual({ value: 1048576 });
	});

	it("accepts positive finite custom values and rejects invalid values", () => {
		expect(parseContextWindowInput(" 300K ")).toEqual({ value: 307200 });
		expect(parseContextWindowInput("0").value).toBeUndefined();
		expect(parseContextWindowInput("-1M").value).toBeUndefined();
		expect(parseContextWindowInput("NaN").value).toBeUndefined();
		expect(parseContextWindowInput(MAX_CONTEXT_WINDOW_TOKENS + 1).value).toBeUndefined();
	});

	it("ignores corrupted persisted values instead of throwing", () => {
		expect(normalizeContextWindowSettings({ main: "256K", subagent: -10, unrelated: "bad" })).toEqual({
			main: 262144,
		});
	});

	it("caps configured values by the model metadata", () => {
		expect(resolveEffectiveContextWindow(262144, 131072)).toBe(131072);
		expect(resolveEffectiveContextWindow(262144, 0)).toBe(262144);
		expect(resolveEffectiveContextWindow(undefined, 131072)).toBe(131072);
		expect(resolveEffectiveContextWindow(undefined, 0)).toBe(0);
	});

	it("uses the latest usage anchor and includes appended tool results", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "tool call" }],
				api: "anthropic-messages",
				provider: "test",
				model: "test",
				usage: {
					input: 108_600,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 108_600,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "tool output ".repeat(400) }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const estimate = estimateActiveContextTokens(messages, "system", []);
		expect(estimate.messageTokens).toBeGreaterThan(108_600);
		expect(estimate.tokens).toBeGreaterThanOrEqual(estimate.messageTokens);
	});

	it("applies min(configured, model) for every preset combination", () => {
		expect(resolveEffectiveContextWindow(256 * 1024, 128 * 1024)).toBe(128 * 1024);
		expect(resolveEffectiveContextWindow(128 * 1024, 256 * 1024)).toBe(128 * 1024);
		expect(resolveEffectiveContextWindow(undefined, 256 * 1024)).toBe(256 * 1024);
		expect(resolveEffectiveContextWindow(256 * 1024, undefined)).toBe(256 * 1024);
	});

	it("uses Codex usable-window headroom without a summary target", () => {
		const settings = getCompactionSettingsForContextWindow(
			{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			262144,
			16384,
		);
		expect(settings.reserveTokens).toBe(13108);
		expect(settings).not.toHaveProperty("targetRatio");
	});
});

describe("formatContextWindow", () => {
	it("formats binary presets with the K/M context-window formatter", () => {
		expect(formatContextWindow(32768)).toBe("32K");
		expect(formatContextWindow(65536)).toBe("64K");
		expect(formatContextWindow(131072)).toBe("128K");
		expect(formatContextWindow(262144)).toBe("256K");
		expect(formatContextWindow(524288)).toBe("512K");
		expect(formatContextWindow(1048576)).toBe("1M");
	});

	it("falls back to the raw number for non-binary values and unknown limits", () => {
		expect(formatContextWindow(12345)).toBe("12345");
		expect(formatContextWindow(undefined)).toBe("模型上限");
	});
});
