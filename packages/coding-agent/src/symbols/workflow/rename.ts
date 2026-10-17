import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { escapeRegExp, searchWorkspaceText } from "../lexical/search.ts";
import { getWorkspaceIdentity, isInsideWorkspace, normalizeDocumentPath } from "../path-semantics.ts";
import type { CodeFileEdit } from "../types.ts";
import { routingOptions, type WorkflowContext } from "./context.ts";
import { describeFailure, rethrowIfAborted } from "./failure.ts";
import { bareName, locateSymbol, type WorkflowTarget } from "./locate.ts";
import {
	RENAME_PLAN_TTL_MS,
	type RenamePlan,
	type RenamePlanEdit,
	type RenamePlanFile,
	storeRenamePlan,
} from "./rename-plans.ts";
import { clipLine, offsetOf, readSourceSnapshot, type SourceSnapshot, splitLines } from "./text.ts";

/**
 * Semantic rename in two steps.
 *
 * rename_preview asks the language server for the rename's WorkspaceEdit and
 * turns it into a plan: the exact new content of every affected file, the
 * SHA-256 of every file as it was read, and a compact preview. Nothing is
 * written. The plan is refused as a whole when any part of the edit cannot be
 * applied safely (file operations, files outside the workspace, read-only or
 * linked-out files, overlapping or out-of-range edits), so a rename is never
 * applied in part.
 *
 * apply_rename (a separate, mutating tool) writes a plan only when every file
 * still has the hash recorded here; any change in between refuses the whole
 * plan. Text occurrences of the old name that the server did not touch are
 * reported, never edited.
 */

const PREVIEW_LINE_BUDGET = 120;
const LEFTOVER_LIMIT = 25;

export type RenamePreviewOutcome =
	| {
			readonly kind: "planned";
			readonly plan: RenamePlan;
			readonly lines: string[];
			readonly warnings: string[];
			/** The language server could not confirm that its edit set is complete. */
			readonly partial: boolean;
	  }
	| { readonly kind: "refused"; readonly lines: string[]; readonly warnings: string[] };

function isIdentifierLike(name: string): boolean {
	return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name);
}

interface ValidatedFile {
	readonly file?: RenamePlanFile;
	readonly problem?: string;
}

async function validateFile(context: WorkflowContext, fileEdit: CodeFileEdit): Promise<ValidatedFile> {
	const absolutePath = normalizeDocumentPath(fileEdit.path, context.workspaceRoot);
	if (!isInsideWorkspace(context.workspaceRoot, absolutePath))
		return { problem: `${fileEdit.path} is outside the workspace` };
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(absolutePath);
	} catch {
		return { problem: `${fileEdit.path} does not exist` };
	}
	if (info.isSymbolicLink()) {
		try {
			const target = await realpath(absolutePath);
			if (!isInsideWorkspace(context.workspaceRoot, target))
				return { problem: `${fileEdit.path} links to a file outside the workspace` };
		} catch {
			return { problem: `${fileEdit.path} is a broken link` };
		}
	} else if (!info.isFile()) {
		return { problem: `${fileEdit.path} is not a regular file` };
	}
	try {
		await access(absolutePath, constants.W_OK);
	} catch {
		return { problem: `${fileEdit.path} is read-only` };
	}
	let snapshot: SourceSnapshot;
	try {
		snapshot = await readSourceSnapshot(absolutePath);
	} catch (error) {
		return { problem: `${fileEdit.path} cannot be read as UTF-8 text: ${describeFailure(error)}` };
	}
	const spans: Array<{ start: number; end: number; newText: string; line: number }> = [];
	for (const edit of fileEdit.edits) {
		const start = offsetOf(snapshot, edit.range.start);
		const end = offsetOf(snapshot, edit.range.end);
		if (start === undefined || end === undefined || end < start) {
			return {
				problem: `${fileEdit.path}: an edit range (line ${edit.range.start.line + 1}) is outside the current file; the file may have changed`,
			};
		}
		spans.push({ start, end, newText: edit.newText, line: edit.range.start.line });
	}
	spans.sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < spans.length; index++) {
		if (spans[index]!.start < spans[index - 1]!.end)
			return { problem: `${fileEdit.path}: the server returned overlapping edits` };
	}
	let newText = "";
	let cursor = 0;
	const edits: RenamePlanEdit[] = [];
	for (const span of spans) {
		newText += snapshot.text.slice(cursor, span.start) + span.newText;
		cursor = span.end;
		edits.push({ line: span.line, oldText: snapshot.text.slice(span.start, span.end), newText: span.newText });
	}
	newText += snapshot.text.slice(cursor);
	return {
		file: {
			path: fileEdit.path,
			absolutePath,
			sha256: snapshot.sha256,
			bom: snapshot.bom,
			originalText: snapshot.text,
			newText,
			edits,
		},
	};
}

