import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import type { CodeIntelligenceRoutingOptions } from "../symbols/index/router/types.ts";
import type { CodeIntelligenceRuntimeStatus } from "../symbols/runtime/types.ts";
import type {
	CallHierarchyResult,
	CodeDiagnostic,
	CodeHoverInfo,
	CodeReference,
	CodeSymbol,
	CodeSymbolKind,
	CodeSymbolTreeNode,
	DefinitionResult,
	DiagnosticsResult,
	FileSymbolsResult,
	HoverResult,
	ImplementationsResult,
	IntelligenceResultMeta,
	ReferencesResult,
	ResolvedSymbolResult,
	ResultCompleteness,
	SymbolTarget,
	TypeHierarchyResult,
	WorkspaceSymbolsResult,
} from "../symbols/types.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import {
	createSymbolsToolRuntime,
	requireAdvancedRouter,
	type SymbolsCodeIntelligenceServices,
} from "./symbols-runtime.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const MAX_SYMBOLS_LIMIT = 500;
const DEFAULT_OUTPUT_MAX_CHARS = 20_000;
const MIN_OUTPUT_MAX_CHARS = 1_000;
const MAX_OUTPUT_MAX_CHARS = 100_000;

const nonEmptyString = Type.String({ minLength: 1 });
const nonEmptyQuery = Type.String({ minLength: 1, description: "Symbol name or text to search for" });
const nonNegativeInteger = Type.Integer({ minimum: 0 });
const codeSymbolKindSchema = Type.Union([
	Type.Literal("class"),
	Type.Literal("function"),
	Type.Literal("method"),
	Type.Literal("interface"),
	Type.Literal("type"),
	Type.Literal("enum"),
	Type.Literal("namespace"),
	Type.Literal("module"),
	Type.Literal("struct"),
	Type.Literal("trait"),
	Type.Literal("variable"),
	Type.Literal("constant"),
	Type.Literal("constructor"),
	Type.Literal("property"),
	Type.Literal("field"),
	Type.Literal("enum_member"),
	Type.Literal("parameter"),
	Type.Literal("type_parameter"),
	Type.Literal("package"),
	Type.Literal("operator"),
	Type.Literal("unknown"),
]);
const validCodeSymbolKinds = new Set([
	"class",
	"function",
	"method",
	"interface",
	"type",
	"enum",
	"namespace",
	"module",
	"struct",
	"trait",
	"variable",
	"constant",
	"constructor",
	"property",
	"field",
	"enum_member",
	"parameter",
	"type_parameter",
	"package",
	"operator",
	"unknown",
]);

type SymbolsOperation =
	| "file_symbols"
	| "find_definition"
	| "find_references"
	| "find_implementations"
	| "diagnostics"
	| "workspace_symbols"
	| "resolve_symbol"
	| "hover"
	| "incoming_calls"
	| "outgoing_calls"
	| "supertypes"
	| "subtypes"
	| "status";

const positionTargetSchema = Type.Object({
	type: Type.Literal("position"),
	path: Type.String({ minLength: 1 }),
	position: Type.Object({
		line: nonNegativeInteger,
		character: nonNegativeInteger,
	}),
});

const symbolIdTargetSchema = Type.Object({
	type: Type.Literal("symbol_id"),
	symbolId: nonEmptyString,
});

const preciseTargetSchema = Type.Union([positionTargetSchema, symbolIdTargetSchema]);
const optionalPathSchema = Type.Optional(
	Type.String({ minLength: 1, description: "Workspace-relative path or directory" }),
);
const optionalLimitSchema = Type.Optional(
	Type.Integer({ minimum: 1, maximum: MAX_SYMBOLS_LIMIT, description: "Maximum number of results" }),
);
const maxCharsSchema = Type.Optional(Type.Integer({ minimum: MIN_OUTPUT_MAX_CHARS, maximum: MAX_OUTPUT_MAX_CHARS }));
const kindsSchema = Type.Optional(Type.Array(codeSymbolKindSchema, { minItems: 1, maxItems: 20 }));
const semanticRoutingProperties = {
	language: Type.Optional(Type.String({ minLength: 1 })),
	definitionId: Type.Optional(Type.String({ minLength: 1 })),
	timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 600_000 })),
};

