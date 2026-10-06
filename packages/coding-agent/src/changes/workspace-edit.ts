/**
 * LSP WorkspaceEdit → per-file text changes, validated against the files as they are on disk.
 *
 * The codec only produces changes it can apply exactly: file URIs inside the workspace, positions that fit the
 * text, edits that do not overlap, versions that match the document the server saw. Resource operations
 * (create, rename, delete) are refused, not approximated; the client never advertises them.
 */

import { readFile } from "node:fs/promises";
import { fromFileUri } from "../symbols/path-semantics.ts";
import { ChangeControlError } from "./errors.ts";
import { resolveScopedFile } from "./path-scope.ts";
import { applyTextEdits, type ResolvedTextEdit, resolveTextEdits, type TextEdit } from "./text-edits.ts";
import { decodeTextFile, sha256, type TextFileFormat } from "./text-file.ts";

export interface DecodedFileEdit {
	/** Workspace-relative path of the real file. */
	readonly path: string;
	readonly absolutePath: string;
	/** Mutation queue key shared by every spelling of the file. */
	readonly key: string;
	/** Hash of the bytes the edit was resolved against; the base the commit compares with. */
	readonly baseHash: string;
	readonly baseSize: number;
	readonly format: TextFileFormat;
	readonly beforeText: string;
	readonly afterText: string;
	readonly edits: readonly ResolvedTextEdit[];
}

export interface DecodedWorkspaceEdit {
	readonly files: readonly DecodedFileEdit[];
	/** Labels of annotations that ask for explicit user confirmation before the edit is applied. */
	readonly needsConfirmation: readonly string[];
}

