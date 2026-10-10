import { lstat, mkdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";
import { writeFileAtomically } from "../../utils/atomic-write.ts";
import type { BusinessToolDefinition } from "../contracts/index.ts";
import { pathExists, resolveToCwd } from "../path-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { type PatchHunk, type PatchOperation, parseApplyPatch } from "./apply-patch-parser.ts";
import {
	countLineChanges,
	detectLineEnding,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { committedAfterCancel } from "./mutation-result.ts";
import {
	assertFileWasReadBefore,
	canonicalFilePathKey,
	recordFileStateAfterMutation,
	resolveFileStateScope,
	statFileReadState,
} from "./read-state.ts";

const applyPatchSchema = Type.Object(
	{
		patch: Type.String({
			description:
				"The whole patch, from *** Begin Patch to *** End Patch. Relative paths are resolved against the working directory.",
		}),
	},
	{},
);

export type ApplyPatchToolInput = Static<typeof applyPatchSchema>;

export interface ApplyPatchFileDetails {
	/** "move" is an update that also renames the file. */
	operation: "add" | "update" | "delete" | "move";
	/** The path as written in the patch: the new file for add, the existing file otherwise. */
	path: string;
	/** Destination of a move, as written in the patch. */
	movedTo?: string;
	/** Display diff of the content change, when the content changed. */
	diff?: string;
	linesAdded: number;
	linesRemoved: number;
}

export interface ApplyPatchToolDetails {
	files: ApplyPatchFileDetails[];
	/** The writes were committed after cancellation arrived. */
	mutationStatus?: "committed-after-cancel";
}

const APPLY_PATCH_DESCRIPTION = [
	"Applies one patch that adds, updates, deletes and moves any number of files. The patch is applied atomically: either every change is written or none is.",
	'The patch starts with "*** Begin Patch" and ends with "*** End Patch". Each file section is one of:',
	'- "*** Add File: <path>": every following line starts with "+" and is the complete new file. The file must not exist yet.',
	'- "*** Delete File: <path>": no body.',
	'- "*** Update File: <path>": optionally followed by "*** Move to: <new path>", then one or more hunks.',
	'A hunk starts with "@@" (text after it is optional and names a line, such as a function signature, that the hunk follows). Its lines start with " " (context, must match the file), "-" (remove) or "+" (add). Hunks appear in file order. "*** End of File" after a hunk means the hunk belongs at the end of the file.',
	"Read an existing file with the read tool before changing or deleting it. A file that was never read, or changed since it was read, is refused.",
].join("\n");

/**
 * Matching ladder for hunk lines, tried in order. Each step is looser than the one before, and the first
 * step that finds the hunk wins. The last step also folds typographic punctuation (curly quotes, dashes,
 * special spaces) through the same normalisation the edit tool uses.
 */
const MATCH_STEPS: ReadonlyArray<(line: string) => string> = [
	(line) => line,
	(line) => line.trimEnd(),
	(line) => line.trim(),
	(line) => normalizeForFuzzyMatch(line).trim(),
];

interface MatchLevel {
	match: (line: string) => string;
	lines: string[];
}

interface Replacement {
	/** Index of the first replaced line in the original file. */
	start: number;
	/** Number of original lines the replacement covers. */
	oldLength: number;
	lines: string[];
}

/** One planned change to one file, computed in memory before anything is written. */
interface ChangeBase {
	path: string;
	absolutePath: string;
	diff?: string;
	linesAdded: number;
	linesRemoved: number;
}

type FileChange =
	| (ChangeBase & { operation: "add"; after: string })
	| (ChangeBase & { operation: "update"; before: Uint8Array; after?: string })
	| (ChangeBase & { operation: "delete"; before: Uint8Array })
	| (ChangeBase & {
			operation: "move";
			movedTo: string;
			destinationPath: string;
			before: Uint8Array;
			after: string | Uint8Array;
	  });

interface PlannedOperation {
	op: PatchOperation;
	absolutePath: string;
	destinationPath?: string;
}

/** One write or removal on disk, with the way back to the state before the patch. */
interface WriteStep {
	description: string;
	run: () => Promise<void>;
	undo: () => Promise<void>;
}

export function createApplyPatchToolDefinition(
	cwd: string,
): BusinessToolDefinition<typeof applyPatchSchema, ApplyPatchToolDetails | undefined> {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet: loadSystemPrompt("tools/apply-patch/snippet.md"),
		parameters: applyPatchSchema,
		async execute(_toolCallId, input: ApplyPatchToolInput, signal?: AbortSignal, onUpdate?, ctx?) {
			const operations = parseApplyPatch(input.patch);
			const plan = await planPatch(operations, cwd);
			const scope = resolveFileStateScope(ctx);

			// Everything from the read gate to the last write runs under the queues of every file the patch
			// touches, so a concurrent edit or write cannot change a file between the check and the write.
			return withFileQueues(plan.lockPaths, async () => {
				// Checking signal.aborted after each await keeps the queues locked until the current operation has
				// settled, the same way the edit tool does.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				const changes: FileChange[] = [];
				for (const entry of plan.entries) {
					changes.push(await computeChange(entry, scope));
					throwIfAborted();
				}

				const files = changes.map(detailsOf);
				// The validated change set, reported while the writes are still to come.
				onUpdate?.({ content: [], details: { files } });
				throwIfAborted();

				await runWriteSteps(changes.flatMap(stepsFor));
				for (const change of changes) {
					await recordFileStateAfterMutation(change.absolutePath, scope);
					if (change.operation === "move") await recordFileStateAfterMutation(change.destinationPath, scope);
				}

				const mutation = committedAfterCancel(signal);
				return {
					content: [{ type: "text", text: summarize(files) }],
					details: { files, ...(mutation ? { mutationStatus: mutation.mutationStatus } : {}) },
				};
			});
		},
	};
}

export function createApplyPatchTool(
	cwd: string,
): AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails | undefined> {
	return wrapToolDefinition(createApplyPatchToolDefinition(cwd));
}

/**
 * Resolve every path the patch names, and refuse a patch in which one file appears twice (including as a
 * move source or destination). Returns the lock order: one representative path per file, sorted by identity,
 * so two patches that touch the same files always acquire them in the same order.
 */
async function planPatch(
	operations: readonly PatchOperation[],
	cwd: string,
): Promise<{ entries: PlannedOperation[]; lockPaths: string[] }> {
	const entries: PlannedOperation[] = operations.map((op) => ({
		op,
		absolutePath: resolveToCwd(op.path, cwd),
		destinationPath: op.type === "update" && op.moveTo !== undefined ? resolveToCwd(op.moveTo, cwd) : undefined,
	}));

	const claimed = new Map<string, { path: string; line: number }>();
	const targets: Array<{ identity: string; absolutePath: string }> = [];
	const claim = async (path: string, absolutePath: string, line: number): Promise<void> => {
		const identity = await fileIdentity(absolutePath);
		const previous = claimed.get(identity);
		if (previous) throw conflictError(path, line, previous);
		claimed.set(identity, { path, line });
		targets.push({ identity, absolutePath });
	};

	for (const entry of entries) {
		await claim(entry.op.path, entry.absolutePath, entry.op.line);
		if (entry.op.type === "update" && entry.op.moveTo !== undefined && entry.destinationPath !== undefined) {
			await claim(entry.op.moveTo, entry.destinationPath, entry.op.line);
		}
	}

	targets.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
	return { entries, lockPaths: targets.map((target) => target.absolutePath) };
}

function conflictError(path: string, line: number, previous: { path: string; line: number }): Error {
	if (previous.line === line) {
		return new Error(
			`Invalid patch at line ${line}: the Move to target ${path} is the same file as ${previous.path}.`,
		);
	}
	return new Error(
		`Invalid patch at line ${line}: ${path} is the same file as ${previous.path} (line ${previous.line}). Put every change to one file in a single *** Update File section.`,
	);
}

/**
 * Stable key for "the same file": the real path when the file exists, otherwise its real directory plus its
 * name. Two different spellings of one file (symlinks, junctions, case on Windows) get the same key.
 */
async function fileIdentity(absolutePath: string): Promise<string> {
	try {
		return canonicalFilePathKey(await realpath(absolutePath));
	} catch {
		// The file does not exist yet, or cannot be resolved: fall through to its directory.
	}
	try {
		return canonicalFilePathKey(join(await realpath(dirname(absolutePath)), basename(absolutePath)));
	} catch {
		return canonicalFilePathKey(absolutePath);
	}
}

/** Take the queues of the given files, one after another in the given order (sorted by the caller). */
async function withFileQueues<T>(paths: readonly string[], task: () => Promise<T>): Promise<T> {
	const [first, ...rest] = paths;
	if (first === undefined) return task();
	return withFileMutationQueue(first, () => withFileQueues(rest, task));
}

async function computeChange(entry: PlannedOperation, scope: string): Promise<FileChange> {
	const { op, absolutePath } = entry;

	if (op.type === "add") {
		if (await entryExists(absolutePath)) {
			throw new Error(
				`Could not add ${op.path}: the file already exists. Use an *** Update File section to change it.`,
			);
		}
		const counts = countLineChanges(undefined, op.content);
		return {
			operation: "add",
			path: op.path,
			absolutePath,
			after: op.content,
			diff: generateDiffString("", op.content).diff,
			linesAdded: counts.additions,
			linesRemoved: counts.deletions,
		};
	}

	if (op.type === "delete") {
		await requireRegularFile(absolutePath, op.path, "delete");
		// A file the model has not read, or that changed since it was read, is refused.
		await assertFileWasReadBefore(absolutePath, "edit", op.path, scope);
		const before = await readFile(absolutePath);
		const text = normalizeToLF(stripBom(before.toString("utf-8")).text);
		const counts = countLineChanges(text, "");
		return {
			operation: "delete",
			path: op.path,
			absolutePath,
			before,
			diff: generateDiffString(text, "").diff,
			linesAdded: counts.additions,
			linesRemoved: counts.deletions,
		};
	}

	await requireRegularFile(absolutePath, op.path, "update");
	await assertFileWasReadBefore(absolutePath, "edit", op.path, scope);
	const before = await readFile(absolutePath);
	const { bom, text } = stripBom(before.toString("utf-8"));
	const oldText = normalizeToLF(text);
	const newText = op.hunks.length === 0 ? oldText : applyHunksToText(oldText, op.hunks, op.path);
	const changed = newText !== oldText;
	const counts = changed ? countLineChanges(oldText, newText) : { additions: 0, deletions: 0 };
	const diff = changed ? generateDiffString(oldText, newText).diff : undefined;
	// Line endings and the byte order mark are kept as the file had them.
	const content = changed ? bom + restoreLineEndings(newText, detectLineEnding(text)) : undefined;
	const destinationPath = entry.destinationPath;

	if (op.moveTo === undefined || destinationPath === undefined) {
		return {
			operation: "update",
			path: op.path,
			absolutePath,
			before,
			...(content !== undefined ? { after: content } : {}),
			...(diff !== undefined ? { diff } : {}),
			linesAdded: counts.additions,
			linesRemoved: counts.deletions,
		};
	}

	if (await entryExists(destinationPath)) {
		throw new Error(`Could not move ${op.path} to ${op.moveTo}: the target already exists.`);
	}
	return {
		operation: "move",
		path: op.path,
		movedTo: op.moveTo,
		absolutePath,
		destinationPath,
		before,
		// A pure rename keeps the original bytes exactly.
		after: content ?? before,
		...(diff !== undefined ? { diff } : {}),
		linesAdded: counts.additions,
		linesRemoved: counts.deletions,
	};
}

async function requireRegularFile(absolutePath: string, path: string, action: "update" | "delete"): Promise<void> {
	if ((await statFileReadState(absolutePath)) === undefined) {
		throw new Error(`Could not ${action} ${path}: the file does not exist or is not a regular file.`);
	}
}

async function entryExists(absolutePath: string): Promise<boolean> {
	try {
		await lstat(absolutePath);
		return true;
	} catch {
		return false;
	}
}

/** Apply the hunks to LF-normalised text, keeping whether the text ends with a line break. */
function applyHunksToText(text: string, hunks: readonly PatchHunk[], displayPath: string): string {
	const endsWithLineBreak = text.endsWith("\n");
	const lines = text === "" ? [] : (endsWithLineBreak ? text.slice(0, -1) : text).split("\n");
	const updated = applyHunksToLines(lines, hunks, displayPath);
	if (updated.length === 0) return "";
	return `${updated.join("\n")}${endsWithLineBreak ? "\n" : ""}`;
}

function applyHunksToLines(lines: readonly string[], hunks: readonly PatchHunk[], displayPath: string): string[] {
	const levels: MatchLevel[] = MATCH_STEPS.map((match) => ({ match, lines: lines.map(match) }));
	const replacements: Replacement[] = [];
	let cursor = 0;
	for (const [index, hunk] of hunks.entries()) {
		// Each hunk is searched from the end of the previous one, so hunks keep the file's order.
		const replacement = locateHunk({ lines, levels, hunk, cursor, index, count: hunks.length, displayPath });
		replacements.push(replacement);
		cursor = replacement.start + replacement.oldLength;
	}

	const result: string[] = [];
	let position = 0;
	for (const replacement of replacements) {
		for (; position < replacement.start; position++) result.push(lines[position] ?? "");
		for (const line of replacement.lines) result.push(line);
		position = replacement.start + replacement.oldLength;
	}
	for (; position < lines.length; position++) result.push(lines[position] ?? "");
	return result;
}

interface LocateInput {
	lines: readonly string[];
	levels: readonly MatchLevel[];
	hunk: PatchHunk;
	cursor: number;
	index: number;
	count: number;
	displayPath: string;
}

function locateHunk(input: LocateInput): Replacement {
	const { lines, levels, hunk, cursor, index, count, displayPath } = input;
	const hunkName = `hunk ${index + 1} of ${count} to ${displayPath}`;

	let searchFrom = cursor;
	let anchorAt: number | undefined;
	if (hunk.anchor !== undefined) {
		anchorAt = findAnchor(levels, hunk.anchor, cursor);
		if (anchorAt === undefined) {
			throw new Error(
				`Could not apply ${hunkName}: no line matches the @@ locating text ${JSON.stringify(hunk.anchor)} at or after line ${cursor + 1}.`,
			);
		}
		// The hunk may start on the anchor line itself, so the search is inclusive.
		searchFrom = anchorAt;
	}

	const oldLines = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
	if (oldLines.length === 0) {
		// Only added lines: they need a known position, either the end of the file or the line after the anchor.
		const added = hunk.lines.map((line) => line.text);
		if (hunk.endOfFile) return { start: lines.length, oldLength: 0, lines: added };
		if (anchorAt !== undefined) return { start: anchorAt + 1, oldLength: 0, lines: added };
		throw new Error(
			`Could not apply ${hunkName}: a hunk with only added lines needs an @@ locating text or *** End of File to say where they go.`,
		);
	}

	const start = findSequence(levels, oldLines, searchFrom, hunk.endOfFile);
	if (start === undefined) {
		const preview = hunk.lines
			.filter((line) => line.kind !== "+")
			.slice(0, 3)
			.map((line) => `${line.kind}${line.text}`)
			.join("\n");
		throw new Error(
			`Could not apply ${hunkName}: its context and removed lines were not found at or after line ${searchFrom + 1}${hunk.endOfFile ? " (matched from the end of the file)" : ""}. The hunk starts with:\n${preview}\nRead the file again and send lines that match it exactly.`,
		);
	}

	// Context lines keep the file's own text, so unchanged lines are not rewritten.
	const replaced: string[] = [];
	let source = start;
	for (const line of hunk.lines) {
		if (line.kind === " ") {
			replaced.push(lines[source] ?? "");
			source++;
		} else if (line.kind === "-") {
			source++;
		} else {
			replaced.push(line.text);
		}
	}
	return { start, oldLength: oldLines.length, lines: replaced };
}

/** First line at or after `from` that matches the anchor, trying the matching ladder in order. */
function findAnchor(levels: readonly MatchLevel[], anchor: string, from: number): number | undefined {
	for (const level of levels) {
		const needle = level.match(anchor);
		for (let at = from; at < level.lines.length; at++) {
			if (level.lines[at] === needle) return at;
		}
	}
	return undefined;
}

/** First position at or after `from` where the lines match, trying the matching ladder in order. */
function findSequence(
	levels: readonly MatchLevel[],
	needleLines: readonly string[],
	from: number,
	endOfFile: boolean,
): number | undefined {
	for (const level of levels) {
		const needle = needleLines.map((line) => level.match(line));
		const found = searchSequence(level.lines, needle, from, endOfFile);
		if (found !== undefined) return found;
	}
	return undefined;
}

function searchSequence(
	haystack: readonly string[],
	needle: readonly string[],
	from: number,
	endOfFile: boolean,
): number | undefined {
	const last = haystack.length - needle.length;
	const matchesAt = (at: number): boolean => needle.every((line, offset) => haystack[at + offset] === line);
	if (endOfFile) {
		// A hunk marked *** End of File is matched from the end of the file backwards.
		for (let at = last; at >= from; at--) {
			if (matchesAt(at)) return at;
		}
		return undefined;
	}
	for (let at = from; at <= last; at++) {
		if (matchesAt(at)) return at;
	}
	return undefined;
}

function detailsOf(change: FileChange): ApplyPatchFileDetails {
	return {
		operation: change.operation,
		path: change.path,
		...(change.operation === "move" ? { movedTo: change.movedTo } : {}),
		...(change.diff !== undefined ? { diff: change.diff } : {}),
		linesAdded: change.linesAdded,
		linesRemoved: change.linesRemoved,
	};
}

/** One line of the result text: A (added), D (deleted), M (modified) or R (renamed, with counts when content changed). */
function summaryRow(file: ApplyPatchFileDetails): string {
	const counts = `(+${file.linesAdded} -${file.linesRemoved})`;
	if (file.operation === "add") return `A ${file.path}`;
	if (file.operation === "delete") return `D ${file.path}`;
	if (file.operation === "update") return `M ${file.path} ${counts}`;
	const changed = file.linesAdded + file.linesRemoved > 0;
	return `R ${file.path} -> ${file.movedTo ?? ""}${changed ? ` ${counts}` : ""}`;
}

function summarize(files: readonly ApplyPatchFileDetails[]): string {
	return [`Applied patch to ${files.length} file(s):`, ...files.map(summaryRow)].join("\n");
}

function stepsFor(change: FileChange): WriteStep[] {
	switch (change.operation) {
		case "add":
			return [createFileStep(change.path, change.absolutePath, change.after)];
		case "update":
			return change.after === undefined
				? []
				: [replaceFileStep(change.path, change.absolutePath, change.after, change.before)];
		case "delete":
			return [removeFileStep(change.path, change.absolutePath, change.before)];
		case "move":
			return [
				createFileStep(change.movedTo, change.destinationPath, change.after),
				removeFileStep(change.path, change.absolutePath, change.before),
			];
	}
}

function createFileStep(displayPath: string, absolutePath: string, content: string | Uint8Array): WriteStep {
	let madeDirectories: string[] = [];
	return {
		description: `create ${displayPath}`,
		run: async () => {
			madeDirectories = await missingDirectories(dirname(absolutePath));
			try {
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFileAtomically(absolutePath, content);
			} catch (error) {
				await removeDirectories(madeDirectories);
				throw error;
			}
		},
		undo: async () => {
			await unlinkIfExists(absolutePath);
			await removeDirectories(madeDirectories);
		},
	};
}

function replaceFileStep(
	displayPath: string,
	absolutePath: string,
	content: string | Uint8Array,
	before: Uint8Array,
): WriteStep {
	return {
		description: `write ${displayPath}`,
		run: () => writeFileAtomically(absolutePath, content),
		undo: () => writeFileAtomically(absolutePath, before),
	};
}

function removeFileStep(displayPath: string, absolutePath: string, before: Uint8Array): WriteStep {
	return {
		description: `delete ${displayPath}`,
		run: () => unlink(absolutePath),
		undo: () => writeFileAtomically(absolutePath, before),
	};
}

/**
 * Run the steps in order. If one fails, the steps already done are undone in reverse, and the error says which
 * files were restored, which could not be restored, and which were never written.
 */
async function runWriteSteps(steps: readonly WriteStep[]): Promise<void> {
	const done: WriteStep[] = [];
	for (const [index, step] of steps.entries()) {
		try {
			await step.run();
			done.push(step);
		} catch (error) {
			throw await writeFailure(error, step, done, steps.slice(index + 1));
		}
	}
}

async function writeFailure(
	error: unknown,
	failed: WriteStep,
	done: readonly WriteStep[],
	notAttempted: readonly WriteStep[],
): Promise<Error> {
	const restored: string[] = [];
	const unrestored: string[] = [];
	for (const step of [...done].reverse()) {
		try {
			await step.undo();
			restored.push(step.description);
		} catch (undoError) {
			unrestored.push(`${step.description} (${messageOf(undoError)})`);
		}
	}

	const parts = [`apply_patch could not finish: ${messageOf(error)}.`];
	if (restored.length > 0) parts.push(`Written and then restored to their earlier state: ${restored.join(", ")}.`);
	if (unrestored.length > 0) parts.push(`Could not restore: ${unrestored.join(", ")}. Check these files by hand.`);
	const notWritten = [failed.description, ...notAttempted.map((step) => step.description)];
	parts.push(`Not written: ${notWritten.join(", ")}.`);
	return new Error(parts.join(" "));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The directories that do not exist yet, deepest first. */
async function missingDirectories(directory: string): Promise<string[]> {
	const missing: string[] = [];
	let current = directory;
	while (!(await pathExists(current))) {
		missing.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return missing;
}

/** Remove the directories a step created, deepest first. Only empty directories go; others are left alone. */
async function removeDirectories(directories: readonly string[]): Promise<void> {
	for (const directory of directories) {
		try {
			await rmdir(directory);
		} catch {
			// Not empty, or already gone: leave it.
		}
	}
}

async function unlinkIfExists(absolutePath: string): Promise<void> {
	try {
		await unlink(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
