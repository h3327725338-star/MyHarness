import { randomUUID } from "node:crypto";
import {
	closeSync,
	type Dirent,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { lstat, open as openAsync, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type WriteOptions = {
	flag?: string;
	mode?: number;
};
type FileContent = string | Uint8Array;

const ATOMIC_TEMP_NAME = /^(.*)\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/iu;

function temporaryPathFor(filePath: string): string {
	return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

export interface AtomicTempCleanupOptions {
	/** Keep a temp file until it is at least this old. */
	minAgeMs?: number;
	/** Injectable clock for deterministic recovery tests. */
	nowMs?: number;
	/** Injectable liveness check for deterministic recovery tests. */
	isProcessAlive?: (pid: number) => boolean;
}

export interface AtomicTempCleanupResult {
	scanned: number;
	removed: string[];
	active: string[];
	tooNew: string[];
	ignored: number;
	errors: string[];
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath !== "" && !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
	);
}

function defaultIsProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Remove only stale temporary files created by this module's atomic writer.
 *
 * The filename contains the creating PID and a UUID. A temp is removed only
 * after the owner is gone and the age grace period has elapsed. Symlinks,
 * reparse points, unknown .tmp names, and uncertain paths are left alone.
 */
export function cleanupStaleAtomicWriteTemps(
	root: string,
	options: AtomicTempCleanupOptions = {},
): AtomicTempCleanupResult {
	const result: AtomicTempCleanupResult = {
		scanned: 0,
		removed: [],
		active: [],
		tooNew: [],
		ignored: 0,
		errors: [],
	};
	const resolvedRoot = resolve(root);
	const minAgeMs = Math.max(0, options.minAgeMs ?? 10 * 60 * 1000);
	const nowMs = options.nowMs ?? Date.now();
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

	let rootStats: Stats;
	try {
		rootStats = lstatSync(resolvedRoot);
	} catch {
		return result;
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return result;

	const visit = (directory: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			result.errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		for (const entry of entries) {
			const filePath = join(directory, entry.name);
			let stats: Stats;
			try {
				stats = lstatSync(filePath);
			} catch {
				result.ignored++;
				continue;
			}
			if (stats.isSymbolicLink()) {
				result.ignored++;
				continue;
			}
			if (stats.isDirectory()) {
				visit(filePath);
				continue;
			}
			if (!stats.isFile()) {
				result.ignored++;
				continue;
			}

			const match = ATOMIC_TEMP_NAME.exec(entry.name);
			if (!match) continue;
			result.scanned++;
			const pid = Number(match[2]);
			const targetPath = join(directory, match[1]!);
			if (!Number.isSafeInteger(pid) || pid <= 0 || !isPathInside(resolvedRoot, targetPath)) {
				result.ignored++;
				continue;
			}

			const ageMs = nowMs - stats.mtimeMs;
			if (ageMs < minAgeMs) {
				result.tooNew.push(filePath);
				continue;
			}
			if (isProcessAlive(pid)) {
				result.active.push(filePath);
				continue;
			}

			try {
				const targetStats = lstatSync(targetPath);
				if (targetStats.isSymbolicLink() || targetStats.isDirectory()) {
					result.ignored++;
					continue;
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					result.ignored++;
					continue;
				}
				// A temp for a target that was never installed is still safe to reclaim
				// once its owner is gone and the grace period has elapsed.
			}

			try {
				unlinkSync(filePath);
				result.removed.push(filePath);
			} catch (error) {
				result.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};

	visit(resolvedRoot);
	return result;
}

function existingModeSync(filePath: string): { mode?: number; isSymlink: boolean } {
	try {
		const stats = lstatSync(filePath);
		return {
			mode: stats.isSymbolicLink() ? undefined : stats.mode & 0o777,
			isSymlink: stats.isSymbolicLink(),
		};
	} catch {
		return { isSymlink: false };
	}
}

async function existingMode(filePath: string): Promise<{ mode?: number; isSymlink: boolean }> {
	try {
		const stats = await lstat(filePath);
		return {
			mode: stats.isSymbolicLink() ? undefined : stats.mode & 0o777,
			isSymlink: stats.isSymbolicLink(),
		};
	} catch {
		return { isSymlink: false };
	}
}

function writeFileDurablySync(filePath: string, content: FileContent, options: WriteOptions = {}): void {
	const fd =
		options.mode === undefined
			? openSync(filePath, options.flag ?? "w")
			: openSync(filePath, options.flag ?? "w", options.mode);
	try {
		if (typeof content === "string") writeFileSync(fd, content, { encoding: "utf-8" });
		else writeFileSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write a file and flush its contents before closing the file descriptor. */
export { writeFileDurablySync };

/**
 * Replace a destination without first truncating it. The fallback is useful on
 * Windows, where another process can briefly hold the destination open and a
 * direct rename-over-existing-file may fail.
 */
function replaceFileSync(temporaryPath: string, filePath: string): void {
	try {
		renameSync(temporaryPath, filePath);
		return;
	} catch (firstError) {
		let targetExists = false;
		try {
			const stats = lstatSync(filePath);
			if (stats.isDirectory()) throw firstError;
			targetExists = true;
		} catch (error) {
			if (error === firstError) throw error;
		}

		if (!targetExists) {
			try {
				renameSync(temporaryPath, filePath);
				return;
			} catch {
				throw firstError;
			}
		}

		const backupPath = `${filePath}.${process.pid}.${randomUUID()}.old`;
		renameSync(filePath, backupPath);
		try {
			renameSync(temporaryPath, filePath);
		} catch (replacementError) {
			try {
				renameSync(backupPath, filePath);
			} catch {
				// Preserve the replacement error; the backup remains recoverable.
			}
			throw replacementError;
		}
		try {
			unlinkSync(backupPath);
		} catch {
			// A stale backup is preferable to losing the successfully installed file.
		}
	}
}

/**
 * Write a file atomically and durably.
 *
 * A symlink is written through instead of replaced so callers retain the
 * normal file-tool semantics for linked workspace files.
 */
export function writeFileAtomicallySync(filePath: string, content: FileContent): void {
	const existing = existingModeSync(filePath);
	if (existing.isSymlink) {
		writeFileDurablySync(filePath, content, { flag: "w" });
		return;
	}

	const temporaryPath = temporaryPathFor(filePath);
	try {
		writeFileDurablySync(temporaryPath, content, {
			flag: "wx",
			...(existing.mode === undefined ? {} : { mode: existing.mode }),
		});
		replaceFileSync(temporaryPath, filePath);
	} finally {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The temporary file was renamed or the original failure is more useful.
		}
	}
}

async function writeFileDurably(filePath: string, content: FileContent, options: WriteOptions = {}): Promise<void> {
	const handle =
		options.mode === undefined
			? await openAsync(filePath, options.flag ?? "w")
			: await openAsync(filePath, options.flag ?? "w", options.mode);
	try {
		if (typeof content === "string") await handle.writeFile(content, { encoding: "utf-8" });
		else await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Async equivalent used by file tools whose operation contract is async. */
export { writeFileDurably };

async function replaceFile(temporaryPath: string, filePath: string): Promise<void> {
	try {
		await rename(temporaryPath, filePath);
		return;
	} catch (firstError) {
		let targetExists = false;
		try {
			const stats = await lstat(filePath);
			if (stats.isDirectory()) throw firstError;
			targetExists = true;
		} catch (error) {
			if (error === firstError) throw error;
		}

		if (!targetExists) {
			try {
				await rename(temporaryPath, filePath);
				return;
			} catch {
				throw firstError;
			}
		}

		const backupPath = `${filePath}.${process.pid}.${randomUUID()}.old`;
		await rename(filePath, backupPath);
		try {
			await rename(temporaryPath, filePath);
		} catch (replacementError) {
			try {
				await rename(backupPath, filePath);
			} catch {
				// Preserve the replacement error; the backup remains recoverable.
			}
			throw replacementError;
		}
		try {
			await unlink(backupPath);
		} catch {
			// A stale backup is preferable to losing the successfully installed file.
		}
	}
}

/** Replace an already-written temporary file without exposing a partial target. */
export async function replaceFileAtomically(temporaryPath: string, filePath: string): Promise<void> {
	await replaceFile(temporaryPath, filePath);
}

/** Async atomic replacement. See writeFileAtomicallySync for symlink semantics. */
export async function writeFileAtomically(filePath: string, content: FileContent): Promise<void> {
	const existing = await existingMode(filePath);
	if (existing.isSymlink) {
		await writeFileDurably(filePath, content, { flag: "w" });
		return;
	}

	const temporaryPath = temporaryPathFor(filePath);
	try {
		await writeFileDurably(temporaryPath, content, {
			flag: "wx",
			...(existing.mode === undefined ? {} : { mode: existing.mode }),
		});
		await replaceFile(temporaryPath, filePath);
	} finally {
		try {
			await unlink(temporaryPath);
		} catch {
			// The temporary file was renamed or the original failure is more useful.
		}
	}
}
