import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import type { CodeIntelligenceRoutingOptions } from "../symbols/index/router/types.ts";
import { createOperationBudget, SymbolsTimeoutError } from "../symbols/operation-budget.ts";
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
import { FileSymbolCache, type WorkflowContext } from "../symbols/workflow/context.ts";
import { findExisting, renderFindExisting } from "../symbols/workflow/discovery.ts";
import { analyzeImpact } from "../symbols/workflow/impact.ts";
import type { WorkflowTarget } from "../symbols/workflow/locate.ts";
import { previewRename } from "../symbols/workflow/rename.ts";
import { readSymbol, type SliceInclude } from "../symbols/workflow/slice.ts";
import type { SourceSnapshot } from "../symbols/workflow/text.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { recordFileReadState, resolveFileStateScope, statFileReadState } from "./files/read-state.ts";
import { SymbolsOutputPages } from "./symbols-output.ts";
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
	| "status"
	| "find_existing"
	| "read_symbol"
	| "impact"
	| "rename_preview";

const WORKFLOW_OPERATIONS: ReadonlySet<string> = new Set(["find_existing", "read_symbol", "impact", "rename_preview"]);

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
const declarationTargetSchema = Type.Object(
	{
		type: Type.Literal("symbol"),
		path: Type.String({ minLength: 1, description: "Workspace-relative file that declares the symbol" }),
		name: Type.String({
			minLength: 1,
			description: "Declaration name, optionally qualified by its parents: load, UserService/load, UserService.load",
		}),
	},
	{ additionalProperties: false },
);
/** Workflow operations also accept a file-and-name target, which survives edits that move lines. */
const workflowTargetSchema = Type.Union([declarationTargetSchema, positionTargetSchema, symbolIdTargetSchema]);
const workflowTimeoutSchema = Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 600_000 }));
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
	Type.Object(
		{
			operation: Type.Literal("find_existing"),
			intent: Type.String({
				minLength: 1,
				description: "What the code you are about to write would do, in plain words (any language)",
			}),
			names: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					maxItems: 10,
					description: "Names you would give it or expect it to have",
				}),
			),
			path: optionalPathSchema,
			languages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 })),
			kinds: kindsSchema,
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Maximum candidates (default 8)" })),
			timeoutMs: workflowTimeoutSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("read_symbol"),
			target: workflowTargetSchema,
			include: Type.Optional(
				Type.Array(Type.Union([Type.Literal("imports"), Type.Literal("callers"), Type.Literal("callees")]), {
					minItems: 1,
					maxItems: 3,
				}),
			),
			maxLines: Type.Optional(
				Type.Integer({ minimum: 10, maximum: 2_000, description: "Source line budget (default 200)" }),
			),
			timeoutMs: workflowTimeoutSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("impact"),
			target: workflowTargetSchema,
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 500, description: "Maximum listed sites (default 80)" }),
			),
			context: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 3, description: "Lines of code around each site" }),
			),
			includeText: Type.Optional(
				Type.Boolean({
					description: "Also list text occurrences the language server did not report (default true)",
				}),
			),
			timeoutMs: workflowTimeoutSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("rename_preview"),
			target: workflowTargetSchema,
			newName: Type.String({ minLength: 1 }),
			timeoutMs: workflowTimeoutSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
];

type CanonicalSymbolsInput = Static<(typeof symbolsOperationSchemas)[number]>;
type CompatibleInput<T> = T extends { target: infer Target }
	? Omit<T, "target"> & {
			target?: Target | string;
			path?: string;
			line?: number;
			character?: number;
			name?: string;
			symbolId?: string;
			cursor?: string;
		}
	: T & { cursor?: string };
export type SymbolsToolInput = CompatibleInput<CanonicalSymbolsInput>;

