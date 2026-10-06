import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import {
	type CodeIndexRefreshSummary,
	type CodeSearchMatch,
	getCodeLanguage,
	type IndexedCodeReference,
	type IndexedCodeSymbol,
} from "../symbols/index/code-index.ts";
import type { CodeIntelligenceRoutingOptions } from "../symbols/index/router/types.ts";
import {
	continueInspect,
	decodeContinuation,
	INSPECT_FACETS,
	type InspectContinuation,
	InspectContinuationError,
	type InspectFacet,
	type InspectFacetItem,
	type InspectFacetName,
	type InspectFacetStatus,
	type InspectResult,
	type InspectTarget,
	inspectSymbol,
	MAX_INSPECT_PAGE_SIZE,
} from "../symbols/inspect/inspect-symbol.ts";
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
	IntelligenceSource,
	QueryCoverage,
	ReferencesResult,
	ResolvedSymbolResult,
	ResultCompleteness,
	SymbolQuery,
	SymbolSearchResult,
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
	type SymbolsIndexPort,
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
	| "find_symbol"
	| "find_definition"
	| "find_references"
	| "file_symbols"
	| "find_implementations"
	| "diagnostics"
	| "search_code"
	| "code_map"
	| "workspace_symbols"
	| "resolve_symbol"
	| "hover"
	| "incoming_calls"
	| "outgoing_calls"
	| "supertypes"
	| "subtypes"
	| "inspect_symbol"
	| "status";

const positionTargetSchema = Type.Object({
	type: Type.Literal("position"),
	path: Type.String({ minLength: 1 }),
	position: Type.Object({
		line: nonNegativeInteger,
		character: nonNegativeInteger,
	}),
});

const namePathTargetSchema = Type.Object({
	type: Type.Literal("name_path"),
	namePath: nonEmptyString,
	path: Type.Optional(Type.String({ minLength: 1 })),
});

const symbolIdTargetSchema = Type.Object({
	type: Type.Literal("symbol_id"),
	symbolId: nonEmptyString,
});

const targetSchema = Type.Union([positionTargetSchema, namePathTargetSchema, symbolIdTargetSchema]);
const preciseTargetSchema = Type.Union([positionTargetSchema, symbolIdTargetSchema]);
const inspectFacetSchema = Type.Union(INSPECT_FACETS.map((facet) => Type.Literal(facet)));
const routingModeSchema = Type.Union([Type.Literal("auto"), Type.Literal("semantic"), Type.Literal("lightweight")]);
const lightweightRoutingModeSchema = Type.Union([Type.Literal("auto"), Type.Literal("lightweight")]);
const optionalPathSchema = Type.Optional(
	Type.String({ minLength: 1, description: "Workspace-relative path or directory" }),
);
const optionalLimitSchema = Type.Optional(
	Type.Integer({ minimum: 1, maximum: MAX_SYMBOLS_LIMIT, description: "Maximum number of results" }),
);
const maxCharsSchema = Type.Optional(Type.Integer({ minimum: MIN_OUTPUT_MAX_CHARS, maximum: MAX_OUTPUT_MAX_CHARS }));
const kindsSchema = Type.Optional(Type.Array(codeSymbolKindSchema, { minItems: 1, maxItems: 20 }));
const semanticRoutingProperties = {
	mode: Type.Optional(routingModeSchema),
	language: Type.Optional(Type.String({ minLength: 1 })),
	definitionId: Type.Optional(Type.String({ minLength: 1 })),
	timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 600_000 })),
};
const lightweightRoutingProperties = {
	mode: Type.Optional(lightweightRoutingModeSchema),
};

/**
 * Keep the public tool contract operation-specific. Every branch is closed so
 * a model cannot treat the union of all Symbols arguments as one operation's
 * parameter list.
 */
