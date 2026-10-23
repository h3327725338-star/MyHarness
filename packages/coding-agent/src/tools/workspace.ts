/**
 * `workspace` — the Agent's control surface for the right-hand workspace of the desktop app: the built-in browser (one
 * real Chromium view per tab) and the file/media tabs of the page.
 *
 * Two channels, one tool:
 * - browser commands go to the Electron host over the service process's IPC link; they act on the WebContentsView of a
 *   tab (navigation, DOM, accessibility tree, scripts, clicks, typing, scrolling, screenshots, downloads, requests);
 * - workspace commands go to the page, which owns the tab list and the media elements, and answers with the state it
 *   reached — that answer is the verification, not an assumption that the command worked.
 *
 * The tool only exists in the desktop app (`MYHARNESS_DESKTOP_HOST=1` with a connected IPC link). In a plain CLI or a
 * browser-only session it is not registered, so nothing advertises a capability the process cannot provide.
 */
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@myharness/agent-core";
import { type Static, Type } from "typebox";
import { loadSystemPrompt } from "../system-prompts/loader/index.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const SLOW_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 20_000;
/** Screenshots are debug artifacts in the temp directory; keep the newest ones and delete older ones. */
const SCREENSHOT_KEEP = 50;

async function pruneScreenshots(directory: string): Promise<void> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		const files: Array<{ path: string; at: number }> = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.startsWith("workspace-") || !entry.name.endsWith(".png")) continue;
			const path = join(directory, entry.name);
			try {
				files.push({ path, at: (await stat(path)).mtimeMs });
			} catch {
				// Removed while listing.
			}
		}
		files.sort((left, right) => right.at - left.at);
		await Promise.all(files.slice(SCREENSHOT_KEEP).map((file) => unlink(file.path).catch(() => undefined)));
	} catch {
		// Pruning is best-effort; a screenshot that was written is still returned.
	}
}

/** Whether this process can reach the desktop host: the web service is a child of Electron and talks over IPC. */
export function desktopWorkspaceAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MYHARNESS_DESKTOP_HOST === "1" && typeof process.send === "function" && process.connected === true;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * Request/response link to the Electron host. One message out, one answer back with the same request id; a closed
 * channel, a host error or a timeout rejects the call instead of leaving the tool waiting forever.
 */
export class DesktopWorkspaceChannel {
	private nextId = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly send: (message: unknown) => boolean;
	private readonly listening: boolean;

	constructor(send: (message: unknown) => boolean, listen?: (handler: (message: unknown) => void) => void) {
		this.send = send;
		if (listen) {
			listen((message) => this.handle(message));
			this.listening = true;
		} else {
			this.listening = false;
		}
	}

	/** Answer from the host: `{ type: "myharness:browser-result", requestId, ok, value | error }`. */
	handle(message: unknown): void {
		const value = message as { type?: string; requestId?: string; ok?: boolean; value?: unknown; error?: string };
		if (!value || value.type !== "myharness:browser-result" || typeof value.requestId !== "string") return;
		const entry = this.pending.get(value.requestId);
		if (!entry) return;
		this.pending.delete(value.requestId);
		clearTimeout(entry.timer);
		if (value.ok) entry.resolve(value.value);
		else entry.reject(new Error(value.error || "the desktop host reported a failure"));
	}

	request(command: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
		const requestId = `w${++this.nextId}-${Date.now().toString(36)}`;
		const { channel: _channel, ...payload } = command;
		const action = _channel === "workspace" ? "workspace" : "browser";
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(
					new Error(
						`the desktop host did not answer within ${Math.round(timeoutMs / 1000)}s (${String(command.action)})`,
					),
				);
			}, timeoutMs);
			this.pending.set(requestId, { resolve, reject, timer });
			const sent = this.send({ type: "myharness:browser-command", requestId, action, command: payload, timeoutMs });
			if (!sent) {
				this.pending.delete(requestId);
				clearTimeout(timer);
				reject(new Error("the desktop host IPC channel is closed"));
			}
		});
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	dispose(reason = "the workspace channel was closed"): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		this.pending.clear();
	}

	get listeningForAnswers(): boolean {
		return this.listening;
	}
}

let channel: DesktopWorkspaceChannel | undefined;

