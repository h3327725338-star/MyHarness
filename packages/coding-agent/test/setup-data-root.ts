import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const DATA_ROOT_PREFIX = `myharness-vitest-data-${process.pid}-`;
const ANY_DATA_ROOT_PREFIX = "myharness-vitest-data-";
const OWNER_MARKER = ".myharness-vitest-owner.json";
const DATA_ROOT_STATE_KEY = "__myharnessVitestDataRootState";

interface DataRootState {
	ownedRoot?: string;
	cleanupRegistered: boolean;
}

const globalState = globalThis as typeof globalThis & {
	[DATA_ROOT_STATE_KEY]?: DataRootState;
};
const state = globalState[DATA_ROOT_STATE_KEY] ?? { cleanupRegistered: false };
globalState[DATA_ROOT_STATE_KEY] = state;

function cleanupOwnedRoot(): void {
	const root = state.ownedRoot;
	state.ownedRoot = undefined;
	if (!root) return;

	try {
		const resolvedRoot = resolve(root);
		const resolvedTempDir = resolve(tmpdir());
		const relativeRoot = relative(resolvedTempDir, resolvedRoot);
		if (
			!relativeRoot ||
			isAbsolute(relativeRoot) ||
			relativeRoot === ".." ||
			relativeRoot.startsWith(`..${sep}`) ||
			basename(resolvedRoot) !== basename(root) ||
			!basename(resolvedRoot).startsWith(DATA_ROOT_PREFIX)
		) {
			return;
		}

		const stats = lstatSync(resolvedRoot);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return;
		rmSync(resolvedRoot, { recursive: true, force: true });
	} catch {
		// Cleanup is best-effort. A failed or interrupted test must never make the
		// runner fail again, and an uncertain path is intentionally left untouched.
	}
}

function isProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM still means that the process exists; never remove a live owner's
		// directory merely because this process cannot signal it.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function cleanupStaleOwnedRoots(): void {
	try {
		for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith(ANY_DATA_ROOT_PREFIX)) continue;

			const root = join(tmpdir(), entry.name);
			const markerPath = join(root, OWNER_MARKER);
			let owner: { pid?: unknown; root?: unknown };
			try {
				const stats = lstatSync(root);
				if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
				owner = JSON.parse(readFileSync(markerPath, "utf8")) as { pid?: unknown; root?: unknown };
			} catch {
				// Historical directories and incomplete test roots have no ownership
				// marker and are intentionally left untouched.
				continue;
			}

			if (
				typeof owner.pid !== "number" ||
				!Number.isSafeInteger(owner.pid) ||
				typeof owner.root !== "string" ||
				resolve(owner.root) !== resolve(root) ||
				isProcessAlive(owner.pid)
			) {
				continue;
			}
			rmSync(root, { recursive: true, force: true });
		}
	} catch {
		// Stale cleanup is opportunistic and must never make a test run fail.
	}
}

if (!state.cleanupRegistered) {
	state.cleanupRegistered = true;
	process.once("exit", cleanupOwnedRoot);
}

// Default Workspace/Session storage is project-local. Tests that intentionally
// provide dataRoot still bypass this setting, while default-storage tests get an
// isolated root instead of registering temporary fixture directories in the
// repository's data/workspaces registry.
if (!process.env.MYHARNESS_DATA_ROOT) {
	cleanupStaleOwnedRoots();
	state.ownedRoot ??= mkdtempSync(join(tmpdir(), DATA_ROOT_PREFIX));
	process.env.MYHARNESS_DATA_ROOT = state.ownedRoot;
	try {
		writeFileSync(
			join(state.ownedRoot, OWNER_MARKER),
			JSON.stringify({ pid: process.pid, root: resolve(state.ownedRoot) }),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
	} catch {
		// Direct process-exit cleanup still applies when the marker cannot be made.
	}
}