const symbolsOperationSchemas = [
	Type.Object(
		{
			operation: Type.Literal("find_symbol"),
			query: nonEmptyQuery,
			namePath: Type.Optional(nonEmptyString),
			path: optionalPathSchema,
			kinds: kindsSchema,
			...lightweightRoutingProperties,
			exact: Type.Optional(Type.Boolean()),
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_symbol"),
			query: Type.Optional(nonEmptyQuery),
			namePath: nonEmptyString,
			path: optionalPathSchema,
			kinds: kindsSchema,
			...lightweightRoutingProperties,
			exact: Type.Optional(Type.Boolean()),
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_definition"),
			query: nonEmptyQuery,
			path: optionalPathSchema,
			...lightweightRoutingProperties,
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_definition"),
			target: targetSchema,
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_references"),
			query: nonEmptyQuery,
			path: optionalPathSchema,
			...lightweightRoutingProperties,
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find_references"),
			target: targetSchema,
			...semanticRoutingProperties,
			includeDeclaration: Type.Optional(Type.Boolean()),
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
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
			operation: Type.Literal("find_implementations"),
			target: targetSchema,
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
			operation: Type.Literal("search_code"),
			query: nonEmptyQuery,
			path: optionalPathSchema,
			regex: Type.Optional(Type.Boolean()),
			ignoreCase: Type.Optional(Type.Boolean()),
			limit: optionalLimitSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("code_map"),
			path: optionalPathSchema,
			limit: optionalLimitSchema,
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
			operation: Type.Literal("inspect_symbol"),
			target: preciseTargetSchema,
			facets: Type.Optional(
				Type.Array(inspectFacetSchema, { minItems: 1, maxItems: INSPECT_FACETS.length, uniqueItems: true }),
			),
			pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_INSPECT_PAGE_SIZE })),
			...semanticRoutingProperties,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("inspect_symbol"),
			continuation: Type.String({
				minLength: 1,
				description: "Continuation value returned by an earlier inspect_symbol facet",
			}),
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

export type SymbolsToolTarget = Static<typeof targetSchema>;

export interface SymbolsInspectFacetDetails {
	name: InspectFacetName;
	status: InspectFacetStatus;
	total: number;
	offset: number;
	hasMore: boolean;
	source?: IntelligenceSource;
	completeness?: ResultCompleteness;
	reason?: string;
	/** The items were left out of the text to respect the output budget. */
	omitted?: boolean;
}

export interface SymbolsInspectDetails {
	snapshot: string;
	stale?: string;
	facets: SymbolsInspectFacetDetails[];
}

export interface SymbolsToolDetails {
	operation: SymbolsToolInput["operation"];
	source?: IntelligenceSource;
	completeness?: ResultCompleteness;
	fallback?: IntelligenceResultMeta["fallback"];
	warnings?: string[];
	/** Which language servers answered, failed or were not asked (workspace-level queries). */
	coverage?: QueryCoverage;
	provenance?: IntelligenceResultMeta["provenance"];
	/** Per-facet outcome of an inspect_symbol call. */
	inspect?: SymbolsInspectDetails;
	legacyCompatibility?: boolean;
	refresh?: CodeIndexRefreshSummary;
	fileCount?: number;
	symbolCount?: number;
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

const LEGACY_COMPATIBILITY_WARNING =
	"legacy query matching is lexical/name-based and does not provide precise semantic target identity";

type DomainResult =
	| SymbolSearchResult
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

function validateTarget(value: unknown, operation: string): SymbolTarget {
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
	if (target.type === "name_path") {
		const namePath = requireNonEmpty(target.namePath, operation, "target.namePath");
		const path = nonEmpty(target.path, operation, "target.path");
		return path ? { type: "name_path", namePath, path } : { type: "name_path", namePath };
	}
	if (target.type === "symbol_id") {
		return { type: "symbol_id", symbolId: requireNonEmpty(target.symbolId, operation, "target.symbolId") };
	}
	throw new SymbolsToolInputError(operation, `${operation} target has an unsupported type`);
}

function validateInspectFacets(value: unknown, operation: string): void {
	if (value === undefined) return;
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > INSPECT_FACETS.length ||
		new Set(value).size !== value.length ||
		value.some((facet) => typeof facet !== "string" || !(INSPECT_FACETS as readonly string[]).includes(facet))
	) {
		throw new SymbolsToolInputError(
			operation,
			`${operation} facets must be a non-empty list of distinct names from: ${INSPECT_FACETS.join(", ")}`,
		);
	}
}