/**
 * Keep the public tool contract operation-specific. Every branch is closed so
 * a model cannot treat the union of all Symbols arguments as one operation's
 * parameter list.
 */
const symbolsOperationSchemas = [
	Type.Object(
		{
			operation: Type.Literal("file_symbols"),
			path: nonEmptyString,
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_definition"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_references"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			includeDeclaration: Type.Optional(Type.Boolean()),
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_implementations"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("diagnostics"),
			path: nonEmptyString,
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("workspace_symbols"),
			query: nonEmptyQuery,
			path: optionalPathSchema,
			kinds: kindsSchema,
			...semanticRoutingProperties,
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("resolve_symbol"),
			target: symbolIdTargetSchema,
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("hover"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("incoming_calls"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("outgoing_calls"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("supertypes"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("subtypes"),
			target: preciseTargetSchema,
			...semanticRoutingProperties,
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("status"),
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
];

export type SymbolsToolInput = Static<(typeof symbolsOperationSchemas)[number]>;

/** Keep a provider-friendly object root while retaining the discriminated anyOf branches. */
const symbolsSchema = Type.Unsafe<SymbolsToolInput>({
	type: "object",
	anyOf: symbolsOperationSchemas,
});

export type SymbolsToolTarget = Static<typeof preciseTargetSchema>;

export interface SymbolsToolDetails {
	operation: SymbolsToolInput["operation"];
	source?: IntelligenceResultMeta["source"];
	completeness?: ResultCompleteness;
	fallback?: IntelligenceResultMeta["fallback"];
	warnings?: string[];
	outputTruncated?: boolean;
	semanticConfigured?: boolean;
	semanticEnabled?: boolean;
	symbolStoreEntryCount?: number;
	languageServerCount?: number;
}

export interface SymbolsToolOptions {
	agentDir?: string;
	codeIntelligence?: SymbolsCodeIntelligenceServices;
}

export class SymbolsToolInputError extends Error {
	readonly code = "invalid_arguments" as const;
	readonly operation: string;

	constructor(operation: string, message: string) {
		super(message);
		this.name = "SymbolsToolInputError";
		this.operation = operation;
	}
}

type DomainResult =
	| DefinitionResult
	| ReferencesResult
	| FileSymbolsResult
	| ImplementationsResult
	| DiagnosticsResult
	| WorkspaceSymbolsResult
	| ResolvedSymbolResult
	| HoverResult
	| CallHierarchyResult
	| TypeHierarchyResult;

function recordOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Derive runtime argument allowlists from the same operation schemas sent to the model. */
function createAllowedArguments(): Record<SymbolsOperation, ReadonlySet<string>> {
	const result = {} as Record<SymbolsOperation, Set<string>>;
	for (const schema of symbolsOperationSchemas) {
		const properties = recordOf(recordOf(schema).properties);
		const operation = recordOf(properties.operation).const;
		if (typeof operation !== "string") continue;
		const allowed = result[operation as SymbolsOperation] ?? new Set<string>();
		for (const key of Object.keys(properties)) allowed.add(key);
		result[operation as SymbolsOperation] = allowed;
	}
	return result;
}

const allowedArguments: Record<SymbolsOperation, ReadonlySet<string>> = createAllowedArguments();

function hasValue(args: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(args, key) && args[key] !== undefined;
}

function nonEmpty(value: unknown, operation: string, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new SymbolsToolInputError(operation, `${operation} requires a non-empty ${label}`);
	}
	return value.trim();
}

function requireNonEmpty(value: unknown, operation: string, label: string): string {
	const normalized = nonEmpty(value, operation, label);
	if (!normalized) throw new SymbolsToolInputError(operation, `${operation} requires a non-empty ${label}`);
	return normalized;
}

function validateBoolean(value: unknown, operation: string, label: string): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new SymbolsToolInputError(operation, `${operation} ${label} must be a boolean`);
	}
}

function validateInteger(value: unknown, operation: string, label: string, minimum: number, maximum?: number): void {
	if (value === undefined) return;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < minimum ||
		(maximum !== undefined && value > maximum)
	) {
		const range = maximum === undefined ? `>= ${minimum}` : `${minimum}..${maximum}`;
		throw new SymbolsToolInputError(operation, `${operation} ${label} must be an integer in ${range}`);
	}
}

function validateTimeout(value: unknown, operation: string): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 600_000) {
		throw new SymbolsToolInputError(operation, `${operation} timeoutMs must be a finite number in (0, 600000]`);
	}
}