/** Changed lines only: `path`, then `- old` / `+ new` per line that differs. */
function previewLines(files: readonly RenamePlanFile[], oldName: string): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let budget = PREVIEW_LINE_BUDGET;
	let truncated = false;
	for (const file of files) {
		const unusual = file.edits.filter((edit) => edit.oldText !== oldName);
		lines.push(
			`  ${file.path} (${file.edits.length} edit(s)${unusual.length ? `, ${unusual.length} not a plain name replacement` : ""})`,
		);
		const before = splitLines(file.originalText);
		const after = splitLines(file.newText);
		const editLines = [...new Set(file.edits.map((edit) => edit.line))].sort((left, right) => left - right);
		const lineBreaks = (text: string): number => splitLines(text).length - 1;
		for (const line of editLines) {
			if (budget <= 0) {
				truncated = true;
				break;
			}
			// Edits that add or remove line breaks above this line move it in the new text.
			const shift = file.edits
				.filter((edit) => edit.line < line)
				.reduce((sum, edit) => sum + lineBreaks(edit.newText) - lineBreaks(edit.oldText), 0);
			lines.push(`    ${line + 1}| - ${clipLine(before[line] ?? "", 180)}`);
			lines.push(`    ${line + 1}| + ${clipLine(after[line + shift] ?? "", 180)}`);
			budget -= 2;
		}
		for (const edit of unusual.slice(0, 5)) {
			lines.push(
				`    ! line ${edit.line + 1}: replaces ${JSON.stringify(clipLine(edit.oldText, 60))} with ${JSON.stringify(clipLine(edit.newText, 60))}`,
			);
		}
		if (budget <= 0) {
			truncated = true;
			break;
		}
	}
	return { lines, truncated };
}

