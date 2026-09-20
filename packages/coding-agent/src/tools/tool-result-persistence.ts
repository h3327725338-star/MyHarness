import { randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@myharness/agent-core";
import type { SessionManager } from "../session/manager/index.ts";
import { replaceFileAtomically, writeFileAtomically } from "../utils/atomic-write.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.ts";

export const FULL_TEXT_OUTPUT = Symbol("myharness.fullTextOutput");

type TextToolResult = AgentToolResult<any> & {
	[FULL_TEXT_OUTPUT]?: string;
};

function safeSegment(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized || "tool";
}

function getTextContent(result: AgentToolResult<any>): string {
	return result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function replaceTextContent(result: AgentToolResult<any>, text: string): AgentToolResult<any> {
	const firstTextIndex = result.content.findIndex((part) => part.type === "text");
	const images = result.content.filter((part) => part.type !== "text");
	if (firstTextIndex < 0) return result;

	const content: typeof result.content = [...images];
	content.splice(Math.min(firstTextIndex, content.length), 0, { type: "text", text });
	return { ...result, content };
}

function getToolResultsDir(sessionManager: SessionManager): string {
	const root = sessionManager.isPersisted()
		? sessionManager.getSessionDir()
		: join(tmpdir(), "myharness-tool-results");
	return join(root, "tool-results", safeSegment(sessionManager.getSessionId()));
}

const ORPHAN_MANIFEST_NAME = ".myharness-sidecar-orphans.json";
const ORPHAN_QUARANTINE_DIR = ".orphaned";
const ORPHAN_MANIFEST_VERSION = 1;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

interface SidecarOrphanRecord {
	relativePath: string;
	firstSeenAt: string;
	lastSeenAt: string;
	size: number;
	mtimeMs: number;
	status: "pending" | "quarantined";
	quarantinePath?: string;
}

interface SidecarOrphanManifest {
	version: typeof ORPHAN_MANIFEST_VERSION;
	entries: SidecarOrphanRecord[];
}

export interface ToolResultCleanupOptions {
	/** Keep an unreferenced sidecar pending for at least this long. */
	graceMs?: number;
	/** Injectable clock for recovery tests. */
	nowMs?: number;
	/** Move proven orphans to a recoverable quarantine directory. */
	reclaim?: boolean;
}

export interface ToolResultCleanupResult {
	referenced: string[];
	pending: string[];
	orphaned: string[];
	quarantined: string[];
	errors: string[];
}

function pathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath !== "" && !isAbsolute(relativePath) && !relativePath.startsWith(`..${sep}`) && relativePath !== ".."
	);
}

async function collectFiles(
	root: string,
	predicate: (name: string) => boolean,
	files: string[],
	skipDirectory?: (name: string) => boolean,
): Promise<boolean> {
	let rootStats: Stats;
	try {
		rootStats = await lstat(root);
	} catch {
		return false;
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return false;

	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const childPath = join(root, entry.name);
		let childStats: Stats;
		try {
			childStats = await lstat(childPath);
		} catch {
			return false;
		}
		if (childStats.isSymbolicLink()) return false;
		if (childStats.isDirectory()) {
			if (skipDirectory?.(entry.name)) continue;
			if (!(await collectFiles(childPath, predicate, files, skipDirectory))) return false;
			continue;
		}
		if (childStats.isFile() && predicate(entry.name)) files.push(childPath);
	}
	return true;
}

async function collectSessionJsonlFiles(sessionDir: string): Promise<string[] | undefined> {
	const files: string[] = [];
	const ok = await collectFiles(sessionDir, (name) => name.toLowerCase().endsWith(".jsonl"), files);
	return ok ? files : undefined;
}

async function collectSidecarFiles(toolResultsRoot: string): Promise<string[] | undefined> {
	const files: string[] = [];
	try {
		const stats = await lstat(toolResultsRoot);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
		return undefined;
	}
	const ok = await collectFiles(
		toolResultsRoot,
		(name) => name.toLowerCase().endsWith(".txt") && name !== ORPHAN_MANIFEST_NAME,
		files,
		(name) => name === ORPHAN_QUARANTINE_DIR,
	);
	return ok ? files : undefined;
}

function collectSidecarReferences(value: unknown, paths: Set<string>, byBasename: Map<string, string[]>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectSidecarReferences(item, paths, byBasename);
		return;
	}
	if (typeof value === "string") {
		const normalized = pathKey(value);
		for (const sidecarPath of byBasename.get(basename(value).toLowerCase()) ?? []) paths.add(sidecarPath);
		for (const [name, sidecarPaths] of byBasename) {
			if (value.toLowerCase().includes(name)) {
				for (const sidecarPath of sidecarPaths) paths.add(sidecarPath);
			}
		}
		paths.add(normalized);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, child] of Object.entries(value)) {
		if (key === "fullOutputPath" && typeof child === "string") paths.add(pathKey(child));
		else collectSidecarReferences(child, paths, byBasename);
	}
}