function validatePreciseSemanticTarget(value: unknown, operation: string): InspectTarget {
	const target = validateTarget(value, operation);
	if (target.type === "name_path") {
		throw new SymbolsToolInputError(operation, `${operation} requires a position or symbol_id target`);
	}
	return target;
}

function validateCommonTypes(args: Record<string, unknown>, operation: SymbolsOperation): void {
	const allowed = allowedArguments[operation];
	const unsupported = Object.keys(args).filter((key) => args[key] !== undefined && !allowed.has(key));
	if (unsupported.length > 0) {
		throw new SymbolsToolInputError(operation, `${operation} does not accept: ${unsupported.join(", ")}`);
	}
	if (args.mode !== undefined && args.mode !== "auto" && args.mode !== "semantic" && args.mode !== "lightweight") {
		throw new SymbolsToolInputError(operation, `${operation} mode must be auto, semantic, or lightweight`);
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
	validateBoolean(args.exact, operation, "exact");
	validateBoolean(args.regex, operation, "regex");
	validateBoolean(args.ignoreCase, operation, "ignoreCase");
	validateBoolean(args.includeDeclaration, operation, "includeDeclaration");
}

function validateSymbolsToolInput(input: SymbolsToolInput): SymbolsToolInput {
	const args = recordOf(input);
	const operation = args.operation;
	if (
		operation !== "find_symbol" &&
		operation !== "find_definition" &&
		operation !== "find_references" &&
		operation !== "file_symbols" &&
		operation !== "find_implementations" &&
		operation !== "diagnostics" &&
		operation !== "search_code" &&
		operation !== "code_map" &&
		operation !== "workspace_symbols" &&
		operation !== "resolve_symbol" &&
		operation !== "hover" &&
		operation !== "incoming_calls" &&
		operation !== "outgoing_calls" &&
		operation !== "supertypes" &&
		operation !== "subtypes" &&
		operation !== "inspect_symbol" &&
		operation !== "status"
	) {
		throw new SymbolsToolInputError(String(operation ?? ""), "symbols operation is required and must be supported");
	}
	validateCommonTypes(args, operation);

	if (operation === "status") return input;

	if (operation === "workspace_symbols") {
		requireNonEmpty(args.query, operation, "query");
		if (hasValue(args, "target") || hasValue(args, "namePath")) {
			throw new SymbolsToolInputError(
				operation,
				"workspace_symbols accepts query and routing options, not target or namePath",
			);
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

	if (operation === "inspect_symbol") {
		if (hasValue(args, "continuation")) {
			const extra = Object.keys(args).filter(
				(key) => args[key] !== undefined && key !== "operation" && key !== "continuation" && key !== "maxChars",
			);
			if (extra.length > 0) {
				throw new SymbolsToolInputError(
					operation,
					`inspect_symbol with a continuation accepts only continuation and maxChars; remove: ${extra.join(", ")}`,
				);
			}
			requireNonEmpty(args.continuation, operation, "continuation");
			return input;
		}
		if (!hasValue(args, "target")) {
			throw new SymbolsToolInputError(operation, "inspect_symbol requires target or continuation");
		}
		validatePreciseSemanticTarget(args.target, operation);
		validateInspectFacets(args.facets, operation);
		validateInteger(args.pageSize, operation, "pageSize", 1, MAX_INSPECT_PAGE_SIZE);
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
		validatePreciseSemanticTarget(args.target, operation);
		return input;
	}

	if (operation === "find_symbol") {
		if (hasValue(args, "target")) {
			throw new SymbolsToolInputError(operation, "find_symbol does not accept target; use query or namePath");
		}
		const query = nonEmpty(args.query, operation, "query");
		const namePath = nonEmpty(args.namePath, operation, "namePath");
		if (!query && !namePath) throw new SymbolsToolInputError(operation, "find_symbol requires query or namePath");
		if (args.includeDeclaration !== undefined) {
			throw new SymbolsToolInputError(operation, "find_symbol does not accept includeDeclaration");
		}
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

	if (operation === "search_code") {
		requireNonEmpty(args.query, operation, "query");
		if (
			hasValue(args, "target") ||
			args.mode !== undefined ||
			args.language !== undefined ||
			args.definitionId !== undefined ||
			args.timeoutMs !== undefined
		) {
			throw new SymbolsToolInputError(
				operation,
				"search_code is textual and does not accept Code Intelligence routing options",
			);
		}
		return input;
	}

	if (operation === "code_map") {
		nonEmpty(args.path, operation, "path");
		if (hasValue(args, "target") || hasValue(args, "query")) {
			throw new SymbolsToolInputError(operation, "code_map accepts only an optional path, limit, and maxChars");
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

	const hasTarget = hasValue(args, "target");
	const hasQuery = hasValue(args, "query");
	if (hasTarget && hasQuery) throw new SymbolsToolInputError(operation, "target and query cannot be used together");
	if (hasTarget) {
		if (hasValue(args, "path"))
			throw new SymbolsToolInputError(operation, "target carries its own path; top-level path is not allowed");
		if (hasValue(args, "limit"))
			throw new SymbolsToolInputError(operation, "limit is only supported by the legacy query compatibility path");
		validateTarget(args.target, operation);
		if (operation === "find_definition" && args.includeDeclaration !== undefined) {
			throw new SymbolsToolInputError(operation, "find_definition does not accept includeDeclaration");
		}
		return input;
	}

	requireNonEmpty(args.query, operation, "query");
	if (
		args.mode === "semantic" ||
		args.language !== undefined ||
		args.definitionId !== undefined ||
		args.timeoutMs !== undefined
	) {
		throw new SymbolsToolInputError(
			operation,
			"legacy query matching only supports the lightweight compatibility path; provide a precise target for routing",
		);
	}
	if (args.includeDeclaration !== undefined) {
		throw new SymbolsToolInputError(operation, "includeDeclaration requires a precise target");
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

	copyIfAllowed("mode", raw.mode);
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

function formatLegacySymbol(symbol: IndexedCodeSymbol): string {
	const parent = symbol.parentName ? ` in ${symbol.parentName}` : "";
	const exported = symbol.exported ? " exported" : "";
	return `${symbol.path}:${symbol.line} ${symbol.kind} ${symbol.name}${parent}${exported} — ${symbol.signature}`;
}

function formatLegacyReference(reference: IndexedCodeReference): string {
	return `${reference.path}:${reference.line} ${reference.referenceKind} ${reference.target} — ${reference.text}`;
}

function formatSearchMatch(match: CodeSearchMatch): string {
	return `${match.path}:${match.line}: ${match.text}`;
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

function symbolTargetHint(symbol: CodeSymbol, supportsSymbolIds: boolean): string {
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
	return JSON.stringify({ type: "name_path", path: symbol.path, namePath: symbol.namePath });
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
	return `${indent}${position.text} ${symbol.kind} ${symbol.namePath} [${symbol.language}] precision=${position.precision}${signature} target=${symbolTargetHint(symbol, supportsSymbolIds)}`;
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
	const source = details.source ?? "lightweight";
	const completeness = details.completeness ?? "complete";
	const parts = [`source=${source}`, `completeness=${completeness}`];
	if (details.fallback) parts.push(`fallback=${details.fallback.reason}`);
	if (details.legacyCompatibility) parts.push("legacy_compatibility=true");
	return `[${parts.join(" ")}]`;
}

function describeCoverageEntry(entry: QueryCoverage["entries"][number]): string {
	const subject = [
		entry.definitionId,
		entry.language,
		entry.project === undefined ? undefined : `project=${entry.project || "."}`,
	]
		.filter((part) => part !== undefined && part !== "")
		.join(" ");
	const detail = entry.detail ? ` (${entry.detail})` : "";
	return `${subject || "server"} status=${entry.status}${detail}`;
}

/** Coverage is shown only when it carries information the header does not: something was not covered. */
function coverageNotices(coverage: QueryCoverage | undefined): string[] {
	if (!coverage) return [];
	const notices: string[] = [];
	const answered = coverage.entries.filter((entry) => entry.status === "ok" || entry.status === "empty");
	const gaps = coverage.entries.filter((entry) => entry.status !== "ok" && entry.status !== "empty");
	const truncated = coverage.entries.filter((entry) => entry.truncated);
	notices.push(
		`[coverage] mode=${coverage.mode} answered=${answered.length} not_covered=${gaps.length}${truncated.length > 0 ? " truncated=true" : ""}`,
	);
	for (const entry of gaps) notices.push(`[coverage] ${describeCoverageEntry(entry)}`);
	if (coverage.inventory && !coverage.inventory.complete) {
		notices.push(`[coverage] workspace scan incomplete: ${coverage.inventory.limits.join("; ")}`);
	}
	return notices;
}

function composeOutput(details: SymbolsToolDetails, lines: string[], emptyText: string): string {
	const notices: string[] = [metaHeader(details)];
	if (details.fallback?.message) notices.push(`[fallback] ${details.fallback.message}`);
	if (details.completeness === "partial") notices.push("[warning] result is partial and may be incomplete");
	for (const warning of details.warnings ?? []) notices.push(`[warning] ${warning}`);
	if (details.provenance?.adapter) {
		const { name, detail } = details.provenance.adapter;
		notices.push(
			`[adapter] ${name}${detail ? ` (${detail})` : ""}: relations come from the written extends/implements clauses`,
		);
	}
	notices.push(...coverageNotices(details.coverage));
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
		...(meta.coverage ? { coverage: meta.coverage } : {}),
		...(meta.provenance ? { provenance: meta.provenance } : {}),
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
	} else if (operation === "find_symbol") {
		lines = (result as SymbolSearchResult).items.map((symbol) => formatCodeSymbol(symbol, "", supportsSymbolIds));
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
		const relations = new Map(
			(result.meta.hierarchy?.relations ?? []).map((entry) => [entry.symbolId, entry.relation]),
		);
		lines = (result as TypeHierarchyResult).items.map((symbol) => {
			const line = formatCodeSymbol(symbol, "", supportsSymbolIds);
			const relation = relations.get(symbol.id);
			return relation ? `${line} [${relation}]` : line;
		});
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

function isAnswered(status: InspectFacetStatus): boolean {
	return status === "ok" || status === "empty";
}

function formatInspectItem(
	facet: InspectFacet,
	item: InspectFacetItem,
	relations: ReadonlyMap<string, string>,
	supportsSymbolIds: boolean,
): string[] {
	switch (facet.name) {
		case "references":
			return [formatCodeReference(item as CodeReference)];
		case "incoming_calls":
		case "outgoing_calls":
			return formatCallEdge(item as import("../symbols/types.ts").CodeCallEdge, supportsSymbolIds);
		case "hover":
			return formatHover(item as CodeHoverInfo);
		case "diagnostics":
			return [formatDiagnostic(item as CodeDiagnostic)];
		case "supertypes":
		case "subtypes": {
			const symbol = item as CodeSymbol;
			const line = formatCodeSymbol(symbol, "", supportsSymbolIds);
			const relation = relations.get(symbol.id);
			return [relation ? `${line} [${relation}]` : line];
		}
		default:
			return [formatCodeSymbol(item as CodeSymbol, "", supportsSymbolIds)];
	}
}

function inspectFacetHeader(facet: InspectFacet, omitted: boolean): string {
	const parts = [`status=${facet.status}`];
	if (isAnswered(facet.status) || facet.status === "stale") parts.push(`total=${facet.total}`);
	if (facet.status === "ok") {
		parts.push(omitted ? "showing=none" : `showing=${facet.offset + 1}-${facet.offset + facet.items.length}`);
	}
	if (facet.meta) parts.push(`source=${facet.meta.source}`, `completeness=${facet.meta.completeness}`);
	if (facet.meta?.fallback) parts.push(`fallback=${facet.meta.fallback.reason}`);
	// A facet whose items were left out has no continuation: resuming would silently skip them.
	if (facet.continuation && !omitted) parts.push(`continuation=${facet.continuation}`);
	return `[facet ${facet.name}] ${parts.join(" ")}`;
}

function inspectFacetNotes(facet: InspectFacet): string[] {
	const notes: string[] = [];
	if (facet.reason) notes.push(`  reason: ${facet.reason}`);
	if (facet.meta?.fallback?.message) notes.push(`  [fallback] ${facet.meta.fallback.message}`);
	for (const warning of facet.meta?.warnings ?? []) notes.push(`  [warning] ${warning}`);
	const adapter = facet.meta?.provenance?.adapter;
	if (adapter) {
		notes.push(
			`  [adapter] ${adapter.name}${adapter.detail ? ` (${adapter.detail})` : ""}: relations come from the written extends/implements clauses`,
		);
	}
	for (const notice of coverageNotices(facet.meta?.coverage)) notes.push(`  ${notice}`);
	return notes;
}

function inspectFacetBody(facet: InspectFacet, supportsSymbolIds: boolean): string[] {
	const relations = new Map((facet.meta?.hierarchy?.relations ?? []).map((entry) => [entry.symbolId, entry.relation]));
	const lines = facet.items.flatMap((item) => formatInspectItem(facet, item, relations, supportsSymbolIds));
	if (facet.byFile && facet.byFile.length > 0) {
		lines.push(`by_file: ${facet.byFile.map((entry) => `${entry.path}=${entry.count}`).join(", ")}`);
	}
	return lines.map((line) => `  ${line}`);
}

const INSPECT_OMITTED_NOTE =
	"  items omitted to fit maxChars; ask for this facet alone (facets: [name]) or raise maxChars";

/** Facet-level output budget: whole item blocks are dropped from the end, so no continuation value is cut in half. */
function renderInspectResult(
	result: InspectResult,
	supportsSymbolIds: boolean,
	maxChars: number,
): { text: string; details: SymbolsToolDetails } {
	const answered = result.facets.filter((facet) => isAnswered(facet.status));
	const unanswered = result.facets.filter((facet) => !isAnswered(facet.status));
	const sources = new Set(result.facets.map((facet) => facet.meta?.source));
	const complete =
		!result.stale &&
		result.facets.length > 0 &&
		unanswered.length === 0 &&
		result.facets.every((facet) => facet.meta?.completeness !== "partial");
	const definitionIds = [
		...new Set(result.facets.flatMap((facet) => facet.meta?.provenance?.definitionIds ?? [])),
	].sort();

	const head: string[] = [];
	const symbol = result.target.symbol;
	const position = result.target.position;
	const targetText = symbol
		? formatCodeSymbol(symbol, "", supportsSymbolIds)
		: position
			? `${position.path}:${position.position.line + 1}:${position.position.character}`
			: "unresolved";
	head.push(`[inspect] target: ${targetText}`);
	if (result.stale) {
		head.push(`[stale] ${result.stale}; locate the symbol again with workspace_symbols or file_symbols`);
	} else if (unanswered.length > 0) {
		head.push(
			`[inspect] answered=${answered.length}/${result.facets.length}; not answered: ${unanswered
				.map((facet) => `${facet.name}=${facet.status}`)
				.join(", ")}`,
		);
	}

	const sections = result.facets.map((facet) => ({
		facet,
		notes: inspectFacetNotes(facet),
		body: inspectFacetBody(facet, supportsSymbolIds),
		omitted: false,
	}));
	const render = (): string[] => [
		...head,
		...sections.flatMap((section) => [
			inspectFacetHeader(section.facet, section.omitted),
			...section.notes,
			...(section.omitted ? [INSPECT_OMITTED_NOTE] : section.body),
		]),
	];
	const headerLine = `[source=${sources.has("semantic") ? "semantic" : "lightweight"} completeness=${complete ? "complete" : "partial"}]`;
	const size = (): number => headerLine.length + 1 + render().join("\n").length;
	for (let index = sections.length - 1; index >= 0 && size() > maxChars; index--) {
		if (sections[index].body.length > 0) sections[index].omitted = true;
	}

	const details: SymbolsToolDetails = {
		operation: "inspect_symbol",
		source: sources.has("semantic") ? "semantic" : "lightweight",
		completeness: complete ? "complete" : "partial",
		...(definitionIds.length > 0 ? { provenance: { definitionIds } } : {}),
		inspect: {
			snapshot: result.snapshot,
			...(result.stale ? { stale: result.stale } : {}),
			facets: sections.map(({ facet, omitted }) => ({
				name: facet.name,
				status: facet.status,
				total: facet.total,
				offset: facet.offset,
				hasMore: facet.continuation !== undefined,
				...(facet.meta ? { source: facet.meta.source, completeness: facet.meta.completeness } : {}),
				...(facet.reason ? { reason: facet.reason } : {}),
				...(omitted ? { omitted: true } : {}),
			})),
		},
	};
	return { text: [headerLine, ...render()].join("\n"), details };
}

function directDetails(
	operation: SymbolsOperation,
	refresh: CodeIndexRefreshSummary,
	index: SymbolsIndexPort,
	options?: { legacyCompatibility?: boolean },
): SymbolsToolDetails {
	const stats = index.getStats();
	const warnings = refresh.limited ? ["lightweight index refresh was limited; results may be incomplete"] : [];
	if (options?.legacyCompatibility) warnings.push(LEGACY_COMPATIBILITY_WARNING);
	return {
		operation,
		source: "lightweight",
		completeness: refresh.limited || options?.legacyCompatibility ? "partial" : "complete",
		warnings,
		legacyCompatibility: options?.legacyCompatibility,
		refresh,
		fileCount: stats.fileCount,
		symbolCount: stats.symbolCount,
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
			"Structured queries for project code symbols, definitions, references, implementations, call relationships, type hierarchies, file structure, and diagnostics; inspect_symbol profiles one object across all of these with a per-facet status; also supports explicit text search. The operation selects a closed, operation-specific parameter set: do not combine parameters from different operations. Semantic results state their source and completeness; lightweight lexical results are only leads.",
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
			} else if (operation === "inspect_symbol") {
				const advancedRouter = requireAdvancedRouter(runtime.router, operation);
				const raw = recordOf(args);
				let inspected: InspectResult;
				if (hasValue(raw, "continuation")) {
					let continuation: InspectContinuation;
					try {
						continuation = decodeContinuation(
							requireNonEmpty(raw.continuation, operation, "continuation"),
							signal,
						);
					} catch (cause) {
						if (cause instanceof InspectContinuationError)
							throw new SymbolsToolInputError(operation, cause.message);
						throw cause;
					}
					inspected = await continueInspect(advancedRouter, continuation);
				} else {
					inspected = await inspectSymbol(advancedRouter, {
						target: validatePreciseSemanticTarget(raw.target, operation),
						facets: raw.facets as InspectFacetName[] | undefined,
						pageSize: raw.pageSize as number | undefined,
						routing: routingOptions(args, signal),
					});
				}
				const rendered = renderInspectResult(inspected, supportsSymbolIds, maxChars);
				text = rendered.text;
				details = rendered.details;
			} else if (
				operation === "hover" ||
				operation === "incoming_calls" ||
				operation === "outgoing_calls" ||
				operation === "supertypes" ||
				operation === "subtypes"
			) {
				const target = validatePreciseSemanticTarget(args.target, operation);
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
			} else if (operation === "find_symbol") {
				const query = nonEmpty(args.query, operation, "query");
				const namePath = nonEmpty(args.namePath, operation, "namePath");
				const symbolQuery: SymbolQuery = {
					query,
					namePath,
					path: nonEmpty(args.path, operation, "path"),
					kinds: args.kinds as CodeSymbolKind[] | undefined,
					exact: args.exact,
					limit: args.limit,
				};
				const rendered = renderDomainResult(
					operation,
					await runtime.router.findSymbol(symbolQuery, routingOptions(args, signal)),
					supportsSymbolIds,
				);
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
			} else if (operation === "find_definition" || operation === "find_references") {
				const raw = recordOf(args);
				if (hasValue(raw, "target")) {
					const target = validateTarget(raw.target, operation);
					const result =
						operation === "find_definition"
							? await runtime.router.findDefinition(target, routingOptions(args, signal))
							: await runtime.router.findReferences(target, routingOptions(args, signal));
					const rendered = renderDomainResult(operation, result, supportsSymbolIds);
					text = rendered.text;
					details = rendered.details;
				} else {
					const query = requireQuery(operation, raw.query);
					const refresh = await runtime.index.ensureFresh(signal);
					const queryOptions = {
						path: nonEmpty(raw.path, operation, "path"),
						limit: raw.limit as number | undefined,
						signal,
						skipRefresh: true,
					};
					const output =
						operation === "find_definition"
							? (await runtime.index.findDefinition(query, queryOptions)).map(formatLegacySymbol)
							: (await runtime.index.findReferences(query, queryOptions)).map(formatLegacyReference);
					details = directDetails(operation, refresh, runtime.index, { legacyCompatibility: true });
					text = composeOutput(details, output, "No matching legacy symbols or references found");
				}
			} else if (operation === "search_code") {
				const query = requireQuery(operation, args.query);
				const refresh = await runtime.index.ensureFresh(signal);
				const output = (
					await runtime.index.searchCode(query, {
						path: nonEmpty(args.path, operation, "path"),
						limit: args.limit,
						regex: args.regex,
						ignoreCase: args.ignoreCase,
						signal,
						skipRefresh: true,
					})
				).map(formatSearchMatch);
				details = directDetails(operation, refresh, runtime.index);
				text = composeOutput(details, output, "No textual matches found");
			} else {
				const refresh = await runtime.index.ensureFresh(signal);
				const output = (
					await runtime.index.getCodeMap(nonEmpty(args.path, operation, "path"), {
						limit: args.limit,
						signal,
						skipRefresh: true,
					})
				).flatMap((entry) => [
					`${entry.path} (${getCodeLanguage(entry.path) ?? entry.language})`,
					...entry.symbols.map((symbol) => `  ${formatLegacySymbol(symbol)}`),
				]);
				details = directDetails(operation, refresh, runtime.index);
				text = composeOutput(details, output, "No code map entries found");
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

export type { SymbolsCodeIntelligenceServices, SymbolsIndexPort } from "./symbols-runtime.ts";
export { SymbolsToolConfigurationError } from "./symbols-runtime.ts";
