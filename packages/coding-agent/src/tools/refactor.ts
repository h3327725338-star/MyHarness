/**
 * refactor: controlled changes across files.
 *
 * A change is previewed first — a language server's rename, or a patch of exact-text edits and new files — which
 * stores the exact result and shows what it touches. `apply` writes that stored result by its id, after the
 * change gates and the approval policy. The model never holds a permit: the policy, or the person, grants it.
 */

import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { type ChangeErrorCode, isChangeControlError } from "../changes/errors.ts";
import { createChangeControl } from "../changes/factory.ts";
import { MAX_PATCH_EDITS_PER_FILE, MAX_PATCH_FILES, type PatchChange } from "../changes/patch-plan.ts";
import type { ApplyOutcome, ChangeOrigin, ChangePreview } from "../changes/service.ts";
import { type ChangeControl, documentVersionLookup } from "../changes/service.ts";
import { getAgentDir } from "../config.ts";
import { CodeIntelligenceRouterError } from "../symbols/index/router/errors.ts";
import { isAbortError } from "../symbols/index/router/policy.ts";
import type { CodeIntelligenceRoutingOptions } from "../symbols/index/router/types.ts";
import { SemanticBackendError } from "../symbols/semantic/errors.ts";
import type { SymbolTarget } from "../symbols/types.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import {
	createSymbolsToolRuntime,
	type SymbolsCodeIntelligenceServices,
	type SymbolsIndexPort,
} from "./symbols-runtime.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

// --- schema ---------------------------------------------------------------------------------------------------

const MAX_NEW_NAME_LENGTH = 255;
const CHANGESET_ID = /^[0-9a-f]{32}$/;
const nonNegativeInteger = Type.Integer({ minimum: 0 });
const nonEmptyString = Type.String({ minLength: 1 });

