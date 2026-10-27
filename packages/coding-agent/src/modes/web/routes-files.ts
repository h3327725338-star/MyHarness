/** Web API routes for the workspace file browser and for change/diff review. */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import ignore from "ignore";
import { NodeHtmlMarkdown } from "node-html-markdown";
import {
	guessAttachmentMime,
	resolveAttachmentReference,
	toAttachmentRelativePath,
	writeAttachmentManifest,
	writeLegacyAttachmentManifest,
} from "../../config/paths/attachments.ts";
import { getAttachmentDir, getDataDir } from "../../config/paths/index.ts";
import { decodeUploadChunk, MAX_UPLOAD_BYTES, writeUploadChunk } from "../../data/upload-chunks.ts";
import {
	artifactScope,
	listArtifacts,
	refreshArtifactIndexes,
	resolveArtifact,
} from "../../session/artifacts/store.ts";
import { SessionManager } from "../../session/manager/index.ts";
import {
	claimPendingMemory,
	deleteMemoryPermanently,
	listMemoryFilesAsync,
	migrateLegacyMemories,
	restoreMemoryArchive,
} from "../../session/memory/store.ts";
import type { FileChangeSummary, RunChangeCardFile } from "./changes.ts";
import {
	getCachedWorktreeChangesSync,
	invalidateWorktreeCache,
	setCachedWorktreeChanges,
	WORKTREE_CACHE_TTL_MS,
} from "./changes-stats.ts";
import {
	lineIndex,
	readBytes,
	readLines,
	readSegment,
	searchBytes,
	searchLines,
	writeBytes,
	writeSegment,
} from "./file-pages.ts";
import { folderDialogOpen, nativeFolderDialogAvailable, pickFolderWithSystemDialog } from "./folder-dialog.ts";
import type { WebHost } from "./host.ts";
import { registerHtmlPreview } from "./html-preview.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import { resolveLocalFile, runLocalFileAction } from "./local-files.ts";
import { registerOfficePreview, registerOfficeRoutes } from "./office.ts";
import { collectSessionChanges } from "./session-changes.ts";
import { attributeConversationFiles, type ConversationAttribution, isElsewhereOwned } from "./session-ownership.ts";
import { RUN_CHANGES_ENTRY, splitAttachmentText } from "./wire.ts";

const MAX_TEXT_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_FILES = 30_000;
const ALWAYS_HIDDEN_DIRS = new Set([".git"]);
const SEARCH_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".cache",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
]);

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
};

/** Files the workspace viewer can play or page through with a native element (the browser owns the renderer). */
const MEDIA_TYPES: Record<string, { mime: string; kind: "pdf" | "audio" | "video" }> = {
	".pdf": { mime: "application/pdf", kind: "pdf" },
	".mp3": { mime: "audio/mpeg", kind: "audio" },
	".wav": { mime: "audio/wav", kind: "audio" },
	".ogg": { mime: "audio/ogg", kind: "audio" },
	".oga": { mime: "audio/ogg", kind: "audio" },
	".m4a": { mime: "audio/mp4", kind: "audio" },
	".flac": { mime: "audio/flac", kind: "audio" },
	".aac": { mime: "audio/aac", kind: "audio" },
	".mp4": { mime: "video/mp4", kind: "video" },
	".m4v": { mime: "video/mp4", kind: "video" },
	".webm": { mime: "video/webm", kind: "video" },
	".ogv": { mime: "video/ogg", kind: "video" },
	".mov": { mime: "video/quicktime", kind: "video" },
};

/**
 * Office documents: this route neither parses nor converts them. `/api/files/read` only reports `kind: "office"`, and
 * the tab then goes through the /api/office routes (office.ts): a read-only PDF preview converted by an installed
 * Microsoft Office or LibreOffice, or editing in the user's own ONLYOFFICE server. MyHarness ships no Office engine.
 */
const OFFICE_EXTENSIONS = new Set([
	".doc",
	".docx",
	".dot",
	".dotx",
	".xls",
	".xlsx",
	".xlsm",
	".ppt",
	".pptx",
	".pps",
	".ppsx",
	".odt",
	".ods",
	".odp",
]);

/** Content type for the streaming raw route; unknown types are served as octet-stream (download). */
const RAW_CONTENT_TYPES: Record<string, string> = {
	...IMAGE_TYPES,
	...Object.fromEntries(Object.entries(MEDIA_TYPES).map(([extension, value]) => [extension, value.mime])),
	".txt": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

const LANGUAGES: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".json": "json",
	".md": "markdown",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cs": "csharp",
	".css": "css",
	".html": "xml",
	".xml": "xml",
	".yml": "yaml",
	".yaml": "yaml",
	".toml": "ini",
	".sh": "bash",
	".ps1": "powershell",
	".sql": "sql",
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
	".kt": "kotlin",
};

function relPosix(root: string, absolute: string): string {
	return path.relative(root, absolute).split(path.sep).join("/");
}

/** Resolve a workspace-relative path and refuse anything that escapes the workspace (including via symlinks). */
function resolveInside(root: string, relative: string): string {
	const absolute = path.resolve(root, relative || ".");
	const rel = path.relative(root, absolute);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new HttpError(403, "Path is outside the workspace");
	if (existsSync(absolute)) {
		const real = realpathSync(absolute);
		const realRoot = realpathSync(root);
		const realRel = path.relative(realRoot, real);
		if (realRel.startsWith("..") || path.isAbsolute(realRel))
			throw new HttpError(403, "Path resolves outside the workspace");
	}
	return absolute;
}

/**
 * Target of a file tab in the right-hand workspace. A workspace-relative path stays confined to the workspace
 * (resolveInside); an absolute local path, which is what a file link in the chat or a chat attachment opens, may name a
 * file anywhere on this machine, but never a network or device path.
 */
function resolveFileTab(root: string, input: string): string {
	if (
		!path.isAbsolute(input) ||
		/^(?:\\\\|\/\/)/.test(input) ||
		(process.platform === "win32" && !/^[a-z]:[\\/]/i.test(input))
	)
		return resolveInside(root, input);
	const absolute = path.resolve(input);
	const rel = path.relative(root, absolute);
	if (!rel.startsWith("..") && !path.isAbsolute(rel)) return resolveInside(root, rel);
	if (
		existsSync(absolute) &&
		/^(?:\\\\|\/\/)/.test(realpathSync(absolute)) &&
		!/^\\\\\?\\[a-z]:\\/i.test(realpathSync(absolute))
	)
		throw new HttpError(400, "Network and device paths are not supported");
	return absolute;
}

/** The path a file tab shows and sends back: workspace-relative inside the workspace, absolute outside it. */
function fileTabPath(root: string, absolute: string): string {
	const rel = path.relative(root, absolute);
	return rel.startsWith("..") || path.isAbsolute(rel) ? absolute : rel.split(path.sep).join("/");
}

function loadIgnore(root: string) {
	const matcher = ignore();
	const file = path.join(root, ".gitignore");
	if (existsSync(file)) {
		try {
			matcher.add(readFileSync(file, "utf8"));
		} catch {
			// unreadable .gitignore: treat nothing as ignored
		}
	}
	return matcher;
}

function looksBinary(buffer: Buffer): boolean {
	const length = Math.min(buffer.length, 8000);
	for (let index = 0; index < length; index++) if (buffer[index] === 0) return true;
	return false;
}

