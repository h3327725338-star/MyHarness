/**
 * Compaction of one AgentSession's context.
 *
 * Owns what a compaction does: choosing the compaction model, asking
 * extensions, producing the checkpoint, writing it to the session and
 * rebuilding the active context. When a compaction runs, how it is cancelled
 * and which events hosts see is decided by AgentSession.
 */

import type { Agent, AgentMessage, AgentTool, ThinkingLevel } from "@myharness/agent-core";
import { contentText } from "@myharness/ai";
import type { Model, Usage } from "@myharness/ai/compat";
import { clampThinkingLevel } from "@myharness/ai/compat";
import type { SettingsManager } from "../../config/settings/index.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import { getLatestCompactionEntry } from "../../session/projection/index.ts";
import type { CompactionEntry, SessionEntry } from "../../session/types.ts";
import type { AgentSessionContextCoordinator } from "../coordinator.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	compact,
	prepareCompaction,
} from "./index.ts";

/** Credentials for the summarization request. */
export interface CompactionRequestAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export interface CompactionExtensionRequest {
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions: string | undefined;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	signal: AbortSignal;
}

export interface SessionCompactionHost {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	contextCoordinator: AgentSessionContextCoordinator;
	/** The configured compaction model if its provider is enabled and the model exists. */
	findCompactionModel(provider: string, model: string): Model<any> | undefined;
	/** Let extensions veto the compaction or supply their own result. Undefined when nobody listens. */
	askExtensions(
		request: CompactionExtensionRequest,
	): Promise<{ cancel?: boolean; compaction?: CompactionResult } | undefined>;
	/** Tell extensions that a checkpoint was written. */
	notifyExtensions(event: {
		compactionEntry: CompactionEntry;
		fromExtension: boolean;
		reason: "manual" | "threshold" | "overflow";
		willRetry: boolean;
	}): Promise<void>;
}

export interface SessionCompactionRequest {
	preparation: CompactionPreparation;
	/** Entries of the branch the preparation was made from. */
	branchEntries: SessionEntry[];
	model: Model<any>;
	auth: CompactionRequestAuth;
	customInstructions: string | undefined;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	signal: AbortSignal;
}

export type SessionCompactionOutcome =
	/** An extension vetoed the compaction; nothing was written. */
	| { status: "cancelled" }
	/** The checkpoint was written, then the caller's signal turned out to be aborted. */
	| { status: "aborted" }
	| { status: "completed"; result: CompactionResult };

export class SessionCompactionRunner {
	private readonly _host: SessionCompactionHost;

	constructor(host: SessionCompactionHost) {
		this._host = host;
	}

	/** The model compaction runs on: the configured compaction model, else the main model. */
	resolveModel(): Model<any> {
		const { settingsManager, agent } = this._host;
		const { provider, model } = settingsManager.getCompactionModelSettings();
		const mainModel = agent.state.model as Model<any> | undefined;
		if (!provider && !model && mainModel) return mainModel;
		const selected = provider && model ? this._host.findCompactionModel(provider, model) : undefined;
		if (!selected) throw new Error(`Compact model unavailable: ${provider ?? ""}/${model ?? ""}`);
		return selected;
	}

	private _resolveThinkingLevel(model: Model<any>): ThinkingLevel {
		const configured = this._host.settingsManager.getCompactionModelSettings();
		// A compaction model of its own without an effort sends none; the main model brings the main effort along.
		const level =
			configured.provider && configured.model
				? (configured.thinkingLevel ?? "off")
				: (configured.thinkingLevel ?? this._host.agent.state.thinkingLevel);
		return clampThinkingLevel(model, level) as ThinkingLevel;
	}

	/**
	 * Plan a compaction of the current branch.
	 * `preparation` is undefined when there is nothing to compact.
	 */
	async prepare(
		settings: CompactionSettings = this._host.contextCoordinator.getRuntimeCompactionSettings(),
	): Promise<{ preparation: CompactionPreparation | undefined; branchEntries: SessionEntry[] }> {
		const branchEntries = this._host.sessionManager.getBranch();
		if (branchEntries.length === 0) return { preparation: undefined, branchEntries };
		// One canonical snapshot per preparation: passed into prepareCompaction
		// so the inner full-history estimate is skipped instead of computed
		// and immediately overwritten here.
		const tokensBefore = (await this._host.contextCoordinator.buildProviderSnapshot()).activeTokens;
		const preparation = prepareCompaction(branchEntries, settings, { tokensBefore });
		return { preparation, branchEntries };
	}