function validateTarget(value: unknown, operation: string): Extract<SymbolTarget, { type: "position" | "symbol_id" }> {
	const target = recordOf(value);
	if (target.type === "position") {
		const path = requireNonEmpty(target.path, operation, "target.path");
		const position = recordOf(target.position);
		if (!hasValue(position, "line") || !hasValue(position, "character")) {
			throw new SymbolsToolInputError(operation, `${operation} position target requires line and character`);
		}
		validateInteger(position.line, operation, "target.position.line", 0);
		validateInteger(position.character, operation, "target.position.character", 0);
		return {
			type: "position",
			path,
			position: { line: position.line as number, character: position.character as number },
		};
	}
	if (target.type === "symbol_id") {
		return { type: "symbol_id", symbolId: requireNonEmpty(target.symbolId, operation, "target.symbolId") };
	}
	throw new SymbolsToolInputError(operation, `${operation} target has an unsupported type`);
}

function validateCommonTypes(args: Record<string, unknown>, operation: SymbolsOperation): void {
	const allowed = allowedArguments[operation];
	const unsupported = Object.keys(args).filter((key) => args[key] !== undefined && !allowed.has(key));
	if (unsupported.length > 0) {
		throw new SymbolsToolInputError(operation, `${operation} does not accept: ${unsupported.join(", ")}`);
	}
	if (args.language !== undefined) requireNonEmpty(args.language, operation, "language");
	if (args.definitionId !== undefined) requireNonEmpty(args.definitionId, operation, "definitionId");
	validateTimeout(args.timeoutMs, operation);
	validateInteger(args.limit, operation, "limit", 1, MAX_SYMBOLS_LIMIT);
	validateInteger(args.maxChars, operation, "maxChars", MIN_OUTPUT_MAX_CHARS, MAX_OUTPUT_MAX_CHARS);
	if (args.kinds !== undefined) {
		if (
			!Array.isArray(args.kinds) ||
			args.kinds.length === 0 ||
			args.kinds.length > 20 ||
			args.kinds.some((kind) => typeof kind !== "string" || !validCodeSymbolKinds.has(kind))
		) {
			throw new SymbolsToolInputError(operation, `${operation} kinds must be a non-empty array of symbol kinds`);
		}
	}
	validateBoolean(args.includeDeclaration, operation, "includeDeclaration");
}

