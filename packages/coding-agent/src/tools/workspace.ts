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
import { processImage } from "../utils/image-process.ts";
import type { BusinessToolDefinition } from "./contracts/index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const SLOW_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_BATCH_STEPS = 30;
/** Input that may start a navigation: afterwards the tool waits for it and says where the page went. */
const FOLLOW_OPERATIONS = new Set(["click", "type", "mouse", "key"]);
/** Operations that take `screenshot: true` and attach the picture of the tab after acting. */
const LOOK_OPERATIONS = new Set([
	"click",
	"type",
	"mouse",
	"key",
	"navigate",
	"back",
	"forward",
	"reload",
	"scroll",
	"login",
	"wait",
]);
/** What a batch step may do: page actions and reads, never tab management or anything outside the page. */
const BATCH_OPERATIONS = new Set([
	"click",
	"type",
	"mouse",
	"key",
	"scroll",
	"wait",
	"navigate",
	"back",
	"forward",
	"reload",
	"text",
	"interactive",
	"find",
	"exec",
	"screenshot",
	"state",
	"read",
]);
/**
 * Operations that change what a page shows (input, navigation, scripts, scrolling). On the user's own tab while they
 * look at it, these run in a background copy instead, unless the call says `onUserTab: true`.
 */
const GUARDED_OPERATIONS = new Set([
	"click",
	"type",
	"mouse",
	"key",
	"scroll",
	"navigate",
	"back",
	"forward",
	"reload",
	"exec",
	"upload",
	"login",
	"collect",
]);
/** read_many: pages read side by side. */
const READ_MANY_LANES = 4;
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
const onUserTabSchema = Type.Optional(
	Type.Boolean({
		description:
			"Act on the user's own tab while they are looking at it. Only when the user asked you to work on their page; otherwise the action runs in a background copy of it",
	}),
);
const readFormatFields = {
	scroll: Type.Optional(
		Type.Boolean({
			description:
				"Scroll the page to its end first, so content that loads while scrolling (feeds, long lists, lazy articles) is read too (default false)",
		}),
	),
	links: Type.Optional(Type.Boolean({ description: "Also return the page's links (text and address)" })),
	tables: Type.Optional(Type.Boolean({ description: "Also return its tables as rows of cells" })),
};

