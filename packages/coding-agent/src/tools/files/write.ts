import { mkdir as fsMkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import type { ChangeControl } from "../../changes/service.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../../system-prompts/loader/index.ts";
import { writeFileAtomically } from "../../utils/atomic-write.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { resolveToCwd } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { countLineChanges } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { committedAfterCancel, type FileMutationDetails } from "./mutation-result.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "File path to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/** What a write changed in the file, counted against the file as it was just before (see `describeWrite`). */
export interface WriteToolDetails extends Partial<FileMutationDetails> {
	/** The file did not exist before this write. */
	created?: boolean;
	/** Lines added to / removed from the file by this write. */
	additions?: number;
	deletions?: number;
}

/** Files larger than this are written without counting lines (the count would cost more than it tells). */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

/**
 * The file as it is before a write: `{ created: true }` when it does not exist, its text when it is an ordinary text
 * file, and nothing when it cannot be read as text (a directory, binary or very large file): then no count is given.
 */
async function readBeforeWrite(absolutePath: string): Promise<{ created: true } | { text: string } | undefined> {
	try {
		const info = await stat(absolutePath);
		if (!info.isFile() || info.size > MAX_COUNTED_BYTES) return undefined;
		const text = (await readFile(absolutePath)).toString("utf8");
		return text.includes("\u0000") ? undefined : { text };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { created: true } : undefined;
	}
}

function describeWrite(before: Awaited<ReturnType<typeof readBeforeWrite>>, content: string): WriteToolDetails {
	if (!before || content.length > MAX_COUNTED_BYTES) return {};
	if ("created" in before) return { created: true, ...countLineChanges(undefined, content) };
	return countLineChanges(before.text, content);
}

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
	/** Local writes use this shared broker when supplied by the session or SDK. */
	changeControl?: ChangeControl;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): BusinessToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
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
			onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			if (options?.changeControl) {
				if (options.operations) throw new Error("Controlled writes do not support remote/custom operations");
				const preview = await options.changeControl.previewWrite(absolutePath, content);
				const outcome = await options.changeControl.apply(preview.changeset.id, {
					origin: { kind: "write", toolCallId: _toolCallId },
					signal,
				});
				const file = preview.changeset.files[0]!;
				return {
					content: [
						{
							type: "text" as const,
							text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`,
						},
					],
					details: {
						created: file.operation === "create",
						additions: file.additions,
						deletions: file.deletions,
						...(outcome.result.committedAfterCancel ? { mutationStatus: "committed-after-cancel" as const } : {}),
					},
				};
			}
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
				// What the file holds now, to tell afterwards how many lines the write added and removed. Only for the
				// local file system: a custom operation set (for example SSH) cannot be read from here.
				const before = ops === defaultWriteOperations ? await readBeforeWrite(absolutePath) : undefined;
				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				const changes = describeWrite(before, content);
				if (Object.keys(changes).length) onUpdate?.({ content: [], details: changes });
				throwIfAborted();
				// Write the file contents without splitting the atomic mutation for presentation.
				await ops.writeFile(absolutePath, content);

				const details: WriteToolDetails = { ...committedAfterCancel(signal), ...changes };
				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: Object.keys(details).length > 0 ? details : undefined,
				};
			});
		},
	};
}

export function createWriteTool(
	cwd: string,
	options?: WriteToolOptions,
): AgentTool<typeof writeSchema, WriteToolDetails | undefined> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
