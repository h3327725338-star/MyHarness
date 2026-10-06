/**
 * A changeset is a complete, reviewable set of file changes: for every file the hash it was computed from, the
 * hash it will have afterwards, and a diff. Its id is the hash of exactly that, so the same plan always has the
 * same id (a retried apply is the same changeset) and any change to the plan, a file's base or the result is a
 * different changeset that needs its own approval.
 */

import { createHash } from "node:crypto";
import { countLineChanges, generateUnifiedPatch } from "../tools/files/edit-diff.ts";
import { ChangeControlError } from "./errors.ts";
import { encodeTextFile, sha256, type TextFileFormat } from "./text-file.ts";
import type { DecodedFileEdit } from "./workspace-edit.ts";

export type ChangeOperation = "modify" | "create";

export type ChangeSource = "rename" | "patch" | "workspace-edit" | "edit-tool" | "write-tool";

export interface PlannedFile {
	/** Workspace-relative path of the real file. */
	readonly path: string;
	readonly absolutePath: string;
	/** Mutation queue key (shared by every spelling of the file). */
	readonly key: string;
	readonly operation: ChangeOperation;
	/** Hash of the bytes the change was computed from; null when the file must not exist yet. */
	readonly baseHash: string | null;
	readonly afterHash: string;
	readonly beforeSize: number;
	readonly afterSize: number;
	readonly additions: number;
	readonly deletions: number;
}

export interface Changeset {
	readonly id: string;
	readonly workspaceRoot: string;
	readonly description: string;
	readonly source: ChangeSource;
	readonly createdAt: number;
	readonly files: readonly PlannedFile[];
	/** Annotation labels that ask for explicit user confirmation. */
	readonly needsConfirmation: readonly string[];
}

/** The bytes and diffs a changeset carries; kept apart because they can be large. */
export interface ChangesetContent {
	/** The new bytes of each file, by path. */
	readonly after: ReadonlyMap<string, Buffer>;
	/** Unified diffs, by path. */
	readonly diffs: ReadonlyMap<string, string>;
}

export interface BuiltChangeset {
	readonly changeset: Changeset;
	readonly content: ChangesetContent;
}

export function changesetIdOf(workspaceRoot: string, files: readonly PlannedFile[]): string {
	const canonical = JSON.stringify([
		workspaceRoot.replace(/\\/g, "/").toLowerCase(),
		[...files]
			.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
			.map((file) => [file.path, file.operation, file.baseHash, file.afterHash]),
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function diffStats(before: string | undefined, after: string): { additions: number; deletions: number } {
	return countLineChanges(before, after);
}

export interface NewFileChange {
	readonly path: string;
	readonly absolutePath: string;
	readonly key: string;
	readonly text: string;
}

export interface ModifiedFileChange {
	readonly path: string;
	readonly absolutePath: string;
	readonly key: string;
	readonly baseHash: string;
	readonly baseSize: number;
	readonly format: TextFileFormat;
	readonly beforeText: string;
	readonly afterText: string;
}

/** Changes from resolved WorkspaceEdits and from patches share one shape. */
export function modifiedFromDecoded(file: DecodedFileEdit): ModifiedFileChange {
	return {
		path: file.path,
		absolutePath: file.absolutePath,
		key: file.key,
		baseHash: file.baseHash,
		baseSize: file.baseSize,
		format: file.format,
		beforeText: file.beforeText,
		afterText: file.afterText,
	};
}

export function buildChangeset(input: {
	readonly workspaceRoot: string;
	readonly description: string;
	readonly source: ChangeSource;
	readonly modified?: readonly ModifiedFileChange[];
	readonly created?: readonly NewFileChange[];
	readonly needsConfirmation?: readonly string[];
	readonly now?: number;
}): BuiltChangeset {
	const files: PlannedFile[] = [];
	const after = new Map<string, Buffer>();
	const diffs = new Map<string, string>();
	const seen = new Set<string>();
	const claim = (path: string, key: string): void => {
		if (seen.has(key)) {
			throw new ChangeControlError("INVALID_EDIT", `${path} is changed more than once in one changeset`, {
				paths: [path],
			});
		}
		seen.add(key);
	};

	for (const file of input.modified ?? []) {
		claim(file.path, file.key);
		const bytes = encodeTextFile(file.afterText, file.format);
		after.set(file.path, bytes);
		diffs.set(file.path, generateUnifiedPatch(file.path, file.beforeText, file.afterText));
		files.push({
			path: file.path,
			absolutePath: file.absolutePath,
			key: file.key,
			operation: "modify",
			baseHash: file.baseHash,
			afterHash: sha256(bytes),
			beforeSize: file.baseSize,
			afterSize: bytes.length,
			...diffStats(file.beforeText, file.afterText),
		});
	}
	for (const file of input.created ?? []) {
		claim(file.path, file.key);
		const bytes = Buffer.from(file.text, "utf8");
		after.set(file.path, bytes);
		diffs.set(file.path, generateUnifiedPatch(file.path, "", file.text));
		files.push({
			path: file.path,
			absolutePath: file.absolutePath,
			key: file.key,
			operation: "create",
			baseHash: null,
			afterHash: sha256(bytes),
			beforeSize: 0,
			afterSize: bytes.length,
			...diffStats(undefined, file.text),
		});
	}
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return {
		changeset: {
			id: changesetIdOf(input.workspaceRoot, files),
			workspaceRoot: input.workspaceRoot,
			description: input.description,
			source: input.source,
			createdAt: input.now ?? Date.now(),
			files,
			needsConfirmation: [...(input.needsConfirmation ?? [])],
		},
		content: { after, diffs },
	};
}
