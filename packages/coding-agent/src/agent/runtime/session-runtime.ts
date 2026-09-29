import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../extensions/compat/types.ts";
import { emitSessionShutdownEvent } from "../../extensions/runtime/runner.ts";
import { assertSessionCwdExists } from "../../session/manager/cwd.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./services.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

type RuntimeParts = {
	session: AgentSession;
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
};

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods prepare the next runtime before invalidating the
 * current one whenever the operation can be transactional. If creation or
 * rebinding fails, the old runtime remains authoritative and the error is
 * propagated to the caller.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private disposePromiseValue: Promise<void> | undefined;
	private replacementPromise: Promise<unknown> | undefined;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		let failure: unknown;
		try {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionFile,
			});
		} catch (cause) {
			failure = cause;
		} finally {
			try {
				this.beforeSessionInvalidate?.();
			} finally {
				try {
					await this.session.disposeAsync();
				} finally {
					await this._services.dispose();
				}
			}
		}
		if (failure !== undefined) throw failure;
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private captureCurrent(): RuntimeParts {
		return {
			session: this._session,
			services: this._services,
			diagnostics: this._diagnostics,
			modelFallbackMessage: this._modelFallbackMessage,
		};
	}

	private applyParts(parts: RuntimeParts): void {
		this._session = parts.session;
		this._services = parts.services;
		this._diagnostics = parts.diagnostics;
		this._modelFallbackMessage = parts.modelFallbackMessage;
	}

	private async disposeRuntime(parts: RuntimeParts): Promise<void> {
		let failure: unknown;
		try {
			await parts.session.disposeAsync();
		} catch (error) {
			failure = error;
		}
		try {
			await parts.services.dispose();
		} catch (error) {
			failure ??= error;
		}
		if (failure !== undefined) throw failure;
	}

	/**
	 * Prepare a replacement before invalidating the current runtime.  This is
	 * the transaction boundary for resume/new/fork/import: factory or setup
	 * failure leaves the old session and UI binding authoritative.
	 */
	private async replaceRuntime(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile: string | undefined,
		prepare: () => Promise<CreateAgentSessionRuntimeResult>,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<void> {
		this.assertCanReplaceRuntime();

		const operation = this.replaceRuntimeInternal(reason, targetSessionFile, prepare, withSession);
		this.replacementPromise = operation;
		try {
			await operation;
		} finally {
			if (this.replacementPromise === operation) this.replacementPromise = undefined;
		}
	}

	/**
	 * Check replacement admission immediately before creating or committing a
	 * target manager. The before-switch hook is asynchronous, so a prompt can
	 * start while it is running; re-check before any target-side write.
	 */
	private assertCanReplaceRuntime(): void {
		if (this.replacementPromise) {
			throw new Error("A session replacement is already in progress");
		}
		if (!this.session.isIdle) {
			throw new Error("Cannot replace the session while the current session is running");
		}
	}

	private async replaceRuntimeInternal(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile: string | undefined,
		prepare: () => Promise<CreateAgentSessionRuntimeResult>,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<void> {
		const previous = this.captureCurrent();
		const prepared = await prepare();
		let committed = false;
		try {
			await emitSessionShutdownEvent(previous.session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionFile,
			});
			this.beforeSessionInvalidate?.();
			this.apply(prepared);
			committed = true;
			// Rebinding is the last rollback-safe step. The old runtime has not
			// been disposed yet, so a rebind failure can still restore it.
			await this.finishSessionReplacement();
		} catch (error) {
			const rollbackErrors: string[] = [];
			if (committed) {
				this.applyParts(previous);
				try {
					if (this.rebindSession) await this.rebindSession(previous.session);
				} catch (rollbackError) {
					rollbackErrors.push(
						`原会话重新绑定失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			try {
				await this.disposeRuntime(prepared);
			} catch (disposeError) {
				rollbackErrors.push(
					`新会话清理失败：${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
				);
			}
			throw new Error(
				[error instanceof Error ? error.message : String(error), ...rollbackErrors].filter(Boolean).join("；"),
			);
		}

		// The new runtime is now authoritative. A failure while releasing the old
		// runtime must not roll the new runtime back into a half-disposed state.
		await this.disposeRuntime(previous);
		// Run callbacks only after the old runtime has been invalidated. A callback
		// must not observe a still-live stale pi/ctx from the replaced session, and
		// its failure cannot make the already-committed runtime non-authoritative.
		if (withSession) await withSession(this.session.createReplacedSessionContext());
	}

	private async finishSessionReplacement(): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		this.assertCanReplaceRuntime();

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.replaceRuntime(
			"resume",
			sessionManager.getSessionFile(),
			() =>
				this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
				}),
			options?.withSession,
		);
		return { cancelled: false };
	}

	/**
	 * Switch the runtime to a different working directory (workspace) without
	 * resuming an existing session: a brand-new session is created in the new
	 * cwd, and all cwd-bound services and tools are rebuilt for it.
	 *
	 * This is the workspace-level counterpart of {@link newSession} (same cwd)
	 * and {@link switchSession} (existing session file, cwd from header).
	 *
	 * @throws When the target cwd does not exist or is not a directory.
	 */
	async switchWorkspace(
		cwd: string,
		options?: {
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const resolvedCwd = resolvePath(cwd);
		if (!existsSync(resolvedCwd)) {
			throw new Error(`Workspace directory does not exist: ${resolvedCwd}`);
		}
		if (!statSync(resolvedCwd).isDirectory()) {
			throw new Error(`Workspace path is not a directory: ${resolvedCwd}`);
		}

		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		this.assertCanReplaceRuntime();

		const previousSessionFile = this.session.sessionFile;
		// Keep a user-provided custom session directory, otherwise use the
		// default per-cwd session directory for the new workspace. In-memory
		// sessions (--no-session) stay in-memory.
		const sessionDir = this.session.sessionManager.usesDefaultSessionDir()
			? undefined
			: this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(resolvedCwd, sessionDir)
			: SessionManager.inMemory(resolvedCwd);

		await this.replaceRuntime(
			"new",
			sessionManager.getSessionFile(),
			() =>
				this.createRuntime({
					cwd: resolvedCwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
					projectTrustContext: options?.projectTrustContextFactory?.(resolvedCwd),
				}),
			options?.withSession,
		);
		return { cancelled: false };
	}

	/**
	 * Rebuild cwd-bound services after the directory containing the active
	 * workspace was renamed or moved, while preserving the current conversation.
	 * A caller moving the directory can defer that filesystem change until the
	 * old cwd-bound services are disposed, which is required on Windows when a
	 * file watcher still holds a handle inside the repository.
	 */
	async relocateWorkspace(
		cwd: string,
		options?: {
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
			beforeCommit?: () => Promise<void> | void;
			rollbackBeforeCommit?: () => Promise<void> | void;
			moveDirectory?: () => Promise<void> | void;
			rollbackDirectoryMove?: () => void;
		},
	): Promise<{ cancelled: boolean; warnings: string[] }> {
		if (this.replacementPromise) {
			throw new Error("A session replacement is already in progress");
		}
		if (!this.session.isIdle) {
			throw new Error("Cannot relocate a workspace while the current session is running");
		}

		const operation = this.relocateWorkspaceInternal(cwd, options);
		this.replacementPromise = operation;
		try {
			return await operation;
		} finally {
			if (this.replacementPromise === operation) this.replacementPromise = undefined;
		}
	}

	private async relocateWorkspaceInternal(
		cwd: string,
		options?: {
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
			beforeCommit?: () => Promise<void> | void;
			rollbackBeforeCommit?: () => Promise<void> | void;
			moveDirectory?: () => Promise<void> | void;
			rollbackDirectoryMove?: () => void;
		},
	): Promise<{ cancelled: boolean; warnings: string[] }> {
		const resolvedCwd = resolvePath(cwd);
		const moveDirectory = options?.moveDirectory;
		const rollbackDirectoryMove = options?.rollbackDirectoryMove;
		if (moveDirectory && !rollbackDirectoryMove) {
			throw new Error("A directory move rollback callback is required");
		}
		if (!moveDirectory) {
			if (!existsSync(resolvedCwd)) throw new Error(`Workspace directory does not exist: ${resolvedCwd}`);
			if (!statSync(resolvedCwd).isDirectory()) throw new Error(`Workspace path is not a directory: ${resolvedCwd}`);
		}
		if (!this.session.isIdle) throw new Error("Cannot relocate a workspace while the current session is running");

		const oldCwd = this.cwd;
		const agentDir = this.services.agentDir;
		const currentManager = this.session.sessionManager;
		const relocatedManager = currentManager.createRelocated(resolvedCwd, agentDir);
		const beforeResult = await this.emitBeforeSwitch("resume", relocatedManager.getSessionFile());
		if (beforeResult.cancelled) return { cancelled: true, warnings: [] };
		if (!this.session.isIdle) throw new Error("Cannot relocate a workspace while the current session is running");

		const previousSessionFile = this.session.sessionFile;
		const warnings: string[] = [];
		let oldRuntimeTornDown = false;
		let directoryMoved = false;
		let metadataCommitAttempted = false;
		let relocationCommitted = false;
		let prepared: CreateAgentSessionRuntimeResult | undefined;
		try {
			try {
				await this.teardownCurrent("resume", relocatedManager.getSessionFile());
			} catch (error) {
				warnings.push(`旧会话关闭时出现错误：${error instanceof Error ? error.message : String(error)}`);
			}
			oldRuntimeTornDown = true;

			if (moveDirectory) {
				await moveDirectory();
				directoryMoved = true;
			}
			if (!existsSync(resolvedCwd)) throw new Error(`Workspace directory does not exist: ${resolvedCwd}`);
			if (!statSync(resolvedCwd).isDirectory()) throw new Error(`Workspace path is not a directory: ${resolvedCwd}`);
			relocatedManager.ensureSessionDirectory();

			prepared = await this.createRuntime({
				cwd: resolvedCwd,
				agentDir,
				sessionManager: relocatedManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(resolvedCwd),
			});
			if (options?.beforeCommit) {
				metadataCommitAttempted = true;
				await options.beforeCommit();
			}
			const relocation = relocatedManager.commitRelocationFrom(currentManager);
			relocationCommitted = true;
			if (relocation.warning) warnings.push(relocation.warning);

			this.apply(prepared);
			// Rebinding is part of the commit boundary. If it fails, enter the
			// rollback path below instead of returning a successful replacement with
			// a UI that still points at the disposed runtime.
			await this.finishSessionReplacement();
			prepared = undefined;
			return { cancelled: false, warnings };
		} catch (error) {
			const rollbackErrors: string[] = [];
			if (metadataCommitAttempted) {
				try {
					await options?.rollbackBeforeCommit?.();
				} catch (rollbackError) {
					rollbackErrors.push(
						`元数据回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			if (prepared) {
				try {
					await prepared.session.disposeAsync();
				} catch (disposeError) {
					rollbackErrors.push(
						`新会话清理失败：${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
					);
				}
				try {
					await prepared.services.dispose();
				} catch (disposeError) {
					rollbackErrors.push(
						`新会话服务清理失败：${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
					);
				}
			}
			if (relocationCommitted) {
				try {
					relocatedManager.rollbackRelocationFrom(currentManager);
				} catch (rollbackError) {
					rollbackErrors.push(
						`会话文件回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			if (directoryMoved) {
				try {
					rollbackDirectoryMove?.();
				} catch (rollbackError) {
					rollbackErrors.push(
						`目录回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			if (oldRuntimeTornDown) {
				try {
					if (!existsSync(oldCwd) || !statSync(oldCwd).isDirectory()) {
						throw new Error(`原工作目录无法恢复：${oldCwd}`);
					}
					const recovered = await this.createRuntime({
						cwd: oldCwd,
						agentDir,
						sessionManager: currentManager,
						sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
						projectTrustContext: options?.projectTrustContextFactory?.(oldCwd),
					});
					this.apply(recovered);
					await this.finishSessionReplacement();
				} catch (recoveryError) {
					rollbackErrors.push(
						`原会话恢复失败：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
					);
				}
			}
			throw new Error(
				[error instanceof Error ? error.message : String(error), ...rollbackErrors].filter(Boolean).join("；"),
			);
		}
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		this.assertCanReplaceRuntime();

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.usesDefaultSessionDir()
			? undefined
			: this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.replaceRuntime(
			"new",
			sessionManager.getSessionFile(),
			async () => {
				const prepared = await this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
				});
				if (options?.setup) {
					await options.setup(prepared.session.sessionManager);
					prepared.session.agent.state.messages = prepared.session.sessionManager.buildSessionContext().messages;
				}
				return prepared;
			},
			options?.withSession,
		);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		this.assertCanReplaceRuntime();
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.usesDefaultSessionDir()
				? undefined
				: this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.replaceRuntime(
					"fork",
					sessionManager.getSessionFile(),
					() =>
						this.createRuntime({
							cwd: this.cwd,
							agentDir: this.services.agentDir,
							sessionManager,
							sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
						}),
					options?.withSession,
				);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.replaceRuntime(
				"fork",
				sessionManager.getSessionFile(),
				() =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				options?.withSession,
			);
			return { cancelled: false, selectedText };
		}

		let sessionManager: SessionManager;
		if (!targetLeafId) {
			sessionManager = SessionManager.inMemory(this.cwd, { parentSession: this.session.sessionFile });
		} else {
			sessionManager = this.session.sessionManager.createInMemoryBranchedSession(targetLeafId);
		}
		await this.replaceRuntime(
			"fork",
			sessionManager.getSessionFile(),
			() =>
				this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			options?.withSession,
		);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const usesDefaultStorage = this.session.sessionManager.usesDefaultSessionDir();
		if (usesDefaultStorage) {
			const beforeResult = await this.emitBeforeSwitch("resume", resolvedPath);
			if (beforeResult.cancelled) return beforeResult;
			this.assertCanReplaceRuntime();
			const previousSessionFile = this.session.sessionFile;
			const sessionManager = SessionManager.importFrom(resolvedPath, this.cwd, cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
			await this.replaceRuntime("resume", sessionManager.getSessionFile(), () =>
				this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				}),
			);
			return { cancelled: false };
		}
		const sessionDir = usesDefaultStorage ? undefined : this.session.sessionManager.getSessionDir();

		let destinationPath = sessionDir ? join(sessionDir, basename(resolvedPath)) : resolvedPath;
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		this.assertCanReplaceRuntime();
		if (sessionDir && !existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

		const previousSessionFile = this.session.sessionFile;
		if (sessionDir && resolve(destinationPath) !== resolvedPath && existsSync(destinationPath)) {
			const extension = ".jsonl";
			const stem = basename(destinationPath).endsWith(extension)
				? basename(destinationPath).slice(0, -extension.length)
				: basename(destinationPath);
			destinationPath = join(sessionDir, `${stem}-import-${randomUUID()}.jsonl`);
		}

		let temporaryImportPath: string | undefined;
		if (sessionDir && resolve(destinationPath) !== resolvedPath) {
			temporaryImportPath = `${destinationPath}.import-${randomUUID()}.tmp`;
			try {
				copyFileSync(resolvedPath, temporaryImportPath);
				const validated = SessionManager.open(temporaryImportPath, sessionDir, cwdOverride);
				assertSessionCwdExists(validated, this.cwd);
				renameSync(temporaryImportPath, destinationPath);
				temporaryImportPath = undefined;
			} catch (error) {
				if (temporaryImportPath) rmSync(temporaryImportPath, { force: true });
				throw error;
			}
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.replaceRuntime("resume", sessionManager.getSessionFile(), () =>
			this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		return { cancelled: false };
	}

	/**
	 * Create an independent runtime (its own session and cwd-bound services) from the same
	 * factory. The current runtime is not touched, so hosts that show several sessions at once
	 * (the Web UI) can keep one runtime per open session and let them run concurrently.
	 */
	async createSibling(options: {
		sessionManager: SessionManager;
		sessionStartEvent: SessionStartEvent;
		projectTrustContext?: ProjectTrustContext;
	}): Promise<AgentSessionRuntime> {
		assertSessionCwdExists(options.sessionManager, this.cwd);
		const result = await this.createRuntime({
			cwd: options.sessionManager.getCwd(),
			agentDir: this.services.agentDir,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			projectTrustContext: options.projectTrustContext,
		});
		return new AgentSessionRuntime(
			result.session,
			result.services,
			this.createRuntime,
			result.diagnostics,
			result.modelFallbackMessage,
		);
	}

	async dispose(): Promise<void> {
		if (this.disposePromiseValue) return this.disposePromiseValue;
		this.disposePromiseValue = this.disposeInternal();
		return this.disposePromiseValue;
	}

	private async disposeInternal(): Promise<void> {
		let failure: unknown;
		try {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
		} catch (cause) {
			failure = cause;
		} finally {
			try {
				this.beforeSessionInvalidate?.();
			} finally {
				try {
					await this.session.disposeAsync();
				} finally {
					await this._services.dispose();
				}
			}
		}
		if (failure !== undefined) throw failure;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later new-session, resume, fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./services.ts";
