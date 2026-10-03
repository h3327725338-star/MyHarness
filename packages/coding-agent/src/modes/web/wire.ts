/**
 * Wire format between the Web host and the browser.
 *
 * Everything here is a JSON-safe projection of existing runtime data
 * (AgentMessage, SessionEntry, Model, ...). It never invents data: fields that
 * the runtime does not provide are simply absent.
 */

import type { AgentMessage } from "@myharness/agent-core";
import { getSupportedThinkingLevels, type Model } from "@myharness/ai/compat";
import { parseSkillBlock } from "../../agent/runtime/agent-session.ts";
import { parseExpandedBuiltinPromptCommand } from "../../cli/slash-commands.ts";
import { explainProviderError } from "../../providers/recovery/error-explanation.ts";
import type { SessionEntry } from "../../session/types.ts";

/** Tool result details larger than this are replaced by a marker to keep payloads bounded. */
const MAX_DETAILS_JSON_CHARS = 400_000;

/**
 * Custom entry that keeps a finished task's change card (the files it changed, with their diffs) in the session, so
 * the card stays in the conversation. Like every custom entry it never enters the model's messages.
 */
export const RUN_CHANGES_ENTRY = "web-run-changes";

/** One file of a change card as the browser lists it; the diff itself is fetched when the file is opened. */
export interface WireChangeFile {
	path: string;
	status: string;
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
	unavailable?: string;
}

export interface WireImage {
	mimeType: string;
	data: string;
}

export type WireAssistantBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; args: unknown };

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: number;
}

export type WireItem =
	| { kind: "gitStatus"; id: string; ts: number; result: Record<string, unknown> }
	| { kind: "runChanges"; id: string; ts: number; runId: number; files: WireChangeFile[] }
	| {
			kind: "user";
			id?: string;
			ts: number;
			text: string;
			images: WireImage[];
			/** The user picked a built-in prompt command such as /workflow. */
			command?: { name: string; task: string };
			skill?: { name: string; location: string; content: string };
	  }
	| {
			kind: "assistant";
			id?: string;
			ts: number;
			blocks: WireAssistantBlock[];
			stopReason: string;
			error?: string;
			provider: string;
			model: string;
			usage?: WireUsage;
	  }
	| {
			kind: "toolResult";
			id?: string;
			ts: number;
			toolCallId: string;
			toolName: string;
			text: string;
			images: WireImage[];
			isError: boolean;
			details?: unknown;
	  }
	| {
			kind: "bash";
			id?: string;
			ts: number;
			command: string;
			output: string;
			exitCode: number | undefined;
			cancelled: boolean;
			timedOut?: boolean;
			truncated: boolean;
			fullOutputPath?: string;
			excludeFromContext?: boolean;
	  }
	| {
			kind: "custom";
			id?: string;
			ts: number;
			customType: string;
			text: string;
			images: WireImage[];
			display: boolean;
			details?: unknown;
	  }
	| { kind: "compaction"; id?: string; ts: number; summary: string; tokensBefore: number }
	| { kind: "branchSummary"; id?: string; ts: number; summary: string; fromId: string }
	| {
			kind: "reload";
			id?: string;
			ts: number;
			ok: boolean;
			error?: string;
			reloadError?: string;
			resources: string;
	  };

export interface WireModel {
	cost?: Model<any>["cost"];
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: string[];
	thinkingLevels?: string[];
}

export function toWireModel(model: Model<any>): WireModel {
	return {
		cost: { ...model.cost, tiers: model.cost.tiers?.map((tier) => ({ ...tier })) },
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		input: [...model.input],
		// This model's own effort options (what the Composer offers after switching to it).
		thinkingLevels: getSupportedThinkingLevels(model),
	};
}

function contentParts(content: unknown): { text: string; images: WireImage[] } {
	if (typeof content === "string") return { text: content, images: [] };
	if (!Array.isArray(content)) return { text: "", images: [] };
	const texts: string[] = [];
	const images: WireImage[] = [];
	for (const part of content as Array<{ type?: string; text?: string; mimeType?: string; data?: string }>) {
		if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part.type === "image" && part.data && part.mimeType)
			images.push({ mimeType: part.mimeType, data: part.data });
	}
	return { text: texts.join(""), images };
}

export function sanitizeDetails(details: unknown): unknown {
	if (details === undefined || details === null) return undefined;
	try {
		const text = JSON.stringify(details);
		if (text.length > MAX_DETAILS_JSON_CHARS) {
			return { truncatedDetails: true, originalChars: text.length };
		}
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function wireUsage(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost?: { total: number };
}): WireUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
		totalTokens: usage.totalTokens,
		cost: usage.cost?.total ?? 0,
	};
}

