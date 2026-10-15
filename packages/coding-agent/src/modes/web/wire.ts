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
import { explainProviderError } from "../../providers/recovery/error-explanation.ts";
import type { SessionEntry, SessionMessageTiming } from "../../session/types.ts";
import { parseExpandedBuiltinPromptCommand } from "../../startup/slash-commands.ts";

/** Tool result details larger than this are replaced by a marker to keep payloads bounded. */
const MAX_DETAILS_JSON_CHARS = 400_000;

/**
 * Details blocks whose serialized-size bound stays under this cap skip the JSON round trip in sanitizeDetails.
 * Chosen well below MAX_DETAILS_JSON_CHARS (measured transcripts have ~99% of details blocks under 4KB) so the
 * size scan early-exits cheaply on the rare large blocks instead of scanning them twice.
 */
const FAST_DETAILS_MAX_CHARS = 64_000;

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
	| {
			type: "toolCall";
			id: string;
			name: string;
			args: unknown;
	  };

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
			timing?: SessionMessageTiming;
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
			timing?: SessionMessageTiming;
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
			timing?: SessionMessageTiming;
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
			timing?: SessionMessageTiming;
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
			timing?: SessionMessageTiming;
	  }
	| {
			kind: "compaction";
			id?: string;
			ts: number;
			summary: string;
			tokensBefore: number;
			firstKeptEntryId?: string;
			usageSource?: { provider: string; model: string; currency: "USD" | "CNY" };
			usage?: WireUsage;
			details?: unknown;
	  }
	| {
			kind: "branchSummary";
			id?: string;
			ts: number;
			summary: string;
			fromId: string;
			usage?: WireUsage;
			details?: unknown;
	  }
	| {
			kind: "label";
			id?: string;
			ts: number;
			targetId: string;
			label?: string;
	  }
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

/**
 * Upper bound on the JSON.stringify output length of a JSON-round-trip-stable value, or undefined when the value
 * is not fast-path eligible: non-plain objects (Date, Map, class instances — anything that could carry toJSON),
 * undefined/function/symbol/bigint members, -0/NaN/Infinity, shared or cyclic references (second visit), sparse
 * arrays, arrays with extra own keys, or a bound that would exceed the remaining budget. Strings count 6 escaped
 * characters per UTF-16 unit (the worst case, "\u0000"), so the bound never undercounts and callers may treat
 * "within budget" as proof that the slow path would not truncate.
 */
function stableJsonSizeUpperBound(value: unknown, budget: number, seen: Set<object>): number | undefined {
	switch (typeof value) {
		case "string": {
			const size = 2 + value.length * 6;
			return size <= budget ? size : undefined;
		}
		case "number": {
			// -0 serializes as "0" (not round-trip stable); any other finite double serializes in at most 25 chars.
			if (!Number.isFinite(value) || Object.is(value, -0)) return undefined;
			return 25 <= budget ? 25 : undefined;
		}
		case "boolean":
			return 5 <= budget ? 5 : undefined;
		case "object": {
			if (value === null) return 4 <= budget ? 4 : undefined;
			if (seen.has(value)) return undefined; // shared or cyclic: the slow path reproduces the old copy exactly.
			seen.add(value);
			let total = 2; // brackets, plus one over-counted comma per member: keeps the bound safe.
			if (Array.isArray(value)) {
				// Holes and extra own keys disappear only through the JSON round trip, so they stay on the slow path.
				if (Object.keys(value).length !== value.length) return undefined;
				const elements = value as unknown[];
				for (let i = 0; i < elements.length; i += 1) {
					total += 1;
					const element = stableJsonSizeUpperBound(elements[i], budget - total, seen);
					if (element === undefined) return undefined;
					total += element;
					if (total > budget) return undefined;
				}
				return total;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) return undefined;
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				total += 3 + key.length * 6; // quoted key + colon
				total += 1; // comma
				if (total > budget) return undefined;
				const property = stableJsonSizeUpperBound(record[key], budget - total, seen);
				if (property === undefined) return undefined;
				total += property;
				if (total > budget) return undefined;
			}
			return total;
		}
		default:
			// undefined/function/symbol/bigint: the round trip drops or rejects them; not fast-path material.
			return undefined;
	}
}

export function sanitizeDetails(details: unknown, charLimit: number = MAX_DETAILS_JSON_CHARS): unknown {
	if (details === undefined || details === null) return undefined;
	// Fast path (W171): transcripts project the same details blocks over and over and ~99% are small, plain JSON.
	// When the size bound proves the serialized text stays within charLimit, the slow path could only rebuild an
	// equal copy, so return the original reference. This is safe because every caller stores the result into a
	// freshly built wire item and never mutates it in place (messageToWire, entriesToWire, the host SSE calls;
	// browsers receive independent JSON.parse copies over HTTP). Anything the bound rejects — or a scan that
	// throws (deep recursion, a getter error) — falls through to the unchanged slow path below.
	try {
		if (stableJsonSizeUpperBound(details, Math.min(charLimit, FAST_DETAILS_MAX_CHARS), new Set()) !== undefined) {
			return details;
		}
	} catch {
		// Not eligible after all; the slow path reproduces the previous behavior exactly.
	}
	try {
		const text = JSON.stringify(details);
		if (text.length > charLimit) {
			return { truncatedDetails: true, originalChars: text.length };
		}
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The sub-agents' light state for the activity bar; each dispatch's details go through the same size bound. */
export function subAgentStateToWire(state: { items: Array<{ details?: unknown }>; running: number }): unknown {
	return { ...state, items: state.items.map((item) => ({ ...item, details: sanitizeDetails(item.details) })) };
}

function wireUsage(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost?: number | { total: number };
}): WireUsage {
	const cost = typeof usage.cost === "number" ? usage.cost : (usage.cost?.total ?? 0);
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
		totalTokens: usage.totalTokens,
		cost,
	};
}