const workspaceParametersUnion = Type.Union([
	Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("tabs") }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("open"),
			type: Type.Union([Type.Literal("browser"), Type.Literal("file")]),
			url: Type.Optional(Type.String({ minLength: 1, description: "http(s) URL for type=browser" })),
			bookmark: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"type=browser: open a bookmark instead of a url (its id, or its exact title; see operation bookmarks)",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"type=browser: open without switching the user's view to it (default true: you work in your own tabs). Pass false only when the user asked to see the page",
				}),
			),
			path: Type.Optional(
				Type.String({ minLength: 1, description: "File path for type=file (workspace relative or absolute)" }),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("bookmarks") }, { additionalProperties: false }),
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
			onUserTab: onUserTabSchema,
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("back"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("forward"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("reload"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("wait"),
			tabId: tabIdSchema,
			selector: Type.Optional(Type.String({ minLength: 1, description: "Until this CSS selector is visible" })),
			text: Type.Optional(Type.String({ minLength: 1, description: "Until the page shows this text" })),
			label: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Visible text or accessible name of the element (e.g. a button's words)",
				}),
			),
			gone: Type.Optional(Type.Boolean({ description: "Wait until it disappears instead" })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 200, maximum: 60000, description: "Default 10000" })),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{
			additionalProperties: false,
			description: "Without selector/text/label: until the page has loaded and its network is quiet",
		},
	),
	Type.Object(
		{
			operation: Type.Literal("batch"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			steps: Type.Array(
				Type.Object(
					{
						operation: Type.String({
							description:
								"click, type, mouse, key, scroll, wait, navigate, back, forward, reload, text, interactive, find, exec, screenshot or state",
						}),
					},
					{ additionalProperties: true, description: "One step: the same fields as that operation" },
				),
				{ minItems: 1, maxItems: MAX_BATCH_STEPS },
			),
			screenshot: Type.Optional(Type.Boolean({ description: "Screenshot after the last step (default true)" })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("stop"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("state"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{ operation: Type.Literal("text"), tabId: tabIdSchema, maxChars: maxCharsSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("read"),
			tabId: tabIdSchema,
			...readFormatFields,
			selector: Type.Optional(Type.String({ minLength: 1, description: "Read only this element (CSS selector)" })),
			fresh: Type.Optional(
				Type.Boolean({
					description:
						"Read the tab's address again in a hidden reader page (same sign-in) instead of the tab itself. A background tab is not drawn, so content that loads only when it scrolls into view may not load there; the reader draws it. What is not in the address (a typed search, an open menu) is not in the reader",
				}),
			),
			maxScrolls: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 80, description: "scroll: at most this many steps (default 20)" }),
			),
			maxChars: Type.Optional(
				Type.Integer({ minimum: 200, maximum: 200_000, description: "Cap for the text (default 40000)" }),
			),
			onUserTab: onUserTabSchema,
		},
		{
			additionalProperties: false,
			description: "The whole page in one call: its text without repeated lines (with scroll: after loading it all)",
		},
	),
	Type.Object(
		{
			operation: Type.Literal("collect"),
			tabId: tabIdSchema,
			pages: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 30, description: "How many pages to read (default 5)" }),
			),
			nextLabel: Type.Optional(
				Type.String({
					minLength: 1,
					description: 'Words on the control that goes to the next page ("Next", "下一页", "›")',
				}),
			),
			nextSelector: Type.Optional(Type.String({ minLength: 1, description: "Or a CSS selector of that control" })),
			urlTemplate: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Or the address of every page with {page} for its number, e.g. https://site/list?p={page}",
				}),
			),
			from: Type.Optional(
				Type.Integer({ minimum: 0, description: "urlTemplate: number of the first page (default 1)" }),
			),
			...readFormatFields,
			maxChars: Type.Optional(
				Type.Integer({
					minimum: 1000,
					maximum: 200_000,
					description: "Cap for all pages together (default 60000)",
				}),
			),
			onUserTab: onUserTabSchema,
		},
		{
			additionalProperties: false,
			description:
				"Read several pages of a paged list in one call: this page, then the next one (by nextLabel/nextSelector, or by urlTemplate) until `pages` are read or there is no next page",
		},
	),
	Type.Object(
		{
			operation: Type.Literal("read_many"),
			urls: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 10,
				description: "http(s) addresses, read side by side in hidden reader pages that are closed afterwards",
			}),
			...readFormatFields,
			maxChars: Type.Optional(
				Type.Integer({ minimum: 200, maximum: 50_000, description: "Cap for each page's text (default 8000)" }),
			),
		},
		{ additionalProperties: false, description: "Read up to 10 pages at once without opening tabs in the panel" },
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
			onUserTab: onUserTabSchema,
			selector: Type.Optional(Type.String({ minLength: 1, description: "CSS selector" })),
			index: Type.Optional(Type.Integer({ minimum: 0, description: "Index in operation interactive" })),
			label: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Visible text or accessible name of the element (e.g. a button's words)",
				}),
			),
			double: Type.Optional(Type.Boolean({ description: "Double-click" })),
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("type"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			selector: Type.Optional(Type.String({ minLength: 1 })),
			index: Type.Optional(Type.Integer({ minimum: 0 })),
			label: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Visible text or accessible name of the element (e.g. a button's words)",
				}),
			),
			replace: Type.Optional(
				Type.Boolean({
					description:
						"Replace what the field holds (default true; without a target this applies to a focused form field, and to a rich-text editor only when true is given); false appends at the end",
				}),
			),
			enter: Type.Optional(Type.Boolean({ description: "Press Enter after typing (submit a search or form)" })),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
			x: Type.Optional(Type.Number({ description: "Click this point first (CSS px of the screenshot), then type" })),
			y: Type.Optional(Type.Number()),
			text: Type.String({
				description:
					"With selector/index/label the element is clicked and the text typed into it (a <select> picks the matching option); otherwise it is typed into the focused element",
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("mouse"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			action: Type.Union(
				[
					Type.Literal("click"),
					Type.Literal("double_click"),
					Type.Literal("right_click"),
					Type.Literal("move"),
					Type.Literal("down"),
					Type.Literal("up"),
					Type.Literal("drag"),
					Type.Literal("wheel"),
				],
				{ description: "move = hover" },
			),
			x: Type.Optional(
				Type.Number({ description: "CSS px from the left of the page viewport (same frame as screenshot)" }),
			),
			y: Type.Optional(Type.Number({ description: "CSS px from the top of the page viewport" })),
			selector: Type.Optional(Type.String({ minLength: 1, description: "Aim at this element instead of x,y" })),
			index: Type.Optional(
				Type.Integer({ minimum: 0, description: "Aim at this interactive element instead of x,y" }),
			),
			label: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Visible text or accessible name of the element (e.g. a button's words)",
				}),
			),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
			toX: Type.Optional(Type.Number({ description: "drag: end point" })),
			toY: Type.Optional(Type.Number()),
			deltaX: Type.Optional(Type.Number({ description: "wheel: horizontal scroll in px" })),
			deltaY: Type.Optional(Type.Number({ description: "wheel: vertical scroll in px (positive = down)" })),
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
			modifiers: Type.Optional(
				Type.Array(
					Type.Union([Type.Literal("Control"), Type.Literal("Shift"), Type.Literal("Alt"), Type.Literal("Meta")]),
				),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("key"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			keys: Type.String({
				minLength: 1,
				description: 'Space-separated keys or combinations, e.g. "Enter", "Control+A Backspace", "Shift+Tab"',
			}),
			repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("login"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			submit: Type.Optional(Type.Boolean({ description: "Submit the form after filling it (default true)" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("upload"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
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
			operation: Type.Literal("answer_permission"),
			requestId: Type.String({ minLength: 1, description: "A pending request id from permissions or state" }),
			allow: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("scroll"),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			deltaY: Type.Optional(
				Type.Union([Type.Number(), Type.Literal("page")], {
					description:
						"Scroll down by this many px (negative = up), or \"page\" for most of the area's height. The area scrolled is the one under x,y, the one holding the selector/index/label element, or else the page's main scrolling list",
				}),
			),
			deltaX: Type.Optional(
				Type.Union([Type.Number(), Type.Literal("page")], { description: "Scroll right by this many px" }),
			),
			until: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Keep scrolling (down unless deltaY is negative) until these words are on screen; the result gives where they are, or says they never appeared",
				}),
			),
			maxSteps: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 60, description: "until: at most this many scrolls (default 20)" }),
			),
			x: Type.Optional(
				Type.Number({
					description:
						"With deltaY/deltaX/until: the point (screenshot CSS px) whose scrolling area is scrolled. Alone (older form): scroll the page right by this many px",
				}),
			),
			y: Type.Optional(
				Type.Number({
					description: "With deltaY/deltaX/until: the point's y. Alone (older form): scroll down by this many px",
				}),
			),
			selector: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Alone: scroll this element into view. With deltaY/until: scroll the area holding it",
				}),
			),
			index: Type.Optional(Type.Integer({ minimum: 0 })),
			label: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Visible text or accessible name of the element (e.g. a button's words)",
				}),
			),
			screenshot: Type.Optional(Type.Boolean({ description: "Attach a screenshot of the tab after the action" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("exec"),
			code: Type.String({ minLength: 1, description: "JavaScript expression or statement; its value is returned" }),
			tabId: tabIdSchema,
			onUserTab: onUserTabSchema,
			maxChars: maxCharsSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("screenshot"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("downloads"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("download"),
			tabId: tabIdSchema,
			url: Type.String({
				minLength: 1,
				description:
					"Link to save as a file with the tab's cookies and sign-in (http/https, or a blob:/data: link of that page)",
			}),
			timeoutMs: Type.Optional(
				Type.Integer({
					minimum: 5000,
					maximum: 600000,
					description: "Wait for the file up to this long (default 120000)",
				}),
			),
		},
		{ additionalProperties: false },
	),
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

type WorkspaceResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: WorkspaceToolDetails;
};

export interface WorkspaceTabSummary {
	id: string;
	type: string;
	/** A website tab that plays nothing aloud (opened by the Agent, or muted by the user). */
	muted?: boolean;
	/** A website tab the Agent opened (its own to drive), not one of the user's. */
	agent?: boolean;
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
	screenshot?: { path: string; bytes: number; width?: number; height?: number };
}

interface WorkspaceBookmark {
	id: string;
	title: string;
	url: string;
}

/** What the host's `read` answers (packages/desktop/browser-page-helpers.cjs pageRead). */
interface PageReading {
	ok?: boolean;
	error?: string;
	url?: string;
	title?: string;
	text?: string;
	lines?: number;
	truncated?: boolean;
	scrolls?: number;
	atEnd?: boolean;
	links?: Array<{ text: string; href: string }>;
	tables?: string[][][];
}

/** A reading as text for the model: the page's words, then its links and tables when they were asked for. */
function formatReading(value: PageReading): string {
	const parts = [String(value.text ?? "")];
	if (value.links?.length)
		parts.push(
			`links (${value.links.length}):\n${value.links.map((link) => `  ${link.text || "(no text)"} → ${link.href}`).join("\n")}`,
		);
	if (value.tables?.length)
		parts.push(
			value.tables
				.map((rows, index) => `table ${index + 1}:\n${rows.map((cells) => `  ${cells.join(" | ")}`).join("\n")}`)
				.join("\n"),
		);
	return parts.filter(Boolean).join("\n");
}

function readingLine(value: PageReading): string {
	const scrolled = value.scrolls ? ` scrolls=${value.scrolls} end=${value.atEnd ? "yes" : "no"}` : "";
	return `title=${JSON.stringify(value.title ?? "")} lines=${value.lines ?? 0}${scrolled}${value.truncated ? " (text cut at maxChars)" : ""}`;
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

const NOT_ON_SCREEN =
	"this chat is not the one on the user's screen; the tab is saved in this chat's panel and appears when the user opens this chat. Do not say it is open in front of the user";

/**
 * Whether the page really drew what `open` asked for. A chat that is not on screen only changes its saved panel
 * (`onScreen: false`); on screen the page reports `shown` once the tab's pane is mounted in a visible panel.
 */
function screenLine(reply: unknown): string {
	const value = reply && typeof reply === "object" ? (reply as { onScreen?: boolean; shown?: string }) : {};
	if (value.onScreen === false) return `\n  on_screen=no (${NOT_ON_SCREEN})`;
	if (value.shown === "visible") return "\n  on_screen=yes";
	if (value.shown === "window-hidden")
		return "\n  on_screen=window-hidden (the MyHarness window is minimized or hidden)";
	if (value.shown === "not-yet") return "\n  on_screen=unconfirmed (requested; the page has not drawn it yet)";
	return "";
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
		onScreen?: false;
	}> => {
		const value = (await page({ action: "tabs" })) as {
			tabs?: WorkspaceTabSummary[];
			activeId?: string | null;
			panelOpen?: boolean;
			onScreen?: boolean;
		};
		return {
			tabs: Array.isArray(value?.tabs) ? value.tabs : [],
			activeId: value?.activeId ?? null,
			panelOpen: !!value?.panelOpen,
			...(value?.onScreen === false ? { onScreen: false as const } : {}),
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

	/** The host's whole-page reading of a tab, with the read options of the call (scroll, links, tables, selector). */
	const readPage = async (id: string, fields: Record<string, unknown>, maxChars: number): Promise<PageReading> => {
		const maxScrolls = Number(fields.maxScrolls) || 20;
		const value = (await browser(
			{
				action: "read",
				tabId: id,
				scroll: fields.scroll === true,
				links: fields.links === true,
				tables: fields.tables === true,
				selector: typeof fields.selector === "string" ? fields.selector : undefined,
				maxScrolls,
				maxChars,
			},
			// Every scroll step waits for the page to append what it loads.
			SLOW_TIMEOUT_MS + (fields.scroll === true ? maxScrolls * 1500 : 0),
		)) as PageReading | null;
		if (!value?.ok) throw new Error(`workspace: the page could not be read: ${value?.error ?? "no answer"}`);
		return value;
	};

	/**
	 * An address read in a reader page of its own (the host's off-screen page in the tabs' session): it draws frames, so
	 * content that loads while scrolling loads as on screen, and it is closed when the reading is done.
	 */
	const readAddress = async (url: string, fields: Record<string, unknown>, maxChars: number): Promise<PageReading> => {
		const maxScrolls = Number(fields.maxScrolls) || 20;
		const value = (await browser(
			{
				action: "readUrl",
				url,
				scroll: fields.scroll === true,
				links: fields.links === true,
				tables: fields.tables === true,
				selector: typeof fields.selector === "string" ? fields.selector : undefined,
				maxScrolls,
				maxChars,
			},
			SLOW_TIMEOUT_MS + 25_000 + (fields.scroll === true ? maxScrolls * 1500 : 0),
		)) as PageReading | null;
		if (!value?.ok) throw new Error(`workspace: the page could not be read: ${value?.error ?? "no answer"}`);
		return value;
	};

	/** What a page shows right now, enough to tell that it changed (its address and the start of its text). */
	const pageSignature = async (id: string): Promise<string> => {
		const state = (await browser({ action: "state", tabId: id }).catch(() => undefined)) as
			| { url?: string }
			| undefined;
		const text = (await browser({ action: "text", tabId: id }).catch(() => undefined)) as
			| { result?: string }
			| undefined;
		return `${state?.url ?? ""}\n${String(text?.result ?? "").slice(0, 6000)}`;
	};

	/** Wait (at most `limitMs`) until the page differs from `before`, then until it has loaded and gone quiet. */
	const changed = async (id: string, before: string, limitMs = 10_000): Promise<boolean> => {
		const deadline = Date.now() + limitMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			if ((await pageSignature(id)) !== before) {
				await settle(id, 20_000).catch(() => undefined);
				await browser({ action: "wait", tabId: id, timeoutMs: 5000 }, 20_000).catch(() => undefined);
				return true;
			}
		}
		return false;
	};

	/** Background copies of the user's own tabs, by the tab they copy: later calls keep working in the same copy. */
	const copies = new Map<string, string>();

	/**
	 * The user's own tab is theirs while they look at it: an operation that would change it (GUARDED_OPERATIONS, or a
	 * scrolling read) runs in a background copy of its address instead, with the same sign-in, and the call's `tabId`
	 * becomes that copy. Tabs the Agent opened, tabs that are not on screen and calls with `onUserTab: true` are left
	 * as they are. Returns the note that tells the model where it acted ("" when nothing was redirected), and `arrived`
	 * when a navigation already happened by opening the copy at its address.
	 */
	const keepOffUserTab = async (fields: Record<string, unknown>): Promise<{ note: string; arrived?: boolean }> => {
		const operation = String(fields.operation || "");
		const guarded =
			GUARDED_OPERATIONS.has(operation) || (operation === "read" && fields.scroll === true && fields.fresh !== true);
		const none = { note: "" };
		if (!guarded || fields.onUserTab === true) return none;
		// An address that will be refused anyway is refused before anything in the workspace is touched.
		if (operation === "navigate" && !/^https?:\/\/[^\s]/i.test(String(fields.url ?? ""))) return none;
		const id = await resolveBrowserTab(typeof fields.tabId === "string" ? fields.tabId : undefined).catch(
			() => undefined,
		);
		if (!id) return none;
		const live = (await browser({ action: "state", tabId: id }).catch(() => undefined)) as
			| { visible?: boolean; active?: boolean; url?: string }
			| undefined;
		if (!live?.visible || !live.active || !live.url) return none;
		const state = await pageTabs().catch(() => undefined);
		if (!state || state.onScreen === false) return none;
		const record = state.tabs.find((tab) => tab.id === id);
		if (!record || record.agent === true) return none;
		let copy = copies.get(id);
		let arrived = false;
		if (!copy || !(await browserTabs().catch(() => [] as WorkspaceTabSummary[])).some((tab) => tab.id === copy)) {
			copy = `browser:agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
			// A navigation goes straight to its address; anything else starts from the page the user is on.
			const start =
				operation === "navigate" && typeof fields.url === "string" && /^https?:/i.test(fields.url)
					? fields.url
					: live.url;
			await page({
				action: "open",
				tab: { type: "browser", id: copy, url: start, muted: true, agent: true },
				background: true,
			});
			await browser({ action: "ensure", tabId: copy, url: start, muted: true }, SLOW_TIMEOUT_MS);
			await settle(copy, 20_000).catch(() => undefined);
			copies.set(id, copy);
			arrived = start !== live.url;
		}
		fields.tabId = copy;
		return {
			note: `\n  note: the user is looking at their tab ${id}, so this ran in your background copy ${copy} (same address and sign-in; their page was not touched). Keep using tabId=${copy}; pass onUserTab: true only when the user asked you to act on their own page.`,
			arrived,
		};
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

	const bookmarkList = async (): Promise<WorkspaceBookmark[]> => {
		const value = (await browser({ action: "bookmarks" })) as { bookmarks?: WorkspaceBookmark[] };
		return (value?.bookmarks || []).map((entry) => ({ id: entry.id, title: entry.title, url: entry.url }));
	};

	const mergedTabs = async (): Promise<{
		tabs: WorkspaceTabSummary[];
		activeId: string | null;
		panelOpen: boolean;
		onScreen?: false;
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
		return {
			tabs,
			activeId: state.activeId,
			panelOpen: state.panelOpen,
			...(state.onScreen === false ? { onScreen: false as const } : {}),
		};
	};

	const runOne = async (input: WorkspaceToolInput): Promise<WorkspaceResult> => {
		const operation = String(input?.operation || "");
		const fields = input as Record<string, unknown>;
		const tabId = typeof fields.tabId === "string" ? fields.tabId : undefined;
		const maxChars = Number(fields.maxChars) || DEFAULT_MAX_CHARS;
		const slow = operation === "ax" || operation === "screenshot" || operation === "exec" || operation === "navigate";
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
					`[workspace] tabs=${state.tabs.length} active=${state.activeId ?? "(none)"} panel=${state.panelOpen ? "open" : "closed"}${state.onScreen === false ? ` on_screen=no (${NOT_ON_SCREEN})` : ""}`,
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
					const wanted = String((input as { bookmark?: string }).bookmark || "");
					let url = String((input as { url?: string }).url || "");
					if (wanted) {
						const list = await bookmarkList();
						const match =
							list.find((entry) => entry.id === wanted) ||
							list.find((entry) => entry.title === wanted) ||
							list.find((entry) => entry.title.toLowerCase() === wanted.toLowerCase());
						if (!match)
							throw new Error(
								`workspace: there is no bookmark ${JSON.stringify(wanted)}; list them with operation=bookmarks`,
							);
						url = match.url;
					}
					let parsed: URL;
					try {
						parsed = new URL(url);
					} catch {
						throw new Error("workspace: open with type=browser needs a valid http(s) url or a bookmark");
					}
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
						throw new Error("workspace: only http and https addresses are allowed");
					// The Agent works in its own tabs: a new one stays in the background unless the user asked to see it.
					const background = (input as { background?: boolean }).background !== false;
					// A website tab the Agent opens plays nothing aloud until the user turns its sound on (the speaker on the tab);
					// an address the user already has open stays their tab, with its sound as it was.
					const opened = await page({
						action: "open",
						tab: { type: "browser", url: parsed.href, muted: true, agent: true },
						...(background ? { background: true } : {}),
					});
					const state = opened as { tabs?: WorkspaceTabSummary[]; activeId?: string | null };
					const tabs = state?.tabs || [];
					const tab = background
						? tabs.filter((entry) => entry.type === "browser" && entry.url === parsed.href).at(-1)
						: tabs.find((entry) => entry.id === state?.activeId) || tabs.at(-1);
					if (!tab) throw new Error("workspace: the page did not report the browser tab it opened");
					// The page owns the tab id and its panel creates the host view on mount; ensure is idempotent, so this
					// call creates the view now when the panel has not mounted yet and never loads the page twice.
					await browser(
						{ action: "ensure", tabId: tab.id, url: parsed.href, ...(tab.muted === true ? { muted: true } : {}) },
						SLOW_TIMEOUT_MS,
					);
					const live = await settle(tab.id);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] opened browser tab ${tab.id}${background ? " (background)" : ""}\n  ${parsed.href}\n  state=${JSON.stringify(live)}${screenLine(opened)}`,
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
								text: `[workspace] opened file tab ${tab?.id || `file:${path}`}\n  path=${path}\n  tabs=${opened?.tabs?.length ?? 0}${screenLine(opened)}`,
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
			case "bookmarks": {
				const list = await bookmarkList();
				const lines = list.map((entry) => `  ${entry.id} ${JSON.stringify(entry.title)} ${entry.url}`);
				return {
					content: [
						{
							type: "text",
							text: `[workspace] bookmarks=${list.length} (trusted sites: full control, saved-login sign-in, permissions allowed)\n${lines.join("\n") || "  (none yet; the user adds them with the star in the browser bar)"}`,
						},
					],
					details: { operation, result: list },
				};
			}
			case "login": {
				const id = await resolveBrowserTab(tabId);
				const value = (await browser({
					action: "login",
					tabId: id,
					submit: (input as { submit?: boolean }).submit !== false,
				})) as {
					ok?: boolean;
					username?: string;
					filledPassword?: boolean;
					submitted?: boolean;
					reason?: string;
				};
				if (!value?.ok) throw new Error(`workspace: the sign-in did not run: ${value?.reason || "no answer"}`);
				// A submit starts a navigation: report where the page went instead of assuming the sign-in worked.
				if (value.submitted) await new Promise((resolve) => setTimeout(resolve, 1200));
				const live = value.submitted
					? await settle(id).catch((error: Error) => ({ error: error.message }))
					: undefined;
				return {
					content: [
						{
							type: "text",
							text: `[workspace] login ${id} as ${JSON.stringify(value.username || "")} password=${value.filledPassword ? "filled" : "not on this page (two-step sign-in: call login again on the next page)"} submitted=${value.submitted ? "yes" : "no"}${live ? `\n  state=${JSON.stringify(live)}` : ""}\n  Check the page (screenshot/text) to confirm the sign-in.`,
						},
					],
					details: { operation, activeId: id, result: value, browser: live },
				};
			}
			case "answer_permission": {
				const requestId = String((input as { requestId?: string }).requestId || "");
				const allow = (input as { allow?: boolean }).allow === true;
				const value = (await browser({ action: "permission", requestId, allow, by: "agent" })) as {
					allowed?: boolean;
					origin?: string;
					permission?: string;
				};
				return {
					content: [
						{
							type: "text",
							text: `[workspace] ${value?.allowed ? "allowed" : "denied"} ${value?.permission ?? ""} for ${value?.origin ?? ""} (remembered for this site)`,
						},
					],
					details: { operation, result: value },
				};
			}
			case "mouse": {
				const id = await resolveBrowserTab(tabId);
				const fieldsIn = input as Record<string, unknown>;
				const value = (await browser(
					{
						action: "mouse",
						tabId: id,
						kind: fieldsIn.action,
						x: fieldsIn.x,
						y: fieldsIn.y,
						selector: fieldsIn.selector,
						index: fieldsIn.index,
						label: fieldsIn.label,
						toX: fieldsIn.toX,
						toY: fieldsIn.toY,
						deltaX: fieldsIn.deltaX,
						deltaY: fieldsIn.deltaY,
						button: fieldsIn.button,
						modifiers: fieldsIn.modifiers,
						// A click that starts a download waits for the file, so it may take longer than other commands.
					},
					SLOW_TIMEOUT_MS,
				)) as {
					ok?: boolean;
					target?: Record<string, unknown>;
					viewport?: { width: number; height: number };
					downloads?: unknown[];
				};
				if (!value?.ok) throw new Error("workspace: the mouse action returned no result");
				if (Number.isFinite(fieldsIn.x) !== Number.isFinite(fieldsIn.y))
					throw new Error("workspace: mouse needs both x and y");
				const point = {
					x: (value as { x?: number }).x ?? fieldsIn.x,
					y: (value as { y?: number }).y ?? fieldsIn.y,
				};
				const where =
					fieldsIn.action === "drag"
						? `(${point.x}, ${point.y}) → (${fieldsIn.toX}, ${fieldsIn.toY})`
						: `(${point.x}, ${point.y})`;
				const started = value.downloads?.length
					? `\n  downloads started by this click=${value.downloads.length}\n${JSON.stringify(value.downloads, null, 1)}`
					: "";
				// The point was on a plain container next to a control (e.g. between two links): say so plainly.
				const near = value.target?.missed
					? (value.target.nearest as Record<string, unknown> | undefined)
					: undefined;
				const missed = near
					? `\n  note: the point is not on a control; the nearest one is ${String(near.tag)}${near.text ? ` "${String(near.text)}"` : ""} ${String(near.distance)}px away, centre (${String(near.x)}, ${String(near.y)}). Aim at that centre or use label.`
					: "";
				return {
					content: [
						{
							type: "text",
							text: `[workspace] mouse ${String(fieldsIn.action)} ${where} in ${id}${value.target ? ` on ${JSON.stringify(value.target)}` : ""}${missed}${started}`,
						},
					],
					details: { operation, activeId: id, result: value },
				};
			}
			case "key": {
				const id = await resolveBrowserTab(tabId);
				const keys = String((input as { keys?: string }).keys || "");
				const value = (await browser({
					action: "keys",
					tabId: id,
					keys,
					repeat: (input as { repeat?: number }).repeat,
				})) as { ok?: boolean; focused?: Record<string, unknown> | null };
				return {
					content: [
						{
							type: "text",
							text: `[workspace] pressed ${keys} in ${id} → focused ${JSON.stringify(value?.focused ?? null)}`,
						},
					],
					details: { operation, activeId: id, result: value },
				};
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
			case "wait": {
				const id = await resolveBrowserTab(tabId);
				const wanted = input as { selector?: string; text?: string; label?: string; gone?: boolean };
				const limit = Number((input as { timeoutMs?: number }).timeoutMs) || 10_000;
				const value = (await browser(
					{
						action: "wait",
						tabId: id,
						selector: wanted.selector,
						text: wanted.text,
						label: wanted.label,
						gone: wanted.gone === true,
						timeoutMs: limit,
					},
					limit + 15_000,
				)) as { ok?: boolean; timeout?: boolean; waitedMs?: number; url?: string };
				const what = wanted.selector
					? `selector=${wanted.selector}`
					: wanted.text
						? `text=${JSON.stringify(wanted.text)}`
						: wanted.label
							? `label=${JSON.stringify(wanted.label)}`
							: "page load and quiet network";
				if (!value?.ok)
					throw new Error(
						`workspace: waited ${value?.waitedMs ?? limit} ms for ${wanted.gone ? "the disappearance of " : ""}${what}; it did not happen (url=${value?.url ?? "?"})`,
					);
				return {
					content: [
						{
							type: "text",
							text: `[workspace] waited ${value.waitedMs} ms for ${wanted.gone ? "the disappearance of " : ""}${what} in ${id}`,
						},
					],
					details: { operation, activeId: id, result: value },
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
			case "read": {
				const id = await resolveBrowserTab(tabId);
				const maxCharsRead = Number(fields.maxChars) || 40_000;
				let value: PageReading;
				if (fields.fresh === true) {
					const live = (await browser({ action: "state", tabId: id })) as { url?: string } | undefined;
					if (!live?.url) throw new Error(`workspace: tab ${id} has no address to read again`);
					value = await readAddress(live.url, fields, maxCharsRead);
				} else value = await readPage(id, fields, maxCharsRead);
				return {
					content: [
						{
							type: "text",
							text: `[workspace] read ${id} ${value.url ?? ""}\n  ${readingLine(value)}\n${formatReading(value)}`,
						},
					],
					details: { operation, activeId: id, result: value },
				};
			}
			case "collect": {
				const id = await resolveBrowserTab(tabId);
				const pages = Math.max(1, Math.min(30, Number(fields.pages) || 5));
				const nextLabel = typeof fields.nextLabel === "string" ? fields.nextLabel : undefined;
				const nextSelector = typeof fields.nextSelector === "string" ? fields.nextSelector : undefined;
				const template = typeof fields.urlTemplate === "string" ? fields.urlTemplate : undefined;
				const from = Number.isInteger(fields.from) ? Number(fields.from) : 1;
				if (template && !template.includes("{page}"))
					throw new Error("workspace: collect urlTemplate needs {page} where the page number goes");
				if (pages > 1 && !template && !nextLabel && !nextSelector)
					throw new Error(
						"workspace: collect needs nextLabel, nextSelector or urlTemplate to reach the next page",
					);
				const perPage = Math.max(1000, Math.floor((Number(fields.maxChars) || 60_000) / pages));
				const sections: string[] = [];
				const links = new Map<string, string>();
				let stopped = "";
				let previous = "";
				for (let index = 0; index < pages; index++) {
					if (template) {
						const address = template.replaceAll("{page}", String(from + index));
						let parsed: URL;
						try {
							parsed = new URL(address);
						} catch {
							throw new Error(`workspace: collect page address ${JSON.stringify(address)} is not a valid url`);
						}
						if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
							throw new Error("workspace: only http and https addresses are allowed");
						await browser({ action: "navigate", tabId: id, url: parsed.href }, SLOW_TIMEOUT_MS);
						await settle(id, 20_000).catch(() => undefined);
					} else if (index > 0) {
						// The next page is whatever the page shows after its "next" control: a new load or new content in place.
						const before = await pageSignature(id);
						try {
							await browser(
								{ action: "click", tabId: id, label: nextLabel, selector: nextSelector },
								SLOW_TIMEOUT_MS,
							);
						} catch (error) {
							stopped = `no next-page control (${error instanceof Error ? error.message : String(error)}); page ${index} was the last`;
							break;
						}
						if (!(await changed(id, before))) {
							stopped = `the page did not change after the next-page control; page ${index} was the last`;
							break;
						}
					}
					const value = await readPage(id, fields, perPage).catch(
						(error: Error) => ({ ok: false, error: error.message }) as PageReading,
					);
					if (!value.ok) {
						stopped = `page ${index + 1} could not be read: ${value.error ?? "no answer"}`;
						break;
					}
					if (index > 0 && value.text === previous) {
						stopped = `page ${index + 1} shows the same content as the page before; that was the last page`;
						break;
					}
					previous = value.text ?? "";
					for (const link of value.links ?? []) if (!links.has(link.href)) links.set(link.href, link.text);
					sections.push(
						`--- page ${index + 1}: ${value.url ?? ""}${value.truncated ? " (cut)" : ""}\n${formatReading({ ...value, links: undefined })}`,
					);
				}
				const linkList = [...links].map(([href, text]) => `  ${text || "(no text)"} → ${href}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `[workspace] collect ${id}: ${sections.length} page(s)${stopped ? ` (stopped: ${stopped})` : ""}\n${sections.join("\n")}${linkList ? `\nlinks of all pages (${links.size}):\n${linkList}` : ""}`,
						},
					],
					details: { operation, activeId: id, result: { pages: sections.length, stopped: stopped || undefined } },
				};
			}
			case "read_many": {
				const urls = Array.isArray(fields.urls) ? (fields.urls as unknown[]).map(String) : [];
				if (!urls.length || urls.length > 10) throw new Error("workspace: read_many takes 1 to 10 urls");
				const addresses = urls.map((url) => {
					let parsed: URL;
					try {
						parsed = new URL(url);
					} catch {
						throw new Error(`workspace: read_many: ${JSON.stringify(url)} is not a valid url`);
					}
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
						throw new Error("workspace: only http and https addresses are allowed");
					return parsed.href;
				});
				const perPage = Number(fields.maxChars) || 8000;
				const results: Array<{ url: string; value?: PageReading; error?: string }> = new Array(addresses.length);
				let nextIndex = 0;
				// Each page is read in a reader page of its own that never appears in the panel and is closed afterwards.
				const lane = async () => {
					while (nextIndex < addresses.length) {
						const index = nextIndex++;
						const url = addresses[index]!;
						try {
							results[index] = { url, value: await readAddress(url, fields, perPage) };
						} catch (error) {
							results[index] = { url, error: error instanceof Error ? error.message : String(error) };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(READ_MANY_LANES, addresses.length) }, lane));
				const text = results
					.map((entry, index) =>
						entry.value
							? `=== ${index + 1}. ${entry.value.url || entry.url}\n  ${readingLine(entry.value)}\n${formatReading(entry.value)}`
							: `=== ${index + 1}. ${entry.url}\n  FAILED: ${entry.error ?? "no answer"}`,
					)
					.join("\n");
				const failed = results.filter((entry) => !entry.value).length;
				return {
					content: [
						{
							type: "text",
							text: `[workspace] read_many ${addresses.length} page(s)${failed ? `, ${failed} failed` : ""}\n${text}`,
						},
					],
					details: {
						operation,
						result: results.map((entry) => ({ url: entry.url, ok: !!entry.value, error: entry.error })),
					},
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
				// Hidden elements keep their index (click/type address the same list) but are left out of the listing; the
				// ones scrolled out of view are marked, since click/type/scroll by index or label bring them into view.
				const shown = elements.filter((element) => element.visible !== false);
				const lines = shown.map((element) => {
					const rect = element.rect as { x?: number; y?: number; width?: number; height?: number } | undefined;
					const at =
						rect && Number(rect.width) > 0 && Number(rect.height) > 0
							? ` @(${Math.round(Number(rect.x) + Number(rect.width) / 2)},${Math.round(Number(rect.y) + Number(rect.height) / 2)})`
							: "";
					const state = [
						element.value ? `value=${JSON.stringify(element.value)}` : "",
						element.checked === true ? "checked" : element.checked === false ? "unchecked" : "",
						element.disabled ? "disabled" : "",
						element.inView === false ? "off-screen" : "",
					].filter(Boolean);
					return `  ${element.index} ${element.tag}${element.type ? `[${element.type}]` : ""}${element.role ? `(${element.role})` : ""} ${JSON.stringify(element.label || element.name || element.href || "")}${at}${state.length ? ` (${state.join(", ")})` : ""}`;
				});
				const hidden = elements.length - shown.length;
				return {
					content: [
						{
							type: "text",
							text: `[workspace] interactive ${id} count=${shown.length}${hidden ? ` (+${hidden} hidden)` : ""}; click/type/mouse/scroll take an index or label\n${lines.join("\n")}`,
						},
					],
					details: { operation, activeId: id, result: elements },
				};
			}
			case "click": {
				const id = await resolveBrowserTab(tabId);
				const selector = (input as { selector?: string }).selector;
				const index = (input as { index?: number }).index;
				const label = (input as { label?: string }).label;
				const value = (await browser(
					{
						action: "click",
						tabId: id,
						selector,
						index,
						label,
						double: (input as { double?: boolean }).double === true,
						button: (input as { button?: string }).button,
					},
					SLOW_TIMEOUT_MS,
				)) as {
					ok?: boolean;
					error?: string;
					text?: string;
					tag?: string;
					x?: number;
					y?: number;
					how?: string;
					covered?: Record<string, unknown>;
					downloads?: unknown[];
				};
				if (!value?.ok)
					throw new Error(`workspace: the click failed: ${value?.error || "the page returned no result"}`);
				const how =
					value.how === "script"
						? ` (script click: ${value.covered ? `covered by ${JSON.stringify(value.covered)}` : "not on screen"})`
						: ` at (${value.x}, ${value.y})`;
				const started = value.downloads?.length
					? `\n  downloads started by this click=${value.downloads.length}\n${JSON.stringify(value.downloads, null, 1)}`
					: "";
				return {
					content: [
						{
							type: "text",
							text: `[workspace] clicked ${id} ${label ? `label=${JSON.stringify(label)}` : selector ? `selector=${selector}` : `index=${index}`} → ${value.tag ?? ""} ${JSON.stringify(value.text || "")}${how}${started}`,
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
				const label = (input as { label?: string }).label;
				if (!selector && !Number.isInteger(index) && !label) {
					// No element named: type where the keyboard is, after clicking the given point if there is one.
					const x = (input as { x?: number }).x;
					const y = (input as { y?: number }).y;
					if (Number.isFinite(x) !== Number.isFinite(y)) throw new Error("workspace: type needs both x and y");
					if (Number.isFinite(x)) await browser({ action: "mouse", tabId: id, kind: "click", x, y });
					const replace = (input as { replace?: boolean }).replace;
					const typed = (await browser({
						action: "insertText",
						tabId: id,
						text,
						replace: replace === false ? false : replace === true ? true : "fields",
					})) as {
						focused?: Record<string, unknown> | null;
					};
					if (typed?.focused && (input as { enter?: boolean }).enter === true)
						await browser({ action: "keys", tabId: id, keys: "Enter" });
					if (!typed?.focused)
						throw new Error(
							"workspace: nothing on the page has the keyboard focus; name the field instead (type with label, selector or index), or click it first (mouse click, or type with x/y)",
						);
					return {
						content: [
							{
								type: "text",
								text: `[workspace] typed into the focused element of ${id} → ${JSON.stringify(typed.focused)}`,
							},
						],
						details: { operation, activeId: id, result: typed },
					};
				}
				const value = (await browser(
					{
						action: "type",
						tabId: id,
						selector,
						index,
						label,
						text,
						replace: (input as { replace?: boolean }).replace,
						enter: (input as { enter?: boolean }).enter === true,
					},
					SLOW_TIMEOUT_MS,
				)) as {
					ok?: boolean;
					error?: string;
					value?: string;
					how?: string;
					tag?: string;
				};
				if (!value?.ok)
					throw new Error(`workspace: typing failed: ${value?.error || "the page returned no result"}`);
				return {
					content: [
						{
							type: "text",
							text: `[workspace] typed into ${id} ${label ? `label=${JSON.stringify(label)}` : selector ? `selector=${selector}` : `index=${index}`} → ${value.tag ?? ""} value=${JSON.stringify(value.value ?? "")}${value.how === "script" ? " (the page refused keyboard input; the value was set directly)" : ""}${(input as { enter?: boolean }).enter ? " + Enter" : ""}`,
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
				})) as {
					matches?: number;
					activeMatch?: number;
					timeout?: boolean;
					elements?: Array<{ tag?: string; text?: string; x?: number; y?: number; inView?: boolean }>;
				};
				if (value?.timeout) throw new Error("workspace: the page did not report find results before the timeout");
				const matches = value?.matches ?? 0;
				const active = value?.activeMatch ?? 0;
				const elements = value?.elements ?? [];
				// Where the words are: elements to click (label/x,y) or to scroll to (scroll with label), on-screen ones first.
				const where = elements.length
					? `\n${elements.map((element) => `  ${element.tag ?? ""} ${JSON.stringify(element.text ?? "")} @(${element.x}, ${element.y})${element.inView ? "" : " (off screen: scroll with label to reach it)"}`).join("\n")}`
					: matches
						? "\n  (no element with these words found in the page's own text; they may be inside a frame)"
						: "";
				return {
					content: [
						{
							type: "text",
							text: `[workspace] find ${JSON.stringify(text)} in ${id} → ${matches} match(es)${matches ? `, active ${active}` : ""}${where}`,
						},
					],
					details: { operation, activeId: id, result: { text, matches, activeMatch: active, elements } },
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
							text: `[workspace] site permissions=${permissions.length} pending=${pending.length}\n${lines.join("\n") || "  (none)"}`,
						},
					],
					details: { operation, result: { permissions, pending } },
				};
			}
			case "scroll": {
				const id = await resolveBrowserTab(tabId);
				const target = input as {
					selector?: string;
					index?: number;
					label?: string;
					x?: number;
					y?: number;
					deltaX?: number | "page";
					deltaY?: number | "page";
					until?: string;
					maxSteps?: number;
				};
				// With an amount or `until`, x/y name the point whose scrolling area moves; alone they are the amounts.
				const aimed = target.deltaX !== undefined || target.deltaY !== undefined || !!target.until;
				const value = (await browser(
					{
						action: "scroll",
						tabId: id,
						...(aimed
							? { atX: target.x, atY: target.y, deltaX: target.deltaX, deltaY: target.deltaY }
							: { x: Number(target.x) || 0, y: Number(target.y) || 0 }),
						until: target.until,
						maxSteps: target.maxSteps,
						selector: target.selector,
						index: target.index,
						label: target.label,
					},
					target.until ? SLOW_TIMEOUT_MS : undefined,
				)) as {
					element?: Record<string, unknown>;
					moved?: number;
					atEnd?: boolean;
					how?: string;
					changed?: boolean;
					container?: Record<string, unknown> | null;
					found?: { tag?: string; text?: string; x?: number; y?: number } | null;
					steps?: number;
				};
				const area = value?.container
					? value.container.page
						? "the page"
						: `${value.container.tag ?? ""} ${JSON.stringify(value.container.text ?? "")}`.trim()
					: "no scrolling area";
				let text: string;
				if (value?.element)
					text = `brought ${value.element.tag} ${JSON.stringify(value.element.text ?? "")} into view at (${value.element.x}, ${value.element.y})`;
				else if (target.until)
					text = value?.found
						? `found ${JSON.stringify(target.until)} after ${value.steps ?? 0} scroll(s): ${value.found.tag ?? ""} ${JSON.stringify(value.found.text ?? "")} at (${value.found.x}, ${value.found.y})`
						: `${JSON.stringify(target.until)} did not appear after ${value?.steps ?? 0} scroll(s) of ${area}${value?.atEnd ? " (reached the end)" : ""}`;
				else
					text =
						value?.how === "wheel"
							? `${area} did not scroll by script; sent a mouse wheel at its centre, the visible content ${value.changed ? "changed" : "did not change"}`
							: `scrolled ${area} by ${value?.moved ?? 0} px${value?.atEnd ? " (reached the end)" : ""}`;
				return {
					content: [{ type: "text", text: `[workspace] ${id}: ${text}` }],
					details: { operation, activeId: id, result: value },
				};
			}
			case "exec": {
				const id = await resolveBrowserTab(tabId);
				const code = String((input as { code?: string }).code || "");
				const value = (await browser({ action: "exec", tabId: id, code }, SLOW_TIMEOUT_MS)) as {
					result?: unknown;
				};
				const serialized = typeof value?.result === "string" ? value.result : JSON.stringify(value?.result ?? null);
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
			case "screenshot":
				return capture(await resolveBrowserTab(tabId));
			case "downloads": {
				const value = (await browser({ action: "downloads", tabId })) as {
					downloads?: unknown[];
					folder?: string;
				};
				const list = value?.downloads || [];
				return {
					content: [
						{
							type: "text",
							text: `[workspace] downloads=${list.length} folder=${value?.folder ?? "(unknown)"}\n${JSON.stringify(list, null, 1)}`,
						},
					],
					details: { operation, result: list },
				};
			}
			case "download": {
				const id = await resolveBrowserTab(tabId);
				const wait = Number((input as { timeoutMs?: number }).timeoutMs) || 120_000;
				const value = (await browser(
					{ action: "download", tabId: id, url: (input as { url?: string }).url, timeoutMs: wait },
					wait + 30_000,
				)) as { downloads?: unknown[]; folder?: string };
				const list = value?.downloads || [];
				return {
					content: [
						{
							type: "text",
							text: `[workspace] download in ${id} folder=${value?.folder ?? "(unknown)"}\n${JSON.stringify(list, null, 1)}`,
						},
					],
					details: { operation, activeId: id, result: list },
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
	};

	/** The picture of a browser tab, saved to a temporary file and attached for the model. */
	const capture = async (id: string): Promise<WorkspaceResult> => {
		const value = (await browser({ action: "snapshot", tabId: id }, SLOW_TIMEOUT_MS)) as {
			snapshot?: string;
			width?: number;
			height?: number;
		};
		const data = String(value?.snapshot || "");
		if (!data.startsWith("data:image/")) throw new Error("workspace: the screenshot command returned no image data");
		const base64 = data.slice(data.indexOf(",") + 1);
		const bytes = Buffer.from(base64, "base64");
		const dir = process.env.MYHARNESS_TEMP_DIR || join(tmpdir(), "myharness-workspace");
		await mkdir(dir, { recursive: true });
		const file = join(dir, `workspace-${id.replace(/[^a-z0-9.-]+/gi, "_")}-${Date.now()}.png`);
		await writeFile(file, bytes);
		await pruneScreenshots(dir);
		const width = Number(value?.width) || undefined;
		const height = Number(value?.height) || undefined;
		// The picture itself goes to the model, so it can point the mouse at what it sees. A resize for the model
		// changes the scale: the note says how to map back to page coordinates.
		const processed = await processImage(bytes, "image/png");
		const scaleNote =
			processed.ok && width && processed.hints.length
				? `\n  ${processed.hints.join(" ")} Page coordinates = picture coordinates scaled to ${width}×${height}.`
				: "";
		const header = `[workspace] screenshot ${id}\n  path=${file}\n  bytes=${bytes.length}${width && height ? `\n  size=${width}×${height} CSS px (mouse x/y use this frame)` : ""}${scaleNote}`;
		return {
			content: processed.ok
				? [
						{ type: "text", text: header },
						{ type: "image", data: processed.data, mimeType: processed.mimeType },
					]
				: [{ type: "text", text: `${header}\n  (picture not attached: ${processed.message})` }],
			details: {
				operation: "screenshot",
				activeId: id,
				screenshot: { path: file, bytes: bytes.length, width, height },
			},
		};
	};

	/**
	 * After an action that can change the page (a click, Enter, a navigation): give the page a moment to react; when it
	 * started loading, wait for the load, and say where it went. Never fails the action itself.
	 */
	const followUp = async (id: string, beforeUrl: string | undefined): Promise<string> => {
		await new Promise((resolve) => setTimeout(resolve, 300));
		const state = (await browser({ action: "state", tabId: id }).catch(() => undefined)) as
			| { loading?: boolean; url?: string }
			| undefined;
		let reached = state;
		if (state?.loading) reached = (await settle(id).catch(() => state)) as typeof state;
		if (reached?.url && beforeUrl && reached.url !== beforeUrl) return `\n  page → ${reached.url}`;
		return reached?.loading ? "\n  page still loading" : "";
	};

	/**
	 * One operation, plus what a person does without thinking after acting: follow the navigation it started, and look
	 * (`screenshot: true` attaches the picture of the tab as it is afterwards).
	 */
	const runActing = async (fields: Record<string, unknown>): Promise<WorkspaceResult> => {
		const operation = String(fields?.operation || "");
		const guard = await keepOffUserTab(fields);
		if (guard.arrived) {
			const reached = (await browser({ action: "state", tabId: String(fields.tabId) })) as
				| { url?: string }
				| undefined;
			return {
				content: [
					{
						type: "text",
						text: `[workspace] navigate ${String(fields.tabId)}\n  url=${reached?.url ?? ""}${guard.note}`,
					},
				],
				details: { operation, activeId: String(fields.tabId), browser: reached },
			};
		}
		// Only input can start a navigation the caller did not ask for; navigate/back/reload report where they went.
		const acting = FOLLOW_OPERATIONS.has(operation) && (operation !== "type" || fields.enter === true);
		const look = fields.screenshot === true && LOOK_OPERATIONS.has(operation);
		const tabIdIn = typeof fields.tabId === "string" ? fields.tabId : undefined;
		const id = acting ? await resolveBrowserTab(tabIdIn).catch(() => undefined) : undefined;
		const before = id
			? ((await browser({ action: "state", tabId: id }).catch(() => undefined)) as { url?: string } | undefined)
			: undefined;
		const result = await runOne(fields as WorkspaceToolInput);
		if (guard.note) {
			const first = result.content[0];
			if (first?.type === "text") first.text += guard.note;
		}
		const resultId = result.details.activeId ?? id;
		if (acting && resultId) {
			const moved = await followUp(resultId, before?.url);
			const first = result.content[0];
			if (moved && first?.type === "text") first.text += moved;
		}
		if (look && resultId) {
			const picture = await capture(resultId);
			result.content.push(...picture.content);
			result.details.screenshot = picture.details.screenshot;
		}
		return result;
	};

	/**
	 * Several steps in one call, run in order on the same tab (a step's own tabId wins), stopping at the first failure.
	 * One picture at the end when `screenshot` is not false, so the model sees where the sequence left the page.
	 */
	const runBatch = async (fields: Record<string, unknown>): Promise<WorkspaceResult> => {
		const steps = Array.isArray(fields.steps) ? (fields.steps as Array<Record<string, unknown>>) : [];
		if (!steps.length) throw new Error("workspace: batch needs steps");
		if (steps.length > MAX_BATCH_STEPS) throw new Error(`workspace: batch takes at most ${MAX_BATCH_STEPS} steps`);
		const tabId = typeof fields.tabId === "string" ? fields.tabId : undefined;
		const lines: string[] = [];
		const images: WorkspaceResult["content"] = [];
		let lastId: string | undefined = tabId;
		for (const [index, raw] of steps.entries()) {
			const step = { ...(raw && typeof raw === "object" ? raw : {}) } as Record<string, unknown>;
			const operation = String(step.operation || "");
			if (!BATCH_OPERATIONS.has(operation))
				throw new Error(
					`workspace: batch step ${index + 1} has operation ${JSON.stringify(operation)}; allowed: ${[...BATCH_OPERATIONS].join(", ")}`,
				);
			if (!step.tabId && lastId) step.tabId = lastId;
			if (fields.onUserTab === true) step.onUserTab = true;
			step.screenshot = operation === "screenshot" ? undefined : false;
			try {
				const result = await runActing(step);
				lastId = result.details.activeId ?? lastId;
				for (const part of result.content) {
					if (part.type === "text") lines.push(`${index + 1}. ${part.text.replace(/^\[workspace\] /, "")}`);
					else images.push(part);
				}
			} catch (error) {
				lines.push(`${index + 1}. FAILED: ${error instanceof Error ? error.message : String(error)}`);
				lines.push(`  stopped; steps ${index + 2}..${steps.length} did not run`);
				break;
			}
		}
		const result: WorkspaceResult = {
			content: [{ type: "text", text: `[workspace] batch ${steps.length} step(s)\n${lines.join("\n")}` }, ...images],
			details: { operation: "batch", activeId: lastId ?? null },
		};
		if (fields.screenshot !== false && lastId) {
			const picture = await capture(lastId).catch((error: Error) => ({
				content: [{ type: "text" as const, text: `[workspace] (no picture: ${error.message})` }],
				details: { operation: "screenshot" } as WorkspaceToolDetails,
			}));
			result.content.push(...picture.content);
			result.details.screenshot = picture.details.screenshot;
		}
		return result;
	};

	return {
		name: "workspace",
		label: "workspace",
		description: [
			"Control the MyHarness desktop workspace: the right-hand panel, the file and media tabs in it, and the built-in browser.",
			"Use `tabs` first to see tab ids. `open` adds a tab without closing what is already open; a website tab opens in the background by default (you work in your own tabs while the user keeps their view; pass `background: false` only when the user asked to see the page). Tabs you open start muted; the user turns their sound on. `close`, `activate`, `close_others`, `move` and `reopen` manage them.",
			"Leave the user's page alone: an action that would change a tab of the user's that they are looking at (click, type, mouse, key, scroll, navigate, back/forward/reload, exec, upload, login, collect, a scrolling read) runs in a background copy of it instead, with the same address and sign-in; the result names the copy, keep using it. Pass `onUserTab: true` only when the user asked you to act on their own page. Reading it (text, read without scroll, screenshot, find, state) never changes it.",
			"Read whole pages, not screens: `read` returns a page's text without repeated lines in one call (`scroll: true` first scrolls to the end so feeds and lazy lists load; `links`/`tables` add those; `selector` reads one part). `collect` reads a paged list in one call: this page, then the next by `nextLabel`/`nextSelector` (the next-page control) or by `urlTemplate` with {page}, up to `pages`, stopping at the last page. `read_many` reads up to 10 addresses side by side in hidden reader pages (the user's sign-ins) that never appear in the panel. A background tab is not drawn, so a list that loads only as it scrolls into view may stop early there; `read` with `fresh: true` reads the tab's address again in such a reader. Prefer these to clicking and scrolling page by page.",
			"Every browser command takes a `tabId` and works on that tab whether or not it is on screen, so several tabs can be driven side by side: navigate/back/forward/reload/stop, text/dom/ax/interactive, find/stop_find, upload, exec, screenshot, downloads, download and network.",
			"A tab on screen has exactly the size of the user's panel (a narrow panel can get a site's phone layout); a background tab is laid out at least 1280×800.",
			"Files: a click that starts a download waits for it and its result gives the saved file's path (files go to the user's Downloads folder, so there is nothing to search for). `download` saves a link directly with the tab's sign-in and returns the path; `downloads` lists recent ones. Move or copy the file afterwards if it belongs elsewhere.",
			'Your own mouse and keyboard: `screenshot` returns the picture of the tab; its pixels are the page\'s CSS pixels, so `mouse` (click/double_click/right_click/move/drag/wheel at x,y) hits exactly the point seen in it - images, canvases and custom controls included. `key` presses keys or combinations ("Control+A", "Enter"), `type` types into the focused element (or clicks x,y first). Selector/index clicks from `interactive` still work.',
			"Point at elements like a person: `click`, `type`, `mouse` and `scroll` take `label` (the words on the element, its placeholder or accessible name), `selector` or `index`; the element is scrolled into view and pressed with the real mouse (a covered or hidden one falls back to its own click(), and the result says so). `type` with a target clicks the field, replaces its text (`replace: false` appends), picks the matching option of a <select>, and `enter: true` submits. A label copied from a screenshot may be cut off or miss punctuation; when nothing matches, the error lists the closest visible texts. Elements inside web components (shadow DOM) are found too. A click or Enter that starts a navigation is followed and the result says where the page went. `wait` waits for a selector, text or label to appear (or with `gone` to disappear), or for the page to load and go quiet.",
			'Lists that scroll inside the page (chat lists, mail, feeds): `scroll` with `deltaY` (px or "page") at x,y or at a label scrolls the area under that point; `until: "words"` keeps scrolling until they are on screen and says where. `find` returns the elements that hold the words with their positions. `exec` errors come back with the page\'s real message.',
			"Fewer round trips: add `screenshot: true` to an action to get the picture of the page after it, and use `batch` with `steps` (click/type/mouse/key/scroll/wait/navigate/back/forward/reload/text/interactive/find/exec/screenshot/state, at most 30) to run a sequence in one call; it stops at the first failing step and ends with one screenshot unless `screenshot: false`.",
			"Bookmarks are sites the user trusts: `bookmarks` lists them, `open` with `bookmark` opens one, `login` signs in to a bookmarked site with the login the user saved (the password is filled by the app and never shown to you), and their site-permission requests are allowed automatically. `permissions` lists decisions and pending requests of any site; `answer_permission` allows or denies a pending one.",
			"Media tabs support play/pause/seek/volume/mute/rate/subtitles. Every call returns the state that was actually reached; a page that does not answer in time is an error, not a success.",
			"`open` reports `on_screen`: only `on_screen=yes` means the user can see the tab now. `on_screen=no` means this chat is not the one on the user's screen (the tab waits in this chat's panel), so never tell the user it is open in front of them.",
			"What it cannot do: solve CAPTCHAs or bot checks, see or type a saved password, confirm payments, or drive anything outside this app's workspace.",
		].join("\n"),
		promptSnippet: loadSystemPrompt("tools/workspace/snippet.md"),
		parameters,
		async execute(_toolCallId, input: WorkspaceToolInput): Promise<WorkspaceResult> {
			const fields = input as Record<string, unknown>;
			if (String(fields?.operation || "") === "batch") return runBatch(fields);
			return runActing(fields);
		},
	};
}

export function createWorkspaceTool(
	options?: WorkspaceToolOptions,
): AgentTool<typeof parameters, WorkspaceToolDetails> {
	return wrapToolDefinition(createWorkspaceToolDefinition(options));
}