/** The process-wide channel, created on first use; undefined when there is no desktop host to talk to. */
export function desktopWorkspaceChannel(): DesktopWorkspaceChannel | undefined {
	if (channel) return channel;
	if (!desktopWorkspaceAvailable()) return undefined;
	const send = process.send?.bind(process);
	if (!send) return undefined;
	channel = new DesktopWorkspaceChannel(
		(message) => {
			try {
				return process.send?.(message) === true;
			} catch {
				return false;
			}
		},
		(listen) => {
			process.on("message", listen);
		},
	);
	return channel;
}

const tabIdSchema = Type.Optional(Type.String({ minLength: 1, description: "Workspace tab id (see operation tabs)" }));
const maxCharsSchema = Type.Optional(
	Type.Integer({ minimum: 200, maximum: 100_000, description: "Cap for text output (default 20000)" }),
);

const workspaceParametersUnion = Type.Union([
	Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("tabs") }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("open"),
			type: Type.Union([Type.Literal("browser"), Type.Literal("file")]),
			url: Type.Optional(Type.String({ minLength: 1, description: "http(s) URL for type=browser" })),
			path: Type.Optional(
				Type.String({ minLength: 1, description: "File path for type=file (workspace relative or absolute)" }),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("close"), tabId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("activate"), tabId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("close_others"), tabId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("move"),
			tabId: Type.String({ minLength: 1 }),
			beforeId: Type.String({ minLength: 1, description: "Insert before this tab id" }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("reopen") }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("navigate"),
			url: Type.String({ minLength: 1 }),
			tabId: tabIdSchema,
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("back"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("forward"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("reload"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("stop"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("state"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{ operation: Type.Literal("text"), tabId: tabIdSchema, maxChars: maxCharsSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("dom"), tabId: tabIdSchema, maxChars: maxCharsSchema },
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("ax"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("interactive"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("click"),
			tabId: tabIdSchema,
			selector: Type.Optional(Type.String({ minLength: 1, description: "CSS selector" })),
			index: Type.Optional(Type.Integer({ minimum: 0, description: "Index in operation interactive" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("type"),
			tabId: tabIdSchema,
			selector: Type.Optional(Type.String({ minLength: 1 })),
			index: Type.Optional(Type.Integer({ minimum: 0 })),
			text: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("upload"),
			tabId: tabIdSchema,
			path: Type.String({ minLength: 1, description: "File inside the current workspace (relative or absolute)" }),
			selector: Type.Optional(Type.String({ minLength: 1, description: "CSS selector of an <input type=file>" })),
			index: Type.Optional(Type.Integer({ minimum: 0, description: "Index in operation interactive" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("find"),
			text: Type.String({ minLength: 1, maxLength: 500 }),
			tabId: tabIdSchema,
			forward: Type.Optional(Type.Boolean({ description: "Search forward (default true)" })),
			findNext: Type.Optional(Type.Boolean({ description: "Move to the next match of the same search" })),
			matchCase: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("stop_find"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("permissions"),
			tabId: tabIdSchema,
			origin: Type.Optional(Type.String({ minLength: 1, description: "Only this origin; omit for every origin" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("scroll"),
			tabId: tabIdSchema,
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("exec"),
			code: Type.String({ minLength: 1, description: "JavaScript expression or statement; its value is returned" }),
			tabId: tabIdSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("screenshot"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("downloads"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("network"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("media"),
			command: Type.Union([
				Type.Literal("play"),
				Type.Literal("pause"),
				Type.Literal("seek"),
				Type.Literal("volume"),
				Type.Literal("mute"),
				Type.Literal("rate"),
				Type.Literal("subtitles"),
			]),
			value: Type.Optional(
				Type.Number({ description: "Seconds, 0–1 volume, playback rate or subtitle track index" }),
			),
			tabId: tabIdSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("open_external"), url: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
]);

export type WorkspaceToolInput = Static<typeof workspaceParametersUnion>;

/** Keep a provider-friendly object root while retaining the discriminated anyOf branches. */
const parameters = Type.Unsafe<WorkspaceToolInput>({
	type: "object",
	anyOf: workspaceParametersUnion.anyOf,
});

export interface WorkspaceTabSummary {
	id: string;
	type: string;
	path?: string;
	url?: string;
	title?: string;
	loading?: boolean;
	error?: string;
	active?: boolean;
}

export interface WorkspaceToolDetails {
	operation: string;
	tabs?: WorkspaceTabSummary[];
	activeId?: string | null;
	page?: Record<string, unknown>;
	browser?: unknown;
	result?: unknown;
	screenshot?: { path: string; bytes: number };
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

function formatTab(tab: WorkspaceTabSummary): string {
	const label = tab.url || tab.path || "";
	const state = [
		tab.title ? `title=${JSON.stringify(tab.title)}` : "",
		tab.loading ? "loading" : "",
		tab.error ? `error=${JSON.stringify(tab.error)}` : "",
	]
		.filter(Boolean)
		.join(" ");
	return `${tab.active ? "→ " : "  "}${tab.type} ${tab.id} ${label}${state ? ` ${state}` : ""}`;
}

export interface WorkspaceToolOptions {
	/** Where the commands go; tests hand in a fake host, production uses the process IPC channel. */
	channel?: () => DesktopWorkspaceChannel | undefined;
	/**
	 * The conversation this tool works for. Page commands carry it, so a chat running in the background (another mode,
	 * another chat on screen) changes its own panel instead of the one the user is looking at.
	 */
	sessionId?: () => string | undefined;
}

export function createWorkspaceToolDefinition(
	options?: WorkspaceToolOptions,
): BusinessToolDefinition<typeof parameters, WorkspaceToolDetails> {
	const require = (): DesktopWorkspaceChannel => {
		const current = options?.channel ? options.channel() : desktopWorkspaceChannel();
		if (!current) {
			throw new Error(
				"workspace: this tool only works in the MyHarness desktop app. This process is not connected to the desktop host (MYHARNESS_DESKTOP_HOST is not 1, or the IPC link is closed), so the built-in browser and the workspace cannot be controlled.",
			);
		}
		return current;
	};
	const browser = (command: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS) =>
		require().request({ ...command }, timeoutMs);
	const page = (command: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS) => {
		const sessionId = options?.sessionId?.();
		return require().request({ channel: "workspace", ...command, ...(sessionId ? { sessionId } : {}) }, timeoutMs);
	};

	/** The page's tab list (files, media, panel tabs and the browser tabs it opened). */
	const pageTabs = async (): Promise<{
		tabs: WorkspaceTabSummary[];
		activeId: string | null;
		panelOpen: boolean;
	}> => {
		const value = (await page({ action: "tabs" })) as {
			tabs?: WorkspaceTabSummary[];
			activeId?: string | null;
			panelOpen?: boolean;
		};
		return {
			tabs: Array.isArray(value?.tabs) ? value.tabs : [],
			activeId: value?.activeId ?? null,
			panelOpen: !!value?.panelOpen,
		};
	};

	/** Browser tabs known to the Electron host; empty when the desktop host has no tab open. */
	const browserTabs = async (): Promise<WorkspaceTabSummary[]> => {
		const value = await browser({ action: "list" });
		if (!Array.isArray(value)) return [];
		// The host names the field `tabId`; the tool and the page both speak `id`.
		return value.map((entry) => {
			const tab = entry as WorkspaceTabSummary & { tabId?: string };
			return { ...tab, id: tab.id || tab.tabId || "" };
		});
	};

	/** Wait until the page finishes loading, then report the state that was reached (or the load error). */
	const settle = async (tabId: string, timeoutMs = 15_000): Promise<unknown> => {
		const deadline = Date.now() + timeoutMs;
		let state = (await browser({ action: "state", tabId })) as { loading?: boolean; error?: string } | undefined;
		while (state?.loading && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			state = (await browser({ action: "state", tabId })) as { loading?: boolean; error?: string } | undefined;
		}
		if (state?.error) throw new Error(`workspace: the page failed to load: ${state.error}`);
		return state;
	};

	/** A browser command needs an existing tab: the given one, the page's active browser tab, or the only tab open. */
	const resolveBrowserTab = async (tabId: string | undefined): Promise<string> => {
		const tabs = await browserTabs();
		if (tabId && tabs.some((tab) => tab.id === tabId)) return tabId;
		const state = await pageTabs();
		const active = state.tabs.find((tab) => tab.id === state.activeId && tab.type === "browser");
		if (active && tabs.some((tab) => tab.id === active.id)) return active.id;
		const single = tabs.length === 1 ? tabs[0] : undefined;
		if (single) return single.id;
		if (tabId)
			throw new Error(
				`workspace: there is no browser tab ${tabId}. Open one first (operation=open, type=browser) or list them with operation=tabs.`,
			);
		throw new Error(
			tabs.length === 0
				? "workspace: no browser tab is open. Open a page first with operation=open and type=browser."
				: `workspace: ${tabs.length} browser tabs are open; name one with tabId: ${tabs.map((tab) => tab.id).join(", ")}`,
		);
	};

	const mergedTabs = async (): Promise<{
		tabs: WorkspaceTabSummary[];
		activeId: string | null;
		panelOpen: boolean;
	}> => {
		const state = await pageTabs();
		const known = await browserTabs().catch(() => [] as WorkspaceTabSummary[]);
		const tabs = state.tabs.map((tab) => {
			const live = known.find((entry) => entry.id === tab.id);
			return {
				...tab,
				active: tab.id === state.activeId,
				title: live?.title || tab.title,
				loading: live?.loading,
				error: live?.error,
			};
		});
		return { tabs, activeId: state.activeId, panelOpen: state.panelOpen };
	};

	return {
		name: "workspace",
		label: "workspace",
		description: [
			"Control the MyHarness desktop workspace: the right-hand panel, the file and media tabs in it, and the built-in browser.",
			"Use `tabs` first to see tab ids. `open` adds a tab without closing what is already open; `close`, `activate`, `close_others`, `move` and `reopen` manage them.",
			"Browser tabs support navigate/back/forward/reload/stop, text/dom/ax/interactive, click/type/scroll by CSS selector or by the index from `interactive`, find/stop_find for in-page search, upload (a workspace file into the page's file input), exec (page JavaScript), screenshot (saved as a PNG file and returned by path), downloads and network. `permissions` reads the session's site-permission decisions and pending requests; granting or revoking them is a user action in the tab, never an Agent action.",
			"Media tabs support play/pause/seek/volume/mute/rate/subtitles. Every call returns the state that was actually reached; a page that does not answer in time is an error, not a success.",
			"What it cannot do: grant site permissions (they are denied and reported), bypass CAPTCHAs, login walls or payment confirmations, or drive anything outside this app's workspace.",
		].join("\n"),
		promptSnippet: loadSystemPrompt("tools/workspace/snippet.md"),
		parameters,
		async execute(
			_toolCallId,
			input: WorkspaceToolInput,
		): Promise<{ content: { type: "text"; text: string }[]; details: WorkspaceToolDetails }> {
			const operation = String(input?.operation || "");
			const fields = input as Record<string, unknown>;
			const tabId = typeof fields.tabId === "string" ? fields.tabId : undefined;
			const maxChars = Number(fields.maxChars) || DEFAULT_MAX_CHARS;
			const slow =
				operation === "ax" || operation === "screenshot" || operation === "exec" || operation === "navigate";
			const timeout = slow ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
			const timeoutMs = Number(fields.timeoutMs) || timeout;

			switch (operation) {
				case "status": {
					const available = desktopWorkspaceAvailable();
					const state = available ? await pageTabs().catch(() => null) : null;
					const known = available ? await browserTabs().catch(() => []) : [];
					const lines = [
						`[workspace] desktop_host=${available ? "connected" : "unavailable"}`,
						`  page_tabs=${state ? state.tabs.length : 0} browser_tabs=${known.length} panel=${state?.panelOpen ? "open" : "closed"}`,
						available
							? "  Ready. Use tabs, open, close, activate, navigate, click, type, media and the rest."
							: "  Only available in the desktop app; nothing can be controlled from this process.",
					];
					return { content: [{ type: "text", text: lines.join("\n") }], details: { operation } };
				}
				case "tabs": {
					const state = await mergedTabs();
					const lines = [
						`[workspace] tabs=${state.tabs.length} active=${state.activeId ?? "(none)"} panel=${state.panelOpen ? "open" : "closed"}`,
					];
					for (const tab of state.tabs) lines.push(formatTab(tab));
					if (state.tabs.length === 0) lines.push("  (no tabs open yet; use open)");
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { operation, tabs: state.tabs, activeId: state.activeId },
					};
				}
				case "open": {
					const type = String((input as { type?: string }).type || "");
					if (type === "browser") {
						const url = String((input as { url?: string }).url || "");
						let parsed: URL;
						try {
							parsed = new URL(url);
						} catch {
							throw new Error("workspace: open with type=browser needs a valid http(s) url");
						}
						if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
							throw new Error("workspace: only http and https addresses are allowed");
						const opened = await page({ action: "open", tab: { type: "browser", url: parsed.href } });
						const state = opened as { tabs?: WorkspaceTabSummary[]; activeId?: string | null };
						const tab =
							(state?.tabs || []).find((entry) => entry.id === state?.activeId) || (state?.tabs || []).at(-1);
						if (!tab) throw new Error("workspace: the page did not report the browser tab it opened");
						// The page owns the tab id and its panel creates the host view on mount; ensure is idempotent, so this
						// call creates the view now when the panel has not mounted yet and never loads the page twice.
						await browser({ action: "ensure", tabId: tab.id, url: parsed.href }, SLOW_TIMEOUT_MS);
						const live = await settle(tab.id);
						return {
							content: [
								{
									type: "text",
									text: `[workspace] opened browser tab ${tab.id}\n  ${parsed.href}\n  state=${JSON.stringify(live)}`,
								},
							],
							details: { operation, activeId: tab.id, page: state as Record<string, unknown>, browser: live },
						};
					}
					if (type === "file") {
						const path = String((input as { path?: string }).path || "");
						if (!path) throw new Error("workspace: open with type=file needs a path");
						const opened = (await page({ action: "open", tab: { type: "file", path } })) as {
							tabs?: WorkspaceTabSummary[];
							activeId?: string | null;
						};
						const tab = (opened?.tabs || []).find((entry) => entry.id === opened?.activeId);
						return {
							content: [
								{
									type: "text",
									text: `[workspace] opened file tab ${tab?.id || `file:${path}`}\n  path=${path}\n  tabs=${opened?.tabs?.length ?? 0}`,
								},
							],
							details: {
								operation,
								activeId: opened?.activeId ?? null,
								page: opened as Record<string, unknown>,
							},
						};
					}
					throw new Error("workspace: open needs type=browser with url, or type=file with path");
				}
				case "close":
				case "activate":
				case "close_others": {
					if (!tabId) throw new Error(`workspace: ${operation} needs a tabId`);
					const state = (await page({
						action: operation === "close_others" ? "closeOthers" : operation,
						tabId,
					})) as {
						tabs?: WorkspaceTabSummary[];
						activeId?: string | null;
					};
					if (operation === "close" && (state.tabs || []).some((entry) => entry.id === tabId))
						throw new Error(
							`workspace: ${tabId} is still in the tab list after closing it, so the close did not take effect`,
						);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] ${operation} ${tabId}\n  tabs=${state.tabs?.length ?? 0} active=${state.activeId ?? "(none)"}`,
							},
						],
						details: { operation, activeId: state.activeId ?? null, page: state as Record<string, unknown> },
					};
				}
				case "move": {
					if (!tabId) throw new Error("workspace: move needs a tabId");
					const beforeId = String((input as { beforeId?: string }).beforeId || "");
					if (!beforeId) throw new Error("workspace: move needs a beforeId");
					const state = (await page({ action: "move", fromId: tabId, toId: beforeId })) as {
						tabs?: WorkspaceTabSummary[];
					};
					const order = (state.tabs || []).map((entry) => entry.id);
					const from = order.indexOf(tabId);
					const before = order.indexOf(beforeId);
					if (from < 0 || before < 0 || from > before)
						throw new Error(`workspace: the move did not take effect; the order is ${order.join(" , ")}`);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] moved ${tabId} before ${beforeId}\n  order=${order.join(" , ")}`,
							},
						],
						details: { operation, tabs: state.tabs || [], activeId: null },
					};
				}
				case "reopen": {
					const state = (await page({ action: "reopen" })) as {
						tabs?: WorkspaceTabSummary[];
						activeId?: string | null;
					};
					return {
						content: [
							{
								type: "text",
								text: `[workspace] reopen → active=${state.activeId ?? "(none)"} tabs=${state.tabs?.length ?? 0}`,
							},
						],
						details: { operation, activeId: state.activeId ?? null, page: state as Record<string, unknown> },
					};
				}
				case "navigate": {
					const url = String((input as { url?: string }).url || "");
					let parsed: URL;
					try {
						parsed = new URL(url);
					} catch {
						throw new Error("workspace: navigate needs a valid http(s) url");
					}
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
						throw new Error("workspace: only http and https addresses are allowed");
					const id = await resolveBrowserTab(tabId);
					const state = await browser({ action: "navigate", tabId: id, url: parsed.href }, timeoutMs);
					const actual = (state as { url?: string; error?: string }) || {};
					if (actual.error) throw new Error(`workspace: navigation failed: ${actual.error}`);
					return {
						content: [{ type: "text", text: `[workspace] navigate ${id}\n  url=${actual.url || parsed.href}` }],
						details: { operation, activeId: id, browser: state },
					};
				}
				case "back":
				case "forward":
				case "reload":
				case "stop": {
					const id = await resolveBrowserTab(tabId);
					await browser({ action: operation, tabId: id });
					// The command is asynchronous in the browser: read the state back instead of reporting success blindly.
					await new Promise((resolve) => setTimeout(resolve, operation === "reload" ? 1000 : 300));
					const state = await browser({ action: "state", tabId: id });
					return {
						content: [{ type: "text", text: `[workspace] ${operation} ${id}\n  state=${JSON.stringify(state)}` }],
						details: { operation, activeId: id, browser: state },
					};
				}
				case "state": {
					const id = await resolveBrowserTab(tabId);
					const state = await browser({ action: "state", tabId: id });
					return {
						content: [{ type: "text", text: `[workspace] state ${id}\n  ${JSON.stringify(state)}` }],
						details: { operation, activeId: id, browser: state },
					};
				}
				case "text": {
					const id = await resolveBrowserTab(tabId);
					const value = (await browser({ action: "text", tabId: id })) as { result?: string };
					const cut = truncate(String(value?.result ?? ""), maxChars);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] text ${id}${cut.truncated ? " (truncated)" : ""}\n${cut.text}`,
							},
						],
						details: { operation, activeId: id, result: cut.truncated ? `${cut.text}…` : cut.text },
					};
				}
				case "dom": {
					const id = await resolveBrowserTab(tabId);
					const value = (await browser({ action: "dom", tabId: id })) as { html?: string; text?: string };
					const html = truncate(String(value?.html ?? ""), maxChars);
					const text = truncate(String(value?.text ?? ""), Math.min(maxChars, 4_000));
					return {
						content: [
							{
								type: "text",
								text: `[workspace] dom ${id}${html.truncated ? " (html truncated)" : ""}\n[text]\n${text.text}\n[html]\n${html.text}`,
							},
						],
						details: {
							operation,
							activeId: id,
							result: { html: html.text, text: text.text, truncated: html.truncated },
						},
					};
				}
				case "ax": {
					const id = await resolveBrowserTab(tabId);
					const value = (await browser({ action: "ax", tabId: id }, SLOW_TIMEOUT_MS)) as {
						nodes?: Array<Record<string, unknown>>;
					};
					const nodes = Array.isArray(value?.nodes) ? value.nodes : [];
					const visible = nodes.filter((node) => node.ignored !== true && (node.role || node.name));
					const lines = visible.slice(0, 300).map((node) => {
						const role = String(node.role ?? "");
						const name = node.name ? ` ${JSON.stringify(node.name)}` : "";
						const extra = node.value !== undefined ? ` value=${JSON.stringify(node.value)}` : "";
						return `  ${role}${name}${extra}`;
					});
					return {
						content: [
							{
								type: "text",
								text: `[workspace] ax ${id} nodes=${nodes.length} shown=${Math.min(300, visible.length)}${visible.length > 300 ? " (truncated)" : ""}\n${lines.join("\n")}`,
							},
						],
						details: { operation, activeId: id, result: { nodes: visible.length } },
					};
				}
				case "interactive": {
					const id = await resolveBrowserTab(tabId);
					const value = (await browser({ action: "interactive", tabId: id })) as {
						elements?: Array<Record<string, unknown>>;
					};
					const elements = Array.isArray(value?.elements) ? value.elements : [];
					const lines = elements.map(
						(element) =>
							`  ${element.index} ${element.tag}${element.type ? `[${element.type}]` : ""} ${JSON.stringify(element.label || element.name || element.href || "")}${element.disabled ? " (disabled)" : ""}`,
					);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] interactive ${id} count=${elements.length}\n${lines.join("\n")}`,
							},
						],
						details: { operation, activeId: id, result: elements },
					};
				}
				case "click": {
					const id = await resolveBrowserTab(tabId);
					const selector = (input as { selector?: string }).selector;
					const index = (input as { index?: number }).index;
					const value = (await browser({ action: "click", tabId: id, selector, index })) as {
						ok?: boolean;
						error?: string;
						text?: string;
					};
					if (!value?.ok)
						throw new Error(`workspace: the click failed: ${value?.error || "the page returned no result"}`);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] clicked ${id} ${selector ? `selector=${selector}` : `index=${index}`} → ${value.text || "(no text)"}`,
							},
						],
						details: { operation, activeId: id, result: value },
					};
				}
				case "type": {
					const id = await resolveBrowserTab(tabId);
					const selector = (input as { selector?: string }).selector;
					const index = (input as { index?: number }).index;
					const text = String((input as { text?: string }).text ?? "");
					const value = (await browser({ action: "type", tabId: id, selector, index, text })) as {
						ok?: boolean;
						error?: string;
						value?: string;
					};
					if (!value?.ok)
						throw new Error(`workspace: typing failed: ${value?.error || "the page returned no result"}`);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] typed into ${id} ${selector ? `selector=${selector}` : `index=${index}`} → ${JSON.stringify(value.value ?? "")}`,
							},
						],
						details: { operation, activeId: id, result: value },
					};
				}
				case "upload": {
					const id = await resolveBrowserTab(tabId);
					const file = String((input as { path?: string }).path || "");
					if (!file) throw new Error("workspace: upload needs a workspace file path");
					const selector = (input as { selector?: string }).selector;
					const index = (input as { index?: number }).index;
					if (!selector && !Number.isInteger(index))
						throw new Error("workspace: upload needs the selector or index of the page's file input");
					const value = (await browser({ action: "upload", tabId: id, path: file, selector, index })) as {
						ok?: boolean;
						name?: string;
						size?: number;
						count?: number;
						path?: string;
						error?: string;
					};
					if (!value?.ok)
						throw new Error(`workspace: the upload failed: ${value?.error || "the page returned no result"}`);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] uploaded ${value.name || file} (${value.size ?? 0} bytes) into ${id}\n  path=${value.path || file} files=${value.count ?? 1}`,
							},
						],
						details: { operation, activeId: id, result: value },
					};
				}
				case "find": {
					const id = await resolveBrowserTab(tabId);
					const text = String((input as { text?: string }).text || "");
					if (!text) throw new Error("workspace: find needs text");
					const value = (await browser({
						action: "find",
						tabId: id,
						text,
						forward: (input as { forward?: boolean }).forward !== false,
						findNext: (input as { findNext?: boolean }).findNext === true,
						matchCase: (input as { matchCase?: boolean }).matchCase === true,
					})) as { matches?: number; activeMatch?: number; timeout?: boolean };
					if (value?.timeout)
						throw new Error("workspace: the page did not report find results before the timeout");
					const matches = value?.matches ?? 0;
					const active = value?.activeMatch ?? 0;
					return {
						content: [
							{
								type: "text",
								text: `[workspace] find ${JSON.stringify(text)} in ${id} → ${matches} match(es)${matches ? `, active ${active}` : ""}`,
							},
						],
						details: { operation, activeId: id, result: { text, matches, activeMatch: active } },
					};
				}
				case "stop_find": {
					const id = await resolveBrowserTab(tabId);
					await browser({ action: "stopFind", tabId: id });
					return {
						content: [{ type: "text", text: `[workspace] stopped the find in ${id}` }],
						details: { operation, activeId: id },
					};
				}
				case "permissions": {
					const origin = String((input as { origin?: string }).origin || "");
					const value = (await browser({
						action: "permissions",
						tabId,
						...(origin ? { origin } : {}),
					})) as {
						permissions?: Array<{ origin: string; permission: string; allowed: boolean }>;
						pending?: Array<{ requestId: string; permission: string; origin: string }>;
					};
					const permissions = value?.permissions || [];
					const pending = value?.pending || [];
					const lines = permissions.map(
						(entry) => `  ${entry.allowed ? "allowed" : "denied"} ${entry.permission} ${entry.origin}`,
					);
					if (pending.length)
						lines.push(
							...pending.map((entry) => `  pending ${entry.permission} ${entry.origin} (${entry.requestId})`),
						);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] site permissions=${permissions.length} pending=${pending.length}\n${lines.join("\n") || "  (none in this app session)"}`,
							},
						],
						details: { operation, result: { permissions, pending } },
					};
				}
				case "scroll": {
					const id = await resolveBrowserTab(tabId);
					const value = (await browser({
						action: "scroll",
						tabId: id,
						x: Number((input as { x?: number }).x) || 0,
						y: Number((input as { y?: number }).y) || 0,
					})) as { result?: { x?: number; y?: number } };
					return {
						content: [
							{ type: "text", text: `[workspace] scrolled ${id} → ${JSON.stringify(value?.result ?? null)}` },
						],
						details: { operation, activeId: id, result: value?.result },
					};
				}
				case "exec": {
					const id = await resolveBrowserTab(tabId);
					const code = String((input as { code?: string }).code || "");
					const value = (await browser({ action: "exec", tabId: id, code }, SLOW_TIMEOUT_MS)) as {
						result?: unknown;
					};
					const serialized =
						typeof value?.result === "string" ? value.result : JSON.stringify(value?.result ?? null);
					const cut = truncate(serialized ?? "null", maxChars);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] exec ${id}${cut.truncated ? " (truncated)" : ""}\n${cut.text}`,
							},
						],
						details: { operation, activeId: id, result: cut.text },
					};
				}
				case "screenshot": {
					const id = await resolveBrowserTab(tabId);
					const value = (await browser({ action: "snapshot", tabId: id }, SLOW_TIMEOUT_MS)) as {
						snapshot?: string;
					};
					const data = String(value?.snapshot || "");
					if (!data.startsWith("data:image/"))
						throw new Error("workspace: the screenshot command returned no image data");
					const base64 = data.slice(data.indexOf(",") + 1);
					const bytes = Buffer.from(base64, "base64");
					const dir = process.env.MYHARNESS_TEMP_DIR || join(tmpdir(), "myharness-workspace");
					await mkdir(dir, { recursive: true });
					const file = join(dir, `workspace-${id.replace(/[^a-z0-9.-]+/gi, "_")}-${Date.now()}.png`);
					await writeFile(file, bytes);
					await pruneScreenshots(dir);
					return {
						content: [
							{ type: "text", text: `[workspace] screenshot ${id}\n  path=${file}\n  bytes=${bytes.length}` },
						],
						details: { operation, activeId: id, screenshot: { path: file, bytes: bytes.length } },
					};
				}
				case "downloads": {
					const value = await browser({ action: "downloads", tabId });
					const list = (value as { downloads?: unknown[] })?.downloads || [];
					return {
						content: [
							{ type: "text", text: `[workspace] downloads=${list.length}\n${JSON.stringify(list, null, 1)}` },
						],
						details: { operation, result: list },
					};
				}
				case "network": {
					const value = await browser({ action: "network", tabId });
					const list = (value as { requests?: unknown[] })?.requests || [];
					const shown = list.slice(-50);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] network requests=${list.length}\n${JSON.stringify(shown, null, 1)}`,
							},
						],
						details: { operation, result: shown },
					};
				}
				case "media": {
					const command = String((input as { command?: string }).command || "");
					const value = Number((input as { value?: number }).value);
					const state = await page({
						action: "media",
						tabId,
						command,
						value: Number.isFinite(value) ? value : undefined,
					});
					const media = (state as { media?: Record<string, unknown> })?.media;
					if (!media) throw new Error("workspace: the page has no media element to control");
					const lines = [
						`[workspace] media ${command}${Number.isFinite(value) ? `=${value}` : ""}`,
						`  kind=${media.kind} paused=${media.paused} time=${media.currentTime}/${media.duration ?? "?"} volume=${media.volume} muted=${media.muted} rate=${media.playbackRate}`,
					];
					if (command === "play" && media.paused === true)
						throw new Error("workspace: the media is still paused after play");
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { operation, page: state as Record<string, unknown>, result: media },
					};
				}
				case "open_external": {
					const url = String((input as { url?: string }).url || "");
					let parsed: URL;
					try {
						parsed = new URL(url);
					} catch {
						throw new Error("workspace: open_external needs a valid http(s) url");
					}
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
						throw new Error("workspace: only http and https addresses are allowed");
					await browser({ action: "external", url: parsed.href });
					return {
						content: [{ type: "text", text: `[workspace] opened ${parsed.href} in the system browser` }],
						details: { operation, result: parsed.href },
					};
				}
				default:
					throw new Error(`workspace: unknown operation ${operation || "(empty)"}`);
			}
		},
	};
}

export function createWorkspaceTool(
	options?: WorkspaceToolOptions,
): AgentTool<typeof parameters, WorkspaceToolDetails> {
	return wrapToolDefinition(createWorkspaceToolDefinition(options));
}