export interface DecodeWorkspaceEditOptions {
	readonly workspaceRoot: string;
	/** The version the client holds for an open document, by absolute path; undefined when it is not open. */
	readonly knownVersion?: (absolutePath: string) => number | undefined;
	readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ChangeControlError {
	return new ChangeControlError("INVALID_EDIT", `WorkspaceEdit: ${message}`);
}

function readPosition(value: unknown, where: string): { line: number; character: number } {
	if (!isRecord(value) || typeof value.line !== "number" || typeof value.character !== "number") {
		throw invalid(`${where} is not a position`);
	}
	return { line: value.line, character: value.character };
}

function readTextEdit(value: unknown, where: string, annotations: ReadonlyMap<string, AnnotationInfo>): TextEdit {
	if (!isRecord(value) || !isRecord(value.range) || typeof value.newText !== "string") {
		throw invalid(`${where} is not a text edit`);
	}
	const annotationId = value.annotationId;
	if (annotationId !== undefined) {
		if (typeof annotationId !== "string" || !annotations.has(annotationId)) {
			throw invalid(`${where} refers to an unknown change annotation`);
		}
	}
	return {
		range: {
			start: readPosition(value.range.start, `${where}.range.start`),
			end: readPosition(value.range.end, `${where}.range.end`),
		},
		newText: value.newText,
	};
}

interface AnnotationInfo {
	readonly label: string;
	readonly needsConfirmation: boolean;
}

function readAnnotations(value: unknown): Map<string, AnnotationInfo> {
	const result = new Map<string, AnnotationInfo>();
	if (value === undefined) return result;
	if (!isRecord(value)) throw invalid("changeAnnotations is not an object");
	for (const [id, annotation] of Object.entries(value)) {
		if (!isRecord(annotation) || typeof annotation.label !== "string") throw invalid(`annotation ${id} has no label`);
		result.set(id, { label: annotation.label, needsConfirmation: annotation.needsConfirmation === true });
	}
	return result;
}

interface UriEdits {
	readonly uri: string;
	readonly version: number | null | undefined;
	readonly edits: TextEdit[];
	readonly annotationIds: string[];
}

function collectEdits(raw: Record<string, unknown>, annotations: ReadonlyMap<string, AnnotationInfo>): UriEdits[] {
	const collected: UriEdits[] = [];
	const annotationOf = (value: unknown): string | undefined =>
		isRecord(value) && typeof value.annotationId === "string" ? value.annotationId : undefined;

	if (raw.documentChanges !== undefined) {
		if (!Array.isArray(raw.documentChanges)) throw invalid("documentChanges is not an array");
		raw.documentChanges.forEach((entry, index) => {
			const where = `documentChanges[${index}]`;
			if (!isRecord(entry)) throw invalid(`${where} is not an object`);
			if (typeof entry.kind === "string") {
				throw new ChangeControlError(
					"UNSUPPORTED_RESOURCE_OPERATION",
					`WorkspaceEdit contains a '${entry.kind}' file operation; this client applies text edits only`,
				);
			}
			const document = entry.textDocument;
			if (!isRecord(document) || typeof document.uri !== "string" || !Array.isArray(entry.edits)) {
				throw invalid(`${where} is not a text document edit`);
			}
			const version = document.version;
			if (version !== undefined && version !== null && typeof version !== "number") {
				throw invalid(`${where}.textDocument.version is not a number`);
			}
			collected.push({
				uri: document.uri,
				version,
				edits: entry.edits.map((edit, editIndex) =>
					readTextEdit(edit, `${where}.edits[${editIndex}]`, annotations),
				),
				annotationIds: entry.edits.map(annotationOf).filter((id): id is string => id !== undefined),
			});
		});
		return collected;
	}
	if (raw.changes !== undefined) {
		if (!isRecord(raw.changes)) throw invalid("changes is not an object");
		for (const [uri, edits] of Object.entries(raw.changes)) {
			if (!Array.isArray(edits)) throw invalid(`changes[${uri}] is not an array`);
			collected.push({
				uri,
				version: undefined,
				edits: edits.map((edit, editIndex) => readTextEdit(edit, `changes[${uri}][${editIndex}]`, annotations)),
				annotationIds: edits.map(annotationOf).filter((id): id is string => id !== undefined),
			});
		}
	}
	return collected;
}

/** Turn a server's WorkspaceEdit into exact per-file changes, or say why it cannot be applied. */
export async function decodeWorkspaceEdit(
	raw: unknown,
	options: DecodeWorkspaceEditOptions,
): Promise<DecodedWorkspaceEdit> {
	if (!isRecord(raw)) throw invalid("the edit is not an object");
	const annotations = readAnnotations(raw.changeAnnotations);
	const entries = collectEdits(raw, annotations);
	const read = options.readFile ?? ((path: string) => readFile(path));

	const byKey = new Map<
		string,
		{ scoped: Awaited<ReturnType<typeof resolveScopedFile>>; edits: TextEdit[]; versions: Set<number> }
	>();
	const confirmations = new Set<string>();
	for (const entry of entries) {
		let uriPath: string;
		try {
			uriPath = fromFileUri(entry.uri);
		} catch (cause) {
			throw new ChangeControlError(
				"PATH_OUT_OF_SCOPE",
				`WorkspaceEdit targets ${entry.uri}, which is not a file URI`,
				{
					cause,
				},
			);
		}
		const scoped = await resolveScopedFile(options.workspaceRoot, uriPath);
		if (!scoped.exists) {
			throw invalid(`${scoped.path} does not exist; text edits cannot create files`);
		}
		const target = byKey.get(scoped.key) ?? { scoped, edits: [], versions: new Set<number>() };
		target.edits.push(...entry.edits);
		if (typeof entry.version === "number") {
			const known = options.knownVersion?.(scoped.absolutePath);
			if (known !== entry.version) {
				throw new ChangeControlError(
					"SNAPSHOT_STALE",
					`${scoped.path}: the server edited version ${entry.version} of the document, the client has ${known ?? "none"}`,
					{ paths: [scoped.path] },
				);
			}
			target.versions.add(entry.version);
		}
		byKey.set(scoped.key, target);
		for (const id of entry.annotationIds) {
			const annotation = annotations.get(id);
			if (annotation?.needsConfirmation) confirmations.add(annotation.label);
		}
	}

	const files: DecodedFileEdit[] = [];
	for (const { scoped, edits } of byKey.values()) {
		const bytes = await read(scoped.absolutePath);
		const decoded = decodeTextFile(bytes, scoped.path);
		const resolved = resolveTextEdits(decoded.text, edits, scoped.path);
		const afterText = applyTextEdits(decoded.text, edits, scoped.path, decoded.eol);
		if (afterText === decoded.text) continue;
		files.push({
			path: scoped.path,
			absolutePath: scoped.absolutePath,
			key: scoped.key,
			baseHash: sha256(bytes),
			baseSize: bytes.length,
			format: { bom: decoded.bom, eol: decoded.eol },
			beforeText: decoded.text,
			afterText,
			edits: resolved,
		});
	}
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return { files, needsConfirmation: [...confirmations].sort() };
}
