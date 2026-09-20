import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	type Stats,
	unlinkSync,
	utimesSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { getSessionsDir } from "../../config/paths/index.ts";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { writeFileAtomicallySync, writeFileDurablySync } from "../../utils/atomic-write.ts";

const SESSION_REFERENCE_FIELDS = ["parentSession", "fullOutputPath"] as const;
const MIGRATION_MARKER_NAME = ".legacy-session-storage-migrated.json";
const MIGRATION_MARKER_VERSION = 2;

export interface SessionStorageMigrationOptions {
	/** The old global Session root. Defaults to the pre-refactor location. */
	sourceRoot?: string;
	/** The legacy flat project Session root used before Workspace scoping. */
	targetRoot?: string;
}

export interface SessionStorageMigrationResult {
	sourceRoot: string;
	targetRoot: string;
	sourceExists: boolean;
	copiedFiles: number;
	alreadyPresentFiles: number;
	removedSourceFiles: number;
	rewrittenPathFields: number;
	conflicts: string[];
	errors: string[];
	unresolvedReferences: string[];
}

interface PathReference {
	sourcePath: string;
	targetPath: string;
}

interface FilePlan {
	sourcePath: string;
	targetPath: string;
	sourceBytes: Buffer;
	targetBytes: Buffer;
	sourceStats: Stats;
	references: PathReference[];
	status: "copied" | "present" | "conflict" | "error";
	validTarget: boolean;
}

function pathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function relativePathInside(root: string, candidate: string): string | undefined {
	const resolvedRoot = resolve(root);
	const resolvedCandidate = resolve(candidate);
	const relativePath = relative(resolvedRoot, resolvedCandidate);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		pathKey(resolve(resolvedRoot, relativePath)) !== pathKey(resolvedCandidate)
	) {
		return undefined;
	}
	return relativePath;
}

function mapLegacyPath(value: string, sourceRoot: string, targetRoot: string): PathReference | undefined {
	const relativePath = relativePathInside(sourceRoot, value);
	if (!relativePath) return undefined;
	return {
		sourcePath: resolve(value),
		targetPath: resolve(targetRoot, relativePath),
	};
}

function rewriteSessionReferences(
	bytes: Buffer,
	sourceRoot: string,
	targetRoot: string,
): { bytes: Buffer; references: PathReference[]; rewrittenPathFields: number } {
	const text = bytes.toString("utf8");
	const lines = text.split("\n");
	const references: PathReference[] = [];
	let rewrittenPathFields = 0;
	let changed = false;

	for (let index = 0; index < lines.length; index++) {
		const originalLine = lines[index]!;
		const lineEnding = originalLine.endsWith("\r") ? "\r" : "";
		const json = originalLine.slice(0, originalLine.length - lineEnding.length);
		if (!json.trim()) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(json) as unknown;
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

		let entryChanged = false;
		const rewriteValue = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const item of value) rewriteValue(item);
				return;
			}
			if (typeof value !== "object" || value === null) return;

			for (const [field, child] of Object.entries(value)) {
				const isPathField = SESSION_REFERENCE_FIELDS.some((candidate) => candidate === field);
				if (isPathField && typeof child === "string") {
					const reference = mapLegacyPath(child, sourceRoot, targetRoot);
					if (reference) {
						(value as Record<string, unknown>)[field] = reference.targetPath;
						references.push(reference);
						rewrittenPathFields++;
						entryChanged = true;
					}
					continue;
				}
				rewriteValue(child);
			}
		};
		rewriteValue(parsed);

		if (entryChanged) {
			lines[index] = `${JSON.stringify(parsed)}${lineEnding}`;
			changed = true;
		}
	}

	return {
		bytes: changed ? Buffer.from(lines.join("\n"), "utf8") : bytes,
		references,
		rewrittenPathFields,
	};
}

function collectSourceFiles(
	currentPath: string,
	relativeDirectory: string,
	directories: Array<{ sourcePath: string; relativePath: string; sourceStats: Stats }>,
	files: Array<{ sourcePath: string; relativePath: string; sourceStats: Stats }>,
	errors: string[],
): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(currentPath, { withFileTypes: true });
	} catch (error) {
		errors.push(`无法读取旧 Session 目录 ${currentPath}：${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	for (const entry of entries) {
		const sourcePath = join(currentPath, entry.name);
		const relativePath = join(relativeDirectory, entry.name);
		let sourceStats: Stats;
		try {
			sourceStats = lstatSync(sourcePath);
		} catch (error) {
			errors.push(
				`无法检查旧 Session 路径 ${sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}

		if (sourceStats.isSymbolicLink()) {
			errors.push(`跳过旧 Session 符号链接：${sourcePath}`);
			continue;
		}
		if (sourceStats.isDirectory()) {
			directories.push({ sourcePath, relativePath, sourceStats });
			collectSourceFiles(sourcePath, relativePath, directories, files, errors);
			continue;
		}
		if (!sourceStats.isFile()) {
			errors.push(`跳过旧 Session 特殊文件：${sourcePath}`);
			continue;
		}

		files.push({ sourcePath, relativePath, sourceStats });
	}
}

