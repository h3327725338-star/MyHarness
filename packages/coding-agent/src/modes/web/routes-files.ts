/** Web API routes for the workspace file browser and for change/diff review. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import ignore from "ignore";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { getDataDir } from "../../config/paths/index.ts";
import {
	artifactScope,
	listArtifacts,
	refreshArtifactIndexes,
	resolveArtifact,
} from "../../session/artifacts/store.ts";
import { listMemoryFiles, migrateLegacyMemories, restoreMemoryArchive } from "../../session/memory/store.ts";
import type { RunChangeCardFile } from "./changes.ts";
import { folderDialogOpen, nativeFolderDialogAvailable, pickFolderWithSystemDialog } from "./folder-dialog.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import { collectSessionChanges } from "./session-changes.ts";
import { RUN_CHANGES_ENTRY } from "./wire.ts";

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

/** Maps items with at most `limit` calls running at once, keeping the input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export function registerFileRoutes(server: WebHttpServer, host: WebHost): void {
	const root = () => path.resolve(host.session.sessionManager.getCwd());

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
			entries: listMemoryFiles(dataRoot).filter(
				(entry) =>
					level === "global" ||
					(entry.workspaceId === manager.getWorkspaceId() &&
						(level === "workspace" || entry.sessionId === manager.getSessionId())),
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

	// Browser uploads retain their original bytes as session-owned context references.
	server.route("POST", "/api/files/upload", async ({ body }) => {
		const payload = body as { name?: unknown; data?: unknown } | null;
		if (typeof payload?.name !== "string" || typeof payload.data !== "string")
			throw new HttpError(400, "Expected a file name and base64 data.");
		if (payload.data.length > Math.ceil((32 * 1024 * 1024) / 3) * 4)
			throw new HttpError(413, "Files must be 32 MiB or smaller.");
		if (payload.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))
			throw new HttpError(400, "Invalid base64 file data.");
		const name =
			path
				.basename(payload.name.replaceAll("\\", "/"))
				.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
				.replace(/[. ]+$/g, "") || "file";
		const sessionFile = host.session.sessionManager.getSessionFile();
		if (!sessionFile) throw new HttpError(409, "No current session.");
		const directory = path.join(path.dirname(sessionFile), "uploads", randomUUID());
		const target = path.join(directory, `attachment-${name}`);
		await mkdir(directory, { recursive: true });
		await writeFile(target, Buffer.from(payload.data, "base64"), { flag: "wx" });
		host.inputTouched = true;
		return { name, path: target };
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
		const absolute = resolveInside(cwd, rel);
		if (!existsSync(absolute)) throw new HttpError(404, "File not found");
		const stat = statSync(absolute);
		if (!stat.isFile()) throw new HttpError(400, "Not a file");
		const ext = path.extname(absolute).toLowerCase();
		const base = { path: relPosix(cwd, absolute), size: stat.size, mtime: stat.mtimeMs };
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

	// Only Markdown gets an editor; compare the complete source before writing so Agent/external edits are not lost.
	server.route("POST", "/api/files/markdown", ({ body }) => {
		const payload = (body ?? {}) as { path?: unknown; original?: unknown; blocks?: unknown };
		if (typeof payload.path !== "string" || typeof payload.original !== "string" || !Array.isArray(payload.blocks))
			throw new HttpError(400, "Invalid Markdown save request");
		const absolute = resolveInside(root(), payload.path);
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
		const buffer = readFileSync(real);
		const limit = 4 * 1024 * 1024;
		return { size: stat.size, truncated: buffer.length > limit, text: buffer.subarray(0, limit).toString("utf8") };
	});

	// ---- Changes / Diff ---------------------------------------------------------
	server.route("GET", "/api/changes", async ({ url }) => {
		const requestedScope = url.searchParams.get("scope");
		const scope = requestedScope === "worktree" ? "worktree" : requestedScope === "session" ? "session" : "run";
		if (scope === "session") {
			const { files } = collectSessionChanges(host.session.sessionManager.getBranch());
			return { scope, files, total: files.length };
		}
		const checkpoint = host.session.getGitCheckpoint();
		if (scope === "worktree") {
			const listed = await host.tracker.listWorktreeChanges();
			const root = listed.repositoryRoot;
			const files = root
				? await mapLimited(
						listed.changes.slice(0, 300),
						8,
						async (change) => (await host.tracker.diffForWorktreeFile(root, change)).summary,
					)
				: [];
			return { scope, files, total: listed.changes.length, error: listed.error ?? null };
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
			const listed = await host.tracker.listWorktreeChanges();
			const change = listed.changes.find((candidate) => candidate.path === file);
			if (!change || !listed.repositoryRoot) throw new HttpError(404, "No such change");
			return host.tracker.diffForWorktreeFile(listed.repositoryRoot, change);
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
