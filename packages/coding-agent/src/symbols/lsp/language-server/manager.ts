import { statSync } from "node:fs";
import { win32 as windowsPath } from "node:path";

import { getCodeLanguage } from "../../index/code-index.ts";
import { getWorkspaceIdentity, normalizeWorkspaceRoot as normalizeWindowsWorkspaceRoot } from "../../path-semantics.ts";
import { LspClient, type LspInitializeOptions } from "../client.ts";
import { LspProcessError } from "../errors.ts";
import type { LspClientState, LspLogger } from "../types.ts";
import { toFileUri } from "../uri.ts";
import { discoverExecutable, type ExecutableDiscoveryResult } from "./discovery.ts";
import {
	InvalidWorkspaceRootError,
	LanguageServerDefinitionNotFoundError,
	LanguageServerDisposalError,
	LanguageServerError,
	LanguageServerInitializeError,
	LanguageServerInstanceDisposedError,
	LanguageServerManagerDisposedError,
	LanguageServerStartError,
	LanguageServerUnavailableError,
	NoLanguageServerRegisteredError,
	UnsupportedLanguageError,
} from "./errors.ts";
import { LanguageServerRegistry, normalizeLanguageId } from "./registry.ts";
import type {
	LanguageServerAcquireOptions,
	LanguageServerClientFactory,
	LanguageServerDefinition,
	LanguageServerInstanceSelector,
	LanguageServerManagerOptions,
	LanguageServerStatusSnapshot,
	ManagedLanguageServer,
	ManagedLanguageServerState,
} from "./types.ts";

interface ManagedEntry {
	readonly key: string;
	readonly definition: LanguageServerDefinition;
	readonly workspaceRoot: string;
	readonly workspaceIdentity: string;
	state: ManagedLanguageServerState;
	client: LspClient | undefined;
	managed: ManagedLanguageServer | undefined;
	startPromise: Promise<ManagedLanguageServer>;
	disposePromise: Promise<void> | undefined;
	disposeSignal: Promise<void>;
	resolveDisposeSignal: () => void;
}

function defaultClientFactory(
	definition: LanguageServerDefinition,
	workspaceRoot: string,
	logger: LspLogger | undefined,
): LspClient {
	return new LspClient(
		{
			command: definition.command,
			args: definition.args,
			cwd: workspaceRoot,
			env: { ...process.env, ...(definition.env ?? {}) },
			logger,
		},
		{
			...(definition.clientOptions ?? {}),
			logger,
		},
	);
}

/** Normalize and validate an explicit workspace root without resolving symlinks. */
export function normalizeWorkspaceRoot(workspaceRoot: string): string {
	if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
		throw new InvalidWorkspaceRootError(String(workspaceRoot), "workspace root must be a non-empty path");
	}

	let normalized: string;
	try {
		normalized = normalizeWindowsWorkspaceRoot(workspaceRoot);
	} catch (cause) {
		throw new InvalidWorkspaceRootError(workspaceRoot, "workspace root path could not be resolved", cause);
	}

	try {
		if (!statSync(normalized).isDirectory()) {
			throw new InvalidWorkspaceRootError(workspaceRoot, "workspace root is not a directory");
		}
	} catch (cause) {
		if (cause instanceof InvalidWorkspaceRootError) throw cause;
		throw new InvalidWorkspaceRootError(workspaceRoot, "workspace root does not exist or is not accessible", cause);
	}
	return normalized;
}

/** Cache identity uses normalized absolute paths and does not resolve symlinks. */
export { getWorkspaceIdentity } from "../../path-semantics.ts";

function makeInstanceKey(definitionId: string, workspaceIdentity: string): string {
	return `${definitionId}\u0000${workspaceIdentity}`;
}

function isInitialized(client: LspClient | undefined): boolean {
	return client?.state === "initialized";
}

function clientStatus(client: LspClient | undefined): LspClientState | undefined {
	return client?.state;
}

/**
 * Owns the runtime lifecycle of language-server clients.
 *
 * The manager intentionally does not send semantic LSP requests or synchronize
 * documents. It only routes definitions and owns process/client lifetime.
 */
export class LanguageServerManager {
	readonly registry: LanguageServerRegistry;

