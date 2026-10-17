import { readFile } from "node:fs/promises";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { getWorkspaceIdentity, normalizeWorkspaceRoot } from "../symbols/path-semantics.ts";
import { discardRenamePlan, getRenamePlan, type RenamePlanFile } from "../symbols/workflow/rename-plans.ts";
import { sha256Hex } from "../symbols/workflow/text.ts";
import { loadSystemPrompt } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { fileIdentity, replaceFileStep, runWriteSteps, withFileQueues } from "./files/apply-patch.ts";
import { countLineChanges, generateDiffString, normalizeToLF } from "./files/edit-diff.ts";
import { committedAfterCancel } from "./files/mutation-result.ts";
import { getFileReadState, recordFileStateAfterMutation, resolveFileStateScope } from "./files/read-state.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * apply_rename writes a rename plan made by `symbols rename_preview`.
 *
 * The plan already holds the exact new content of every file, computed from
 * the language server's WorkspaceEdit. Writing goes through the same
 * machinery as apply_patch: every file's mutation queue is held for the whole
 * check-and-write, all files are written or none (a failed write restores the
 * ones already written), and the result carries per-file diffs for review.
 *
 * Before anything is written each file must still hash exactly as when the
 * plan was made; a file edited in between (by the agent, an editor, Git, a
 * formatter) refuses the whole plan. This hash check replaces the
 * read-before-edit check for these files: the content being replaced is
 * proven to be the content the plan was computed from. Afterwards the
 * read-before-edit state is refreshed only for files the model had read, so
 * a later free-form edit of a file it never saw still requires a read.
 */

const applyRenameSchema = Type.Object(
	{
		planId: Type.String({ minLength: 1, description: "The plan id printed by symbols rename_preview" }),
	},
	{ additionalProperties: false },
);

export type ApplyRenameToolInput = Static<typeof applyRenameSchema>;

export interface ApplyRenameFileDetails {
	path: string;
	edits: number;
	diff?: string;
	linesAdded: number;
	linesRemoved: number;
}

export interface ApplyRenameToolDetails {
	planId: string;
	oldName: string;
	newName: string;
	files: ApplyRenameFileDetails[];
	mutationStatus?: "committed-after-cancel";
}

const APPLY_RENAME_DESCRIPTION = [
	"Apply a semantic rename planned by `symbols` operation rename_preview. Pass the planId it printed.",
	"Every file of the plan is written, or none: if any file changed after the preview, or cannot be written, nothing is written and the reason is reported.",
	"Only the language server's edits are applied; text occurrences outside them (comments, strings, other languages) are left as they were. Run diagnostics or the project's type check afterwards.",
].join("\n");

function fileBytes(file: RenamePlanFile): string {
	return file.bom ? `﻿${file.newText}` : file.newText;
}

export function createApplyRenameToolDefinition(
	cwd: string,
): BusinessToolDefinition<typeof applyRenameSchema, ApplyRenameToolDetails | undefined> {
	return {
		name: "apply_rename",
		label: "apply_rename",
		description: APPLY_RENAME_DESCRIPTION,
		promptSnippet: loadSystemPrompt("tools/apply-rename/snippet.md"),
		parameters: applyRenameSchema,
		async execute(_toolCallId, input: ApplyRenameToolInput, signal?: AbortSignal, onUpdate?, ctx?) {
			const planId = typeof input?.planId === "string" ? input.planId.trim() : "";
			const plan = planId ? getRenamePlan(planId) : undefined;
			if (!plan) {
				throw new Error(
					`apply_rename: no rename plan ${planId || "(empty)"} is available. Plans expire after 30 minutes, are used once, and exist only in the session that made them. Run symbols rename_preview again.`,
				);
			}
			const workspaceIdentity = getWorkspaceIdentity(normalizeWorkspaceRoot(cwd));
			if (plan.workspaceIdentity !== workspaceIdentity) {
				throw new Error(
					`apply_rename: plan ${plan.id} was made for workspace ${plan.workspaceRoot}, not for this session's workspace ${cwd}. Nothing was written.`,
				);
			}
			const scope = resolveFileStateScope(ctx);
			const identities = await Promise.all(
				plan.files.map(async (file) => ({ file, identity: await fileIdentity(file.absolutePath) })),
			);
			identities.sort((left, right) =>
				left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0,
			);
			const lockPaths = identities.map((entry) => entry.file.absolutePath);

			return withFileQueues(
				lockPaths,
				async () => {
					if (signal?.aborted) throw new Error("Operation aborted");
					const changed: string[] = [];
					const befores = new Map<string, Buffer>();
					for (const file of plan.files) {
						let bytes: Buffer;
						try {
							bytes = await readFile(file.absolutePath);
						} catch (error) {
							changed.push(
								`${file.path} (cannot be read: ${error instanceof Error ? error.message : String(error)})`,
							);
							continue;
						}
						if (sha256Hex(bytes) !== file.sha256) changed.push(`${file.path} (content differs from the preview)`);
						befores.set(file.absolutePath, bytes);
					}
					if (changed.length > 0) {
						throw new Error(
							[
								`apply_rename refused plan ${plan.id}: ${changed.length} file(s) changed after the preview, so nothing was written:`,
								...changed.map((entry) => `- ${entry}`),
								"Run symbols rename_preview again on the current code.",
							].join("\n"),
						);
					}
					if (signal?.aborted) throw new Error("Operation aborted");

					const files: ApplyRenameFileDetails[] = plan.files.map((file) => {
						const before = normalizeToLF(file.originalText);
						const after = normalizeToLF(file.newText);
						const counts = countLineChanges(before, after);
						return {
							path: file.path,
							edits: file.edits.length,
							diff: generateDiffString(before, after).diff,
							linesAdded: counts.additions,
							linesRemoved: counts.deletions,
						};
					});
					onUpdate?.({
						content: [],
						details: { planId: plan.id, oldName: plan.oldName, newName: plan.newName, files },
					});
					const previouslyRead = new Set(
						plan.files
							.filter((file) => getFileReadState(file.absolutePath, scope) !== undefined)
							.map((file) => file.absolutePath),
					);
					await runWriteSteps(
						plan.files.map((file) =>
							replaceFileStep(file.path, file.absolutePath, fileBytes(file), befores.get(file.absolutePath)!),
						),
						"apply_rename",
					);
					discardRenamePlan(plan.id);
					for (const file of plan.files) {
						if (previouslyRead.has(file.absolutePath))
							await recordFileStateAfterMutation(file.absolutePath, scope);
					}
					const editCount = plan.files.reduce((sum, file) => sum + file.edits.length, 0);
					const mutation = committedAfterCancel(signal);
					return {
						content: [
							{
								type: "text",
								text: [
									`Renamed ${plan.oldName} -> ${plan.newName}: ${editCount} edit(s) in ${plan.files.length} file(s).`,
									...files.map((file) => `M ${file.path} (${file.edits} edit(s))`),
									"Next: run diagnostics or the project's type check; text occurrences listed by the preview were not changed.",
								].join("\n"),
							},
						],
						details: {
							planId: plan.id,
							oldName: plan.oldName,
							newName: plan.newName,
							files,
							...(mutation ? { mutationStatus: mutation.mutationStatus } : {}),
						},
					};
				},
				signal,
			);
		},
	};
}

export function createApplyRenameTool(
	cwd: string,
): AgentTool<typeof applyRenameSchema, ApplyRenameToolDetails | undefined> {
	return wrapToolDefinition(createApplyRenameToolDefinition(cwd));
}
