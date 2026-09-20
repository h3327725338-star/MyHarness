import type { CodeIntelligenceSettings, LanguageServerConfiguration } from "../../config/settings/index.ts";
import { LanguageServerRegistry } from "../lsp/language-server/registry.ts";

/**
 * Built-in definitions are deliberately just executable descriptions. The
 * runtime never downloads or installs these programs.
 */
const BUILTIN_SERVERS: ReadonlyArray<{
	id: string;
	command: string;
	args: readonly string[];
	languages: readonly string[];
}> = [
	{
		id: "builtin-typescript-language-server",
		command: "typescript-language-server",
		args: ["--stdio"],
		languages: ["typescript", "javascript"],
	},
	{ id: "builtin-pyright-langserver", command: "pyright-langserver", args: ["--stdio"], languages: ["python"] },
	{ id: "builtin-clangd", command: "clangd", args: [], languages: ["c", "cpp"] },
	{ id: "builtin-jdtls", command: "jdtls", args: [], languages: ["java"] },
	{ id: "builtin-rust-analyzer", command: "rust-analyzer", args: [], languages: ["rust"] },
	{ id: "builtin-gopls", command: "gopls", args: ["serve"], languages: ["go"] },
];

function normalizeList(values: readonly string[] | undefined): string[] | undefined {
	if (values === undefined) return undefined;
	return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function normalizedConfiguration(config: LanguageServerConfiguration): {
	command: string;
	args: readonly string[];
	languages: readonly string[];
	priority: number;
	env?: Readonly<Record<string, string>>;
} {
	const languages = normalizeList(config.languages);
	if (!languages || languages.length === 0) {
		throw new Error("configured language server must declare at least one language");
	}
	if (typeof config.command !== "string" || config.command.trim() === "") {
		throw new Error("configured language server command must not be empty");
	}
	const priority = config.priority ?? 1000;
	if (!Number.isFinite(priority)) throw new Error("configured language server priority must be finite");
	return {
		command: config.command,
		args: [...(config.args ?? [])],
		languages,
		priority,
		env: config.env === undefined ? undefined : { ...config.env },
	};
}

/** Create the immutable registry used by a normal AgentSession runtime. */
export function createBuiltInLanguageServerRegistry(settings: CodeIntelligenceSettings = {}): LanguageServerRegistry {
	const registry = new LanguageServerRegistry();
	const disabledLanguages = new Set(normalizeList(settings.disabledLanguages) ?? []);
	const configured = settings.servers ?? {};

	for (const server of BUILTIN_SERVERS) {
		if (configured[server.id] !== undefined) {
			// A configured built-in id fully takes over the built-in definition (first
			// loop) and an explicit enabled:false is skipped (second loop), so the
			// server silently disappears. Keep the disable visible instead.
			if (configured[server.id]?.enabled === false) {
				console.warn(
					`[code-intelligence] built-in language server "${server.id}" is disabled by configuration; ` +
						`languages ${server.languages.join(", ")} will have no semantic support`,
				);
			}
			continue;
		}
		const languages = server.languages.filter((language) => !disabledLanguages.has(language));
		if (languages.length === 0) continue;
		registry.register({
			id: server.id,
			command: server.command,
			args: server.args,
			languages,
			priority: 0,
			configured: false,
		});
	}

	for (const [id, rawConfig] of Object.entries(configured)) {
		if (rawConfig.enabled === false) continue;
		const config = normalizedConfiguration(rawConfig);
		const languages = config.languages.filter((language) => !disabledLanguages.has(language));
		if (languages.length === 0) continue;
		registry.register({
			id,
			command: config.command,
			args: config.args,
			languages,
			priority: config.priority,
			env: config.env,
			configured: true,
		});
	}

	return registry;
}
