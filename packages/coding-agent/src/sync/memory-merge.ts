/**
 * Deterministic text merge for memories.
 *
 * Two devices may edit the same memory while offline. Keeping one side and filing the other as a "conflict" makes the
 * user choose, and the choice never converges: the losing device keeps its own text and reports the same conflict again.
 * This module merges the two versions instead, with one hard requirement: the result must not depend on which device
 * runs the merge. Identical inputs therefore produce byte-identical output on both machines, so the next pass sees
 * equal content and stops.
 *
 * The merge is line based:
 * - with a common base (the last version both devices had), a three-way merge applies every non-overlapping edit;
 * - without a base, the common lines act as anchors and each differing block is kept, ordered by its content hash;
 * - a block that is already contained in the other side is not repeated, so "the more detailed version" wins;
 * - nothing is ever dropped silently: when both sides changed the same region, both regions survive.
 */

/** Above this many line pairs the LCS table is skipped; a huge memory falls back to the anchored union below. */
const MAX_DIFF_CELLS = 4_000_000;

export interface MemoryMergeResult {
	text: string;
	/** True when the merged text differs from the local text. */
	changed: boolean;
}

interface LineText {
	lines: string[];
	/** Whether the original text ended with a line break. */
	trailing: boolean;
}

interface Hunk {
	/** Start index in the base text. */
	start: number;
	/** End index in the base text (exclusive); equal to start for a pure insertion. */
	end: number;
	lines: string[];
}

function splitLines(text: string): LineText {
	const normalized = text.replace(/\r\n/gu, "\n");
	const trailing = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (trailing) lines.pop();
	return { lines, trailing };
}

function joinLines(lines: string[], trailing: boolean): string {
	const body = lines.join("\n");
	return trailing ? `${body}\n` : body;
}

