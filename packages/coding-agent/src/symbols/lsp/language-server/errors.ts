/** Structured errors raised by the Phase 4 language-server manager. */

export type LanguageServerErrorCode =
	| "invalid_definition"
	| "duplicate_definition"
	| "definition_not_found"
	| "no_server_registered"
	| "unsupported_language"
	| "invalid_workspace_root"
	| "manager_disposed"
	| "instance_disposed"
	| "server_unavailable"
	| "server_start_failed"
	| "server_initialize_failed"
	| "server_disposal_failed";

export interface LanguageServerErrorOptions {
	readonly definitionId?: string;
	readonly workspaceRoot?: string;
	readonly language?: string;
	readonly cause?: unknown;
}

function contextSuffix(options: LanguageServerErrorOptions): string {
	const context: string[] = [];
	if (options.definitionId) context.push(`definition=${options.definitionId}`);
	if (options.workspaceRoot) context.push(`workspace=${options.workspaceRoot}`);
	if (options.language) context.push(`language=${options.language}`);
	return context.length > 0 ? ` (${context.join(", ")})` : "";
}

export class LanguageServerError extends Error {
	readonly code: LanguageServerErrorCode;
	readonly definitionId: string | undefined;
	readonly workspaceRoot: string | undefined;
	readonly language: string | undefined;

	constructor(code: LanguageServerErrorCode, message: string, options: LanguageServerErrorOptions = {}) {
		super(`${message}${contextSuffix(options)}`, { cause: options.cause });
		this.name = new.target.name;
		this.code = code;
		this.definitionId = options.definitionId;
		this.workspaceRoot = options.workspaceRoot;
		this.language = options.language;
	}
}

export class InvalidLanguageServerDefinitionError extends LanguageServerError {
	constructor(message: string, options: LanguageServerErrorOptions = {}) {
		super("invalid_definition", message, options);
	}
}

export class DuplicateLanguageServerDefinitionError extends LanguageServerError {
	constructor(definitionId: string) {
		super("duplicate_definition", `language server definition is already registered: ${definitionId}`, {
			definitionId,
		});
	}
}

export class LanguageServerDefinitionNotFoundError extends LanguageServerError {
	constructor(definitionId: string) {
		super("definition_not_found", `language server definition was not found: ${definitionId}`, { definitionId });
	}
}

export class NoLanguageServerRegisteredError extends LanguageServerError {
	constructor(language: string) {
		super("no_server_registered", `no language server is registered for language "${language}"`, { language });
	}
}

export class UnsupportedLanguageError extends LanguageServerError {
	constructor(message: string, options: LanguageServerErrorOptions = {}) {
		super("unsupported_language", message, options);
	}
}

export class InvalidWorkspaceRootError extends LanguageServerError {
	constructor(workspaceRoot: string, message: string, cause?: unknown) {
		super("invalid_workspace_root", message, { workspaceRoot, cause });
	}
}

export class LanguageServerManagerDisposedError extends LanguageServerError {
	constructor() {
		super("manager_disposed", "language server manager has been disposed");
	}
}

export class LanguageServerInstanceDisposedError extends LanguageServerError {
	constructor(definitionId: string, workspaceRoot: string, cause?: unknown) {
		super("instance_disposed", "language server instance was disposed while starting", {
			definitionId,
			workspaceRoot,
			cause,
		});
	}
}

export class LanguageServerUnavailableError extends LanguageServerError {
	constructor(definitionId: string, workspaceRoot: string, message: string, cause?: unknown) {
		super("server_unavailable", message, { definitionId, workspaceRoot, cause });
	}
}

export class LanguageServerStartError extends LanguageServerError {
	constructor(definitionId: string, workspaceRoot: string, cause: unknown) {
		super("server_start_failed", "language server process failed to start", {
			definitionId,
			workspaceRoot,
			cause,
		});
	}
}

export class LanguageServerInitializeError extends LanguageServerError {
	constructor(definitionId: string, workspaceRoot: string, cause: unknown) {
		super("server_initialize_failed", "language server initialize request failed", {
			definitionId,
			workspaceRoot,
			cause,
		});
	}
}

export class LanguageServerDisposalError extends LanguageServerError {
	readonly errors: readonly unknown[];

	constructor(errors: readonly unknown[], context: LanguageServerErrorOptions = {}) {
		super("server_disposal_failed", `failed to dispose ${errors.length} language server instance(s)`, context);
		this.errors = Object.freeze([...errors]);
	}
}
