export type LightweightBackendErrorCode = "invalid_query" | "unsupported_target";

export class LightweightBackendError extends Error {
	readonly code: LightweightBackendErrorCode;

	constructor(code: LightweightBackendErrorCode, message: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

export class LightweightUnsupportedTargetError extends LightweightBackendError {
	constructor(operation: string, targetType: string) {
		super("unsupported_target", `lightweight backend does not support ${operation} target type: ${targetType}`);
	}
}