/** Small, stable content hash used only to order two conflicting blocks deterministically. */
function orderKey(lines: string[]): string {
	let hash = 0x811c9dc5;
	const text = lines.join("\n");
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function sameLines(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

function containsLines(container: string[], part: string[]): boolean {
	if (part.length === 0) return true;
	const available = new Set(container);
	return part.every((line) => line === "" || available.has(line));
}

/**
 * Split one side into hunks relative to the base. Returns undefined when the table would be too large, so the caller
 * can fall back instead of allocating hundreds of megabytes.
 */
function diffHunks(base: string[], side: string[]): Hunk[] | undefined {
	const rows = base.length + 1;
	const columns = side.length + 1;
	if (rows * columns > MAX_DIFF_CELLS) return undefined;
	const table = new Uint32Array(rows * columns);
	for (let row = base.length - 1; row >= 0; row -= 1) {
		for (let column = side.length - 1; column >= 0; column -= 1) {
			table[row * columns + column] =
				base[row] === side[column]
					? table[(row + 1) * columns + column + 1]! + 1
					: Math.max(table[(row + 1) * columns + column]!, table[row * columns + column + 1]!);
		}
	}
	const hunks: Hunk[] = [];
	let row = 0;
	let column = 0;
	let pending: { start: number; base: number; side: string[] } | undefined;
	const flush = (end: number, sideEnd: number): void => {
		if (!pending) return;
		pending.side = side.slice(pending.base, sideEnd);
		hunks.push({ start: pending.start, end, lines: pending.side });
		pending = undefined;
	};
	while (row < base.length || column < side.length) {
		const equal = row < base.length && column < side.length && base[row] === side[column];
		if (equal) {
			flush(row, column);
			row += 1;
			column += 1;
			continue;
		}
		if (!pending) pending = { start: row, base: column, side: [] };
		const down = row < base.length ? table[(row + 1) * columns + column]! : -1;
		const right = column < side.length ? table[row * columns + column + 1]! : -1;
		if (row < base.length && (column >= side.length || down >= right)) row += 1;
		else column += 1;
	}
	flush(base.length, side.length);
	return hunks;
}

/** Apply hunks that all sit inside the base segment [offset, offset + segment.length). */
function applySegment(base: string[], offset: number, length: number, hunks: Hunk[]): string[] {
	const result: string[] = [];
	let position = offset;
	for (const hunk of hunks) {
		for (let index = position; index < hunk.start; index += 1) result.push(base[index]!);
		result.push(...hunk.lines);
		position = hunk.end;
	}
	for (let index = position; index < offset + length; index += 1) result.push(base[index]!);
	return result;
}

/**
 * Both sides changed the same base region differently. Keep both blocks, ordered by content hash, so the two devices
 * produce the same text. A block fully contained in the other one is not repeated.
 */
function resolveConflict(base: string[], local: string[], remote: string[]): string[] {
	if (sameLines(local, remote)) return local;
	if (sameLines(local, base)) return remote;
	if (sameLines(remote, base)) return local;
	if (containsLines(local, remote)) return local;
	if (containsLines(remote, local)) return remote;
	const localKey = orderKey(local);
	const remoteKey = orderKey(remote);
	return localKey <= remoteKey ? [...local, ...remote] : [...remote, ...local];
}

/** Three-way merge over the common base. */
function mergeWithBase(base: string[], local: string[], remote: string[]): string[] {
	const localHunks = diffHunks(base, local);
	const remoteHunks = diffHunks(base, remote);
	if (!localHunks || !remoteHunks) return mergeWithoutBase(local, remote);
	const result: string[] = [];
	let position = 0;
	let localIndex = 0;
	let remoteIndex = 0;
	while (true) {
		const nextLocal = localHunks[localIndex];
		const nextRemote = remoteHunks[remoteIndex];
		if (!nextLocal && !nextRemote) break;
		const startLocal = nextLocal ? nextLocal.start : Number.POSITIVE_INFINITY;
		const startRemote = nextRemote ? nextRemote.start : Number.POSITIVE_INFINITY;
		if (startLocal > position && startRemote > position) {
			result.push(base[position]!);
			position += 1;
			continue;
		}
		let end = position;
		const regionLocal: Hunk[] = [];
		const regionRemote: Hunk[] = [];
		let progressed = true;
		while (progressed) {
			progressed = false;
			while (localIndex < localHunks.length && localHunks[localIndex]!.start <= end) {
				const hunk = localHunks[localIndex]!;
				localIndex += 1;
				regionLocal.push(hunk);
				if (hunk.end > end) end = hunk.end;
				progressed = true;
			}
			while (remoteIndex < remoteHunks.length && remoteHunks[remoteIndex]!.start <= end) {
				const hunk = remoteHunks[remoteIndex]!;
				remoteIndex += 1;
				regionRemote.push(hunk);
				if (hunk.end > end) end = hunk.end;
				progressed = true;
			}
		}
		const baseSegment = base.slice(position, end);
		const localSegment = applySegment(base, position, baseSegment.length, regionLocal);
		const remoteSegment = applySegment(base, position, baseSegment.length, regionRemote);
		result.push(...resolveConflict(baseSegment, localSegment, remoteSegment));
		position = end;
	}
	while (position < base.length) {
		result.push(base[position]!);
		position += 1;
	}
	return result;
}

/**
 * No common base: use the longest common subsequence as anchors, keep each differing block from both sides, and order
 * the two blocks of one gap by hash. The result is symmetric in the two inputs, so both devices converge.
 */
function mergeWithoutBase(local: string[], remote: string[]): string[] {
	if (sameLines(local, remote)) return local;
	if (containsLines(local, remote)) return local;
	if (containsLines(remote, local)) return remote;
	// A diff of local -> remote gives both the common anchors and the blocks that differ; walking it in order keeps
	// the document structure and treats the two sides symmetrically.
	const hunks = diffHunks(local, remote);
	if (!hunks) {
		// Too large for a table: keep both documents, ordered deterministically.
		return orderKey(local) <= orderKey(remote) ? [...local, ...remote] : [...remote, ...local];
	}
	const result: string[] = [];
	let localIndex = 0;
	let remoteIndex = 0;
	for (const hunk of hunks) {
		const common = hunk.start - localIndex;
		for (let index = 0; index < common; index += 1) result.push(local[localIndex + index]!);
		localIndex = hunk.start;
		remoteIndex += common;
		const localGap = local.slice(localIndex, hunk.end);
		result.push(...resolveConflict([], localGap, hunk.lines));
		localIndex = hunk.end;
		remoteIndex += hunk.lines.length;
	}
	const tail = local.length - localIndex;
	const remoteTail = remote.length - remoteIndex;
	if (tail === remoteTail) {
		for (let index = 0; index < tail; index += 1) result.push(local[localIndex + index]!);
	} else {
		result.push(...resolveConflict([], local.slice(localIndex), remote.slice(remoteIndex)));
	}
	return result;
}

interface MemoryDocument {
	frontmatter?: string[];
	body: string;
}

/** Split a memory into its YAML frontmatter block and the markdown body. */
function splitDocument(text: string): MemoryDocument {
	const lines = text.replace(/\r\n/gu, "\n").split("\n");
	if (lines[0] !== "---") return { body: text };
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index] === "---") {
			end = index;
			break;
		}
	}
	if (end < 0) return { body: text };
	return { frontmatter: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

/** Group frontmatter lines by their top-level `key:` so one field is replaced as a whole, never duplicated. */
function parseFields(lines: string[]): Map<string, string[]> {
	const fields = new Map<string, string[]>();
	let current: string[] | undefined;
	for (const line of lines) {
		const match = /^([A-Za-z0-9_.-]+):(.*)$/u.exec(line);
		if (match) {
			current = [line];
			fields.set(match[1]!, current);
		} else if (current) {
			current.push(line);
		}
	}
	return fields;
}

function isListField(lines: string[]): boolean {
	return lines.slice(1).some((line) => /^\s+-\s+/u.test(line)) || /:\s*\[[^\]]*\]\s*$/u.test(lines[0] ?? "");
}

