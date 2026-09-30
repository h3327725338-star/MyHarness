/** Web API routes for Workspaces, Sessions, session tree navigation and export. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateConversationTitle,
	normalizeConversationTitle,
	validateConversationTitle,
} from "../../agent/runtime/conversation-title.ts";
import { WorkspaceSessionUseCase } from "../../application/use-cases/workspace-session.ts";
import { MissingSessionCwdError } from "../../session/manager/cwd.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { deleteSessionFile } from "../../session/storage/jsonl/file-operations.ts";
import type { SessionEntry, SessionInfo, SessionTreeNode } from "../../session/types.ts";
import { pathIdentityKey } from "../../utils/paths.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import type { WebHostHub } from "./hub.ts";

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

function asString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new HttpError(400, `"${name}" must be a non-empty string`);
	return value;
}

function entryPreview(entry: SessionEntry): { kind: string; text: string } {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "user") {
				const content = message.content;
				const text =
					typeof content === "string"
						? content
						: content
								.filter((part) => part.type === "text")
								.map((part) => (part as { text: string }).text)
								.join("");
				return { kind: "user", text };
			}
			if (message.role === "assistant") {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => (part as { text: string }).text)
					.join("");
				const tools = message.content.filter((part) => part.type === "toolCall").length;
				return { kind: "assistant", text: text || (tools ? `(${tools} tool call${tools > 1 ? "s" : ""})` : "") };
			}
			if (message.role === "toolResult") return { kind: "toolResult", text: message.toolName };
			if (message.role === "bashExecution") return { kind: "bash", text: message.command };
			return { kind: message.role, text: "" };
		}
		case "compaction":
			return { kind: "compaction", text: "Context compacted" };
		case "branch_summary":
			return { kind: "branchSummary", text: "Branch summary" };
		case "custom_message":
			return { kind: "custom", text: entry.customType };
		case "model_change":
			return { kind: "model", text: `${entry.provider}/${entry.modelId}` };
		case "thinking_level_change":
			return { kind: "thinking", text: entry.thinkingLevel };
		case "label":
			return { kind: "label", text: entry.label ?? "" };
		case "session_info":
			return { kind: "info", text: entry.name ?? "" };
		default:
			return { kind: entry.type, text: "" };
	}
}

interface TreeRow {
	id: string;
	parentId: string | null;
	depth: number;
	kind: string;
	text: string;
	ts: number;
	label?: string;
	onPath: boolean;
	isLeaf: boolean;
	childCount: number;
}

function flattenTree(nodes: SessionTreeNode[], pathIds: Set<string>, leafId: string | null): TreeRow[] {
	const rows: TreeRow[] = [];
	const visit = (node: SessionTreeNode, depth: number) => {
		const preview = entryPreview(node.entry);
		rows.push({
			id: node.entry.id,
			parentId: node.entry.parentId,
			depth,
			kind: preview.kind,
			text: preview.text.slice(0, 240),
			ts: Date.parse(node.entry.timestamp) || 0,
			...(node.label ? { label: node.label } : {}),
			onPath: pathIds.has(node.entry.id),
			isLeaf: node.entry.id === leafId,
			childCount: node.children.length,
		});
		for (const child of node.children) visit(child, node.children.length > 1 ? depth + 1 : depth);
	};
	for (const node of nodes) visit(node, 0);
	return rows;
}

export function registerSessionRoutes(server: WebHttpServer, host: WebHost, hub: WebHostHub): void {
	const sessionDir = () =>
		host.session.sessionManager.usesDefaultSessionDir() ? undefined : host.session.sessionManager.getSessionDir();
	const useCase = new WorkspaceSessionUseCase({
		getSessionDir: sessionDir,
		// Deleting is handled by this file (it is aware of every open session); the use case only lists.
		getCurrentSessionPath: () => undefined,
		isSessionIdle: () => host.session.isIdle,
		newSession: () => host.runtimeHost.newSession(),
		switchWorkspace: (cwd) =>
			host.runtimeHost.switchWorkspace(cwd, {
				projectTrustContextFactory: (nextCwd) => host.createProjectTrustContext(nextCwd),
			}),
	});

	const activeRenames = new Map<string, Promise<unknown>>();

	const requireIdle = (what: string) => {
		if (!host.session.isIdle || host.completionActive) {
			throw new HttpError(409, `Cannot ${what} while a task is running.`);
		}
	};

	server.route("GET", "/api/slots", () => ({ slots: hub.statuses() }));

	// The browser shows this session's latest result to the user: clears its "unread" marker.
	server.route("POST", "/api/seen", () => {
		host.markResultsSeen();
		return { ok: true };
	});

	server.route("GET", "/api/workspaces", () => {
		const cwd = host.session.sessionManager.getCwd();
		const current = host.workspace;
		return {
			currentPath: cwd,
			currentSessionFile: host.session.sessionFile ?? null,
			workspaces: host.workspaceStore.list().map((workspace) => ({
				id: workspace.workspaceId,
				name: workspace.name,
				rootPath: workspace.rootPath,
				current: current?.workspaceId === workspace.workspaceId,
			})),
		};
	});

	const sessionSummary = (info: SessionInfo) => {
		const currentFile = host.session.sessionFile;
		return {
			path: info.path,
			id: info.id,
			name: info.name ?? null,
			firstMessage: info.firstMessage,
			created: info.created.getTime(),
			modified: info.modified.getTime(),
			messageCount: info.messageCount,
			parentSessionPath: info.parentSessionPath ?? null,
			current: currentFile !== undefined && pathIdentityKey(info.path) === pathIdentityKey(currentFile),
		};
	};

	server.route("GET", "/api/workspaces/sessions", async ({ url }) => {
		const rootPath = url.searchParams.get("path");
		if (!rootPath) throw new HttpError(400, "Missing path");
		const sessions = await useCase.listSessions(rootPath);
		return { sessions: sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime()).map(sessionSummary) };
	});

	/** Chats that belong to no registered Workspace: created without one, or left behind by a removed Workspace. */
	server.route("GET", "/api/sessions/unbound", async () => {
		const sessions = await SessionManager.listUnbound();
		return { sessions: sessions.map(sessionSummary) };
	});

	server.route("POST", "/api/workspaces/add", ({ body }) => {
		const input = asString(asObject(body).path, "path");
		const result = host.workspaceStore.add(input, host.session.sessionManager.getCwd());
		if (!result.ok || !result.workspace) throw new HttpError(400, result.error ?? "Failed to add workspace");
		return {
			workspace: {
				id: result.workspace.workspaceId,
				name: result.workspace.name,
				rootPath: result.workspace.rootPath,
			},
		};
	});

	/**
	 * Only un-registers the Workspace. The folder, its project files and every chat stay exactly where they are; the
	 * chats simply belong to no Workspace afterwards (see `SessionManager.isUnbound`). Open chats keep running.
	 */
	server.route("POST", "/api/workspaces/remove", ({ body }) => {
		const id = asString(asObject(body).id, "id");
		const workspace = host.workspaceStore.getById(id);
		if (!workspace) throw new HttpError(404, "Unknown workspace");
		if (!host.workspaceStore.remove(id)) throw new HttpError(500, "Could not save the workspace list.");
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});

	// Neither route touches the session the request came from: it keeps running in its own slot.
	server.route("POST", "/api/sessions/new", async ({ body }) => {
		const payload = asObject(body ?? {});
		const rootPath = typeof payload.rootPath === "string" && payload.rootPath ? payload.rootPath : undefined;
		return hub.newSession(host, rootPath, payload.unbound === true);
	});

	server.route("POST", "/api/sessions/open", async ({ body }) => {
		const path = asString(asObject(body).path, "path");
		const cwdOverride =
			typeof asObject(body).cwdOverride === "string" ? (asObject(body).cwdOverride as string) : undefined;
		try {
			return await hub.openSession(host, path, cwdOverride);
		} catch (error) {
			if (error instanceof MissingSessionCwdError) throw new HttpError(409, `${error.message}`);
			if (error instanceof HttpError) throw error;
			throw new HttpError(500, error instanceof Error ? error.message : String(error));
		}
	});

	/**
	 * A session that is open in a slot must be released before its file is deleted. A running one is refused.
	 * The slot the request came from stays alive with a fresh chat, so the browser always has a session to show.
	 */
	const releaseSessionSlots = async (path: string): Promise<void> => {
		const showing = hub.slotsShowing(path);
		for (const slot of showing) {
			if (!slot.session.isIdle || slot.completionActive) {
				throw new HttpError(409, "A running chat cannot be deleted. Stop it first.");
			}
		}
		for (const slot of showing) {
			if (slot === host || hub.all().length === 1) {
				const result = await slot.runtimeHost.newSession();
				if (result.cancelled) throw new HttpError(409, "Cancelled.");
			} else {
				await hub.closeSlot(slot);
			}
		}
	};

	server.route("POST", "/api/sessions/delete", async ({ body }) => {
		const path = asString(asObject(body).path, "path");
		await releaseSessionSlots(path);
		const deleted = await deleteSessionFile(path);
		if (!deleted.ok) throw new HttpError(409, deleted.error ?? "Failed to delete the chat.");
		return { ok: true };
	});

	server.route("POST", "/api/sessions/clear", async ({ body }) => {
		const rootPath = asString(asObject(body).rootPath, "rootPath");
		const sessions = await useCase.listSessions(rootPath);
		for (const session of sessions) await releaseSessionSlots(session.path);
		for (const session of sessions) {
			const deleted = await deleteSessionFile(session.path);
			if (!deleted.ok) throw new HttpError(409, deleted.error ?? "Failed to delete the chat.");
		}
		return { ok: true };
	});

	/** The slot that has this session open, if any: its runtime owns the file while it is loaded. */
	const openSlot = (path: string): WebHost | undefined => hub.slotsShowing(path)[0];

	const applyTitle = (path: string, rawTitle: string, manager?: SessionManager): string => {
		const title = normalizeConversationTitle(rawTitle);
		const validation = validateConversationTitle(title);
		if (validation) throw new HttpError(400, validation);
		const owner = openSlot(path);
		if (owner) {
			if (!owner.session.isIdle)
				throw new HttpError(409, "The title cannot be changed while the session is running.");
			owner.session.setSessionName(title);
		} else {
			(manager ?? SessionManager.open(path)).appendSessionInfo(title);
		}
		return title;
	};

	server.route("POST", "/api/sessions/rename", ({ body }) => {
		const payload = asObject(body);
		const title = applyTitle(asString(payload.path, "path"), asString(payload.title, "title"));
		return { title };
	});

	server.route("POST", "/api/sessions/rename-ai", async ({ body }) => {
		const path = asString(asObject(body).path, "path");
		const key = pathIdentityKey(path);
		const existing = activeRenames.get(key);
		if (existing) return existing;
		const operation = (async () => {
			const owner = openSlot(path);
			if (owner && !owner.session.isIdle)
				throw new HttpError(409, "The title cannot be generated while the session is running.");
			const manager = owner ? owner.session.sessionManager : SessionManager.open(path);
			const result = await generateConversationTitle({
				sessionManager: manager,
				modelRuntime: host.session.modelRuntime,
				settingsManager: host.session.settingsManager,
				fallbackModel: host.session.model,
			});
			if (result.status === "skipped") return { status: "skipped", reason: result.reason };
			const title = applyTitle(path, result.title, manager);
			return { status: "renamed", title };
		})();
		activeRenames.set(key, operation);
		const clear = () => {
			if (activeRenames.get(key) === operation) activeRenames.delete(key);
		};
		operation.then(clear, clear);
		return operation;
	});

	server.route("GET", "/api/sessions/tree", () => {
		const manager = host.session.sessionManager;
		const leafId = manager.getLeafId();
		const pathIds = new Set(manager.getBranch().map((entry) => entry.id));
		return { leafId, rows: flattenTree(manager.getTree(), pathIds, leafId) };
	});

	server.route("POST", "/api/sessions/navigate", async ({ body }) => {
		requireIdle("navigate the session tree");
		const payload = asObject(body);
		const targetId = asString(payload.targetId, "targetId");
		const result = await host.session.navigateTree(targetId, {
			summarize: payload.summarize === true,
			customInstructions: typeof payload.customInstructions === "string" ? payload.customInstructions : undefined,
			label: typeof payload.label === "string" ? payload.label : undefined,
		});
		host.broadcast("session_replaced", { at: Date.now() });
		return { cancelled: result.cancelled, editorText: result.editorText ?? null };
	});

	server.route("POST", "/api/sessions/fork", async ({ body }) => {
		requireIdle("fork the session");
		const payload = asObject(body);
		const entryId = asString(payload.entryId, "entryId");
		const position = payload.position === "at" ? "at" : "before";
		const result = await host.runtimeHost.fork(entryId, { position });
		return { cancelled: result.cancelled, selectedText: result.selectedText ?? null };
	});

	server.route("GET", "/api/sessions/export", async ({ res }) => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-export-"));
		try {
			const file = join(directory, "session.html");
			await host.session.exportToHtml(file);
			const html = readFileSync(file);
			const name = `${(host.session.sessionName ?? host.session.sessionId).replace(/[^\w.-]+/g, "_").slice(0, 60) || "session"}.html`;
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-disposition": `attachment; filename="${name}"`,
				"content-length": html.length,
			});
			res.end(html);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	server.route("GET", "/api/sessions/stats", () => host.session.getSessionStats());
}