async function collectReferencedSidecars(sessionDir: string, sidecarPaths: string[]): Promise<Set<string> | undefined> {
	const references = new Set<string>();
	const byBasename = new Map<string, string[]>();
	for (const sidecarPath of sidecarPaths) {
		const name = basename(sidecarPath).toLowerCase();
		const paths = byBasename.get(name) ?? [];
		paths.push(pathKey(sidecarPath));
		byBasename.set(name, paths);
	}
	const files = await collectSessionJsonlFiles(sessionDir);
	if (!files) return undefined;
	for (const filePath of files) {
		let content: string;
		try {
			content = await readFile(filePath, "utf8");
		} catch {
			return undefined;
		}
		for (const line of content.split(/\r?\n/u)) {
			if (!line.trim()) continue;
			try {
				collectSidecarReferences(JSON.parse(line) as unknown, references, byBasename);
			} catch {
				// A malformed/truncated line means the reference scan is incomplete.
				// Keep every sidecar until the Session can be parsed safely.
				return undefined;
			}
		}
	}
	return references;
}

async function hasSessionWriterLock(sessionDir: string): Promise<boolean> {
	let found = false;
	let uncertain = false;
	const visit = async (directory: string): Promise<boolean> => {
		let stats: Stats;
		try {
			stats = await lstat(directory);
		} catch {
			uncertain = true;
			return true;
		}
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			uncertain = true;
			return true;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			uncertain = true;
			return true;
		}
		for (const entry of entries) {
			const childPath = join(directory, entry.name);
			let childStats: Stats;
			try {
				childStats = await lstat(childPath);
			} catch {
				uncertain = true;
				return true;
			}
			if (childStats.isSymbolicLink()) {
				uncertain = true;
				return true;
			}
			if (entry.name.toLowerCase().endsWith(".lock")) {
				found = true;
				return true;
			}
			if (childStats.isDirectory() && !(await visit(childPath))) return false;
		}
		return true;
	};
	await visit(sessionDir);
	return found || uncertain;
}

async function readOrphanManifest(manifestPath: string): Promise<SidecarOrphanManifest | undefined> {
	try {
		const stats = await lstat(manifestPath);
		if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
		const value = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<SidecarOrphanManifest>;
		if (value.version !== ORPHAN_MANIFEST_VERSION || !Array.isArray(value.entries)) return undefined;
		return {
			version: ORPHAN_MANIFEST_VERSION,
			entries: value.entries.filter(
				(entry): entry is SidecarOrphanRecord =>
					typeof entry === "object" &&
					entry !== null &&
					typeof entry.relativePath === "string" &&
					typeof entry.firstSeenAt === "string" &&
					typeof entry.lastSeenAt === "string" &&
					typeof entry.size === "number" &&
					typeof entry.mtimeMs === "number" &&
					(entry.status === "pending" || entry.status === "quarantined"),
			),
		};
	} catch {
		return undefined;
	}
}

