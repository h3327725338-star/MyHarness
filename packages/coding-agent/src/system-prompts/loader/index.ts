/**
 * Single local boundary for loading immutable system-prompts content.
 * The actual content remains in the repository-level `system-prompts/` tree;
 * this module preserves the AI package loader's path and interpolation rules.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../../config.ts";

export { loadSystemPrompt, loadSystemPromptLines } from "@myharness/ai/api/system-prompt-loader";

/**
 * Resolve a CLI or settings-provided prompt input. Existing callers may pass
 * either a literal prompt or a path to a UTF-8 file; preserve that distinction
 * and the warning/fallback behavior here.
 */
export function resolveSystemPromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

/** Resolve the trusted project/global SYSTEM.md precedence used by the CLI. */
export function discoverSystemPromptFile(options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): string | undefined {
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
	if (options.projectTrusted && existsSync(projectPath)) {
		return projectPath;
	}

	const globalPath = join(options.agentDir, "SYSTEM.md");
	if (existsSync(globalPath)) {
		return globalPath;
	}

	return undefined;
}

/** Resolve the trusted project/global APPEND_SYSTEM.md precedence used by the CLI. */
export function discoverAppendSystemPromptFile(options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): string | undefined {
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
	if (options.projectTrusted && existsSync(projectPath)) {
		return projectPath;
	}

	const globalPath = join(options.agentDir, "APPEND_SYSTEM.md");
	if (existsSync(globalPath)) {
		return globalPath;
	}

	return undefined;
}
