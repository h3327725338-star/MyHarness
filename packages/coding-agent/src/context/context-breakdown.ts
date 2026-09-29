/**
 * Breakdown of the Active Context by what occupies it.
 *
 * Every number is measured on the same inputs a model request is built from (system prompt, tool definitions and the
 * active messages) with the same estimator the context budget uses. Nothing is invented: a category that does not
 * exist in the session simply has zero tokens and is left out by the caller's UI.
 */

import type { AgentMessage } from "@myharness/agent-core";
import { estimateMessageTokens, estimateTextTokens } from "@myharness/ai";
import { convertToLlm } from "../agent/runtime/messages.ts";
import type { ContextBudgetSnapshot } from "./context-budget.ts";

export type ContextCategoryId =
	| "systemPrompt"
	| "projectInstructions"
	| "skills"
	| "memoryPolicy"
	| "builtinTools"
	| "extensionTools"
	| "userMessages"
	| "assistantMessages"
	| "toolResults"
	| "memoryRecall"
	| "compactionSummary";

export interface ContextCategory {
	id: ContextCategoryId;
	tokens: number;
	/** Number of items behind the number (tools, messages, files, skills). */
	count: number;
}

export interface ContextBreakdown {
	/** The context window this session may use, and where that limit comes from. */
	window: number;
	windowSource: ContextBudgetSnapshot["windowSource"];
	modelWindow: number;
	/** Tokens the next request needs: provider-reported usage when available, otherwise a full estimate. */
	used: number;
	usageSource: ContextBudgetSnapshot["usageSource"];
	percent: number;
	/** Tokens set aside for the model's answer and safety margin. */
	reserved: number;
	/** Window minus used minus reserved, never negative. */
	free: number;
	autoCompactEnabled: boolean;
	autoCompactThreshold: number;
	/** Sum of the categories below (the measured composition; can differ from `used` when the provider reports it). */
	measured: number;
	categories: ContextCategory[];
	/** The heaviest tool definitions, largest first. */
	topTools: Array<{ name: string; tokens: number; extension: boolean }>;
	/** Tools whose definitions are loaded on demand instead of being part of the request prefix. */
	deferredTools: string[];
}

export interface ContextBreakdownInput {
	budget: ContextBudgetSnapshot;
	systemPrompt: string;
	contextFiles: ReadonlyArray<{ content: string }>;
	/** The skills section exactly as it appears in the system prompt ("" when no skills are listed). */
	skillsPromptText: string;
	/** The Auto Memory policy appended to the system prompt ("" when Auto Memory is off). */
	memoryPolicyText: string;
	tools: ReadonlyArray<{ name: string; description: string; parameters: unknown; extension: boolean }>;
	deferredTools?: readonly string[];
	messages: readonly AgentMessage[];
}

function toolTokens(tool: { name: string; description: string; parameters: unknown }): number {
	try {
		return estimateTextTokens(
			JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
		);
	} catch {
		return estimateTextTokens(`${tool.name} ${tool.description}`);
	}
}

function messageTokens(message: AgentMessage): number {
	try {
		return convertToLlm([message]).reduce((sum, llm) => sum + estimateMessageTokens(llm), 0);
	} catch {
		return 0;
	}
}

export function buildContextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
	const { budget } = input;
	const projectTokens = input.contextFiles.reduce((sum, file) => sum + estimateTextTokens(file.content), 0);
	const skillsTokens = input.skillsPromptText ? estimateTextTokens(input.skillsPromptText) : 0;
	const memoryPolicyTokens =
		input.memoryPolicyText && input.systemPrompt.includes(input.memoryPolicyText)
			? estimateTextTokens(input.memoryPolicyText)
			: 0;
	const systemTotal = input.systemPrompt ? estimateTextTokens(input.systemPrompt) : 0;
	const systemCore = Math.max(0, systemTotal - projectTokens - skillsTokens - memoryPolicyTokens);

	let builtin = 0;
	let extension = 0;
	let builtinCount = 0;
	let extensionCount = 0;
	const perTool: Array<{ name: string; tokens: number; extension: boolean }> = [];
	const deferred = new Set(input.deferredTools ?? []);
	for (const tool of input.tools) {
		if (deferred.has(tool.name)) continue;
		const tokens = toolTokens(tool);
		perTool.push({ name: tool.name, tokens, extension: tool.extension });
		if (tool.extension) {
			extension += tokens;
			extensionCount += 1;
		} else {
			builtin += tokens;
			builtinCount += 1;
		}
	}

	const roles = {
		user: { tokens: 0, count: 0 },
		assistant: { tokens: 0, count: 0 },
		toolResult: { tokens: 0, count: 0 },
		memory: { tokens: 0, count: 0 },
		summary: { tokens: 0, count: 0 },
	};
	for (const message of input.messages) {
		const tokens = messageTokens(message);
		let bucket: keyof typeof roles;
		if (message.role === "assistant") bucket = "assistant";
		else if (message.role === "toolResult") bucket = "toolResult";
		else if (message.role === "compactionSummary") bucket = "summary";
		else if (message.role === "custom" && message.customType === "auto-memory-recall") bucket = "memory";
		else bucket = "user";
		roles[bucket].tokens += tokens;
		roles[bucket].count += 1;
	}

	const categories: ContextCategory[] = [
		{ id: "systemPrompt", tokens: systemCore, count: systemCore > 0 ? 1 : 0 },
		{ id: "projectInstructions", tokens: projectTokens, count: input.contextFiles.length },
		{ id: "skills", tokens: skillsTokens, count: 0 },
		{ id: "memoryPolicy", tokens: memoryPolicyTokens, count: memoryPolicyTokens > 0 ? 1 : 0 },
		{ id: "builtinTools", tokens: builtin, count: builtinCount },
		{ id: "extensionTools", tokens: extension, count: extensionCount },
		{ id: "userMessages", tokens: roles.user.tokens, count: roles.user.count },
		{ id: "assistantMessages", tokens: roles.assistant.tokens, count: roles.assistant.count },
		{ id: "toolResults", tokens: roles.toolResult.tokens, count: roles.toolResult.count },
		{ id: "memoryRecall", tokens: roles.memory.tokens, count: roles.memory.count },
		{ id: "compactionSummary", tokens: roles.summary.tokens, count: roles.summary.count },
	];
	const measured = categories.reduce((sum, category) => sum + category.tokens, 0);
	const used = budget.activeTokens;
	const reserved = budget.reserveTokens;
	return {
		window: budget.effectiveWindow,
		windowSource: budget.windowSource,
		modelWindow: budget.modelWindow,
		used,
		usageSource: budget.usageSource,
		percent: budget.percent,
		reserved,
		free: Math.max(0, budget.effectiveWindow - used - reserved),
		autoCompactEnabled: budget.autoCompactEnabled,
		autoCompactThreshold: budget.autoCompactThresholdTokens,
		measured,
		categories,
		topTools: perTool.sort((a, b) => b.tokens - a.tokens).slice(0, 8),
		deferredTools: [...deferred],
	};
}
