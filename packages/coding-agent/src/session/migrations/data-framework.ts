import { createHash, randomUUID } from "node:crypto";
import {
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
import { extname, join, relative, resolve, sep } from "node:path";
import {
	getDataDir,
	getDataFrameworkMigrationMarkerPath,
	getSessionConversationPath,
	getSessionDir,
	getSessionMetadataPath,
	getWorkspaceSessionsDir,
	getWorkspacesDir,
} from "../../config/paths/index.ts";
import { getAgentDir } from "../../config.ts";
import { type Workspace, WorkspaceStore } from "../../data/workspace-store.ts";
import { writeFileDurablySync } from "../../utils/atomic-write.ts";
import { writeSessionMetadata } from "../storage/jsonl/index.ts";

const MIGRATION_MARKER_VERSION = 1;
const LEGACY_STORAGE_MARKER_NAME = ".legacy-session-storage-migrated.json";
const SESSION_REFERENCE_FIELDS = new Set(["parentSession", "fullOutputPath"]);
const KNOWN_SESSION_DATA_DIRS = new Set(["tool-results", ".vision-checkpoints"]);

export interface DataFrameworkSessionMigrationOptions {
	sourceRoot?: string;
	dataRoot?: string;
	agentDir?: string;
}

export interface DataFrameworkSessionMigrationResult {
	sourceRoot: string;
	targetRoot: string;
	sourceExists: boolean;
	migratedFiles: number;
	alreadyPresentFiles: number;
	removedSourceFiles: number;
	rewrittenPathFields: number;
	conflicts: string[];
	errors: string[];
	unresolvedReferences: string[];
}

interface SourceFile {
	sourcePath: string;
	relativePath: string;
	stats: Stats;
}

interface SessionPlan {
	sourcePath: string;
	sourceDirectory: string;
	sessionId: string;
	workspace: Workspace;
	targetPath: string;
	stats: Stats;
	cwd: string;
	createdAt: string;
}

interface FilePlan {
	sourcePath: string;
	targetPath: string;
	sourceBytes: Buffer;
	targetBytes: Buffer;
	stats: Stats;
	references: Array<{ sourcePath: string; targetPath: string }>;
	ownerSourcePath?: string;
	status: "copied" | "present" | "conflict" | "error";
	validTarget: boolean;
}

function pathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameBytes(left: Buffer, right: Buffer): boolean {
	if (left.length !== right.length) return false;
	return createHash("sha256").update(left).digest("hex") === createHash("sha256").update(right).digest("hex");
}

function collectFiles(currentPath: string, relativeDirectory: string, files: SourceFile[], errors: string[]): void {
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
		let stats: Stats;
		try {
			stats = lstatSync(sourcePath);
		} catch (error) {
			errors.push(
				`无法检查旧 Session 路径 ${sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (stats.isSymbolicLink()) {
			errors.push(`跳过旧 Session 符号链接：${sourcePath}`);
			continue;
		}
		if (stats.isDirectory()) {
			collectFiles(sourcePath, relativePath, files, errors);
			continue;
		}
		if (stats.isFile()) files.push({ sourcePath, relativePath, stats });
		else errors.push(`跳过旧 Session 特殊文件：${sourcePath}`);
	}
}

function readSessionHeader(
	path: string,
): { id: string; cwd: string; workspaceId?: string; timestamp?: string } | undefined {
	try {
		const firstLine = readFileSync(path, "utf8")
			.split(/\r?\n/u)
			.find((line) => line.trim());
		if (!firstLine) return undefined;
		const value = JSON.parse(firstLine) as Record<string, unknown>;
		if (value.type !== "session" || typeof value.id !== "string" || !value.id) return undefined;
		return {
			id: value.id,
			cwd: typeof value.cwd === "string" ? value.cwd : "",
			workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : undefined,
			timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
		};
	} catch {
		return undefined;
	}
}

function safeSessionId(id: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(id);
}

function encodeLegacyCwd(cwd: string): string {
	const resolved = resolve(cwd);
	return `--${resolved.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

function markerPath(targetRoot: string): string {
	return getDataFrameworkMigrationMarkerPath(resolve(targetRoot, ".."));
}

function hasCompletedMarker(targetRoot: string): boolean {
	try {
		if (!existsSync(markerPath(targetRoot))) return false;
		const value = JSON.parse(readFileSync(markerPath(targetRoot), "utf8")) as { version?: unknown };
		return value.version === MIGRATION_MARKER_VERSION;
	} catch {
		return false;
	}
}

function writeCompletedMarker(targetRoot: string, result: DataFrameworkSessionMigrationResult): void {
	const path = markerPath(targetRoot);
	if (existsSync(path)) return;
	const temporaryPath = `${path}.tmp-${randomUUID()}`;
	try {
		writeFileDurablySync(
			temporaryPath,
			`${JSON.stringify({ version: MIGRATION_MARKER_VERSION, completedAt: new Date().toISOString() })}\n`,
			{ flag: "wx" },
		);
		if (existsSync(path)) {
			result.errors.push(`迁移完成标记已存在但无法确认：${path}`);
			return;
		}
		renameSync(temporaryPath, path);
	} catch (error) {
		result.errors.push(
			`无法写入 Session 数据迁移标记 ${path}：${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function ensureDirectory(path: string, result: DataFrameworkSessionMigrationResult): boolean {
	try {
		if (existsSync(path)) {
			const stats = lstatSync(path);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				result.conflicts.push(path);
				return false;
			}
			return true;
		}
		mkdirSync(path, { recursive: true });
		return true;
	} catch (error) {
		result.errors.push(
			`无法创建目标 Session 目录 ${path}：${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function rewriteJsonl(
	bytes: Buffer,
	workspaceId: string,
	pathMap: Map<string, string>,
): { bytes: Buffer; references: Array<{ sourcePath: string; targetPath: string }>; rewrittenPathFields: number } {
	const lines = bytes.toString("utf8").split("\n");
	const references: Array<{ sourcePath: string; targetPath: string }> = [];
	let changed = false;
	let rewrittenPathFields = 0;

	for (let index = 0; index < lines.length; index++) {
		const originalLine = lines[index]!;
		const lineEnding = originalLine.endsWith("\r") ? "\r" : "";
		const jsonText = originalLine.slice(0, originalLine.length - lineEnding.length);
		if (!jsonText.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonText) as unknown;
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
		let lineChanged = false;
		const visit = (value: unknown, isHeader = false): void => {
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			if (typeof value !== "object" || value === null) return;
			const record = value as Record<string, unknown>;
			if (isHeader && record.type === "session" && record.workspaceId !== workspaceId) {
				record.workspaceId = workspaceId;
				lineChanged = true;
			}
			for (const [field, child] of Object.entries(record)) {
				if (SESSION_REFERENCE_FIELDS.has(field) && typeof child === "string") {
					const targetPath = pathMap.get(pathKey(child));
					if (targetPath) {
						references.push({ sourcePath: resolve(child), targetPath });
						if (targetPath !== child) {
							record[field] = targetPath;
							rewrittenPathFields++;
							lineChanged = true;
						}
					}
					continue;
				}
				visit(child);
			}
		};
		visit(parsed, index === 0);
		if (lineChanged) {
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

function validateJsonl(bytes: Buffer, sessionId: string, workspaceId: string): boolean {
	try {
		const firstLine = bytes
			.toString("utf8")
			.split(/\r?\n/u)
			.find((line) => line.trim());
		if (!firstLine) return false;
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		return header.type === "session" && header.id === sessionId && header.workspaceId === workspaceId;
	} catch {
		return false;
	}
}

function createOrFindWorkspace(
	store: WorkspaceStore,
	header: { cwd: string; workspaceId?: string },
	result: DataFrameworkSessionMigrationResult,
): Workspace | undefined {
	if (header.workspaceId) {
		const byId = store.getById(header.workspaceId);
		if (byId) return byId;
	}
	try {
		return store.ensureForPath(header.cwd || process.cwd(), process.cwd(), true, false);
	} catch (error) {
		result.errors.push(
			`无法为旧 Session 建立 Workspace 元数据 ${header.cwd || "<empty>"}：${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function sidecarOwner(
	file: SourceFile,
	sessionPlans: SessionPlan[],
	sourceRoot: string,
	store?: WorkspaceStore,
): SessionPlan | undefined {
	const relativePath = file.relativePath.split(/[\\/]+/u).filter(Boolean);
	for (const category of KNOWN_SESSION_DATA_DIRS) {
		const categoryIndex = relativePath.indexOf(category);
		if (categoryIndex < 0) continue;
		const candidateId = relativePath[categoryIndex + 1];
		if (!candidateId) continue;
		const legacySessionDirectory = relativePath
			.slice(0, categoryIndex)
			.reduce((current, segment) => join(current, segment), "");
		const exact = sessionPlans.find(
			(plan) =>
				plan.sessionId === candidateId &&
				pathKey(plan.sourceDirectory) === pathKey(resolve(sourceRoot, legacySessionDirectory)),
		);
		if (exact) return exact;
	}

	const sourceDirectory = dirnameFor(file.sourcePath);
	const candidates = sessionPlans.filter((plan) => pathKey(plan.sourceDirectory) === pathKey(sourceDirectory));
	if (candidates.length === 1) return candidates[0];

	for (const category of KNOWN_SESSION_DATA_DIRS) {
		const categoryIndex = relativePath.indexOf(category);
		if (categoryIndex < 0 || !store) continue;
		const candidateId = relativePath[categoryIndex + 1];
		if (!candidateId) continue;
		const legacyDirectory = relativePath.slice(0, categoryIndex).join("\\");
		const workspace = store.list().find((item) => encodeLegacyCwd(item.rootPath) === legacyDirectory);
		if (!workspace) continue;
		return {
			sourcePath: "",
			sourceDirectory: resolve(sourceRoot, legacyDirectory),
			sessionId: candidateId,
			workspace,
			targetPath: "",
			stats: file.stats,
			cwd: workspace.rootPath,
			createdAt: file.stats.birthtime.toISOString(),
		};
	}
	return undefined;
}

function isValidSessionMetadata(
	path: string,
	sessionId: string,
	workspaceId: string,
	conversationPath: string,
): boolean {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) return false;
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return (
			value.version === 1 &&
			value.sessionId === sessionId &&
			value.workspaceId === workspaceId &&
			value.conversationPath === conversationPath
		);
	} catch {
		return false;
	}
}

function ensureSessionMetadataForPlan(
	dataRoot: string,
	plan: SessionPlan,
	result: DataFrameworkSessionMigrationResult,
): boolean {
	const metadataPath = getSessionMetadataPath(dataRoot, plan.workspace.workspaceId, plan.sessionId);
	if (existsSync(metadataPath)) {
		if (isValidSessionMetadata(metadataPath, plan.sessionId, plan.workspace.workspaceId, plan.targetPath))
			return true;
		result.conflicts.push(metadataPath);
		return false;
	}

	try {
		const createdAt = plan.createdAt || plan.stats.birthtime.toISOString();
		writeSessionMetadata(metadataPath, {
			version: 1,
			sessionId: plan.sessionId,
			workspaceId: plan.workspace.workspaceId,
			cwd: plan.cwd,
			createdAt,
			updatedAt: plan.stats.mtime.toISOString(),
			conversationPath: plan.targetPath,
		});
		if (!isValidSessionMetadata(metadataPath, plan.sessionId, plan.workspace.workspaceId, plan.targetPath)) {
			result.errors.push(`目标 Session metadata 校验失败：${metadataPath}`);
			return false;
		}
		return true;
	} catch (error) {
		result.errors.push(
			`无法写入 Session metadata ${metadataPath}：${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function ensureSessionMetadataTree(
	dataRoot: string,
	targetRoot: string,
	result: DataFrameworkSessionMigrationResult,
): void {
	try {
		for (const workspaceEntry of readdirSync(targetRoot, { withFileTypes: true })) {
			if (!workspaceEntry.isDirectory() || !safeSessionId(workspaceEntry.name)) continue;
			const workspaceId = workspaceEntry.name;
			const sessionsDir = getWorkspaceSessionsDir(dataRoot, workspaceId);
			if (!existsSync(sessionsDir)) continue;
			for (const sessionEntry of readdirSync(sessionsDir, { withFileTypes: true })) {
				if (!sessionEntry.isDirectory() || !safeSessionId(sessionEntry.name)) continue;
				const sessionId = sessionEntry.name;
				const conversationDir = join(sessionsDir, sessionId, "conversation");
				let conversationEntries: Dirent[];
				try {
					conversationEntries = readdirSync(conversationDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const conversationEntry of conversationEntries) {
					if (!conversationEntry.isFile() || extname(conversationEntry.name).toLowerCase() !== ".jsonl") continue;
					const conversationPath = join(conversationDir, conversationEntry.name);
					const header = readSessionHeader(conversationPath);
					if (!header || header.id !== sessionId || header.workspaceId !== workspaceId) {
						result.errors.push(`目标 Session header 校验失败：${conversationPath}`);
						continue;
					}
					const stats = lstatSync(conversationPath);
					ensureSessionMetadataForPlan(
						dataRoot,
						{
							sourcePath: conversationPath,
							sourceDirectory: dirnameFor(conversationPath),
							sessionId,
							workspace: {
								workspaceId,
								id: workspaceId,
								name: workspaceId,
								rootPath: header.cwd || "",
								createdAt: header.timestamp ?? stats.birthtime.toISOString(),
							},
							targetPath: conversationPath,
							stats,
							cwd: header.cwd,
							createdAt: header.timestamp ?? stats.birthtime.toISOString(),
						},
						result,
					);
				}
			}
		}
	} catch (error) {
		result.errors.push(`无法补齐 Session metadata：${error instanceof Error ? error.message : String(error)}`);
	}
}

function dirnameFor(path: string): string {
	const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return separatorIndex < 0 ? "." : path.slice(0, separatorIndex);
}

function sessionDataTarget(plan: SessionPlan, file: SourceFile, dataRoot: string): string | undefined {
	const relativePath = relative(plan.sourceDirectory, file.sourcePath);
	if (!relativePath || relativePath.startsWith(`..${sep}`)) return undefined;
	return join(getSessionDir(dataRoot, plan.workspace.workspaceId, plan.sessionId), relativePath);
}

/** Migrate the current flat data/sessions tree into Workspace/Session scopes. */
export function migrateSessionsToDataFramework(
	projectRoot: string = process.cwd(),
	options: DataFrameworkSessionMigrationOptions = {},
): DataFrameworkSessionMigrationResult {
	const dataRoot = resolve(options.dataRoot ?? getDataDir(projectRoot));
	const sourceRoot = resolve(options.sourceRoot ?? join(dataRoot, "sessions"));
	const targetRoot = resolve(getWorkspacesDir(dataRoot));
	const result: DataFrameworkSessionMigrationResult = {
		sourceRoot,
		targetRoot,
		sourceExists: existsSync(sourceRoot),
		migratedFiles: 0,
		alreadyPresentFiles: 0,
		removedSourceFiles: 0,
		rewrittenPathFields: 0,
		conflicts: [],
		errors: [],
		unresolvedReferences: [],
	};

	if (pathKey(sourceRoot) === pathKey(targetRoot)) {
		result.errors.push("旧 Session 目录与 Workspace 数据目录相同，已跳过迁移。");
		return result;
	}
	if (!result.sourceExists) return result;
	let sourceStats: Stats;
	try {
		sourceStats = lstatSync(sourceRoot);
	} catch (error) {
		result.errors.push(
			`无法检查旧 Session 根目录 ${sourceRoot}：${error instanceof Error ? error.message : String(error)}`,
		);
		return result;
	}
	if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
		result.errors.push(`旧 Session 根目录不是普通目录，已跳过：${sourceRoot}`);
		return result;
	}

	const sourceFiles: SourceFile[] = [];
	collectFiles(sourceRoot, "", sourceFiles, result.errors);
	const sessionFiles = sourceFiles.filter(
		(file) =>
			extname(file.sourcePath).toLowerCase() === ".jsonl" && !file.relativePath.endsWith(LEGACY_STORAGE_MARKER_NAME),
	);
	const nonMarkerFiles = sourceFiles.filter((file) => !file.relativePath.endsWith(LEGACY_STORAGE_MARKER_NAME));
	// The default project source is a one-time migration input. Explicit source
	// roots are still allowed to drain legacy trees that were discovered after
	// the Workspace marker was written (for example the old global agent tree).
	if (hasCompletedMarker(targetRoot) && options.sourceRoot === undefined) {
		ensureSessionMetadataTree(dataRoot, targetRoot, result);
		return result;
	}
	if (sessionFiles.length === 0 && nonMarkerFiles.length === 0) {
		if (hasCompletedMarker(targetRoot)) ensureSessionMetadataTree(dataRoot, targetRoot, result);
		return result;
	}
	if (!ensureDirectory(targetRoot, result)) return result;

	const store = WorkspaceStore.create(options.agentDir ?? getAgentDir(), dataRoot);
	const sessionPlans: SessionPlan[] = [];
	for (const sourceFile of sessionFiles) {
		const header = readSessionHeader(sourceFile.sourcePath);
		if (!header || !safeSessionId(header.id)) {
			result.errors.push(`无法识别旧 Session 文件，已保留原文件：${sourceFile.sourcePath}`);
			continue;
		}
		const workspace = createOrFindWorkspace(store, header, result);
		if (!workspace) continue;
		const sourceDirectory = dirnameFor(sourceFile.sourcePath);
		sessionPlans.push({
			sourcePath: sourceFile.sourcePath,
			sourceDirectory,
			sessionId: header.id,
			workspace,
			targetPath: getSessionConversationPath(
				dataRoot,
				workspace.workspaceId,
				header.id,
				sourceFile.sourcePath.split(/[\\/]/u).pop()!,
			),
			stats: sourceFile.stats,
			cwd: header.cwd || workspace.rootPath,
			createdAt: header.timestamp ?? sourceFile.stats.birthtime.toISOString(),
		});
	}
	try {
		store.persist();
	} catch (error) {
		result.errors.push(`无法保存 Workspace 元数据：${error instanceof Error ? error.message : String(error)}`);
		return result;
	}

	const pathMap = new Map<string, string>();
	for (const plan of sessionPlans) pathMap.set(pathKey(plan.sourcePath), plan.targetPath);
	for (const sourceFile of sourceFiles) {
		if (sourceFile.relativePath.endsWith(LEGACY_STORAGE_MARKER_NAME)) continue;
		if (extname(sourceFile.sourcePath).toLowerCase() === ".jsonl") continue;
		const owner = sidecarOwner(sourceFile, sessionPlans, sourceRoot, store);
		const targetPath = owner ? sessionDataTarget(owner, sourceFile, dataRoot) : undefined;
		if (targetPath) pathMap.set(pathKey(sourceFile.sourcePath), targetPath);
	}
	const plans: FilePlan[] = [];
	for (const sourceFile of sourceFiles) {
		if (sourceFile.relativePath.endsWith(LEGACY_STORAGE_MARKER_NAME)) continue;
		let targetPath: string | undefined;
		const sessionPlan = sessionPlans.find((plan) => pathKey(plan.sourcePath) === pathKey(sourceFile.sourcePath));
		let owner: SessionPlan | undefined = sessionPlan;
		if (sessionPlan) {
			targetPath = sessionPlan.targetPath;
		} else if (extname(sourceFile.sourcePath).toLowerCase() !== ".jsonl") {
			owner = sidecarOwner(sourceFile, sessionPlans, sourceRoot, store);
			if (owner) targetPath = sessionDataTarget(owner, sourceFile, dataRoot);
		}
		if (!targetPath) {
			result.unresolvedReferences.push(sourceFile.sourcePath);
			continue;
		}

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
			owner && extname(sourceFile.sourcePath).toLowerCase() === ".jsonl"
				? rewriteJsonl(sourceBytes, owner.workspace.workspaceId, pathMap)
				: { bytes: sourceBytes, references: [], rewrittenPathFields: 0 };
		result.rewrittenPathFields += rewritten.rewrittenPathFields;
		plans.push({
			sourcePath: sourceFile.sourcePath,
			targetPath,
			sourceBytes,
			targetBytes: rewritten.bytes,
			stats: sourceFile.stats,
			references: rewritten.references,
			ownerSourcePath: owner?.sourcePath,
			status: "error",
			validTarget: false,
		});
	}

	const sessionPlanBySource = new Map(sessionPlans.map((plan) => [pathKey(plan.sourcePath), plan]));
	const planBySource = new Map(plans.map((plan) => [pathKey(plan.sourcePath), plan]));
	for (const plan of plans) {
		const sessionPlan = sessionPlanBySource.get(pathKey(plan.sourcePath));
		if (!ensureDirectory(dirnameFor(plan.targetPath), result)) continue;
		try {
			if (existsSync(plan.targetPath)) {
				const targetStats = lstatSync(plan.targetPath);
				if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
					result.conflicts.push(plan.targetPath);
					plan.status = "conflict";
					continue;
				}
				if (!sameBytes(readFileSync(plan.targetPath), plan.targetBytes)) {
					result.conflicts.push(plan.targetPath);
					plan.status = "conflict";
					continue;
				}
				plan.status = "present";
			} else {
				const temporaryPath = `${plan.targetPath}.migration-${randomUUID()}.tmp`;
				try {
					writeFileDurablySync(temporaryPath, plan.targetBytes, { flag: "wx" });
					if (existsSync(plan.targetPath)) {
						result.conflicts.push(plan.targetPath);
						plan.status = "conflict";
						continue;
					}
					renameSync(temporaryPath, plan.targetPath);
					plan.status = "copied";
				} finally {
					if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
				}
			}
			const targetBytes = readFileSync(plan.targetPath);
			plan.validTarget =
				sessionPlan !== undefined
					? validateJsonl(targetBytes, sessionPlan.sessionId, sessionPlan.workspace.workspaceId)
					: sameBytes(targetBytes, plan.targetBytes);
			if (!plan.validTarget) {
				plan.status = "error";
				result.errors.push(`目标 Session 校验失败：${plan.targetPath}`);
				continue;
			}
			utimesSync(plan.targetPath, plan.stats.atime, plan.stats.mtime);
			if (plan.status === "copied") result.migratedFiles++;
			if (plan.status === "present") result.alreadyPresentFiles++;
		} catch (error) {
			plan.status = "error";
			result.errors.push(
				`迁移 Session 文件失败 ${plan.sourcePath}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const blockedOwners = new Set<string>();
	for (const sessionPlan of sessionPlans) {
		const conversationPlan = planBySource.get(pathKey(sessionPlan.sourcePath));
		if (!conversationPlan?.validTarget || !ensureSessionMetadataForPlan(dataRoot, sessionPlan, result)) {
			blockedOwners.add(pathKey(sessionPlan.sourcePath));
		}
	}

	const blocked = new Set<FilePlan>();
	for (const plan of plans) {
		if (!plan.validTarget || (plan.ownerSourcePath && blockedOwners.has(pathKey(plan.ownerSourcePath)))) {
			blocked.add(plan);
			continue;
		}
		for (const reference of plan.references) {
			const referencedPlan = planBySource.get(pathKey(reference.sourcePath));
			if (!referencedPlan) {
				if (existsSync(reference.sourcePath)) {
					result.unresolvedReferences.push(`${plan.sourcePath} -> ${reference.targetPath}`);
					blocked.add(plan);
				}
				continue;
			}
			if (!referencedPlan.validTarget) {
				result.unresolvedReferences.push(`${plan.sourcePath} -> ${reference.targetPath}`);
				blocked.add(plan);
			}
		}
	}

	for (const plan of plans) {
		if (!plan.validTarget || blocked.has(plan)) continue;
		try {
			if (!sameBytes(readFileSync(plan.sourcePath), plan.sourceBytes)) {
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
		result.errors.length === 0 &&
		result.conflicts.length === 0 &&
		result.unresolvedReferences.length === 0 &&
		result.removedSourceFiles === plans.length &&
		plans.length === nonMarkerFiles.length
	) {
		writeCompletedMarker(targetRoot, result);
	}
	return result;
}
