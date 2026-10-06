export {
	createInvestigationToolDefinition,
	createUltracodeTool,
	createUltracodeToolDefinition,
	createWorkflowTool,
	createWorkflowToolDefinition,
	type InvestigationToolKind,
	type UltracodeToolDetails,
	type UltracodeToolInput,
	type UltracodeToolOptions,
	type WorkflowPhaseDetails,
	type WorkflowToolDetails,
	type WorkflowToolInput,
	type WorkflowToolOptions,
} from "../workflow/tool.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./files/edit.ts";
export { withFileMutationQueue } from "./files/file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./files/find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./files/grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./files/ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./files/read.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./files/write.ts";
export {
	createRefactorTool,
	createRefactorToolDefinition,
	type RefactorToolDetails,
	RefactorToolError,
	type RefactorToolInput,
	RefactorToolInputError,
	type RefactorToolOptions,
} from "./refactor.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./shell/bash.ts";
export {
	createLocalPwshOperations,
	createPwshTool,
	createPwshToolDefinition,
	type PwshOperations,
	type PwshSpawnContext,
	type PwshSpawnHook,
	type PwshToolDetails,
	type PwshToolInput,
	type PwshToolOptions,
} from "./shell/pwsh.ts";
export {
	createSubAgentTool,
	createSubAgentToolDefinition,
	type ExploreTaskResult,
	type SubAgentBackgroundProgress,
	type SubAgentBackgroundTask,
	type SubAgentRuntimeSettings,
	type SubAgentTaskSpec,
	type SubAgentToolDetails,
	type SubAgentToolInput,
	type SubAgentToolOptions,
	type SubAgentToolTrace,
} from "./sub-agent.ts";
export {
	createSymbolsTool,
	createSymbolsToolDefinition,
	type SymbolsCodeIntelligenceServices,
	type SymbolsIndexPort,
	SymbolsToolConfigurationError,
	type SymbolsToolDetails,
	type SymbolsToolInput,
	SymbolsToolInputError,
	type SymbolsToolOptions,
	type SymbolsToolTarget,
} from "./symbols.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWebFetchTool,
	createWebFetchToolDefinition,
	createWebSearchTool,
	createWebSearchToolDefinition,
	createWebSearchToolDefinitions,
	type WebFetchToolDetails,
	type WebFetchToolInput,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "./web-search/tool.ts";

import type { AgentTool } from "@myharness/agent-core";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./files/edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./files/find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./files/grep.ts";
import { createGitHubTool, createGitHubToolDefinition, type GitHubToolOptions } from "./github/tool.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./shell/bash.ts";

export { createGitHubTool, createGitHubToolDefinition, type GitHubToolOptions } from "./github/tool.ts";

import {
	createUltracodeTool,
	createUltracodeToolDefinition,
	createWorkflowTool,
	createWorkflowToolDefinition,
	type UltracodeToolOptions,
	type WorkflowToolOptions,
} from "../workflow/tool.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./files/ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./files/read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./files/write.ts";
import { createRefactorTool, createRefactorToolDefinition, type RefactorToolOptions } from "./refactor.ts";
import { createPwshTool, createPwshToolDefinition, type PwshToolOptions } from "./shell/pwsh.ts";
import { createSubAgentTool, createSubAgentToolDefinition, type SubAgentToolOptions } from "./sub-agent.ts";
import { createSymbolsTool, createSymbolsToolDefinition, type SymbolsToolOptions } from "./symbols.ts";
import {
	createWebFetchTool,
	createWebFetchToolDefinition,
	createWebSearchTool,
	createWebSearchToolDefinition,
	createWebSearchToolDefinitions,
	type WebSearchToolOptions,
} from "./web-search/tool.ts";

export type Tool = AgentTool<any>;
export type ToolDef = BusinessToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "pwsh"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "symbols"
	| "refactor"
	| "agent"
	| "workflow"
	| "ultracode"
	| "github"
	| "web_search"
	| "web_fetch";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"pwsh",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"symbols",
	"refactor",
	"agent",
	"workflow",
	"ultracode",
	"github",
	"web_search",
	"web_fetch",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	pwsh?: PwshToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	symbols?: SymbolsToolOptions;
	refactor?: RefactorToolOptions;
	agent?: SubAgentToolOptions;
	workflow?: WorkflowToolOptions;
	ultracode?: UltracodeToolOptions;
	github?: GitHubToolOptions;
	webSearch?: WebSearchToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "github":
			return createGitHubToolDefinition(cwd, options?.github);
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "pwsh":
			return createPwshToolDefinition(cwd, options?.pwsh);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "symbols":
			return createSymbolsToolDefinition(cwd, options?.symbols);
		case "refactor":
			return createRefactorToolDefinition(cwd, options?.refactor);
		case "agent":
			return createSubAgentToolDefinition(cwd, options?.agent);
		case "workflow":
			return createWorkflowToolDefinition(cwd, options?.workflow);
		case "ultracode":
			return createUltracodeToolDefinition(cwd, options?.ultracode);
		case "web_search":
			return createWebSearchToolDefinition(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchToolDefinition(cwd, options?.webSearch);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "github":
			return createGitHubTool(cwd, options?.github);
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "pwsh":
			return createPwshTool(cwd, options?.pwsh);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "symbols":
			return createSymbolsTool(cwd, options?.symbols);
		case "refactor":
			return createRefactorTool(cwd, options?.refactor);
		case "agent":
			return createSubAgentTool(cwd, options?.agent);
		case "workflow":
			return createWorkflowTool(cwd, options?.workflow);
		case "ultracode":
			return createUltracodeTool(cwd, options?.ultracode);
		case "web_search":
			return createWebSearchTool(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchTool(cwd, options?.webSearch);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const webSearchTools = createWebSearchToolDefinitions(cwd, options?.webSearch);
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		pwsh: createPwshToolDefinition(cwd, options?.pwsh),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		symbols: createSymbolsToolDefinition(cwd, options?.symbols),
		refactor: createRefactorToolDefinition(cwd, options?.refactor),
		agent: createSubAgentToolDefinition(cwd, options?.agent),
		workflow: createWorkflowToolDefinition(cwd, options?.workflow),
		ultracode: createUltracodeToolDefinition(cwd, options?.ultracode),
		github: createGitHubToolDefinition(cwd, options?.github),
		web_search: webSearchTools.web_search,
		web_fetch: webSearchTools.web_fetch,
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		pwsh: createPwshTool(cwd, options?.pwsh),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		symbols: createSymbolsTool(cwd, options?.symbols),
		refactor: createRefactorTool(cwd, options?.refactor),
		agent: createSubAgentTool(cwd, options?.agent),
		workflow: createWorkflowTool(cwd, options?.workflow),
		ultracode: createUltracodeTool(cwd, options?.ultracode),
		github: createGitHubTool(cwd, options?.github),
		web_search: createWebSearchTool(cwd, options?.webSearch),
		web_fetch: createWebFetchTool(cwd, options?.webSearch),
	};
}
