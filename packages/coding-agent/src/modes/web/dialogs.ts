/**
 * Bridges Extension UI dialogs (select / confirm / input / editor) to the browser.
 *
 * Extensions call these through ExtensionUIContext, exactly as they do in the
 * TUI. The bridge keeps the request pending until a browser answers it, the
 * dialog's own timeout/abort fires, or the owning runtime is torn down.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions } from "../../extensions/contracts/ui.ts";
import type { ExtensionUIContext } from "../../extensions/runtime/types.ts";

export type WebDialogKind = "select" | "confirm" | "input" | "editor";

export interface WebDialogRequest {
	id: string;
	kind: WebDialogKind;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	initialValue?: string;
	/** Absolute deadline (ms epoch) when the dialog auto-dismisses. */
	deadline?: number;
	createdAt: number;
}

export interface WebUiSurfaceState {
	statuses: Record<string, string>;
	workingMessage?: string;
	workingVisible: boolean;
	hiddenThinkingLabel?: string;
	title?: string;
	widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	notices: Array<{ id: string; message: string; type: "info" | "warning" | "error"; ts: number }>;
}

interface PendingDialog {
	request: WebDialogRequest;
	resolve: (value: unknown) => void;
	cleanup: () => void;
}

type DialogValue = string | boolean | undefined;

export class WebDialogBridge {
	private readonly pending = new Map<string, PendingDialog>();
	private readonly surface: WebUiSurfaceState = {
		statuses: {},
		workingVisible: true,
		widgets: {},
		notices: [],
	};
	private editorText = "";
	onDialogsChanged: (() => void) | undefined;
	onSurfaceChanged: (() => void) | undefined;
	onEditorText: ((text: string) => void) | undefined;
	onNotice: ((notice: WebUiSurfaceState["notices"][number]) => void) | undefined;

	get requests(): WebDialogRequest[] {
		return [...this.pending.values()].map((entry) => entry.request);
	}

	get surfaceState(): WebUiSurfaceState {
		return this.surface;
	}

	get currentEditorText(): string {
		return this.editorText;
	}

	setEditorTextFromClient(text: string): void {
		this.editorText = text;
	}

	/** Ask the browser a question. Resolves undefined (or false for confirm) when dismissed. */
	ask(
		kind: WebDialogKind,
		fields: Omit<WebDialogRequest, "id" | "kind" | "createdAt" | "deadline">,
		opts?: ExtensionUIDialogOptions,
	): Promise<DialogValue> {
		const id = randomUUID();
		const request: WebDialogRequest = {
			id,
			kind,
			...fields,
			...(opts?.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
			...(opts?.timeout ? { deadline: Date.now() + opts.timeout } : {}),
			createdAt: Date.now(),
		};
		return new Promise<DialogValue>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
			};
			const finish = (value: DialogValue) => {
				if (!this.pending.delete(id)) return;
				cleanup();
				this.onDialogsChanged?.();
				resolve(value);
			};
			const dismissValue = kind === "confirm" ? false : undefined;
			const onAbort = () => finish(dismissValue);
			if (opts?.timeout) timer = setTimeout(() => finish(dismissValue), opts.timeout);
			if (opts?.signal) {
				if (opts.signal.aborted) {
					resolve(dismissValue);
					return;
				}
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending.set(id, { request, resolve: (value) => finish(value as DialogValue), cleanup });
			this.onDialogsChanged?.();
		});
	}

	/** Answer a pending dialog from the browser. Returns false when it is no longer pending. */
	respond(id: string, value: DialogValue): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		entry.resolve(value);
		return true;
	}

	/** Dismiss everything that is pending (session replaced / shutting down). */
	dismissAll(): void {
		for (const [id, entry] of [...this.pending.entries()]) {
			entry.resolve(entry.request.kind === "confirm" ? false : undefined);
			this.pending.delete(id);
		}
		this.onDialogsChanged?.();
	}

	resetSurface(): void {
		this.surface.statuses = {};
		this.surface.workingMessage = undefined;
		this.surface.workingVisible = true;
		this.surface.hiddenThinkingLabel = undefined;
		this.surface.title = undefined;
		this.surface.widgets = {};
		this.onSurfaceChanged?.();
	}

	private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		const notice = { id: randomUUID(), message, type, ts: Date.now() };
		this.surface.notices = [...this.surface.notices.slice(-19), notice];
		this.onNotice?.(notice);
	}

	/**
	 * ExtensionUIContext for the Web host. Dialog and status APIs are real;
	 * terminal-only APIs (custom components, custom editors, footers) are inert
	 * because the browser cannot host TUI components.
	 */
	createExtensionUiContext(options: {
		getAllThemes: () => { name: string; path: string | undefined }[];
	}): ExtensionUIContext {
		return {
			select: (title, choices, opts) =>
				this.ask("select", { title, options: choices }, opts) as Promise<string | undefined>,
			confirm: async (title, message, opts) => (await this.ask("confirm", { title, message }, opts)) === true,
			input: (title, placeholder, opts) =>
				this.ask("input", { title, placeholder }, opts) as Promise<string | undefined>,
			editor: (title, prefill) =>
				this.ask("editor", { title }, { initialValue: prefill }) as Promise<string | undefined>,
			notify: (message, type) => this.notify(message, type),
			setStatus: (key, text) => {
				if (text === undefined) delete this.surface.statuses[key];
				else this.surface.statuses[key] = text;
				this.onSurfaceChanged?.();
			},
			setWorkingMessage: (message) => {
				this.surface.workingMessage = message;
				this.onSurfaceChanged?.();
			},
			setWorkingVisible: (visible) => {
				this.surface.workingVisible = visible;
				this.onSurfaceChanged?.();
			},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: (label) => {
				this.surface.hiddenThinkingLabel = label;
				this.onSurfaceChanged?.();
			},
			setWidget: ((key: string, content: unknown, widgetOptions?: { placement?: "aboveEditor" | "belowEditor" }) => {
				if (Array.isArray(content)) {
					this.surface.widgets[key] = {
						lines: content.map(String),
						placement: widgetOptions?.placement ?? "aboveEditor",
					};
				} else {
					delete this.surface.widgets[key];
				}
				this.onSurfaceChanged?.();
			}) as ExtensionUIContext["setWidget"],
			setTitle: (title) => {
				this.surface.title = title;
				this.onSurfaceChanged?.();
			},
			pasteToEditor: (text) => {
				this.editorText += text;
				this.onEditorText?.(this.editorText);
			},
			setEditorText: (text) => {
				this.editorText = text;
				this.onEditorText?.(text);
			},
			getEditorText: () => this.editorText,
			getAllThemes: options.getAllThemes,
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}
}
