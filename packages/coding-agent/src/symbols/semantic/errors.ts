export type SemanticErrorCode =
	| "backend_disposed"
	| "document_not_found"
	| "document_not_readable"
	| "document_outside_workspace"
	| "document_sync_failed"
	| "unsupported_capability"
	| "unsupported_position_encoding"
	| "unsupported_target"
	| "unsupported_language"
	| "invalid_document_position"
	| "invalid_server_response"
	| "result_conversion_failed"
	| "request_failed"
	| "server_unavailable"
	| "ambiguous_target";

export interface SemanticBackendErrorOptions {
	readonly cause?: unknown;
	readonly workspaceRoot?: string;
	readonly filePath?: string;
	readonly capability?: string;
	readonly method?: string;
}

export class SemanticBackendError extends Error {
	readonly code: SemanticErrorCode;
	readonly workspaceRoot: string | undefined;
	readonly filePath: string | undefined;
	readonly capability: string | undefined;
	readonly method: string | undefined;

	constructor(code: SemanticErrorCode, message: string, options: SemanticBackendErrorOptions = {}) {
		super(message, { cause: options.cause });
		this.name = new.target.name;
		this.code = code;
		this.workspaceRoot = options.workspaceRoot;
		this.filePath = options.filePath;
		this.capability = options.capability;
		this.method = options.method;
	}
}

export class SemanticBackendDisposedError extends SemanticBackendError {
	constructor() {
		super("backend_disposed", "semantic backend has been disposed");
	}
}

export class SemanticCapabilityUnsupportedError extends SemanticBackendError {
	constructor(capability: string, cause?: unknown) {
		super("unsupported_capability", `language server does not support ${capability}`, { capability, cause });
	}
}

export class SemanticUnsupportedPositionEncodingError extends SemanticBackendError {
	constructor(encoding: unknown, cause?: unknown) {
		super("unsupported_position_encoding", `unsupported LSP position encoding: ${String(encoding)}`, { cause });
	}
}

export class SemanticDocumentOutsideWorkspaceError extends SemanticBackendError {
	constructor(filePath: string, workspaceRoot: string, cause?: unknown) {
		super("document_outside_workspace", "document must be inside the workspace root", {
			filePath,
			workspaceRoot,
			cause,
		});
	}
}

export class SemanticDocumentReadError extends SemanticBackendError {
	constructor(filePath: string, cause: unknown) {
		super("document_not_readable", `document could not be read: ${filePath}`, { filePath, cause });
	}
}

export class SemanticDocumentSyncError extends SemanticBackendError {
	constructor(filePath: string, cause: unknown) {
		super("document_sync_failed", `document synchronization failed: ${filePath}`, { filePath, cause });
	}
}

export class SemanticUnsupportedTargetError extends SemanticBackendError {
	constructor(targetType: string) {
		super("unsupported_target", `semantic backend does not support target type: ${targetType}`);
	}
}

export class SemanticAmbiguousTargetError extends SemanticBackendError {
	constructor(message = "semantic target is ambiguous") {
		super("ambiguous_target", message);
	}
}
