import { LspRequestAbortedError } from "../../lsp/errors.ts";
import type { SymbolTarget } from "../../types.ts";

export type RouterOperation =
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
	| "subtypes";

export type RouterBackend = "semantic" | "unsupported";

function causeValues(error: unknown): unknown[] {
	const values: unknown[] = [];
	const queue: unknown[] = [error];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		values.push(current);
		if (current instanceof Error) {
			if (current.cause !== undefined) queue.push(current.cause);
			if (current instanceof AggregateError) queue.push(...current.errors);
		}
	}
	return values;
}

export function isAbortError(error: unknown): boolean {
	return causeValues(error).some((value) => {
		if (!(value instanceof Error)) return false;
		return (
			value instanceof LspRequestAbortedError ||
			value.name === "AbortError" ||
			(value as Error & { code?: unknown }).code === "ABORT_ERR"
		);
	});
}

export function backendForTarget(operation: RouterOperation, target: SymbolTarget): RouterBackend {
	if (operation === "find_definition" || operation === "find_references" || operation === "find_implementations") {
		return target.type === "position" ? "semantic" : "unsupported";
	}
	return "unsupported";
}
