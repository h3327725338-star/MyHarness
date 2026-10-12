/**
 * Session data projection for standalone HTML replay export.
 *
 * Projects a persisted session (via SessionManager) into the wire items, snapshot,
 * usage stats, model info, and metadata expected by the Web UI frontend on startup,
 * without running a Web server or AgentSessionRuntime.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	entriesToWire,
	RUN_CHANGES_ENTRY,
	sanitizeDetails,
	type WireItem,
	type WireModel,
} from "../../../modes/web/wire.ts";
import { collectSessionUsageStats, type SessionUsageStats } from "../../../observability/session-stats.ts";
import { SessionManager } from "../../../session/manager/index.ts";
import type { SessionEntry, SessionHeader } from "../../../session/types.ts";

export interface ProjectSessionOptions {
	file?: string;
	sessionManager?: SessionManager;
	prefs?: Record<string, unknown>;
	detailsCharLimit?: number;
	exporterVersion?: string;
}

export interface ProjectedSessionMeta {
	sessionId: string | null;
	name: string | null;
	cwd: string;
	mode: string;
	workspaceId: string | null;
	headerTimestamp: string | null;
	entryCount: number;
	branchCount: number;
	file: string | null;
}

export interface ProjectedSession {
	items: WireItem[];
	entries: readonly SessionEntry[];
	branch: readonly SessionEntry[];
	leafId: string | null;
	stats: SessionUsageStats;
	snapshot: Record<string, unknown>;
	meta: ProjectedSessionMeta;
	rawJsonl: string;
	entryTypes: Record<string, number>;
}

export function projectSession(
	fileOrOptions: string | ProjectSessionOptions,
	maybeOptions?: ProjectSessionOptions,
): ProjectedSession {
	const options: ProjectSessionOptions =
		typeof fileOrOptions === "string"
			? { file: fileOrOptions, ...maybeOptions }
			: { ...fileOrOptions, ...maybeOptions };

	let manager: SessionManager;
	let jsonlPath: string | null = options.file ?? null;

	if (options.sessionManager) {
		manager = options.sessionManager;
		jsonlPath = jsonlPath ?? manager.getSessionFile() ?? null;
	} else if (options.file) {
		manager = SessionManager.open(options.file);
	} else {
		throw new Error("projectSession requires either 'file' or 'sessionManager'");
	}

	const header = manager.getHeader();
	const branch = manager.getBranch();
	const entries = manager.getEntries();
	const branchIds = new Set(branch.map((e) => e.id));
	const branchLabels: SessionEntry[] = [];
	for (const e of entries) {
		if (e.type === "label" && branchIds.has(e.targetId) && !branchIds.has(e.id)) {
			branchLabels.push(e);
		}
	}
	const projectedBranch = branchLabels.length ? [...branch, ...branchLabels] : branch;
	const items = entriesToWire(projectedBranch, { detailsCharLimit: options.detailsCharLimit });
	const stats = collectSessionUsageStats(entries);

	let rawJsonl = "";
	if (jsonlPath && existsSync(jsonlPath)) {
		rawJsonl = readFileSync(jsonlPath, "utf8");
	} else {
		const lines: string[] = [];
		if (header) lines.push(JSON.stringify(header));
		for (const entry of entries) {
			lines.push(JSON.stringify(entry));
		}
		rawJsonl = lines.length ? `${lines.join("\n")}\n` : "";
	}

	return {
		items,
		entries,
		branch,
		leafId: manager.getLeafId(),
		stats,
		snapshot: offlineSnapshot({ manager, header, stats, jsonlPath, options }),
		meta: {
			sessionId: header?.id ?? null,
			name: manager.getSessionName() ?? null,
			cwd: manager.getCwd(),
			mode: manager.getMode(),
			workspaceId: header?.workspaceId ?? null,
			headerTimestamp: header?.timestamp ?? null,
			entryCount: entries.length,
			branchCount: branch.length,
			file: jsonlPath,
		},
		rawJsonl,
		entryTypes: countBy(entries, (e) => (e.type === "message" ? `message/${e.message.role}` : e.type)),
	};
}

function countBy<T>(list: readonly T[], key: (item: T) => string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of list) {
		const k = key(item);
		out[k] = (out[k] ?? 0) + 1;
	}
	return out;
}

interface OfflineSnapshotContext {
	manager: SessionManager;
	header: SessionHeader | null;
	stats: SessionUsageStats;
	jsonlPath: string | null;
	options: ProjectSessionOptions;
}

function offlineSnapshot({
	manager,
	header,
	stats,
	jsonlPath,
	options,
}: OfflineSnapshotContext): Record<string, unknown> {
	const name = manager.getSessionName() ?? null;
	const lastModel = lastModelOf(manager);
	return {
		mode: manager.getMode(),
		slot: "export",
		gitTask: null,
		memoryMaintenance: null,
		app: {
			version: `export-${String(options.exporterVersion ?? "replay")}`,
			startedAt: Date.parse(header?.timestamp ?? "") || Date.now(),
			platform: process.platform,
		},
		cwd: manager.getCwd(),
		workspace: header?.workspaceId ? { id: header.workspaceId, name: null, rootPath: manager.getCwd() } : null,
		session: {
			id: header?.id ?? null,
			file: jsonlPath,
			name,
			persisted: true,
			header: header ? { timestamp: header.timestamp } : null,
		},
		model: lastModel ? toWireModelLike(lastModel) : null,
		thinking: { level: lastThinkingLevelOf(manager) ?? "off", levels: [], supported: false },
		run: { state: "completed", activity: null, runId: 0 },
		active: false,
		flags: {
			streaming: false,
			compacting: false,
			retrying: false,
			bashRunning: false,
			completion: false,
			completionStatus: null,
			mirror: false,
			background: 0,
		},
		queue: { steering: [], followUp: [] },
		queueModes: { steering: "steer", followUp: "followUp" },
		context: contextFromStats(stats),
		speed: null,
		cache: cacheFromStats(stats),
		autoCompaction: false,
		autoRetry: false,
		trust: { trusted: true, requiresTrust: false },
		git: { enabled: false },
		checkpoint: null,
		dialogs: [],
		surface: { statuses: {}, widgets: {}, workingVisible: true, notices: [] },
		editorText: null,
		diagnostics: [],
		modelFallbackMessage: null,
		lastRun: lastRunFromSession(manager),
		extensionErrors: [],
	};
}

function lastModelOf(manager: SessionManager): { provider: string; id: string } | null {
	let model: { provider: string; id: string } | null = null;
	for (const entry of manager.getEntries()) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const m = entry.message as { provider?: string; model?: string };
			if (m.provider && m.model) {
				model = { provider: m.provider, id: m.model };
			}
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, id: entry.modelId };
		}
	}
	return model;
}

function toWireModelLike({ provider, id }: { provider: string; id: string }): WireModel {
	return {
		provider,
		id,
		name: id,
		reasoning: false,
		contextWindow: 0,
		maxTokens: 0,
		input: ["text"],
	};
}

function lastThinkingLevelOf(manager: SessionManager): string | null {
	let level: string | null = null;
	for (const entry of manager.getEntries()) {
		if (entry.type === "thinking_level_change") {
			level = entry.thinkingLevel;
		}
	}
	return level;
}

function contextFromStats(stats: SessionUsageStats) {
	const tokens = stats.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return {
		tokens: tokens.total || 0,
		contextWindow: 0,
		percent: null,
		usageEstimated: true,
		breakdown: stats.tokens,
	};
}

function cacheFromStats(stats: SessionUsageStats) {
	return stats.cache ?? null;
}

function lastRunFromSession(manager: SessionManager) {
	let runId = 0;
	let endedAt: number | null = null;
	let outcome: string | null = null;
	for (const entry of manager.getEntries()) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m?.role === "assistant") {
			runId += 1;
			endedAt = Date.parse(entry.timestamp) || null;
			outcome = m.stopReason === "error" ? "failed" : m.stopReason === "aborted" ? "cancelled" : "completed";
		}
	}
	if (!outcome) return null;
	return { runId, endedAt, outcome, files: 0, error: null };
}

export { entriesToWire, sanitizeDetails, RUN_CHANGES_ENTRY };