	/** Run a prepared compaction: ask extensions, write the checkpoint, rebuild the context, notify extensions. */
	async run(request: SessionCompactionRequest): Promise<SessionCompactionOutcome> {
		const { preparation, branchEntries, model, auth, customInstructions, reason, willRetry, signal } = request;
		// P0-1 prefix stability: the summarization fork reuses the parent's exact
		// system/tools references captured here, never a rebuilt prompt. A per-turn
		// re-derivation inside _generate would risk prefix drift mid-compaction.
		const parentSystemPrompt = this._host.agent.state.systemPrompt;
		const parentTools = this._host.agent.state.tools;

		let extensionCompaction: CompactionResult | undefined;
		const extensionResult = await this._host.askExtensions({
			preparation,
			branchEntries,
			customInstructions,
			reason,
			willRetry,
			signal,
		});
		if (extensionResult?.cancel) {
			return { status: "cancelled" };
		}
		if (extensionResult?.compaction) {
			extensionCompaction = extensionResult.compaction;
		}

		// Automatic and manual compaction share one checkpoint implementation.
		const outcome = await this._generate(
			preparation,
			model,
			auth,
			customInstructions,
			signal,
			this._resolveThinkingLevel(model),
			extensionCompaction,
			parentSystemPrompt,
			parentTools,
			branchEntries,
		);
		const summary = outcome.result.summary;
		const firstKeptEntryId = outcome.result.firstKeptEntryId;
		const tokensBefore = outcome.result.tokensBefore;
		const usage: Usage | undefined = outcome.result.usage;
		const details: unknown = outcome.result.details;
		const estimatedTokensAfter = outcome.result.estimatedTokensAfter;

		if (signal.aborted) return { status: "aborted" };

		const savedCompactionEntry = getLatestCompactionEntry(this._host.sessionManager.getBranch());
		if (savedCompactionEntry) {
			await this._host.notifyExtensions({
				compactionEntry: savedCompactionEntry,
				fromExtension: outcome.fromExtension,
				reason,
				willRetry,
			});
		}

		return {
			status: "completed",
			result: {
				replacementHistory: savedCompactionEntry?.replacementHistory,
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			},
		};
	}

	private async _generate(
		preparation: CompactionPreparation,
		model: Model<any>,
		auth: CompactionRequestAuth,
		customInstructions: string | undefined,
		signal: AbortSignal,
		thinkingLevel: ThinkingLevel,
		extensionCompaction?: CompactionResult,
		parentSystemPrompt?: string,
		parentTools?: AgentTool[],
		branchEntries: SessionEntry[] = [],
	): Promise<{ result: CompactionResult & { estimatedTokensAfter: number }; fromExtension: boolean }> {
		const { agent, sessionManager, contextCoordinator } = this._host;
		const mainModel = agent.state.model as Model<any> | undefined;
		const fromExtension = extensionCompaction !== undefined;
		const tools = parentTools ?? agent.state.tools;
		const sameModel =
			mainModel?.provider === model.provider &&
			mainModel?.id === model.id &&
			mainModel?.api === model.api &&
			mainModel?.baseUrl === model.baseUrl;
		// On the chat's own model the summary request is the chat's next request plus the checkpoint instruction (same
		// transforms, same tools), so the provider serves almost all of it from the prompt cache.
		const mainRequest =
			!fromExtension && sameModel
				? {
						messages: agent.transformContext
							? await agent.transformContext(preparation.messagesToSummarize, signal)
							: preparation.messagesToSummarize,
						tools,
					}
				: undefined;
		const branchMessages: AgentMessage[] = [];
		const userEntries: Array<{ id: string; timestamp: number; text: string }> = [];
		for (const entry of branchEntries) {
			if (entry.type !== "message") continue;
			branchMessages.push(entry.message);
			if (entry.message.role === "user")
				userEntries.push({
					id: entry.id,
					timestamp: entry.message.timestamp,
					text: contentText(entry.message.content, "\n"),
				});
		}
		// The checkpoint lists the earlier user messages only where session_get can read this chat back.
		const canReadBack =
			sessionManager.isPersisted() &&
			sessionManager.usesDefaultSessionDir() &&
			tools.some((tool) => tool.name === "session_get");
		const history = {
			contextWindow: contextCoordinator.effectiveContextWindow || undefined,
			branchMessages,
			...(canReadBack ? { recovery: { sessionId: sessionManager.getSessionId(), userEntries } } : {}),
		};
		const result =
			extensionCompaction ??
			(await compact(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				customInstructions,
				signal,
				thinkingLevel,
				agent.streamFunction,
				auth.env,
				parentSystemPrompt ?? agent.state.systemPrompt,
				tools,
				mainModel?.provider === model.provider &&
					mainModel?.api === model.api &&
					mainModel?.baseUrl === model.baseUrl,
				sessionManager.getSessionId(),
				{ mainRequest, history },
			));
		if (signal.aborted) throw new Error("Compaction cancelled");
		const id = sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
			result.usage,
			undefined,
			true,
			result.replacementHistory,
			!fromExtension && result.usage
				? { provider: model.provider, model: model.id, currency: model.cost.currency ?? "USD" }
				: undefined,
		);
		result.firstKeptEntryId = id;
		agent.state.messages = sessionManager.buildSessionContext().messages;
		contextCoordinator.resetAfterCompaction();
		const after = await contextCoordinator.buildProviderSnapshot();
		contextCoordinator.remember([], undefined, after);
		return { result: { ...result, estimatedTokensAfter: after.activeTokens }, fromExtension };
	}
}
