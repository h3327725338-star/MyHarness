import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getSessionDir, getWorkspaceDir, getWorkspaceMetadataPath, getWorkspacesDir } from "../config/paths/index.ts";
import { WorkspaceStore } from "../data/workspace-store.ts";
import { listMemoryFiles } from "../session/memory/store.ts";
import type { ModeStateStore } from "../session/mode-state.ts";
import { readSessionHeader } from "../session/storage/jsonl/index.ts";
import type { ScannedEntity } from "./types.ts";
import { stableJson } from "./util.ts";

const SESSIONS_DIR = "sessions";
const CONVERSATION_DIR = "conversation";
const WORKSPACE_FILE_DIRS = ["uploads", "artifacts"] as const;
const MAX_SCANNED_FILE_BYTES = 256 * 1024 * 1024;
const TEMP_FILE_PATTERN = /\.(?:tmp|part|crdownload)$/u;
/** Local-only bridges and locks. An archive or pin marker is real user state and does travel. */
const LOCAL_ONLY_FILE_PATTERN = /(?:\.bridge|\.lock)$/u;

export interface HeaderCacheEntry {
	mtimeMs: number;
	general: boolean;
}

export interface ScanOptions {
	dataRoot: string;
	agentDir: string;
	modeState: ModeStateStore;
	headerCache?: Map<string, HeaderCacheEntry>;
}

function toPosix(value: string): string {
	return value.split(sep).join("/");
}

function isFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function addFile(
	map: Map<string, ScannedEntity>,
	dataRoot: string,
	absolute: string,
	kind: ScannedEntity["kind"] = "file",
	meta?: Record<string, string>,
): void {
	if (!isFile(absolute)) return;
	const stat = statSync(absolute);
	if (stat.size > MAX_SCANNED_FILE_BYTES) return;
	const relativePath = toPosix(relative(dataRoot, absolute));
	if (TEMP_FILE_PATTERN.test(relativePath)) return;
	if (LOCAL_ONLY_FILE_PATTERN.test(relativePath)) return;
	const id = relativePath;
	const key = `${kind}:${id}`;
	const entity: ScannedEntity = {
		key,
		kind,
		id,
		path: absolute,
		updatedAt: stat.mtime.toISOString(),
		mtimeMs: stat.mtimeMs,
		size: stat.size,
	};
	if (meta) entity.meta = meta;
	map.set(key, entity);
}

function walkFiles(directory: string, visit: (file: string) => void): void {
	if (!existsSync(directory)) return;
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const full = join(directory, entry.name);
		if (entry.isDirectory()) walkFiles(full, visit);
		else if (entry.isFile()) visit(full);
	}
}

function readWorkspaceMetadata(file: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as { workspace?: Record<string, unknown> };
		return value.workspace && typeof value.workspace === "object" ? value.workspace : undefined;
	} catch {
		return undefined;
	}
}

/** The registry is authoritative for which sidebar lists a Workspace belongs to, including removed entries. */
function readRegistryModes(agentDir: string, dataRoot: string): Map<string, string[]> {
	const modes = new Map<string, string[]>();
	try {
		for (const workspace of WorkspaceStore.create(agentDir, dataRoot).list()) {
			modes.set(workspace.workspaceId, [...(workspace.modes ?? ["coding"])]);
		}
	} catch {
		// Without a readable registry the metadata on disk decides.
	}
	return modes;
}

/** The Workspace record content intentionally excludes `rootPath`: each device binds its own folder. */
function workspaceContent(workspace: Record<string, unknown>): string {
	const modes = Array.isArray(workspace.modes)
		? workspace.modes.filter((mode): mode is string => mode === "coding" || mode === "general").sort()
		: [];
	return stableJson({
		workspaceId: String(workspace.workspaceId ?? workspace.id ?? ""),
		name: String(workspace.name ?? ""),
		instructions: typeof workspace.instructions === "string" ? workspace.instructions : "",
		memoryEnabled: workspace.memoryEnabled !== false,
		libraryEnabled: workspace.libraryEnabled !== false,
		modes,
		createdAt: String(workspace.createdAt ?? ""),
	});
}

