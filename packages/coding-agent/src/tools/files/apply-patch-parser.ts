/**
 * Parser for the apply_patch format. It is pure: it reads no file and writes none, so a whole
 * patch is validated before any path is resolved or any byte is touched.
 *
 *   *** Begin Patch
 *   *** Add File: <path>       every following line starts with "+"; together they are the new file
 *   *** Delete File: <path>    no body
 *   *** Update File: <path>    optional "*** Move to: <new path>", then one or more hunks
 *   @@ <optional locating text>
 *    context line              " " prefix: must match the file
 *   -removed line              "-" prefix
 *   +added line                "+" prefix
 *   *** End of File            optional: the hunk belongs at the end of the file
 *   *** End Patch
 */

export interface PatchLine {
	/** " " for a context line, "-" for a removed line, "+" for an added line. */
	kind: " " | "-" | "+";
	/** The line without its one-character prefix. */
	text: string;
}

export interface PatchHunk {
	/** Text after "@@" that locates the hunk, when one was given. */
	anchor?: string;
	/** Context, removed and added lines in patch order. */
	lines: PatchLine[];
	/** "*** End of File" follows the hunk, so it belongs at the end of the file. */
	endOfFile: boolean;
	/** 1-based line of the hunk header (or of its first line when the hunk has no "@@"). */
	line: number;
}

export type PatchOperation =
	| { type: "add"; path: string; content: string; line: number }
	| { type: "delete"; path: string; line: number }
	| { type: "update"; path: string; moveTo?: string; hunks: PatchHunk[]; line: number };

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

