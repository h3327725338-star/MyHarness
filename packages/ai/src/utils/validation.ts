import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
	const?: unknown;
}

/**
 * Tools whose parameters are one object per operation (a union whose branches each fix a constant such as
 * `operation: "click"`): the one branch the call names by those constants, if exactly one does.
 */
function discriminatedBranch(value: unknown, schema: JsonSchemaObject | undefined): JsonSchemaObject | undefined {
	if (!schema || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].filter((branch) => branch?.properties);
	if (branches.length < 2) return undefined;
	const record = value as Record<string, unknown>;
	const matching = branches.filter((branch) => {
		const constants = Object.entries(branch.properties ?? {}).filter(([, sub]) => sub.const !== undefined);
		return constants.length > 0 && constants.every(([key, sub]) => key in record && record[key] === sub.const);
	});
	return matching.length === 1 ? matching[0] : undefined;
}

/** The field every branch of such a union fixes to a constant (e.g. `operation`), and the values it may take. */
function discriminator(schema: JsonSchemaObject): { key: string; values: unknown[] } | undefined {
	const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
	if (branches.length < 2 || !branches.every((branch) => branch?.properties)) return undefined;
	const keys = Object.entries(branches[0]!.properties ?? {})
		.filter(([, sub]) => sub.const !== undefined)
		.map(([key]) => key);
	const key = keys.find((candidate) =>
		branches.every((branch) => branch.properties?.[candidate]?.const !== undefined),
	);
	return key ? { key, values: branches.map((branch) => branch.properties![key]!.const) } : undefined;
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return getValidator(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			if (value === null) {
				return false;
			}
			if (typeof value === "string") {
				if (value === "true") {
					return true;
				}
				if (value === "false") {
					return false;
				}
			}
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			if (value === null) {
				return "";
			}
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			return value;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (schema.items && typeof schema.items === "object") {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/**
 * Model channels sometimes serialize an object/array parameter as a JSON *string* (a very common slip on tools
 * whose payload is a few KB of JSON). TypeBox's `Value.Convert` only coerces primitives, so the call then fails
 * with a "must be object" schema error and a whole tool round is lost. Against the schema, parse such a string
 * back exactly where the schema expects an object or array - plain string arguments are never touched, and a
 * string that does not parse stays as it is so the real validation error still surfaces.
 */
function schemaAcceptsKind(schema: JsonSchemaObject | undefined, kind: "object" | "array"): boolean {
	if (!schema) return false;
	if (getSchemaTypes(schema).includes(kind)) return true;
	return [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].some((member) =>
		schemaAcceptsKind(member, kind),
	);
}

function parseJsonContainer(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/** The parsed container must actually be the kind this schema position wants, or the string is left alone. */
function parsedFitsSchema(parsed: unknown, schema: JsonSchemaObject | undefined): boolean {
	if (!schema) return false;
	for (const kind of getSchemaTypes(schema)) {
		if (kind === "object" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return true;
		if (kind === "array" && Array.isArray(parsed)) return true;
	}
	return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some((member) => parsedFitsSchema(parsed, member));
}

function repairStringifiedContainers(value: unknown, schema: JsonSchemaObject | undefined): unknown {
	if (
		typeof value === "string" &&
		schema &&
		(schemaAcceptsKind(schema, "object") || schemaAcceptsKind(schema, "array"))
	) {
		const parsed = parseJsonContainer(value);
		return parsed !== undefined && parsedFitsSchema(parsed, schema)
			? repairStringifiedContainers(parsed, schema)
			: value;
	}
	if (Array.isArray(value)) {
		const itemSchema = schema?.items;
		for (let index = 0; index < value.length; index++) {
			const forItem =
				itemSchema === undefined
					? undefined
					: Array.isArray(itemSchema)
						? (itemSchema[index] ?? itemSchema[itemSchema.length - 1])
						: itemSchema;
			value[index] = repairStringifiedContainers(value[index], forItem);
		}
		return value;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		// One object per operation (no properties at the root): repair against the branch the call names.
		const properties = (schema?.properties ? schema : discriminatedBranch(record, schema))?.properties ?? {};
		for (const key of Object.keys(record)) {
			if (properties[key]) record[key] = repairStringifiedContainers(record[key], properties[key]);
		}
		return record;
	}
	return value;
}

/**
 * Semantic string coercion (ZCode-style semanticBoolean/semanticNumber).
 *
 * Model channels sometimes emit the *words* of a boolean ("yes", "no", "TRUE ") or a
 * quoted number ("42") for a field the tool schema declared as boolean/number/integer.
 * TypeBox `Value.Convert` already maps a few exact spellings ("true"/"false"/"1"/"0",
 * numeric strings), so this pass only adds the explicitly accepted semantic spellings
 * and case/whitespace tolerance, running BEFORE Convert with the same schema.
 *
 * Strictness is deliberate: only fields whose schema declares exactly one of these
 * scalar types are touched (a union with "string" stays a string); unexpected words
 * like "on" are NOT coerced so they still surface as a real validation error instead
 * of silently becoming `false`.
 */
const SEMANTIC_BOOLEAN_TRUE = new Set(["true", "1", "yes"]);
const SEMANTIC_BOOLEAN_FALSE = new Set(["false", "0", "no"]);
// Pure decimal number only: rejects hex ("0x10"), underscores ("12_000"), binary literals and trailing junk.
const PURE_DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const NO_SEMANTIC_COERCION = Symbol("noSemanticCoercion");

function semanticCoerceString(value: string, schemaTypes: string[]): unknown {
	if (schemaTypes.length !== 1) {
		return NO_SEMANTIC_COERCION;
	}
	const schemaType = schemaTypes[0];
	if (schemaType === "boolean") {
		const normalized = value.trim().toLowerCase();
		if (SEMANTIC_BOOLEAN_TRUE.has(normalized)) {
			return true;
		}
		if (SEMANTIC_BOOLEAN_FALSE.has(normalized)) {
			return false;
		}
		return NO_SEMANTIC_COERCION;
	}
	if (schemaType === "number" || schemaType === "integer") {
		const trimmed = value.trim();
		if (PURE_DECIMAL_PATTERN.test(trimmed)) {
			const parsed = Number(trimmed);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return NO_SEMANTIC_COERCION;
}

/**
 * Walks the *declared* schema shape (object properties, or those of the union branch the
 * call names; no array-item guessing) and replaces strings that the schema type explicitly
 * accepts with their semantic value.
 */
function applySemanticStringCoercion(value: unknown, schema: JsonSchemaObject | undefined): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return;
	}
	const shape = schema?.properties ? schema : discriminatedBranch(value, schema);
	if (!shape?.properties) {
		return;
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		const propertySchema = shape.properties[key];
		if (!propertySchema) {
			continue;
		}
		const propertyValue = record[key];
		if (typeof propertyValue === "string") {
			const coerced = semanticCoerceString(propertyValue, getSchemaTypes(propertySchema));
			if (coerced !== NO_SEMANTIC_COERCION) {
				record[key] = coerced;
			}
			continue;
		}
		if (propertyValue !== null && typeof propertyValue === "object" && !Array.isArray(propertyValue)) {
			applySemanticStringCoercion(propertyValue, propertySchema);
		}
	}
}

/**
 * For one object per operation, the errors of every branch bury the one that matters (each branch the call did not
 * name adds "root: must not have additional properties"), and the models that read them re-sent the same call. Report
 * the named branch alone, with a property it does not take named outright next to what it does take; or, when the
 * call names no branch, the values that select one.
 */
function describeValidationErrors(
	schema: JsonSchemaObject,
	args: unknown,
	validator: ReturnType<typeof Compile>,
): string {
	const list = (errors: Iterable<TLocalizedValidationError>, skipExtra = false) =>
		[...errors]
			.filter((error) => !(skipExtra && error.keyword === "additionalProperties"))
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`);
	const branch = discriminatedBranch(args, schema);
	const branchValidator = branch ? getSubSchemaValidator(branch) : undefined;
	if (branch && branchValidator) {
		const known = Object.keys(branch.properties ?? {});
		const unknown =
			branch.additionalProperties === false
				? Object.keys(args as Record<string, unknown>).filter((key) => !known.includes(key))
				: [];
		const lines = [
			...unknown.map((key) => `  - ${key}: not a parameter of this operation; it takes ${known.join(", ")}`),
			...list(branchValidator.Errors(args), unknown.length > 0),
		];
		if (lines.length > 0) return lines.join("\n");
	}
	const named = discriminator(schema);
	if (named && !branch && args !== null && typeof args === "object") {
		const given = (args as Record<string, unknown>)[named.key];
		const problem = given === undefined ? "missing" : `${JSON.stringify(given)} is not one of its values`;
		return `  - ${named.key}: ${problem}; use one of ${named.values.map((value) => JSON.stringify(value)).join(", ")}`;
	}
	return list(validator.Errors(args)).join("\n") || "Unknown validation error";
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
function isTypeBoxDeclared(schema: unknown): boolean {
	return (
		typeof schema === "object" &&
		schema !== null &&
		("~kind" in schema || Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND))
	);
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const args = structuredClone(toolCall.arguments);
	// Repair stringified containers before Value.Convert: the repair is schema-driven and leaves genuine strings
	// alone, while Convert would already wrap a loose string into a one-element array and hide the real shape.
	repairStringifiedContainers(args, tool.parameters as unknown as JsonSchemaObject);
	const parameters = tool.parameters as unknown as JsonSchemaObject | undefined;
	// A provider-safe root (`Type.Unsafe({ type: "object", anyOf: union.anyOf })`) loses the mark; its branches keep it.
	const isTypeBoxSchema =
		isTypeBoxDeclared(parameters) ||
		[...(parameters?.anyOf ?? []), ...(parameters?.oneOf ?? [])].some(isTypeBoxDeclared);
	// Semantic coercion only for TypeBox-declared schemas: plain JSON schemas keep their
	// existing AJV-style strictness (e.g. "1" for a boolean stays a rejected string).
	if (isTypeBoxSchema) {
		applySemanticStringCoercion(args, parameters);
	}
	Value.Convert(tool.parameters, args);

	const validator = getValidator(tool.parameters);
	// 该判断在 TypeBox 1.x 下恒为真（标记是 "~kind" 字符串键，不是 Symbol），保持原样是为了不改变既有工具的参数校验路径；如需修复应作为单独决定。
	if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters as JsonSchemaObject);
		if (coerced !== args) {
			if (typeof args === "object" && args !== null && typeof coerced === "object" && coerced !== null) {
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else {
				return validator.Check(coerced) ? coerced : args;
			}
		}
	}

	if (validator.Check(args)) {
		return args;
	}

	const errors = describeValidationErrors(tool.parameters as unknown as JsonSchemaObject, args, validator);

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