function fuzzyScore(query: string, target: string): number {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	const base = t.slice(t.lastIndexOf("/") + 1);
	if (base === q) return 1000;
	if (base.startsWith(q)) return 800 - base.length;
	const index = t.indexOf(q);
	if (index >= 0) return 600 - index - t.length * 0.1;
	let position = 0;
	let score = 0;
	for (const char of q) {
		const found = t.indexOf(char, position);
		if (found < 0) return -1;
		score += found === position ? 3 : 1;
		position = found + 1;
	}
	return score - t.length * 0.05;
}

// First-block size and cumulative window for GET /api/tool-output (chunked read of saved tool output).
const TOOL_OUTPUT_DEFAULT_CHUNK = 512 * 1024;
const TOOL_OUTPUT_MAX_TOTAL = 4 * 1024 * 1024;

/**
 * Length of the incomplete UTF-8 sequence at the end of `data` (0 when the last character is complete).
 * Used to cut a byte block back to a character boundary so the next block decodes cleanly. Only the
 * final 1..4 bytes are inspected: a lead byte is any byte that is not a `10xxxxxx` continuation.
 */
function utf8IncompleteTailBytes(data: Buffer): number {
	if (data.length === 0) return 0;
	let index = data.length - 1;
	let continuation = 0;
	while (index >= 0 && (data[index]! & 0xc0) === 0x80) {
		index -= 1;
		continuation += 1;
		if (continuation > 3) return 0;
	}
	if (index < 0) return 0;
	const lead = data[index]!;
	let needed: number;
	if ((lead & 0x80) === 0x00) return 0;
	else if ((lead & 0xe0) === 0xc0) needed = 2;
	else if ((lead & 0xf0) === 0xe0) needed = 3;
	else if ((lead & 0xf8) === 0xf0) needed = 4;
	else return 0;
	return continuation + 1 < needed ? continuation + 1 : 0;
}

