export type CodeIntelligenceRouterErrorCode =
	| "semantic_backend_unavailable"
	| "lightweight_backend_unavailable"
	| "unsupported_operation"
	| "unsupported_target"
	| "invalid_routing_options"
	| "fallback_not_safe"
	| "fallback_failed"
	| "symbol_id_resolution_unavailable"
	| "unknown_symbol_id"
	| "stale_symbol_id"
	| "ambiguous_target";

export interface CodeIntelligenceRouterErrorOptions {
	readonly operation?: string;
	readonly cause?: unknown;
	readonly primaryCause?: unknown;
	readonly fallbackCause?: unknown;
}

export class CodeIntelligenceRouterError extends Error {
	readonly code: CodeIntelligenceRouterErrorCode;
	readonly operation: string | undefined;
	readonly primaryCause: unknown;
	readonly fallbackCause: unknown;

	constructor(
		code: CodeIntelligenceRouterErrorCode,
		message: string,
		options: CodeIntelligenceRouterErrorOptions = {},
	) {
		super(message, { cause: options.cause ?? options.primaryCause });
		this.name = new.target.name;
		this.code = code;
		this.operation = options.operation;
		this.primaryCause = options.primaryCause;
		this.fallbackCause = options.fallbackCause;
	}
}
