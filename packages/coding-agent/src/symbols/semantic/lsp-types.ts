import type { JsonObject, JsonValue } from "../lsp/types.ts";

export interface RawLspPosition {
	readonly line: number;
	readonly character: number;
}

export interface RawLspRange {
	readonly start: RawLspPosition;
	readonly end: RawLspPosition;
}

export interface RawLspLocation {
	readonly uri: string;
	readonly range: RawLspRange;
}

export interface RawLspLocationLink {
	readonly targetUri: string;
	readonly targetRange: RawLspRange;
	readonly targetSelectionRange: RawLspRange;
}

export interface RawLspDocumentSymbol {
	readonly name: string;
	readonly kind: number;
	readonly range: RawLspRange;
	readonly selectionRange: RawLspRange;
	readonly children: readonly RawLspDocumentSymbol[];
	readonly malformedChildCount: number;
}

export interface RawLspSymbolInformation {
	readonly name: string;
	readonly kind: number;
	readonly location: RawLspLocation;
	readonly containerName: string | undefined;
}

export interface RawLspWorkspaceSymbol {
	readonly name: string;
	readonly kind: number;
	readonly location: { readonly uri: string; readonly range?: RawLspRange };
	readonly containerName: string | undefined;
}

export type RawLspMarkupContent =
	| { readonly kind: "plaintext" | "markdown"; readonly value: string }
	| string
	| { readonly language: string; readonly value: string };

export interface RawLspHover {
	readonly contents: RawLspMarkupContent | readonly RawLspMarkupContent[];
	readonly range: RawLspRange | undefined;
}

export interface RawLspCallHierarchyItem {
	readonly name: string;
	readonly kind: number;
	readonly uri: string;
	readonly range: RawLspRange;
	readonly selectionRange: RawLspRange;
	readonly data?: JsonValue;
}

export interface RawLspIncomingCall {
	readonly from: RawLspCallHierarchyItem;
	readonly fromRanges: readonly RawLspRange[];
}

export interface RawLspOutgoingCall {
	readonly to: RawLspCallHierarchyItem;
	readonly fromRanges: readonly RawLspRange[];
}

export interface RawLspDiagnostic {
	readonly range: RawLspRange;
	readonly severity: number | undefined;
	readonly code: string | number | undefined;
	readonly source: string | undefined;
	readonly message: string;
}

export interface RawPublishDiagnosticsParams {
	readonly uri: string;
	readonly diagnostics: readonly RawLspDiagnostic[];
	readonly version: number | undefined;
}