function listValues(lines: string[]): string[] {
	const values: string[] = [];
	const inline = /:\s*\[([^\]]*)\]\s*$/u.exec(lines[0] ?? "");
	if (inline) {
		for (const part of inline[1]!.split(",")) {
			const value = part.trim().replace(/^["']|["']$/gu, "");
			if (value) values.push(value);
		}
	}
	for (const line of lines.slice(1)) {
		const match = /^\s+-\s*(.+?)\s*$/u.exec(line);
		if (match) values.push(match[1]!.replace(/^["']|["']$/gu, ""));
	}
	return values;
}

function scalarValue(lines: string[]): string {
	return (lines[0] ?? "").replace(/^[^:]+:\s*/u, "").trim();
}

/**
 * Merge one frontmatter field. The choice is a pure function of the two sides, so both devices agree: a timestamp takes
 * the later value, a list takes the sorted union, and any other value keeps the more detailed text.
 */
function mergeField(key: string, base: string[] | undefined, local: string[], remote: string[]): string[] | undefined {
	if (base) {
		if (sameLines(local, base)) return remote;
		if (sameLines(remote, base)) return local;
	}
	if (isListField(local) && isListField(remote)) {
		const values = [...new Set([...listValues(local), ...listValues(remote)])].sort((left, right) =>
			left.localeCompare(right, "en"),
		);
		return [`${key}:`, ...values.map((value) => `  - ${value}`)];
	}
	const localText = local.join("\n");
	const remoteText = remote.join("\n");
	if (/updatedat|timestamp|createdat|deletedat/iu.test(key)) {
		const localValue = scalarValue(local);
		const remoteValue = scalarValue(remote);
		return localValue.localeCompare(remoteValue, "en") >= 0 ? local : remote;
	}
	if (localText.length !== remoteText.length) return localText.length > remoteText.length ? local : remote;
	return localText.localeCompare(remoteText, "en") >= 0 ? local : remote;
}

/** Field-wise merge of the frontmatter; returns the lines between the two `---` markers. */
function mergeFrontmatter(base: string[] | undefined, local: string[], remote: string[]): string[] {
	const baseFields = base ? parseFields(base) : new Map<string, string[]>();
	const localFields = parseFields(local);
	const remoteFields = parseFields(remote);
	const order = [...baseFields.keys()];
	const added = [...new Set([...localFields.keys(), ...remoteFields.keys()])]
		.filter((key) => !baseFields.has(key))
		.sort((left, right) => left.localeCompare(right, "en"));
	order.push(...added);
	const result: string[] = [];
	for (const key of order) {
		const baseValue = baseFields.get(key);
		const localValue = localFields.get(key);
		const remoteValue = remoteFields.get(key);
		let chosen: string[] | undefined;
		if (localValue && remoteValue) chosen = mergeField(key, baseValue, localValue, remoteValue);
		else if (localValue) {
			// Deleted on the other side: a deletion wins only while this side still holds the base value.
			chosen = !baseValue ? localValue : sameLines(localValue, baseValue) ? undefined : localValue;
		} else if (remoteValue) {
			chosen = !baseValue ? remoteValue : sameLines(remoteValue, baseValue) ? undefined : remoteValue;
		}
		if (chosen) result.push(...chosen);
	}
	return result;
}

function mergePlainText(baseText: string | undefined, localText: string, remoteText: string): MemoryMergeResult {
	const local = splitLines(localText);
	const remote = splitLines(remoteText);
	const base = baseText === undefined ? undefined : splitLines(baseText);
	const trailing = local.trailing || remote.trailing;
	const lines = base
		? mergeWithBase(base.lines, local.lines, remote.lines)
		: mergeWithoutBase(local.lines, remote.lines);
	const text = joinLines(lines, trailing);
	return { text, changed: text !== localText };
}

export function mergeMemoryText(
	baseText: string | undefined,
	localText: string,
	remoteText: string,
): MemoryMergeResult {
	if (localText.replace(/\r\n/gu, "\n") === remoteText.replace(/\r\n/gu, "\n")) {
		return { text: localText, changed: false };
	}
	if (baseText !== undefined && baseText === localText) return { text: remoteText, changed: true };
	if (baseText !== undefined && baseText === remoteText) return { text: localText, changed: true };
	const local = splitDocument(localText);
	const remote = splitDocument(remoteText);
	if (!local.frontmatter && !remote.frontmatter) return mergePlainText(baseText, localText, remoteText);
	const base = baseText === undefined ? undefined : splitDocument(baseText);
	const body = mergePlainText(base?.body, local.body, remote.body);
	const frontmatter = mergeFrontmatter(base?.frontmatter, local.frontmatter ?? [], remote.frontmatter ?? []);
	let text = ["---", ...frontmatter, "---", ...(body.text === "" ? [] : [body.text])].join("\n");
	const newline = localText.includes("\r\n") ? "\r\n" : "\n";
	if ((localText.endsWith("\n") || remoteText.endsWith("\n")) && !text.endsWith("\n")) text += "\n";
	if (newline === "\r\n") text = text.replace(/\n/gu, "\r\n");
	return { text, changed: text !== localText };
}
