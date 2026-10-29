/** Web API routes for Workspaces, Sessions, session tree navigation and export. */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import {
	generateConversationTitle,
	normalizeConversationTitle,
	validateConversationTitle,
} from "../../agent/runtime/conversation-title.ts";
import { WorkspaceSessionUseCase } from "../../application/use-cases/workspace-session.ts";
import { getDataDir, getWorkspacesDir } from "../../config/paths/index.ts";
import {
	deleteWorkspaceSource,
	finishWorkspaceSourceUpload,
	listWorkspaceSources,
	readWorkspaceSourceTree,
	type StagedWorkspaceSourceUpload,
	stageWorkspaceSourceUploads,
	uploadWorkspaceSource,
	WorkspaceSourceError,
	type WorkspaceSourceUploadItem,
	writeWorkspaceSourceChunk,
} from "../../data/workspace-sources.ts";
import { buildReplayHtml } from "../../exports/html/replay/build.ts";
import { buildExportTooLargeBody, ReplayExportTooLargeError } from "../../exports/html/replay/limits.ts";
import { isWorktreeCopyPath } from "../../git/worktrees/merged-records.ts";
import { deleteWorkspaceArtifacts } from "../../session/artifacts/store.ts";
import {
	buildSessionContinuation,
	SESSION_CONTINUATION_TYPE,
	SESSION_CONTINUATION_UNLINKED_TYPE,
} from "../../session/history/continuation.ts";
import { MissingSessionCwdError } from "../../session/manager/cwd.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { deleteSessionFile, summarizeSessionDeletion } from "../../session/storage/jsonl/file-operations.ts";
import { readSessionHeader } from "../../session/storage/jsonl/index.ts";
import {
	getIndexedSessionMarkers,
	isSessionPathIndexed,
	patchIndexMarker,
} from "../../session/storage/jsonl/sessions-index.ts";
import {
	type ChatMode,
	getChatMode,
	type SessionEntry,
	type SessionInfo,
	type SessionTreeNode,
} from "../../session/types.ts";
import { pathIdentityKey } from "../../utils/paths.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type RequestContext, type WebHttpServer } from "./http-server.ts";
import type { WebHostHub } from "./hub.ts";

/** Optional `limit` (1-200) / `offset` pagination for session lists. Exported for tests. */
export function parseSessionListPagination(url: URL): { limit: number; offset: number } | undefined {
	const limitRaw = url.searchParams.get("limit");
	const offsetRaw = url.searchParams.get("offset");
	if (limitRaw === null && offsetRaw === null) return undefined;
	const limit = limitRaw === null ? 50 : Number(limitRaw);
	const offset = offsetRaw === null ? 0 : Number(offsetRaw);
	if (!Number.isInteger(limit) || limit < 1 || limit > 200)
		throw new HttpError(400, '"limit" must be an integer 1-200');
	if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, '"offset" must be a non-negative integer');
	return { limit, offset };
}

/** Slice an already (modified-desc) sorted summary list. Without pagination the shape is unchanged (no `total`). */
export function paginateSessionSummaries<T>(
	summaries: T[],
	pagination?: { limit: number; offset: number },
): { sessions: T[]; total?: number } {
	if (!pagination) return { sessions: summaries };
	return {
		sessions: summaries.slice(pagination.offset, pagination.offset + pagination.limit),
		total: summaries.length,
	};
}

/**
 * Whether `path` lies inside `root`, compared by path identity (case-insensitive on Windows). Identity keys use the
 * platform separator, so the prefix test does too: a `/` never matches a Windows key. Exported for tests.
 */
