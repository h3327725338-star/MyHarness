import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CodeIntelligenceSettings, LanguageServerConfiguration } from "../../config/settings/index.ts";
import { LanguageServerRegistry } from "../lsp/language-server/registry.ts";

export const BUNDLED_CODE_INTELLIGENCE_VERSION = "0.4.0";
export const BUNDLED_NODE_VERSION = "22.19.0";

export type BundledServerKind = "node-package" | "native-binary" | "portable-ruby";

export interface BundledServerCatalogEntry {
	readonly id: string;
	readonly key: string;
	readonly languages: readonly string[];
	readonly server: string;
	readonly version: string;
	readonly license: string;
	readonly kind: BundledServerKind;
	readonly packageName?: string;
	readonly marker: readonly string[];
	readonly distribution: "bundled" | "external-prerequisites-required";
	readonly notes?: string;
}

/**
 * The single source of truth for the private Windows language-server bundle.
 * A catalog entry is only registered when its marker exists inside the bundle.
 */
export const BUNDLED_SERVER_CATALOG: readonly BundledServerCatalogEntry[] = Object.freeze([
	{
		id: "managed-typescript-language-server",
		key: "typescript-language-server",
		languages: ["typescript", "javascript"],
		server: "typescript-language-server",
		version: "5.3.0",
		license: "Apache-2.0",
		kind: "node-package",
		packageName: "typescript-language-server",
		marker: ["node_modules", "typescript-language-server", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-pyright",
		key: "pyright",
		languages: ["python"],
		server: "Pyright",
		version: "1.1.413",
		license: "MIT",
		kind: "node-package",
		packageName: "pyright",
		marker: ["node_modules", "pyright", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-vscode-json",
		key: "vscode-json",
		languages: ["json"],
		server: "vscode-json-language-server",
		version: "4.10.0",
		license: "MIT",
		kind: "node-package",
		packageName: "vscode-langservers-extracted",
		marker: ["node_modules", "vscode-langservers-extracted", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-vscode-css",
		key: "vscode-css",
		languages: ["scss"],
		server: "vscode-css-language-server",
		version: "4.10.0",
		license: "MIT",
		kind: "node-package",
		packageName: "vscode-langservers-extracted",
		marker: ["node_modules", "vscode-langservers-extracted", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-bash",
		key: "bash-language-server",
		languages: ["shell"],
		server: "bash-language-server",
		version: "5.6.0",
		license: "MIT",
		kind: "node-package",
		packageName: "bash-language-server",
		marker: ["node_modules", "bash-language-server", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-svelte",
		key: "svelte-language-server",
		languages: ["svelte"],
		server: "svelte-language-server",
		version: "0.18.4",
		license: "MIT",
		kind: "node-package",
		packageName: "svelte-language-server",
		marker: ["node_modules", "svelte-language-server", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-vue",
		key: "vue-language-server",
		languages: ["vue"],
		server: "@vue/language-server",
		version: "3.3.11",
		license: "MIT",
		kind: "node-package",
		packageName: "@vue/language-server",
		marker: ["node_modules", "@vue", "language-server", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-yaml",
		key: "yaml-language-server",
		languages: ["yaml"],
		server: "yaml-language-server",
		version: "1.24.0",
		license: "MIT",
		kind: "node-package",
		packageName: "yaml-language-server",
		marker: ["node_modules", "yaml-language-server", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-php",
		key: "devsense-php-ls",
		languages: ["php"],
		server: "Devsense PHP Language Server",
		version: "1.0.19264",
		license: "ISC package license; bundled binary license must be retained",
		kind: "node-package",
		packageName: "devsense-php-ls",
		marker: ["node_modules", "devsense-php-ls", "package.json"],
		distribution: "bundled",
		notes: "The package and platform binary are separately audited during packaging.",
	},
	{
		id: "managed-sql",
		key: "sqllens-language-server",
		languages: ["sql"],
		server: "sqllens-language-server",
		version: "0.5.0",
		license: "MIT",
		kind: "node-package",
		packageName: "sqllens-language-server",
		marker: ["node_modules", "sqllens-language-server", "package.json"],
		distribution: "bundled",
	},
	{
		id: "managed-clangd",
		key: "clangd",
		languages: ["c", "cpp"],
		server: "clangd",
		version: "22.1.0",
		license: "Apache-2.0 with LLVM exceptions",
		kind: "native-binary",
		marker: ["servers", "clangd", "clangd.exe"],
		distribution: "bundled",
	},
	{
		id: "managed-jdtls",
		key: "jdtls",
		languages: ["java"],
		server: "Eclipse JDT Language Server",
		version: "1.51.0",
		license: "EPL-2.0",
		kind: "native-binary",
		marker: ["servers", "jdtls", "plugins"],
		distribution: "bundled",
		notes: "Runs on the bundled Temurin JRE and keeps JDT workspace data in the private data root.",
	},
	{
		id: "managed-rust-analyzer",
		key: "rust-analyzer",
		languages: ["rust"],
		server: "rust-analyzer",
		version: "2026-09-07",
		license: "MIT OR Apache-2.0",
		kind: "native-binary",
		marker: ["servers", "rust-analyzer", "rust-analyzer.exe"],
		distribution: "bundled",
		notes: "Full project semantics also require the matching private Rust sysroot.",
	},
	{
		id: "managed-gopls",
		key: "gopls",
		languages: ["go"],
		server: "gopls",
		version: "v0.23.0",
		license: "BSD-3-Clause",
		kind: "native-binary",
		marker: ["servers", "go-1.27.1", "gopls.exe"],
		distribution: "bundled",
		notes: "Runs with the matching private Go distribution.",
	},
	{
		id: "managed-csharp",
		key: "csharp-ls",
		languages: ["csharp"],
		server: "csharp-ls",
		version: "0.26.0",
		license: "MIT",
		kind: "native-binary",
		marker: ["servers", "csharp-ls", "csharp-ls.exe"],
		distribution: "bundled",
		notes: "Runs from the private .NET SDK/tool root.",
	},
	{
		id: "managed-kotlin",
		key: "kotlin-language-server",
		languages: ["kotlin"],
		server: "Kotlin Language Server",
		version: "1.3.9",
		license: "Apache-2.0",
		kind: "native-binary",
		marker: ["servers", "kotlin", "server", "bin", "kotlin-language-server.bat"],
		distribution: "bundled",
		notes: "Runs on the bundled Temurin JRE.",
	},
	{
		id: "managed-ruby",
		key: "solargraph",
		languages: ["ruby"],
		server: "Solargraph",
		version: "0.60.3",
		license: "MIT; Ruby runtime licenses retained in the installed module",
		kind: "portable-ruby",
		marker: ["servers", "ruby", "bin", "ruby.exe"],
		distribution: "bundled",
		notes: "Uses only the private Ruby runtime and gem path.",
	},
	{
		id: "managed-xml",
		key: "lemminx",
		languages: ["xml"],
		server: "Eclipse LemMinX",
		version: "0.31.0",
		license: "EPL-2.0",
		kind: "native-binary",
		marker: ["servers", "lemminx", "lemminx.jar"],
		distribution: "bundled",
		notes: "Runs on the bundled Temurin JRE.",
	},
	{
		id: "managed-swift",
		key: "sourcekit-lsp",
		languages: ["swift"],
		server: "SourceKit-LSP",
		version: "swift-6.3.3",
		license: "Apache-2.0",
		kind: "native-binary",
		marker: ["servers", "swift", "usr", "bin", "sourcekit-lsp.exe"],
		distribution: "external-prerequisites-required",
		notes: "Not bundled on Windows: the official distribution requires external MSVC, Windows SDK, Python, Git and Developer Mode prerequisites.",
	},
]);

export interface BundledCodeIntelligencePaths {
	readonly root: string;
	readonly runtimeRoot: string;
	readonly serversRoot: string;
	readonly nodeExecutable: string;
	readonly launcherPath: string;
}

function isBundleRoot(root: string): boolean {
	return (
		existsSync(path.join(root, "runtime", "node.exe")) &&
		existsSync(path.join(root, "runtime", "lsp-launcher.mjs")) &&
		existsSync(path.join(root, "runtime", "servers"))
	);
}

/** Resolve only project/package-local candidates. The Codex plugin cache is intentionally never searched. */
export function findBundledCodeIntelligenceRoot(moduleUrl: string = import.meta.url): string | undefined {
	const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
	const executableDirectories = [
		path.dirname(process.execPath),
		...(process.argv[1] ? [path.dirname(path.resolve(process.argv[1]))] : []),
	];
	const configuredRoot = process.env.MYHARNESS_CODE_INTELLIGENCE_ROOT?.trim();
	const candidates = [
		...(configuredRoot ? [path.resolve(configuredRoot)] : []),
		path.resolve(moduleDirectory, "../../../../code-intelligence"),
		path.resolve(moduleDirectory, "../../../../dist/code-intelligence"),
		path.resolve(moduleDirectory, "../bundled"),
		...executableDirectories.map((directory) => path.resolve(directory, "code-intelligence")),
		path.resolve(process.cwd(), "packages/coding-agent/code-intelligence"),
		path.resolve(process.cwd(), "code-intelligence"),
		path.resolve(process.cwd(), "dist/code-intelligence"),
	];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const normalized = path.resolve(candidate);
		const identity = normalized.toLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		if (isBundleRoot(normalized)) return normalized;
	}
	return undefined;
}

export function getBundledCodeIntelligencePaths(root: string): BundledCodeIntelligencePaths | undefined {
	const normalizedRoot = path.resolve(root);
	if (!isBundleRoot(normalizedRoot)) return undefined;
	const runtimeRoot = path.join(normalizedRoot, "runtime");
	return Object.freeze({
		root: normalizedRoot,
		runtimeRoot,
		serversRoot: path.join(runtimeRoot, "servers"),
		nodeExecutable: path.join(runtimeRoot, "node.exe"),
		launcherPath: path.join(runtimeRoot, "lsp-launcher.mjs"),
	});
}

export function isBundledServerAvailable(entry: BundledServerCatalogEntry, root: string): boolean {
	return existsSync(path.join(root, "runtime", ...entry.marker));
}

function normalizeList(values: readonly string[] | undefined): string[] | undefined {
	if (values === undefined) return undefined;
	return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function configuredServer(
	registry: LanguageServerRegistry,
	id: string,
	config: LanguageServerConfiguration,
	disabledLanguages: ReadonlySet<string>,
): void {
	if (config.enabled === false) return;
	const languages = normalizeList(config.languages);
	if (!languages || languages.length === 0) {
		throw new Error(`configured language server "${id}" must declare at least one language`);
	}
	const command = config.command.trim();
	if (!command) throw new Error(`configured language server "${id}" command must not be empty`);
	const filteredLanguages = languages.filter((language) => !disabledLanguages.has(language));
	if (filteredLanguages.length === 0) return;
	const priority = config.priority ?? 1000;
	if (!Number.isFinite(priority)) throw new Error(`configured language server "${id}" priority must be finite`);
	registry.register({
		id,
		languages: filteredLanguages,
		command,
		args: config.args ?? [],
		priority,
		env: config.env,
		configured: true,
	});
}

export interface BundledLanguageServerRegistryOptions {
	readonly root?: string;
	readonly moduleUrl?: string;
	readonly dataRoot?: string;
}

/**
 * Build the private registry used by normal runtime construction. An absent
 * bundle returns undefined so a source checkout can still use the legacy
 * built-in registry until its distribution assets are staged.
 */
export function createBundledLanguageServerRegistry(
	settings: CodeIntelligenceSettings = {},
	options: BundledLanguageServerRegistryOptions = {},
): LanguageServerRegistry | undefined {
	const root = options.root ?? findBundledCodeIntelligenceRoot(options.moduleUrl);
	if (!root) return undefined;
	const paths = getBundledCodeIntelligencePaths(root);
	if (!paths) return undefined;

	const registry = new LanguageServerRegistry();
	const disabledLanguages = new Set(normalizeList(settings.disabledLanguages) ?? []);
	const configured = settings.servers ?? {};
	const dataRoot = options.dataRoot ?? path.join(paths.root, "data");

	for (const entry of BUNDLED_SERVER_CATALOG) {
		if (configured[entry.id] !== undefined) continue;
		const languages = entry.languages.filter((language) => !disabledLanguages.has(language));
		if (languages.length === 0 || !isBundledServerAvailable(entry, paths.root)) continue;
		registry.register({
			id: entry.id,
			languages,
			command: paths.nodeExecutable,
			args: [paths.launcherPath, entry.key],
			priority: 200,
			configured: true,
			env: {
				MYHARNESS_CODE_INTELLIGENCE_ROOT: paths.root,
				MYHARNESS_SYMBOLS_DATA_ROOT: dataRoot,
			},
			clientInfo: { name: "myharness-symbols", version: BUNDLED_CODE_INTELLIGENCE_VERSION },
		});
	}

	for (const [id, config] of Object.entries(configured)) {
		configuredServer(registry, id, config, disabledLanguages);
	}

	return registry;
}