export function registerFileRoutes(server: WebHttpServer, host: WebHost): void {
	const currentCwd = () =>
		typeof host.cwd === "string"
			? host.cwd
			: host.session?.sessionManager?.getCwd
				? host.session.sessionManager.getCwd()
				: "";
	const root = () => path.resolve(currentCwd());

	if (server && typeof server.route === "function") {
		const originalRoute = server.route.bind(server);
		server.route = (method, pattern, handler) => {
			if (method === "POST" && pattern.startsWith("/api/git/")) {
				return originalRoute(method, pattern, async (ctx) => {
					try {
						return await handler(ctx);
					} finally {
						const cwd = currentCwd();
						invalidateWorktreeCache(cwd);
						// /api/git/task/abort only signals the running task; it settles in the
						// background after the handler returns. Invalidate once more after the
						// cache TTL so a list fetched in between cannot survive the abort.
						if (pattern === "/api/git/task/abort" && cwd) {
							const timer = setTimeout(() => invalidateWorktreeCache(cwd), WORKTREE_CACHE_TTL_MS);
							timer.unref?.();
						}
					}
				});
			}
			return originalRoute(method, pattern, handler);
		};
	}

	// Chat file links land here from markdown data-local-path clicks (resolve/choices/open/reveal/handler).
	// All actions share resolveLocalFile, so a link created on another computer remaps the same
	// way everywhere: direct path first, then workspace-root suffix (Drive-aware; the Data root is searched too),
	// then a unique basename fallback, else a precise 404. The resolved absolute path is what gets opened.
	server.route("POST", "/api/files/local", async ({ body }) => {
		const payload = body as { path?: unknown; action?: unknown; handler?: unknown } | null;
		if (!payload || !["resolve", "choices", "open", "reveal", "handler"].includes(String(payload.action)))
			throw new HttpError(400, "Unknown local file action");
		let localPath = payload.path;
		if (typeof localPath === "string" && localPath.startsWith("/api/artifacts/download?")) {
			const artifactPath = new URL(localPath, "http://localhost").searchParams.get("path") ?? "";
			try {
				localPath = resolveArtifact(artifactDataRoot(), artifactPath);
			} catch {
				throw new HttpError(404, "Unknown artifact");
			}
		}
		const dataRoot = host.session?.sessionManager?.getDataRoot?.() ?? getDataDir();
		const target = await resolveLocalFile(root(), localPath, [dataRoot]);
		if (payload.action === "resolve") return target;
		if (payload.action === "handler" && typeof payload.handler !== "string")
			throw new HttpError(400, "Expected an opening method");
		const result = await runLocalFileAction(
			target.path,
			String(payload.action),
			typeof payload.handler === "string" ? payload.handler : "",
		);
		return payload.action === "choices" ? { ...target, choices: result } : { ...target, opened: true };
	});

	const artifactDataRoot = () => host.session.sessionManager.getDataRoot() ?? getDataDir();
	server.route("GET", "/api/artifacts", ({ url }) => {
		const scope = artifactScope(host.session.sessionManager);
		const level = url.searchParams.get("scope") ?? "session";
		if (!["session", "workspace", "global"].includes(level)) throw new HttpError(400, "Unknown artifact scope");
		const dataRoot = artifactDataRoot();
		// Only "All workspaces" reads every Workspace (and refreshes the derived indexes with it); that blocks the server
		// for seconds on a data root with many Workspaces, so the other views read just their own folders.
		if (level === "global") return { entries: refreshArtifactIndexes(dataRoot) };
		if (!scope) return { entries: [] };
		return {
			entries: listArtifacts(dataRoot, {
				workspaceId: scope.workspaceId,
				...(level === "session" ? { sessionId: scope.sessionId } : {}),
			}),
		};
	});
	server.route("GET", "/api/artifacts/download", ({ url, res }) => {
		let full: string;
		try {
			full = resolveArtifact(artifactDataRoot(), url.searchParams.get("path") ?? "");
		} catch {
			throw new HttpError(404, "Unknown artifact");
		}
		res.setHeader("Content-Type", "application/octet-stream");
		res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`);
		res.end(readFileSync(full));
	});

	server.route("GET", "/api/memory", async ({ url }) => {
		const dataRoot = artifactDataRoot();
		await migrateLegacyMemories(dataRoot);
		const level = url.searchParams.get("scope") ?? "session";
		if (!["session", "workspace", "global"].includes(level)) throw new HttpError(400, "Unknown memory scope");
		const manager = host.session.sessionManager;
		return {
			entries:
				level !== "global" && !manager.getWorkspaceId()
					? []
					: await listMemoryFilesAsync(
							dataRoot,
							level === "global"
								? {}
								: {
										workspaceId: manager.getWorkspaceId(),
										...(level === "session" ? { sessionId: manager.getSessionId() } : {}),
									},
						),
		};
	});
	server.route("POST", "/api/memory/restore", async ({ body }) => {
		const payload = body as { path?: unknown } | null;
		if (typeof payload?.path !== "string") throw new HttpError(400, "Expected an archive path");
		// A restore can replace active text. Do not race a running task or its memory extraction.
		if (!host.session.isIdle || host.completionActive)
			throw new HttpError(409, "Wait for the current task to finish");
		await restoreMemoryArchive(artifactDataRoot(), payload.path);
		return { ok: true };
	});
	server.route("POST", "/api/memory/delete", async ({ body }) => {
		const payload = body as { path?: unknown } | null;
		if (typeof payload?.path !== "string") throw new HttpError(400, "Expected a memory path");
		// Permanent deletion removes the active file and all its archived versions. Nothing can be recovered.
		// Do not race a running task or its memory extraction.
		if (!host.session.isIdle || host.completionActive)
			throw new HttpError(409, "Wait for the current task to finish");
		const { archiveCount } = await deleteMemoryPermanently(artifactDataRoot(), payload.path);
		return { ok: true, archiveCount };
	});
	server.route("POST", "/api/memory/claim", async ({ body }) => {
		const payload = body as { path?: unknown } | null;
		if (typeof payload?.path !== "string") throw new HttpError(400, "Expected a pending memory path");
		// Claiming moves a quarantined memory into this workspace. Do not race a running task.
		if (!host.session.isIdle || host.completionActive)
			throw new HttpError(409, "Wait for the current task to finish");
		const workspaceId = host.session.sessionManager.getWorkspaceId();
		if (!workspaceId) throw new HttpError(409, "No current workspace.");
		const { id } = await claimPendingMemory(artifactDataRoot(), payload.path, workspaceId);
		return { ok: true, id };
	});
	server.route("POST", "/api/memory/maintenance-retry", async () => {
		// Do not race a running task: the pill only shows these buttons while idle.
		if (!host.session.isIdle || host.completionActive)
			throw new HttpError(409, "Wait for the current task to finish");
		const retried = await host.session.retryAutoMemoryMaintenance();
		return { ok: true, retried, status: host.session.getAutoMemoryMaintenanceStatus() };
	});
	server.route("POST", "/api/memory/maintenance-dismiss", async () => {
		if (!host.session.isIdle || host.completionActive)
			throw new HttpError(409, "Wait for the current task to finish");
		const archived = await host.session.dismissAutoMemoryMaintenance();
		return { ok: true, archived, status: host.session.getAutoMemoryMaintenanceStatus() };
	});

	// Browser uploads retain their original bytes as session-owned context references.
	// New uploads land in the workspace attachment library with a manifest beside the file.
	// Where one new upload goes: the workspace attachment library when the session has one, else the legacy
	// `uploads/<id>/` folder beside the session file.
	const prepareAttachment = async (rawName: string) => {
		const name =
			path
				.basename(rawName.replaceAll("\\", "/"))
				.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
				.replace(/[. ]+$/g, "") || "file";
		const manager = host.session.sessionManager;
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new HttpError(409, "No current session.");
		const storedName = `attachment-${name}`;
		const workspaceId = manager.getWorkspaceId?.();
		const sessionId = manager.getSessionId?.();
		const dataRoot = manager.getDataRoot?.() ?? getDataDir();
		const id = randomUUID();
		const library = workspaceId && sessionId && dataRoot ? { workspaceId, sessionId, dataRoot } : undefined;
		const directory = library
			? getAttachmentDir(library.dataRoot, library.workspaceId, library.sessionId, id)
			: path.join(path.dirname(sessionFile), "uploads", id);
		await mkdir(directory, { recursive: true });
		return { name, storedName, id, library, directory, target: path.join(directory, storedName) };
	};
	// Record a written upload the same way for one-request and chunked uploads.
	const recordAttachment = (prepared: Awaited<ReturnType<typeof prepareAttachment>>, size: number) => {
		const { name, storedName, id, library, directory, target } = prepared;
		host.inputTouched = true;
		if (library) {
			const relativePath = toAttachmentRelativePath(library.dataRoot, target);
			const manifest = {
				version: 1 as const,
				id,
				originalName: name,
				storedName,
				mime: guessAttachmentMime(name),
				size,
				createdAt: new Date().toISOString(),
				relativePath,
			};
			writeAttachmentManifest(library.dataRoot, library.workspaceId, library.sessionId, id, manifest);
			return { name, path: relativePath, id: manifest.id, mime: manifest.mime, size: manifest.size };
		}
		try {
			writeLegacyAttachmentManifest(directory, {
				version: 1 as const,
				id: path.basename(directory),
				originalName: name,
				storedName,
				mime: guessAttachmentMime(name),
				size,
				createdAt: new Date().toISOString(),
				relativePath: target,
			});
		} catch {
			// Legacy layout keeps the previous absolute-path contract even when the manifest cannot be written.
		}
		return { name, path: target };
	};

	// Browser uploads retain their original bytes as session-owned context references.
	// New uploads land in the workspace attachment library with a manifest beside the file.
	server.route("POST", "/api/files/upload", async ({ body }) => {
		const payload = body as { name?: unknown; data?: unknown } | null;
		if (typeof payload?.name !== "string" || typeof payload.data !== "string")
			throw new HttpError(400, "Expected a file name and base64 data.");
		if (payload.data.length > Math.ceil((32 * 1024 * 1024) / 3) * 4)
			throw new HttpError(413, "Files must be 32 MiB or smaller.");
		if (payload.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))
			throw new HttpError(400, "Invalid base64 file data.");
		const prepared = await prepareAttachment(payload.name);
		const bytes = Buffer.from(payload.data, "base64");
		await writeFile(prepared.target, bytes, { flag: "wx" });
		return recordAttachment(prepared, bytes.length);
	});
	// Large files arrive in order, one chunk per request, and never sit whole in memory on either side. An upload
	// that is never finished leaves only its `.part` file, which no attachment list reads.
	const chunkedUploads = new Map<
		string,
		{ prepared: Awaited<ReturnType<typeof prepareAttachment>>; size: number; written: number }
	>();
	server.route("POST", "/api/files/upload/begin", async ({ body }) => {
		const payload = body as { name?: unknown; size?: unknown } | null;
		const size = Number(payload?.size);
		if (typeof payload?.name !== "string" || !Number.isSafeInteger(size) || size < 0)
			throw new HttpError(400, "Expected a file name and size.");
		if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files must be 500 MiB or smaller.");
		const prepared = await prepareAttachment(payload.name);
		chunkedUploads.set(prepared.id, { prepared, size, written: 0 });
		return { uploadId: prepared.id };
	});
	const chunkedUpload = (raw: unknown) => {
		const upload = typeof raw === "string" ? chunkedUploads.get(raw) : undefined;
		if (!upload) throw new HttpError(404, "This upload is no longer available.");
		return upload;
	};
	server.route("POST", "/api/files/upload/chunk", ({ body }) => {
		const payload = body as { uploadId?: unknown; offset?: unknown; data?: unknown } | null;
		const upload = chunkedUpload(payload?.uploadId);
		if (typeof payload?.data !== "string") throw new HttpError(400, "Expected base64 data.");
		try {
			upload.written = writeUploadChunk(
				`${upload.prepared.target}.part`,
				Number(payload.offset),
				decodeUploadChunk(payload.data),
				upload.size,
			);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : "Upload failed");
		}
		return { written: upload.written };
	});
	server.route("POST", "/api/files/upload/finish", async ({ body }) => {
		const payload = body as { uploadId?: unknown } | null;
		const upload = chunkedUpload(payload?.uploadId);
		const part = `${upload.prepared.target}.part`;
		if (upload.size === 0 && upload.written === 0) await writeFile(part, Buffer.alloc(0));
		else if (upload.written !== upload.size) throw new HttpError(409, "The file has not been fully uploaded.");
		if (existsSync(upload.prepared.target)) throw new HttpError(409, "The file already exists.");
		await rename(part, upload.prepared.target);
		chunkedUploads.delete(upload.prepared.id);
		return recordAttachment(upload.prepared, upload.size);
	});

	// ---- Session upload attachments ----------------------------------------------------
	// Non-image composer uploads live in the workspace attachment library (or, for a session without one, next to its
	// session file as `uploads/<id>/attachment-<name>`); history keeps only the path as text (relative to the Data root,
	// or absolute for legacy uploads), so the transcript and the sidebar read them back here.
	// A file deleted from disk answers as missing (`exists: false` / 404) and never breaks the page.
	function resolveUploadPath(raw: unknown): string {
		if (typeof raw !== "string" || !raw) throw new HttpError(400, "Missing path");
		const ref = raw.trim();
		if (!ref) throw new HttpError(400, "Missing path");
		try {
			const dataRoot = host.session.sessionManager.getDataRoot?.() ?? getDataDir();
			if (dataRoot && !ref.startsWith("\u0000")) {
				const resolved = resolveAttachmentReference(dataRoot, ref);
				if (resolved.split(path.sep).includes("uploads")) return resolved;
			}
		} catch {
			// Fall through to legacy absolute-path handling below.
		}
		const absolute = path.resolve(ref);
		if (!path.basename(absolute).startsWith("attachment-")) throw new HttpError(400, "Unknown attachment");
		if (!absolute.split(path.sep).includes("uploads")) throw new HttpError(400, "Unknown attachment");
		if (!existsSync(absolute)) throw new HttpError(404, "Attachment has been deleted.");
		return absolute;
	}

	function uploadMeta(absolute: string): {
		name: string;
		path: string;
		exists: boolean;
		size?: number;
		mtime?: number;
		mimeType?: string | null;
	} {
		const base = path.basename(absolute);
		const name = base.startsWith("attachment-") ? base.slice("attachment-".length) || base : base;
		try {
			const stat = statSync(absolute);
			if (!stat.isFile()) return { name, path: absolute, exists: false };
			return {
				name,
				path: absolute,
				exists: true,
				size: stat.size,
				mtime: stat.mtimeMs,
				mimeType: IMAGE_TYPES[path.extname(absolute).toLowerCase()] ?? null,
			};
		} catch {
			return { name, path: absolute, exists: false };
		}
	}

	server.route("GET", "/api/uploads/info", ({ url }) => {
		return uploadMeta(resolveUploadPath(url.searchParams.get("path")));
	});

	// Batch metadata for the attachment cards of one message or chat: one POST instead of one GET
	// per file. Read-only (statSync via uploadMeta); per-path failures stay per-path
	// (`{ ok: false, status, error }`) so one deleted file never fails the rest, and the whole
	// answer is always 200. Only the array shape is validated as a whole (400); ownership and
	// cleanup logic are untouched.
	server.route("POST", "/api/uploads/info-batch", ({ body }) => {
		const payload = body as { paths?: unknown } | null;
		const paths = payload?.paths;
		if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100)
			throw new HttpError(400, "Expected 1 to 100 paths");
		for (const candidate of paths) {
			if (typeof candidate !== "string" || candidate.length > 4096) throw new HttpError(400, "Invalid path");
		}
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const candidate of paths as string[]) {
			if (!seen.has(candidate)) {
				seen.add(candidate);
				unique.push(candidate);
			}
		}
		return {
			results: unique.map((uploadPath) => {
				try {
					return { path: uploadPath, ok: true as const, meta: uploadMeta(resolveUploadPath(uploadPath)) };
				} catch (error) {
					const status = error instanceof HttpError ? error.status : 500;
					return {
						path: uploadPath,
						ok: false as const,
						status,
						error: error instanceof Error ? error.message : "Request failed",
					};
				}
			}),
		};
	});

	server.route("GET", "/api/uploads/read", ({ url }) => {
		const absolute = resolveUploadPath(url.searchParams.get("path"));
		if (!existsSync(absolute)) throw new HttpError(404, "Attachment has been deleted.");
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(absolute);
		} catch {
			throw new HttpError(404, "Attachment has been deleted.");
		}
		if (!stat.isFile()) throw new HttpError(404, "Attachment has been deleted.");
		const meta = uploadMeta(absolute);
		const ext = path.extname(absolute).toLowerCase();
		const imageType = IMAGE_TYPES[ext];
		if (imageType && ext !== ".svg") {
			if (stat.size > MAX_IMAGE_BYTES) return { ...meta, kind: "large" as const };
			return {
				...meta,
				kind: "image" as const,
				mimeType: imageType,
				data: readFileSync(absolute).toString("base64"),
			};
		}
		if (stat.size > MAX_TEXT_BYTES) {
			const head = readFileSync(absolute).subarray(0, MAX_TEXT_BYTES);
			if (looksBinary(head)) return { ...meta, kind: "binary" as const };
			return { ...meta, kind: "text" as const, content: head.toString("utf8"), truncated: true };
		}
		const buffer = readFileSync(absolute);
		if (looksBinary(buffer)) return { ...meta, kind: "binary" as const };
		return { ...meta, kind: "text" as const, content: buffer.toString("utf8"), truncated: false };
	});

	server.route("GET", "/api/uploads/download", ({ url, res }) => {
		const absolute = resolveUploadPath(url.searchParams.get("path"));
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(absolute);
		} catch {
			throw new HttpError(404, "Attachment has been deleted.");
		}
		if (!stat.isFile()) throw new HttpError(404, "Attachment has been deleted.");
		res.setHeader("Content-Type", "application/octet-stream");
		res.setHeader(
			"Content-Disposition",
			`attachment; filename*=UTF-8''${encodeURIComponent(uploadMeta(absolute).name)}`,
		);
		res.end(readFileSync(absolute));
	});

	// Attachments of one conversation (sidebar groups them per chat): scanned off the persisted branch,
	// with on-disk state attached per file. Unknown sessions 404; unreadable histories 500; missing files
	// stay in the list as `exists: false` so the sidebar can say "deleted" instead of failing.
	server.route("GET", "/api/session/attachments", ({ url }) => {
		const sessionPath = url.searchParams.get("path");
		if (!sessionPath) throw new HttpError(400, "Missing path");
		const resolved = path.resolve(sessionPath);
		try {
			if (!statSync(resolved).isFile()) throw new HttpError(404, "Unknown session");
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw new HttpError(404, "Unknown session");
		}
		let manager: SessionManager;
		try {
			manager = SessionManager.open(resolved);
		} catch {
			throw new HttpError(404, "Unknown session");
		}
		let branch: ReturnType<SessionManager["getBranch"]>;
		try {
			branch = manager.getBranch();
		} catch {
			throw new HttpError(500, "Could not read the chat history.");
		}
		const seen = new Map<string, { messageId?: string; ts: number }>();
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
			if (!message || message.role !== "user") continue;
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? (content as Array<{ type?: string; text?: string }>)
								.filter((part) => part.type === "text")
								.map((part) => part.text ?? "")
								.join("")
						: "";
			const { attachments } = splitAttachmentText(text);
			const ts = Date.parse(entry.timestamp) || 0;
			for (const attachment of attachments) {
				if (!seen.has(attachment.path)) seen.set(attachment.path, { messageId: entry.id, ts });
			}
		}
		const entries = [...seen].map(([uploadPath, ref]) => {
			let meta: ReturnType<typeof uploadMeta>;
			try {
				meta = uploadMeta(resolveUploadPath(uploadPath));
			} catch {
				const base = String(uploadPath).replace(/\\/g, "/").split("/").pop() || String(uploadPath);
				meta = { name: base.replace(/^attachment-/, "") || base, path: uploadPath, exists: false };
			}
			return { ...meta, messageId: ref.messageId, ts: ref.ts };
		});
		entries.sort((a, b) => a.ts - b.ts);
		return { entries };
	});

	server.route("GET", "/api/files/list", ({ url }) => {
		const cwd = root();
		const dir = url.searchParams.get("dir") ?? "";
		const absolute = resolveInside(cwd, dir);
		if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new HttpError(404, "Not a directory");
		const matcher = loadIgnore(cwd);
		const entries = readdirSync(absolute, { withFileTypes: true })
			.filter((entry) => !(entry.isDirectory() && ALWAYS_HIDDEN_DIRS.has(entry.name)))
			.map((entry) => {
				const full = path.join(absolute, entry.name);
				const rel = relPosix(cwd, full);
				let size = 0;
				let mtime = 0;
				try {
					const stat = statSync(full);
					size = stat.size;
					mtime = stat.mtimeMs;
				} catch {
					// broken symlink: keep zeroes
				}
				const isDir = entry.isDirectory() || (entry.isSymbolicLink() && safeIsDirectory(full));
				return {
					name: entry.name,
					path: rel,
					type: isDir ? ("dir" as const) : ("file" as const),
					size,
					mtime,
					ignored: matcher.ignores(isDir ? `${rel}/` : rel),
				};
			})
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
		return { dir: relPosix(cwd, absolute), entries };
	});

	server.route("GET", "/api/files/read", ({ url }) => {
		const cwd = root();
		const rel = url.searchParams.get("path");
		if (!rel) throw new HttpError(400, "Missing path");
		const absolute = resolveFileTab(cwd, rel);
		if (!existsSync(absolute)) throw new HttpError(404, "File not found");
		const stat = statSync(absolute);
		if (!stat.isFile()) throw new HttpError(400, "Not a file");
		const ext = path.extname(absolute).toLowerCase();
		const base = { path: fileTabPath(cwd, absolute), absolutePath: absolute, size: stat.size, mtime: stat.mtimeMs };
		const imageType = IMAGE_TYPES[ext];
		if (imageType && ext !== ".svg") {
			if (stat.size > MAX_IMAGE_BYTES) return { ...base, kind: "large" as const };
			return {
				...base,
				kind: "image" as const,
				mimeType: imageType,
				data: readFileSync(absolute).toString("base64"),
			};
		}
		const media = MEDIA_TYPES[ext];
		if (media) {
			return {
				...base,
				kind: media.kind,
				mimeType: media.mime,
				rawUrl: `/api/files/raw?path=${encodeURIComponent(fileTabPath(cwd, absolute))}`,
			};
		}
		if (OFFICE_EXTENSIONS.has(ext)) {
			return { ...base, kind: "office" as const, mimeType: RAW_CONTENT_TYPES[ext] ?? "application/octet-stream" };
		}
		if (stat.size > MAX_TEXT_BYTES) {
			const head = readFileSync(absolute).subarray(0, MAX_TEXT_BYTES);
			if (looksBinary(head)) return { ...base, kind: "binary" as const };
			return {
				...base,
				kind: "text" as const,
				content: head.toString("utf8"),
				truncated: true,
				language: LANGUAGES[ext] ?? null,
			};
		}
		const buffer = readFileSync(absolute);
		if (looksBinary(buffer)) return { ...base, kind: "binary" as const };
		return {
			...base,
			kind: "text" as const,
			content: buffer.toString("utf8"),
			truncated: false,
			language: LANGUAGES[ext] ?? null,
		};
	});

	// Raw bytes for the viewers that need a real element (PDF pages, audio, video, large images).
	// Range requests are answered so media can seek; everything is read-only and confined to the workspace.
	server.route("GET", "/api/files/raw", ({ url, req, res }) => {
		const cwd = root();
		const rel = url.searchParams.get("path");
		if (!rel) throw new HttpError(400, "Missing path");
		const absolute = resolveFileTab(cwd, rel);
		if (!existsSync(absolute)) throw new HttpError(404, "File not found");
		const stat = statSync(absolute);
		if (!stat.isFile()) throw new HttpError(400, "Not a file");
		const type = RAW_CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream";
		const download = url.searchParams.get("download") === "1";
		const headers: Record<string, string | number> = {
			"content-type": type,
			"accept-ranges": "bytes",
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
			"content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(absolute))}`,
		};
		const range = req.headers.range;
		const parsed = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
		if (parsed && (parsed[1] !== "" || parsed[2] !== "")) {
			const start = parsed[1] === "" ? Math.max(0, stat.size - Number(parsed[2])) : Number(parsed[1]);
			const end =
				parsed[1] === ""
					? stat.size - 1
					: parsed[2] === ""
						? stat.size - 1
						: Math.min(Number(parsed[2]), stat.size - 1);
			if (start > end || start >= stat.size) {
				res.writeHead(416, { "content-range": `bytes */${stat.size}` });
				res.end();
				return;
			}
			res.writeHead(206, {
				...headers,
				"content-range": `bytes ${start}-${end}/${stat.size}`,
				"content-length": end - start + 1,
			});
			if (req.method === "HEAD") return res.end();
			createReadStream(absolute, { start, end })
				.on("error", () => res.destroy())
				.pipe(res);
			return;
		}
		res.writeHead(200, { ...headers, "content-length": stat.size });
		if (req.method === "HEAD") return res.end();
		createReadStream(absolute)
			.on("error", () => res.destroy())
			.pipe(res);
	});

	// Plain-text save for the code/text editor. The byte-for-byte baseline makes a concurrent Agent, editor or Git write
	// a conflict instead of being overwritten; a failed check writes nothing.
	server.route("POST", "/api/files/text", ({ body }) => {
		const payload = (body ?? {}) as { path?: unknown; original?: unknown; content?: unknown };
		if (
			typeof payload.path !== "string" ||
			typeof payload.original !== "string" ||
			typeof payload.content !== "string"
		)
			throw new HttpError(400, "Invalid text save request");
		const cwd = root();
		const absolute = resolveFileTab(cwd, payload.path);
		if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new HttpError(404, "File not found");
		if (
			MEDIA_TYPES[path.extname(absolute).toLowerCase()] ||
			OFFICE_EXTENSIONS.has(path.extname(absolute).toLowerCase())
		)
			throw new HttpError(400, "Binary files cannot be edited as text");
		const bytes = readFileSync(absolute);
		if (bytes.length > MAX_TEXT_BYTES) throw new HttpError(413, "File is too large to edit");
		if (looksBinary(bytes)) throw new HttpError(400, "File cannot be edited as text");
		const raw = bytes.toString("utf8");
		if (!Buffer.from(raw, "utf8").equals(bytes)) throw new HttpError(400, "Only UTF-8 text can be edited");
		const bom = raw.startsWith("\uFEFF");
		const original = bom ? raw.slice(1) : raw;
		if (original !== payload.original) throw new HttpError(409, "File changed on disk. Reopen it before saving.");
		if (Buffer.byteLength(payload.content, "utf8") > MAX_TEXT_BYTES) throw new HttpError(413, "Text is too large");
		try {
			writeFileSync(absolute, `${bom ? "\uFEFF" : ""}${payload.content}`, "utf8");
		} catch (error) {
			throw new HttpError(403, `Cannot write the file: ${error instanceof Error ? error.message : String(error)}`);
		}
		const written = statSync(absolute);
		return { path: fileTabPath(cwd, absolute), size: written.size, mtime: written.mtimeMs, content: payload.content };
	});

	// Only Markdown gets an editor; compare the complete source before writing so Agent/external edits are not lost.
	server.route("POST", "/api/files/markdown", ({ body }) => {
		const payload = (body ?? {}) as { path?: unknown; original?: unknown; blocks?: unknown };
		if (typeof payload.path !== "string" || typeof payload.original !== "string" || !Array.isArray(payload.blocks))
			throw new HttpError(400, "Invalid Markdown save request");
		const absolute = resolveFileTab(root(), payload.path);
		if (!/\.(md|markdown)$/iu.test(absolute)) throw new HttpError(400, "Only Markdown files can be edited here");
		if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new HttpError(404, "File not found");
		const bytes = readFileSync(absolute);
		if (bytes.length > MAX_TEXT_BYTES || looksBinary(bytes)) throw new HttpError(400, "File cannot be edited");
		const original = bytes.toString("utf8");
		if (!Buffer.from(original, "utf8").equals(bytes)) throw new HttpError(400, "Only UTF-8 Markdown can be edited");
		if (original !== payload.original) throw new HttpError(409, "File changed on disk. Reopen it before saving.");
		const converter = new NodeHtmlMarkdown({ codeBlockStyle: "fenced", keepDataImages: false });
		let raw = "";
		const blocks = payload.blocks.map((block: unknown) => {
			const value = block as { raw?: unknown; html?: unknown } | null;
			if (!value || typeof value.raw !== "string" || (value.html !== undefined && typeof value.html !== "string"))
				throw new HttpError(400, "Invalid Markdown block");
			raw += value.raw;
			return value.html === undefined ? value.raw : `${converter.translate(value.html as string)}\n\n`;
		});
		if (raw !== original) throw new HttpError(400, "Markdown baseline does not match");
		if (original.includes("\r\n")) {
			for (let index = 0; index < blocks.length; index++)
				blocks[index] = blocks[index]!.replace(/(?<!\r)\n/gu, "\r\n");
		}
		const content = blocks.join("");
		if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new HttpError(413, "Markdown is too large");
		writeFileSync(absolute, content, "utf8");
		return { content, blocks };
	});

	// Paged access for the hex view/editor and the large-text view/editor (file-pages.ts): no whole-file reads, and every
	// write is checked against the bytes the user saw.
	const pageTarget = (value: unknown) => {
		if (typeof value !== "string" || !value) throw new HttpError(400, "Missing path");
		return resolveFileTab(root(), value);
	};
	const intParam = (url: URL, name: string, fallback = 0) => {
		const value = Number(url.searchParams.get(name) ?? fallback);
		return Number.isFinite(value) ? Math.floor(value) : fallback;
	};
	server.route("GET", "/api/files/bytes", ({ url }) =>
		readBytes(pageTarget(url.searchParams.get("path")), intParam(url, "offset"), intParam(url, "length", 65536)),
	);
	server.route("POST", "/api/files/bytes", ({ body }) => {
		const payload = (body ?? {}) as { path?: unknown; size?: unknown; edits?: unknown };
		if (!Number.isSafeInteger(payload.size)) throw new HttpError(400, "Expected the file size");
		return writeBytes(pageTarget(payload.path), payload.size as number, payload.edits as never);
	});
	server.route("GET", "/api/files/bytes-search", ({ url }) => {
		const hex = url.searchParams.get("hex");
		const text = url.searchParams.get("text");
		const pattern =
			hex !== null ? Buffer.from(hex.replace(/[^0-9a-f]/gi, ""), "hex") : Buffer.from(text ?? "", "utf8");
		return searchBytes(
			pageTarget(url.searchParams.get("path")),
			pattern,
			intParam(url, "from"),
			url.searchParams.get("dir") === "back",
		);
	});
	server.route("GET", "/api/files/text-index", async ({ url }) => {
		const index = await lineIndex(pageTarget(url.searchParams.get("path")));
		return { size: index.size, mtime: index.mtime, lines: index.lines };
	});
	server.route("GET", "/api/files/text-lines", ({ url }) =>
		readLines(pageTarget(url.searchParams.get("path")), intParam(url, "start"), intParam(url, "count", 500)),
	);
	server.route("GET", "/api/files/text-search", ({ url }) =>
		searchLines(
			pageTarget(url.searchParams.get("path")),
			url.searchParams.get("q") ?? "",
			intParam(url, "from"),
			intParam(url, "limit", 200),
		),
	);
	server.route("GET", "/api/files/text-segment", ({ url }) =>
		readSegment(pageTarget(url.searchParams.get("path")), intParam(url, "start"), intParam(url, "count", 1000)),
	);
	server.route("POST", "/api/files/text-segment", ({ body }) => {
		const payload = (body ?? {}) as Record<string, unknown>;
		if (
			!Number.isSafeInteger(payload.size) ||
			typeof payload.original !== "string" ||
			typeof payload.content !== "string"
		)
			throw new HttpError(400, "Invalid text segment save request");
		const absolute = pageTarget(payload.path);
		const ext = path.extname(absolute).toLowerCase();
		if (MEDIA_TYPES[ext] || OFFICE_EXTENSIONS.has(ext))
			throw new HttpError(400, "Binary files cannot be edited as text");
		return writeSegment(
			absolute,
			payload.size as number,
			Number(payload.startByte),
			Number(payload.endByte),
			payload.original,
			payload.content,
		);
	});

	const officeTarget = (input: unknown) => {
		const absolute = pageTarget(input);
		if (!OFFICE_EXTENSIONS.has(path.extname(absolute).toLowerCase()))
			throw new HttpError(400, "Not an Office document");
		return absolute;
	};
	registerOfficeRoutes(server, {
		settings: () => ({
			url: host.session.settingsManager.getOfficeServerUrl(),
			secret: host.session.settingsManager.getOfficeJwtSecret(),
		}),
		resolve: officeTarget,
	});
	registerOfficePreview(server, officeTarget);
	registerHtmlPreview(server, pageTarget);

	server.route("GET", "/api/files/search", ({ url }) => {
		const cwd = root();
		const query = (url.searchParams.get("q") ?? "").trim();
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, 100);
		const matcher = loadIgnore(cwd);
		const files: string[] = [];
		const stack: string[] = [cwd];
		while (stack.length > 0 && files.length < MAX_SEARCH_FILES) {
			const dir = stack.pop()!;
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				const rel = relPosix(cwd, full);
				if (entry.isDirectory()) {
					if (SEARCH_SKIP_DIRS.has(entry.name) || matcher.ignores(`${rel}/`)) continue;
					stack.push(full);
				} else if (entry.isFile() && !matcher.ignores(rel)) {
					files.push(rel);
				}
			}
		}
		const scored = query
			? files
					.map((file) => ({ file, score: fuzzyScore(query, file) }))
					.filter((entry) => entry.score >= 0)
					.sort((a, b) => b.score - a.score)
			: files.sort().map((file) => ({ file, score: 0 }));
		return { files: scored.slice(0, limit).map((entry) => entry.file), truncated: files.length >= MAX_SEARCH_FILES };
	});

	// ---- Saved full output of truncated tool results -----------------------------------------
	server.route("GET", "/api/tool-output", ({ url }) => {
		const requested = url.searchParams.get("path");
		if (!requested) throw new HttpError(400, "Missing path");
		const manager = host.session.sessionManager;
		const roots = [path.join(manager.getSessionDir(), "tool-results"), path.join(tmpdir(), "myharness-tool-results")];
		let real: string;
		try {
			real = realpathSync(path.resolve(requested));
		} catch {
			throw new HttpError(404, "Output file not found");
		}
		const allowed = roots.some((root) => {
			try {
				const relative = path.relative(realpathSync(root), real);
				return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
			} catch {
				return false;
			}
		});
		if (!allowed) throw new HttpError(403, "Only saved tool output can be read here");
		const stat = statSync(real);
		if (!stat.isFile()) throw new HttpError(400, "Not a file");
		// Chunked first-block read: `limit` bytes from `offset` (512 KB default and maximum), opened and read at the
		// offset instead of readFileSync on the whole file. The cumulative window stays 4 MB. A block that
		// ends inside a UTF-8 sequence is cut back to the character boundary and `nextOffset` follows it,
		// so every caller resumes on clean text. Out-of-range offsets answer with an empty block, no throw.
		const size = stat.size;
		const offsetParam = Number(url.searchParams.get("offset"));
		const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;
		const limitParam = Number(url.searchParams.get("limit"));
		const limit = Math.min(
			Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : TOOL_OUTPUT_DEFAULT_CHUNK,
			TOOL_OUTPUT_DEFAULT_CHUNK,
		);
		const window = Math.min(size, TOOL_OUTPUT_MAX_TOTAL);
		if (offset >= size) return { size, truncated: false, nextOffset: size, text: "" };
		if (offset >= window) return { size, truncated: true, nextOffset: window, text: "" };
		const end = Math.min(offset + limit, window);
		const chunk = Buffer.allocUnsafe(end - offset);
		let bytesRead = 0;
		const fd = openSync(real, "r");
		try {
			bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
		} finally {
			closeSync(fd);
		}
		const reached = offset + bytesRead;
		const cut = reached >= size ? 0 : utf8IncompleteTailBytes(chunk.subarray(0, bytesRead));
		const nextOffset = reached - cut;
		return { size, truncated: nextOffset < size, nextOffset, text: chunk.toString("utf8", 0, bytesRead - cut) };
	});

	// ---- Changes / Diff ---------------------------------------------------------
	server.route("GET", "/api/changes", async ({ url }) => {
		const requestedScope = url.searchParams.get("scope");
		const scope = requestedScope === "worktree" ? "worktree" : requestedScope === "session" ? "session" : "run";
		const fresh = url.searchParams.get("fresh") === "1";
		// The number on the "Current conversation" button: the uncommitted files this chat changed last. A file another
		// conversation changed more recently belongs to that conversation, so the list keeps it as history while the number
		// and the commit leave it out (see session-ownership.ts). Both scopes answer the number, because both buttons show
		// their number at the same time.
		const attributionOf = async (changes: readonly { path: string }[]) => {
			const conversation = collectSessionChanges(host.session.sessionManager.getBranch()).files;
			return attributeConversationFiles({
				sessionKey: host.session.sessionId,
				conversationPaths: conversation.map((file) => file.path),
				cwd: currentCwd(),
				dirtyPaths: changes.map((change) => change.path),
				registry: host.changeClaims,
			}).catch(() => undefined);
		};
		const withElsewhereMark = (files: FileChangeSummary[], attribution: ConversationAttribution | undefined) => {
			if (!attribution || attribution.elsewhere.size === 0) return files;
			const cwd = currentCwd();
			return files.map((file) =>
				isElsewhereOwned(attribution.elsewhere, cwd, file.path) ? { ...file, lastChangeElsewhere: true } : file,
			);
		};
		if (scope === "session") {
			const { files } = collectSessionChanges(host.session.sessionManager.getBranch());
			// A conversation that recorded no change yet is the common case: answer without reading Git at all.
			if (files.length === 0) return { scope, files, total: 0, uncommitted: 0 };
			const listed = await host.tracker
				.listWorktreeChanges(fresh ? { forceRefresh: true } : undefined)
				.catch(() => undefined);
			const attribution = listed?.repositoryRoot ? await attributionOf(listed.changes) : undefined;
			return {
				scope,
				files: withElsewhereMark(files, attribution),
				total: files.length,
				uncommitted: attribution?.own.length,
			};
		}
		// The conversation's own count rides on both scopes' answers, so its button keeps the number while the other scope
		// is on screen instead of blanking on every switch.
		const checkpoint = host.session.getGitCheckpoint();
		if (scope === "worktree") {
			const cwd = currentCwd();
			const cached = fresh ? undefined : getCachedWorktreeChangesSync(cwd);
			if (cached?.files) {
				const attribution = cached.repositoryRoot ? await attributionOf(cached.changes) : undefined;
				return {
					scope,
					files: cached.files,
					total: cached.changes.length,
					error: cached.error ?? null,
					uncommitted: attribution?.own.length,
				};
			}
			const listed = await host.tracker.listWorktreeChanges(fresh ? { forceRefresh: true } : undefined);
			const root = listed.repositoryRoot;
			const files = root ? await host.tracker.batchWorktreeStats(root, listed.changes.slice(0, 300)) : [];
			setCachedWorktreeChanges(cwd, {
				repositoryRoot: listed.repositoryRoot,
				changes: listed.changes,
				files,
				error: listed.error,
				cacheVersion: listed.cacheVersion,
			});
			return {
				scope,
				files,
				total: listed.changes.length,
				error: listed.error ?? null,
				uncommitted: (root ? await attributionOf(listed.changes) : undefined)?.own.length,
			};
		}
		const runParam = url.searchParams.get("runId");
		const runId = runParam ? Number(runParam) : host.tracker.latestRunId();
		if (runId === undefined || Number.isNaN(runId))
			return { scope, runs: host.tracker.listRuns().map(runInfo), files: [], total: 0, run: null };
		const record = host.tracker.getRun(runId);
		if (!record) return { scope, runs: host.tracker.listRuns().map(runInfo), files: [], total: 0, run: null };
		const files = host.tracker.summariseRun(runId, checkpoint);
		return {
			scope,
			runs: host.tracker.listRuns().map(runInfo),
			run: {
				...runInfo(record),
				git: record.git ?? null,
				reason: record.reason ?? null,
				checkpointStatus: host.tracker.checkpointStatus(runId) ?? null,
			},
			files,
			total: record.changes.length,
		};
	});

	server.route("GET", "/api/changes/diff", async ({ url }) => {
		const requestedScope = url.searchParams.get("scope");
		const scope = requestedScope === "worktree" ? "worktree" : requestedScope === "session" ? "session" : "run";
		const file = url.searchParams.get("path");
		if (!file) throw new HttpError(400, "Missing path");
		if (scope === "session") {
			const { files, diffs } = collectSessionChanges(host.session.sessionManager.getBranch());
			const summary = files.find((candidate) => candidate.path === file);
			if (!summary) throw new HttpError(404, "No such change");
			return { summary, history: diffs.get(file) ?? [] };
		}
		if (scope === "worktree") {
			const cwd = currentCwd();
			const fresh = url.searchParams.get("fresh") === "1";
			let cached = fresh ? undefined : getCachedWorktreeChangesSync(cwd);
			if (!cached) {
				const freshListed = await host.tracker.listWorktreeChanges(fresh ? { forceRefresh: true } : undefined);
				cached = setCachedWorktreeChanges(cwd, freshListed);
			}
			let change = cached.changesByPath.get(file);
			if (!change && cached.repositoryRoot) {
				invalidateWorktreeCache(cwd);
				const freshListed = await host.tracker.listWorktreeChanges({ forceRefresh: true });
				cached = setCachedWorktreeChanges(cwd, freshListed);
				change = cached.changesByPath.get(file);
			}
			if (!change || !cached.repositoryRoot) throw new HttpError(404, "No such change");
			return host.tracker.diffForWorktreeFile(cached.repositoryRoot, change);
		}
		const runParam = url.searchParams.get("runId");
		const runId = runParam ? Number(runParam) : host.tracker.latestRunId();
		if (runId === undefined) throw new HttpError(404, "No run recorded");
		const result = host.tracker.diffForRunFile(runId, file, host.session.getGitCheckpoint());
		if (!result) throw new HttpError(404, "No such change");
		return result;
	});

	// One file of a change card in the conversation: the diff kept with the card in the session, so the card of an
	// earlier task still shows that task's own changes. A diff that was too large to keep (or a card that was only
	// shown, not saved) falls back to the task's record in this server process.
	server.route("GET", "/api/changes/card-diff", ({ url }) => {
		const file = url.searchParams.get("path");
		if (!file) throw new HttpError(400, "Missing path");
		const entry = host.session.sessionManager.getEntry(url.searchParams.get("id") ?? "");
		const card =
			entry?.type === "custom" && entry.customType === RUN_CHANGES_ENTRY
				? (entry.data as { runId?: number; files?: RunChangeCardFile[] } | undefined)
				: undefined;
		const kept = card?.files?.find((candidate) => candidate?.path === file);
		if (kept && !kept.patchOmitted) {
			const { patch, patchOmitted: _omitted, ...summary } = kept;
			return { summary, ...(patch ? { patch } : {}) };
		}
		const runId = Number(card?.runId ?? url.searchParams.get("runId"));
		const live = Number.isFinite(runId)
			? host.tracker.diffForRunFile(runId, file, host.session.getGitCheckpoint())
			: undefined;
		if (live) return live;
		if (!kept) throw new HttpError(404, "No such change");
		const { patch: _patch, patchOmitted: _omitted, ...summary } = kept;
		return { summary: { ...summary, unavailable: "The diff of this file was too large to keep with the chat." } };
	});
}

function safeIsDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function runInfo(record: import("./changes.ts").RunChangeRecord) {
	return {
		runId: record.runId,
		startedAt: record.startedAt,
		endedAt: record.endedAt ?? null,
		reliability: record.reliability,
		fileCount: record.changes.length,
		bashRuns: record.bashRuns,
		checkpointId: record.checkpointId ?? null,
	};
}

/** Folder picker for "Add workspace": lists sub-folders only (never file names or contents). */
interface FolderPlace {
	id: string;
	name: string;
	path: string;
}

const SKIPPED_FOLDER_NAMES = new Set(["$RECYCLE.BIN", "System Volume Information", "Recovery", "Config.Msi"]);

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** Windows drive roots that exist right now. */
function listDrives(): FolderPlace[] {
	if (process.platform !== "win32") return [{ id: "root", name: "/", path: "/" }];
	const drives: FolderPlace[] = [];
	for (let code = 65; code <= 90; code++) {
		const letter = String.fromCharCode(code);
		try {
			const root = `${letter}:${path.sep}`;
			if (existsSync(root)) drives.push({ id: `drive-${letter}`, name: `${letter}:`, path: root });
		} catch {
			// inaccessible drive: skip
		}
	}
	return drives;
}

/** The usual starting folders of a desktop user (Desktop, Documents, Downloads … and the home folder). */
function listPlaces(): FolderPlace[] {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? undefined;
	const oneDrive = process.env.OneDrive ?? process.env.OneDriveConsumer ?? undefined;
	const places: FolderPlace[] = [];
	const seen = new Set<string>();
	const add = (id: string, name: string, candidates: Array<string | undefined>) => {
		for (const candidate of candidates) {
			if (!candidate || !isDirectory(candidate)) continue;
			const key = path.resolve(candidate).toLowerCase();
			if (seen.has(key)) return;
			seen.add(key);
			places.push({ id, name, path: path.resolve(candidate) });
			return;
		}
	};
	if (home) add("home", path.basename(home), [home]);
	for (const [id, name] of [
		["desktop", "Desktop"],
		["documents", "Documents"],
		["downloads", "Downloads"],
	] as const) {
		add(id, name, [oneDrive && path.join(oneDrive, name), home && path.join(home, name)]);
	}
	return places;
}

