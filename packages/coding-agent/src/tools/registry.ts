export {
	createUltracodeTool,
	createUltracodeToolDefinition,
	createWorkflowTool,
	createWorkflowToolDefinition,
	type UltracodeToolOptions,
	type WorkflowPhaseDetails,
	type WorkflowToolDetails,
	type WorkflowToolInput,
	type WorkflowToolOptions,
} from "../workflow/tool.ts";
export {
	type ApplyPatchToolDetails,
	type ApplyPatchToolInput,
	createApplyPatchTool,
	createApplyPatchToolDefinition,
} from "./files/apply-patch.ts";
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
	createSessionGetTool,
	createSessionGetToolDefinition,
	createSessionSearchTool,
	createSessionSearchToolDefinition,
	type SessionGetToolInput,
	type SessionHistoryOperations,
	type SessionHistoryToolDetails,
	type SessionHistoryToolOptions,
	type SessionSearchToolInput,
} from "./history/session-history.ts";
export {
	type AskUserQuestionAnswer,
	type AskUserQuestionToolDetails,
	type AskUserQuestionToolInput,
	createAskUserQuestionTool,
	createAskUserQuestionToolDefinition,
} from "./interaction/ask-user-question.ts";
export {
	createTodoWriteTool,
	createTodoWriteToolDefinition,
	type TodoWriteCounts,
	type TodoWriteItem,
	type TodoWriteToolDetails,
	type TodoWriteToolInput,
} from "./interaction/todo-write.ts";
export {
	createMemoryClaimTool,
	createMemoryClaimToolDefinition,
	createMemoryDeleteTool,
	createMemoryDeleteToolDefinition,
} from "./memory/manage.ts";
export {
	createMemoryGetTool,
	createMemoryGetToolDefinition,
	createMemorySearchTool,
	createMemorySearchToolDefinition,
	type MemoryGetToolInput,
	type MemorySearchToolInput,
	type MemoryToolDetails,
	type MemoryToolOperations,
	type MemoryToolOptions,
} from "./memory/search.ts";
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
	createJobKillTool,
	createJobKillToolDefinition,
	createJobListTool,
	createJobListToolDefinition,
	createJobOutputTool,
	createJobOutputToolDefinition,
	type JobKillToolInput,
	type JobListToolInput,
	type JobOutputToolInput,
	type JobToolDetails,
} from "./shell/job-tools.ts";
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
import { createApplyPatchTool, createApplyPatchToolDefinition } from "./files/apply-patch.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./files/edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./files/find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./files/grep.ts";
import { createGitHubTool, createGitHubToolDefinition, type GitHubToolOptions } from "./github/tool.ts";
import { createMailTool, createMailToolDefinition, type MailToolOptions } from "./mail/tool.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./shell/bash.ts";
import { createWorkspaceTool, createWorkspaceToolDefinition, type WorkspaceToolOptions } from "./workspace.ts";

export { createGitHubTool, createGitHubToolDefinition, type GitHubToolOptions } from "./github/tool.ts";
export { createMailTool, createMailToolDefinition, type MailToolOptions } from "./mail/tool.ts";

import {
	createUltracodeTool,
	createUltracodeToolDefinition,
	createWorkflowTool,
	createWorkflowToolDefinition,
	type UltracodeToolOptions,
	type WorkflowToolOptions,
} from "../workflow/tool.ts";
import { type AgentTasksToolOptions, createAgentTasksTool, createAgentTasksToolDefinition } from "./agent-tasks.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./files/ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./files/read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./files/write.ts";
import {
	createSessionGetTool,
	createSessionGetToolDefinition,
	createSessionSearchTool,
	createSessionSearchToolDefinition,
	type SessionHistoryToolOptions,
} from "./history/session-history.ts";
import { createAskUserQuestionTool, createAskUserQuestionToolDefinition } from "./interaction/ask-user-question.ts";
import { createTodoWriteTool, createTodoWriteToolDefinition } from "./interaction/todo-write.ts";
import {
	createMemoryClaimTool,
	createMemoryClaimToolDefinition,
	createMemoryDeleteTool,
	createMemoryDeleteToolDefinition,
} from "./memory/manage.ts";
import {
	createMemoryGetTool,
	createMemoryGetToolDefinition,
	createMemorySearchTool,
	createMemorySearchToolDefinition,
	type MemoryToolOptions,
} from "./memory/search.ts";
import { createMemoryWriteTool, createMemoryWriteToolDefinition } from "./memory/write.ts";

export {
	createMemoryWriteTool,
	createMemoryWriteToolDefinition,
	type MemoryWriteToolDetails,
	type MemoryWriteToolInput,
	type MemoryWriteToolItem,
} from "./memory/write.ts";

