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
import type { SessionEntry, SessionTreeNode } from "../../session/types.ts";
import { pathIdentityKey } from "../../utils/paths.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

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

export function registerSessionRoutes(server: WebHttpServer, host: WebHost): void {
	const sessionDir = () =>
		host.session.sessionManager.usesDefaultSessionDir() ? undefined : host.session.sessionManager.getSessionDir();
	const useCase = new WorkspaceSessionUseCase({
		getSessionDir: sessionDir,
		getCurrentSessionPath: () => host.session.sessionFile,
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

	server.route("GET", "/api/workspaces", () => {
		const cwd = host.session.sessionManager.getCwd();
		const current = host.workspaceStore.getByPath(cwd);
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

	server.route("GET", "/api/workspaces/sessions", async ({ url }) => {
		const rootPath = url.searchParams.get("path");
		if (!rootPath) throw new HttpError(400, "Missing path");
		const sessions = await useCase.listSessions(rootPath);
		const currentFile = host.session.sessionFile;
		return {
			sessions: sessions
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.map((info) => ({
					path: info.path,
					id: info.id,
					name: info.name ?? null,
					firstMessage: info.firstMessage,
					created: info.created.getTime(),
					modified: info.modified.getTime(),
					messageCount: info.messageCount,
					parentSessionPath: info.parentSessionPath ?? null,
					current: currentFile !== undefined && pathIdentityKey(info.path) === pathIdentityKey(currentFile),
				})),
		};
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

	server.route("POST", "/api/workspaces/remove", ({ body }) => {
		const id = asString(asObject(body).id, "id");
		const workspace = host.workspaceStore.getById(id);
		if (!workspace) throw new HttpError(404, "Unknown workspace");
		if (host.workspaceStore.getByPath(host.session.sessionManager.getCwd())?.workspaceId === id) {
			throw new HttpError(409, "The current workspace cannot be removed.");
		}
		host.workspaceStore.remove(id);
		return { ok: true };
	});

	server.route("POST", "/api/sessions/new", async ({ body }) => {
		requireIdle("start a new session");
		const rootPath =
			typeof asObject(body ?? {}).rootPath === "string" ? (asObject(body).rootPath as string) : undefined;
		const cwd = host.session.sessionManager.getCwd();
		const error = rootPath
			? await useCase.createSessionInWorkspace(rootPath, cwd)
			: await host.runtimeHost.newSession().then((result) => (result.cancelled ? "Cancelled." : undefined));
		if (error) throw new HttpError(400, error);
		return { ok: true };
	});

	server.route("POST", "/api/sessions/open", async ({ body }) => {
		requireIdle("switch sessions");
		const path = asString(asObject(body).path, "path");
		const cwdOverride =
			typeof asObject(body).cwdOverride === "string" ? (asObject(body).cwdOverride as string) : undefined;
		try {
			const result = await host.runtimeHost.switchSession(path, {
				cwdOverride,
				projectTrustContextFactory: (cwd) => host.createProjectTrustContext(cwd),
			});
			return { cancelled: result.cancelled };
		} catch (error) {
			if (error instanceof MissingSessionCwdError) {
				throw new HttpError(409, `${error.message}`);
			}
			throw new HttpError(500, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/sessions/delete", async ({ body }) => {
		const path = asString(asObject(body).path, "path");
		const error = await useCase.deleteSession(path);
		if (error) throw new HttpError(409, error);
		return { ok: true };
	});

	server.route("POST", "/api/sessions/clear", async ({ body }) => {
		const rootPath = asString(asObject(body).rootPath, "rootPath");
		const error = await useCase.clearSessions(rootPath);
		if (error) throw new HttpError(409, error);
		return { ok: true };
	});

	const isCurrent = (path: string) =>
		host.session.sessionFile !== undefined && pathIdentityKey(path) === pathIdentityKey(host.session.sessionFile);

	const applyTitle = (path: string, rawTitle: string, manager?: SessionManager): string => {
		const title = normalizeConversationTitle(rawTitle);
		const validation = validateConversationTitle(title);
		if (validation) throw new HttpError(400, validation);
		if (isCurrent(path)) {
			if (!host.session.isIdle)
				throw new HttpError(409, "The title cannot be changed while the session is running.");
			host.session.setSessionName(title);
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
			const current = isCurrent(path);
			if (current && !host.session.isIdle)
				throw new HttpError(409, "The title cannot be generated while the session is running.");
			const manager = current ? host.session.sessionManager : SessionManager.open(path);
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
