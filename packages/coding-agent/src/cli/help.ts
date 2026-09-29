/**
 * Top-level CLI help output. Keep it in sync with args.ts; cli-help.test.ts
 * fails if an advertised flag is not accepted by parseArgs.
 */

import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";

export interface CliHelpOption {
	/** Flag forms and their value placeholder, e.g. "-n, --name <name>". */
	flags: string;
	description: string;
}

export interface CliHelpSection {
	title: string;
	options: readonly CliHelpOption[];
}

export const CLI_HELP_SECTIONS: readonly CliHelpSection[] = [
	{
		title: "General",
		options: [
			{ flags: "-h, --help", description: "Show this help and exit" },
			{ flags: "-v, --version", description: "Show version and exit" },
		],
	},
	{
		title: "Modes",
		options: [
			{ flags: "-p, --print [message]", description: "Print response and exit (also reads piped stdin)" },
			{ flags: "--mode <text|json>", description: "Output mode (default: text in print mode)" },
			{ flags: "--web", description: "Start the local Web UI (loopback only) instead of the terminal UI" },
			{ flags: "--port <n>", description: "Web UI port (default 7878; 0 picks a free port)" },
			{ flags: "--no-open", description: "Do not open the browser automatically in Web UI mode" },
			{ flags: "--export <file>", description: "Export a session file to HTML and exit" },
		],
	},
	{
		title: "Model",
		options: [
			{ flags: "--provider <name>", description: "Provider id (e.g. anthropic, or a custom provider)" },
			{ flags: "--model <pattern>", description: "Model id or pattern (supports provider/id and :thinking)" },
			{ flags: "--api-key <key>", description: "Runtime API key override (requires --model)" },
			{
				flags: "--thinking <level>",
				description: "Thinking level: off, minimal, low, medium, high, xhigh, max",
			},
			{ flags: "--models <patterns>", description: "Comma-separated model scope for cycling" },
			{ flags: "--list-models [search]", description: "List available models and exit" },
			{ flags: "--context-window <size>", description: "Context window override (e.g. 256K)" },
		],
	},
	{
		title: "Session",
		options: [
			{ flags: "-c, --continue", description: "Continue the most recent session" },
			{ flags: "-r, --resume", description: "Browse and select a session" },
			{ flags: "--session <path|id>", description: "Use a specific session file or partial id" },
			{ flags: "--session-id <id>", description: "Use an exact project session id, creating it if missing" },
			{ flags: "--fork <path|id>", description: "Fork a session into a new one" },
			{ flags: "--session-dir <dir>", description: "Custom session storage directory" },
			{ flags: "--no-session", description: "Ephemeral mode: do not persist the session" },
			{ flags: "-n, --name <name>", description: "Set the session display name at startup" },
		],
	},
	{
		title: "Tools",
		options: [
			{ flags: "-t, --tools <list>", description: "Allowlist tool names (built-in, extension, custom)" },
			{ flags: "-xt, --exclude-tools <list>", description: "Disable specific tool names" },
			{ flags: "-nbt, --no-builtin-tools", description: "Disable built-in tools but keep extension/custom tools" },
			{ flags: "-nt, --no-tools", description: "Disable all tools" },
		],
	},
	{
		title: "Resources",
		options: [
			{ flags: "-e, --extension <source>", description: "Load an extension from path, npm, or git (repeatable)" },
			{ flags: "-ne, --no-extensions", description: "Disable extension discovery" },
			{ flags: "--skill <path>", description: "Load a skill (repeatable)" },
			{ flags: "-ns, --no-skills", description: "Disable skill discovery" },
			{ flags: "--prompt-template <path>", description: "Load a prompt template (repeatable)" },
			{ flags: "-np, --no-prompt-templates", description: "Disable prompt template discovery" },
			{ flags: "--theme <path>", description: "Load a theme (repeatable)" },
			{ flags: "--no-themes", description: "Disable theme discovery" },
			{ flags: "-nc, --no-context-files", description: "Disable AGENTS.md / CLAUDE.md discovery" },
		],
	},
	{
		title: "Other",
		options: [
			{ flags: "--system-prompt <text>", description: "Append custom instructions to the system prompt" },
			{ flags: "--append-system-prompt <text>", description: "Append text to the system prompt" },
			{ flags: "--agent-role <main|delegated|reviewer>", description: "Internal agent role override" },
			{ flags: "--verbose", description: "Force verbose startup output" },
			{ flags: "--offline", description: "Disable startup network operations" },
			{ flags: "-a, --approve", description: "Trust project-local files for this run" },
			{ flags: "-na, --no-approve", description: "Ignore project-local files for this run" },
		],
	},
];

const CLI_HELP_INPUT = `Input:
  @file...      Include file contents in the initial message
  message...    Initial message; remaining arguments are queued as follow-ups

Package commands (run "${APP_NAME} <command> --help" for details):
  ${APP_NAME} install|remove|update|list [...]
  ${APP_NAME} config [-l]   Edit settings and package resources

Project settings live in ${CONFIG_DIR_NAME}/settings.json; global settings in
~/${CONFIG_DIR_NAME}/agent/settings.json.`;

/** Render the full top-level help text. */
export function renderCliHelp(): string {
	const sections = CLI_HELP_SECTIONS.map((section) => {
		const lines = section.options.map((option) => {
			const padding = " ".repeat(Math.max(2, 34 - option.flags.length));
			return `  ${option.flags}${padding}${option.description}`;
		});
		return `${section.title}:\n${lines.join("\n")}`;
	});

	return [`Usage: ${APP_NAME} [options] [@files...] [messages...]`, "", ...sections, "", CLI_HELP_INPUT].join("\n");
}

/**
 * Long flags advertised by the help text (without the leading `--`).
 * Used by tests to keep the help listing and `parseArgs` in sync.
 */
export function listCliHelpFlags(): string[] {
	const flags = new Set<string>();
	for (const section of CLI_HELP_SECTIONS) {
		for (const option of section.options) {
			for (const token of option.flags.split(/[,\s]+/)) {
				if (token.startsWith("--")) {
					flags.add(token.slice(2));
				}
			}
		}
	}
	return [...flags];
}