function fail(line: number, message: string): never {
	throw new Error(`Invalid patch at line ${line}: ${message}`);
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

/** Index of the first non-blank line at or after `index` (or `lines.length`). */
function skipBlank(lines: readonly string[], index: number): number {
	let next = index;
	while (next < lines.length && isBlank(lines[next] ?? "")) next++;
	return next;
}

function pathAfter(line: string, prefix: string, lineNumber: number): string {
	const path = line.slice(prefix.length).trim();
	if (path === "") fail(lineNumber, `"${prefix.trim()}" must be followed by a file path`);
	return path;
}

/** Parse one apply_patch text into file operations. Throws an Error that names the offending line. */
export function parseApplyPatch(patch: string): PatchOperation[] {
	if (patch.trim() === "") throw new Error("Invalid patch: the patch is empty.");
	const lines = patch.split(/\r?\n/);
	let index = skipBlank(lines, 0);
	if ((lines[index] ?? "").trimEnd() !== BEGIN_PATCH) {
		fail(index + 1, `the patch must start with "${BEGIN_PATCH}"`);
	}
	index++;

	const operations: PatchOperation[] = [];
	let ended = false;
	while (index < lines.length && !ended) {
		const line = lines[index] ?? "";
		const lineNumber = index + 1;

		if (isBlank(line)) {
			index++;
			continue;
		}
		if (line.trimEnd() === END_PATCH) {
			ended = true;
			index++;
			continue;
		}

		if (line.startsWith(ADD_FILE)) {
			const path = pathAfter(line, ADD_FILE, lineNumber);
			index++;
			const contents: string[] = [];
			while (index < lines.length) {
				const body = lines[index] ?? "";
				if (body.startsWith("***")) break;
				if (isBlank(body)) {
					// Blank lines before the next section or the end of the patch are separators, not content.
					const next = skipBlank(lines, index);
					const nextLine = lines[next];
					if (nextLine === undefined || nextLine.startsWith("***")) {
						index = next;
						break;
					}
					fail(index + 1, 'every line of an Add File section must start with "+"');
				}
				if (!body.startsWith("+")) fail(index + 1, 'every line of an Add File section must start with "+"');
				contents.push(body.slice(1));
				index++;
			}
			// Every content line is one complete line of the new file, so the file ends with a line break.
			operations.push({
				type: "add",
				path,
				content: contents.map((text) => `${text}\n`).join(""),
				line: lineNumber,
			});
			continue;
		}

		if (line.startsWith(DELETE_FILE)) {
			const path = pathAfter(line, DELETE_FILE, lineNumber);
			index = skipBlank(lines, index + 1);
			const nextLine = lines[index];
			if (nextLine !== undefined && !nextLine.startsWith("***")) {
				fail(index + 1, '"*** Delete File" takes no content lines');
			}
			operations.push({ type: "delete", path, line: lineNumber });
			continue;
		}

		if (line.startsWith(UPDATE_FILE)) {
			const path = pathAfter(line, UPDATE_FILE, lineNumber);
			index++;
			let moveTo: string | undefined;
			const moveLine = lines[index] ?? "";
			if (moveLine.startsWith(MOVE_TO)) {
				moveTo = pathAfter(moveLine, MOVE_TO, index + 1);
				index++;
			}

			const hunks: PatchHunk[] = [];
			let current: PatchHunk | undefined;
			let closed = false;
			while (index < lines.length) {
				const body = lines[index] ?? "";
				const bodyNumber = index + 1;

				if (body.startsWith("***")) {
					if (body.trimEnd() !== END_OF_FILE) break;
					if (!current || current.lines.length === 0) {
						fail(bodyNumber, `"${END_OF_FILE}" must come after the lines of a hunk`);
					}
					current.endOfFile = true;
					closed = true;
					index++;
					continue;
				}

				if (body.startsWith("@@")) {
					if (current && current.lines.length === 0) fail(current.line, "this @@ hunk has no lines");
					const anchor = body.slice(2).trim();
					current = { anchor: anchor === "" ? undefined : anchor, lines: [], endOfFile: false, line: bodyNumber };
					hunks.push(current);
					closed = false;
					index++;
					continue;
				}

				if (isBlank(body)) {
					// A blank line followed by more hunk text is an empty context line (models often drop the
					// leading space). A blank line before "@@", a directive or the end of the patch is a separator.
					const nextLine = lines[skipBlank(lines, index)];
					const continuesHunk =
						current !== undefined &&
						!closed &&
						nextLine !== undefined &&
						!nextLine.startsWith("***") &&
						!nextLine.startsWith("@@");
					if (continuesHunk && current) current.lines.push({ kind: " ", text: "" });
					index++;
					continue;
				}

				if (!(body.startsWith(" ") || body.startsWith("-") || body.startsWith("+"))) {
					fail(
						bodyNumber,
						`unexpected line in an Update File section: ${JSON.stringify(body.slice(0, 60))}. Hunk lines start with " ", "-" or "+", and a hunk starts with "@@".`,
					);
				}
				if (closed) fail(bodyNumber, `a hunk line follows "${END_OF_FILE}"; start a new hunk with "@@"`);
				if (!current) {
					// The first hunk of a section may omit "@@".
					current = { anchor: undefined, lines: [], endOfFile: false, line: bodyNumber };
					hunks.push(current);
				}
				current.lines.push({ kind: body.charAt(0) as PatchLine["kind"], text: body.slice(1) });
				index++;
			}

			for (const hunk of hunks) {
				if (hunk.lines.length === 0) fail(hunk.line, "this hunk has no lines");
			}
			if (hunks.length === 0 && moveTo === undefined) {
				fail(lineNumber, `"${UPDATE_FILE.trim()}" needs at least one hunk or a "${MOVE_TO.trim()}" line`);
			}
			operations.push({ type: "update", path, moveTo, hunks, line: lineNumber });
			continue;
		}

		if (line.startsWith("***")) {
			fail(lineNumber, `unknown or misplaced directive ${JSON.stringify(line.trimEnd())}`);
		}
		fail(
			lineNumber,
			`expected "*** Add File:", "*** Delete File:" or "*** Update File:", got ${JSON.stringify(line.slice(0, 60))}`,
		);
	}

	if (!ended) fail(lines.length, `the patch is missing "${END_PATCH}" at the end`);
	const trailing = lines.slice(index).findIndex((line) => !isBlank(line));
	if (trailing !== -1) fail(index + trailing + 1, `nothing may follow "${END_PATCH}"`);
	if (operations.length === 0) throw new Error("Invalid patch: the patch contains no file operations.");
	return operations;
}

/**
 * Every path a patch text names, both ends of a move, in the order the operations appear. For observers that only want
 * to know which files a call touches (change panel, run summary, compaction): it never throws, and a value that is not
 * text, or a patch that does not parse, names no path.
 */
export function applyPatchPaths(patch: unknown): string[] {
	if (typeof patch !== "string") return [];
	try {
		return parseApplyPatch(patch).flatMap((operation) =>
			operation.type === "update" && operation.moveTo !== undefined
				? [operation.path, operation.moveTo]
				: [operation.path],
		);
	} catch {
		return [];
	}
}
