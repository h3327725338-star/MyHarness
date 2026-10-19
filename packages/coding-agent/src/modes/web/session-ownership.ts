/**
 * Which conversation owns an uncommitted file.
 *
 * Several conversations share one folder and one Git state, and two of them can change the same file. When they do, the
 * newest change decides: the file belongs to the conversation that changed it last, because that conversation is the one
 * whose view of the file is current. The other conversation keeps the file in its history - it did change it - but its
 * own commit leaves it alone, so the same file is never committed twice or swept up by a conversation that is no longer
 * looking at it.
 *
 * The evidence is the shared ChangeClaimRegistry: which conversation changed what, and when (direct file operations, and
 * the windows during which a conversation ran shell commands that can write files). A write nobody recorded - another
 * MyHarness process, an unrelated program, or a change made before this process started - leaves no owner; the file then
 * counts as the asking conversation's own, which is what it did before this check existed.
 */

import * as path from "node:path";
import { pathIdentityKey } from "../../utils/paths.ts";
import type { ChangeClaimRegistry } from "./change-claims.ts";
import { statModifiedAt } from "./changes.ts";

/** How much later than the newest record a write must land to count as nobody's (write-order and clock slack). */
const UNRECORDED_WRITE_GRACE_MS = 2_000;

export interface ConversationAttributionInput {
	/** Identity of the conversation asking (`session.sessionId`). */
	sessionKey: string;
	/** Paths this conversation recorded as changed, relative to `cwd`. */
	conversationPaths: readonly string[];
	cwd: string;
	/** Files that are uncommitted right now, relative to `cwd`. */
	dirtyPaths: readonly string[];
	registry?: ChangeClaimRegistry;
}

export interface ConversationAttribution {
	/** Paths of `conversationPaths` whose newest change is this conversation's, in the order they were given. */
	own: string[];
	/** Identity keys of this conversation's uncommitted files whose newest change came from another conversation. */
	elsewhere: Set<string>;
}

interface Evidence {
	sessionKey: string;
	at: number;
}

/** Path of `absolute` inside the repository, or undefined when it lies outside it. */
export function repositoryRelative(repositoryRoot: string, absolute: string): string | undefined {
	const relative = path.relative(path.resolve(repositoryRoot), path.resolve(absolute));
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/");
}

/**
 * The conversation that made the newest recorded change of one file, or undefined when nothing on record explains its
 * last write.
 */
function newestOwner(
	registry: ChangeClaimRegistry,
	absolute: string,
	modifiedAt: number | undefined,
	sessionKey: string,
): string | undefined {
	const evidence: Evidence[] = [];
	const claim = registry.latestClaim(absolute);
	if (claim) evidence.push({ sessionKey: claim.sessionKey, at: claim.at });
	// A shell command has no path-specific record: the write time decides, and it only counts for windows covering it.
	if (modifiedAt !== undefined) {
		for (const window of registry.windowsCovering(modifiedAt)) {
			evidence.push({ sessionKey: window.sessionKey, at: modifiedAt });
		}
	}
	if (evidence.length === 0) return undefined;
	let newest = evidence[0];
	for (const entry of evidence) {
		if (entry.at > newest.at || (entry.at === newest.at && entry.sessionKey === sessionKey)) newest = entry;
	}
	// The file was written after everything on record: that write has no owner.
	if (modifiedAt !== undefined && modifiedAt > newest.at + UNRECORDED_WRITE_GRACE_MS) return undefined;
	return newest.sessionKey;
}

/** Splits a conversation's uncommitted files into the ones it changed last and the ones another conversation changed last. */
export async function attributeConversationFiles(
	input: ConversationAttributionInput,
): Promise<ConversationAttribution> {
	const { sessionKey, conversationPaths, cwd, dirtyPaths, registry } = input;
	const dirty = new Set(dirtyPaths.map((candidate) => pathIdentityKey(path.resolve(cwd, candidate))));
	const own: string[] = [];
	const elsewhere = new Set<string>();
	const seen = new Set<string>();
	for (const candidate of conversationPaths) {
		const absolute = path.resolve(cwd, candidate);
		const key = pathIdentityKey(absolute);
		if (seen.has(key)) continue;
		seen.add(key);
		if (!dirty.has(key)) continue;
		const owner = registry ? newestOwner(registry, absolute, statModifiedAt(absolute), sessionKey) : undefined;
		if (owner === undefined || owner === sessionKey) own.push(candidate);
		else elsewhere.add(key);
	}
	return { own, elsewhere };
}

/** Whether one recorded path is a file another conversation changed more recently. */
export const isElsewhereOwned = (elsewhere: ReadonlySet<string>, cwd: string, candidate: string): boolean =>
	elsewhere.has(pathIdentityKey(path.resolve(cwd, candidate)));
