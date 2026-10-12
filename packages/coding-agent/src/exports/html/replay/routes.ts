/**
 * Embedded routes table for standalone HTML replay export.
 *
 * Implements the mock backend route table needed by the Web UI frontend during boot
 * and interactive inspection (transcript, state, modes, stats, models, workspaces, slots,
 * resources, and flattened card-diff endpoints).
 *
 * - Uncovered GET requests return `{}` with 200 OK without errors.
 * - Non-GET requests return 405 with `{ error: "Read only" }`.
 */

import type { WireItem } from "../../../modes/web/wire.ts";
import type { ProjectedSession } from "./project.ts";

export interface BuildRoutesOptions {
	projection: ProjectedSession;
	prefs?: Record<string, unknown>;
	detailsLimit?: number | null;
}

export interface BuildRoutesResult {
	routes: Record<string, unknown>;
	prefs: Record<string, unknown>;
	slotStatus: Record<string, unknown>;
}

export interface RouteResponse {
	ok: boolean;
	status: number;
	data: unknown;
}

export function buildRoutes({ projection, prefs = {}, detailsLimit }: BuildRoutesOptions): BuildRoutesResult {
	const snapshot = { ...projection.snapshot };
	if (detailsLimit !== undefined && detailsLimit !== null) {
		snapshot.exportDetailsLimit = detailsLimit;
	}
	const mode = String(snapshot.mode ?? "coding");
	const altMode = mode === "coding" ? "general" : "coding";
	const viewPrefs = { ...prefs, chatMode: mode };
	const slot = "export";
	const emptyModeState = { lastSessionFile: null, model: null, drafts: {} };
	const firstMsg = firstUserText(projection.items);
	const lastActivity = lastTs(projection.items);
	const sessionTimestamp =
		Date.parse((snapshot.session as { header?: { timestamp?: string } } | undefined)?.header?.timestamp ?? "") ||
		Date.now();

	const slotStatus = {
		mode,
		slot,
		sessionFile: projection.meta.file,
		sessionId: projection.meta.sessionId,
		cwd: snapshot.cwd,
		name: projection.meta.name,
		firstMessage: firstMsg,
		hasContent: projection.items.length > 0,
		active: false,
		waiting: false,
		completion: false,
		lastOutcome: (snapshot.lastRun as { outcome?: string } | null | undefined)?.outcome ?? null,
		unread: false,
		unbound: !snapshot.workspace,
		lastActivityAt: lastActivity,
		conversationNaming: null,
	};

	const sessionSummary = {
		path: projection.meta.file,
		mode,
		id: projection.meta.sessionId,
		name: projection.meta.name,
		firstMessage: firstMsg,
		created: sessionTimestamp,
		modified: lastActivity ?? Date.now(),
		messageCount: projection.items.length,
		blank: projection.items.length === 0,
		parentSessionPath: null,
		pinned: false,
		current: true,
	};

	const snapshotWorkspace = snapshot.workspace as { id?: string; rootPath?: string } | null | undefined;
	const workspace = {
		id: snapshotWorkspace?.id ?? "export",
		name: snapshotWorkspace?.id ?? "Exported workspace",
		rootPath: snapshot.cwd,
		current: true,
	};

	const routes: Record<string, unknown> = {
		"/api/boot": {
			instanceId: "export",
			worktreeService: null,
			phase: "ready",
			detail: null,
			version: `${String((snapshot.app as { version?: string } | undefined)?.version ?? "export-replay")}-replay`,
			dialogs: [],
		},
		"/api/state": snapshot,
		"/api/modes/state": { coding: emptyModeState, general: emptyModeState },
		"/api/transcript": { items: projection.items, leafId: projection.leafId },
		"/api/slots": { slots: [slotStatus] },
		[`/api/workspaces?mode=${mode}`]: {
			currentPath: snapshot.cwd,
			currentSessionFile: projection.meta.file,
			workspaces: [workspace],
		},
		[`/api/workspaces?mode=${altMode}`]: {
			currentPath: snapshot.cwd,
			currentSessionFile: null,
			workspaces: [],
		},
		"/api/workspaces": {
			currentPath: snapshot.cwd,
			currentSessionFile: projection.meta.file,
			workspaces: [workspace],
		},
		[`/api/workspaces/sessions?path=${encodeURIComponent(String(snapshot.cwd))}&mode=${mode}`]: {
			sessions: [sessionSummary],
		},
		"/api/workspaces/sessions": { sessions: [sessionSummary] },
		[`/api/sessions/unbound?mode=${mode}`]: { sessions: [] },
		[`/api/sessions/unbound?mode=${altMode}`]: { sessions: [] },
		"/api/sessions/unbound": { sessions: [] },
		[`/api/sessions/archived?mode=${mode}`]: { sessions: [] },
		[`/api/sessions/archived?mode=${altMode}`]: { sessions: [] },
		"/api/sessions/archived": { sessions: [] },
		"/api/sessions/tree": { nodes: [] },
		"/api/git/status": null,
		"/api/settings": { items: [], menu: [], errors: [] },
		"/api/providers": { providers: [] },
		"/api/sessions/stats": projection.stats,
		"/api/models": modelsFromProjection(projection),
		"/api/resources": {
			tools: [],
			skills: [],
			prompts: [],
			extensions: [],
			extensionErrors: [],
			contextFiles: [],
			commands: [],
			diagnostics: [],
		},
	};

	// 变更卡片的文件 diff：会话里 web-run-changes 的 data.files[] 本来带着 patch，展开摊平成路由
	const cardDiffRoute = (
		entryId: string,
		runId: number,
		filePath: string,
		summary: Record<string, unknown>,
		patch?: string,
	) => {
		const params = new URLSearchParams({ id: entryId, runId: String(runId), path: filePath });
		routes[`/api/changes/card-diff?${params.toString()}`] = {
			summary,
			...(patch ? { patch } : {}),
		};
	};

	for (const entry of projection.entries ?? []) {
		if (entry.type !== "custom" || entry.customType !== "web-run-changes") continue;
		const card = (entry.data ?? {}) as { runId?: unknown; files?: unknown[]; patch?: string };
		const runId = Number(card.runId) || 0;
		const files = Array.isArray(card.files) ? card.files : [];
		for (const file of files) {
			if (!file || typeof file !== "object" || typeof (file as { path?: unknown }).path !== "string") continue;
			const f = file as {
				path: string;
				patch?: unknown;
				patchOmitted?: unknown;
				additions?: unknown;
				added?: unknown;
				deletions?: unknown;
				removed?: unknown;
				binary?: unknown;
				[k: string]: unknown;
			};
			const { patch, patchOmitted, ...rest } = f;
			const summary: Record<string, unknown> = {
				...rest,
				additions: Number(f.additions ?? f.added) || 0,
				deletions: Number(f.deletions ?? f.removed) || 0,
				binary: f.binary === true,
			};
			const single = files.length === 1 && typeof card.patch === "string" ? card.patch : undefined;
			const effPatch = typeof patch === "string" ? patch : single;
			if (patchOmitted && !effPatch) {
				summary.unavailable = "The diff of this file was too large to keep with the chat.";
			}
			cardDiffRoute(entry.id, runId, f.path, summary, effPatch);
		}
	}

	if (!routes["/api/changes/card-diff"]) {
		routes["/api/changes/card-diff"] = {
			summary: { unavailable: "This diff was not embedded in the export." },
		};
	}

	return { routes, prefs: viewPrefs, slotStatus };
}