async function writeOrphanManifest(manifestPath: string, manifest: SidecarOrphanManifest): Promise<void> {
	await writeFileAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function recordPendingSidecar(sessionDir: string, sidecarPath: string): Promise<void> {
	const toolResultsRoot = join(sessionDir, "tool-results");
	const relativePath = relative(sessionDir, sidecarPath);
	if (!isPathInside(sessionDir, sidecarPath) || !relativePath) return;
	const manifestPath = join(toolResultsRoot, ORPHAN_MANIFEST_NAME);
	try {
		const toolResultsStats = await lstat(toolResultsRoot);
		if (toolResultsStats.isSymbolicLink() || !toolResultsStats.isDirectory()) return;
	} catch {
		return;
	}
	const existing = await readOrphanManifest(manifestPath);
	try {
		const manifestStats = await lstat(manifestPath);
		if (manifestStats.isSymbolicLink() || !manifestStats.isFile() || !existing) return;
	} catch {
		// The manifest is optional on the first sidecar write.
	}
	const manifest = existing ?? { version: ORPHAN_MANIFEST_VERSION, entries: [] };
	const now = new Date().toISOString();
	const stats = await lstat(sidecarPath);
	const entry = manifest.entries.find(
		(candidate) => pathKey(join(sessionDir, candidate.relativePath)) === pathKey(sidecarPath),
	);
	if (entry) {
		entry.lastSeenAt = now;
		entry.size = stats.size;
		entry.mtimeMs = stats.mtimeMs;
		entry.status = "pending";
		delete entry.quarantinePath;
	} else {
		manifest.entries.push({
			relativePath,
			firstSeenAt: now,
			lastSeenAt: now,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			status: "pending",
		});
	}
	await writeOrphanManifest(manifestPath, manifest);
}

/**
 * Classify unreferenced Session tool-result sidecars and, after a grace
 * period, move them to a recoverable quarantine. No sidecar is deleted.
 */
export async function cleanupOrphanedToolResults(
	sessionDir: string,
	options: ToolResultCleanupOptions = {},
): Promise<ToolResultCleanupResult> {
	const result: ToolResultCleanupResult = {
		referenced: [],
		pending: [],
		orphaned: [],
		quarantined: [],
		errors: [],
	};
	const resolvedSessionDir = resolve(sessionDir);
	const toolResultsRoot = join(resolvedSessionDir, "tool-results");
	const manifestPath = join(toolResultsRoot, ORPHAN_MANIFEST_NAME);
	const manifest = await readOrphanManifest(manifestPath);
	try {
		const manifestStats = await lstat(manifestPath);
		if (!manifest || manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
			result.errors.push(`Invalid sidecar orphan manifest: ${manifestPath}`);
			return result;
		}
	} catch {
		// A missing manifest is the normal first-run case.
	}
	const nextManifest = manifest ?? { version: ORPHAN_MANIFEST_VERSION, entries: [] };
	const records = new Map(nextManifest.entries.map((entry) => [entry.relativePath, entry]));
	const sidecars = await collectSidecarFiles(toolResultsRoot);
	const referenced = sidecars ? await collectReferencedSidecars(resolvedSessionDir, sidecars) : undefined;
	if (!referenced || !sidecars) {
		result.errors.push(`Unable to safely scan Session sidecars: ${resolvedSessionDir}`);
		return result;
	}
	const active = await hasSessionWriterLock(resolvedSessionDir);
	const nowMs = options.nowMs ?? Date.now();
	const graceMs = Math.max(0, options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS);
	const reclaim = options.reclaim ?? true;

	for (const sidecarPath of sidecars) {
		const relativePath = relative(resolvedSessionDir, sidecarPath);
		if (!relativePath) continue;
		if (referenced.has(pathKey(sidecarPath))) {
			result.referenced.push(sidecarPath);
			records.delete(relativePath);
			continue;
		}

		let stats: Stats;
		try {
			stats = await lstat(sidecarPath);
		} catch {
			continue;
		}
		let record = records.get(relativePath);
		if (!record) {
			const now = new Date(nowMs).toISOString();
			record = {
				relativePath,
				firstSeenAt: now,
				lastSeenAt: now,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
				status: "pending",
			};
			records.set(relativePath, record);
		}
		const ageMs = nowMs - Date.parse(record.firstSeenAt);
		if (active || !Number.isFinite(ageMs) || ageMs < graceMs) {
			record.lastSeenAt = new Date(nowMs).toISOString();
			record.size = stats.size;
			record.mtimeMs = stats.mtimeMs;
			record.status = "pending";
			result.pending.push(sidecarPath);
			continue;
		}

		result.orphaned.push(sidecarPath);
		if (!reclaim) continue;
		const quarantineRoot = join(toolResultsRoot, ORPHAN_QUARANTINE_DIR);
		try {
			try {
				const quarantineStats = await lstat(quarantineRoot);
				if (quarantineStats.isSymbolicLink() || !quarantineStats.isDirectory())
					throw new Error("invalid quarantine directory");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await mkdir(quarantineRoot, { recursive: true });
			}
			const quarantinePath = join(quarantineRoot, `${basename(sidecarPath)}.${randomBytes(8).toString("hex")}`);
			await rename(sidecarPath, quarantinePath);
			record.status = "quarantined";
			record.quarantinePath = relative(resolvedSessionDir, quarantinePath);
			result.quarantined.push(quarantinePath);
		} catch (error) {
			result.errors.push(`${sidecarPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	nextManifest.entries = [...records.values()];
	try {
		if (nextManifest.entries.length === 0) await rm(manifestPath, { force: true });
		else await writeOrphanManifest(manifestPath, nextManifest);
	} catch (error) {
		result.errors.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return result;
}

async function persistText(
	sessionManager: SessionManager,
	toolName: string,
	toolCallId: string,
	text: string,
	existingPath?: string,
	allowExistingCopyFallback = false,
): Promise<string> {
	const directory = getToolResultsDir(sessionManager);
	await mkdir(directory, { recursive: true });
	const target = join(directory, `${safeSegment(toolCallId)}-${safeSegment(toolName)}.txt`);
	const temporaryPath = join(directory, `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		if (existingPath) {
			try {
				await copyFile(existingPath, temporaryPath);
			} catch (error) {
				if (!allowExistingCopyFallback) throw error;
				await writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
			}
		} else {
			await writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
		}
		await replaceFileAtomically(temporaryPath, target);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}

	if (existingPath && isOwnedTemporaryOutput(existingPath)) {
		await rm(existingPath, { force: true }).catch(() => {});
	}
	if (sessionManager.isPersisted()) {
		await recordPendingSidecar(sessionManager.getSessionDir(), target).catch(() => {
			// The sidecar remains usable even if its best-effort recovery marker
			// cannot be written.
		});
	}
	return target;
}

function isOwnedTemporaryOutput(path: string): boolean {
	const tempRoot = resolve(tmpdir());
	const resolvedPath = resolve(path);
	return (
		resolvedPath.startsWith(`${tempRoot}${process.platform === "win32" ? "\\" : "/"}`) &&
		/^myharness-(?:bash|pwsh|output)-/.test(basename(resolvedPath))
	);
}

/** Remove an intermediate executor output only when it is a MyHarness-owned temp file. */
export async function discardTemporaryToolOutput(path: string | undefined): Promise<void> {
	if (!path || !isOwnedTemporaryOutput(path)) return;
	await rm(path, { force: true }).catch(() => {});
}

export async function persistToolText(
	sessionManager: SessionManager,
	toolName: string,
	toolCallId: string,
	text: string,
	existingPath?: string,
): Promise<string> {
	return persistText(sessionManager, toolName, toolCallId, text, existingPath);
}

function withReference(text: string, fullOutputPath: string): string {
	return `${text}\n\n[完整输出已保存：${fullOutputPath}]`;
}

/**
 * Persist large textual tool results before they enter model context.
 *
 * Built-ins that must truncate internally can attach their original text with
 * FULL_TEXT_OUTPUT. Extension tools are measured and truncated here. Image
 * blocks are preserved unchanged.
 */
export function wrapToolWithResultPersistence(tool: AgentTool<any>, sessionManager: SessionManager): AgentTool<any> {
	const execute = tool.execute;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const rawResult = (await execute(toolCallId, params, signal, onUpdate)) as TextToolResult;
			if (!Array.isArray(rawResult.content)) {
				rawResult.content = [];
			}
			const suppliedFullText = rawResult[FULL_TEXT_OUTPUT];
			delete rawResult[FULL_TEXT_OUTPUT];

			const visibleText = getTextContent(rawResult);
			const truncation = truncateHead(suppliedFullText ?? visibleText);
			const existingPath =
				rawResult.details &&
				typeof rawResult.details === "object" &&
				typeof (rawResult.details as { fullOutputPath?: unknown }).fullOutputPath === "string"
					? (rawResult.details as { fullOutputPath: string }).fullOutputPath
					: undefined;

			if (!suppliedFullText && !truncation.truncated && !existingPath) {
				return rawResult;
			}

			const fullText = suppliedFullText ?? visibleText;
			let fullOutputPath: string;
			try {
				fullOutputPath = await persistText(
					sessionManager,
					tool.name,
					toolCallId,
					fullText,
					existingPath,
					Boolean(suppliedFullText),
				);
			} catch (error) {
				// Never publish a durable-looking reference when copying the executor's
				// full output failed. The model keeps the bounded preview and receives a
				// clear diagnostic instead of a path to a partial file.
				const preview = suppliedFullText
					? visibleText
					: truncation.content ||
						`[文本输出超过 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB，完整结果保存失败]`;
				const reason = error instanceof Error ? error.message : String(error);
				return replaceTextContent(rawResult, `${preview}\n\n[完整输出保存失败：${reason}]`);
			}

			const preview = suppliedFullText
				? visibleText
				: truncation.content ||
					`[文本输出超过 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB，已保存完整结果]`;
			const referencedPreview =
				existingPath && preview.includes(existingPath)
					? preview.split(existingPath).join(fullOutputPath)
					: withReference(preview, fullOutputPath);
			const result = replaceTextContent(rawResult, referencedPreview);
			return {
				...result,
				details: {
					...(result.details && typeof result.details === "object" ? result.details : {}),
					fullOutputPath,
				},
			};
		},
	};
}