/** Project one AgentMessage into a wire item. Returns undefined for messages with no visible form. */
export function messageToWire(message: AgentMessage, meta: { id?: string; ts?: number } = {}): WireItem | undefined {
	const ts = meta.ts ?? (typeof message.timestamp === "number" ? message.timestamp : Date.now());
	switch (message.role) {
		case "user": {
			const { text, images } = contentParts(message.content);
			const builtin = parseExpandedBuiltinPromptCommand(text);
			const skill = builtin ? undefined : parseSkillBlock(text);
			if (builtin) {
				return { kind: "user", id: meta.id, ts, text: builtin.task, images, command: builtin };
			}
			if (skill) {
				return {
					kind: "user",
					id: meta.id,
					ts,
					text: skill.userMessage ?? "",
					images,
					skill: { name: skill.name, location: skill.location, content: skill.content },
				};
			}
			return { kind: "user", id: meta.id, ts, text, images };
		}
		case "assistant": {
			const blocks: WireAssistantBlock[] = [];
			for (const block of message.content) {
				if (block.type === "text") blocks.push({ type: "text", text: block.text });
				else if (block.type === "thinking") {
					blocks.push({
						type: "thinking",
						text: block.thinking ?? "",
						...(block.redacted ? { redacted: true } : {}),
					});
				} else if (block.type === "toolCall") {
					blocks.push({ type: "toolCall", id: block.id, name: block.name, args: block.arguments });
				}
			}
			return {
				kind: "assistant",
				id: meta.id,
				ts,
				blocks,
				stopReason: message.stopReason,
				// A failed request is shown with its cause and next step, not as a bare status code.
				...(message.stopReason === "error"
					? { error: explainProviderError(message.errorMessage) }
					: message.errorMessage
						? { error: message.errorMessage }
						: {}),
				provider: message.provider,
				model: message.model,
				...(message.usage ? { usage: wireUsage(message.usage) } : {}),
			};
		}
		case "toolResult": {
			const { text, images } = contentParts(message.content);
			return {
				kind: "toolResult",
				id: meta.id,
				ts,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				text,
				images,
				isError: message.isError,
				details: sanitizeDetails(message.details),
			};
		}
		case "bashExecution":
			return {
				kind: "bash",
				id: meta.id,
				ts,
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				...(message.timedOut ? { timedOut: true } : {}),
				truncated: message.truncated,
				...(message.fullOutputPath ? { fullOutputPath: message.fullOutputPath } : {}),
				...(message.excludeFromContext ? { excludeFromContext: true } : {}),
			};
		case "custom": {
			const { text, images } = contentParts(message.content);
			return {
				kind: "custom",
				id: meta.id,
				ts,
				customType: message.customType,
				text,
				images,
				display: message.display,
				details: sanitizeDetails(message.details),
			};
		}
		case "compactionSummary":
			return { kind: "compaction", id: meta.id, ts, summary: message.summary, tokensBefore: message.tokensBefore };
		case "branchSummary":
			return { kind: "branchSummary", id: meta.id, ts, summary: message.summary, fromId: message.fromId };
		case "reloadSummary":
			return {
				kind: "reload",
				id: meta.id,
				ts,
				ok: message.ok,
				error: message.error,
				reloadError: message.reloadError,
				resources: message.resources,
			};
		default:
			return undefined;
	}
}

/** The change card kept in a RUN_CHANGES_ENTRY, without the diffs; undefined when the data is not a card with files. */
export function runChangesToWire(id: string, ts: number, data: unknown): WireItem | undefined {
	const card = data as { runId?: unknown; files?: unknown } | null | undefined;
	if (!card || !Array.isArray(card.files)) return undefined;
	const files: WireChangeFile[] = [];
	for (const file of card.files as Array<Record<string, unknown> | null>) {
		if (!file || typeof file.path !== "string") continue;
		files.push({
			path: file.path,
			status: typeof file.status === "string" ? file.status : "modified",
			...(typeof file.oldPath === "string" ? { oldPath: file.oldPath } : {}),
			additions: Number(file.additions) || 0,
			deletions: Number(file.deletions) || 0,
			binary: file.binary === true,
			...(typeof file.unavailable === "string" ? { unavailable: file.unavailable } : {}),
		});
	}
	if (files.length === 0) return undefined;
	return { kind: "runChanges", id, ts, runId: Number(card.runId) || 0, files };
}

/** Project a persisted session branch into wire items (compaction entries become markers, not replayed history). */
export function entriesToWire(entries: readonly SessionEntry[]): WireItem[] {
	const items: WireItem[] = [];
	for (const entry of entries) {
		const ts = Date.parse(entry.timestamp) || Date.now();
		switch (entry.type) {
			case "message": {
				const wire = messageToWire(entry.message, { id: entry.id, ts });
				if (wire) items.push(wire);
				break;
			}
			case "custom":
				if (entry.customType === "web-git-status" && entry.data && typeof entry.data === "object")
					items.push({
						kind: "gitStatus",
						id: entry.id,
						ts,
						result: sanitizeDetails(entry.data) as Record<string, unknown>,
					});
				else if (entry.customType === RUN_CHANGES_ENTRY) {
					const card = runChangesToWire(entry.id, ts, entry.data);
					if (card) items.push(card);
				}
				break;
			case "custom_message": {
				const { text, images } = contentParts(entry.content);
				items.push({
					kind: "custom",
					id: entry.id,
					ts,
					customType: entry.customType,
					text,
					images,
					display: entry.display,
					details: sanitizeDetails(entry.details),
				});
				break;
			}
			case "compaction":
				items.push({
					kind: "compaction",
					id: entry.id,
					ts,
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
				});
				break;
			case "branch_summary":
				if (entry.summary) {
					items.push({ kind: "branchSummary", id: entry.id, ts, summary: entry.summary, fromId: entry.fromId });
				}
				break;
			default:
				break;
		}
	}
	return items;
}
