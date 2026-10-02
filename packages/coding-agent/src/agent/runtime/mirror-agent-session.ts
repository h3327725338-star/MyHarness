/**
 * MirrorAgentSession: this process's view of a Session that another MyHarness process owns and runs.
 *
 * It is a normal AgentSession for everything that only reads (messages, model, context usage, tools, settings), so
 * hosts such as the Web UI keep working unchanged. The Agent never runs here. Instead:
 *   - the Session file is followed (SessionManager.syncFromDisk) and the owner's events are replayed to local
 *     listeners, so the conversation, tool output and run state move together with the owner's;
 *   - prompt, steer, follow-up, abort and model changes are sent to the owner (session-bridge.ts), which runs them
 *     exactly as if they had been typed there.
 */

import type { AgentMessage } from "@myharness/agent-core";
import type { ImageContent } from "@myharness/ai";
import { AgentSession, type AgentSessionEvent, type PromptOptions } from "./agent-session.ts";
import type { RunStateSnapshot } from "./run-state.ts";
import type { BridgeFlags, BridgeHello, SessionBridgeClient } from "./session-bridge.ts";

const NO_RUN: RunStateSnapshot = { state: "idle" } as RunStateSnapshot;

/** Events after which the Session file may have new entries. */
const SYNC_EVENTS = new Set<AgentSessionEvent["type"]>([
	"message_end",
	"turn_end",
	"agent_end",
	"agent_settled",
	"compaction_end",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
]);

export class MirrorAgentSession extends AgentSession {
	private bridge: SessionBridgeClient | undefined;
	private flags: BridgeFlags | undefined;
	private idleWaiters: Array<() => void> = [];
	private mirrorClosedHandler: (() => void) | undefined;
	private mirrorDisposed = false;

	override get isMirror(): boolean {
		return true;
	}

	/** Called once when the owning process goes away (it exited, or closed the session). */
	override onMirrorClosed(handler: () => void): void {
		this.mirrorClosedHandler = handler;
	}

	/** Start following the owner. `hello` is what the owner reported when the connection was made. */
	attachBridge(client: SessionBridgeClient, hello: BridgeHello): void {
		this.bridge = client;
		this.applyFlags(hello.flags);
		this.sessionManager.syncFromDisk();
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		client.onEvent((event, flags) => this.handleOwnerEvent(event, flags));
		client.onClose(() => {
			if (this.mirrorDisposed) return;
			this.flags = undefined;
			this.releaseIdleWaiters();
			this.mirrorClosedHandler?.();
		});
		// A run that is already in progress: show it from where it is now.
		if (hello.flags.isStreaming) {
			this._emit({ type: "agent_start" });
			if (hello.streaming) this._emit({ type: "message_start", message: hello.streaming as AgentMessage });
		}
	}

	private applyFlags(flags: BridgeFlags): void {
		this.flags = flags;
		const model = flags.model ? this.modelRuntime.getModel(flags.model.provider, flags.model.id) : undefined;
		if (model && this.agent.state.model !== model) this.agent.state.model = model;
		if (this.agent.state.thinkingLevel !== flags.thinkingLevel) {
			this.agent.state.thinkingLevel = flags.thinkingLevel as never;
		}
		if (flags.isIdle) this.releaseIdleWaiters();
	}

	private releaseIdleWaiters(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** Take over what the owner has appended to the Session file; returns whether anything was new. */
	private syncFromOwner(): boolean {
		const added = this.sessionManager.syncFromDisk();
		if (added.length === 0) return false;
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		return true;
	}

	private handleOwnerEvent(event: AgentSessionEvent, flags: BridgeFlags): void {
		if (this.mirrorDisposed) return;
		this.applyFlags(flags);
		if (SYNC_EVENTS.has(event.type)) this.syncFromOwner();
		this._emit(event);
	}

	// ----- state the owner holds ---------------------------------------------------------------------------

	override get isStreaming(): boolean {
		return this.flags?.isStreaming ?? false;
	}

	override get isIdle(): boolean {
		return this.flags?.isIdle ?? true;
	}

	override get isCompacting(): boolean {
		return this.flags?.isCompacting ?? false;
	}

	override get isRetrying(): boolean {
		return this.flags?.isRetrying ?? false;
	}

	override get isBashRunning(): boolean {
		return this.flags?.isBashRunning ?? false;
	}

	override get backgroundTaskCount(): number {
		return this.flags?.backgroundTasks ?? 0;
	}

	override getRunStateSnapshot(): RunStateSnapshot {
		return this.flags?.run ?? NO_RUN;
	}

	override getSteeringMessages(): readonly string[] {
		return this.flags?.steering ?? [];
	}

	override getFollowUpMessages(): readonly string[] {
		return this.flags?.followUp ?? [];
	}

	override get pendingMessageCount(): number {
		return (this.flags?.steering.length ?? 0) + (this.flags?.followUp.length ?? 0);
	}

	override get steeringMode(): "all" | "one-at-a-time" {
		return this.flags?.steeringMode ?? "one-at-a-time";
	}

	override get followUpMode(): "all" | "one-at-a-time" {
		return this.flags?.followUpMode ?? "one-at-a-time";
	}

	override async waitForIdle(): Promise<void> {
		if (this.isIdle) return;
		await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	// ----- commands go to the owner ------------------------------------------------------------------------

	private requireBridge(): SessionBridgeClient {
		if (!this.bridge) throw new Error("The process that owns this session has ended.");
		return this.bridge;
	}

	override async prompt(text: string, options?: PromptOptions): Promise<void> {
		const bridge = this.requireBridge();
		try {
			await bridge.command("prompt", {
				text,
				images: options?.images,
				streamingBehavior: options?.streamingBehavior,
			});
		} catch (error) {
			options?.preflightResult?.(false);
			throw error;
		}
		options?.preflightResult?.(true);
	}

	override async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this.requireBridge().command("steer", { text, images });
	}

	override async followUp(text: string, images?: ImageContent[]): Promise<void> {
		await this.requireBridge().command("followUp", { text, images });
	}

	override clearQueue(): { steering: string[]; followUp: string[] } {
		const queued = { steering: [...(this.flags?.steering ?? [])], followUp: [...(this.flags?.followUp ?? [])] };
		void this.bridge?.command("clearQueue").catch(() => {});
		return queued;
	}

	override async abort(): Promise<void> {
		await this.requireBridge().command("abort");
		await this.waitForIdle();
	}

	override async setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void> {
		await this.requireBridge().command("setModel", { provider: model.provider, id: model.id });
	}

	override setThinkingLevel(level: Parameters<AgentSession["setThinkingLevel"]>[0]): void {
		void this.bridge?.command("setThinkingLevel", { level }).catch(() => {});
	}

	override dispose(): void {
		this.mirrorDisposed = true;
		this.bridge?.close();
		this.releaseIdleWaiters();
		super.dispose();
	}

	override async disposeAsync(timeoutMs?: number): Promise<void> {
		this.mirrorDisposed = true;
		this.bridge?.close();
		this.releaseIdleWaiters();
		await super.disposeAsync(timeoutMs);
	}
}