function validateSymbolsToolInput(input: SymbolsToolInput): SymbolsToolInput {
	const args = recordOf(input);
	const operation = args.operation;
	if (
		operation !== "file_symbols" &&
		operation !== "find_definition" &&
		operation !== "find_references" &&
		operation !== "find_implementations" &&
		operation !== "diagnostics" &&
		operation !== "workspace_symbols" &&
		operation !== "resolve_symbol" &&
		operation !== "hover" &&
		operation !== "incoming_calls" &&
		operation !== "outgoing_calls" &&
		operation !== "supertypes" &&
		operation !== "subtypes" &&
		operation !== "status"
	) {
		throw new SymbolsToolInputError(String(operation ?? ""), "symbols operation is required and must be supported");
	}
	validateCommonTypes(args, operation);

	if (operation === "status") return input;

	if (operation === "workspace_symbols") {
		requireNonEmpty(args.query, operation, "query");
		if (hasValue(args, "target")) {
			throw new SymbolsToolInputError(operation, "workspace_symbols accepts query and routing options, not target");
		}
		return input;
	}

	if (operation === "resolve_symbol") {
		if (!hasValue(args, "target")) throw new SymbolsToolInputError(operation, "resolve_symbol requires target");
		const target = validateTarget(args.target, operation);
		if (target.type !== "symbol_id")
			throw new SymbolsToolInputError(operation, "resolve_symbol requires a symbol_id target");
		return input;
	}

	if (
		operation === "hover" ||
		operation === "incoming_calls" ||
		operation === "outgoing_calls" ||
		operation === "supertypes" ||
		operation === "subtypes"
	) {
		if (!hasValue(args, "target")) throw new SymbolsToolInputError(operation, `${operation} requires target`);
		if (hasValue(args, "query") || hasValue(args, "path")) {
			throw new SymbolsToolInputError(
				operation,
				`${operation} accepts target and routing options, not query or top-level path`,
			);
		}
		validateTarget(args.target, operation);
		return input;
	}

	if (operation === "file_symbols") {
		requireNonEmpty(args.path, operation, "path");
		if (args.includeDeclaration !== undefined || hasValue(args, "target") || hasValue(args, "query")) {
			throw new SymbolsToolInputError(
				operation,
				"file_symbols accepts path and routing options, not query or target",
			);
		}
		return input;
	}

	if (operation === "diagnostics") {
		requireNonEmpty(args.path, operation, "path");
		if (hasValue(args, "target") || hasValue(args, "query")) {
			throw new SymbolsToolInputError(operation, "diagnostics accepts a file path, not query or target");
		}
		if (args.includeDeclaration !== undefined) {
			throw new SymbolsToolInputError(operation, "diagnostics does not accept includeDeclaration");
		}
		return input;
	}

	if (operation === "find_implementations") {
		if (!hasValue(args, "target")) throw new SymbolsToolInputError(operation, "find_implementations requires target");
		if (hasValue(args, "query") || hasValue(args, "path")) {
			throw new SymbolsToolInputError(
				operation,
				"find_implementations requires target and does not accept query or top-level path",
			);
		}
		validateTarget(args.target, operation);
		if (args.includeDeclaration !== undefined) {
			throw new SymbolsToolInputError(operation, "find_implementations does not accept includeDeclaration");
		}
		return input;
	}

	if (!hasValue(args, "target")) throw new SymbolsToolInputError(operation, `${operation} requires target`);
	if (hasValue(args, "path"))
		throw new SymbolsToolInputError(operation, "target carries its own path; top-level path is not allowed");
	validateTarget(args.target, operation);
	if (operation === "find_definition" && args.includeDeclaration !== undefined) {
		throw new SymbolsToolInputError(operation, "find_definition does not accept includeDeclaration");
	}
	return input;
}

function routingOptions(
	args: SymbolsToolInput,
	signal: AbortSignal | undefined,
	includeWorkspaceFilters = false,
): CodeIntelligenceRoutingOptions {
	const raw = recordOf(args);
	const operation = raw.operation as SymbolsOperation;
	const allowed = allowedArguments[operation];
	const options: Record<string, unknown> = {};
	const copyIfAllowed = (key: string, value: unknown): void => {
		if (value !== undefined && allowed.has(key)) options[key] = value;
	};

	copyIfAllowed("language", raw.language);
	copyIfAllowed("definitionId", raw.definitionId);
	copyIfAllowed("timeoutMs", raw.timeoutMs);
	copyIfAllowed("includeDeclaration", raw.includeDeclaration);
	copyIfAllowed("limit", raw.limit);
	if (includeWorkspaceFilters) {
		copyIfAllowed("path", raw.path);
		copyIfAllowed("kinds", raw.kinds as CodeSymbolKind[] | undefined);
	}
	if (signal) options.signal = signal;
	return options as CodeIntelligenceRoutingOptions;
}

function positionText(symbol: CodeSymbol): { text: string; precision: string } {
	if (symbol.selectionRange) {
		return {
			text: `${symbol.path}:${symbol.selectionRange.start.line + 1}:${symbol.selectionRange.start.character}`,
			precision: "selection",
		};
	}
	if (symbol.line !== undefined) return { text: `${symbol.path}:${symbol.line + 1}`, precision: "line-only" };
	return { text: symbol.path, precision: "unknown" };
}

function symbolTargetHint(symbol: CodeSymbol, supportsSymbolIds: boolean): string | undefined {
	if (supportsSymbolIds) {
		return JSON.stringify({ type: "symbol_id", symbolId: symbol.id });
	}
	if (symbol.selectionRange) {
		return JSON.stringify({
			type: "position",
			path: symbol.path,
			position: symbol.selectionRange.start,
		});
	}
	return undefined;
}

function formatRange(
	path: string,
	range: { start: { line: number; character: number }; end: { line: number; character: number } },
): string {
	return `${path}:${range.start.line + 1}:${range.start.character}-${range.end.line + 1}:${range.end.character}`;
}

