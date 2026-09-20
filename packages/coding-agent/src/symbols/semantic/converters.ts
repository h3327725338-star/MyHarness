import { fromFileUri, toFileUri } from "../lsp/uri.ts";
import {
	getWorkspaceRelativeIdentity,
	isInsideWorkspace,
	normalizeDocumentPath,
	normalizeWorkspaceRoot,
	relativeToWorkspace,
} from "../path-semantics.ts";
import type { CodeDiagnostic, CodePosition, CodeRange, CodeSymbolKind } from "../types.ts";
import type { RawLspPosition, RawLspRange } from "./lsp-types.ts";

export interface ResolvedWorkspaceDocument {
	readonly workspaceRoot: string;
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly uri: string;
}

export interface ConvertedLocation {
	readonly path: string;
	readonly range: CodeRange;
}

export type LocationConversion =
	| { readonly kind: "ok"; readonly location: ConvertedLocation }
	| { readonly kind: "skip"; readonly warning: string };

export function resolveWorkspaceDocument(workspaceRootInput: string, filePath: string): ResolvedWorkspaceDocument {
	const workspaceRoot = normalizeWorkspaceRoot(workspaceRootInput);
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error("document path must be a non-empty string");
	}
	const absolutePath = normalizeDocumentPath(filePath, workspaceRoot);
	const normalizedRelativePath = relativeToWorkspace(workspaceRoot, absolutePath);
	if (!isInsideWorkspace(workspaceRoot, absolutePath) || normalizedRelativePath === "") {
		throw new Error(`document is outside workspace: ${filePath}`);
	}
	return Object.freeze({
		workspaceRoot,
		absolutePath,
		relativePath: normalizedRelativePath,
		uri: toFileUri(absolutePath),
	});
}

function lineLengths(text: string): readonly number[] {
	return text.split(/\r\n|\n|\r/).map((line) => line.length);
}

export function documentEndPosition(text: string): CodePosition {
	const lines = lineLengths(text);
	return { line: lines.length - 1, character: lines[lines.length - 1] ?? 0 };
}

export function comparePositions(left: CodePosition, right: CodePosition): number {
	return left.line - right.line || left.character - right.character;
}

export function positionsEqual(left: CodePosition, right: CodePosition): boolean {
	return left.line === right.line && left.character === right.character;
}

export function rangesEqual(left: CodeRange, right: CodeRange): boolean {
	return positionsEqual(left.start, right.start) && positionsEqual(left.end, right.end);
}

export function rangeContainsPosition(range: CodeRange, position: CodePosition): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) < 0;
}

export function rangesOverlap(left: CodeRange, right: CodeRange): boolean {
	return comparePositions(left.start, right.end) < 0 && comparePositions(right.start, left.end) < 0;
}

export function rangeWidth(range: CodeRange): number {
	return range.end.line - range.start.line + (range.end.character - range.start.character) / 1_000_000;
}

export function tryCodePosition(value: RawLspPosition, text?: string): CodePosition | undefined {
	if (!Number.isInteger(value.line) || !Number.isInteger(value.character) || value.line < 0 || value.character < 0) {
		return undefined;
	}
	if (text !== undefined) {
		const lengths = lineLengths(text);
		const lineLength = lengths[value.line];
		if (lineLength === undefined || value.character > lineLength) return undefined;
	}
	return { line: value.line, character: value.character };
}

export function tryCodeRange(value: RawLspRange, text?: string): CodeRange | undefined {
	const start = tryCodePosition(value.start, text);
	const end = tryCodePosition(value.end, text);
	if (!start || !end || comparePositions(start, end) > 0) return undefined;
	return { start, end };
}

export function toLspPosition(position: CodePosition): RawLspPosition {
	return { line: position.line, character: position.character };
}

export function toWholeDocumentReplacementRange(text: string): RawLspRange {
	return { start: { line: 0, character: 0 }, end: toLspPosition(documentEndPosition(text)) };
}

export function convertWorkspaceLocation(
	uri: string,
	range: RawLspRange,
	workspaceRoot: string,
	text?: string,
): LocationConversion {
	if (!/^file:/i.test(uri)) {
		return { kind: "skip", warning: `skipped non-file semantic location: ${uri}` };
	}
	let absolutePath: string;
	try {
		absolutePath = fromFileUri(uri);
	} catch (cause) {
		return { kind: "skip", warning: `skipped invalid file URI: ${String(cause)}` };
	}
	let document: ResolvedWorkspaceDocument;
	try {
		document = resolveWorkspaceDocument(workspaceRoot, absolutePath);
	} catch {
		return { kind: "skip", warning: `skipped location outside workspace: ${uri}` };
	}
	const codeRange = tryCodeRange(range, text);
	if (!codeRange) return { kind: "skip", warning: `skipped invalid semantic range: ${uri}` };
	return { kind: "ok", location: { path: document.relativePath, range: codeRange } };
}

export function normalizeLocationKey(location: ConvertedLocation): string {
	return `${getWorkspaceRelativeIdentity(location.path)}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
}

export function mapLspSymbolKind(kind: number): CodeSymbolKind {
	const mapping: Record<number, CodeSymbolKind> = {
		2: "module",
		3: "namespace",
		4: "package",
		5: "class",
		6: "method",
		7: "property",
		8: "field",
		9: "constructor",
		10: "enum",
		11: "interface",
		12: "function",
		13: "variable",
		14: "constant",
		22: "enum_member",
		23: "struct",
		25: "operator",
		26: "type_parameter",
	};
	return mapping[kind] ?? "unknown";
}

export function mapDiagnosticSeverity(value: number | undefined): CodeDiagnostic["severity"] {
	if (value === 1) return "error";
	if (value === 2) return "warning";
	if (value === 3) return "information";
	if (value === 4) return "hint";
	return value === undefined ? undefined : "unknown";
}