/**
 * Collect every entity that belongs to the sync scope:
 * all memories (global, workspace, session, archived, pending), General-mode Workspaces and their Sessions,
 * the files inside those Sessions (uploads, artifacts, metadata), the Workspace library, the General personal
 * prompt and drafts. Coding-mode chats are deliberately excluded; Coding memories are included through the memory
 * scan because memory is shared across modes.
 */
export function scanLocalEntities(options: ScanOptions): Map<string, ScannedEntity> {
	const { dataRoot, agentDir, modeState } = options;
	const headerCache = options.headerCache ?? new Map<string, HeaderCacheEntry>();
	const entities = new Map<string, ScannedEntity>();

	// 1. All memories, including archives and pending quarantine entries.
	for (const memory of listMemoryFiles(dataRoot)) {
		const absolute = join(dataRoot, memory.path);
		if (!isFile(absolute) || !memory.path.endsWith(".md")) continue;
		const stat = statSync(absolute);
		entities.set(`memory:${memory.path}`, {
			key: `memory:${memory.path}`,
			kind: "memory",
			id: memory.path,
			path: absolute,
			updatedAt: stat.mtime.toISOString(),
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			meta: { memoryId: memory.id || memory.path, scope: memory.scope },
		});
	}

	// 2. General Sessions and the Workspaces that own them.
	const generalWorkspaces = new Set<string>();
	const workspaceMeta = new Map<string, Record<string, unknown> | undefined>();
	const registryModes = readRegistryModes(agentDir, dataRoot);
	const workspacesRoot = getWorkspacesDir(dataRoot);
	if (existsSync(workspacesRoot)) {
		for (const workspaceId of readdirSync(workspacesRoot, { withFileTypes: true })) {
			if (!workspaceId.isDirectory() || workspaceId.isSymbolicLink()) continue;
			const workspace = workspaceId.name;
			const registry = registryModes.get(workspace);
			// A Workspace the user removed from every list keeps its files but is not published again.
			if (registry && registry.length === 0) continue;
			// A Workspace that was only ever opened in General mode still has a name, notes and switches to share,
			// even before its first chat exists.
			const metadata = readWorkspaceMetadata(getWorkspaceMetadataPath(dataRoot, workspace));
			workspaceMeta.set(workspace, metadata);
			const metadataModes = Array.isArray(metadata?.modes) ? metadata.modes : [];
			const general = registry ? registry.includes("general") : metadataModes.includes("general");
			if (general) generalWorkspaces.add(workspace);
			const sessionsRoot = join(getWorkspaceDir(dataRoot, workspace), SESSIONS_DIR);
			if (!existsSync(sessionsRoot)) continue;
			for (const session of readdirSync(sessionsRoot, { withFileTypes: true })) {
				if (!session.isDirectory() || session.isSymbolicLink()) continue;
				const sessionId = session.name;
				const conversationDir = join(getSessionDir(dataRoot, workspace, sessionId), CONVERSATION_DIR);
				if (!existsSync(conversationDir)) continue;
				const files = readdirSync(conversationDir, { withFileTypes: true })
					.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
					.sort((a, b) => a.name.localeCompare(b.name));
				const conversation = files.at(-1);
				if (!conversation) continue;
				const conversationPath = join(conversationDir, conversation.name);
				const stat = statSync(conversationPath);
				let cached = headerCache.get(conversationPath);
				if (!cached || cached.mtimeMs !== stat.mtimeMs) {
					const header = readSessionHeader(conversationPath);
					cached = { mtimeMs: stat.mtimeMs, general: header?.mode === "general" };
					headerCache.set(conversationPath, cached);
				}
				if (!cached.general) continue;
				if (!general) continue;
				generalWorkspaces.add(workspace);
				entities.set(`session:${workspace}/${sessionId}`, {
					key: `session:${workspace}/${sessionId}`,
					kind: "session",
					id: `${workspace}/${sessionId}`,
					path: conversationPath,
					updatedAt: stat.mtime.toISOString(),
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					meta: { fileName: conversation.name },
				});
			}
		}
	}

	// 3. Workspace identity and library files, plus every non-conversation file of its General Sessions.
	for (const workspaceId of generalWorkspaces) {
		const metadataPath = getWorkspaceMetadataPath(dataRoot, workspaceId);
		const metadata = workspaceMeta.get(workspaceId);
		if (metadata) {
			const content = workspaceContent(metadata);
			const stat = statSync(metadataPath);
			entities.set(`workspace:${workspaceId}`, {
				key: `workspace:${workspaceId}`,
				kind: "workspace",
				id: workspaceId,
				path: metadataPath,
				inline: content,
				updatedAt: stat.mtime.toISOString(),
				mtimeMs: stat.mtimeMs,
				size: Buffer.byteLength(content),
				meta: {
					name: String(metadata.name ?? ""),
					rootPathHint: String(metadata.rootPath ?? ""),
				},
			});
		}
		for (const directory of WORKSPACE_FILE_DIRS) {
			const folder = join(getWorkspaceDir(dataRoot, workspaceId), directory);
			walkFiles(folder, (file) => addFile(entities, dataRoot, file));
		}
		const sessionsRoot = join(getWorkspaceDir(dataRoot, workspaceId), SESSIONS_DIR);
		if (existsSync(sessionsRoot)) {
			for (const session of readdirSync(sessionsRoot, { withFileTypes: true })) {
				if (!session.isDirectory() || session.isSymbolicLink()) continue;
				if (!entities.has(`session:${workspaceId}/${session.name}`)) continue;
				for (const category of ["uploads", "artifacts", "metadata", "notes", "files", "tool-results"] as const) {
					walkFiles(join(getSessionDir(dataRoot, workspaceId, session.name), category), (file) =>
						addFile(entities, dataRoot, file),
					);
				}
				// Legacy uploads live inside the conversation folder, beside the JSONL rather than in a session uploads folder.
				walkFiles(join(getSessionDir(dataRoot, workspaceId, session.name), CONVERSATION_DIR), (file) => {
					if (!file.endsWith(".jsonl")) addFile(entities, dataRoot, file);
				});
			}
		}
	}

	// 4. General-mode personal prompt and drafts live in the agent directory, not the Data root.
	const stateFile = join(agentDir, "chat-mode-state.json");
	let stateMtime = Date.now();
	try {
		stateMtime = statSync(stateFile).mtimeMs;
	} catch {
		// No state file yet: drafts and prompt are simply empty.
	}
	const updatedAt = new Date(stateMtime).toISOString();
	let general: ReturnType<ModeStateStore["get"]>;
	try {
		general = modeState.get("general");
	} catch {
		general = { drafts: {} } as ReturnType<ModeStateStore["get"]>;
	}
	const prompt = modeState.getPersonalPrompt("general");
	// An empty prompt is the absence of a value: leaving it out means another device's text can arrive, and clearing
	// here becomes an explicit delete record instead of an empty version that would block the other device.
	if (prompt) {
		entities.set("prompt:general", {
			key: "prompt:general",
			kind: "prompt",
			id: "general",
			inline: prompt,
			updatedAt,
			mtimeMs: stateMtime,
			size: Buffer.byteLength(prompt),
			meta: { name: "General personal prompt" },
		});
	}
	for (const [sessionId, draft] of Object.entries(general.drafts)) {
		if (!draft || (!draft.text && draft.attachments.length === 0)) continue;
		const content = stableJson({ text: draft.text, attachments: draft.attachments });
		entities.set(`draft:${sessionId}`, {
			key: `draft:${sessionId}`,
			kind: "draft",
			id: sessionId,
			inline: content,
			updatedAt,
			mtimeMs: stateMtime,
			size: Buffer.byteLength(content),
			meta: { name: `Draft ${sessionId}` },
		});
	}

	return entities;
}