/** Keep closed operation branches, but accept both the original target and flat locators. */
const compatibleOperationSchemas = symbolsOperationSchemas.map((schema) => {
	const branch = JSON.parse(JSON.stringify(schema)) as Record<string, any>;
	branch.properties.cursor = {
		type: "string",
		minLength: 1,
		description: "Opaque continuation from this tool instance; repeat the same query with cursor",
	};
	if (branch.properties.target) {
		branch.properties.target = {
			anyOf: [
				branch.properties.target,
				{ type: "string", minLength: 1, description: "Compatibility: JSON-encoded target object" },
			],
		};
		branch.required = branch.required.filter((key: string) => key !== "target");
		branch.properties.symbolId = { type: "string", minLength: 1 };
		if (branch.properties.operation.const === "resolve_symbol")
			branch.anyOf = [{ required: ["target"] }, { required: ["symbolId"] }];
		else {
			branch.properties.path = {
				type: "string",
				minLength: 1,
				description: "File of the target; use with 0-based line and character",
			};
			branch.properties.line = {
				type: "integer",
				minimum: 0,
				description: "0-based line, not the displayed 1-based line",
			};
			branch.properties.character = { type: "integer", minimum: 0, description: "0-based UTF-16 column" };
			branch.anyOf = [
				{ required: ["target"] },
				{ required: ["symbolId"] },
				{ required: ["path", "line", "character"] },
			];
			if (WORKFLOW_OPERATIONS.has(branch.properties.operation.const)) {
				branch.properties.name = {
					type: "string",
					minLength: 1,
					description: "Declaration name, qualified if needed; use with path instead of position",
				};
				branch.anyOf.push({ required: ["path", "name"] });
			}
		}
	}
	return branch;
});

/**
 * Hoist shared scalar/locator validators once. Closed branches still encode the
 * exact operation matrix; `{}` there inherits the root constraint, not an open
 * argument. This avoids resending the same target/coordinate schema 12 times.
 * No $ref/$defs: providers that strip schema declarations keep the contract.
 */
function compactOperationSchema() {
	const properties: Record<string, any> = {};
	for (const branch of compatibleOperationSchemas) {
		for (const [key, value] of Object.entries(branch.properties)) properties[key] ??= value;
	}
	properties.operation = { enum: symbolsOperationSchemas.map((branch) => branch.properties.operation.const) };
	properties.target = { anyOf: [workflowTargetSchema, { type: "string", minLength: 1 }] };
	const constraints = (value: unknown) =>
		JSON.stringify(value, (key, item) => (key === "description" ? undefined : item));
	const anyOf = compatibleOperationSchemas.map((branch) => ({
		...branch,
		properties: Object.fromEntries(
			Object.entries(branch.properties).map(([key, value]) => {
				if (key === "operation") return [key, value];
				if (key === "target")
					return [
						key,
						{
							anyOf: [
								{ type: "string" },
								{
									properties: {
										type: {
											enum:
												branch.properties.operation.const === "resolve_symbol"
													? ["symbol_id"]
													: WORKFLOW_OPERATIONS.has(branch.properties.operation.const)
														? ["position", "symbol_id", "symbol"]
														: ["position", "symbol_id"],
										},
									},
								},
							],
						},
					];
				return [key, constraints(value) === constraints(properties[key]) ? {} : value];
			}),
		),
	}));
	return { type: "object", properties, anyOf };
}

/** Object root remains compatible with providers that do not accept a union root. */
const symbolsSchema = Type.Unsafe<SymbolsToolInput>(compactOperationSchema());

export type SymbolsToolTarget = Static<typeof preciseTargetSchema>;

