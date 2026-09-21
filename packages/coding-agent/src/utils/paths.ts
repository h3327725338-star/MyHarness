import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const MAX_CANONICAL_PATH_CACHE_ENTRIES = 4096;
const canonicalPathCache = new Map<string, { exists: boolean; value: string }>();

function readCachedCanonicalPath(path: string): string | undefined {
	const cached = canonicalPathCache.get(path);
	if (!cached) return undefined;
	if (cached.exists !== existsSync(path)) {
		canonicalPathCache.delete(path);
		return undefined;
	}
	return cached.value;
}

function cacheCanonicalPath(path: string, value: string, exists: boolean): void {
	if (canonicalPathCache.size >= MAX_CANONICAL_PATH_CACHE_ENTRIES) {
		const oldest = canonicalPathCache.keys().next().value;
		if (oldest !== undefined) canonicalPathCache.delete(oldest);
	}
	canonicalPathCache.set(path, { exists, value });
}

export interface PathInputOptions {
	/** Trim leading/trailing whitespace before normalization. */
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	normalizeUnicodeSpaces?: boolean;
}

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Resolve a path for identity comparisons. Existing paths use the filesystem's
 * canonical spelling (including Windows junction/symlink and short-name
 * resolution); paths that do not exist still get stable lexical resolution.
 */
export function resolveCanonicalPath(input: string, baseDir: string = process.cwd()): string {
	const resolved = resolvePath(input, baseDir);
	const cached = readCachedCanonicalPath(resolved);
	if (cached !== undefined) return cached;
	const missingSegments: string[] = [];
	let current = resolved;
	while (true) {
		const cachedBase = readCachedCanonicalPath(current);
		if (cachedBase !== undefined) {
			const value = missingSegments.length === 0 ? cachedBase : join(cachedBase, ...missingSegments.reverse());
			cacheCanonicalPath(resolved, value, false);
			return value;
		}
		try {
			const canonicalBase = realpathSync.native(current);
			cacheCanonicalPath(current, canonicalBase, true);
			const value = missingSegments.length === 0 ? canonicalBase : join(canonicalBase, ...missingSegments.reverse());
			cacheCanonicalPath(resolved, value, missingSegments.length === 0);
			return value;
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				cacheCanonicalPath(resolved, resolved, false);
				return resolved;
			}
			const segment = basename(current);
			if (!segment) {
				cacheCanonicalPath(resolved, resolved, false);
				return resolved;
			}
			missingSegments.push(segment);
			current = parent;
		}
	}
}

/** Return the stable key used when comparing filesystem identities. */
export function pathIdentityKey(input: string, baseDir: string = process.cwd()): string {
	const resolved = resolveCanonicalPath(input, baseDir);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve Git's repository-root output while preserving the path spelling used
 * by the caller. Windows runners can expose the same directory through an
 * 8.3 short path (for example, `RUNNER~1`) while Git returns the long user
 * directory name. Keeping one spelling is important because Node's lexical
 * `path.relative` does not resolve short/long-name aliases.
 */
export function resolveGitRepositoryRoot(cwd: string, reportedRoot: string): string {
	const resolvedCwd = nodeResolvePath(cwd);
	const resolvedRoot = nodeResolvePath(reportedRoot);
	if (process.platform !== "win32") return resolvedRoot;
	const lexicalRootToCwd = relative(resolvedRoot, resolvedCwd);
	const lexicalCwdIsInsideRoot =
		lexicalRootToCwd === "" ||
		(lexicalRootToCwd !== ".." && !lexicalRootToCwd.startsWith(`..${sep}`) && !isAbsolute(lexicalRootToCwd));
	if (lexicalCwdIsInsideRoot) {
		const lexicalCwdToRoot = relative(resolvedCwd, resolvedRoot);
		if (!isAbsolute(lexicalCwdToRoot)) return nodeResolvePath(resolvedCwd, lexicalCwdToRoot);
	}

	try {
		const physicalCwd = realpathSync.native(resolvedCwd);
		const physicalRoot = realpathSync.native(resolvedRoot);
		const rootToCwd = relative(physicalRoot, physicalCwd);
		const cwdToRoot = relative(physicalCwd, physicalRoot);
		const cwdIsInsideRoot =
			rootToCwd === "" || (rootToCwd !== ".." && !rootToCwd.startsWith(`..${sep}`) && !isAbsolute(rootToCwd));
		if (cwdIsInsideRoot && !isAbsolute(cwdToRoot)) {
			// Resolve from the caller's cwd so short/long spelling is consistent
			// for all later path.relative calls.
			return nodeResolvePath(resolvedCwd, cwdToRoot);
		}
	} catch {
		// Fall back to Git's absolute path when either side is unavailable.
	}

	return resolvedRoot;
}

/**
 * Returns true if the value is NOT a package source (npm:, git:, etc.)
 * or a remote URL protocol. Bare names, relative paths, and file: URLs
 * are considered local.
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// Known non-local prefixes. file: URLs are local paths and are intentionally resolved by resolvePath().
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	) {
		return false;
	}
	return true;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const lexicalRelativePath = relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		lexicalRelativePath === "" ||
		(lexicalRelativePath !== ".." && !lexicalRelativePath.startsWith(`..${sep}`) && !isAbsolute(lexicalRelativePath));

	if (isInsideCwd) return lexicalRelativePath || ".";

	const canonicalCwd = resolveCanonicalPath(resolvedCwd);
	const canonicalPath = resolveCanonicalPath(filePath, canonicalCwd);
	const canonicalRelativePath = relative(canonicalCwd, canonicalPath);
	const isCanonicalPathInsideCwd =
		canonicalRelativePath === "" ||
		(canonicalRelativePath !== ".." &&
			!canonicalRelativePath.startsWith(`..${sep}`) &&
			!isAbsolute(canonicalRelativePath));

	return isCanonicalPathInsideCwd ? canonicalRelativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

export function markPathIgnoredByCloudSync(path: string): void {
	const attrs =
		process.platform === "darwin"
			? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: process.platform === "linux"
				? ["user.com.dropbox.ignored"]
				: [];

	for (const attr of attrs) {
		if (process.platform === "darwin") {
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