function browse(target: string, host: WebHost) {
	const absolute = path.resolve(target);
	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new HttpError(404, "Not a folder");
	let names: import("node:fs").Dirent[] = [];
	try {
		names = readdirSync(absolute, { withFileTypes: true });
	} catch (error) {
		throw new HttpError(403, error instanceof Error ? error.message : "Cannot read folder");
	}
	const parent = path.dirname(absolute);
	const registered = new Set(
		host.workspaceStore.list().map((workspace) => path.resolve(workspace.rootPath).toLowerCase()),
	);
	return {
		path: absolute,
		parent: parent === absolute ? "" : parent,
		dirs: names
			.filter((entry) => entry.isDirectory() && !SKIPPED_FOLDER_NAMES.has(entry.name))
			.map((entry) => {
				const full = path.join(absolute, entry.name);
				return {
					name: entry.name,
					path: full,
					hidden: entry.name.startsWith("."),
					workspace: registered.has(full.toLowerCase()),
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
		workspace: registered.has(absolute.toLowerCase()),
		current: host.session.sessionManager.getCwd(),
	};
}

export function registerFolderBrowser(server: WebHttpServer, host: WebHost): void {
	server.route("GET", "/api/fs/places", () => ({
		places: listPlaces(),
		drives: listDrives(),
		current: host.session.sessionManager.getCwd(),
		separator: path.sep,
	}));

	server.route("GET", "/api/fs/browse", ({ url }) => {
		const requested = url.searchParams.get("path") ?? "";
		if (!requested) {
			// "This PC": the drives (or the file system root) instead of a folder.
			const drives = listDrives();
			return {
				path: "",
				parent: null,
				dirs: drives.map((drive) => ({ ...drive, hidden: false, workspace: false })),
				workspace: false,
			};
		}
		return browse(requested, host);
	});

	/**
	 * Choose a folder in the operating system's own folder window (shown on this computer, in front of the browser).
	 * Answers `{ path }`, or `{ cancelled: true }` when the user closed the window. 501 where there is no such window:
	 * the page then falls back to its built-in folder list.
	 */
	server.route("POST", "/api/fs/pick-folder", async ({ body }) => {
		if (!nativeFolderDialogAvailable()) throw new HttpError(501, "No system folder window on this platform.");
		if (folderDialogOpen()) throw new HttpError(409, "A folder window is already open.");
		const title = (body as { title?: unknown } | null)?.title;
		try {
			return await pickFolderWithSystemDialog(typeof title === "string" ? title.slice(0, 120) : "");
		} catch (error) {
			throw new HttpError(500, error instanceof Error ? error.message : "The folder window could not be opened.");
		}
	});

	server.route("POST", "/api/fs/mkdir", ({ body }) => {
		const payload = (body ?? {}) as { parent?: unknown; name?: unknown };
		if (typeof payload.parent !== "string" || typeof payload.name !== "string") {
			throw new HttpError(400, '"parent" and "name" must be strings');
		}
		const name = payload.name.trim();
		if (!name || name === "." || name === ".." || /[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name)) {
			throw new HttpError(400, "That is not a valid folder name.");
		}
		const parent = path.resolve(payload.parent);
		if (!isDirectory(parent)) throw new HttpError(404, "Not a folder");
		const created = path.join(parent, name);
		if (existsSync(created)) throw new HttpError(409, "A file or folder with that name already exists.");
		try {
			mkdirSync(created);
		} catch (error) {
			throw new HttpError(403, error instanceof Error ? error.message : "Cannot create the folder");
		}
		return { path: created };
	});
}