export interface RawLspDiagnosticReport {
	readonly kind: "full" | "unchanged";
	readonly items: readonly JsonValue[];
	readonly version: number | undefined;
	readonly resultId: string | undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function readPosition(value: unknown): RawLspPosition | undefined {
	if (!isJsonObject(value)) return undefined;
	if (!isFiniteInteger(value.line) || !isFiniteInteger(value.character)) return undefined;
	if (value.line < 0 || value.character < 0) return undefined;
	return { line: value.line, character: value.character };
}

function readRange(value: unknown): RawLspRange | undefined {
	if (!isJsonObject(value)) return undefined;
	const start = readPosition(value.start);
	const end = readPosition(value.end);
	if (!start || !end) return undefined;
	return { start, end };
}

export function readLspRange(value: unknown): RawLspRange | undefined {
	return readRange(value);
}

export function readLspLocation(value: unknown): RawLspLocation | undefined {
	if (!isJsonObject(value) || typeof value.uri !== "string") return undefined;
	const range = readRange(value.range);
	return range ? { uri: value.uri, range } : undefined;
}

export function readLspLocationLink(value: unknown): RawLspLocationLink | undefined {
	if (!isJsonObject(value) || typeof value.targetUri !== "string") return undefined;
	const targetRange = readRange(value.targetRange);
	const targetSelectionRange = readRange(value.targetSelectionRange);
	if (!targetRange || !targetSelectionRange) return undefined;
	return { targetUri: value.targetUri, targetRange, targetSelectionRange };
}

export function readDocumentSymbol(value: unknown): RawLspDocumentSymbol | undefined {
	if (!isJsonObject(value) || typeof value.name !== "string" || !isFiniteInteger(value.kind)) return undefined;
	const range = readRange(value.range);
	const selectionRange = readRange(value.selectionRange);
	if (!range || !selectionRange) return undefined;
	if (value.children !== undefined && !Array.isArray(value.children)) return undefined;
	const children: RawLspDocumentSymbol[] = [];
	let malformedChildCount = 0;
	for (const child of (value.children as JsonValue[] | undefined) ?? []) {
		const parsed = readDocumentSymbol(child);
		if (parsed) children.push(parsed);
		else malformedChildCount += 1;
	}
	return { name: value.name, kind: value.kind, range, selectionRange, children, malformedChildCount };
}

export function readSymbolInformation(value: unknown): RawLspSymbolInformation | undefined {
	if (!isJsonObject(value) || typeof value.name !== "string" || !isFiniteInteger(value.kind)) return undefined;
	const location = readLspLocation(value.location);
	if (!location) return undefined;
	if (value.containerName !== undefined && typeof value.containerName !== "string") return undefined;
	return { name: value.name, kind: value.kind, location, containerName: value.containerName };
}

export function readWorkspaceSymbol(value: unknown): RawLspWorkspaceSymbol | undefined {
	if (!isJsonObject(value) || typeof value.name !== "string" || !isFiniteInteger(value.kind)) return undefined;
	if (!isJsonObject(value.location) || typeof value.location.uri !== "string") return undefined;
	const range = value.location.range === undefined ? undefined : readRange(value.location.range);
	if (value.location.range !== undefined && !range) return undefined;
	if (value.containerName !== undefined && typeof value.containerName !== "string") return undefined;
	return {
		name: value.name,
		kind: value.kind,
		location: { uri: value.location.uri, range },
		containerName: value.containerName,
	};
}

function readMarkupContent(value: unknown): RawLspMarkupContent | undefined {
	if (typeof value === "string") return value;
	if (!isJsonObject(value)) return undefined;
	if (value.kind === "plaintext" || value.kind === "markdown") {
		return typeof value.value === "string" ? { kind: value.kind, value: value.value } : undefined;
	}
	if (typeof value.language === "string" && typeof value.value === "string") {
		return { language: value.language, value: value.value };
	}
	return undefined;
}

export function readHover(value: unknown): RawLspHover | null | undefined {
	if (value === null) return null;
	if (!isJsonObject(value)) return undefined;
	const contents = Array.isArray(value.contents)
		? value.contents.map(readMarkupContent)
		: [readMarkupContent(value.contents)];
	if (contents.some((item) => item === undefined)) return undefined;
	const range = value.range === undefined ? undefined : readRange(value.range);
	if (value.range !== undefined && !range) return undefined;
	return { contents: (Array.isArray(value.contents) ? contents : contents[0]) as RawLspHover["contents"], range };
}

function parseCallHierarchyItem(value: unknown): RawLspCallHierarchyItem | undefined {
	if (!isJsonObject(value) || typeof value.name !== "string" || !isFiniteInteger(value.kind)) return undefined;
	if (typeof value.uri !== "string") return undefined;
	const range = readRange(value.range);
	const selectionRange = readRange(value.selectionRange);
	if (!range || !selectionRange) return undefined;
	return { name: value.name, kind: value.kind, uri: value.uri, range, selectionRange, data: value.data };
}

export function readCallHierarchyItem(value: unknown): RawLspCallHierarchyItem | undefined {
	return parseCallHierarchyItem(value);
}

export function readIncomingCall(value: unknown): RawLspIncomingCall | undefined {
	if (!isJsonObject(value) || !Array.isArray(value.fromRanges)) return undefined;
	const from = parseCallHierarchyItem(value.from);
	if (!from) return undefined;
	const fromRanges = value.fromRanges.map(readRange);
	if (fromRanges.some((range) => range === undefined)) return undefined;
	return { from, fromRanges: fromRanges as RawLspRange[] };
}

export function readOutgoingCall(value: unknown): RawLspOutgoingCall | undefined {
	if (!isJsonObject(value) || !Array.isArray(value.fromRanges)) return undefined;
	const to = parseCallHierarchyItem(value.to);
	if (!to) return undefined;
	const fromRanges = value.fromRanges.map(readRange);
	if (fromRanges.some((range) => range === undefined)) return undefined;
	return { to, fromRanges: fromRanges as RawLspRange[] };
}

export function readPublishDiagnosticsParams(value: unknown): RawPublishDiagnosticsParams | undefined {
	if (!isJsonObject(value) || typeof value.uri !== "string" || !Array.isArray(value.diagnostics)) return undefined;
	if (value.version !== undefined && !isFiniteInteger(value.version)) return undefined;
	const diagnostics: RawLspDiagnostic[] = [];
	for (const item of value.diagnostics as JsonValue[]) {
		if (!isJsonObject(item) || typeof item.message !== "string") continue;
		const range = readRange(item.range);
		if (!range) continue;
		if (item.severity !== undefined && !isFiniteInteger(item.severity)) continue;
		if (item.code !== undefined && typeof item.code !== "string" && typeof item.code !== "number") continue;
		if (item.source !== undefined && typeof item.source !== "string") continue;
		diagnostics.push({
			range,
			severity: item.severity,
			code: item.code,
			source: item.source,
			message: item.message,
		});
	}
	return { uri: value.uri, diagnostics, version: value.version };
}

/** Parse the pull-diagnostics report from textDocument/diagnostic. */
export function readDiagnosticReport(value: unknown): RawLspDiagnosticReport | undefined {
	if (!isJsonObject(value) || (value.kind !== "full" && value.kind !== "unchanged")) return undefined;
	if (value.resultId !== undefined && typeof value.resultId !== "string") return undefined;
	if (value.version !== undefined && !isFiniteInteger(value.version)) return undefined;
	if (value.kind === "full") {
		if (!Array.isArray(value.items)) return undefined;
		return {
			kind: "full",
			items: value.items,
			version: value.version,
			resultId: value.resultId,
		};
	}
	return {
		kind: "unchanged",
		items: [],
		version: value.version,
		resultId: value.resultId,
	};
}

export interface RawLspTextEdit {
	readonly range: RawLspRange;
	readonly newText: string;
	readonly annotationId: string | undefined;
}

export interface RawLspDocumentEdits {
	readonly uri: string;
	readonly version: number | undefined;
	readonly edits: readonly RawLspTextEdit[];
}

export interface RawLspWorkspaceEdit {
	/** Text edits grouped by document URI, in the order the server sent them. */
	readonly documents: readonly RawLspDocumentEdits[];
	/** Resource operations (create/rename/delete) and malformed entries, described for the caller. */
	readonly unsupported: readonly string[];
	/** Annotation ids whose change annotation asks for user confirmation. */
	readonly confirmationAnnotations: ReadonlySet<string>;
}

function readTextEdit(value: unknown): RawLspTextEdit | undefined {
	if (!isJsonObject(value)) return undefined;
	const range = readRange(value.range);
	if (!range) return undefined;
	// A SnippetTextEdit (LSP 3.18) carries `snippet` instead of `newText`: it is not plain text.
	if (typeof value.newText !== "string") return undefined;
	const annotationId = typeof value.annotationId === "string" ? value.annotationId : undefined;
	return { range, newText: value.newText, annotationId };
}

function readTextEdits(uri: string, values: readonly JsonValue[], unsupported: string[]): RawLspTextEdit[] {
	const edits: RawLspTextEdit[] = [];
	for (const value of values) {
		const parsed = readTextEdit(value);
		if (parsed) edits.push(parsed);
		else unsupported.push(`unsupported or malformed text edit in ${uri}`);
	}
	return edits;
}

/**
 * Parse a WorkspaceEdit (`documentChanges` or `changes`). Nothing is dropped
 * silently: resource operations and malformed entries are reported in
 * `unsupported`, because applying only the remaining edits would leave a
 * half-renamed workspace.
 */
export function readWorkspaceEdit(value: unknown): RawLspWorkspaceEdit | undefined {
	if (!isJsonObject(value)) return undefined;
	const documents: RawLspDocumentEdits[] = [];
	const unsupported: string[] = [];
	const confirmationAnnotations = new Set<string>();
	if (isJsonObject(value.changeAnnotations)) {
		for (const [id, annotation] of Object.entries(value.changeAnnotations)) {
			if (isJsonObject(annotation) && annotation.needsConfirmation === true) confirmationAnnotations.add(id);
		}
	}
	if (value.documentChanges !== undefined) {
		if (!Array.isArray(value.documentChanges)) return undefined;
		for (const change of value.documentChanges as JsonValue[]) {
			if (!isJsonObject(change)) {
				unsupported.push("malformed documentChanges entry");
				continue;
			}
			if (typeof change.kind === "string") {
				const target =
					typeof change.uri === "string"
						? change.uri
						: typeof change.oldUri === "string"
							? `${change.oldUri} -> ${String(change.newUri)}`
							: "";
				unsupported.push(`resource operation ${change.kind} ${target}`.trim());
				continue;
			}
			const textDocument = change.textDocument;
			if (!isJsonObject(textDocument) || typeof textDocument.uri !== "string" || !Array.isArray(change.edits)) {
				unsupported.push("malformed TextDocumentEdit");
				continue;
			}
			documents.push({
				uri: textDocument.uri,
				version: isFiniteInteger(textDocument.version) ? textDocument.version : undefined,
				edits: readTextEdits(textDocument.uri, change.edits as JsonValue[], unsupported),
			});
		}
	} else if (value.changes !== undefined) {
		if (!isJsonObject(value.changes)) return undefined;
		for (const [uri, edits] of Object.entries(value.changes)) {
			if (!Array.isArray(edits)) {
				unsupported.push(`malformed edits for ${uri}`);
				continue;
			}
			documents.push({ uri, version: undefined, edits: readTextEdits(uri, edits, unsupported) });
		}
	}
	return { documents, unsupported, confirmationAnnotations };
}

/** prepareRename result: a range, a range with a placeholder, `{ defaultBehavior }`, or null. */
export function readPrepareRename(
	value: unknown,
): { readonly range: RawLspRange | undefined; readonly placeholder: string | undefined } | null | undefined {
	if (value === null) return null;
	const direct = readRange(value);
	if (direct) return { range: direct, placeholder: undefined };
	if (!isJsonObject(value)) return undefined;
	if (value.defaultBehavior === true) return { range: undefined, placeholder: undefined };
	const range = readRange(value.range);
	if (!range) return undefined;
	return { range, placeholder: typeof value.placeholder === "string" ? value.placeholder : undefined };
}

export function isProviderSupported(value: unknown): boolean {
	return value === true || isJsonObject(value);
}