function formatCodeSymbol(symbol: CodeSymbol, indent = "", supportsSymbolIds = false): string {
	const position = positionText(symbol);
	const signature = symbol.signature ? ` — ${symbol.signature}` : "";
	const target = symbolTargetHint(symbol, supportsSymbolIds);
	return `${indent}${position.text} ${symbol.kind} ${symbol.namePath} [${symbol.language}] precision=${position.precision}${signature}${target ? ` target=${target}` : ""}`;
}

function formatSymbolTree(node: CodeSymbolTreeNode, depth = 0, supportsSymbolIds = false): string[] {
	return [
		formatCodeSymbol(node.symbol, "  ".repeat(depth), supportsSymbolIds),
		...node.children.flatMap((child) => formatSymbolTree(child, depth + 1, supportsSymbolIds)),
	];
}

function formatCodeReference(reference: CodeReference): string {
	const { location } = reference;
	if (location.range) {
		return `${formatRange(location.path, location.range)} ${reference.kind ?? "reference"} precision=range`;
	}
	if (location.line !== undefined)
		return `${location.path}:${location.line + 1} ${reference.kind ?? "reference"} precision=line-only`;
	return `${location.path} ${reference.kind ?? "reference"} precision=unknown`;
}

function formatDiagnostic(diagnostic: CodeDiagnostic): string {
	const location = diagnostic.location;
	const position = location.range
		? formatRange(location.path, location.range)
		: location.line !== undefined
			? `${location.path}:${location.line + 1}`
			: location.path;
	const fields = [diagnostic.severity, diagnostic.source, diagnostic.code].filter(Boolean).join(" ");
	return `${position} ${fields ? `[${fields}] ` : ""}${diagnostic.message}`;
}

function formatHoverContent(content: CodeHoverInfo["contents"][number]): string {
	if (content.kind === "code") return `code${content.language ? `(${content.language})` : ""}: ${content.value}`;
	return `${content.kind}: ${content.value}`;
}

function formatHover(info: CodeHoverInfo): string[] {
	const location = info.location?.range
		? `range=${formatRange(info.location.path, info.location.range)}`
		: "range=unknown";
	return [`hover ${location}`, ...info.contents.map((content) => `  ${formatHoverContent(content)}`)];
}

function formatCallEdge(edge: import("../symbols/types.ts").CodeCallEdge, supportsSymbolIds: boolean): string[] {
	return [
		formatCodeSymbol(edge.symbol, "", supportsSymbolIds),
		...edge.callSites.map(
			(location) => `  call_site ${location.range ? formatRange(location.path, location.range) : location.path}`,
		),
	];
}

function formatStatus(status: CodeIntelligenceRuntimeStatus): string[] {
	const lines = [
		`workspace=${status.workspaceRoot}`,
		`semantic_runtime=${status.semanticConfigured ? (status.semanticEnabled ? "enabled" : "disabled") : "not_configured"}`,
		`semantic_enabled=${status.semanticEnabled}`,
		`symbol_store_entries=${status.symbolStoreEntryCount}`,
		`language_servers=${status.languageServers.length}`,
		`configured_servers=${status.languageServers.filter((server) => server.configured).length}`,
		`discovered_servers=${status.languageServers.filter((server) => server.discovered).length}`,
		`running_servers=${status.languageServers.filter((server) => server.running).length}`,
	];
	if (!status.semanticConfigured) lines.push("semantic runtime not configured");
	for (const server of status.languageServers) {
		lines.push(
			`  ${server.definitionId} state=${server.state} configured=${server.configured} discovered=${server.discovered} running=${server.running}`,
		);
	}
	return lines;
}

function metaHeader(details: SymbolsToolDetails): string {
	const source = details.source ?? "semantic";
	const completeness = details.completeness ?? "complete";
	const parts = [`source=${source}`, `completeness=${completeness}`];
	if (details.fallback) parts.push(`fallback=${details.fallback.reason}`);
	return `[${parts.join(" ")}]`;
}

