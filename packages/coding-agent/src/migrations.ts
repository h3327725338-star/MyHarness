/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { getSessionsDir } from "./config/paths/index.ts";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir, getDataDir } from "./config.ts";
import {
	migrateWorkspaceRegistry,
	type WorkspaceRegistryMigrationResult,
} from "./data/workspace-registry-migration.ts";
import {
	type DataFrameworkSessionMigrationResult,
	migrateSessionsToDataFramework,
} from "./session/migrations/data-framework.ts";
import { cleanupEmptySessionDirectories } from "./session/storage/jsonl/index.ts";
import { cleanupStaleAtomicWriteTemps } from "./utils/atomic-write.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/h3327725338-star/MyHarness/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * Migrate sessions from ~/.myharness/agent/*.jsonl into the old global
 * sessions tree so the Workspace Data Framework can import them directly.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.myharness/agent/ instead of
 * ~/.myharness/agent/sessions/<encoded-cwd>/. This compatibility migration
 * moves them into the project data tree based on the cwd in their header.
 *
 * See: https://github.com/h3327725338-star/MyHarness/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by MyHarness, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log();
}

const LEGACY_STORAGE_MARKER_NAME = ".legacy-session-storage-migrated.json";
const LEGACY_STORAGE_MARKER_VERSION = 2;

function mergeDataFrameworkMigrationResults(
	results: DataFrameworkSessionMigrationResult[],
): DataFrameworkSessionMigrationResult {
	const first = results[0]!;
	return {
		sourceRoot: results.map((result) => result.sourceRoot).join("; "),
		targetRoot: first.targetRoot,
		sourceExists: results.some((result) => result.sourceExists),
		migratedFiles: results.reduce((total, result) => total + result.migratedFiles, 0),
		alreadyPresentFiles: results.reduce((total, result) => total + result.alreadyPresentFiles, 0),
		removedSourceFiles: results.reduce((total, result) => total + result.removedSourceFiles, 0),
		rewrittenPathFields: results.reduce((total, result) => total + result.rewrittenPathFields, 0),
		conflicts: results.flatMap((result) => result.conflicts),
		errors: results.flatMap((result) => result.errors),
		unresolvedReferences: results.flatMap((result) => result.unresolvedReferences),
	};
}

function hasCompletedLegacyStorageMarker(root: string): boolean {
	const markerPath = join(root, LEGACY_STORAGE_MARKER_NAME);
	try {
		const stats = lstatSync(markerPath);
		if (stats.isSymbolicLink() || !stats.isFile()) return false;
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: unknown };
		return marker.version === LEGACY_STORAGE_MARKER_VERSION;
	} catch {
		return false;
	}
}

/**
 * Remove only the retired project-local flat Session root. The source must
 * contain its completed marker and empty directories only; any file, lock,
 * link, or special entry keeps the root intact.
 */
function removeRetiredLegacySessionRoot(root: string, migration: DataFrameworkSessionMigrationResult): boolean {
	if (
		!migration.sourceExists ||
		migration.errors.length > 0 ||
		migration.conflicts.length > 0 ||
		migration.unresolvedReferences.length > 0 ||
		!hasCompletedLegacyStorageMarker(root)
	) {
		return false;
	}

	const resolvedRoot = root;
	const removableDirectories: string[] = [];
	const markerPath = join(resolvedRoot, LEGACY_STORAGE_MARKER_NAME);
	const inspect = (directory: string): boolean => {
		let directoryStats: Stats;
		try {
			directoryStats = lstatSync(directory);
		} catch {
			return false;
		}
		if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return false;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			const childPath = join(directory, entry.name);
			let childStats: Stats;
			try {
				childStats = lstatSync(childPath);
			} catch {
				return false;
			}
			if (childStats.isSymbolicLink()) return false;
			if (childStats.isDirectory()) {
				if (entry.name.toLowerCase().endsWith(".lock") || !inspect(childPath)) return false;
				continue;
			}
			if (childPath !== markerPath || !childStats.isFile()) return false;
		}
		removableDirectories.push(directory);
		return true;
	};

	if (!inspect(resolvedRoot)) return false;
	const markerContents = readFileSync(markerPath);
	try {
		// Remove child directories first. The root itself still contains the marker,
		// so it is removed only after the marker is unlinked below.
		for (const directory of removableDirectories) {
			if (directory !== resolvedRoot) rmdirSync(directory);
		}
		unlinkSync(markerPath);
		try {
			rmdirSync(resolvedRoot);
		} catch (error) {
			// A concurrent entry or transient filesystem failure must not leave an
			// otherwise recognizable legacy root permanently unmarked.
			try {
				writeFileSync(markerPath, markerContents, { flag: "wx" });
			} catch {
				// Keep the original removal error as the observable result.
			}
			throw error;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	dataFrameworkSessionMigration: DataFrameworkSessionMigrationResult;
	workspaceRegistryMigration: WorkspaceRegistryMigrationResult;
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	const dataRoot = getDataDir(cwd);
	cleanupStaleAtomicWriteTemps(dataRoot);
	const projectLegacyRoot = getSessionsDir(cwd);
	const legacySourceRoots = [projectLegacyRoot, join(getAgentDir(), "sessions")].filter(
		(sourceRoot, index, roots) =>
			roots.findIndex((candidate) => candidate.toLowerCase() === sourceRoot.toLowerCase()) === index,
	);
	const sourceResults = legacySourceRoots.map((sourceRoot) =>
		migrateSessionsToDataFramework(cwd, { sourceRoot, dataRoot, agentDir: getAgentDir() }),
	);
	const dataFrameworkSessionMigration = mergeDataFrameworkMigrationResults(sourceResults);
	const workspaceRegistryMigration = migrateWorkspaceRegistry(dataRoot, { agentDir: getAgentDir() });
	removeRetiredLegacySessionRoot(projectLegacyRoot, sourceResults[0]!);
	cleanupEmptySessionDirectories(dataRoot);
	migrateToolsToBin();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return {
		migratedAuthProviders,
		dataFrameworkSessionMigration,
		workspaceRegistryMigration,
		deprecationWarnings,
	};
}
