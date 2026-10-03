import { sep } from "node:path";
import { visibleWidth } from "@myharness/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/agent/runtime/agent-session.ts";
import type { VisionAssistantSettings } from "../src/config/settings/index.ts";
import type { ContextBudgetSnapshot } from "../src/context/context-budget.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import type { ReadonlyFooterDataProvider } from "../src/modes/interactive/footer-data-provider.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { BalanceInfo, BalanceScope } from "../src/providers/runtime/balance-tracker.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	visionAssistant?: VisionAssistantSettings;
	visionProviderEnabled?: boolean;
	visionAuthConfigured?: boolean;
	budgetSnapshot?: ContextBudgetSnapshot;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		getContextBudgetSnapshot: () =>
			options.budgetSnapshot ?? {
				role: "main",
				configuredWindow: 200_000,
				modelWindow: 200_000,
				effectiveWindow: 200_000,
				reserveTokens: 16_384,
				autoCompactThresholdTokens: Math.floor(200_000 * 0.85),
				budgetLimit: 200_000 - 16_384,
				activeTokens: 24_600,
				percent: 12.3,
				overBudget: false,
				shouldAutoCompact: false,
				autoCompactEnabled: true,
				usageSource: "provider-anchor",
				windowSource: "model",
			},
		modelRuntime: {
			isUsingOAuth: () => false,
			isProviderEnabled: () => options.visionProviderEnabled ?? true,
			hasVisionConfiguredAuth: () => options.visionAuthConfigured ?? true,
		},
		settingsManager: {
			getVisionAssistantSettings: () => ({
				enabled: options.visionAssistant?.enabled ?? false,
				provider: options.visionAssistant?.provider,
				model: options.visionAssistant?.model,
				thinkingLevel: options.visionAssistant?.thinkingLevel,
			}),
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("Footer context-window display", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders a 512K effective window as 512K (not 524k)", () => {
		const session = createSession({
			sessionName: "",
			budgetSnapshot: {
				role: "main",
				configuredWindow: 524_288,
				modelWindow: 1_048_576,
				effectiveWindow: 524_288,
				reserveTokens: 78_644,
				autoCompactThresholdTokens: 445_644,
				budgetLimit: 445_644,
				activeTokens: 124_780,
				percent: (124_780 / 524_288) * 100,
				overBudget: false,
				shouldAutoCompact: false,
				autoCompactEnabled: true,
				usageSource: "provider-anchor",
				windowSource: "min-configured-model",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[1]);
		expect(line).toContain("124.8K/512K");
		expect(line).toContain("23.8%");
		expect(line).not.toContain("524k");
	});

	it("renders a 1M effective window as 1M (not 1049k)", () => {
		const session = createSession({
			sessionName: "",
			budgetSnapshot: {
				role: "main",
				configuredWindow: 1_048_576,
				modelWindow: 1_048_576,
				effectiveWindow: 1_048_576,
				reserveTokens: 157_287,
				autoCompactThresholdTokens: 891_289,
				budgetLimit: 891_289,
				activeTokens: 250_000,
				percent: (250_000 / 1_048_576) * 100,
				overBudget: false,
				shouldAutoCompact: false,
				autoCompactEnabled: true,
				usageSource: "provider-anchor",
				windowSource: "settings",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[1]);
		expect(line).toContain("/1M");
		expect(line).not.toContain("1049k");
		expect(line).not.toContain("1.05m");
	});

	it("shows the real smaller effective window plus a model-limit hint when configured exceeds the model", () => {
		const session = createSession({
			sessionName: "",
			budgetSnapshot: {
				role: "main",
				configuredWindow: 524_288,
				modelWindow: 131_072,
				effectiveWindow: 131_072,
				reserveTokens: 19_661,
				autoCompactThresholdTokens: 111_411,
				budgetLimit: 111_411,
				activeTokens: 125_000,
				percent: (125_000 / 131_072) * 100,
				overBudget: true,
				shouldAutoCompact: true,
				autoCompactEnabled: true,
				usageSource: "provider-anchor",
				windowSource: "min-configured-model",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[1]);
		expect(line).toContain("/128K");
		expect(line).not.toContain("/512K");
		expect(line).toContain("model limit");
	});

	it("does not add a model-limit hint when configured equals effective", () => {
		const session = createSession({
			sessionName: "",
			budgetSnapshot: {
				role: "main",
				configuredWindow: 262_144,
				modelWindow: 1_048_576,
				effectiveWindow: 262_144,
				reserveTokens: 39_322,
				autoCompactThresholdTokens: 222_822,
				budgetLimit: 222_822,
				activeTokens: 60_000,
				percent: (60_000 / 262_144) * 100,
				overBudget: false,
				shouldAutoCompact: false,
				autoCompactEnabled: true,
				usageSource: "provider-anchor",
				windowSource: "settings",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[1]);
		expect(line).toContain("/256K");
		expect(line).not.toContain("model limit");
	});
});

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe(`~${sep}project`);
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("formats the provider and model with a hyphen", () => {
		const session = createSession({
			sessionName: "",
			modelId: "test-model",
			provider: "test-provider",
			reasoning: true,
			thinkingLevel: "max",
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const line = stripAnsi(footer.render(120)[1]);
		expect(line).toContain("test-provider-test-model • max");
		expect(line).not.toContain("(test-provider) test-model");
	});

	it("hides costs when no balance is available", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).not.toContain("$1.234");
	});

	it("shows the selected vision model and its balance on a second aligned row", () => {
		const session = createSession({
			sessionName: "",
			modelId: "deepseek-v4-pro",
			provider: "anthropic",
			reasoning: true,
			thinkingLevel: "high",
			visionAssistant: {
				enabled: true,
				provider: "openrouter",
				model: "qwen-vl",
				thinkingLevel: "medium",
			},
		});
		const balances: Record<BalanceScope, BalanceInfo> = {
			main: { totalBalance: "5.23", currency: "CNY" },
			vision: { totalBalance: "1.50", currency: "CNY" },
		};
		const footer = new FooterComponent(session, createFooterData(1), (scope = "main") => balances[scope]);

		const lines = footer.render(100).map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("¥5.23");
		expect(lines[1]).toContain("deepseek-v4-pro • high");
		expect(lines[2]).toContain("¥1.50");
		expect(lines[2]).toContain("openrouter/qwen-vl • medium");
		expect(lines[1].indexOf("deepseek-v4-pro")).toBe(lines[2].indexOf("openrouter/qwen-vl"));
	});

	it("hides the vision row when Vision Assistant is disabled", () => {
		const session = createSession({
			sessionName: "",
			visionAssistant: {
				enabled: false,
				provider: "openrouter",
				model: "qwen-vl",
				thinkingLevel: "medium",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(footer.render(100)).toHaveLength(2);
	});

	it("hides the vision row when its Provider has no usable visual credential", () => {
		const session = createSession({
			sessionName: "",
			visionAssistant: {
				enabled: true,
				provider: "longcatai",
				model: "LongCat-2.0",
				thinkingLevel: "high",
			},
			visionAuthConfigured: false,
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(footer.render(100)).toHaveLength(2);
	});

	it("shows the vision row right side without a balance when the balance is unknown", () => {
		const session = createSession({
			sessionName: "",
			visionAssistant: {
				enabled: true,
				provider: "openrouter",
				model: "qwen-vl",
				thinkingLevel: "medium",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1), () => null);

		const lines = footer.render(100).map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[2]).not.toContain("余额");
		expect(lines[2]).toContain("openrouter/qwen-vl");
	});

	it("shows the vision row right side in a narrow terminal when the balance is unknown", () => {
		const width = 44;
		const session = createSession({
			sessionName: "",
			modelId: "main-model-with-a-long-name",
			reasoning: true,
			thinkingLevel: "high",
			visionAssistant: {
				enabled: true,
				provider: "custom-provider",
				model: "vision-model-with-a-long-name",
				thinkingLevel: "off",
			},
		});
		const footer = new FooterComponent(session, createFooterData(1), () => null);

		const lines = footer.render(width);
		expect(lines).toHaveLength(3);
		expect(stripAnsi(lines[2])).not.toContain("余额");
		expect(stripAnsi(lines[2])).toContain("custom-provider/");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
