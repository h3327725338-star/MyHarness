import {
	createWorkflowToolDefinition as createBusinessWorkflowToolDefinition,
	type WorkflowToolOptions,
} from "../../workflow/engine.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { createEditToolDefinition as createBusinessEditToolDefinition, type EditToolOptions } from "../files/edit.ts";
import { createFindToolDefinition as createBusinessFindToolDefinition, type FindToolOptions } from "../files/find.ts";
import { createGrepToolDefinition as createBusinessGrepToolDefinition, type GrepToolOptions } from "../files/grep.ts";
import { createLsToolDefinition as createBusinessLsToolDefinition, type LsToolOptions } from "../files/ls.ts";
import { createReadToolDefinition as createBusinessReadToolDefinition, type ReadToolOptions } from "../files/read.ts";
import {
	createWriteToolDefinition as createBusinessWriteToolDefinition,
	type WriteToolOptions,
} from "../files/write.ts";
import { type BashToolOptions, createBashToolDefinition as createBusinessBashToolDefinition } from "../shell/bash.ts";
import { createPwshToolDefinition as createBusinessPwshToolDefinition, type PwshToolOptions } from "../shell/pwsh.ts";
import {
	createSubAgentToolDefinition as createBusinessSubAgentToolDefinition,
	type SubAgentToolOptions,
} from "../sub-agent.ts";
import {
	createSymbolsToolDefinition as createBusinessSymbolsToolDefinition,
	type SymbolsToolOptions,
} from "../symbols.ts";
import { getBuiltinToolRenderer } from "./index.ts";
import type { BuiltinToolRenderer } from "./types.ts";

type PublicBuiltinToolDefinition<T extends BusinessToolDefinition<any, any>> = T &
	Pick<BuiltinToolRenderer, "renderShell" | "renderCall" | "renderResult">;

function attachBuiltinRenderer<T extends BusinessToolDefinition<any, any>>(
	definition: T,
): PublicBuiltinToolDefinition<T> {
	const renderer = getBuiltinToolRenderer(definition.name);
	if (!renderer) return definition as PublicBuiltinToolDefinition<T>;

	const publicDefinition = { ...definition } as PublicBuiltinToolDefinition<T>;
	if (renderer.renderShell !== undefined) publicDefinition.renderShell = renderer.renderShell;
	if (renderer.renderCall !== undefined) publicDefinition.renderCall = renderer.renderCall;
	if (renderer.renderResult !== undefined) publicDefinition.renderResult = renderer.renderResult;
	return publicDefinition;
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessBashToolDefinition>> {
	return attachBuiltinRenderer(createBusinessBashToolDefinition(cwd, options));
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessEditToolDefinition>> {
	return attachBuiltinRenderer(createBusinessEditToolDefinition(cwd, options));
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessFindToolDefinition>> {
	return attachBuiltinRenderer(createBusinessFindToolDefinition(cwd, options));
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessGrepToolDefinition>> {
	return attachBuiltinRenderer(createBusinessGrepToolDefinition(cwd, options));
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessLsToolDefinition>> {
	return attachBuiltinRenderer(createBusinessLsToolDefinition(cwd, options));
}

export function createPwshToolDefinition(
	cwd: string,
	options?: PwshToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessPwshToolDefinition>> {
	return attachBuiltinRenderer(createBusinessPwshToolDefinition(cwd, options));
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessReadToolDefinition>> {
	return attachBuiltinRenderer(createBusinessReadToolDefinition(cwd, options));
}

export function createSubAgentToolDefinition(
	cwd: string,
	options?: SubAgentToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessSubAgentToolDefinition>> {
	return attachBuiltinRenderer(createBusinessSubAgentToolDefinition(cwd, options));
}

export function createSymbolsToolDefinition(
	cwd: string,
	options?: SymbolsToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessSymbolsToolDefinition>> {
	return attachBuiltinRenderer(createBusinessSymbolsToolDefinition(cwd, options));
}

export function createWorkflowToolDefinition(
	cwd: string,
	options?: WorkflowToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessWorkflowToolDefinition>> {
	return attachBuiltinRenderer(createBusinessWorkflowToolDefinition(cwd, options));
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): PublicBuiltinToolDefinition<ReturnType<typeof createBusinessWriteToolDefinition>> {
	return attachBuiltinRenderer(createBusinessWriteToolDefinition(cwd, options));
}
