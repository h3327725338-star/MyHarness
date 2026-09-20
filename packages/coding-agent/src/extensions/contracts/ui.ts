/** Dialog options shared by all frontends. */
export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
	initialValue?: string;
}

export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Raw terminal input listener. */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Configuration for the frontend's working indicator. */
export interface WorkingIndicatorOptions {
	frames?: string[];
	intervalMs?: number;
}

/** Primitive UI ports that do not expose a TUI component or a Theme. */
export interface ExtensionUIContextPort {
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	onTerminalInput(handler: TerminalInputHandler): () => void;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;
	setHiddenThinkingLabel(label?: string): void;
	setTitle(title: string): void;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
}