/** Project one AgentMessage into a wire item. Returns undefined for messages with no visible form. */
export function messageToWire(
	message: AgentMessage,
	meta: { id?: string; ts?: number; timing?: SessionMessageTiming; detailsCharLimit?: number } = {},
): WireItem | undefined {
	const ts = meta.ts ?? (typeof message.timestamp === "number" ? message.timestamp : Date.now());
	const timingProp = meta.timing ? { timing: meta.timing } : {};
	switch (message.role) {
		case "user": {
			const { text, images } = contentParts(message.content);
			const builtin = parseExpandedBuiltinPromptCommand(text);
			const skill = builtin ? undefined : parseSkillBlock(text);
			if (builtin) {
				return { kind: "user", id: meta.id, ts, text: builtin.task, images, command: builtin, ...timingProp };
			}
			if (skill) {
				return {
					kind: "user",
					id: meta.id,
					ts,
					text: skill.userMessage ?? "",
					images,
					skill: { name: skill.name, location: skill.location, content: skill.content },
					...timingProp,
				};
			}
			return { kind: "user", id: meta.id, ts, text, images, ...timingProp };
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
					blocks.push({
						type: "toolCall",
						id: block.id,
						name: block.name,
						args: block.arguments,
					});
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
				...timingProp,
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
				details: sanitizeDetails(message.details, meta.detailsCharLimit),
				...timingProp,
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
				...timingProp,
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
				details: sanitizeDetails(message.details, meta.detailsCharLimit),
				...timingProp,
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

export interface EntriesToWireOptions {
	detailsCharLimit?: number;
}

/** Message roles that project to a wire item in messageToWire (anything else projects to nothing). */
const PROJECTABLE_MESSAGE_ROLES = new Set([
	"user",
	"assistant",
	"toolResult",
	"bashExecution",
	"custom",
	"compactionSummary",
	"branchSummary",
	"reloadSummary",
]);

/** Whether a persisted entry projects to a wire item, without paying the sanitizeDetails cost.
 *
 * Mirrors entriesToWire/runChangesToWire exactly (one entry maps to at most one item, in order): callers use it to
 * slice an entry branch down to the tail window before projecting, so paginated transcript reads only convert the
 * entries they actually return. Existence never depends on sanitizeDetails (it only truncates details in place).
 */
export function entryProjectsToWire(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return PROJECTABLE_MESSAGE_ROLES.has(
				(entry.message as { role?: unknown } | undefined)?.role as string,
			);
		case "custom":
			if (entry.customType === RUN_CHANGES_ENTRY) {
				const card = entry.data as { files?: unknown } | null | undefined;
				return (
					Array.isArray(card?.files) &&
					(card.files as Array<Record<string, unknown> | null>).some(
						(file) => !!file && typeof file.path === "string",
					)
			);
			}
			return true;
		case "custom_message":
			return true;
		case "compaction":
			return true;
		case "branch_summary":
			return Boolean(entry.summary);
		case "label":
			return true;
		default:
			return false;
	}
}

/** Project a persisted session branch into wire items (compaction entries become markers, not replayed history). */
export function entriesToWire(entries: readonly SessionEntry[], options: EntriesToWireOptions = {}): WireItem[] {
	const charLimit = options.detailsCharLimit ?? MAX_DETAILS_JSON_CHARS;
	const items: WireItem[] = [];
	for (const entry of entries) {
		const ts = Date.parse(entry.timestamp) || Date.now();
		switch (entry.type) {
			case "message": {
				const wire = messageToWire(entry.message, {
					id: entry.id,
					ts,
					timing: entry.timing,
					detailsCharLimit: charLimit,
				});
				if (wire) items.push(wire);
				break;
			}
			case "custom":
				if (entry.customType === "web-git-status" && entry.data && typeof entry.data === "object")
					items.push({
						kind: "gitStatus",
						id: entry.id,
						ts,
						result: sanitizeDetails(entry.data, charLimit) as Record<string, unknown>,
					});
				else if (entry.customType === RUN_CHANGES_ENTRY) {
					const card = runChangesToWire(entry.id, ts, entry.data);
					if (card) items.push(card);
				} else {
					items.push({
						kind: "custom",
						id: entry.id,
						ts,
						customType: entry.customType,
						text: typeof entry.data === "string" ? entry.data : "",
						images: [],
						display: false,
						details: sanitizeDetails(entry.data, charLimit),
					});
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
					details: sanitizeDetails(entry.details, charLimit),
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
					...(entry.firstKeptEntryId ? { firstKeptEntryId: entry.firstKeptEntryId } : {}),
					...(entry.usageSource ? { usageSource: entry.usageSource } : {}),
					...(entry.usage ? { usage: wireUsage(entry.usage) } : {}),
					...(entry.details !== undefined ? { details: sanitizeDetails(entry.details, charLimit) } : {}),
				});
				break;
			case "branch_summary":
				if (entry.summary) {
					items.push({
						kind: "branchSummary",
						id: entry.id,
						ts,
						summary: entry.summary,
						fromId: entry.fromId,
						...(entry.usage ? { usage: wireUsage(entry.usage) } : {}),
						...(entry.details !== undefined ? { details: sanitizeDetails(entry.details, charLimit) } : {}),
					});
				}
				break;
			case "label":
				items.push({
					kind: "label",
					id: entry.id,
					ts,
					targetId: entry.targetId,
					...(entry.label !== undefined ? { label: entry.label } : {}),
				});
				break;
			default:
				break;
		}
	}
	return items;
}
