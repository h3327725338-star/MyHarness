import { LspRequestAbortedError } from "../../lsp/errors.ts";
import {
	LanguageServerError,
	LanguageServerInitializeError,
	LanguageServerStartError,
	LanguageServerUnavailableError,
	NoLanguageServerRegisteredError,
} from "../../lsp/language-server/errors.ts";
import {
	SemanticBackendError,
	SemanticCapabilityUnsupportedError,
	SemanticUnsupportedPositionEncodingError,
} from "../../semantic/errors.ts";
import type { SymbolTarget } from "../../types.ts";
import type { CodeIntelligenceRoutingMode } from "./types.ts";

export type RouterOperation =
	| "find_symbol"
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

export type RouterBackend = "semantic" | "lightweight" | "unsupported";

export type FallbackReasonCode =
	| "semantic_not_configured"
	| "semantic_server_unavailable"
	| "semantic_capability_unsupported"
	| "semantic_position_encoding_unsupported";

export interface FallbackDecision {
	readonly reason: FallbackReasonCode;
	readonly message: string;
}

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

function hasCause<T extends Error>(error: unknown, type: new (...args: never[]) => T): boolean {
	return causeValues(error).some((value) => value instanceof type);
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

export function normalizeRoutingMode(value: unknown): CodeIntelligenceRoutingMode {
	if (value === undefined) return "auto";
	if (value === "auto" || value === "semantic" || value === "lightweight") return value;
	throw new Error("invalid routing mode");
}

export function backendForTarget(operation: RouterOperation, target: SymbolTarget): RouterBackend {
	if (operation === "find_definition" || operation === "find_references") {
		if (target.type === "position") return "semantic";
		if (target.type === "name_path") return "lightweight";
		return "unsupported";
	}
	if (operation === "find_implementations") return target.type === "position" ? "semantic" : "unsupported";
	return "unsupported";
}

export function classifyFileSymbolsFallback(
	error: unknown,
	definitionId: string | undefined,
	signal: AbortSignal | undefined,
): FallbackDecision | undefined {
	if (definitionId !== undefined || signal?.aborted || isAbortError(error)) return undefined;

	if (error instanceof SemanticCapabilityUnsupportedError) {
		return {
			reason: "semantic_capability_unsupported",
			message: "semantic backend does not support document symbols",
		};
	}
	if (
		error instanceof SemanticUnsupportedPositionEncodingError ||
		(error instanceof SemanticBackendError && error.code === "unsupported_position_encoding")
	) {
		return {
			reason: "semantic_position_encoding_unsupported",
			message: "semantic backend uses an unsupported position encoding",
		};
	}
	// Do not classify by SemanticBackendError.code alone. A server_unavailable
	// wrapper is safe only when its cause chain proves a real unavailable server.
	if (hasCause(error, LanguageServerInitializeError) || hasCause(error, LanguageServerStartError)) return undefined;
	if (hasCause(error, NoLanguageServerRegisteredError) || hasCause(error, LanguageServerUnavailableError)) {
		return {
			reason: "semantic_server_unavailable",
			message: "no usable semantic language server is available",
		};
	}
	if (error instanceof LanguageServerError) return undefined;
	return undefined;
}

export function classifyWorkspaceSymbolsFallback(
	error: unknown,
	signal: AbortSignal | undefined,
): FallbackDecision | undefined {
	if (signal?.aborted || isAbortError(error)) return undefined;
	if (error instanceof SemanticCapabilityUnsupportedError) {
		return {
			reason: "semantic_capability_unsupported",
			message: "semantic backend does not support workspace symbol search",
		};
	}
	if (hasCause(error, NoLanguageServerRegisteredError) || hasCause(error, LanguageServerUnavailableError)) {
		return {
			reason: "semantic_server_unavailable",
			message: "no usable semantic language server is available for workspace symbol search",
		};
	}
	return undefined;
}