	private readonly logger: LspLogger | undefined;
	private readonly createClient: LanguageServerClientFactory;
	private readonly entries = new Map<string, ManagedEntry>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: LanguageServerManagerOptions = {}) {
		this.registry = options.registry ?? new LanguageServerRegistry();
		this.logger = options.logger;
		this.createClient = options.createClient ?? defaultClientFactory;
	}

	async acquire(options: LanguageServerAcquireOptions): Promise<ManagedLanguageServer> {
		this.ensureActive();
		const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
		const workspaceIdentity = getWorkspaceIdentity(workspaceRoot);
		const language = this.resolveLanguage(options);

		let candidates: readonly LanguageServerDefinition[];
		if (options.definitionId !== undefined) {
			const definitionId = options.definitionId.trim();
			const definition = this.registry.get(definitionId);
			if (!definition) throw new LanguageServerDefinitionNotFoundError(definitionId);
			if (language !== undefined && !definition.languages.includes(language)) {
				throw new UnsupportedLanguageError(`language server definition does not support language "${language}"`, {
					definitionId: definition.id,
					language,
				});
			}
			candidates = [definition];
		} else {
			if (language === undefined) {
				throw new UnsupportedLanguageError("language or a file path with a supported extension is required");
			}
			candidates = this.registry.getCandidates(language);
			if (candidates.length === 0) throw new NoLanguageServerRegisteredError(language);
		}

		let lastUnavailable: LanguageServerUnavailableError | undefined;
		for (const definition of candidates) {
			this.ensureActive();
			try {
				return await this.acquireDefinition(definition, workspaceRoot, workspaceIdentity);
			} catch (cause) {
				if (cause instanceof LanguageServerUnavailableError) {
					lastUnavailable = cause;
					continue;
				}
				throw cause;
			}
		}

		if (lastUnavailable) throw lastUnavailable;
		throw new NoLanguageServerRegisteredError(language ?? "unknown");
	}

	async getClientForFile(
		filePath: string,
		options: Omit<LanguageServerAcquireOptions, "filePath">,
	): Promise<LspClient> {
		const managed = await this.acquire({ ...options, filePath });
		return managed.client;
	}

	/**
	 * Acquire a server for workspace-level requests that have no source file.
	 * An explicit definition remains strict; otherwise the highest-priority
	 * registered definition is selected deterministically.
	 */
	async acquireForWorkspace(options: {
		readonly workspaceRoot: string;
		readonly language?: string;
		readonly definitionId?: string;
	}): Promise<ManagedLanguageServer> {
		if (options.language !== undefined) {
			return this.acquire({ ...options });
		}
		const definition = options.definitionId
			? this.registry.get(options.definitionId)
			: [...this.registry.getAll()].sort(
					(left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
				)[0];
		if (!definition) {
			if (options.definitionId) throw new LanguageServerDefinitionNotFoundError(options.definitionId);
			throw new NoLanguageServerRegisteredError("workspace");
		}
		return this.acquire({
			workspaceRoot: options.workspaceRoot,
			language: definition.languages[0],
			definitionId: definition.id,
		});
	}

	async disposeServer(selector: LanguageServerInstanceSelector): Promise<void> {
		const workspaceRoot = normalizeWorkspaceRoot(selector.workspaceRoot);
		const key = makeInstanceKey(selector.definitionId.trim(), getWorkspaceIdentity(workspaceRoot));
		const entry = this.entries.get(key);
		if (entry) await this.disposeEntry(entry);
	}

	async disposeWorkspace(workspaceRootInput: string): Promise<void> {
		const workspaceRoot = normalizeWorkspaceRoot(workspaceRootInput);
		const workspaceIdentity = getWorkspaceIdentity(workspaceRoot);
		const entries = [...this.entries.values()].filter((entry) => entry.workspaceIdentity === workspaceIdentity);
		await this.disposeEntries(entries);
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.disposePromise = this.disposeAllEntries();
		return this.disposePromise;
	}

	getServers(): readonly LanguageServerStatusSnapshot[] {
		return Object.freeze([...this.entries.values()].map((entry) => this.createStatusSnapshot(entry)));
	}

	/**
	 * Return status for all definitions without acquiring or starting a client.
	 * This is the status surface used by CodeIntelligenceRuntime.
	 */
	getStatusForWorkspace(workspaceRootInput: string): readonly LanguageServerStatusSnapshot[] {
		const workspaceRoot = normalizeWorkspaceRoot(workspaceRootInput);
		const workspaceIdentity = getWorkspaceIdentity(workspaceRoot);
		return Object.freeze(
			this.registry.getAll().map((definition) => {
				const key = makeInstanceKey(definition.id, workspaceIdentity);
				const entry = this.entries.get(key);
				return entry ? this.createStatusSnapshot(entry) : this.createDefinitionStatus(definition, workspaceRoot);
			}),
		);
	}

	getServerStatus(selector: LanguageServerInstanceSelector): LanguageServerStatusSnapshot | undefined {
		const workspaceRoot = normalizeWorkspaceRoot(selector.workspaceRoot);
		const key = makeInstanceKey(selector.definitionId.trim(), getWorkspaceIdentity(workspaceRoot));
		const entry = this.entries.get(key);
		return entry ? this.createStatusSnapshot(entry) : undefined;
	}

	private resolveLanguage(options: LanguageServerAcquireOptions): string | undefined {
		if (options.language !== undefined) {
			const language = normalizeLanguageId(options.language);
			if (!language) throw new UnsupportedLanguageError("language must not be empty");
			return language;
		}
		if (options.filePath !== undefined) {
			const language = getCodeLanguage(options.filePath);
			if (!language) {
				throw new UnsupportedLanguageError(`file path has no supported code language: ${options.filePath}`);
			}
			return normalizeLanguageId(language);
		}
		return undefined;
	}

	private async acquireDefinition(
		definition: LanguageServerDefinition,
		workspaceRoot: string,
		workspaceIdentity: string,
	): Promise<ManagedLanguageServer> {
		this.ensureActive();
		const key = makeInstanceKey(definition.id, workspaceIdentity);
		for (;;) {
			const existing = this.entries.get(key);
			if (!existing) break;
			if (existing.state === "starting") return existing.startPromise;
			if (existing.state === "ready" && existing.managed && isInitialized(existing.client)) {
				return existing.managed;
			}
			// A failed, closed, or externally crashed client is evicted lazily. Wait
			// for disposal before creating a replacement for the same cache key. The
			// loop is important: many callers can resume after the same disposal, and
			// only the first caller may create the replacement entry.
			await this.disposeEntry(existing);
			this.ensureActive();
		}

		let resolveDisposeSignal!: () => void;
		const disposeSignal = new Promise<void>((resolve) => {
			resolveDisposeSignal = resolve;
		});
		const entry: ManagedEntry = {
			key,
			definition,
			workspaceRoot,
			workspaceIdentity,
			state: "starting",
			client: undefined,
			managed: undefined,
			startPromise: Promise.resolve(undefined as never),
			disposePromise: undefined,
			disposeSignal,
			resolveDisposeSignal,
		};
		// Publish before starting so every concurrent acquire shares this promise.
		this.entries.set(key, entry);
		entry.startPromise = this.startEntry(entry);
		return entry.startPromise;
	}

	private async startEntry(entry: ManagedEntry): Promise<ManagedLanguageServer> {
		let client: LspClient | undefined;
		let phase: "start" | "initialize" = "start";
		try {
			this.ensureEntryCanStart(entry);
			client = this.createClient(entry.definition, entry.workspaceRoot, this.logger);
			entry.client = client;
			this.log("info", `starting language server ${entry.definition.id} for ${entry.workspaceRoot}`);

			await this.waitForStartupPhase(entry, client.start());
			this.ensureEntryCanStart(entry);

			phase = "initialize";
			const rootUri = toFileUri(entry.workspaceRoot);
			const initializeOptions: LspInitializeOptions = {
				rootUri,
				capabilities: entry.definition.capabilities ?? {},
				workspaceFolders: [
					{
						uri: rootUri,
						name: windowsPath.basename(entry.workspaceRoot) || entry.workspaceRoot,
					},
				],
			};
			if (entry.definition.clientInfo !== undefined) initializeOptions.clientInfo = entry.definition.clientInfo;
			await this.waitForStartupPhase(entry, client.initialize(initializeOptions));
			this.ensureEntryCanStart(entry);

			entry.state = "ready";
			entry.managed = Object.freeze({
				key: entry.key,
				definition: entry.definition,
				workspaceRoot: entry.workspaceRoot,
				client,
				state: "ready" as const,
			});
			this.log("info", `language server ${entry.definition.id} is ready for ${entry.workspaceRoot}`);
			return entry.managed;
		} catch (cause) {
			if (client) {
				try {
					await client.dispose();
				} catch (disposeCause) {
					this.log("warn", `language server cleanup failed: ${String(disposeCause)}`);
				}
			}
			if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
			if (entry.state !== "disposing" && entry.state !== "disposed") entry.state = "failed";

			if (this.disposed || entry.state === "disposing" || entry.state === "disposed") {
				throw new LanguageServerInstanceDisposedError(entry.definition.id, entry.workspaceRoot, cause);
			}
			if (cause instanceof LanguageServerError) throw cause;
			if (phase === "initialize") {
				throw new LanguageServerInitializeError(entry.definition.id, entry.workspaceRoot, cause);
			}
			if (cause instanceof LspProcessError && cause.code === "ENOENT") {
				throw new LanguageServerUnavailableError(
					entry.definition.id,
					entry.workspaceRoot,
					`language server command is unavailable: ${entry.definition.command}`,
					cause,
				);
			}
			throw new LanguageServerStartError(entry.definition.id, entry.workspaceRoot, cause);
		}
	}

	private ensureActive(): void {
		if (this.disposed) throw new LanguageServerManagerDisposedError();
	}

	private ensureEntryCanStart(entry: ManagedEntry): void {
		if (this.disposed) throw new LanguageServerManagerDisposedError();
		if (entry.state === "disposing" || entry.state === "disposed") {
			throw new LanguageServerInstanceDisposedError(entry.definition.id, entry.workspaceRoot);
		}
	}

	private async waitForStartupPhase<T>(entry: ManagedEntry, operation: Promise<T>): Promise<T> {
		const operationOutcome = operation.then(
			(value) => ({ type: "completed" as const, value }),
			(error) => ({ type: "failed" as const, error }),
		);
		const outcome = await Promise.race([
			operationOutcome,
			entry.disposeSignal.then(() => ({ type: "disposed" as const })),
		]);
		if (outcome.type === "failed") throw outcome.error;
		if (outcome.type === "disposed") {
			throw new LanguageServerInstanceDisposedError(entry.definition.id, entry.workspaceRoot);
		}
		return outcome.value;
	}

	private async disposeEntry(entry: ManagedEntry): Promise<void> {
		if (entry.disposePromise) return entry.disposePromise;
		entry.state = "disposing";
		entry.resolveDisposeSignal();
		entry.disposePromise = (async () => {
			const errors: unknown[] = [];
			const firstClient = entry.client;

			// Dispose the client immediately. This is important when initialize is
			// waiting for a response: waiting for startPromise first could deadlock.
			if (firstClient) {
				try {
					await firstClient.dispose();
				} catch (cause) {
					errors.push(cause);
				}
			}

			try {
				await entry.startPromise;
			} catch {
				// Startup failures are already reported to the acquire caller. Disposal
				// must still finish and must not turn that original failure into a leak.
			}

			if (entry.client && entry.client !== firstClient) {
				try {
					await entry.client.dispose();
				} catch (cause) {
					errors.push(cause);
				}
			}

			entry.state = "disposed";
			if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
			if (errors.length > 0) {
				throw new LanguageServerDisposalError(errors, {
					definitionId: entry.definition.id,
					workspaceRoot: entry.workspaceRoot,
				});
			}
		})();
		return entry.disposePromise;
	}

	private async disposeEntries(entries: readonly ManagedEntry[]): Promise<void> {
		const results = await Promise.allSettled(entries.map((entry) => this.disposeEntry(entry)));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length > 0) throw new LanguageServerDisposalError(errors);
	}

	private async disposeAllEntries(): Promise<void> {
		await this.disposeEntries([...this.entries.values()]);
	}

	private createStatusSnapshot(entry: ManagedEntry): LanguageServerStatusSnapshot {
		const currentClientState = clientStatus(entry.client);
		const discovery = this.discover(entry.definition, entry.workspaceRoot);
		const state: ManagedLanguageServerState =
			entry.state === "ready" && currentClientState !== undefined && currentClientState !== "initialized"
				? "failed"
				: entry.state;
		return Object.freeze({
			key: entry.key,
			definitionId: entry.definition.id,
			languages: entry.definition.languages,
			workspaceRoot: entry.workspaceRoot,
			state,
			clientState: currentClientState,
			configured: entry.definition.configured,
			discovered: discovery.discovered,
			running: currentClientState === "started" || currentClientState === "initialized",
			discoverySource: discovery.source,
		});
	}

	private createDefinitionStatus(
		definition: LanguageServerDefinition,
		workspaceRoot: string,
	): LanguageServerStatusSnapshot {
		const discovery = this.discover(definition, workspaceRoot);
		return Object.freeze({
			key: makeInstanceKey(definition.id, getWorkspaceIdentity(workspaceRoot)),
			definitionId: definition.id,
			languages: definition.languages,
			workspaceRoot,
			state: "absent",
			clientState: undefined,
			configured: definition.configured,
			discovered: discovery.discovered,
			running: false,
			discoverySource: discovery.source,
		});
	}

	private discover(definition: LanguageServerDefinition, workspaceRoot: string): ExecutableDiscoveryResult {
		return discoverExecutable(definition.command, workspaceRoot);
	}

	private log(level: "debug" | "info" | "warn" | "error", message: string): void {
		this.logger?.({ level, category: "lifecycle", message });
	}
}
