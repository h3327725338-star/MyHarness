import { createHash } from "node:crypto";
import { createReadStream, type Dirent, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { WorkspaceFileEntry } from "./types.ts";

/**
 * Directory names that never take part in workspace file sync. The list is deliberately short and shown to the user
 * before the first upload: a hidden folder is not excluded just because it is hidden, and an `archive/` folder full of
 * study material is ordinary content.
 */
export const EXCLUDED_DIRECTORY_NAMES = new Set([
	".git",
	".svn",
	".hg",
	"node_modules",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".venv",
	"venv",
	".cache",
	".gradle",
	".myharness",
]);

/** Temporary downloads and Office lock files. A `yarn.lock` or `Cargo.lock` is real content and stays. */
const EXCLUDED_FILE_PATTERNS = [
	/\.(?:tmp|part|crdownload)$/iu,
	/\.myharness[-.]/iu,
	/^~\$/u,
	/^\.ds_store$/iu,
	/^thumbs\.db$/iu,
	/^desktop\.ini$/iu,
	/\.bridge$/iu,
];

/** Reported before the first upload; detection is a hint, never a promise that every secret was found. */
const SECRET_FILE_PATTERNS = [
	/^\.env(?:\.|$)/iu,
	/^id_(?:rsa|dsa|ecdsa|ed25519)$/iu,
	/\.(?:pem|pfx|p12|key)$/iu,
	/^credentials\.json$/iu,
	/^client_secret.*\.json$/iu,
	/^\.npmrc$/iu,
	/^\.pypirc$/iu,
	/^\.git-credentials$/iu,
];

export interface WorkspaceScanResult {
	/** Every entry keyed by its exact POSIX relative path. Directories are entries too, so empty folders survive. */
	entries: Map<string, WorkspaceFileEntry>;
	/** Modification time per file, used to reuse a cached hash when nothing changed. */
	mtimes: Map<string, number>;
	/** Lower-case path -> exact path, used to detect two names that only differ by case. */
	caseKeys: Map<string, string>;
	/** Directories whose listing or reading failed. No deletion is derived below one of them. */
	incomplete: string[];
	/** True when the root itself could not be read; every tracked entry must be kept untouched. */
	rootMissing: boolean;
	symlinks: string[];
	special: string[];
	secrets: string[];
	unstable: string[];
	files: number;
	directories: number;
	bytes: number;
}

export interface WorkspaceScanOptions {
	root: string;
	/** Absolute directories that must never be descended into (the Data root and the agent directory). */
	excludedRoots?: string[];
	/** Hash cache keyed by relative path; an unchanged size and mtime reuses the hash instead of re-reading the file. */
	cache?: Record<string, { size: number; mtimeMs: number; hash: string }>;
	/** Test hook: read a file hash with a small delay so a scan can be interrupted deterministically. */
	hashFile?: (path: string) => Promise<{ hash: string; size: number } | "unstable" | undefined>;
}

function toPosix(value: string): string {
	return value.split(sep).join("/");
}

function isExcludedFile(name: string): boolean {
	return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function isSecret(name: string): boolean {
	return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function isInside(parent: string, child: string): boolean {
	const base = parent.endsWith(sep) ? parent : `${parent}${sep}`;
	return child === parent || child.startsWith(base);
}

/** SHA-256 over the file stream; the file is never loaded into memory as one buffer. */
export async function hashFileStream(path: string): Promise<{ hash: string; size: number }> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		const buffer = chunk as Buffer;
		hash.update(buffer);
		size += buffer.byteLength;
	}
	return { hash: hash.digest("hex"), size };
}

async function stableHash(path: string): Promise<{ hash: string; size: number } | "unstable"> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let before: ReturnType<typeof statSync>;
		try {
			before = statSync(path);
		} catch {
			return "unstable";
		}
		const result = await hashFileStream(path);
		let after: ReturnType<typeof statSync>;
		try {
			after = statSync(path);
		} catch {
			return "unstable";
		}
		if (before.mtimeMs === after.mtimeMs && before.size === after.size && result.size === after.size) return result;
	}
	return "unstable";
}

function listDirectory(path: string): Dirent[] | undefined {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return undefined;
	}
}

/**
 * Walk a workspace root without following links and without ever trusting a single `readdir` result for deletions.
 * A directory that cannot be listed is reported as incomplete; the caller must then keep every entry below it.
 */
export async function scanWorkspaceFiles(options: WorkspaceScanOptions): Promise<WorkspaceScanResult> {
	const result: WorkspaceScanResult = {
		entries: new Map(),
		mtimes: new Map(),
		caseKeys: new Map(),
		incomplete: [],
		rootMissing: false,
		symlinks: [],
		special: [],
		secrets: [],
		unstable: [],
		files: 0,
		directories: 0,
		bytes: 0,
	};
	const excludedRoots = (options.excludedRoots ?? []).filter(Boolean);
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(options.root);
	} catch {
		result.rootMissing = true;
		return result;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		result.rootMissing = true;
		return result;
	}
	const hash = options.hashFile ?? stableHash;

	const add = (entry: WorkspaceFileEntry): void => {
		result.entries.set(entry.path, entry);
		const folded = entry.path.toLowerCase();
		const existing = result.caseKeys.get(folded);
		if (!existing) result.caseKeys.set(folded, entry.path);
	};

	const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
		if (excludedRoots.some((excluded) => isInside(excluded, directory))) return;
		const entries = listDirectory(directory);
		if (!entries) {
			result.incomplete.push(relativeDirectory || ".");
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const item of entries) {
			const full = join(directory, item.name);
			const child = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name;
			if (item.isSymbolicLink()) {
				result.symlinks.push(child);
				continue;
			}
			if (excludedRoots.some((excluded) => isInside(excluded, full))) continue;
			if (item.isDirectory()) {
				if (EXCLUDED_DIRECTORY_NAMES.has(item.name)) continue;
				add({ path: child, type: "dir" });
				result.directories += 1;
				await walk(full, child);
				continue;
			}
			if (!item.isFile()) {
				result.special.push(child);
				continue;
			}
			if (isExcludedFile(item.name)) continue;
			if (isSecret(item.name)) result.secrets.push(child);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(full);
			} catch {
				result.incomplete.push(relativeDirectory || ".");
				continue;
			}
			const cached = options.cache?.[child];
			const value =
				cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
					? { hash: cached.hash, size: cached.size }
					: await hash(full);
			if (value === "unstable" || !value) {
				result.unstable.push(child);
				continue;
			}
			add({ path: child, type: "file", hash: value.hash, size: value.size });
			result.mtimes.set(child, stat.mtimeMs);
			result.files += 1;
			result.bytes += value.size;
		}
	};

	await walk(options.root, "");
	return result;
}

/** A path the scanner never manages, refused again when a remote manifest tries to write it. */
export function isExcludedWorkspacePath(path: string): boolean {
	const segments = path.split("/");
	if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true;
	return isExcludedFile(segments.at(-1) ?? "");
}

/** True when a relative path lives inside one of the incomplete directories of a scan. */
export function isUnderIncomplete(path: string, incomplete: readonly string[]): boolean {
	return incomplete.some((directory) => directory === "." || path === directory || path.startsWith(`${directory}/`));
}

/** Whether the root exists and is a readable directory; a missing root never means every file was deleted. */
export function workspaceRootAvailable(root: string): boolean {
	try {
		const stat = lstatSync(root);
		return stat.isDirectory() && !stat.isSymbolicLink() && existsSync(root);
	} catch {
		return false;
	}
}

export function toWorkspaceRelative(root: string, absolute: string): string {
	return toPosix(relative(root, absolute));
}
