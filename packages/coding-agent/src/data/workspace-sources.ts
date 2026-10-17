import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getWorkspaceUploadsDir } from "../config/paths/index.ts";
import { decodeUploadChunk, MAX_UPLOAD_BYTES, writeUploadChunk } from "./upload-chunks.ts";

export interface WorkspaceSource {
	id: string;
	name: string;
	path: string;
	/** Bytes of the stored file, or of every file inside a folder source. */
	size: number;
	/** Modification time of the stored file, or of the newest file inside a folder (ms since epoch). */
	modified: number;
	kind: "file" | "folder";
	/** Folder sources only: how many files they hold, sub-folders included. */
	fileCount?: number;
}
/** One entry below a folder source, for the sources page tree. */
export interface WorkspaceSourceNode {
	name: string;
	/** Posix path relative to the folder source's root; what deleting one entry names. */
	path: string;
	kind: "file" | "folder";
	size: number;
	modified: number;
	fileCount?: number;
	children?: WorkspaceSourceNode[];
}
/** Why a source could not be deleted: a malformed id, a source that is not there, or a directory left untouched. */
export class WorkspaceSourceError extends Error {
	readonly code: "invalid" | "not_found" | "refused";
	constructor(code: "invalid" | "not_found" | "refused", message: string) {
		super(message);
		this.code = code;
	}
}
const SOURCE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STORED_FILE = /^source-[^\\/:*?"<>|]+$/;
const STORED_FOLDER = /^folder-[^\\/:*?"<>|]+$/;
/** Chunks of files still being uploaded live here, beside (never inside) the stored file or folder. */
const STAGING_DIR = "staging";
/** Longest absolute path a stored file may get: Windows tools past MAX_PATH (260) are unreliable. */
const MAX_STORED_PATH = 250;
/** Segment length caps tried in turn when a folder's deepest paths would be too long. */
const SEGMENT_CAPS = [180, 120, 80, 60, 40, 30, 20, 12];
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const UNEXPECTED_ENTRIES = "The source directory holds unexpected entries and was left as is.";

function sourceRoot(dataRoot: string, workspaceId: string): string {
	const root = getWorkspaceUploadsDir(dataRoot, workspaceId);
	// Refuse indirect roots; never write through a user-created junction/symlink.
	for (const directory of [dataRoot, join(dataRoot, "workspaces"), join(dataRoot, "workspaces", workspaceId), root]) {
		if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
			throw new Error("Indirect source directories are not supported.");
	}
	return root;
}

interface SourceManifest {
	kind: "file" | "folder";
	name: string;
	storedName: string;
	size: number;
}
/** Read one source's manifest. Version 1 (no `kind`) is a single file; version 2 adds `kind: "folder"`. */
function readManifest(directory: string): SourceManifest | undefined {
	const manifest = join(directory, "source.json");
	if (lstatSync(manifest).isSymbolicLink()) return undefined;
	const source = JSON.parse(readFileSync(manifest, "utf8"));
	if (typeof source.name !== "string" || typeof source.storedName !== "string") return undefined;
	if (source.kind === "folder")
		return STORED_FOLDER.test(source.storedName)
			? { kind: "folder", name: source.name, storedName: source.storedName, size: 0 }
			: undefined;
	if (!Number.isFinite(source.size) || !STORED_FILE.test(source.storedName)) return undefined;
	return { kind: "file", name: source.name, storedName: source.storedName, size: source.size };
}
/** Walk a folder source; links and anything that is neither a file nor a directory are not part of it. */
function walkFolder(directory: string, relativePath: string, name: string): WorkspaceSourceNode {
	const children: WorkspaceSourceNode[] = [];
	let size = 0;
	let fileCount = 0;
	let modified = 0;
	let entries: string[] = [];
	try {
		entries = readdirSync(directory);
	} catch {
		/* An unreadable folder shows as empty. */
	}
	for (const entry of entries) {
		const path = join(directory, entry);
		const childPath = relativePath ? `${relativePath}/${entry}` : entry;
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		let child: WorkspaceSourceNode;
		if (stat.isDirectory()) child = walkFolder(path, childPath, entry);
		else if (stat.isFile())
			child = { name: entry, path: childPath, kind: "file", size: stat.size, modified: stat.mtimeMs };
		else continue;
		children.push(child);
		size += child.size;
		fileCount += child.kind === "file" ? 1 : (child.fileCount ?? 0);
		modified = Math.max(modified, child.modified);
	}
	if (!modified) {
		try {
			modified = lstatSync(directory).mtimeMs;
		} catch {
			/* keep 0 */
		}
	}
	return { name, path: relativePath, kind: "folder", size, modified, fileCount, children };
}
function readSource(root: string, id: string): WorkspaceSource | undefined {
	try {
		const directory = join(root, id);
		const manifest = readManifest(directory);
		if (!manifest) return undefined;
		const path = join(directory, manifest.storedName);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return undefined;
		if (manifest.kind === "folder") {
			if (!stat.isDirectory()) return undefined;
			const tree = walkFolder(path, "", manifest.name);
			return {
				id,
				name: manifest.name,
				path,
				size: tree.size,
				modified: tree.modified,
				kind: "folder",
				fileCount: tree.fileCount ?? 0,
			};
		}
		if (!stat.isFile()) return undefined;
		return { id, name: manifest.name, size: manifest.size, path, modified: stat.mtimeMs, kind: "file" };
	} catch {
		/* An incomplete upload does not become a source. */
		return undefined;
	}
}
export function listWorkspaceSources(dataRoot: string, workspaceId: string): WorkspaceSource[] {
	const root = sourceRoot(dataRoot, workspaceId);
	if (!existsSync(root)) return [];
	const sources: WorkspaceSource[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
		const source = readSource(root, entry.name);
		if (source) sources.push(source);
	}
	return sources;
}
/** The entries inside one folder source, for the sources page; a single-file source has none. */
export function readWorkspaceSourceTree(
	dataRoot: string,
	workspaceId: string,
	sourceId: string,
): WorkspaceSourceNode[] {
	if (!SOURCE_ID.test(sourceId)) throw new WorkspaceSourceError("invalid", "Invalid source id.");
	const directory = join(sourceRoot(dataRoot, workspaceId), sourceId);
	let manifest: SourceManifest | undefined;
	try {
		manifest = lstatSync(directory).isSymbolicLink() ? undefined : readManifest(directory);
	} catch {
		manifest = undefined;
	}
	if (!manifest) throw new WorkspaceSourceError("not_found", "This source no longer exists.");
	if (manifest.kind !== "folder") return [];
	const path = join(directory, manifest.storedName);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new WorkspaceSourceError("refused", "Indirect source directories are not supported.");
	return walkFolder(path, "", manifest.name).children ?? [];
}

/** The same character cleaning as single-file sources, plus Windows device names, for one path segment. */
function cleanSegment(name: string): string {
	const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
	if (!cleaned) return "_";
	return RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}
/** Fit a cleaned name into `cap` characters, keeping a short extension and an optional uniqueness suffix. */
function fitSegment(name: string, cap: number, suffix = ""): string {
	if (!suffix && name.length <= cap) return name;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 && name.length - dot <= Math.floor(cap / 2) ? name.slice(dot) : "";
	let base = (ext ? name.slice(0, dot) : name).slice(0, Math.max(1, cap - suffix.length - ext.length));
	// Never end on half a surrogate pair, a dot or a space.
	if (/[\ud800-\udbff]$/.test(base)) base = base.slice(0, -1);
	base = base.replace(/[. ]+$/g, "") || "_";
	return `${base}${suffix}${ext}`;
}
interface NameNode {
	children: Map<string, NameNode>;
	used: Set<string>;
	stored: string;
}
/** The stored name of one child; cleaned and shortened names that collide (case-insensitively) get `~2`, `~3`… */
function childName(parent: NameNode, original: string, cap: number): NameNode {
	const existing = parent.children.get(original);
	if (existing) return existing;
	const cleaned = cleanSegment(original);
	let stored = fitSegment(cleaned, cap);
	for (let n = 2; parent.used.has(stored.toLowerCase()); n++) stored = fitSegment(cleaned, cap, `~${n}`);
	parent.used.add(stored.toLowerCase());
	const node: NameNode = { stored, children: new Map(), used: new Set() };
	parent.children.set(original, node);
	return node;
}

export interface WorkspaceSourceUploadItem {
	kind: "file" | "folder";
	/** The file name, or the top folder's name. */
	name: string;
	/** Folder items: paths relative to the folder ("sub/file.txt"). A file item has one entry, its own name. */
	files: Array<{ path: string; size: number }>;
}
export interface WorkspaceSourceUploadProblem {
	/** Index of the item in the request. */
	item: number;
	path: string;
	reason: "too_large" | "path_too_long" | "invalid_path" | "invalid_size";
}
export interface StagedWorkspaceSourceUpload {
	id: string;
	kind: "file" | "folder";
	name: string;
	directory: string;
	storedName: string;
	entries: Array<{ path: string; size: number; target: string; done: boolean }>;
}

function planItem(
	root: string,
	item: WorkspaceSourceUploadItem,
	index: number,
	problems: WorkspaceSourceUploadProblem[],
): StagedWorkspaceSourceUpload | undefined {
	const id = randomUUID();
	const directory = join(root, id);
	const before = problems.length;
	const seen = new Set<string>();
	if (!item.files.length || (item.kind === "file" && item.files.length !== 1))
		problems.push({ item: index, path: item.name, reason: "invalid_path" });
	for (const file of item.files) {
		const segments = file.path.split("/");
		if (
			!file.path ||
			seen.has(file.path) ||
			segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
		)
			problems.push({ item: index, path: file.path, reason: "invalid_path" });
		else if (!Number.isSafeInteger(file.size) || file.size < 0)
			problems.push({ item: index, path: file.path, reason: "invalid_size" });
		else if (file.size > MAX_UPLOAD_BYTES) problems.push({ item: index, path: file.path, reason: "too_large" });
		seen.add(file.path);
	}
	if (problems.length > before) return undefined;
	const cleanedName = item.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "") || "file";
	if (item.kind === "file") {
		const file = item.files[0]!;
		for (const cap of SEGMENT_CAPS) {
			const storedName = `source-${fitSegment(cleanedName, cap)}`;
			const target = join(directory, storedName);
			if (target.length <= MAX_STORED_PATH)
				return {
					id,
					kind: "file",
					name: item.name.slice(0, 255),
					directory,
					storedName,
					entries: [{ path: file.path, size: file.size, target, done: false }],
				};
		}
		problems.push({ item: index, path: file.path, reason: "path_too_long" });
		return undefined;
	}
	// Names are given in sorted order so `~2` suffixes do not depend on the order the browser listed the files in;
	// entries keep the request's order, which is how chunks address them.
	const sorted = [...item.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	let tooLong: string[] = [];
	for (const cap of SEGMENT_CAPS) {
		const storedName = `folder-${fitSegment(cleanedName, cap)}`;
		const top: NameNode = { stored: storedName, children: new Map(), used: new Set() };
		const targets = new Map<string, string>();
		tooLong = [];
		for (const file of sorted) {
			let node = top;
			const parts = [directory, storedName];
			for (const segment of file.path.split("/")) {
				node = childName(node, segment, cap);
				parts.push(node.stored);
			}
			const target = join(...parts);
			if (target.length > MAX_STORED_PATH) tooLong.push(file.path);
			targets.set(file.path, target);
		}
		if (!tooLong.length) {
			const entries = item.files.map((file) => ({
				path: file.path,
				size: file.size,
				target: targets.get(file.path)!,
				done: false,
			}));
			return { id, kind: "folder", name: item.name.slice(0, 255), directory, storedName, entries };
		}
	}
	for (const path of tooLong) problems.push({ item: index, path, reason: "path_too_long" });
	return undefined;
}

/**
 * Check and prepare a batch of sources. Every problem in every item is reported, and nothing is written unless the
 * whole batch is acceptable. A folder source gets its manifest and directories at once, so each of its files shows up
 * as soon as it is complete; a single file's manifest is written only once its bytes are complete.
 */
export function stageWorkspaceSourceUploads(
	dataRoot: string,
	workspaceId: string,
	items: WorkspaceSourceUploadItem[],
): { problems: WorkspaceSourceUploadProblem[]; staged: StagedWorkspaceSourceUpload[] } {
	const root = sourceRoot(dataRoot, workspaceId);
	const problems: WorkspaceSourceUploadProblem[] = [];
	const planned = items.map((item, index) => planItem(root, item, index, problems));
	if (problems.length) return { problems, staged: [] };
	const staged = planned as StagedWorkspaceSourceUpload[];
	const created: string[] = [];
	try {
		mkdirSync(root, { recursive: true });
		for (const upload of staged) {
			mkdirSync(upload.directory);
			created.push(upload.directory);
			mkdirSync(join(upload.directory, STAGING_DIR));
			if (upload.kind !== "folder") continue;
			mkdirSync(join(upload.directory, upload.storedName));
			for (const entry of upload.entries) mkdirSync(dirname(entry.target), { recursive: true });
			writeFileSync(
				join(upload.directory, "source.json"),
				JSON.stringify({ version: 2, kind: "folder", name: upload.name, storedName: upload.storedName }),
				{ flag: "wx" },
			);
		}
	} catch (error) {
		// Only this batch's own fresh directories are removed, so no half-made source is left behind.
		for (const directory of created) {
			try {
				removeTree(directory);
			} catch {
				/* left as is: removeTree never deletes through a link */
			}
		}
		throw error;
	}
	return { problems: [], staged };
}

function assertRealDirectory(directory: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(directory);
	} catch {
		throw new Error("This source no longer exists.");
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Indirect source directories are not supported.");
}

/** Write one chunk of one staged file; a completed file moves into place at once. */
export function writeWorkspaceSourceChunk(
	upload: StagedWorkspaceSourceUpload,
	index: number,
	offset: number,
	data: string,
): { done: boolean } {
	const entry = upload.entries[index];
	if (!entry) throw new Error("Unknown file in this upload.");
	if (entry.done) return { done: true };
	const bytes = decodeUploadChunk(data);
	assertRealDirectory(upload.directory);
	assertRealDirectory(join(upload.directory, STAGING_DIR));
	const part = join(upload.directory, STAGING_DIR, `${index}.part`);
	if (writeUploadChunk(part, offset, bytes, entry.size) < entry.size) return { done: false };
	assertRealDirectory(dirname(entry.target));
	renameSync(part, entry.target);
	entry.done = true;
	return { done: true };
}

/** Complete a staged source once every file is in place: a single file gets its (version 1) manifest now. */
export function finishWorkspaceSourceUpload(upload: StagedWorkspaceSourceUpload): WorkspaceSource {
	if (upload.entries.some((entry) => !entry.done)) throw new Error("Some files have not been uploaded yet.");
	assertRealDirectory(upload.directory);
	if (upload.kind === "file")
		writeFileSync(
			join(upload.directory, "source.json"),
			JSON.stringify({
				version: 1,
				name: upload.name,
				size: upload.entries[0]!.size,
				storedName: upload.storedName,
			}),
			{ flag: "wx" },
		);
	try {
		rmdirSync(join(upload.directory, STAGING_DIR));
	} catch {
		/* not empty or already gone: deleting the source removes it */
	}
	const source = readSource(dirname(upload.directory), upload.id);
	if (!source) throw new Error("The uploaded source could not be read back.");
	return source;
}

/** One-request upload of a small file (kept for existing callers; the sources page uploads in chunks). */
export function uploadWorkspaceSource(
	dataRoot: string,
	workspaceId: string,
	name: string,
	data: string,
): WorkspaceSource {
	if (data.length > Math.ceil((32 * 1024 * 1024) / 3) * 4) throw new Error("Files must be 32 MiB or smaller.");
	if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid base64 file data.");
	const root = sourceRoot(dataRoot, workspaceId);
	mkdirSync(root, { recursive: true });
	const id = randomUUID();
	const directory = join(root, id);
	mkdirSync(directory);
	const storedName = `source-${
		name
			.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
			.replace(/[. ]+$/g, "")
			.slice(0, 180) || "file"
	}`;
	const path = join(directory, storedName);
	const bytes = Buffer.from(data, "base64");
	writeFileSync(path, bytes, { flag: "wx" });
	const source: WorkspaceSource = {
		id,
		name: name.slice(0, 255),
		path,
		size: bytes.length,
		modified: lstatSync(path).mtimeMs,
		kind: "file",
	};
	writeFileSync(
		join(directory, "source.json"),
		JSON.stringify({ version: 1, name: source.name, size: source.size, storedName }),
		{ flag: "wx" },
	);
	return source;
}

/**
 * Remove a directory tree that may hold only real files and directories. Everything is checked before anything is
 * deleted: a link, junction or other entry anywhere inside refuses the whole removal and leaves the tree as it is.
 */
function removeTree(directory: string): void {
	const files: string[] = [];
	const directories: string[] = [];
	const visit = (current: string) => {
		directories.push(current);
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new WorkspaceSourceError("refused", UNEXPECTED_ENTRIES);
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) files.push(path);
			else throw new WorkspaceSourceError("refused", UNEXPECTED_ENTRIES);
		}
	};
	try {
		visit(directory);
	} catch (error) {
		if (error instanceof WorkspaceSourceError) throw error;
		throw new WorkspaceSourceError("refused", UNEXPECTED_ENTRIES);
	}
	try {
		for (const file of files) unlinkSync(file);
		for (const current of directories.reverse()) rmdirSync(current);
	} catch (error) {
		throw new WorkspaceSourceError(
			"refused",
			`Could not delete the source: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Delete one source (only its own `<uploads>/<id>/` directory), or with `innerPath` one file or sub-folder inside a
 * folder source. The same indirect-root checks as listing and upload apply first; the source directory and every
 * path component down to the target must be real, and a removed tree may hold only real files and directories, so
 * nothing is ever removed through a link and the uploads root and workspace directory stay untouched.
 */
export function deleteWorkspaceSource(
	dataRoot: string,
	workspaceId: string,
	sourceId: string,
	innerPath?: string,
): void {
	if (!SOURCE_ID.test(sourceId)) throw new WorkspaceSourceError("invalid", "Invalid source id.");
	const root = sourceRoot(dataRoot, workspaceId);
	const directory = join(root, sourceId);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(directory);
	} catch {
		throw new WorkspaceSourceError("not_found", "This source no longer exists.");
	}
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new WorkspaceSourceError("refused", "Indirect source directories are not supported.");
	if (innerPath === undefined) {
		removeTree(directory);
		return;
	}
	const segments = innerPath.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\:]/.test(segment)))
		throw new WorkspaceSourceError("invalid", "Invalid path inside the source.");
	let manifest: SourceManifest | undefined;
	try {
		manifest = readManifest(directory);
	} catch {
		manifest = undefined;
	}
	if (manifest?.kind !== "folder") throw new WorkspaceSourceError("invalid", "Only folder sources hold entries.");
	let current = join(directory, manifest.storedName);
	for (const segment of ["", ...segments]) {
		if (segment) current = join(current, segment);
		try {
			stat = lstatSync(current);
		} catch {
			throw new WorkspaceSourceError("not_found", "This entry no longer exists.");
		}
		if (stat.isSymbolicLink())
			throw new WorkspaceSourceError("refused", "Indirect source directories are not supported.");
	}
	if (stat.isDirectory()) {
		removeTree(current);
		return;
	}
	if (!stat.isFile()) throw new WorkspaceSourceError("refused", UNEXPECTED_ENTRIES);
	try {
		unlinkSync(current);
	} catch (error) {
		throw new WorkspaceSourceError(
			"refused",
			`Could not delete the entry: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