function composeOutput(details: SymbolsToolDetails, lines: string[], emptyText: string): string {
	const notices: string[] = [metaHeader(details)];
	if (details.fallback?.message) notices.push(`[fallback] ${details.fallback.message}`);
	if (details.completeness === "partial") notices.push("[warning] result is partial and may be incomplete");
	for (const warning of details.warnings ?? []) notices.push(`[warning] ${warning}`);
	notices.push(lines.length > 0 ? lines.join("\n") : emptyText);
	return notices.join("\n");
}

function safeSlice(value: string, maxChars: number): string {
	let end = Math.min(value.length, maxChars);
	if (end > 0) {
		const last = value.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
	}
	return value.slice(0, end);
}

function finalizeOutput(value: string, maxChars: number): { text: string; outputTruncated: boolean } {
	if (value.length <= maxChars) return { text: value, outputTruncated: false };
	const notice = "\nTool output truncated for presentation.";
	const budget = Math.max(0, maxChars - notice.length);
	return { text: `${safeSlice(value, budget)}${notice}`, outputTruncated: true };
}

function detailsFromMeta(operation: SymbolsOperation, meta: IntelligenceResultMeta): SymbolsToolDetails {
	return {
		operation,
		source: meta.source,
		completeness: meta.completeness,
		fallback: meta.fallback,
		warnings: meta.warnings ? [...meta.warnings] : undefined,
	};
}

function renderDomainResult(
	operation: SymbolsOperation,
	result: DomainResult,
	supportsSymbolIds = false,
): { text: string; details: SymbolsToolDetails } {
	const details = detailsFromMeta(operation, result.meta);
	let lines: string[];
	if (operation === "file_symbols") {
		lines = (result as FileSymbolsResult).items.flatMap((node) => formatSymbolTree(node, 0, supportsSymbolIds));
	} else if (operation === "find_definition") {
		lines = (result as DefinitionResult).items.map((symbol) => formatCodeSymbol(symbol, "", supportsSymbolIds));
	} else if (operation === "find_implementations") {
		lines = (result as ImplementationsResult).items.map((symbol) => formatCodeSymbol(symbol, "", supportsSymbolIds));
	} else if (operation === "find_references") {
		lines = (result as ReferencesResult).items.map(formatCodeReference);
	} else if (operation === "workspace_symbols" || operation === "resolve_symbol") {
		lines = (result as WorkspaceSymbolsResult | ResolvedSymbolResult).items.map((symbol) =>
			formatCodeSymbol(symbol, "", supportsSymbolIds),
		);
	} else if (operation === "hover") {
		lines = (result as HoverResult).items.flatMap(formatHover);
	} else if (operation === "incoming_calls" || operation === "outgoing_calls") {
		lines = (result as CallHierarchyResult).items.flatMap((edge) => formatCallEdge(edge, supportsSymbolIds));
	} else if (operation === "supertypes" || operation === "subtypes") {
		lines = (result as TypeHierarchyResult).items.map((symbol) => formatCodeSymbol(symbol, "", supportsSymbolIds));
	} else {
		lines = (result as DiagnosticsResult).items.map(formatDiagnostic);
	}
	return {
		text: composeOutput(
			details,
			lines,
			"No matching symbols, references, implementations, hover data, or hierarchy entries found",
		),
		details,
	};
}

function requireQuery(operation: SymbolsOperation, value: unknown): string {
	return requireNonEmpty(value, operation, "query");
}

