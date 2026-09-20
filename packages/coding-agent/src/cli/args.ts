/**
 * CLI argument parsing
 */

import type { ThinkingLevel } from "@myharness/agent-core";
import type { AgentRole } from "../agent/runtime/role.ts";
import { parseContextWindowInput } from "../context/context-window.ts";

export type Mode = "text" | "json";

export interface Args {
	agentRole?: AgentRole;
	provider?: string;
	model?: string;
	contextWindow?: number;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	version?: boolean;
	help?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Core flags that consume the following argument as their value. */
const VALUE_FLAGS = new Set([
	"provider",
	"model",
	"context-window",
	"api-key",
	"system-prompt",
	"append-system-prompt",
	"agent-role",
	"name",
	"session",
	"session-id",
	"fork",
	"session-dir",
	"models",
	"tools",
	"exclude-tools",
	"thinking",
	"export",
	"extension",
	"skill",
	"prompt-template",
	"theme",
	"mode",
]);

/** Short forms of value-taking flags, for "requires a value" diagnostics. */
const SHORT_VALUE_FLAGS = new Set(["n", "t", "xt", "e"]);

/**
 * Expand a `--flag=value` token in place, but only for known value-taking
 * flags and only at the position being parsed. A token already consumed as a
 * preceding flag's value is never rewritten, so values like
 * `--system-prompt --foo=bar` stay verbatim. Unknown/extension flags keep the
 * pre-existing equals handling.
 */
function expandInlineValueFlag(args: string[], index: number): string {
	const arg = args[index];
	if (!arg.startsWith("--")) return arg;
	const eqIndex = arg.indexOf("=");
	if (eqIndex === -1) return arg;
	if (!VALUE_FLAGS.has(arg.slice(2, eqIndex))) return arg;
	args.splice(index, 1, arg.slice(0, eqIndex), arg.slice(eqIndex + 1));
	return args[index];
}

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(rawArgs: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
	const args = [...rawArgs];

	for (let i = 0; i < args.length; i++) {
		const arg = expandInlineValueFlag(args, i);

		if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--mode") {
			if (i + 1 >= args.length) {
				result.diagnostics.push({ type: "error", message: "--mode requires a value" });
			} else {
				const mode = args[++i];
				if (mode === "text" || mode === "json") {
					result.mode = mode;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid --mode value "${mode}". Valid values: text, json`,
					});
				}
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--context-window") {
			if (i + 1 >= args.length) {
				result.diagnostics.push({ type: "error", message: "--context-window requires a value" });
			} else {
				const rawValue = args[++i];
				const parsed = parseContextWindowInput(rawValue);
				if (parsed.value === undefined) {
					result.diagnostics.push({
						type: "error",
						message: `Invalid --context-window value "${rawValue}": ${parsed.error ?? "invalid value"}`,
					});
				} else {
					result.contextWindow = parsed.value;
				}
			}
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--agent-role") {
			if (i + 1 >= args.length) {
				result.diagnostics.push({ type: "error", message: "--agent-role requires a value" });
			} else {
				const role = args[++i];
				if (role === "main" || role === "delegated" || role === "reviewer") {
					result.agentRole = role;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid agent role "${role}". Valid values: main, delegated, reviewer`,
					});
				}
			}
		} else if (arg === "--name" || arg === "-n") {
			if (i + 1 < args.length) {
				result.name = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--name requires a value" });
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--session-id" && i + 1 < args.length) {
			result.sessionId = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			result.excludeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			const shortFlag = arg.slice(1);
			if (SHORT_VALUE_FLAGS.has(shortFlag)) {
				result.diagnostics.push({ type: "error", message: `${arg} requires a value` });
			} else {
				result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
			}
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	// A known core flag left without a value falls through to the unknown-flag
	// map when it is the last argument. Report it as a missing value instead of
	// the misleading "Unknown option" raised later by extension flag validation.
	for (const [name, value] of [...result.unknownFlags]) {
		if (value === true && VALUE_FLAGS.has(name)) {
			result.unknownFlags.delete(name);
			result.diagnostics.push({ type: "error", message: `--${name} requires a value` });
		}
	}

	return result;
}
