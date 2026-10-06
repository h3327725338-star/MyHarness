/**
 * Error codes of controlled changes. They name what a caller can do next: re-read and plan again
 * (SNAPSHOT_STALE, EDIT_CONFLICT), ask for approval (PERMIT_REQUIRED, REUSE_REVIEW_REQUIRED), fix the
 * input (INVALID_EDIT, PATH_OUT_OF_SCOPE), or wait for a person (RECOVERY_CONFLICT).
 */
export type ChangeErrorCode =
	| "CAPABILITY_UNSUPPORTED"
	| "RENAME_REFUSED"
	| "PROJECT_NOT_READY"
	| "TARGET_AMBIGUOUS"
	| "SNAPSHOT_STALE"
	| "COVERAGE_INCOMPLETE"
	| "REUSE_REVIEW_REQUIRED"
	| "PERMIT_REQUIRED"
	| "PERMIT_INVALID"
	| "PATH_OUT_OF_SCOPE"
	| "EDIT_CONFLICT"
	| "VERIFY_TIMEOUT"
	| "RECOVERY_CONFLICT"
	| "INVALID_EDIT"
	| "UNSUPPORTED_ENCODING"
	| "UNSUPPORTED_RESOURCE_OPERATION"
	| "UNSUPPORTED_FILE"
	| "LOCK_TIMEOUT"
	| "CANCELLED"
	| "NOT_FOUND";

export class ChangeControlError extends Error {
	readonly code: ChangeErrorCode;
	/** Paths (workspace-relative) the error is about, when it is about particular files. */
	readonly paths: readonly string[];

	constructor(code: ChangeErrorCode, message: string, options: { paths?: readonly string[]; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ChangeControlError";
		this.code = code;
		this.paths = options.paths ?? [];
	}
}

export function isChangeControlError(error: unknown, code?: ChangeErrorCode): error is ChangeControlError {
	return error instanceof ChangeControlError && (code === undefined || error.code === code);
}
