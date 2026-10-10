/**
 * Read-before-mutate state for the file tools.
 *
 * The `read` tool records the shape of the file it just handed to the model.
 * `edit` and `write` refuse to change a file that was never read in this
 * Session, or whose recorded shape no longer matches what is on disk, because
 * in both cases the change is being made against content the model is not
 * looking at. The refusal is a structured error code so the model and the UI
 * can tell "did not read yet" apart from "changed since you read it".
 *
 * The state is intentionally small: `mtimeMs` plus `size` per file. Both are
 * already needed to prove the file did not move underneath the model, and both
 * are free to obtain from one `stat`.
 */

import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** What one tracked file looked like when the model last saw it. */
export interface FileReadState {
	mtimeMs: number;
	size: number;
}

/** Structured reasons a mutation was refused because of the read state. */
export type FileReadStateCode = "FILE_NOT_READ" | "FILE_STALE";

/** Which tool is asking, used only to phrase the actionable message. */
export type FileReadStateTool = "edit" | "write";

/**
 * Bound on tracked files. Every entry is two numbers, so the cap keeps the
 * table trivially small while a long Session touching thousands of files
 * cannot grow it without limit. The least recently used entry is dropped.
 */
export const MAX_TRACKED_FILE_STATES = 1000;

/** Scope used when no Session is reachable from the tool execution context. */
const GLOBAL_SCOPE = "global";

const fileReadStates = new Map<string, FileReadState>();

/**
 * Stable key for a file path: absolute, separator-normalised, Unicode
 * normalised, and case-folded on the case-insensitive Windows filesystem. No
 * filesystem access, so the same path always maps to the same key whether or
 * not the file exists yet. Shared by the read state table and the mutation
 * queue, which must both consider "the same file" the same thing.
 */
export function canonicalFilePathKey(absolutePath: string): string {
	const normalized = resolve(absolutePath).split(sep).join("/").normalize("NFC");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stateKey(scope: string, absolutePath: string): string {
	return `${scope}\u0000${canonicalFilePathKey(absolutePath)}`;
}

/**
 * Scope for one tool call. Built-in tools receive the extension execution
 * context as the last `execute` argument, which carries the Session manager;
 * reading it must never throw (a stale extension runner rejects its getters),
 * and a missing Session falls back to the shared global scope.
 */
export function resolveFileStateScope(ctx: unknown): string {
	if (!ctx || typeof ctx !== "object") return GLOBAL_SCOPE;
	try {
		const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => string | undefined } }).sessionManager;
		const sessionId = sessionManager?.getSessionId?.();
		if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
	} catch {
		// The runner was replaced: fall back to the shared scope rather than
		// failing an otherwise valid tool call.
	}
	return GLOBAL_SCOPE;
}

/** Remember what the model was just shown for this file. */
export function recordFileReadState(absolutePath: string, state: FileReadState, scope: string = GLOBAL_SCOPE): void {
	const key = stateKey(scope, absolutePath);
	fileReadStates.delete(key);
	fileReadStates.set(key, state);
	while (fileReadStates.size > MAX_TRACKED_FILE_STATES) {
		const oldest = fileReadStates.keys().next();
		if (oldest.done) break;
		fileReadStates.delete(oldest.value);
	}
}

/** The last shape recorded for this file, or undefined when it was never read. */
export function getFileReadState(absolutePath: string, scope: string = GLOBAL_SCOPE): FileReadState | undefined {
	const key = stateKey(scope, absolutePath);
	const state = fileReadStates.get(key);
	if (state) {
		// Touch to mark it as recently used.
		fileReadStates.delete(key);
		fileReadStates.set(key, state);
	}
	return state;
}

/** Forget one file (all Scopes when no Scope is given). */
export function forgetFileReadState(absolutePath: string, scope?: string): void {
	if (scope === undefined) {
		const canonical = canonicalFilePathKey(absolutePath);
		for (const key of [...fileReadStates.keys()]) {
			if (key.slice(key.indexOf("\u0000") + 1) === canonical) fileReadStates.delete(key);
		}
		return;
	}
	fileReadStates.delete(stateKey(scope, absolutePath));
}

/** Forget everything. Exposed for tests and for tearing a Session down. */
export function clearFileReadStates(): void {
	fileReadStates.clear();
}

/** How many files are tracked. Exposed for tests. */
export function fileReadStateCount(): number {
	return fileReadStates.size;
}

/** Current shape of a file on disk, or undefined when it is not an existing regular file. */
export async function statFileReadState(absolutePath: string): Promise<FileReadState | undefined> {
	try {
		const info = await stat(absolutePath);
		if (!info.isFile()) return undefined;
		return { mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		return undefined;
	}
}

function createFileReadStateError(
	code: FileReadStateCode,
	message: string,
	absolutePath: string,
): Error & { code: string; details: Record<string, unknown> } {
	const error = new Error(message) as Error & { code: string; details: Record<string, unknown> };
	error.code = code;
	error.details = { code, path: absolutePath };
	return error;
}

/**
 * Refuse a mutation of an existing file that the model never read, or that
 * changed since it was read. A target that does not exist yet is always
 * allowed: creating a new file cannot overwrite anything the model is looking
 * at, and `edit` rejects a missing file with its own error before this runs.
 */
export async function assertFileWasReadBefore(
	absolutePath: string,
	tool: FileReadStateTool,
	displayPath: string,
	scope: string,
): Promise<void> {
	const current = await statFileReadState(absolutePath);
	if (!current) return;
	const recorded = getFileReadState(absolutePath, scope);
	if (!recorded) {
		throw createFileReadStateError(
			"FILE_NOT_READ",
			tool === "edit"
				? `Could not edit ${displayPath}: the file was not read in this Session. Read it with the read tool first, then repeat the edit.`
				: `Could not write ${displayPath}: the file already exists but was not read in this Session, so overwriting it could discard content you have not seen. Read it with the read tool first, then repeat the write.`,
			absolutePath,
		);
	}
	if (recorded.mtimeMs !== current.mtimeMs || recorded.size !== current.size) {
		throw createFileReadStateError(
			"FILE_STALE",
			`Could not ${tool} ${displayPath}: the file changed on disk since it was last read. Read it again with the read tool, then repeat the ${tool}.`,
			absolutePath,
		);
	}
}

/**
 * Refresh the state after the tool's own mutation, so a change the tool just
 * made is not reported as an external modification to the next call.
 */
export async function recordFileStateAfterMutation(absolutePath: string, scope: string): Promise<void> {
	const current = await statFileReadState(absolutePath);
	if (current) recordFileReadState(absolutePath, current, scope);
	else forgetFileReadState(absolutePath, scope);
}
