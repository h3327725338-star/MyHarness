/**
 * WebHostHub: keeps one WebHost ("slot") per open session so several sessions can run at the same time.
 *
 * Each slot owns an independent AgentSessionRuntime (session + cwd-bound services), created from the same
 * factory the process started with. Nothing here adds Agent behaviour: the hub only decides which runtime a
 * request talks to and which idle runtimes to release.
 *
 * Routes are written against a single `WebHost`. `hub.host` is a stand-in whose calls are forwarded to the slot
 * that the current request addresses (`x-myharness-slot` header or `slot` query parameter), so route code does
 * not need to know that several sessions exist.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync } from "node:fs";
import type { AgentSessionRuntime } from "../../agent/runtime/session-runtime.ts";
import type { WorkspaceStore } from "../../application/workspace-store.ts";
import { WorkspaceStore as WorkspaceStoreImpl } from "../../application/workspace-store.ts";
import { getDataDir } from "../../config.ts";
import { SessionManager } from "../../session/manager/index.ts";
import { pathIdentityKey, resolvePath } from "../../utils/paths.ts";
import { WebDialogBridge } from "./dialogs.ts";
import { type SlotStatus, WebHost, type WebHostHubLink } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

/** Idle sessions kept ready in the background (running or waiting sessions are never released). */
export const MAX_IDLE_BACKGROUND_SLOTS = 5;
const STATUS_EVENTS = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"run_state",
	"run_finished",
	"completion",
	"result_seen",
	"dialogs",
	"session_info",
	"session_replaced",
]);
const STATUS_DEBOUNCE_MS = 80;

export interface WebHostHubOptions {
	server: WebHttpServer;
	version: string;
	onShutdown: () => void;
}

export class WebHostHub implements WebHostHubLink {
	private readonly slots = new Map<string, WebHost>();
	private readonly scope = new AsyncLocalStorage<WebHost>();
	private readonly opening = new Map<string, Promise<WebHost>>();
	private readonly options: WebHostHubOptions;
	private workspaceStore: WorkspaceStore | undefined;
	private primary: WebHost | undefined;
	private nextSlot = 1;
	private statusTimer: ReturnType<typeof setTimeout> | undefined;
	private lastStatusJson = "";
	private disposed = false;
	/** Route code sees this as a normal WebHost; every access is forwarded to the slot the request addresses. */
	readonly host: WebHost;

