import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { nowIso, sha256 } from "../util.ts";
import { isExcludedWorkspacePath, isUnderIncomplete } from "./scan.ts";
import type {
	WorkspaceFileConflict,
	WorkspaceFileEntry,
	WorkspaceFileManifest,
	WorkspaceFileOperation,
	WorkspaceFileState,
} from "./types.ts";
import { MAX_CONFLICTS } from "./types.ts";

/** Characters Windows refuses in a file name, plus the names it reserves for devices. */
const RESERVED_SEGMENTS = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	"com1",
	"com2",
	"com3",
	"com4",
	"com5",
	"com6",
	"com7",
	"com8",
	"com9",
	"lpt1",
	"lpt2",
	"lpt3",
	"lpt4",
	"lpt5",
	"lpt6",
	"lpt7",
	"lpt8",
	"lpt9",
]);

/**
 * A remote path may only be a plain relative path inside the workspace. Absolute paths, drive letters, `..`,
 * control characters and Windows device names are refused instead of being normalised into something that writes
 * outside the bound folder.
 */
export function isSafeWorkspacePath(path: string): boolean {
	if (!path || path.length > 1024) return false;
	if (path.startsWith("/") || path.startsWith("\\")) return false;
	if (path.includes("\\")) return false;
	if (/^[A-Za-z]:/u.test(path)) return false;
	if (/[\u0000-\u001f<>:"|?*]/u.test(path)) return false;
	if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	for (const segment of path.split("/")) {
		// Windows silently strips a trailing dot or space, so two different keys would address one file.
		if (segment !== segment.replace(/[. ]+$/u, "")) return false;
		const trimmed = segment.replace(/[. ]+$/u, "");
		if (!trimmed) return false;
		if (RESERVED_SEGMENTS.has(trimmed.toLowerCase())) return false;
	}
	return posix.normalize(path) === path;
}

export interface FileApplyContext {
	root: string;
	state: WorkspaceFileState;
	/** Copy kept before a file is replaced or deleted; receives a path and must throw when no copy could be made. */
	backup: (key: string, name: string, source: string) => string;
	deviceName: string;
	now?: () => Date;
	/** Streams a remote object into a temp file beside its destination, resuming at `offset`. */
	download: (hash: string, tempPath: string, offset: number) => Promise<void>;
}

export interface FileApplyResult {
	applied: number;
	downloaded: number;
	bytes: number;
	conflicts: number;
	/** Operations that could not be finished; the manifest must not be marked applied yet. */
	failed: number;
	issues: string[];
}

function conflictStamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeName(value: string): string {
	return (
		value
			.replace(/[^A-Za-z0-9._-]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 40) || "device"
	);
}

/** `Report.docx` + laptop -> `Report (conflict laptop 2026-10-22 183000).docx`. */
export function conflictFileName(path: string, deviceName: string, date: Date): string {
	const slash = path.lastIndexOf("/");
	const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : "";
	return `${directory}${stem} (conflict ${sanitizeName(deviceName)} ${conflictStamp(date)})${extension}`;
}

export function workspacePath(root: string, relative: string): string {
	return join(root, ...relative.split("/"));
}

function ensureDirectory(path: string): void {
	mkdirSync(path, { recursive: true });
}

/** The first component of a path that is a symlink or junction, including the final one, if any. */
function linkedAncestor(root: string, relative: string): string | undefined {
	const parts = relative.split("/");
	let current = root;
	for (let index = 0; index < parts.length; index += 1) {
		current = join(current, parts[index]!);
		try {
			if (lstatSync(current).isSymbolicLink()) return parts.slice(0, index + 1).join("/");
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Remove a planted link at a temp or target path so a download never writes through it. */
function removeLinkAt(path: string): boolean {
	try {
		if (!lstatSync(path).isSymbolicLink()) return false;
	} catch {
		return false;
	}
	rmSync(path, { force: true });
	return true;
}

/** Streaming SHA-256, so a large file is never read into one buffer. */
export async function verifyFileHash(path: string): Promise<{ hash: string; size: number } | undefined> {
	try {
		const hash = createHash("sha256");
		let size = 0;
		for await (const chunk of createReadStream(path)) {
			const buffer = chunk as Buffer;
			hash.update(buffer);
			size += buffer.byteLength;
		}
		return { hash: hash.digest("hex"), size };
	} catch {
		return undefined;
	}
}

/** Small synchronous hash for a file whose size is already known; used when planning uploads. */
export function readFileBytes(path: string): Uint8Array | undefined {
	try {
		return readFileSync(path) as Uint8Array;
	} catch {
		return undefined;
	}
}

/** Hash a file through a bounded buffer without loading it whole. */
export function hashLocalFile(path: string): { hash: string; size: number } | undefined {
	let descriptor: number | undefined;
	try {
		const hash = createHash("sha256");
		let size = 0;
		descriptor = openSync(path, "r");
		const buffer = Buffer.alloc(1024 * 1024);
		for (;;) {
			const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
			size += read;
		}
		return { hash: hash.digest("hex"), size };
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function addConflict(state: WorkspaceFileState, conflict: WorkspaceFileConflict): void {
	if (
		state.conflicts.some(
			(item) =>
				item.path === conflict.path &&
				item.reason === conflict.reason &&
				item.remoteCopyPath === conflict.remoteCopyPath,
		)
	) {
		return;
	}
	state.conflicts.push(conflict);
	if (state.conflicts.length > MAX_CONFLICTS) state.conflicts = state.conflicts.slice(-MAX_CONFLICTS);
}

/** Replace a destination, including a rename that only changes letter case on Windows. */
export function replaceFile(temp: string, target: string): void {
	try {
		renameSync(temp, target);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
		const backup = `${target}.myharness-old`;
		rmSync(backup, { force: true });
		renameSync(target, backup);
		try {
			renameSync(temp, target);
		} catch (retry) {
			renameSync(backup, target);
			throw retry;
		}
		rmSync(backup, { force: true });
	}
}

/** Download a verified object and replace the destination only after the hash matched. */
async function downloadFile(
	ctx: FileApplyContext,
	relative: string,
	operation: WorkspaceFileOperation,
	result: FileApplyResult,
): Promise<boolean> {
	if (!operation.hash) return false;
	const target = workspacePath(ctx.root, relative);
	const temp = join(dirname(target), `.${posix.basename(relative)}.myharness.part`);
	const previous = ctx.state.transfers[relative];
	let offset = previous && previous.hash === operation.hash && previous.temp === temp ? previous.offset : 0;
	try {
		ensureDirectory(dirname(target));
		// A link planted at the temp path must never be written through.
		if (removeLinkAt(temp)) offset = 0;
		if (offset === 0) rmSync(temp, { force: true });
		await ctx.download(operation.hash, temp, offset);
		const verified = await verifyFileHash(temp);
		if (!verified) {
			// The temp file exists but cannot be read right now; keep it and its offset for the next attempt.
			result.issues.push(`${relative}: the downloaded file could not be verified yet`);
			ctx.state.transfers[relative] = {
				hash: operation.hash,
				size: operation.size ?? 0,
				offset,
				temp,
				at: nowIso(),
			};
			return false;
		}
		if (verified.hash !== operation.hash) {
			rmSync(temp, { force: true });
			delete ctx.state.transfers[relative];
			result.issues.push(`${relative}: downloaded content failed its checksum`);
			return false;
		}
		// A copy must exist before the local file is replaced; if it cannot be made, nothing is replaced.
		if (existsSync(target)) ctx.backup("workspace-file", posix.basename(relative), target);
		replaceFile(temp, target);
		delete ctx.state.transfers[relative];
		result.downloaded += 1;
		result.bytes += operation.size ?? 0;
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOSPC" && code !== "EACCES" && code !== "EPERM" && code !== "EBUSY") {
			result.issues.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
		}
		ctx.state.transfers[relative] = {
			hash: operation.hash,
			size: operation.size ?? 0,
			offset: existsSync(temp) ? statSync(temp).size : offset,
			temp,
			at: nowIso(),
		};
		return false;
	}
}

/** Save the other version beside the local file so the user can open both. */
async function saveConflictCopy(ctx: FileApplyContext, conflict: WorkspaceFileConflict): Promise<void> {
	if (!conflict.remote?.hash) return;
	let relativeCopy = conflictFileName(conflict.path, conflict.deviceName, new Date(conflict.at));
	let target = workspacePath(ctx.root, relativeCopy);
	for (let index = 2; existsSync(target); index += 1) {
		// Never replace a real file with a conflict copy; the name carries the device and a counter instead.
		relativeCopy = conflictFileName(conflict.path, `${conflict.deviceName} ${index}`, new Date(conflict.at));
		target = workspacePath(ctx.root, relativeCopy);
	}
	if (!isSafeWorkspacePath(relativeCopy)) return;
	const temp = join(dirname(target), `.${posix.basename(relativeCopy)}.myharness.part`);
	try {
		ensureDirectory(dirname(target));
		removeLinkAt(temp);
		await ctx.download(conflict.remote.hash, temp, 0);
		const verified = await verifyFileHash(temp);
		if (!verified || verified.hash !== conflict.remote.hash) {
			rmSync(temp, { force: true });
			return;
		}
		replaceFile(temp, target);
		conflict.remoteCopyPath = target;
	} catch {
		rmSync(temp, { force: true });
	}
}

function removeFile(ctx: FileApplyContext, relative: string): boolean {
	const target = workspacePath(ctx.root, relative);
	if (!existsSync(target)) return true;
	try {
		// Removing a user file always leaves a copy first; a failed copy aborts the deletion.
		ctx.backup("workspace-file", posix.basename(relative), target);
		unlinkSync(target);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT";
	}
}

function removeEmptyDirectory(ctx: FileApplyContext, relative: string): boolean {
	const target = workspacePath(ctx.root, relative);
	try {
		if (readdirSync(target).length > 0) return false;
		rmSync(target, { recursive: false, force: false });
		return true;
	} catch {
		return false;
	}
}

/**
 * Apply one remote manifest against the last confirmed base and the local files seen by this pass.
 *
 * The rules are deliberately conservative: a file that changed on both sides keeps the local content and stores the
 * other version beside it; a remote deletion never removes a file this device edited; an unknown local file is never
 * overwritten because it is missing from a listing; a local deletion is not undone by a remote edit.
 */
export async function applyWorkspaceFileManifest(
	ctx: FileApplyContext,
	manifest: WorkspaceFileManifest,
	local: Map<string, WorkspaceFileEntry>,
	localCase: Map<string, string>,
	remoteDeviceName: string,
	incomplete: readonly string[] = [],
): Promise<FileApplyResult> {
	const result: FileApplyResult = { applied: 0, downloaded: 0, bytes: 0, conflicts: 0, failed: 0, issues: [] };
	const date = (ctx.now ?? (() => new Date()))();
	if (!existsSync(ctx.root)) {
		result.issues.push("workspace root is not available");
		result.failed = manifest.operations.length;
		return result;
	}
	for (const operation of manifest.operations) {
		const relative = operation.path;
		if (!isSafeWorkspacePath(relative)) {
			result.issues.push(`refused unsafe path ${relative}`);
			result.failed += 1;
			continue;
		}
		if (isExcludedWorkspacePath(relative)) {
			result.issues.push(`refused an excluded path ${relative}`);
			result.failed += 1;
			continue;
		}
		if (isUnderIncomplete(relative, incomplete)) {
			// The local side of the comparison is unknown for this subtree, so nothing in it may be applied.
			result.issues.push(`waiting for ${relative}: its folder could not be listed`);
			result.failed += 1;
			continue;
		}
		const linked = linkedAncestor(ctx.root, relative);
		if (linked) {
			result.issues.push(`refused ${relative}: ${linked} is a link`);
			result.failed += 1;
			continue;
		}
		if (operation.type === "dir") {
			const target = workspacePath(ctx.root, relative);
			if (operation.op === "put") {
				const existing = local.get(relative);
				let occupiedByFile = false;
				try {
					occupiedByFile = existsSync(target) && !statSync(target).isDirectory();
				} catch {
					occupiedByFile = true;
				}
				if (existing?.type === "file" || occupiedByFile) {
					addConflict(ctx.state, buildConflict(ctx, relative, "type-mismatch", remoteDeviceName, date));
					result.conflicts += 1;
					continue;
				}
				try {
					ensureDirectory(target);
				} catch (error) {
					result.issues.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
					result.failed += 1;
					continue;
				}
				local.set(relative, { path: relative, type: "dir" });
				ctx.state.base[relative] = { path: relative, type: "dir" };
				result.applied += 1;
			} else if (!existsSync(target)) {
				local.delete(relative);
				delete ctx.state.base[relative];
				result.applied += 1;
			} else if (removeEmptyDirectory(ctx, relative)) {
				local.delete(relative);
				delete ctx.state.base[relative];
				result.applied += 1;
			} else {
				// Unknown files appeared inside a folder the other computer deleted; never force-remove them.
				addConflict(ctx.state, buildConflict(ctx, relative, "deleted-remotely", remoteDeviceName, date));
				result.conflicts += 1;
			}
			continue;
		}
		const base = ctx.state.base[relative];
		const casePath = localCase.get(relative.toLowerCase());
		let current = local.get(relative);
		// A case-only alias belongs to a put: a delete for the old spelling must not delete the renamed file.
		if (!current && operation.op === "put" && casePath && casePath !== relative) current = local.get(casePath);
		if (operation.op === "delete") {
			if (!current) {
				const onDisk = existsSync(workspacePath(ctx.root, relative));
				if (onDisk && base) {
					// The file is on disk but missing from this pass's listing: that is not proof it was deleted.
					addConflict(ctx.state, buildConflict(ctx, relative, "deleted-remotely", remoteDeviceName, date));
					result.conflicts += 1;
					continue;
				}
				delete ctx.state.base[relative];
				result.applied += 1;
				continue;
			}
			if (base && current.hash === base.hash) {
				if (removeFile(ctx, relative)) {
					local.delete(relative);
					delete ctx.state.base[relative];
					result.applied += 1;
				} else {
					result.failed += 1;
				}
			} else {
				const conflict = buildConflict(ctx, relative, "deleted-remotely", remoteDeviceName, date);
				addConflict(ctx.state, conflict);
				result.conflicts += 1;
			}
			continue;
		}
		const remote = operation;
		if (!remote.hash) {
			result.issues.push(`${relative}: a file without a content hash cannot be applied`);
			result.failed += 1;
			continue;
		}
		if (current && current.type === "dir") {
			addConflict(ctx.state, buildConflict(ctx, relative, "type-mismatch", remoteDeviceName, date));
			result.conflicts += 1;
			continue;
		}
		if (current && current.hash === remote.hash) {
			if (casePath && casePath !== relative && !local.has(relative)) {
				if (!renameCaseOnly(ctx, casePath, relative)) {
					result.issues.push(`${relative}: a rename that only changes letter case failed`);
					result.failed += 1;
					continue;
				}
				local.delete(casePath);
				localCase.delete(casePath.toLowerCase());
				local.set(relative, { path: relative, type: "file", hash: remote.hash, size: remote.size ?? 0 });
				localCase.set(relative.toLowerCase(), relative);
			}
			delete ctx.state.base[casePath ?? relative];
			ctx.state.base[relative] = { path: relative, type: "file", hash: remote.hash, size: remote.size ?? 0 };
			result.applied += 1;
			continue;
		}
		const existsOnDisk = existsSync(workspacePath(ctx.root, relative));
		if (!current && !existsOnDisk) {
			if (base) {
				// This device deleted the file while the other one edited it. The deletion stays; the edit is kept as
				// a copy so nothing is lost, and the path is no longer tracked here so no delete is published for it.
				const conflict = buildConflict(ctx, relative, "deleted-locally", remoteDeviceName, date, remote);
				await saveConflictCopy(ctx, conflict);
				addConflict(ctx.state, conflict);
				result.conflicts += 1;
				delete ctx.state.base[relative];
				result.applied += 1;
				continue;
			}
			if (await downloadFile(ctx, relative, remote, result)) {
				local.set(relative, { path: relative, type: "file", hash: remote.hash, size: remote.size ?? 0 });
				if (casePath && casePath !== relative) {
					local.delete(casePath);
					localCase.set(relative.toLowerCase(), relative);
				}
				ctx.state.base[relative] = { path: relative, type: "file", hash: remote.hash, size: remote.size ?? 0 };
				result.applied += 1;
			} else {
				result.failed += 1;
			}
			continue;
		}
		const localChanged = current ? !base || current.hash !== base.hash : true;
		const remoteChanged = !base || remote.hash !== base.hash;
		if (!localChanged) {
			if (await downloadFile(ctx, relative, remote, result)) {
				local.set(relative, { path: relative, type: "file", hash: remote.hash, size: remote.size ?? 0 });
				ctx.state.base[relative] = { path: relative, type: "file", hash: remote.hash, size: remote.size ?? 0 };
				result.applied += 1;
			} else {
				result.failed += 1;
			}
			continue;
		}
		if (!remoteChanged) continue;
		const conflict = buildConflict(ctx, relative, "both-modified", remoteDeviceName, date, remote);
		await saveConflictCopy(ctx, conflict);
		addConflict(ctx.state, conflict);
		result.conflicts += 1;
	}
	return result;
}

function renameCaseOnly(ctx: FileApplyContext, from: string, to: string): boolean {
	const source = workspacePath(ctx.root, from);
	const target = workspacePath(ctx.root, to);
	if (!existsSync(source)) return false;
	const temp = `${source}.myharness-case`;
	try {
		if (existsSync(target) && target !== source) {
			ctx.backup("workspace-file", posix.basename(to), target);
		}
		renameSync(source, temp);
		try {
			renameSync(temp, target);
		} catch (error) {
			renameSync(temp, source);
			throw error;
		}
		return true;
	} catch {
		return false;
	}
}

function buildConflict(
	ctx: FileApplyContext,
	relative: string,
	reason: WorkspaceFileConflict["reason"],
	remoteDeviceName: string,
	date: Date,
	remote?: WorkspaceFileEntry,
): WorkspaceFileConflict {
	return {
		id: sha256(`${ctx.state.workspaceId}:${relative}:${reason}:${date.toISOString()}`).slice(0, 12),
		workspaceId: ctx.state.workspaceId,
		path: relative,
		reason,
		at: date.toISOString(),
		deviceName: remoteDeviceName,
		localPath: workspacePath(ctx.root, relative),
		...(remote ? { remote: { ...remote } } : {}),
		message: conflictMessage(reason),
	};
}

export function conflictMessage(reason: WorkspaceFileConflict["reason"]): string {
	switch (reason) {
		case "both-modified":
			return "Both computers changed this file. The local version is in use and the other version was saved beside it.";
		case "deleted-remotely":
			return "The other computer deleted this file, but this computer changed it. The local file was kept.";
		case "deleted-locally":
			return "This computer deleted this file while the other computer changed it. The other version was saved.";
		default:
			return "A file and a folder claim the same path. Nothing was overwritten; resolve the path manually.";
	}
}

export type ConflictChoice = "keep-local" | "take-remote" | "keep-both";

/**
 * Resolve one recorded conflict. Every choice ends as a normal file change on this device, so the next pass publishes
 * one new version and the other computers converge on it.
 */
export function resolveFileConflict(
	state: WorkspaceFileState,
	conflictId: string,
	choice: ConflictChoice,
	backup: (key: string, name: string, source: string) => string,
): { ok: boolean; error?: string } {
	const conflict = state.conflicts.find((item) => item.id === conflictId);
	if (!conflict) return { ok: false, error: "Unknown conflict" };
	const target = conflict.localPath;
	if (choice === "take-remote") {
		if (!conflict.remoteCopyPath || !existsSync(conflict.remoteCopyPath)) {
			return { ok: false, error: "The other version is no longer on disk" };
		}
		try {
			if (existsSync(target)) backup("workspace-file", posix.basename(target), target);
			replaceFile(conflict.remoteCopyPath, target);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		state.base[conflict.path] = {
			path: conflict.path,
			type: "file",
			...(conflict.remote?.hash ? { hash: conflict.remote.hash } : {}),
			...(conflict.remote?.size !== undefined ? { size: conflict.remote.size } : {}),
		};
	} else {
		// Both keep-local and keep-both publish the local content as a new version; the saved copy, if any, is a
		// normal new file on the next scan. Removing the base entry is what makes the next pass upload it.
		delete state.base[conflict.path];
	}
	state.conflicts = state.conflicts.filter((item) => item.id !== conflictId);
	return { ok: true };
}