export interface SymbolsToolDetails {
	operation: SymbolsToolInput["operation"];
	source?: IntelligenceResultMeta["source"];
	completeness?: ResultCompleteness;
	fallback?: IntelligenceResultMeta["fallback"];
	warnings?: string[];
	outputTruncated?: boolean;
	status?: "ok" | "empty" | "partial" | "unsupported";
	emptyReason?: IntelligenceResultMeta["emptyReason"];
	unsupported?: boolean;
	/** Opaque continuation token bound to this query and tool instance. */
	nextCursor?: string;
	/** 0-based entry offset within the returned query snapshot. */
	offset?: number;
	totalEntries?: number;
	/** The underlying server's completeness, distinct from presentation pagination. */
	queryCompleteness?: ResultCompleteness;
	semanticConfigured?: boolean;
	semanticEnabled?: boolean;
	symbolStoreEntryCount?: number;
	languageServerCount?: number;
	/** find_existing: number of candidates listed. */
	candidateCount?: number;
	/** read_symbol: the source itself was condensed or cut (with a continuation hint). */
	sourceTruncated?: boolean;
	/** rename_preview: the plan to pass to apply_rename. */
	renamePlanId?: string;
	renameFiles?: Array<{ path: string; edits: number }>;
	/** rename_preview: no plan was created; the output says why. */
	renameRefused?: boolean;
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
	for (const schema of compatibleOperationSchemas) {
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
	if (args.cursor !== undefined) requireNonEmpty(args.cursor, operation, "cursor");
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

function validateWorkflowTarget(value: unknown, operation: string): WorkflowTarget {
	const target = recordOf(value);
	if (target.type === "symbol") {
		const unexpected = Object.keys(target).filter((key) => key !== "type" && key !== "path" && key !== "name");
		if (unexpected.length > 0) {
			throw new SymbolsToolInputError(
				operation,
				`${operation} symbol target does not accept: ${unexpected.join(", ")}`,
			);
		}
		return {
			type: "symbol",
			path: requireNonEmpty(target.path, operation, "target.path"),
			name: requireNonEmpty(target.name, operation, "target.name"),
		};
	}
	return validateTarget(value, operation);
}

function validateStringArray(value: unknown, operation: string, label: string, maxItems: number): void {
	if (value === undefined) return;
	if (
		!Array.isArray(value) ||
		value.length > maxItems ||
		value.some((item) => typeof item !== "string" || item.trim() === "")
	) {
		throw new SymbolsToolInputError(
			operation,
			`${operation} ${label} must be an array of at most ${maxItems} non-empty strings`,
		);
	}
}

function validateWorkflowInput(args: Record<string, unknown>, operation: SymbolsOperation): void {
	if (operation === "find_existing") {
		requireNonEmpty(args.intent, operation, "intent");
		validateStringArray(args.names, operation, "names", 10);
		validateStringArray(args.languages, operation, "languages", 20);
		validateInteger(args.limit, operation, "limit", 1, 30);
		if (args.path !== undefined) requireNonEmpty(args.path, operation, "path");
		return;
	}
	if (!hasValue(args, "target")) throw new SymbolsToolInputError(operation, `${operation} requires target`);
	validateWorkflowTarget(args.target, operation);
	if (operation === "read_symbol") {
		if (
			args.include !== undefined &&
			(!Array.isArray(args.include) ||
				args.include.length === 0 ||
				args.include.some((item) => item !== "imports" && item !== "callers" && item !== "callees"))
		) {
			throw new SymbolsToolInputError(operation, "read_symbol include must list imports, callers and/or callees");
		}
		validateInteger(args.maxLines, operation, "maxLines", 10, 2_000);
	} else if (operation === "impact") {
		validateInteger(args.context, operation, "context", 0, 3);
		validateBoolean(args.includeText, operation, "includeText");
	} else if (operation === "rename_preview") {
		requireNonEmpty(args.newName, operation, "newName");
	}
}

function prepareSymbolsArguments(input: unknown): SymbolsToolInput {
	const args = { ...recordOf(input) };
	// Only lossless, named scalar/list compatibility; never infer a target or missing coordinate.
	for (const key of ["line", "character", "limit", "maxChars", "timeoutMs", "maxLines", "context"]) {
		if (typeof args[key] === "string" && /^\d+(?:\.\d+)?$/.test(args[key] as string)) args[key] = Number(args[key]);
	}
	for (const key of ["kinds", "names", "languages", "include"]) {
		if (typeof args[key] === "string") {
			try {
				const value = JSON.parse(args[key] as string);
				if (Array.isArray(value)) args[key] = value;
			} catch {
				/* validation gives the field-specific error */
			}
		}
	}
	return args as SymbolsToolInput;
}

function normalizeSymbolsInput(input: SymbolsToolInput): {
	args: CanonicalSymbolsInput & { cursor?: string };
	warnings: string[];
} {
	const raw = { ...recordOf(input) };
	const operation = String(raw.operation ?? "");
	const warnings: string[] = [];
	const targetOperation = compatibleOperationSchemas.some(
		(branch) => branch.properties.operation.const === operation && branch.properties.target,
	);
	if (targetOperation) {
		const flatPosition = hasValue(raw, "line") || hasValue(raw, "character");
		let flat: unknown;
		if (flatPosition) {
			if (!hasValue(raw, "line") || !hasValue(raw, "character") || !hasValue(raw, "path"))
				throw new SymbolsToolInputError(
					operation,
					`${operation} flat position requires path, line and character (both coordinates 0-based)`,
				);
			flat = { type: "position", path: raw.path, position: { line: raw.line, character: raw.character } };
		} else if (hasValue(raw, "name")) {
			if (!WORKFLOW_OPERATIONS.has(operation))
				throw new SymbolsToolInputError(
					operation,
					`${operation} does not accept a declaration name; use path/line/character or a returned symbolId`,
				);
			flat = { type: "symbol", path: raw.path, name: raw.name };
		} else if (hasValue(raw, "symbolId")) flat = { type: "symbol_id", symbolId: raw.symbolId };
		if (flat !== undefined) {
			if (raw.target !== undefined && JSON.stringify(raw.target) !== JSON.stringify(flat))
				warnings.push("flat target parameters take precedence over the legacy target");
			raw.target = flat;
		} else if (typeof raw.target === "string") {
			try {
				raw.target = JSON.parse(raw.target);
			} catch {
				throw new SymbolsToolInputError(
					operation,
					`${operation} target must be a valid JSON object string; prefer flat path/line/character`,
				);
			}
			if (!raw.target || typeof raw.target !== "object" || Array.isArray(raw.target))
				throw new SymbolsToolInputError(
					operation,
					`${operation} target JSON must decode to an object; prefer path/line/character`,
				);
		}
		for (const key of ["line", "character", "name", "symbolId"]) delete raw[key];
		if (flat !== undefined) delete raw.path;
	}
	return { args: raw as CanonicalSymbolsInput & { cursor?: string }, warnings };
}

function validateSymbolsToolInput(input: SymbolsToolInput): SymbolsToolInput {
	const args = recordOf(input);
	const operation = args.operation;
	if (typeof operation === "string" && WORKFLOW_OPERATIONS.has(operation)) {
		validateCommonTypes(args, operation as SymbolsOperation);
		validateWorkflowInput(args, operation as SymbolsOperation);
		return input;
	}
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
	copyIfAllowed("timeoutMs", raw.timeoutMs ?? 60_000);
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
	if (supportsSymbolIds && symbol.selectionRange) {
		return `symbolId=${JSON.stringify(symbol.id)}`;
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
	const signature = symbol.signature ? ` — ${symbol.signature.replace(/\r?\n/g, " ")}` : "";
	const target = symbolTargetHint(symbol, supportsSymbolIds);
	return `${indent}${position.text} ${symbol.kind} ${symbol.namePath} [${symbol.language}] precision=${position.precision}${signature}${target ? ` ${supportsSymbolIds ? target : `target=${target}`}` : ""}`;
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
	if (details.status && details.status !== "ok") parts.push(`status=${details.status}`);
	if (details.emptyReason) parts.push(`emptyReason=${details.emptyReason}`);
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

function detailsFromMeta(operation: SymbolsOperation, meta: IntelligenceResultMeta): SymbolsToolDetails {
	return {
		operation,
		source: meta.source,
		completeness: meta.completeness,
		fallback: meta.fallback,
		warnings: meta.warnings ? [...meta.warnings] : undefined,
		...(meta.emptyReason ? { emptyReason: meta.emptyReason } : {}),
		...(meta.unsupported ? { unsupported: true, status: "unsupported" as const } : {}),
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
	if (lines.length === 0)
		details.emptyReason ??=
			result.meta.completeness === "partial"
				? "incomplete_query"
				: operation === "diagnostics"
					? "no_diagnostics"
					: "no_matches";
	details.status ??= result.meta.completeness === "partial" ? "partial" : lines.length === 0 ? "empty" : "ok";
	return {
		text: composeOutput(
			details,
			lines,
			details.emptyReason === "no_diagnostics"
				? "No diagnostics reported for this synchronized document snapshot."
				: details.emptyReason === "no_matches"
					? "No matches reported within the queried scope."
					: `No usable results: ${details.emptyReason}. This is not proof of absence; inspect warnings and narrow scope or retry.`,
		),
		details,
	};
}

function requireQuery(operation: SymbolsOperation, value: unknown): string {
	return requireNonEmpty(value, operation, "query");
}

type WorkflowOperation = "find_existing" | "read_symbol" | "impact" | "rename_preview";

interface WorkflowOutcome {
	readonly lines: string[];
	readonly source: "semantic" | "lexical";
	readonly completeness: ResultCompleteness;
	readonly warnings: string[];
	readonly shown: readonly SourceSnapshot[];
	readonly details: Partial<SymbolsToolDetails>;
}

async function runWorkflowOperation(
	operation: WorkflowOperation,
	args: Record<string, unknown>,
	context: WorkflowContext,
): Promise<WorkflowOutcome> {
	if (operation === "find_existing") {
		const result = await findExisting(context, {
			intent: String(args.intent),
			...(Array.isArray(args.names) ? { names: args.names as string[] } : {}),
			...(typeof args.path === "string" ? { path: args.path } : {}),
			...(Array.isArray(args.languages) ? { languages: args.languages as string[] } : {}),
			...(Array.isArray(args.kinds) ? { kinds: args.kinds as CodeSymbolKind[] } : {}),
			...(typeof args.limit === "number" ? { limit: args.limit } : {}),
		});
		const lexicalOnly = [...result.coverage.languages.values()].some((coverage) => coverage.mode === "lexical");
		const partial =
			lexicalOnly ||
			result.coverage.hitsTruncated ||
			result.coverage.codeFilesTruncated ||
			result.coverage.errors.length > 0;
		return {
			lines: renderFindExisting(result),
			source: result.candidates.some((candidate) => candidate.evidence !== "lexical") ? "semantic" : "lexical",
			completeness: partial ? "partial" : "complete",
			warnings: [...result.coverage.errors],
			shown: [],
			details: {
				candidateCount: result.candidates.length,
				...(result.candidates.length === 0
					? ({
							emptyReason: partial ? "incomplete_query" : "no_matches",
							status: partial ? "partial" : "empty",
						} as const)
					: {}),
			},
		};
	}
	const target = validateWorkflowTarget(args.target, operation);
	if (operation === "read_symbol") {
		const result = await readSymbol(context, target, {
			...(Array.isArray(args.include) ? { include: args.include as SliceInclude[] } : {}),
			...(typeof args.maxLines === "number" ? { maxLines: args.maxLines } : {}),
		});
		return { ...result, details: { sourceTruncated: result.sourceTruncated } };
	}
	if (operation === "impact") {
		const result = await analyzeImpact(context, target, {
			...(typeof args.limit === "number" ? { limit: args.limit } : {}),
			...(typeof args.context === "number" ? { context: args.context } : {}),
			...(typeof args.includeText === "boolean" ? { includeText: args.includeText } : {}),
		});
		return { ...result, shown: [], details: {} };
	}
	const preview = await previewRename(context, target, String(args.newName));
	return {
		lines: preview.lines,
		source: "semantic",
		completeness: preview.kind === "planned" && !preview.partial ? "complete" : "partial",
		warnings: preview.warnings,
		shown: [],
		details:
			preview.kind === "planned"
				? {
						renamePlanId: preview.plan.id,
						renameFiles: preview.plan.files.map((file) => ({ path: file.path, edits: file.edits.length })),
					}
				: { renameRefused: true },
	};
}

function composeWorkflowOutput(details: SymbolsToolDetails, lines: string[]): string {
	const notices = [metaHeader(details)];
	for (const warning of details.warnings ?? []) notices.push(`[warning] ${warning}`);
	notices.push(...lines);
	return notices.join("\n");
}

/**
 * A slice shown by read_symbol counts as a read of that file for the
 * read-before-edit check, exactly like a ranged `read`: the model has seen
 * the code it is about to edit. It is recorded only when the file is still
 * the one that was shown.
 */
async function recordShownFiles(shown: readonly SourceSnapshot[], ctx: unknown): Promise<void> {
	if (shown.length === 0) return;
	const scope = resolveFileStateScope(ctx);
	for (const snapshot of shown) {
		const current = await statFileReadState(snapshot.absolutePath);
		if (current && current.mtimeMs === snapshot.mtimeMs && current.size === snapshot.size) {
			recordFileReadState(snapshot.absolutePath, current, scope);
		}
	}
}

export function createSymbolsToolDefinition(
	cwd: string,
	options?: SymbolsToolOptions,
): BusinessToolDefinition<typeof symbolsSchema, SymbolsToolDetails | undefined> {
	const runtime = createSymbolsToolRuntime(cwd, options);
	const fileSymbols = new FileSymbolCache();
	const pages = new SymbolsOutputPages();
	return {
		name: "symbols",
		label: "symbols",
		description:
			"Structured queries for project code symbols, definitions, references, implementations, call relationships, type hierarchies, file structure, and diagnostics. The operation selects a closed, operation-specific parameter set: do not combine parameters from different operations. Semantic results state their source and completeness.",
		promptSnippet: loadSystemPrompt("tools/symbols/snippet.md"),
		promptGuidelines: loadSystemPromptLines("tools/symbols/guidelines.md"),
		parameters: symbolsSchema,
		prepareArguments: prepareSymbolsArguments,
		async execute(_toolCallId, input: SymbolsToolInput, parentSignal?: AbortSignal, _onUpdate?, _ctx?) {
			const normalized = normalizeSymbolsInput(prepareSymbolsArguments(input));
			const args = normalized.args;
			validateSymbolsToolInput(args);
			const operation = args.operation;
			const maxChars = args.maxChars ?? DEFAULT_OUTPUT_MAX_CHARS;
			const finish = (text: string, details: SymbolsToolDetails) => {
				if (normalized.warnings.length) {
					details.warnings = [...new Set([...(details.warnings ?? []), ...normalized.warnings])];
					text = `${text}\n${normalized.warnings.map((warning) => `[warning] ${warning}`).join("\n")}`;
				}
				const rendered = pages.create(args, text, details, maxChars);
				return { content: [{ type: "text" as const, text: rendered.text }], details: rendered.details };
			};
			parentSignal?.throwIfAborted();
			if (args.cursor) {
				try {
					const page = pages.continue(args, args.cursor, maxChars);
					return { content: [{ type: "text" as const, text: page.text }], details: page.details };
				} catch (error) {
					throw new SymbolsToolInputError(operation, error instanceof Error ? error.message : String(error));
				}
			}
			const budget = createOperationBudget(
				(recordOf(args).timeoutMs as number | undefined) ?? (operation === "find_existing" ? 30_000 : 60_000),
				parentSignal,
			);
			const signal = budget.signal;
			const progressTimer = setTimeout(
				() =>
					_onUpdate?.({
						content: [
							{
								type: "text",
								text: `symbols ${operation}: language server query in progress; budget=${budget.timeoutMs}ms, cancellable`,
							},
						],
						details: { operation, status: "partial" },
					}),
				1_000,
			);
			try {
				return await budget.run(async () => {
					const supportsSymbolIds = runtime.supportsSymbolIds;
					let text: string;
					let details: SymbolsToolDetails;

					if (WORKFLOW_OPERATIONS.has(operation)) {
						const raw = recordOf(args);
						const context: WorkflowContext = {
							workspaceRoot: runtime.workspaceRoot,
							router: runtime.router,
							semanticLanguages: runtime.semanticLanguages,
							fileSymbols,
							...(signal ? { signal } : {}),
							// Leave bounded time to render retained coverage before the outer deadline.
							timeoutMs: Math.max(1, budget.remainingMs() - Math.min(2_000, budget.timeoutMs / 10)),
						};
						const outcome = await runWorkflowOperation(operation as WorkflowOperation, raw, context);
						details = {
							operation,
							source: outcome.source as IntelligenceResultMeta["source"],
							completeness: outcome.completeness,
							...(outcome.warnings.length > 0 ? { warnings: [...new Set(outcome.warnings)] } : {}),
							...outcome.details,
						};
						details.status ??= outcome.completeness === "partial" ? "partial" : "ok";
						text = composeWorkflowOutput(details, outcome.lines);
						const output = finish(text, details);
						if (!output.details.outputTruncated) await recordShownFiles(outcome.shown, _ctx);
						return output;
					}

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

					return finish(text, details);
				});
			} catch (error) {
				if (parentSignal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
				if (budget.timedOut() || error instanceof SymbolsTimeoutError)
					return finish(
						`[source=semantic completeness=partial status=partial emptyReason=timeout]\nQuery timed out after ${budget.timeoutMs}ms; narrow path or retry after server warmup. No absence or clean-code claim can be made.`,
						{ operation, source: "semantic", completeness: "partial", status: "partial", emptyReason: "timeout" },
					);
				let current: unknown = error;
				const seen = new Set<unknown>();
				while (current instanceof Error && !seen.has(current)) {
					seen.add(current);
					if (
						["unsupported_capability", "unsupported_operation"].includes(
							String((current as Error & { code?: unknown }).code),
						)
					)
						return finish(
							`[source=semantic completeness=partial status=unsupported emptyReason=unsupported]\nUnsupported: ${current.message}. ${operation === "supertypes" || operation === "subtypes" ? "Do not infer an empty hierarchy. Use definitions/implementations and source to inspect relations; these are not an exact hierarchy." : "This is not a successful empty result. Configure a supporting language server, or inspect source/text matches and verify with project checks."}`,
							{
								operation,
								source: "semantic",
								completeness: "partial",
								status: "unsupported",
								unsupported: true,
								emptyReason: "unsupported",
							},
						);
					current = current.cause;
				}
				throw error;
			} finally {
				clearTimeout(progressTimer);
				budget.dispose();
			}
		},
	};
}

export function createSymbolsTool(cwd: string, options?: SymbolsToolOptions): AgentTool<typeof symbolsSchema> {
	return wrapToolDefinition(createSymbolsToolDefinition(cwd, options));
}

export type { SymbolsCodeIntelligenceServices } from "./symbols-runtime.ts";
export { SymbolsToolConfigurationError } from "./symbols-runtime.ts";