	constructor(options: WebHostHubOptions) {
		this.options = options;
		this.host = new Proxy({} as WebHost, {
			get: (_target, property) => {
				const target = this.current();
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
			set: (_target, property, value) => Reflect.set(this.current(), property, value),
		});
		options.server.setRequestScope(({ req, url }, run) => {
			const wanted = req.headers["x-myharness-slot"];
			const id = typeof wanted === "string" && wanted ? wanted : (url.searchParams.get("slot") ?? undefined);
			if (!id) return run();
			const slot = this.slots.get(id);
			if (!slot) throw new HttpError(410, "This session is no longer open. Reopen it from the sidebar.");
			slot.touchedAt = Date.now();
			return this.scope.run(slot, run);
		});
		options.server.onSseConnect = (client) => client.send("slots", { slots: this.statuses() });
	}

	private current(): WebHost {
		const host = this.scope.getStore() ?? this.primary;
		if (!host) throw new HttpError(503, "The session is not ready yet.");
		return host;
	}

	/** Register the runtime the process started with. Its dialog bridge already exists (Project Trust runs before it). */
	async addPrimary(runtimeHost: AgentSessionRuntime, dialogs: WebDialogBridge): Promise<WebHost> {
		this.workspaceStore = WorkspaceStoreImpl.create(runtimeHost.services.agentDir, getDataDir());
		const host = await this.addRuntime(runtimeHost, dialogs);
		this.primary = host;
		return host;
	}

	private async addRuntime(runtimeHost: AgentSessionRuntime, dialogs: WebDialogBridge): Promise<WebHost> {
		const host = new WebHost({
			runtimeHost,
			server: this.options.server,
			dialogs,
			version: this.options.version,
			slotId: `s${this.nextSlot++}`,
			workspaceStore: this.workspaceStore,
			hub: this,
		});
		this.slots.set(host.slotId, host);
		await host.start();
		this.scheduleStatus();
		return host;
	}

	get(id: string): WebHost | undefined {
		return this.slots.get(id);
	}

	all(): WebHost[] {
		return [...this.slots.values()];
	}

	statuses(): SlotStatus[] {
		return this.all().map((host) => host.status);
	}

	/** Any dialog id (they are UUIDs) can be answered no matter which slot asked. */
	respondToDialog(id: string, value: string | boolean | undefined): boolean {
		return this.all().some((host) => host.dialogs.respond(id, value));
	}

	// ---- WebHostHubLink ---------------------------------------------------------------------

	hostBroadcast(host: WebHost, event: string): void {
		if (STATUS_EVENTS.has(event)) this.scheduleStatus();
		if (event === "settings_changed" || event === "models_changed") {
			// Other runtimes keep their own in-memory settings; pick up what this one just saved.
			for (const other of this.slots.values()) {
				if (other === host || !other.session.isIdle) continue;
				void (async () => {
					await other.session.settingsManager.reload();
					// Providers added, edited or deleted here must reach the other runtimes too (each has its own ModelRuntime).
					if (event === "models_changed") {
						await other.session.modelRuntime.reloadConfig();
						await other.session.reconcileModelAfterConfigChange();
					}
				})().catch(() => {});
			}
		}
	}

	requestShutdown(): void {
		this.options.onShutdown();
	}

	private scheduleStatus(): void {
		if (this.statusTimer || this.disposed) return;
		this.statusTimer = setTimeout(() => {
			this.statusTimer = undefined;
			this.broadcastStatus();
		}, STATUS_DEBOUNCE_MS);
	}

	private broadcastStatus(): void {
		const slots = this.statuses();
		const json = JSON.stringify(slots);
		if (json === this.lastStatusJson) return;
		this.lastStatusJson = json;
		this.options.server.broadcast("slots", { slots });
	}

	// ---- Opening, creating and closing sessions -----------------------------------------

	private findBySessionFile(path: string): WebHost | undefined {
		const key = pathIdentityKey(path);
		return this.all().find((host) => host.session.sessionFile && pathIdentityKey(host.session.sessionFile) === key);
	}

	/** Show an existing session. It keeps running in its own runtime if it already has one. */
	async openSession(from: WebHost, path: string, cwdOverride?: string): Promise<{ slot: string; created: boolean }> {
		const existing = this.findBySessionFile(path);
		if (existing) return { slot: existing.slotId, created: false };
		const key = pathIdentityKey(path);
		let pending = this.opening.get(key);
		const created = !pending;
		if (!pending) {
			pending = (async () => {
				const sessionManager = SessionManager.open(path, undefined, cwdOverride);
				const runtime = await from.runtimeHost.createSibling({
					sessionManager,
					sessionStartEvent: {
						type: "session_start",
						reason: "resume",
						previousSessionFile: from.session.sessionFile,
					},
					projectTrustContext: from.createProjectTrustContext(sessionManager.getCwd()),
				});
				return this.addRuntime(runtime, new WebDialogBridge());
			})();
			this.opening.set(key, pending);
		}
		try {
			const host = await pending;
			this.pruneIdle(host);
			return { slot: host.slotId, created };
		} finally {
			this.opening.delete(key);
		}
	}

	/** Start a fresh chat. The session the request came from keeps running untouched. */
	async newSession(from: WebHost, rootPath?: string): Promise<{ slot: string; created: boolean }> {
		const cwd = rootPath ? resolvePath(rootPath) : from.cwd;
		if (!existsSync(cwd)) throw new HttpError(400, `Workspace directory does not exist: ${cwd}`);
		if (!statSync(cwd).isDirectory()) throw new HttpError(400, `Workspace path is not a directory: ${cwd}`);
		// An untouched empty chat in the same workspace is already what the user asks for.
		const reusable = [from, ...this.all()].find(
			(host) =>
				pathIdentityKey(host.cwd) === pathIdentityKey(cwd) &&
				host.session.isIdle &&
				!host.completionActive &&
				host.session.sessionManager.buildSessionContext().messages.length === 0,
		);
		if (reusable) return { slot: reusable.slotId, created: false };
		const manager = from.session.sessionManager;
		const sessionDir = manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir();
		const sessionManager = manager.isPersisted()
			? SessionManager.create(cwd, sessionDir)
			: SessionManager.inMemory(cwd);
		const runtime = await from.runtimeHost.createSibling({
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile: from.session.sessionFile },
			projectTrustContext: from.createProjectTrustContext(cwd),
		});
		const host = await this.addRuntime(runtime, new WebDialogBridge());
		this.pruneIdle(host);
		return { slot: host.slotId, created: true };
	}

	/** Slots that currently show the given session file. */
	slotsShowing(path: string): WebHost[] {
		const key = pathIdentityKey(path);
		return this.all().filter((host) => host.session.sessionFile && pathIdentityKey(host.session.sessionFile) === key);
	}

	/** Release a slot's runtime. The last slot is kept; callers replace its session instead. */
	async closeSlot(host: WebHost): Promise<void> {
		if (!this.slots.delete(host.slotId)) return;
		if (this.primary === host) this.primary = this.all()[0];
		await host.dispose();
		this.options.server.broadcast("slot_closed", { slot: host.slotId });
		this.scheduleStatus();
	}

	private isBusy(host: WebHost): boolean {
		// A finished session whose result is still unread keeps its slot, so its sidebar marker cannot vanish unseen.
		return !host.session.isIdle || host.completionActive || host.dialogs.requests.length > 0 || host.unread;
	}

	/** Keep only the most recently used idle background slots; running or waiting ones are never touched. */
	private pruneIdle(keep: WebHost): void {
		const idle = this.all()
			.filter((host) => host !== keep && host !== this.primary && !this.isBusy(host))
			.sort((a, b) => b.touchedAt - a.touchedAt);
		for (const host of idle.slice(MAX_IDLE_BACKGROUND_SLOTS)) void this.closeSlot(host).catch(() => {});
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.statusTimer) clearTimeout(this.statusTimer);
		const hosts = this.all();
		this.slots.clear();
		await Promise.allSettled(hosts.map((host) => host.dispose()));
		await Promise.allSettled(hosts.map((host) => host.runtimeHost.services.settingsManager.flush()));
	}
}
