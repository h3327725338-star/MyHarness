/**
 * Workspace language and project inventory.
 *
 * It answers "which languages and which projects does this workspace contain?" from facts the source
 * index already collected (file list, languages, project configuration files). Workspace-level semantic
 * queries use it to pick language servers and to report what was and was not covered. It is derived
 * data: when the scan was limited the inventory says so, and callers must not read "no hit" as "no
 * such symbol anywhere".
 */

import type { WorkspaceFacts } from "./code-index.ts";

export interface WorkspaceProject {
	readonly language: string;
	/** What defines the project, for example "tsconfig" or "cargo". */
	readonly kind: string;
	/** Workspace-relative POSIX path of the configuration file. */
	readonly configFile: string;
	/** Workspace-relative project root directory ("" for the workspace root). */
	readonly root: string;
	/**
	 * A source file of this project that is not owned by a nested project. Servers that only search the
	 * project of the document opened last (tsserver) are queried after opening it.
	 */
	readonly anchorFile?: string;
}

export interface WorkspaceInventory {
	/** Languages by file count, source languages first and data/markup languages last. */
	readonly languages: ReadonlyArray<{ readonly language: string; readonly fileCount: number }>;
	readonly projects: readonly WorkspaceProject[];
	readonly complete: boolean;
	readonly limits: readonly string[];
}

/** Languages whose "symbols" are keys and tags; they never outrank source languages for server selection. */
const DATA_LANGUAGES = new Set(["json", "yaml", "xml"]);

export function isDataLanguage(language: string): boolean {
	return DATA_LANGUAGES.has(language);
}

const TYPESCRIPT_PROJECT_MARKERS: Record<string, { language: string; kind: string }> = {
	"tsconfig.json": { language: "typescript", kind: "tsconfig" },
	"jsconfig.json": { language: "javascript", kind: "jsconfig" },
};

const OTHER_PROJECT_MARKERS: Record<string, { language: string; kind: string }> = {
	"cargo.toml": { language: "rust", kind: "cargo" },
	"go.mod": { language: "go", kind: "go-module" },
	"go.work": { language: "go", kind: "go-workspace" },
	"pyproject.toml": { language: "python", kind: "pyproject" },
	"setup.py": { language: "python", kind: "setup.py" },
	"pyrightconfig.json": { language: "python", kind: "pyright" },
	"pom.xml": { language: "java", kind: "maven" },
	"build.gradle": { language: "java", kind: "gradle" },
	"build.gradle.kts": { language: "kotlin", kind: "gradle-kotlin" },
	"compile_commands.json": { language: "cpp", kind: "compile-commands" },
	"cmakelists.txt": { language: "cpp", kind: "cmake" },
	"composer.json": { language: "php", kind: "composer" },
	gemfile: { language: "ruby", kind: "bundler" },
	"package.swift": { language: "swift", kind: "swift-package" },
};

function directoryOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return (index < 0 ? path : path.slice(index + 1)).toLowerCase();
}

function isInsideRoot(root: string, path: string): boolean {
	return root === "" || path === root || path.startsWith(`${root}/`);
}

export function buildWorkspaceInventory(facts: WorkspaceFacts): WorkspaceInventory {
	const counts = new Map<string, number>();
	for (const file of facts.files) counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
	const languages = [...counts.entries()]
		.map(([language, fileCount]) => ({ language, fileCount }))
		.sort(
			(left, right) =>
				Number(DATA_LANGUAGES.has(left.language)) - Number(DATA_LANGUAGES.has(right.language)) ||
				right.fileCount - left.fileCount ||
				left.language.localeCompare(right.language),
		);

	const normalizedFiles = facts.files.map((file) => file.path.replace(/\\/g, "/"));
	const markers = facts.markers.map((marker) => marker.replace(/\\/g, "/"));

	// TypeScript/JavaScript projects: one per tsconfig/jsconfig. A file belongs to the deepest project root.
	const tsConfigs = markers
		.map((marker) => ({ marker, info: TYPESCRIPT_PROJECT_MARKERS[baseName(marker)] }))
		.filter(
			(entry): entry is { marker: string; info: { language: string; kind: string } } => entry.info !== undefined,
		)
		.map((entry) => ({ ...entry, root: directoryOf(entry.marker) }));
	const scriptFiles = normalizedFiles.filter((path) => /\.(?:tsx?|jsx?|mjs)$/iu.test(path));
	const projects: WorkspaceProject[] = [];
	for (const config of tsConfigs) {
		const nested = tsConfigs.filter(
			(other) => other !== config && other.root !== config.root && isInsideRoot(config.root, other.root),
		);
		const owned = scriptFiles.filter(
			(path) => isInsideRoot(config.root, path) && !nested.some((other) => isInsideRoot(other.root, path)),
		);
		const preferred =
			config.info.kind === "tsconfig"
				? (owned.find((path) => /\.tsx?$/iu.test(path)) ?? owned[0])
				: (owned.find((path) => /\.(?:jsx?|mjs)$/iu.test(path)) ?? owned[0]);
		projects.push({
			language: config.info.language,
			kind: config.info.kind,
			configFile: config.marker,
			root: config.root,
			anchorFile: preferred,
		});
	}
	// Source files without any tsconfig/jsconfig live in an implicit inferred project.
	const unowned = scriptFiles.filter((path) => !tsConfigs.some((config) => isInsideRoot(config.root, path)));
	if (unowned.length > 0) {
		projects.push({
			language: unowned.some((path) => /\.tsx?$/iu.test(path)) ? "typescript" : "javascript",
			kind: "inferred",
			configFile: "",
			root: "",
			anchorFile: unowned[0],
		});
	}

	for (const marker of markers) {
		const info = OTHER_PROJECT_MARKERS[baseName(marker)];
		if (info) {
			projects.push({ language: info.language, kind: info.kind, configFile: marker, root: directoryOf(marker) });
		} else if (/\.(?:csproj|sln)$/iu.test(marker)) {
			projects.push({ language: "csharp", kind: "dotnet", configFile: marker, root: directoryOf(marker) });
		}
	}

	return {
		languages,
		projects: projects.sort(
			(left, right) => left.root.localeCompare(right.root) || left.kind.localeCompare(right.kind),
		),
		complete: facts.complete,
		limits: facts.limits,
	};
}
