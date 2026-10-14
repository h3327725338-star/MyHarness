import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { loadSystemPrompt, loadSystemPromptLines } from "../../system-prompts/loader/index.ts";
import { writeFileAtomically } from "../../utils/atomic-write.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { assertLocalWorkspaceCwdAvailable, resolveToCwd } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { committedAfterCancel } from "./mutation-result.ts";
import { assertFileWasReadBefore, recordFileStateAfterMutation, resolveFileStateScope } from "./read-state.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"The exact text to replace. It must be unique in the original file and must not overlap with other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "The text to replace it with for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "File path to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit matches against the original file, not the result of a previous edit. Do not include overlapping or nested edits. If two changes affect the same code block or adjacent lines, merge them into one edit.",
		}),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** The write committed after cancellation arrived during the write. */
	mutationStatus?: "committed-after-cancel";
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => writeFileAtomically(path, content),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): BusinessToolDefinition<typeof editSchema, EditToolDetails | undefined> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edits a single file with exact text replacement. Each edits[].oldText must match a unique, non-overlapping region in the original file. If two changes affect the same code block or adjacent lines, merge them into one edit and do not generate overlapping edits. Do not include large amounts of unchanged content just to connect distant changes. Read the file with the read tool before editing it: an unread file, or one that changed since it was read, is refused.",
		promptSnippet: loadSystemPrompt("tools/edit/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/edit/guidelines.md"),
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, onUpdate?, ctx?) {
			const { path, edits } = validateEditInput(input);
			assertLocalWorkspaceCwdAvailable(cwd);
			const absolutePath = resolveToCwd(path, cwd);
			// The read state gate compares the file's timestamp and size, which only the local
			// filesystem can report. A custom operation set (for example SSH) may serve a file
			// this process cannot stat, so the gate applies to the default operations only, the
			// same way the write tool counts lines only for them.
			const localFileSystem = ops === defaultEditOperations;
			const scope = resolveFileStateScope(ctx);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Refuse to edit a file the model has not looked at, or that moved since it did.
				if (localFileSystem) {
					await assertFileWasReadBefore(absolutePath, "edit", path, scope);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				// Validated change set, reported while the atomic write is still running.
				onUpdate?.({
					content: [],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				});
				throwIfAborted();
				await ops.writeFile(absolutePath, finalContent);
				// The change is ours: remember its shape so the next edit of this file in the same
				// Session is not reported as an external modification.
				if (localFileSystem) await recordFileStateAfterMutation(absolutePath, scope);
				const mutation = committedAfterCancel(signal);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: {
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
						...(mutation ? { mutationStatus: mutation.mutationStatus } : {}),
					},
				};
			});
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