import { createApplyRenameTool, createApplyRenameToolDefinition } from "./apply-rename.ts";
import {
	createJobKillTool,
	createJobKillToolDefinition,
	createJobListTool,
	createJobListToolDefinition,
	createJobOutputTool,
	createJobOutputToolDefinition,
} from "./shell/job-tools.ts";
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

export {
	createWorkspaceTool,
	createWorkspaceToolDefinition,
	desktopWorkspaceAvailable,
} from "./workspace.ts";

export type Tool = AgentTool<any>;
export type ToolDef = BusinessToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "pwsh"
	| "job_list"
	| "job_output"
	| "job_kill"
	| "edit"
	| "write"
	| "apply_patch"
	| "grep"
	| "find"
	| "ls"
	| "symbols"
	| "apply_rename"
	| "agent"
	| "workflow"
	| "ultracode"
	| "agent_tasks"
	| "github"
	| "mail"
	| "memory_search"
	| "memory_get"
	| "memory_delete"
	| "memory_claim"
	| "memory_write"
	| "session_search"
	| "session_get"
	| "ask_user_question"
	| "todo_write"
	| "web_search"
	| "web_fetch"
	| "workspace";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"pwsh",
	"job_list",
	"job_output",
	"job_kill",
	"edit",
	"write",
	"apply_patch",
	"grep",
	"find",
	"ls",
	"symbols",
	"apply_rename",
	"agent",
	"workflow",
	"ultracode",
	"agent_tasks",
	"github",
	"mail",
	"memory_search",
	"memory_get",
	"memory_delete",
	"memory_claim",
	"memory_write",
	"session_search",
	"session_get",
	"ask_user_question",
	"todo_write",
	"web_search",
	"web_fetch",
	"workspace",
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
	agent?: SubAgentToolOptions;
	workflow?: WorkflowToolOptions;
	ultracode?: UltracodeToolOptions;
	agentTasks?: AgentTasksToolOptions;
	github?: GitHubToolOptions;
	mail?: MailToolOptions;
	memory?: MemoryToolOptions;
	sessionHistory?: SessionHistoryToolOptions;
	webSearch?: WebSearchToolOptions;
	workspace?: WorkspaceToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "github":
			return createGitHubToolDefinition(cwd, options?.github);
		case "mail":
			return createMailToolDefinition(cwd, options?.mail);
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "pwsh":
			return createPwshToolDefinition(cwd, options?.pwsh);
		case "job_list":
			return createJobListToolDefinition(cwd);
		case "job_output":
			return createJobOutputToolDefinition(cwd);
		case "job_kill":
			return createJobKillToolDefinition(cwd);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "apply_patch":
			return createApplyPatchToolDefinition(cwd);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "symbols":
			return createSymbolsToolDefinition(cwd, options?.symbols);
		case "apply_rename":
			return createApplyRenameToolDefinition(cwd);
		case "agent":
			return createSubAgentToolDefinition(cwd, options?.agent);
		case "workflow":
			return createWorkflowToolDefinition(cwd, options?.workflow);
		case "ultracode":
			return createUltracodeToolDefinition(cwd, options?.ultracode);
		case "agent_tasks":
			return createAgentTasksToolDefinition(options?.agentTasks);
		case "memory_search":
			return createMemorySearchToolDefinition(cwd, options?.memory);
		case "memory_get":
			return createMemoryGetToolDefinition(cwd, options?.memory);
		case "memory_delete":
			return createMemoryDeleteToolDefinition(cwd, options?.memory);
		case "memory_claim":
			return createMemoryClaimToolDefinition(cwd, options?.memory);
		case "memory_write":
			return createMemoryWriteToolDefinition(cwd, options?.memory);
		case "session_search":
			return createSessionSearchToolDefinition(cwd, options?.sessionHistory);
		case "session_get":
			return createSessionGetToolDefinition(cwd, options?.sessionHistory);
		case "ask_user_question":
			return createAskUserQuestionToolDefinition();
		case "todo_write":
			return createTodoWriteToolDefinition();
		case "web_search":
			return createWebSearchToolDefinition(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchToolDefinition(cwd, options?.webSearch);
		case "workspace":
			return createWorkspaceToolDefinition(options?.workspace);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "github":
			return createGitHubTool(cwd, options?.github);
		case "mail":
			return createMailTool(cwd, options?.mail);
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "pwsh":
			return createPwshTool(cwd, options?.pwsh);
		case "job_list":
			return createJobListTool(cwd);
		case "job_output":
			return createJobOutputTool(cwd);
		case "job_kill":
			return createJobKillTool(cwd);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "apply_patch":
			return createApplyPatchTool(cwd);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "symbols":
			return createSymbolsTool(cwd, options?.symbols);
		case "apply_rename":
			return createApplyRenameTool(cwd);
		case "agent":
			return createSubAgentTool(cwd, options?.agent);
		case "workflow":
			return createWorkflowTool(cwd, options?.workflow);
		case "ultracode":
			return createUltracodeTool(cwd, options?.ultracode);
		case "agent_tasks":
			return createAgentTasksTool(options?.agentTasks);
		case "memory_search":
			return createMemorySearchTool(cwd, options?.memory);
		case "memory_get":
			return createMemoryGetTool(cwd, options?.memory);
		case "memory_delete":
			return createMemoryDeleteTool(cwd, options?.memory);
		case "memory_claim":
			return createMemoryClaimTool(cwd, options?.memory);
		case "memory_write":
			return createMemoryWriteTool(cwd, options?.memory);
		case "session_search":
			return createSessionSearchTool(cwd, options?.sessionHistory);
		case "session_get":
			return createSessionGetTool(cwd, options?.sessionHistory);
		case "ask_user_question":
			return createAskUserQuestionTool();
		case "todo_write":
			return createTodoWriteTool();
		case "web_search":
			return createWebSearchTool(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchTool(cwd, options?.webSearch);
		case "workspace":
			return createWorkspaceTool(options?.workspace);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const webSearchTools = createWebSearchToolDefinitions(cwd, options?.webSearch);
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		pwsh: createPwshToolDefinition(cwd, options?.pwsh),
		job_list: createJobListToolDefinition(cwd),
		job_output: createJobOutputToolDefinition(cwd),
		job_kill: createJobKillToolDefinition(cwd),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		apply_patch: createApplyPatchToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		symbols: createSymbolsToolDefinition(cwd, options?.symbols),
		apply_rename: createApplyRenameToolDefinition(cwd),
		agent: createSubAgentToolDefinition(cwd, options?.agent),
		workflow: createWorkflowToolDefinition(cwd, options?.workflow),
		ultracode: createUltracodeToolDefinition(cwd, options?.ultracode),
		agent_tasks: createAgentTasksToolDefinition(options?.agentTasks),
		github: createGitHubToolDefinition(cwd, options?.github),
		mail: createMailToolDefinition(cwd, options?.mail),
		memory_search: createMemorySearchToolDefinition(cwd, options?.memory),
		memory_get: createMemoryGetToolDefinition(cwd, options?.memory),
		memory_delete: createMemoryDeleteToolDefinition(cwd, options?.memory),
		memory_claim: createMemoryClaimToolDefinition(cwd, options?.memory),
		memory_write: createMemoryWriteToolDefinition(cwd, options?.memory),
		session_search: createSessionSearchToolDefinition(cwd, options?.sessionHistory),
		session_get: createSessionGetToolDefinition(cwd, options?.sessionHistory),
		ask_user_question: createAskUserQuestionToolDefinition(),
		todo_write: createTodoWriteToolDefinition(),
		web_search: webSearchTools.web_search,
		web_fetch: webSearchTools.web_fetch,
		workspace: createWorkspaceToolDefinition(options?.workspace),
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
		job_list: createJobListTool(cwd),
		job_output: createJobOutputTool(cwd),
		job_kill: createJobKillTool(cwd),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		apply_patch: createApplyPatchTool(cwd),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		symbols: createSymbolsTool(cwd, options?.symbols),
		apply_rename: createApplyRenameTool(cwd),
		agent: createSubAgentTool(cwd, options?.agent),
		workflow: createWorkflowTool(cwd, options?.workflow),
		ultracode: createUltracodeTool(cwd, options?.ultracode),
		agent_tasks: createAgentTasksTool(options?.agentTasks),
		github: createGitHubTool(cwd, options?.github),
		mail: createMailTool(cwd, options?.mail),
		memory_search: createMemorySearchTool(cwd, options?.memory),
		memory_get: createMemoryGetTool(cwd, options?.memory),
		memory_delete: createMemoryDeleteTool(cwd, options?.memory),
		memory_claim: createMemoryClaimTool(cwd, options?.memory),
		memory_write: createMemoryWriteTool(cwd, options?.memory),
		session_search: createSessionSearchTool(cwd, options?.sessionHistory),
		session_get: createSessionGetTool(cwd, options?.sessionHistory),
		ask_user_question: createAskUserQuestionTool(),
		todo_write: createTodoWriteTool(),
		web_search: createWebSearchTool(cwd, options?.webSearch),
		web_fetch: createWebFetchTool(cwd, options?.webSearch),
		workspace: createWorkspaceTool(options?.workspace),
	};
}