export function createSymbolsToolDefinition(
	cwd: string,
	options?: SymbolsToolOptions,
): BusinessToolDefinition<typeof symbolsSchema, SymbolsToolDetails | undefined> {
	const runtime = createSymbolsToolRuntime(cwd, options);
	return {
		name: "symbols",
		label: "symbols",
		description:
			"Structured queries for project code symbols, definitions, references, implementations, call relationships, type hierarchies, file structure, and diagnostics. The operation selects a closed, operation-specific parameter set: do not combine parameters from different operations. Semantic results state their source and completeness.",
		promptSnippet: loadSystemPrompt("tools/symbols/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/symbols/guidelines.md"),
		parameters: symbolsSchema,
		async execute(_toolCallId, args: SymbolsToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			validateSymbolsToolInput(args);
			const operation = args.operation;
			const maxChars = args.maxChars ?? DEFAULT_OUTPUT_MAX_CHARS;
			const supportsSymbolIds = runtime.supportsSymbolIds;
			let text: string;
			let details: SymbolsToolDetails;

			if (operation === "status") {
				const status = runtime.getStatus();
				details = {
					operation,
					semanticConfigured: status.semanticConfigured,
					semanticEnabled: status.semanticEnabled,
					symbolStoreEntryCount: status.symbolStoreEntryCount,
					languageServerCount: status.languageServers.length,
				};
				text = ["[status]", ...formatStatus(status).map((line) => `  ${line}`)].join("\n");
			} else if (operation === "workspace_symbols") {
				const advancedRouter = requireAdvancedRouter(runtime.router, operation);
				const rendered = renderDomainResult(
					operation,
					await advancedRouter.workspaceSymbols(
						requireQuery(operation, args.query),
						routingOptions(args, signal, true),
					),
					supportsSymbolIds,
				);
				text = rendered.text;
				details = rendered.details;
			} else if (operation === "resolve_symbol") {
				const target = validateTarget(args.target, operation);
				if (target.type !== "symbol_id")
					throw new SymbolsToolInputError(operation, "resolve_symbol requires a symbol_id target");
				const advancedRouter = requireAdvancedRouter(runtime.router, operation);
				const rendered = renderDomainResult(
					operation,
					await advancedRouter.resolveSymbol(target.symbolId, routingOptions(args, signal)),
					supportsSymbolIds,
				);
				text = rendered.text;
				details = rendered.details;
			} else if (
				operation === "hover" ||
				operation === "incoming_calls" ||
				operation === "outgoing_calls" ||
				operation === "supertypes" ||
				operation === "subtypes"
			) {
				const target = validateTarget(args.target, operation);
				const advancedRouter = requireAdvancedRouter(runtime.router, operation);
				const result =
					operation === "hover"
						? await advancedRouter.hover(target, routingOptions(args, signal))
						: operation === "incoming_calls"
							? await advancedRouter.incomingCalls(target, routingOptions(args, signal))
							: operation === "outgoing_calls"
								? await advancedRouter.outgoingCalls(target, routingOptions(args, signal))
								: operation === "supertypes"
									? await advancedRouter.supertypes(target, routingOptions(args, signal))
									: await advancedRouter.subtypes(target, routingOptions(args, signal));
				const rendered = renderDomainResult(operation, result, supportsSymbolIds);
				text = rendered.text;
				details = rendered.details;
			} else if (operation === "file_symbols") {
				const rendered = renderDomainResult(
					operation,
					await runtime.router.fileSymbols(
						requireNonEmpty(args.path, operation, "path"),
						routingOptions(args, signal),
					),
					supportsSymbolIds,
				);
				text = rendered.text;
				details = rendered.details;
			} else if (operation === "find_implementations") {
				const target = validateTarget(args.target, operation);
				const rendered = renderDomainResult(
					operation,
					await runtime.router.findImplementations(target, routingOptions(args, signal)),
					supportsSymbolIds,
				);
				text = rendered.text;
				details = rendered.details;
			} else if (operation === "diagnostics") {
				const rendered = renderDomainResult(
					operation,
					await runtime.router.getDiagnostics(
						requireNonEmpty(args.path, operation, "path"),
						routingOptions(args, signal),
					),
					supportsSymbolIds,
				);
				text = rendered.text;
				details = rendered.details;
			} else {
				const raw = recordOf(args);
				const target = validateTarget(raw.target, operation);
				const result =
					operation === "find_definition"
						? await runtime.router.findDefinition(target, routingOptions(args, signal))
						: await runtime.router.findReferences(target, routingOptions(args, signal));
				const rendered = renderDomainResult(operation, result, supportsSymbolIds);
				text = rendered.text;
				details = rendered.details;
			}

			const finalized = finalizeOutput(text, maxChars);
			details.outputTruncated = finalized.outputTruncated;
			return {
				content: [{ type: "text", text: finalized.text }],
				details,
			};
		},
	};
}

export function createSymbolsTool(cwd: string, options?: SymbolsToolOptions): AgentTool<typeof symbolsSchema> {
	return wrapToolDefinition(createSymbolsToolDefinition(cwd, options));
}

export type { SymbolsCodeIntelligenceServices } from "./symbols-runtime.ts";
export { SymbolsToolConfigurationError } from "./symbols-runtime.ts";
