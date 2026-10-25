import { repairJson } from "./json-parse.ts";

/**
 * Deterministic recovery of tool arguments that reached us in the wrong JSON shape.
 *
 * Some models (and some gateways in front of them) hand a nested array or object over as a
 * *string* holding its JSON, which then fails schema validation with a misleading type error.
 * This walks the tool's own schema and replaces such a value with the parsed container, and
 * nothing else: it never adds a field, never fills a missing value, never completes truncated
 * JSON, and never touches a string the schema declares as a string. When nothing matches, the
 * original reference is returned so callers can tell that no change happened.
 *
 * One narrow exception to "never completes": an array of complete items whose closing `]` alone is
 * missing (`"[\"a\", \"b\""`). Some gateways drop exactly that bracket when they turn a model's
 * array into text while the surrounding call arrives whole; every item is there, so the call is
 * used instead of failing it and costing the model a round trip to resend the same list.
 */

interface SchemaNode {
	type?: string | string[];
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	anyOf?: SchemaNode[];
	oneOf?: SchemaNode[];
}

const MAX_DEPTH = 32;

function declaredKinds(node: SchemaNode | undefined): string[] {
	if (!node) return [];
	const kinds: string[] = [];
	const collect = (candidate: SchemaNode) => {
		if (typeof candidate.type === "string") kinds.push(candidate.type);
		else if (Array.isArray(candidate.type)) kinds.push(...candidate.type);
		for (const branch of candidate.anyOf ?? []) collect(branch);
		for (const branch of candidate.oneOf ?? []) collect(branch);
	};
	collect(node);
	return kinds;
}

/**
 * `[` + complete items, with only the final `]` missing: the text must end right after a complete item (a closing
 * quote or `}`), and adding the one bracket must give an array. Anything cut inside an item stays an error.
 */
function closeArrayMissingBracket(text: string): unknown[] | undefined {
	if (!text.startsWith("[") || text.endsWith("]") || !/["}]$/.test(text)) return undefined;
	for (const candidate of [`${text}]`, `${repairJson(text)}]`]) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (Array.isArray(parsed) && parsed.length > 0) return parsed;
		} catch {
			// Try the next form.
		}
	}
	return undefined;
}

/** Parses only when the text really is the container the schema asks for; otherwise returns undefined. */
function parseAsDeclaredContainer(text: string, kinds: string[]): unknown[] | Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return undefined;
	const candidates: unknown[] = [];
	try {
		candidates.push(JSON.parse(trimmed));
	} catch {
		const repaired = repairJson(trimmed);
		try {
			if (repaired !== trimmed) candidates.push(JSON.parse(repaired));
		} catch {
			// Neither form parses; only the missing-bracket case below may still apply.
		}
	}
	if (candidates.length === 0 && kinds.includes("array")) {
		const closed = closeArrayMissingBracket(trimmed);
		if (closed) candidates.push(closed);
	}
	for (const candidate of candidates) {
		if (Array.isArray(candidate) && kinds.includes("array")) return candidate;
		if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && kinds.includes("object"))
			return candidate as Record<string, unknown>;
	}
	return undefined;
}

/**
 * The properties an object may have under a union of object schemas (a tool whose parameters are one object per
 * operation). Only the branches whose constant fields agree with the value count, so `{ operation: "batch" }` is read
 * against the batch branch alone; a key declared by several matching branches accepts what any of them declares.
 */
function unionProperties(
	value: Record<string, unknown>,
	node: SchemaNode | undefined,
): Record<string, SchemaNode> | undefined {
	const branches = [...(node?.anyOf ?? []), ...(node?.oneOf ?? [])].filter((branch) => branch?.properties);
	if (!branches.length) return undefined;
	const agrees = (branch: SchemaNode) =>
		Object.entries(branch.properties ?? {}).every(([key, sub]) => {
			const constant = (sub as { const?: unknown }).const;
			return constant === undefined || !(key in value) || value[key] === constant;
		});
	const matching = branches.filter(agrees);
	const merged: Record<string, SchemaNode> = {};
	for (const branch of matching.length ? matching : branches) {
		for (const [key, sub] of Object.entries(branch.properties ?? {})) {
			const existing = merged[key];
			merged[key] = existing ? { anyOf: [...(existing.anyOf ?? [existing]), sub] } : sub;
		}
	}
	return merged;
}

function coerceNode(value: unknown, node: SchemaNode | undefined, depth: number): unknown {
	if (depth > MAX_DEPTH) return value;
	if (typeof value === "string") {
		const parsed = parseAsDeclaredContainer(value, declaredKinds(node));
		return parsed === undefined ? value : coerceNode(parsed, node, depth + 1);
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const coerced = coerceNode(item, node?.items, depth + 1);
			if (coerced !== item) changed = true;
			return coerced;
		});
		return changed ? next : value;
	}
	if (value !== null && typeof value === "object") {
		const properties = node?.properties ?? unionProperties(value as Record<string, unknown>, node);
		if (!properties) return value;
		const record = value as Record<string, unknown>;
		let changed = false;
		const next: Record<string, unknown> = { ...record };
		for (const [key, sub] of Object.entries(properties)) {
			if (!(key in record)) continue;
			const coerced = coerceNode(record[key], sub, depth + 1);
			if (coerced !== record[key]) {
				next[key] = coerced;
				changed = true;
			}
		}
		return changed ? next : value;
	}
	return value;
}

/**
 * Returns `args` with schema-declared containers restored from a JSON string, or the very same
 * `args` reference when nothing needed recovery.
 */
export function coerceToolArgumentsBySchema<T>(schema: unknown, args: T): T {
	if (!schema || typeof schema !== "object") return args;
	if (!args || typeof args !== "object") return args;
	return coerceNode(args, schema as SchemaNode, 0) as T;
}
