import { existsSync, statSync } from "node:fs";
import { win32 as windowsPath } from "node:path";

export type ExecutableDiscoverySource = "absolute" | "workspace-bin" | "path" | "unavailable";

export interface ExecutableDiscoveryResult {
	readonly command: string;
	readonly discovered: boolean;
	readonly resolvedPath?: string;
	readonly source: ExecutableDiscoverySource;
}

function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		return true;
	} catch {
		return false;
	}
}

function windowsExtensions(): readonly string[] {
	const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	return [
		"",
		...raw
			.split(";")
			.map((value) => value.trim())
			.filter(Boolean),
	];
}

function candidateNames(command: string): readonly string[] {
	const lower = command.toLowerCase();
	if (windowsExtensions().some((extension) => extension && lower.endsWith(extension.toLowerCase()))) return [command];
	return windowsExtensions().map((extension) => `${command}${extension}`);
}

function resolveCandidate(candidate: string): string | undefined {
	for (const name of candidateNames(candidate)) {
		if (isExecutable(name)) return windowsPath.resolve(name);
	}
	return undefined;
}

/**
 * Discover an executable without invoking a shell, package manager, network,
 * or child process. Workspace-local binaries are checked before PATH and only
 * for the current workspace; parent-directory traversal is intentionally not
 * performed.
 */
export function discoverExecutable(command: string, workspaceRoot: string): ExecutableDiscoveryResult {
	const trimmed = command.trim();
	if (!trimmed) return { command, discovered: false, source: "unavailable" };

	if (windowsPath.isAbsolute(trimmed)) {
		const resolvedPath = resolveCandidate(trimmed);
		return resolvedPath
			? { command, discovered: true, resolvedPath, source: "absolute" }
			: { command, discovered: false, source: "unavailable" };
	}

	const localBase = windowsPath.join(windowsPath.resolve(workspaceRoot), "node_modules", ".bin", trimmed);
	const localPath = resolveCandidate(localBase);
	if (localPath) return { command, discovered: true, resolvedPath: localPath, source: "workspace-bin" };

	const pathEntries = (process.env.PATH ?? "").split(";");
	for (const entry of pathEntries) {
		if (!entry) continue;
		const resolvedPath = resolveCandidate(windowsPath.join(entry, trimmed));
		if (resolvedPath) return { command, discovered: true, resolvedPath, source: "path" };
	}
	return { command, discovered: false, source: "unavailable" };
}

/** Read-only helper used by tests and runtime status. */
export function isExplicitExecutablePath(command: string): boolean {
	return windowsPath.isAbsolute(command) || existsSync(command);
}