function ensureDirectory(path: string, conflicts: string[], errors: string[]): boolean {
	try {
		if (existsSync(path)) {
			const stats = lstatSync(path);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				conflicts.push(path);
				return false;
			}
			return true;
		}
		mkdirSync(path, { recursive: true });
		return true;
	} catch (error) {
		errors.push(`无法创建目标 Session 目录 ${path}：${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

function hash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(left: Buffer, right: Buffer): boolean {
	return left.length === right.length && hash(left) === hash(right);
}

function validateSessionJsonl(path: string, bytes: Buffer): boolean {
	if (extname(path).toLowerCase() !== ".jsonl") return true;
	for (const line of bytes.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const header = JSON.parse(line) as { type?: unknown; id?: unknown };
			return header.type === "session" && typeof header.id === "string";
		} catch {
			return false;
		}
	}
	return false;
}

function defaultLegacySessionsDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "agent", "sessions");
}

function initializeTargetRoot(targetRoot: string, result: SessionStorageMigrationResult): boolean {
	try {
		if (existsSync(targetRoot)) {
			const stats = lstatSync(targetRoot);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				result.conflicts.push(targetRoot);
				return false;
			}
			return true;
		}
		mkdirSync(targetRoot, { recursive: true });
		return true;
	} catch (error) {
		result.errors.push(
			`无法创建目标 Session 根目录 ${targetRoot}：${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function migrationMarkerPath(targetRoot: string): string {
	return join(targetRoot, MIGRATION_MARKER_NAME);
}

function readMigrationMarkerVersion(targetRoot: string): number | undefined {
	const markerPath = migrationMarkerPath(targetRoot);
	try {
		if (!existsSync(markerPath)) return undefined;
		const stats = lstatSync(markerPath);
		if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: unknown };
		return typeof marker.version === "number" ? marker.version : undefined;
	} catch {
		return undefined;
	}
}

function hasCompletedMigrationMarker(targetRoot: string): boolean {
	return readMigrationMarkerVersion(targetRoot) === MIGRATION_MARKER_VERSION;
}

function writeCompletedMigrationMarker(targetRoot: string, result: SessionStorageMigrationResult): void {
	const markerPath = migrationMarkerPath(targetRoot);
	if (hasCompletedMigrationMarker(targetRoot)) return;
	if (existsSync(markerPath)) {
		if (readMigrationMarkerVersion(targetRoot) !== 1) {
			result.errors.push(`迁移完成标记无法安全更新：${markerPath}`);
			return;
		}
		try {
			unlinkSync(markerPath);
		} catch (error) {
			result.errors.push(
				`无法更新 Session 迁移完成标记 ${markerPath}：${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
	}
	const temporaryPath = `${markerPath}.tmp-${randomUUID()}`;
	try {
		writeFileDurablySync(
			temporaryPath,
			`${JSON.stringify({ version: MIGRATION_MARKER_VERSION, completedAt: new Date().toISOString() })}\n`,
			{ flag: "wx" },
		);
		renameSync(temporaryPath, markerPath);
		if (readMigrationMarkerVersion(targetRoot) !== MIGRATION_MARKER_VERSION)
			result.errors.push(`迁移完成标记写入后校验失败：${markerPath}`);
	} catch (error) {
		result.errors.push(
			`无法写入 Session 迁移完成标记 ${markerPath}：${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function repairTargetSessionReferences(
	targetRoot: string,
	sourceRoot: string,
	result: SessionStorageMigrationResult,
): void {
	const targetDirectories: Array<{ sourcePath: string; relativePath: string; sourceStats: Stats }> = [];
	const targetFiles: Array<{ sourcePath: string; relativePath: string; sourceStats: Stats }> = [];
	collectSourceFiles(targetRoot, "", targetDirectories, targetFiles, result.errors);

	for (const targetFile of targetFiles) {
		if (extname(targetFile.sourcePath).toLowerCase() !== ".jsonl") continue;
		let currentBytes: Buffer;
		try {
			currentBytes = readFileSync(targetFile.sourcePath);
		} catch (error) {
			result.errors.push(
				`无法读取目标 Session 文件 ${targetFile.sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		const rewritten = rewriteSessionReferences(currentBytes, sourceRoot, targetRoot);
		if (sameBytes(currentBytes, rewritten.bytes)) continue;

		const backupPath = `${targetFile.sourcePath}.migration-backup-${randomUUID()}.tmp`;
		try {
			copyFileSync(targetFile.sourcePath, backupPath);
			writeFileAtomicallySync(targetFile.sourcePath, rewritten.bytes);
			const verifiedBytes = readFileSync(targetFile.sourcePath);
			if (
				!sameBytes(verifiedBytes, rewritten.bytes) ||
				!validateSessionJsonl(targetFile.sourcePath, verifiedBytes)
			) {
				throw new Error(`目标 Session 校验失败：${targetFile.sourcePath}`);
			}
			unlinkSync(backupPath);
			result.rewrittenPathFields += rewritten.rewrittenPathFields;
		} catch (error) {
			try {
				if (existsSync(backupPath)) {
					writeFileAtomicallySync(targetFile.sourcePath, readFileSync(backupPath));
					unlinkSync(backupPath);
				}
			} catch (restoreError) {
				result.errors.push(
					`目标 Session 修复失败且无法恢复原文件 ${targetFile.sourcePath}：${
						restoreError instanceof Error ? restoreError.message : String(restoreError)
					}`,
				);
			}
			result.errors.push(
				`无法修复已迁移 Session 中的旧路径 ${targetFile.sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (existsSync(backupPath)) unlinkSync(backupPath);
		}
	}
}

/**
 * Copy the legacy global Session tree into the project data root without
 * overwriting conflicts. Source files are removed only after their target and
 * any migrated Session references have been validated.
 */
export function migrateLegacySessionsToDataDir(
	projectRoot: string = process.cwd(),
	options: SessionStorageMigrationOptions = {},
): SessionStorageMigrationResult {
	const sourceRoot = resolve(options.sourceRoot ?? defaultLegacySessionsDir());
	const targetRoot = resolve(options.targetRoot ?? getSessionsDir(projectRoot));
	const result: SessionStorageMigrationResult = {
		sourceRoot,
		targetRoot,
		sourceExists: false,
		copiedFiles: 0,
		alreadyPresentFiles: 0,
		removedSourceFiles: 0,
		rewrittenPathFields: 0,
		conflicts: [],
		errors: [],
		unresolvedReferences: [],
	};

	if (pathKey(sourceRoot) === pathKey(targetRoot)) {
		result.errors.push("旧 Session 目录与目标 Session 目录相同，已跳过迁移。");
		return result;
	}
	const markerVersion = readMigrationMarkerVersion(targetRoot);
	if (markerVersion === MIGRATION_MARKER_VERSION) return result;
	if (markerVersion === 1) {
		if (!initializeTargetRoot(targetRoot, result)) return result;
		repairTargetSessionReferences(targetRoot, sourceRoot, result);
		if (result.errors.length === 0) writeCompletedMigrationMarker(targetRoot, result);
		return result;
	}
	result.sourceExists = existsSync(sourceRoot);
	if (!result.sourceExists) return result;
	if (!initializeTargetRoot(targetRoot, result)) return result;

	let sourceRootStats: Stats;
	try {
		sourceRootStats = lstatSync(sourceRoot);
	} catch (error) {
		result.errors.push(
			`无法检查旧 Session 根目录 ${sourceRoot}：${error instanceof Error ? error.message : String(error)}`,
		);
		return result;
	}
	if (sourceRootStats.isSymbolicLink() || !sourceRootStats.isDirectory()) {
		result.errors.push(`旧 Session 根目录不是普通目录，已跳过：${sourceRoot}`);
		return result;
	}

	const sourceDirectories: Array<{ sourcePath: string; relativePath: string; sourceStats: Stats }> = [];
	const sourceFiles: Array<{ sourcePath: string; relativePath: string; sourceStats: Stats }> = [];
	collectSourceFiles(sourceRoot, "", sourceDirectories, sourceFiles, result.errors);

	for (const sourceDirectory of sourceDirectories) {
		const targetDirectory = resolve(targetRoot, sourceDirectory.relativePath);
		ensureDirectory(targetDirectory, result.conflicts, result.errors);
	}

	const plans: FilePlan[] = [];
	for (const sourceFile of sourceFiles) {
		const targetPath = resolve(targetRoot, sourceFile.relativePath);
		let sourceBytes: Buffer;
		try {
			sourceBytes = readFileSync(sourceFile.sourcePath);
		} catch (error) {
			result.errors.push(
				`无法读取旧 Session 文件 ${sourceFile.sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}

		const rewritten =
			extname(sourceFile.sourcePath).toLowerCase() === ".jsonl"
				? rewriteSessionReferences(sourceBytes, sourceRoot, targetRoot)
				: { bytes: sourceBytes, references: [], rewrittenPathFields: 0 };
		result.rewrittenPathFields += rewritten.rewrittenPathFields;

		const plan: FilePlan = {
			sourcePath: sourceFile.sourcePath,
			targetPath,
			sourceBytes,
			targetBytes: rewritten.bytes,
			sourceStats: sourceFile.sourceStats,
			references: rewritten.references,
			status: "error",
			validTarget: false,
		};
		plans.push(plan);

		if (!ensureDirectory(dirname(targetPath), result.conflicts, result.errors)) continue;

		try {
			if (existsSync(targetPath)) {
				const targetStats = lstatSync(targetPath);
				if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
					result.conflicts.push(targetPath);
					plan.status = "conflict";
					continue;
				}
				const existingBytes = readFileSync(targetPath);
				if (!sameBytes(existingBytes, plan.targetBytes)) {
					result.conflicts.push(targetPath);
					plan.status = "conflict";
					continue;
				}
				plan.status = "present";
			} else {
				const temporaryPath = `${targetPath}.migration-${randomUUID()}.tmp`;
				try {
					writeFileDurablySync(temporaryPath, plan.targetBytes, { flag: "wx" });
					if (existsSync(targetPath)) {
						result.conflicts.push(targetPath);
						unlinkSync(temporaryPath);
						plan.status = "conflict";
						continue;
					}
					renameSync(temporaryPath, targetPath);
				} finally {
					if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
				}
				plan.status = "copied";
			}

			const targetBytes = readFileSync(targetPath);
			plan.validTarget = sameBytes(targetBytes, plan.targetBytes) && validateSessionJsonl(targetPath, targetBytes);
			if (!plan.validTarget) {
				plan.status = "error";
				result.errors.push(`目标 Session 校验失败：${targetPath}`);
				continue;
			}
			utimesSync(targetPath, sourceFile.sourceStats.atime, sourceFile.sourceStats.mtime);
			if (plan.status === "copied") result.copiedFiles++;
			if (plan.status === "present") result.alreadyPresentFiles++;
		} catch (error) {
			plan.status = "error";
			result.errors.push(
				`迁移 Session 文件失败 ${sourceFile.sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	for (const sourceDirectory of sourceDirectories) {
		const targetDirectory = resolve(targetRoot, sourceDirectory.relativePath);
		try {
			if (lstatSync(targetDirectory).isDirectory()) {
				utimesSync(targetDirectory, sourceDirectory.sourceStats.atime, sourceDirectory.sourceStats.mtime);
			}
		} catch (error) {
			result.errors.push(
				`无法保留目标 Session 目录时间 ${targetDirectory}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const plansBySource = new Map(plans.map((plan) => [pathKey(plan.sourcePath), plan]));
	const blockedPlans = new Set<FilePlan>();
	for (const plan of plans) {
		if (!plan.validTarget) {
			blockedPlans.add(plan);
			continue;
		}
		for (const reference of plan.references) {
			const referencedPlan = plansBySource.get(pathKey(reference.sourcePath));
			if (!referencedPlan) {
				// A historical parent or tool-output reference may already point to
				// a file that was deleted before this migration. Preserve the
				// reference rewrite but do not make that pre-existing absence a new
				// migration failure.
				if (!existsSync(reference.sourcePath)) continue;
				const message = `${plan.sourcePath} -> ${reference.targetPath}`;
				result.unresolvedReferences.push(message);
				blockedPlans.add(plan);
				continue;
			}
			if (!referencedPlan.validTarget) {
				const message = `${plan.sourcePath} -> ${reference.targetPath}`;
				result.unresolvedReferences.push(message);
				blockedPlans.add(plan);
			}
		}
	}

	for (const plan of plans) {
		if (!plan.validTarget || blockedPlans.has(plan)) continue;
		try {
			const currentBytes = readFileSync(plan.sourcePath);
			if (!sameBytes(currentBytes, plan.sourceBytes)) {
				result.errors.push(`旧 Session 在迁移期间发生变化，保留原文件：${plan.sourcePath}`);
				continue;
			}
			unlinkSync(plan.sourcePath);
			result.removedSourceFiles++;
		} catch (error) {
			result.errors.push(
				`无法清理已验证的旧 Session 文件 ${plan.sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (
		result.conflicts.length === 0 &&
		result.errors.length === 0 &&
		result.unresolvedReferences.length === 0 &&
		result.removedSourceFiles === sourceFiles.length
	) {
		writeCompletedMigrationMarker(targetRoot, result);
	}

	return result;
}
