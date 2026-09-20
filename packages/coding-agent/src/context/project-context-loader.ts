import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import type { AgentRole } from "../agent/runtime/role.ts";
import { resolvePath } from "../utils/paths.ts";
import { filterContextFilesForAgentRole } from "./context-policy.ts";

export interface ProjectContextFile {
	path: string;
	content: string;
}

function loadContextFileFromDir(dir: string): ProjectContextFile | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (!existsSync(filePath)) {
			continue;
		}
		try {
			return {
				path: filePath,
				content: readFileSync(filePath, "utf-8"),
			};
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
		}
	}
	return null;
}

/**
 * Load project context in the existing global-then-ancestor order.
 *
 * The loader only deals with context files. System prompts and skills are
 * loaded by their own modules and are composed later by the agent runtime.
 */
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	agentRole?: AgentRole;
}): ProjectContextFile[] {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: ProjectContextFile[] = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: ProjectContextFile[] = [];
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);
	return filterContextFilesForAgentRole(contextFiles, options.agentRole ?? "main");
}
