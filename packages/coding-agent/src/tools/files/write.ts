import { mkdir as fsMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { loadSystemPrompt, loadSystemPromptLines } from "../../system-prompts/loader/index.ts";
import { writeFileAtomically } from "../../utils/atomic-write.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { resolveToCwd } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { committedAfterCancel, type FileMutationDetails } from "./mutation-result.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "File path to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => writeFileAtomically(path, content),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): BusinessToolDefinition<typeof writeSchema, FileMutationDetails | undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Writes content to a file. Creates the file if it does not exist and overwrites it if it does. Automatically creates parent directories.",
		promptSnippet: loadSystemPrompt("tools/write/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/write/guidelines.md"),
		parameters: writeSchema,
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);

				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: committedAfterCancel(signal),
				};
			});
		},
	};
}

export function createWriteTool(
	cwd: string,
	options?: WriteToolOptions,
): AgentTool<typeof writeSchema, FileMutationDetails | undefined> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
