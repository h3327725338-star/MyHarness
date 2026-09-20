import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { ResourceDiagnostic } from "../../extensions/contracts/diagnostics.ts";
import { resolvePath } from "../../utils/paths.ts";
import { loadThemeResourceFromPath, type ThemeResource } from "./theme-resource.ts";

export type { ThemeResource } from "./theme-resource.ts";

export interface LoadThemeResourcesOptions {
	cwd: string;
	agentDir: string;
	themePaths: string[];
	includeDefaults?: boolean;
}

export interface LoadThemeResourcesResult {
	themes: ThemeResource[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Load neutral theme JSON resources. This module intentionally does not import
 * the interactive Theme class; the frontend creates a concrete Theme only
 * after it receives these validated resources.
 */
export function loadThemeResources(options: LoadThemeResourcesOptions): LoadThemeResourcesResult {
	const themes: ThemeResource[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	const loadThemesFromDir = (dir: string): void => {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile || !entry.name.endsWith(".json")) {
					continue;
				}

				const filePath = join(dir, entry.name);
				try {
					themes.push(loadThemeResourceFromPath(filePath));
				} catch (error) {
					const message = error instanceof Error ? error.message : "failed to load theme";
					diagnostics.push({ type: "warning", message, path: filePath });
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	};

	if (options.includeDefaults ?? true) {
		loadThemesFromDir(join(resolvePath(options.agentDir), "themes"));
		loadThemesFromDir(join(resolvePath(options.cwd), CONFIG_DIR_NAME, "themes"));
	}

	for (const rawPath of options.themePaths) {
		const resolved = resolvePath(rawPath, resolvePath(options.cwd), { trim: true });
		if (!existsSync(resolved)) {
			diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
			continue;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isDirectory()) {
				loadThemesFromDir(resolved);
			} else if (stats.isFile() && resolved.endsWith(".json")) {
				themes.push(loadThemeResourceFromPath(resolved));
			} else {
				diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme path";
			diagnostics.push({ type: "warning", message, path: resolved });
		}
	}

	return { themes, diagnostics };
}

export function dedupeThemeResources(themes: ThemeResource[]): LoadThemeResourcesResult {
	const seen = new Map<string, ThemeResource>();
	const diagnostics: ResourceDiagnostic[] = [];

	for (const theme of themes) {
		const name = theme.name ?? "unnamed";
		const existing = seen.get(name);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `name "${name}" collision`,
				path: theme.sourcePath,
				collision: {
					resourceType: "theme",
					name,
					winnerPath: existing.sourcePath ?? "<builtin>",
					loserPath: theme.sourcePath ?? "<builtin>",
				},
			});
		} else {
			seen.set(name, theme);
		}
	}

	return { themes: Array.from(seen.values()), diagnostics };
}
