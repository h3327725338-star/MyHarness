/**
 * Navigation inside one session tree: move the leaf to another entry and,
 * when asked, summarize the branch that is being left.
 *
 * Extensions and credentials are reached through the host, so this module
 * only knows the session tree and the branch summarizer.
 */

import type { Agent } from "@myharness/agent-core";
import { contentText } from "@myharness/ai";
import type { Model, Usage } from "@myharness/ai/compat";
import type { SettingsManager } from "../../config/settings/index.ts";
import type { SessionManager } from "../../session/manager/index.ts";
import type { BranchSummaryEntry, SessionEntry } from "../../session/types.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./index.ts";

export interface TreeNavigationOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface TreeNavigationResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
}

export interface TreeNavigationPreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface TreeNavigationHost {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	getModel(): Model<any> | undefined;
	getEffectiveContextWindow(): number;
	/** Reserve tokens of the session's runtime compaction settings. */
	getCompactionReserveTokens(): number;
	resolveSummarizationAuth(
		model: Model<any>,
	): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
	/** Let extensions cancel, supply a summary, or override instructions and label. Undefined when nobody listens. */
	askExtensions(
		preparation: TreeNavigationPreparation,
		signal: AbortSignal,
	): Promise<
		| {
				cancel?: boolean;
				summary?: { summary: string; details?: unknown; usage?: Usage };
				customInstructions?: string;
				replaceInstructions?: boolean;
				label?: string;
		  }
		| undefined
	>;
	/** Tell extensions that the leaf moved. */
	notifyExtensions(event: {
		newLeafId: string | null;
		oldLeafId: string | null;
		summaryEntry?: BranchSummaryEntry;
		fromExtension?: boolean;
	}): Promise<void>;
}

/**
 * Move the session leaf from `oldLeafId` to `targetId`.
 * The caller has already checked that the session is idle and that the target differs from the current leaf.
 */
export async function navigateSessionTree(
	host: TreeNavigationHost,
	targetId: string,
	oldLeafId: string | null,
	options: TreeNavigationOptions,
	signal: AbortSignal,
): Promise<TreeNavigationResult> {
	const { sessionManager } = host;
	const targetEntry = sessionManager.getEntry(targetId);
	if (!targetEntry) {
		throw new Error(`Entry ${targetId} not found`);
	}

	// Collect entries to summarize (from old leaf to common ancestor)
	const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
		sessionManager,
		oldLeafId,
		targetId,
	);

	// Prepare event data - mutable so extensions can override
	let customInstructions = options.customInstructions;
	let replaceInstructions = options.replaceInstructions;
	let label = options.label;

	const preparation: TreeNavigationPreparation = {
		targetId,
		oldLeafId,
		commonAncestorId,
		entriesToSummarize,
		userWantsSummary: options.summarize ?? false,
		customInstructions,
		replaceInstructions,
		label,
	};

	let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
	let fromExtension = false;

	const result = await host.askExtensions(preparation, signal);
	if (result?.cancel) {
		return { cancelled: true };
	}

	if (result?.summary && options.summarize) {
		extensionSummary = result.summary;
		fromExtension = true;
	}

	// Allow extensions to override instructions and label
	if (result?.customInstructions !== undefined) {
		customInstructions = result.customInstructions;
	}
	if (result?.replaceInstructions !== undefined) {
		replaceInstructions = result.replaceInstructions;
	}
	if (result?.label !== undefined) {
		label = result.label;
	}

	// Run default summarizer if needed
	let summaryText: string | undefined;
	let summaryDetails: unknown;
	let summaryUsage: Usage | undefined;
	if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
		const model = host.getModel()!;
		const { apiKey, headers, env } = await host.resolveSummarizationAuth(model);
		const branchSummarySettings = host.settingsManager.getBranchSummarySettings();
		const summary = await generateBranchSummary(entriesToSummarize, {
			model,
			contextWindow: host.getEffectiveContextWindow() || undefined,
			apiKey,
			headers,
			env,
			signal,
			customInstructions,
			replaceInstructions,
			reserveTokens: Math.max(branchSummarySettings.reserveTokens, host.getCompactionReserveTokens()),
			streamFn: host.agent.streamFunction,
		});
		if (summary.aborted) {
			return { cancelled: true, aborted: true };
		}
		if (summary.error) {
			throw new Error(summary.error);
		}
		summaryText = summary.summary;
		summaryUsage = summary.usage;
		summaryDetails = {
			readFiles: summary.readFiles || [],
			modifiedFiles: summary.modifiedFiles || [],
		};
	} else if (extensionSummary) {
		summaryText = extensionSummary.summary;
		summaryDetails = extensionSummary.details;
		summaryUsage = extensionSummary.usage;
	}

	// Determine the new leaf position based on target type
	let newLeafId: string | null;
	let editorText: string | undefined;

	if (targetEntry.type === "message" && targetEntry.message.role === "user") {
		// User message: leaf = parent (null if root), text goes to editor
		newLeafId = targetEntry.parentId;
		editorText = contentText(targetEntry.message.content, "");
	} else if (targetEntry.type === "custom_message") {
		// Custom message: leaf = parent (null if root), text goes to editor
		newLeafId = targetEntry.parentId;
		editorText = contentText(targetEntry.content, "");
	} else {
		// Non-user message: leaf = selected node
		newLeafId = targetId;
	}

	// Switch leaf (with or without summary)
	// Summary is attached at the navigation target position (newLeafId), not the old branch
	let summaryEntry: BranchSummaryEntry | undefined;
	if (summaryText) {
		// Create summary at target position (can be null for root)
		const summaryId = sessionManager.branchWithSummary(
			newLeafId,
			summaryText,
			summaryDetails,
			fromExtension,
			summaryUsage,
		);
		summaryEntry = sessionManager.getEntry(summaryId) as BranchSummaryEntry;

		// Attach label to the summary entry
		if (label) {
			sessionManager.appendLabelChange(summaryId, label);
		}
	} else if (newLeafId === null) {
		// No summary, navigating to root - reset leaf
		sessionManager.resetLeaf();
	} else {
		// No summary, navigating to non-root
		sessionManager.branch(newLeafId);
	}

	// Attach label to target entry when not summarizing (no summary entry to label)
	if (label && !summaryText) {
		sessionManager.appendLabelChange(targetId, label);
	}

	// Update agent state
	const sessionContext = sessionManager.buildSessionContext();
	host.agent.state.messages = sessionContext.messages;

	await host.notifyExtensions({
		newLeafId: sessionManager.getLeafId(),
		oldLeafId,
		summaryEntry,
		fromExtension: summaryText ? fromExtension : undefined,
	});

	return { editorText, cancelled: false, summaryEntry };
}