/** Create (but do not apply) a rename plan for the symbol at `target`. */
export async function previewRename(
	context: WorkflowContext,
	target: WorkflowTarget,
	newName: string,
): Promise<RenamePreviewOutcome> {
	const warnings: string[] = [];
	const trimmed = newName.trim();
	if (trimmed === "" || trimmed !== newName) {
		return {
			kind: "refused",
			lines: ["[refused] newName must be a non-empty name without surrounding spaces"],
			warnings,
		};
	}
	if (typeof context.router.rename !== "function") {
		return {
			kind: "refused",
			lines: ["[refused] the semantic router does not support rename in this session"],
			warnings,
		};
	}
	let located: Awaited<ReturnType<typeof locateSymbol>>;
	try {
		located = await locateSymbol(context, target);
	} catch (error) {
		rethrowIfAborted(error, context.signal);
		return {
			kind: "refused",
			lines: [
				`[refused] semantic rename needs a working language server for this file: ${describeFailure(error)}`,
				"Nothing was changed. A text replacement is not a safe substitute; use impact to find the sites and edit them one by one if you must proceed.",
			],
			warnings,
		};
	}
	if (located.kind !== "found") {
		const list = located.kind === "ambiguous" ? located.candidates : located.suggestions;
		return {
			kind: "refused",
			lines: [
				located.kind === "ambiguous"
					? `[refused] several declarations match in ${located.path}; repeat with one namePath:`
					: `[refused] ${located.reason}`,
				...list.map(
					(symbol) =>
						`  ${symbol.path}:${(symbol.selectionRange?.start.line ?? 0) + 1} ${symbol.kind} ${symbol.namePath}`,
				),
			],
			warnings: [...located.warnings],
		};
	}
	warnings.push(...located.warnings);
	const symbol = located.symbol;
	if (!symbol.selectionRange) {
		return { kind: "refused", lines: ["[refused] the declaration has no precise name position"], warnings };
	}
	const oldName = bareName(symbol.name);
	if (oldName === trimmed)
		return { kind: "refused", lines: ["[refused] the new name equals the current name"], warnings };
	if (!isIdentifierLike(trimmed))
		warnings.push(`"${trimmed}" is not a plain identifier; the language server decides whether it is valid`);
	let result: Awaited<ReturnType<NonNullable<typeof context.router.rename>>>;
	try {
		result = await context.router.rename(
			{ type: "position", path: symbol.path, position: symbol.selectionRange.start },
			trimmed,
			routingOptions(context),
		);
	} catch (error) {
		rethrowIfAborted(error, context.signal);
		return {
			kind: "refused",
			lines: [
				`[refused] the language server did not produce a rename: ${describeFailure(error)}`,
				"Nothing was changed.",
			],
			warnings,
		};
	}
	warnings.push(...(result.meta.warnings ?? []));
	if (result.unsupportedChanges.length > 0) {
		return {
			kind: "refused",
			lines: [
				"[refused] the rename includes changes that cannot be applied safely, so none of it is planned:",
				...result.unsupportedChanges.map((change) => `  - ${change}`),
				"Nothing was changed.",
			],
			warnings,
		};
	}
	if (result.items.length === 0) {
		return {
			kind: "refused",
			lines: ["[refused] the language server returned no edits for this rename. Nothing was changed."],
			warnings,
		};
	}
	const files: RenamePlanFile[] = [];
	const problems: string[] = [];
	for (const fileEdit of result.items) {
		const validated = await validateFile(context, fileEdit);
		if (validated.problem) problems.push(validated.problem);
		else if (validated.file) files.push(validated.file);
	}
	if (problems.length > 0) {
		return {
			kind: "refused",
			lines: [
				"[refused] some files of the rename cannot be written safely, so none of it is planned:",
				...problems.map((problem) => `  - ${problem}`),
				"Nothing was changed.",
			],
			warnings,
		};
	}
	files.sort((left, right) => left.path.localeCompare(right.path));

	const lines: string[] = [];
	const editCount = files.reduce((sum, file) => sum + file.edits.length, 0);
	const now = Date.now();
	const plan: RenamePlan = {
		id: `rn_${randomBytes(6).toString("hex")}`,
		workspaceRoot: context.workspaceRoot,
		workspaceIdentity: getWorkspaceIdentity(context.workspaceRoot),
		createdAt: now,
		expiresAt: now + RENAME_PLAN_TTL_MS,
		oldName,
		newName: trimmed,
		target: `${symbol.kind} ${symbol.namePath} (${symbol.path}:${symbol.selectionRange.start.line + 1})`,
		files,
	};
	lines.push(
		`[plan] ${plan.id}: rename ${plan.target} -> ${trimmed}; ${editCount} edit(s) in ${files.length} file(s), computed by the language server`,
	);
	const preview = previewLines(files, oldName);
	lines.push(...preview.lines);
	if (preview.truncated) lines.push("  … preview truncated; apply_rename reports every file it writes");

	const collisions = files.filter((file) =>
		new RegExp(
			`(?<![\\p{L}\\p{N}_$])${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_$])`,
			"u",
		).test(file.originalText),
	);
	if (collisions.length > 0) {
		lines.push(
			`[check] "${trimmed}" already occurs in ${collisions.length} edited file(s) (${collisions
				.slice(0, 5)
				.map((file) => file.path)
				.join(
					", ",
				)}); the new name may shadow or collide with another declaration — run diagnostics after applying`,
		);
	}
	const text = await searchWorkspaceText({
		workspaceRoot: context.workspaceRoot,
		patterns: [oldName],
		fixedStrings: true,
		wordRegexp: true,
		maxMatches: 2_000,
		signal: context.signal,
	});
	// Edited files are checked in their planned new text, so an occurrence on an
	// edited line (a string next to a renamed call) is still reported.
	const editedPaths = new Set(files.map((file) => file.path.toLowerCase()));
	const word = new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(oldName)}(?![\\p{L}\\p{N}_$])`, "u");
	const leftovers: { path: string; line: number; text: string }[] = [];
	for (const file of files) {
		splitLines(file.newText).forEach((lineText, line) => {
			if (word.test(lineText)) leftovers.push({ path: file.path, line, text: lineText });
		});
	}
	for (const match of text.matches) if (!editedPaths.has(match.path.toLowerCase())) leftovers.push(match);
	leftovers.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
	lines.push(
		`[not changed] ${leftovers.length} line(s) still contain the word "${oldName}" outside the planned edits: comments, strings, config, other languages, dynamic access, or different entities with the same name. They stay as they are; review the ones that refer to this symbol.`,
	);
	for (const match of leftovers.slice(0, LEFTOVER_LIMIT))
		lines.push(`  ${match.path}:${match.line + 1} | ${clipLine(match.text)}`);
	if (leftovers.length > LEFTOVER_LIMIT) lines.push(`  … ${leftovers.length - LEFTOVER_LIMIT} more`);
	if (text.error) warnings.push(`text search for leftovers failed: ${text.error}`);
	lines.push(
		`[next] apply with apply_rename planId=${plan.id} (valid ${Math.round(RENAME_PLAN_TTL_MS / 60000)} minutes; refused if any file changes before then). Afterwards run diagnostics or the project's type check.`,
	);
	storeRenamePlan(plan);
	return { kind: "planned", plan, lines, warnings, partial: result.meta.completeness === "partial" };
}