export function isPathInsideRoot(path: string, root: string): boolean {
	const rootKey = pathIdentityKey(root);
	const key = pathIdentityKey(path);
	return key === rootKey || key.startsWith(rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`);
}

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
	/**
	 * Saved chats checked per uninterrupted step while the archive is selected. One step stays around a hundred
	 * milliseconds even when a chat's index has to be read, so requests that have nothing to do with the archive are
	 * served between steps instead of waiting for the whole list.
	 */
	const ARCHIVED_SCAN_SLICE = 50;
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
	const requestMode = (value?: unknown): ChatMode => {
		if (value === undefined || value === null) return host.session.sessionManager.getMode();
		if (value !== "coding" && value !== "general") throw new HttpError(400, "Invalid chat mode");
		return value;
	};

	const requireIdle = (what: string) => {
		if (!host.session.isIdle || host.completionActive || host.gitTask) {
			throw new HttpError(409, `Cannot ${what} while a task is running.`);
		}
	};

	server.route("GET", "/api/slots", () => ({ slots: hub.statuses() }));

	// The browser shows this session's latest result to the user: clears its "unread" marker.
	server.route("POST", "/api/seen", () => {
		host.markResultsSeen();
		return { ok: true };
	});

	server.route("GET", "/api/workspaces", ({ url }) => {
		const mode = requestMode(url.searchParams.get("mode"));
		const cwd = host.session.sessionManager.getCwd();
		const current = host.workspace;
		return {
			currentPath: cwd,
			currentSessionFile: host.session.sessionFile ?? null,
			workspaces: host.workspaceStore.list(mode).map((workspace) => {
				let missing = false;
				try {
					missing = !existsSync(workspace.rootPath);
				} catch {
					missing = false;
				}
				return {
					id: workspace.workspaceId,
					name: workspace.name,
					rootPath: workspace.rootPath,
					current: current?.workspaceId === workspace.workspaceId,
					// The sidebar uses this for its weak missing-folder mark; no probing from the browser.
					missing,
				};
			}),
		};
	});

	const generalWorkspace = (id: unknown) => {
		const workspace = host.workspaceStore.getById(asString(id, "id"), "general");
		if (!workspace) throw new HttpError(404, "Unknown workspace");
		return workspace;
	};
	server.route("GET", "/api/workspaces/settings", ({ url }) => {
		const workspace = generalWorkspace(url.searchParams.get("id"));
		return {
			workspace,
			sources: listWorkspaceSources(host.workspaceStore.getDataRoot() ?? getDataDir(), workspace.workspaceId),
		};
	});
	server.route("POST", "/api/workspaces/settings", ({ body }) => {
		const input = asObject(body);
		const workspace = generalWorkspace(input.id);
		if (
			typeof input.instructions !== "string" ||
			typeof input.memoryEnabled !== "boolean" ||
			typeof input.libraryEnabled !== "boolean"
		)
			throw new HttpError(400, "Invalid workspace settings");
		if (
			!host.workspaceStore.updateGeneralSettings(workspace.workspaceId, {
				name: asString(input.name, "name"),
				instructions: input.instructions,
				memoryEnabled: input.memoryEnabled,
				libraryEnabled: input.libraryEnabled,
			})
		)
			throw new HttpError(500, "Could not save workspace settings");
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});
	server.route("POST", "/api/workspaces/sources/upload", ({ body }) => {
		const input = asObject(body);
		const workspace = generalWorkspace(input.id);
		try {
			return uploadWorkspaceSource(
				host.workspaceStore.getDataRoot() ?? getDataDir(),
				workspace.workspaceId,
				asString(input.name, "name"),
				asString(input.data, "data"),
			);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : "Upload failed");
		}
	});
	server.route("GET", "/api/workspaces/sources/tree", ({ url }) => {
		const workspace = generalWorkspace(url.searchParams.get("id"));
		try {
			return {
				entries: readWorkspaceSourceTree(
					host.workspaceStore.getDataRoot() ?? getDataDir(),
					workspace.workspaceId,
					asString(url.searchParams.get("sourceId"), "sourceId"),
				),
			};
		} catch (error) {
			throw new HttpError(
				error instanceof WorkspaceSourceError && error.code === "not_found" ? 404 : 400,
				error instanceof Error ? error.message : "Could not read the source",
			);
		}
	});
	// Chunked uploads: `stage` checks a whole batch (files and folders) and prepares it, `chunk` writes one piece of
	// one file, `finish` completes a source. Staged uploads live only as long as this server, so an interrupted batch
	// can be continued from the same page, never across a restart.
	const stagedSources = new Map<string, { workspaceId: string; upload: StagedWorkspaceSourceUpload }>();
	const stagedSource = (input: Record<string, unknown>) => {
		const workspace = generalWorkspace(input.id);
		const staged = stagedSources.get(asString(input.sourceId, "sourceId"));
		if (!staged || staged.workspaceId !== workspace.workspaceId)
			throw new HttpError(404, "This upload is no longer available. Choose the files again.");
		return staged.upload;
	};
	server.route("POST", "/api/workspaces/sources/stage", ({ body }) => {
		const input = asObject(body);
		const workspace = generalWorkspace(input.id);
		if (!Array.isArray(input.items) || !input.items.length) throw new HttpError(400, "Expected upload items");
		const items: WorkspaceSourceUploadItem[] = input.items.map((raw) => {
			const item = asObject(raw);
			if ((item.kind !== "file" && item.kind !== "folder") || !Array.isArray(item.files))
				throw new HttpError(400, "Invalid upload item");
			return {
				kind: item.kind,
				name: asString(item.name, "name"),
				files: item.files.map((file) => {
					const entry = asObject(file);
					return { path: typeof entry.path === "string" ? entry.path : "", size: Number(entry.size) };
				}),
			};
		});
		try {
			const { problems, staged } = stageWorkspaceSourceUploads(
				host.workspaceStore.getDataRoot() ?? getDataDir(),
				workspace.workspaceId,
				items,
			);
			if (problems.length) return { problems };
			for (const upload of staged) stagedSources.set(upload.id, { workspaceId: workspace.workspaceId, upload });
			return { uploads: staged.map((upload) => ({ sourceId: upload.id, kind: upload.kind })) };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : "Upload failed");
		}
	});
	server.route("POST", "/api/workspaces/sources/chunk", ({ body }) => {
		const input = asObject(body);
		const upload = stagedSource(input);
		if (typeof input.data !== "string") throw new HttpError(400, '"data" must be a string');
		try {
			return writeWorkspaceSourceChunk(upload, Number(input.index), Number(input.offset), input.data);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : "Upload failed");
		}
	});
	server.route("POST", "/api/workspaces/sources/finish", ({ body }) => {
		const input = asObject(body);
		const upload = stagedSource(input);
		try {
			const source = finishWorkspaceSourceUpload(upload);
			stagedSources.delete(upload.id);
			return source;
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : "Upload failed");
		}
	});
	server.route("POST", "/api/workspaces/sources/delete", ({ body }) => {
		const input = asObject(body);
		const workspace = generalWorkspace(input.id);
		const sourceId = asString(input.sourceId, "sourceId");
		const innerPath = input.path === undefined ? undefined : asString(input.path, "path");
		try {
			deleteWorkspaceSource(
				host.workspaceStore.getDataRoot() ?? getDataDir(),
				workspace.workspaceId,
				sourceId,
				innerPath,
			);
			if (innerPath === undefined) stagedSources.delete(sourceId);
		} catch (error) {
			const status =
				error instanceof WorkspaceSourceError
					? error.code === "not_found"
						? 404
						: error.code === "invalid"
							? 400
							: 409
					: 409;
			throw new HttpError(status, error instanceof Error ? error.message : "Delete failed");
		}
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});

	const isArchivedSession = (info: SessionInfo): boolean =>
		getIndexedSessionMarkers(info.path)?.archived ?? existsSync(`${info.path}.archived`);

	const sessionSummary = (info: SessionInfo) => {
		const currentFile = host.session.sessionFile;
		const markers = getIndexedSessionMarkers(info.path);
		return {
			path: info.path,
			mode: getChatMode(info),
			id: info.id,
			name: info.name ?? null,
			firstMessage: info.firstMessage,
			created: info.created.getTime(),
			modified: info.modified.getTime(),
			messageCount: info.messageCount,
			blank: info.blank === true,
			parentSessionPath: info.parentSessionPath ?? null,
			copy: isWorktreeCopyPath(host.runtimeHost.services.agentDir, info.cwd),
			pinned: markers?.pinned ?? existsSync(`${info.path}.pinned`),
			current: currentFile !== undefined && pathIdentityKey(info.path) === pathIdentityKey(currentFile),
		};
	};

	server.route("GET", "/api/workspaces/sessions", async ({ url }) => {
		const rootPath = url.searchParams.get("path");
		if (!rootPath) throw new HttpError(400, "Missing path");
		const mode = requestMode(url.searchParams.get("mode"));
		const pagination = parseSessionListPagination(url);
		const sessions = host.workspaceStore.getByPath(rootPath, mode)
			? (await useCase.listSessions(rootPath)).filter(
					(info) => getChatMode(info) === mode && !isArchivedSession(info),
				)
			: [];
		const sorted = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		const page = paginateSessionSummaries(sorted.map(sessionSummary), pagination);
		return pagination ? { sessions: page.sessions, total: page.total } : { sessions: page.sessions };
	});

	/** Chats that belong to no registered Workspace: created without one, or left behind by a removed Workspace. */
	server.route("GET", "/api/sessions/unbound", async ({ url }) => {
		const mode = requestMode(url.searchParams.get("mode"));
		const pagination = parseSessionListPagination(url);
		const customDir = sessionDir();
		// detached-only: sessions whose workspace is gone (or never registered), not the whole library.
		const infos = customDir
			? (await SessionManager.listAll(customDir)).filter(
					(info) => !info.workspaceId || !host.workspaceStore.getById(info.workspaceId, mode),
				)
			: await SessionManager.listUnbound();
		const sessions = infos.filter((info) => getChatMode(info) === mode && !isArchivedSession(info));
		const page = paginateSessionSummaries(sessions.map(sessionSummary), pagination);
		return pagination ? { sessions: page.sessions, total: page.total } : { sessions: page.sessions };
	});

	server.route("POST", "/api/workspaces/add", ({ body }) => {
		const payload = asObject(body);
		const input = asString(payload.path, "path");
		const result = host.workspaceStore.add(
			input,
			host.session.sessionManager.getCwd(),
			true,
			requestMode(payload.mode),
		);
		if (!result.ok || !result.workspace) throw new HttpError(400, result.error ?? "Failed to add workspace");
		return {
			workspace: {
				id: result.workspace.workspaceId,
				name: result.workspace.name,
				rootPath: result.workspace.rootPath,
			},
		};
	});

	// Anchor to the same resolved Data root as the registry, not a user folder or the current Chat's cwd.
	// Capture once: a later cwd change cannot silently create another data tree.
	let createBaseDir: string | undefined;
	const resolveCreateBase = (_mode: ChatMode) => {
		if (createBaseDir === undefined) {
			createBaseDir = join(host.workspaceStore.getDataRoot() ?? getDataDir(), "workspace-folders");
		}
		return {
			baseDir: createBaseDir,
			referenceName: "",
			referencePath: "",
		};
	};

	const INVALID_WORKSPACE_NAME = /[\\/:*?"<>|]/;
	const validateNewWorkspaceName = (raw: unknown): string => {
		if (typeof raw !== "string") throw new HttpError(400, '"name" must be a string');
		const name = raw.trim();
		if (!name) throw new HttpError(400, "Please enter a workspace name.");
		if (name === "." || name === "..") throw new HttpError(400, "That is not a valid folder name.");
		if (INVALID_WORKSPACE_NAME.test(name) || /[. ]$/.test(name))
			throw new HttpError(400, 'The name cannot contain \\ / : * ? " < > | and cannot end with a space or dot.');
		if (name.length > 200) throw new HttpError(400, "The name is too long.");
		return name;
	};

	server.route("GET", "/api/workspaces/create-target", ({ url }) => {
		const mode = requestMode(url.searchParams.get("mode"));
		if (mode !== "general") throw new HttpError(400, "Quick-create is only available in General mode.");
		return resolveCreateBase(mode);
	});

	/**
	 * General-only quick-create: make a real sub-folder `<baseDir>/<name>` and register it as a Workspace. The parent
	 * always comes from the server (see resolveCreateBase); the client never sends a path, so it cannot escape to an
	 * arbitrary location. Existing unregistered directories are registered in place, never overwritten.
	 */
	server.route("POST", "/api/workspaces/create", ({ body }) => {
		const payload = asObject(body);
		const mode = requestMode(payload.mode);
		if (mode !== "general") throw new HttpError(400, "Quick-create is only available in General mode.");
		const name = validateNewWorkspaceName(payload.name);
		const { baseDir } = resolveCreateBase(mode);
		const created = join(baseDir, name);
		if (
			host.workspaceStore
				.list(mode)
				.some(
					(workspace) =>
						workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase() ||
						pathIdentityKey(workspace.rootPath) === pathIdentityKey(created),
				)
		)
			throw new HttpError(409, "A workspace with that name already exists.");
		try {
			mkdirSync(baseDir, { recursive: true });
			if (existsSync(created)) {
				if (!statSync(created).isDirectory())
					throw new HttpError(400, "A file occupies this path. Choose another workspace name.");
			} else mkdirSync(created);
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw new HttpError(403, error instanceof Error ? error.message : "Cannot create the folder");
		}
		const result = host.workspaceStore.add(created, host.session.sessionManager.getCwd(), true, mode);
		if (!result.ok || !result.workspace) throw new HttpError(400, result.error ?? "Failed to add workspace");
		host.broadcast("workspaces_changed", {});
		return {
			workspace: {
				id: result.workspace.workspaceId,
				name: result.workspace.name,
				rootPath: result.workspace.rootPath,
			},
		};
	});

	server.route("POST", "/api/workspaces/rename", ({ body }) => {
		const input = asObject(body);
		const id = asString(input.id, "id");
		const name = asString(input.name, "name").trim();
		if (!name) throw new HttpError(400, "Missing name");
		if (!host.workspaceStore.getById(id, requestMode(input.mode))) throw new HttpError(404, "Unknown workspace");
		if (!host.workspaceStore.rename(id, name)) throw new HttpError(500, "Could not save the workspace list.");
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});

	/**
	 * Only un-registers the Workspace (plus the chats' artifact files when `deleteArtifacts` is true). The folder, its
	 * project files and every chat stay exactly where they are; the chats simply belong to no Workspace afterwards (see
	 * `SessionManager.isUnbound`). Open chats keep running.
	 */
	server.route("POST", "/api/workspaces/remove", ({ body }) => {
		const input = asObject(body);
		const id = asString(input.id, "id");
		if (input.deleteArtifacts !== undefined && typeof input.deleteArtifacts !== "boolean")
			throw new HttpError(400, "deleteArtifacts must be a boolean");
		const mode = requestMode(input.mode);
		const workspace = host.workspaceStore.getById(id, mode);
		if (!workspace) throw new HttpError(404, "Unknown workspace");
		if (input.deleteArtifacts === true) {
			if (hub.statuses().some((slot) => slot.active))
				throw new HttpError(409, "Stop running tasks before deleting workspace artifacts.");
			deleteWorkspaceArtifacts(host.session.sessionManager.getDataRoot() ?? getDataDir(), workspace.workspaceId);
		}
		if (!host.workspaceStore.remove(id, mode)) throw new HttpError(500, "Could not save the workspace list.");
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});

	// Neither route touches the session the request came from: it keeps running in its own slot.
	server.route("POST", "/api/sessions/new", async ({ body }) => {
		const payload = asObject(body ?? {});
		const rootPath = typeof payload.rootPath === "string" && payload.rootPath ? payload.rootPath : undefined;
		return hub.newSession(host, rootPath, payload.unbound === true, requestMode(payload.mode));
	});

	server.route("POST", "/api/sessions/open", async ({ body }) => {
		const path = asString(asObject(body).path, "path");
		const cwdOverride =
			typeof asObject(body).cwdOverride === "string" ? (asObject(body).cwdOverride as string) : undefined;
		try {
			// Missing folders never block: hub opens the history and names the workspace without paths.
			return await hub.openSession(host, path, cwdOverride);
		} catch (error) {
			if (error instanceof HttpError) throw error;
			if (error instanceof MissingSessionCwdError) {
				// Safety net if a strict path still throws: name the workspace, never expose paths.
				const name = host.workspaceStore.getByPath(
					error.issue.sessionCwd,
					host.session.sessionManager.getMode(),
				)?.name;
				throw new HttpError(
					400,
					name
						? `工作区 [${name}] 本地目录不存在或已被移除`
						: "工作区本地目录不存在或已被移除，历史对话仍可查阅。",
				);
			}
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
			if (!slot.session.isIdle || slot.completionActive || slot.gitTask) {
				throw new HttpError(409, "A running chat cannot be deleted. Stop it first.");
			}
		}
		for (const slot of showing) {
			if (slot.slotId === host.slotId || hub.all().length === 1) {
				const result = await slot.runtimeHost.newSession();
				if (result.cancelled) throw new HttpError(409, "Cancelled.");
			} else {
				await hub.closeSlot(slot);
			}
		}
	};

	/**
	 * The archive lists the chats whose `.archived` marker is set, so every saved chat is looked at once. Marking them
	 * used to be one uninterrupted pass of several seconds on a large library, which held every other request (the
	 * folder window, another click) until it ended; it now runs in slices, so the server answers between them.
	 */
	server.route("GET", "/api/sessions/archived", async ({ url }) => {
		const pagination = parseSessionListPagination(url);
		const mode = requestMode(url.searchParams.get("mode"));
		const infos = await SessionManager.listAll(sessionDir());
		const sessions: ReturnType<typeof sessionSummary>[] = [];
		for (let index = 0; index < infos.length; index += ARCHIVED_SCAN_SLICE) {
			for (const info of infos.slice(index, index + ARCHIVED_SCAN_SLICE))
				if (getChatMode(info) === mode && isArchivedSession(info)) sessions.push(sessionSummary(info));
			if (index + ARCHIVED_SCAN_SLICE < infos.length) await new Promise<void>((resolve) => setImmediate(resolve));
		}
		const page = paginateSessionSummaries(sessions, pagination);
		return pagination ? { sessions: page.sessions, total: page.total } : { sessions: page.sessions };
	});
	/** Set or clear a marker file next to the session's JSONL (`.archived`, `.pinned`); the session data is not touched. */
	const setSessionMarker = async (path: string, suffix: string, on: boolean): Promise<void> => {
		if (on) {
			await writeFile(`${path}${suffix}`, `${suffix.slice(1)}\n`, { flag: "wx" }).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				},
			);
		} else {
			await unlink(`${path}${suffix}`).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		if (suffix === ".pinned" || suffix === ".archived")
			patchIndexMarker(path, suffix.slice(1) as "pinned" | "archived", on);
	};
	/** Header fast path guard: only files inside the current library's sessions tree can be known sessions. */
	const isInsideSessionsLibrary = (path: string): boolean =>
		isPathInsideRoot(path, sessionDir() ?? getWorkspacesDir(getDataDir()));
	const assertKnownSession = async (path: string, allowDeferred = false): Promise<void> => {
		if (allowDeferred && hub.slotsShowing(path).length > 0) return;
		// Fast path: persistent index hit (rows only exist for real library files).
		if (isSessionPathIndexed(path)) return;
		// Header fast path: containment first. A file outside the library's sessions tree must stay
		// unknown even when its first line looks like a session header, or delete/pin/archive would
		// operate on arbitrary user files.
		if (isInsideSessionsLibrary(path)) {
			try {
				if (readSessionHeader(path) !== null) return;
			} catch {
				// Fall through to the 404 below.
			}
		}
		throw new HttpError(404, "Unknown session");
	};

	/**
	 * Archiving only moves the chat to the sidebar's Archive folder. A chat that is open keeps its runtime and stays on
	 * screen where it is shown (nothing is reloaded or replaced); a running chat is refused.
	 */
	server.route("POST", "/api/sessions/archive", async ({ body }) => {
		const input = asObject(body);
		const path = asString(input.path, "path");
		await assertKnownSession(path, true);
		if (input.archived !== false) {
			for (const slot of hub.slotsShowing(path)) {
				if (!slot.session.isIdle || slot.completionActive || slot.gitTask) {
					throw new HttpError(409, "A running chat cannot be archived. Stop it first.");
				}
			}
		}
		// Deferred drafts are visible from their slots but not discoverable on disk yet.
		const owner = hub.slotsShowing(path)[0];
		if (owner && !existsSync(path)) owner.session.sessionManager.ensureSaved();
		await setSessionMarker(path, ".archived", input.archived !== false);
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});

	/** Pinned chats stay at the top of their sidebar group. */
	server.route("POST", "/api/sessions/pin", async ({ body }) => {
		const input = asObject(body);
		const path = asString(input.path, "path");
		await assertKnownSession(path);
		await setSessionMarker(path, ".pinned", input.pinned !== false);
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});

	server.route("POST", "/api/sessions/delete", async ({ body }) => {
		const input = asObject(body);
		if (input.deleteArtifacts !== undefined && typeof input.deleteArtifacts !== "boolean")
			throw new HttpError(400, "deleteArtifacts must be a boolean");
		if (input.deleteMemory !== undefined && typeof input.deleteMemory !== "boolean")
			throw new HttpError(400, "deleteMemory must be a boolean");
		const path = asString(input.path, "path");
		await assertKnownSession(path, true);
		await releaseSessionSlots(path);
		const deleted = await deleteSessionFile(path, {
			permanent: true,
			deleteArtifacts: input.deleteArtifacts === true,
			deleteMemory: input.deleteMemory === true,
		});
		if (!deleted.ok)
			throw new HttpError(
				409,
				deleted.code === "in-use"
					? "A file of this chat is open in another program. Close it and try again. Nothing was deleted."
					: deleted.code === "memory-busy"
						? "Memories are being updated right now. Try again in a moment. Nothing was deleted."
						: (deleted.error ?? "Failed to delete the chat."),
			);
		await setSessionMarker(path, ".pinned", false);
		host.broadcast("workspaces_changed", {});
		return { ok: true };
	});

	/**
	 * What the delete confirmation shows before anything is deleted: the chat's artifact files, the uploads and tool
	 * results that stay, and the memories "Also delete this chat's memories" would remove (`owned`, plus `retired`:
	 * archived memory text of this chat alone) or keep because another chat, consolidation or a restore also wrote them,
	 * or a copy of the chat still carries them (`shared`). Read-only, asynchronous I/O only.
	 */
	server.route("GET", "/api/sessions/delete-impact", async ({ url }) => {
		const path = asString(url.searchParams.get("path"), "path");
		await assertKnownSession(path, true);
		return summarizeSessionDeletion(path);
	});

	server.route("POST", "/api/sessions/clear", async ({ body }) => {
		const input = asObject(body);
		if (input.deleteArtifacts !== undefined && typeof input.deleteArtifacts !== "boolean")
			throw new HttpError(400, "deleteArtifacts must be a boolean");
		const rootPath = asString(input.rootPath, "rootPath");
		const sessions = (await useCase.listSessions(rootPath)).filter(
			(info) => getChatMode(info) === requestMode(input.mode),
		);
		for (const session of sessions) await releaseSessionSlots(session.path);
		for (const session of sessions) {
			const deleted = await deleteSessionFile(session.path, {
				permanent: true,
				deleteArtifacts: input.deleteArtifacts === true,
			});
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

	server.route("POST", "/api/sessions/naming-retry", ({ body }) => {
		const path = asString(asObject(body).path, "path");
		const owner = openSlot(path);
		if (!owner) throw new HttpError(409, "Open this chat before retrying automatic naming.");
		owner.retryConversationNaming();
		return { ok: true };
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
				sessionId: manager.getSessionId(),
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

	/**
	 * "Fork from here" under a message: a new chat with this chat's history up to just before that message, opened as a
	 * chat of its own in the same Workspace and mode. This chat is only read and stays as it is (it may even be running).
	 * With nothing worth keeping before the message (it is the first one), the new chat starts empty.
	 */
	server.route("POST", "/api/sessions/fork-new", async ({ body }) => {
		const entryId = asString(asObject(body).entryId, "entryId");
		const manager = host.session.sessionManager;
		const entry = manager.getEntry(entryId);
		if (entry?.type !== "message" || entry.message.role !== "user")
			throw new HttpError(404, "No message with that id in this chat.");
		const file = host.session.sessionFile;
		const mode = manager.getMode();
		const saved = !!file && existsSync(file);
		// The Workspace the chat belongs to, as "Continue in a new chat" finds it.
		const workspaceId = saved ? readSessionHeader(file)?.workspaceId : undefined;
		const workspace = workspaceId ? host.workspaceStore.getById(workspaceId, mode) : undefined;
		const place = { rootPath: workspace?.rootPath ?? null, unbound: !workspace };
		let forked: string | undefined;
		if (entry.parentId && saved) {
			// The newest lines are written in batches: the copy reads the file, so it must have them.
			manager.flushPendingWrites();
			const copy = SessionManager.open(file, sessionDir());
			forked = copy.createBranchedSession(entry.parentId);
		}
		// createBranchedSession writes nothing for a history without a reply (only a marker before the first message).
		if (!forked || !existsSync(forked)) {
			const created = await hub.newSession(host, workspace?.rootPath, !workspace, mode, { forceNew: true });
			return { slot: created.slot, ...place };
		}
		const opened = await hub.openSession(host, forked);
		host.broadcast("workspaces_changed", {});
		return { slot: opened.slot, ...place };
	});

	/**
	 * "Continue in a new chat": a separate, ordinary new chat in the source's Workspace and mode that starts with the
	 * source's hand-off note and newest messages as background. The source is only read; nothing is sent or run.
	 */
	server.route("POST", "/api/sessions/continue", async ({ body }) => {
		const path = asString(asObject(body).path, "path");
		await assertKnownSession(path, true);
		const header = readSessionHeader(path);
		if (!header) throw new HttpError(404, "Unknown session");
		const mode: ChatMode = header.mode === "general" ? "general" : "coding";
		const owner = openSlot(path);
		const built = buildSessionContinuation(path, { title: owner?.session.sessionName });
		if (!built || (built.details.messagesIncluded === 0 && built.details.summaryState !== "current"))
			throw new HttpError(409, "This chat has no messages to continue from yet.");
		const workspace = header.workspaceId ? host.workspaceStore.getById(header.workspaceId, mode) : undefined;
		const created = await hub.newSession(host, workspace?.rootPath, !workspace, mode, { forceNew: true });
		const target = hub.get(created.slot);
		if (!target) throw new HttpError(500, "The new chat could not be opened.");
		await target.session.sendCustomMessage({
			customType: SESSION_CONTINUATION_TYPE,
			content: built.text,
			display: true,
			details: built.details,
		});
		host.broadcast("workspaces_changed", {});
		return { slot: created.slot, rootPath: workspace?.rootPath ?? null, unbound: !workspace };
	});

	/** Take the continued-from background back out of a chat that has not started yet. */
	server.route("POST", "/api/sessions/continuation/unlink", async ({ body }) => {
		requireIdle("change the chat");
		const entryId = asString(asObject(body).entryId, "entryId");
		const entry = host.session.sessionManager.getEntry(entryId);
		if (entry?.type !== "custom_message" || entry.customType !== SESSION_CONTINUATION_TYPE)
			throw new HttpError(404, "No continued-from background with that id in this chat.");
		if (!host.session.detachContextMessage(entryId, SESSION_CONTINUATION_UNLINKED_TYPE))
			throw new HttpError(409, "The chat has already started; the background stays as part of its history.");
		host.broadcast("session_replaced", { at: Date.now() });
		return { ok: true };
	});

	const handleExport = async ({ res, body }: RequestContext) => {
		let prefs: Record<string, unknown> | undefined;
		if (body && typeof body === "object" && !Array.isArray(body)) {
			const value = (body as Record<string, unknown>).prefs;
			if (value && typeof value === "object" && !Array.isArray(value)) prefs = value as Record<string, unknown>;
		}

		let html: string;
		try {
			html = await buildReplayHtml({
				sessionManager: host.session.sessionManager,
				sessionFile: host.session.sessionFile ?? undefined,
				prefs,
				name: host.session.sessionName ?? undefined,
			});
		} catch (error) {
			if (!(error instanceof ReplayExportTooLargeError)) throw error;
			const text = JSON.stringify(buildExportTooLargeBody(error));
			res.writeHead(413, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				"content-length": Buffer.byteLength(text),
			});
			res.end(text);
			return;
		}

		const rawName = host.session.sessionName ?? host.session.sessionId;
		const name = `${rawName.replace(/[^\w.-]+/g, "_").slice(0, 60) || "session"}.html`;
		const buffer = Buffer.from(html, "utf8");
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-disposition": `attachment; filename="${name}"`,
			"content-length": buffer.length,
		});
		res.end(buffer);
	};

	server.route("GET", "/api/sessions/export", handleExport);
	server.route("POST", "/api/sessions/export", handleExport);

	server.route("GET", "/api/sessions/stats", () => host.usage().stats);
	server.route("POST", "/api/sessions/touched", ({ body }) => {
		// The page tells whether the chat's composer holds anything; `touched: false` follows when it was emptied again, so a
		// chat that was typed into and cleared is not kept listed for the typing.
		host.inputTouched = asObject(body ?? {}).touched !== false;
		host.broadcast("session_info", { name: host.session.sessionName ?? null });
		return { ok: true };
	});
}