export function handleRouteRequest(
	routes: Record<string, unknown>,
	path: string,
	method: string = "GET",
): RouteResponse {
	const upper = method.toUpperCase();
	if (upper !== "GET" && upper !== "HEAD") {
		return {
			ok: false,
			status: 405,
			data: { error: "Read only" },
		};
	}
	const data = lookupRoute(routes, path);
	if (data !== undefined) {
		return {
			ok: true,
			status: 200,
			data,
		};
	}
	return {
		ok: true,
		status: 200,
		data: {},
	};
}

export function lookupRoute(routes: Record<string, unknown>, path: string): unknown {
	let pathname: string;
	let search: string;
	try {
		const u = new URL(path, "http://export.invalid");
		pathname = u.pathname;
		search = u.search;
	} catch {
		const q = path.indexOf("?");
		pathname = q >= 0 ? path.slice(0, q) : path;
		search = q >= 0 ? path.slice(q) : "";
	}

	const exact = routes[pathname + search];
	if (exact !== undefined) return exact;

	const byPath = routes[pathname];
	if (byPath !== undefined) return byPath;

	// Query params matching (e.g. /api/changes/card-diff?id=...&runId=...&path=...)
	const qIndex = path.indexOf("?");
	if (qIndex >= 0) {
		try {
			const targetUrl = new URL(path, "http://export.invalid");
			for (const k of Object.keys(routes)) {
				if (k.startsWith(`${pathname}?`)) {
					const want = new URL(k, "http://export.invalid");
					let same = true;
					want.searchParams.forEach((v, kk) => {
						if (targetUrl.searchParams.get(kk) !== v) same = false;
					});
					if (same) return routes[k];
				}
			}
		} catch {
			// Ignore parse errors on unusual patterns
		}
	}

	return routes["*"];
}

export function modelsFromProjection(projection: ProjectedSession): Record<string, unknown> {
	const seen = new Map<string, string>();
	for (const item of projection.items) {
		if (item.kind === "assistant" && item.model) {
			seen.set(`${item.provider}/${item.model}`, item.model);
		}
	}
	const snapshotModel = projection.snapshot.model as { provider?: string; id?: string } | null | undefined;
	const provider = snapshotModel?.provider ?? "unknown";
	if (snapshotModel?.id) {
		seen.set(`${provider}/${snapshotModel.id}`, snapshotModel.id);
	}
	const models = [...new Set(seen.values())].map((id) => ({
		provider,
		id,
		name: id,
		reasoning: false,
		contextWindow: 0,
		maxTokens: 0,
		input: ["text"],
	}));
	return {
		current: snapshotModel ? { provider, id: snapshotModel.id } : null,
		providers: models.length ? [{ id: provider, name: provider, models }] : [],
		scoped: [],
		defaults: { provider: null, model: null, thinkingLevel: null },
		error: null,
		currentAvailable: models.length > 0,
	};
}

export function firstUserText(items: readonly WireItem[]): string {
	for (const item of items) {
		if (item.kind === "user" && item.text) {
			return item.text.replace(/\s+/g, " ").trim().slice(0, 200);
		}
	}
	return "";
}

export function lastTs(items: readonly WireItem[]): number | null {
	for (let i = items.length - 1; i >= 0; i--) {
		if (typeof items[i].ts === "number") return items[i].ts;
	}
	return null;
}