const positionTargetSchema = Type.Object(
	{
		type: Type.Literal("position"),
		path: Type.String({ minLength: 1, description: "Workspace-relative path of the file" }),
		position: Type.Object(
			{ line: nonNegativeInteger, character: nonNegativeInteger },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const symbolIdTargetSchema = Type.Object(
	{ type: Type.Literal("symbol_id"), symbolId: nonEmptyString },
	{ additionalProperties: false },
);
const targetSchema = Type.Union([positionTargetSchema, symbolIdTargetSchema]);

const patchEditSchema = Type.Object(
	{
		oldText: Type.String({ minLength: 1, description: "Exact text to replace; unique in the file as it is now" }),
		newText: Type.String(),
	},
	{ additionalProperties: false },
);
const patchChangeSchema = Type.Union([
	Type.Object(
		{
			path: nonEmptyString,
			edits: Type.Array(patchEditSchema, { minItems: 1, maxItems: MAX_PATCH_EDITS_PER_FILE }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: nonEmptyString,
			content: Type.String({ description: "Complete text of a file that does not exist yet" }),
		},
		{ additionalProperties: false },
	),
]);

const changesetIdSchema = Type.String({ pattern: "^[0-9a-f]{32}$", description: "Id returned by a preview" });

const refactorOperationSchemas = [
	Type.Object(
		{
			operation: Type.Literal("preview_rename"),
			target: targetSchema,
			newName: Type.String({ minLength: 1, maxLength: MAX_NEW_NAME_LENGTH }),
			expectedName: Type.Optional(
				Type.String({ minLength: 1, description: "The identifier you mean to rename; checked against the source" }),
			),
			definitionId: Type.Optional(nonEmptyString),
			language: Type.Optional(nonEmptyString),
			timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 600_000 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("preview_patch"),
			description: Type.String({ minLength: 1, maxLength: 300 }),
			changes: Type.Array(patchChangeSchema, { minItems: 1, maxItems: MAX_PATCH_FILES }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("apply"), changesetId: changesetIdSchema }, { additionalProperties: false }),
	Type.Object(
		{ operation: Type.Literal("status"), changesetId: Type.Optional(changesetIdSchema) },
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("discard"), changesetId: changesetIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("recover") }, { additionalProperties: false }),
];

export type RefactorToolInput = Static<(typeof refactorOperationSchemas)[number]>;
export type RefactorOperation = RefactorToolInput["operation"];

const refactorSchema = Type.Unsafe<RefactorToolInput>({ type: "object", anyOf: refactorOperationSchemas });

function recordOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function createAllowedArguments(): Record<RefactorOperation, ReadonlySet<string>> {
	const result = {} as Record<RefactorOperation, Set<string>>;
	for (const schema of refactorOperationSchemas) {
		const properties = recordOf(recordOf(schema).properties);
		const operation = recordOf(properties.operation).const;
		if (typeof operation !== "string") continue;
		result[operation as RefactorOperation] = new Set(Object.keys(properties));
	}
	return result;
}

const allowedArguments = createAllowedArguments();

// --- errors ---------------------------------------------------------------------------------------------------

export class RefactorToolInputError extends Error {
	readonly code = "invalid_arguments" as const;
	readonly operation: string;

	constructor(operation: string, message: string) {
		super(message);
		this.name = "RefactorToolInputError";
		this.operation = operation;
	}
}

/** The failure of a refactor operation, named by what the caller can do about it. */
export class RefactorToolError extends Error {
	readonly code: ChangeErrorCode;
	readonly paths: readonly string[];

	constructor(code: ChangeErrorCode, message: string, options: { paths?: readonly string[]; cause?: unknown } = {}) {
		super(`[${code}] ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "RefactorToolError";
		this.code = code;
		this.paths = options.paths ?? [];
	}
}

function toRefactorError(error: unknown): unknown {
	if (isAbortError(error) || error instanceof RefactorToolInputError || error instanceof RefactorToolError)
		return error;
	if (isChangeControlError(error)) {
		return new RefactorToolError(error.code, error.message, { paths: error.paths, cause: error });
	}
	if (error instanceof SemanticBackendError) {
		const code: ChangeErrorCode | undefined =
			error.code === "unsupported_capability" || error.code === "unsupported_language"
				? "CAPABILITY_UNSUPPORTED"
				: error.code === "rename_not_allowed"
					? "RENAME_REFUSED"
					: error.code === "server_unavailable" || error.code === "environment_blocked"
						? "PROJECT_NOT_READY"
						: error.code === "invalid_document_position" || error.code === "unsupported_target"
							? "TARGET_AMBIGUOUS"
							: undefined;
		if (code) return new RefactorToolError(code, error.message, { cause: error });
	}
	if (error instanceof CodeIntelligenceRouterError) {
		const code: ChangeErrorCode | undefined =
			error.code === "semantic_backend_unavailable" || error.code === "unsupported_operation"
				? "CAPABILITY_UNSUPPORTED"
				: error.code === "stale_symbol_id"
					? "SNAPSHOT_STALE"
					: error.code === "unknown_symbol_id" ||
							error.code === "ambiguous_target" ||
							error.code === "unsupported_target"
						? "TARGET_AMBIGUOUS"
						: undefined;
		if (code) return new RefactorToolError(code, error.message, { cause: error });
	}
	return error;
}

// --- validation -----------------------------------------------------------------------------------------------

function fail(operation: string, message: string): never {
	throw new RefactorToolInputError(operation, `${operation} ${message}`);
}

function requireText(value: unknown, operation: string, label: string, maxLength?: number): string {
	if (typeof value !== "string" || value.trim() === "") fail(operation, `requires a non-empty ${label}`);
	if (maxLength !== undefined && value.length > maxLength)
		fail(operation, `${label} is longer than ${maxLength} characters`);
	return value;
}

function validateTarget(value: unknown, operation: string): SymbolTarget {
	const target = recordOf(value);
	if (target.type === "position") {
		const path = requireText(target.path, operation, "target.path");
		const position = recordOf(target.position);
		const { line, character } = position;
		if (
			!Number.isInteger(line) ||
			(line as number) < 0 ||
			!Number.isInteger(character) ||
			(character as number) < 0
		) {
			fail(operation, "position target requires non-negative integer line and character");
		}
		return { type: "position", path, position: { line: line as number, character: character as number } };
	}
	if (target.type === "symbol_id") {
		return { type: "symbol_id", symbolId: requireText(target.symbolId, operation, "target.symbolId") };
	}
	return fail(operation, "target must be a position or a symbol_id");
}

function validatePatchChanges(value: unknown, operation: string): PatchChange[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATCH_FILES) {
		fail(operation, `requires changes with 1 to ${MAX_PATCH_FILES} files`);
	}
	return value.map((entry, index): PatchChange => {
		const change = recordOf(entry);
		const where = `changes[${index}]`;
		for (const key of Object.keys(change)) {
			if (key !== "path" && key !== "edits" && key !== "content")
				fail(operation, `${where} has an unknown field ${key}`);
		}
		const path = requireText(change.path, operation, `${where}.path`);
		const hasEdits = change.edits !== undefined;
		const hasContent = change.content !== undefined;
		if (hasEdits === hasContent)
			fail(operation, `${where} needs exactly one of edits (existing file) or content (new file)`);
		if (hasContent) {
			if (typeof change.content !== "string") fail(operation, `${where}.content must be text`);
			return { path, content: change.content as string };
		}
		const edits = change.edits;
		if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_PATCH_EDITS_PER_FILE) {
			fail(operation, `${where}.edits needs 1 to ${MAX_PATCH_EDITS_PER_FILE} edits`);
		}
		return {
			path,
			edits: (edits as unknown[]).map((raw, editIndex) => {
				const edit = recordOf(raw);
				for (const key of Object.keys(edit)) {
					if (key !== "oldText" && key !== "newText")
						fail(operation, `${where}.edits[${editIndex}] has an unknown field ${key}`);
				}
				if (typeof edit.oldText !== "string" || edit.oldText.length === 0 || typeof edit.newText !== "string") {
					fail(operation, `${where}.edits[${editIndex}] needs non-empty oldText and text newText`);
				}
				return { oldText: edit.oldText as string, newText: edit.newText as string };
			}),
		};
	});
}

function validateChangesetId(value: unknown, operation: string, required: boolean): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !CHANGESET_ID.test(value))
		fail(operation, "requires the changesetId a preview returned");
	return value;
}

export function validateRefactorInput(input: unknown): RefactorToolInput {
	const args = recordOf(input);
	const operation = args.operation;
	if (typeof operation !== "string" || !Object.hasOwn(allowedArguments, operation)) {
		throw new RefactorToolInputError(String(operation ?? ""), "refactor operation is required and must be supported");
	}
	const allowed = allowedArguments[operation as RefactorOperation];
	for (const key of Object.keys(args)) {
		if (args[key] !== undefined && !allowed.has(key)) fail(operation, `does not accept ${key}`);
	}
	if (args.timeoutMs !== undefined) {
		if (
			typeof args.timeoutMs !== "number" ||
			!Number.isFinite(args.timeoutMs) ||
			args.timeoutMs <= 0 ||
			args.timeoutMs > 600_000
		) {
			fail(operation, "timeoutMs must be a finite number in (0, 600000]");
		}
	}
	switch (operation as RefactorOperation) {
		case "preview_rename": {
			validateTarget(args.target, operation);
			requireText(args.newName, operation, "newName", MAX_NEW_NAME_LENGTH);
			for (const label of ["expectedName", "definitionId", "language"] as const) {
				if (args[label] !== undefined) requireText(args[label], operation, label);
			}
			return input as RefactorToolInput;
		}
		case "preview_patch":
			requireText(args.description, operation, "description", 300);
			validatePatchChanges(args.changes, operation);
			return input as RefactorToolInput;
		case "apply":
		case "discard":
			validateChangesetId(args.changesetId, operation, true);
			return input as RefactorToolInput;
		case "status":
			validateChangesetId(args.changesetId, operation, false);
			return input as RefactorToolInput;
		case "recover":
			return input as RefactorToolInput;
	}
}

// --- output ---------------------------------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 14_000;
const MAX_DIFF_LINES_PER_FILE = 40;
const MAX_MENTION_FILES = 10;

export interface RefactorToolDetails {
	operation: RefactorOperation;
	changesetId?: string;
	files?: Array<{ path: string; operation: "modify" | "create"; additions: number; deletions: number }>;
	/** Who approved (apply), or what the policy says (preview). */
	approval?: "policy" | "user" | "needs_user";
	riskReasons?: string[];
	state?: string;
	warnings?: string[];
	outputTruncated?: boolean;
}

function fileLines(changeset: ChangePreview["changeset"]): string[] {
	return changeset.files.map(
		(file) => `  ${file.operation === "create" ? "+" : "~"} ${file.path}  (+${file.additions} -${file.deletions})`,
	);
}

function detailsFiles(changeset: ChangePreview["changeset"]): NonNullable<RefactorToolDetails["files"]> {
	return changeset.files.map((file) => ({
		path: file.path,
		operation: file.operation,
		additions: file.additions,
		deletions: file.deletions,
	}));
}

/** The diffs, cut to what fits: the full result is stored under the changeset id either way. */
function diffSection(preview: ChangePreview): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;
	let budget = MAX_OUTPUT_CHARS - 4_000;
	for (const file of preview.changeset.files) {
		const diff = preview.diffs.get(file.path) ?? "";
		const diffLines = diff.split("\n");
		const shown = diffLines.slice(0, MAX_DIFF_LINES_PER_FILE);
		const text = shown.join("\n");
		if (text.length > budget) {
			lines.push(`... diff of ${file.path} and later files left out; apply stores and writes the complete result`);
			truncated = true;
			break;
		}
		budget -= text.length;
		lines.push(`--- ${file.path}`, text);
		if (diffLines.length > MAX_DIFF_LINES_PER_FILE) {
			lines.push(`... ${diffLines.length - MAX_DIFF_LINES_PER_FILE} more diff lines of ${file.path}`);
			truncated = true;
		}
	}
	return { lines, truncated };
}

function approvalLine(preview: ChangePreview): string {
	return preview.risk.level === "low"
		? "approval: not needed (low risk; the policy approves it)"
		: `approval: the user must approve it, because it ${preview.risk.reasons.join("; ")}`;
}

function finalize(text: string): { text: string; outputTruncated: boolean } {
	if (text.length <= MAX_OUTPUT_CHARS) return { text, outputTruncated: false };
	return {
		text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n... output cut at ${MAX_OUTPUT_CHARS} characters`,
		outputTruncated: true,
	};
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Files that still mention the old name as text but are not part of the rename: unrelated objects, or code no server loaded. */
async function findOtherMentions(
	index: SymbolsIndexPort,
	oldName: string,
	changedPaths: ReadonlySet<string>,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const wordLike = /^[\p{L}\p{N}_$]+$/u.test(oldName);
	const matches = await index.searchCode(wordLike ? `\\b${escapeRegex(oldName)}\\b` : oldName, {
		regex: wordLike,
		limit: 500,
		signal,
	});
	const byPath = new Map<string, { count: number; line: number; text: string }>();
	for (const match of matches) {
		if (changedPaths.has(match.path)) continue;
		const entry = byPath.get(match.path);
		if (entry) entry.count++;
		else byPath.set(match.path, { count: 1, line: match.line, text: match.text.trim().slice(0, 100) });
	}
	if (byPath.size === 0) return [];
	const listed = [...byPath.entries()]
		.slice(0, MAX_MENTION_FILES)
		.map(
			([path, entry]) =>
				`  ${path}:${entry.line + 1}${entry.count > 1 ? ` (+${entry.count - 1} more)` : ""}  ${entry.text}`,
		);
	return [
		`Not renamed: ${byPath.size} other file(s) still mention '${oldName}' as text (unrelated objects, strings, comments, or code the language server did not load). Check them:`,
		...listed,
		...(byPath.size > MAX_MENTION_FILES ? [`  ... and ${byPath.size - MAX_MENTION_FILES} more files`] : []),
	];
}

// --- the tool -------------------------------------------------------------------------------------------------

export interface RefactorToolOptions {
	agentDir?: string;
	codeIntelligence?: SymbolsCodeIntelligenceServices;
	/** The session's change control. Without one, a default over the agent directory is created. */
	changeControl?: ChangeControl;
	/** The session that acts, recorded with every change. */
	sessionId?: () => string | undefined;
}

export function createRefactorToolDefinition(
	cwd: string,
	options?: RefactorToolOptions,
): BusinessToolDefinition<typeof refactorSchema, RefactorToolDetails | undefined> {
	const runtime = createSymbolsToolRuntime(cwd, options);
	let changeControl = options?.changeControl;
	const control = (): ChangeControl => {
		changeControl ??= createChangeControl({
			agentDir: options?.agentDir ?? getAgentDir(),
			workspaceRoot: runtime.workspaceRoot,
		});
		return changeControl;
	};

	async function previewRename(
		input: Extract<RefactorToolInput, { operation: "preview_rename" }>,
		signal: AbortSignal | undefined,
	): Promise<{ text: string; details: RefactorToolDetails }> {
		const target = validateTarget(input.target, "preview_rename");
		const router = runtime.router;
		if (typeof router.rename !== "function") {
			throw new RefactorToolError("CAPABILITY_UNSUPPORTED", "this workspace has no language server that can rename");
		}
		const routing: CodeIntelligenceRoutingOptions = {
			mode: "semantic",
			language: input.language,
			definitionId: input.definitionId,
			timeoutMs: input.timeoutMs ?? 60_000,
			signal,
		};
		let symbolName: string | undefined;
		if (target.type === "symbol_id" && typeof router.resolveSymbol === "function") {
			symbolName = (await router.resolveSymbol(target.symbolId, routing)).items[0]?.name;
			if (symbolName !== undefined && input.expectedName !== undefined && input.expectedName !== symbolName) {
				throw new RefactorToolError(
					"TARGET_AMBIGUOUS",
					`the symbol is '${symbolName}', not '${input.expectedName}'`,
				);
			}
		}
		const result = await router.rename(target, input.newName, routing);
		const proposal = result.items[0];
		if (!proposal) throw new RefactorToolError("RENAME_REFUSED", "the language server proposed no rename");
		if (input.expectedName !== undefined && input.expectedName !== proposal.oldName) {
			throw new RefactorToolError(
				"TARGET_AMBIGUOUS",
				`the position is on '${proposal.oldName}', not '${input.expectedName}'; nothing was previewed`,
			);
		}
		if (symbolName !== undefined && symbolName !== proposal.oldName) {
			throw new RefactorToolError(
				"TARGET_AMBIGUOUS",
				`the symbol is '${symbolName}' but the server would rename '${proposal.oldName}'; use a position target with expectedName`,
			);
		}
		const service = control();
		const preview = await service.previewWorkspaceEdit(proposal.edit, {
			description: `Rename ${proposal.oldName} to ${proposal.newName}`,
			source: "rename",
			knownVersion: documentVersionLookup(proposal.documentVersions, runtime.workspaceRoot),
			rename: { oldName: proposal.oldName },
		});

		const warnings = [...(result.meta.warnings ?? [])];
		let mentions: string[] = [];
		try {
			mentions = await findOtherMentions(
				runtime.index,
				proposal.oldName,
				new Set(preview.changeset.files.map((file) => file.path)),
				signal,
			);
		} catch (error) {
			if (isAbortError(error)) throw error;
			warnings.push("could not scan the workspace for other mentions of the old name");
		}
		const diff = diffSection(preview);
		const text = [
			`[preview_rename] ${preview.changeset.description} (server ${proposal.definitionId}${proposal.prepared ? "" : ", name read from source"})`,
			`changesetId: ${preview.changeset.id}`,
			`files: ${preview.changeset.files.length}`,
			...fileLines(preview.changeset),
			approvalLine(preview),
			...(warnings.length > 0 ? ["warnings:", ...warnings.map((warning) => `  ${warning}`)] : []),
			...mentions,
			"",
			...diff.lines,
			"",
			`Nothing is written yet. Apply it with refactor {"operation":"apply","changesetId":"${preview.changeset.id}"}.`,
		].join("\n");
		return {
			text,
			details: {
				operation: "preview_rename",
				changesetId: preview.changeset.id,
				files: detailsFiles(preview.changeset),
				approval: preview.risk.level === "low" ? "policy" : "needs_user",
				riskReasons: [...preview.risk.reasons],
				warnings,
				outputTruncated: diff.truncated,
			},
		};
	}

	async function previewPatch(
		input: Extract<RefactorToolInput, { operation: "preview_patch" }>,
	): Promise<{ text: string; details: RefactorToolDetails }> {
		const preview = await control().previewPatch(validatePatchChanges(input.changes, "preview_patch"), {
			description: input.description,
		});
		const diff = diffSection(preview);
		const text = [
			`[preview_patch] ${preview.changeset.description}`,
			`changesetId: ${preview.changeset.id}`,
			`files: ${preview.changeset.files.length}`,
			...fileLines(preview.changeset),
			approvalLine(preview),
			"",
			...diff.lines,
			"",
			`Nothing is written yet. Apply it with refactor {"operation":"apply","changesetId":"${preview.changeset.id}"}.`,
		].join("\n");
		return {
			text,
			details: {
				operation: "preview_patch",
				changesetId: preview.changeset.id,
				files: detailsFiles(preview.changeset),
				approval: preview.risk.level === "low" ? "policy" : "needs_user",
				riskReasons: [...preview.risk.reasons],
				outputTruncated: diff.truncated,
			},
		};
	}

	function applied(outcome: ApplyOutcome): { text: string; details: RefactorToolDetails } {
		const { changeset, result } = outcome;
		const notes = [
			...(result.committedAfterCancel
				? ["The request was cancelled after every file had been written; nothing was rolled back."]
				: []),
			...(result.observerError ? [`Follow-up work after the change failed: ${result.observerError}`] : []),
		];
		return {
			text: [
				`[apply] committed ${changeset.id}: ${changeset.description}`,
				...fileLines(changeset),
				`approved by: ${outcome.approvedBy}`,
				...notes,
			].join("\n"),
			details: {
				operation: "apply",
				changesetId: changeset.id,
				files: detailsFiles(changeset),
				approval: outcome.approvedBy,
				state: "committed",
				warnings: notes,
			},
		};
	}

	return {
		name: "refactor",
		label: "refactor",
		description:
			"Controlled changes across files. preview_rename asks the language server for a rename and preview_patch plans exact-text edits and new files over several files; neither writes anything. apply writes a previewed change by its changesetId, after the change gates and approval. status and recover report and finish unfinished changes; discard drops a preview. Each operation accepts only its own parameters.",
		promptSnippet: loadSystemPrompt("tools/refactor/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/refactor/guidelines.md"),
		parameters: refactorSchema,
		async execute(toolCallId, args: RefactorToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const input = validateRefactorInput(args);
			const origin: ChangeOrigin = { kind: "refactor", sessionId: options?.sessionId?.(), toolCallId };
			try {
				let output: { text: string; details: RefactorToolDetails };
				switch (input.operation) {
					case "preview_rename":
						output = await previewRename(input, signal);
						break;
					case "preview_patch":
						output = await previewPatch(input);
						break;
					case "apply":
						output = applied(await control().apply(input.changesetId, { origin, signal }));
						break;
					case "discard":
						control().discard(input.changesetId);
						output = {
							text: `[discard] forgot the preview ${input.changesetId}`,
							details: { operation: "discard", changesetId: input.changesetId },
						};
						break;
					case "status": {
						const status = control().status(input.changesetId);
						output = {
							text: [
								"[status]",
								`mode: ${control().mode}`,
								...(status.entries.length === 0
									? ["no change has been applied yet"]
									: status.entries.map(
											(entry) =>
												`  ${entry.id}  ${entry.state}  ${entry.files.join(", ")}${entry.note ? `  (${entry.note})` : ""}`,
										)),
								...(status.recoveryFailure ? [`recovery on startup failed: ${status.recoveryFailure}`] : []),
							].join("\n"),
							details: { operation: "status", changesetId: input.changesetId },
						};
						break;
					}
					case "recover": {
						const reports = await control().recover();
						output = {
							text: [
								"[recover]",
								...(reports.length === 0
									? ["nothing unfinished"]
									: reports.map(
											(report) =>
												`  ${report.changesetId}  ${report.outcome}${report.restored.length > 0 ? `  restored: ${report.restored.join(", ")}` : ""}${report.conflicts.length > 0 ? `  NOT restored (changed since): ${report.conflicts.join(", ")}` : ""}`,
										)),
							].join("\n"),
							details: { operation: "recover" },
						};
						break;
					}
				}
				const finalized = finalize(output.text);
				return {
					content: [{ type: "text", text: finalized.text }],
					details: {
						...output.details,
						outputTruncated: output.details.outputTruncated || finalized.outputTruncated,
					},
				};
			} catch (error) {
				throw toRefactorError(error);
			}
		},
	};
}

export function createRefactorTool(cwd: string, options?: RefactorToolOptions): AgentTool<typeof refactorSchema> {
	return wrapToolDefinition(createRefactorToolDefinition(cwd, options));
}
