import { fauxAssistantMessage } from "@myharness/ai";
import { Container, Text } from "@myharness/tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/agent/runtime/agent-session.ts";
import type { ExtensionUIContext } from "../../../src/extensions/compat/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function createUiContext(
	onNotify: (message: string, type: "info" | "warning" | "error" | undefined) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: onNotify,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

type LoadedResourcesResult<T> = { [K in keyof T]: T[K] } & { diagnostics: [] };

type LoadedResourcesContext = {
	loadedResourcesContainer: Container;
	chatContainer: Container;
	options: { verbose?: boolean };
	settingsManager: { getQuietStartup: () => boolean };
	sessionManager: { getCwd: () => string };
	session: {
		promptTemplates: [];
		resourceLoader: {
			getAgentsFiles: () => LoadedResourcesResult<{ agentsFiles: Array<{ path: string }> }>;
			getSkills: () => LoadedResourcesResult<{ skills: [] }>;
			getPrompts: () => LoadedResourcesResult<{ prompts: [] }>;
			getThemes: () => LoadedResourcesResult<{ themes: [] }>;
			getExtensions: () => { extensions: []; errors: [] };
		};
		extensionRunner: {
			getCommandDiagnostics: () => [];
			getShortcutDiagnostics: () => [];
			getRegisteredCommands: () => [];
		};
	};
	getStartupExpansionState: () => boolean;
	formatDisplayPath: (resourcePath: string) => string;
	formatContextPath: (resourcePath: string) => string;
	getBuiltInCommandConflictDiagnostics: (extensionRunner: LoadedResourcesContext["session"]["extensionRunner"]) => [];
};

type RebindContext = {
	unsubscribe?: () => void;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	subscribeToAgent: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type InteractiveModePrototype = {
	showLoadedResources(
		this: LoadedResourcesContext,
		options?: { extensions?: Array<{ path: string }>; force?: boolean; showDiagnosticsWhenQuiet?: boolean },
	): void;
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type MessageEvent = Extract<AgentSessionEvent, { type: "message_start" | "message_end" }>;

function getMessageText(event: MessageEvent): string {
	const message = event.message;
	if (!("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function createLoadedResourcesContext(): LoadedResourcesContext {
	return {
		loadedResourcesContainer: new Container(),
		chatContainer: new Container(),
		options: { verbose: true },
		settingsManager: { getQuietStartup: () => false },
		sessionManager: { getCwd: () => "/repo" },
		session: {
			promptTemplates: [],
			resourceLoader: {
				getAgentsFiles: () => ({ agentsFiles: [{ path: "/repo/AGENTS.md" }], diagnostics: [] }),
				getSkills: () => ({ skills: [], diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
				getExtensions: () => ({ extensions: [], errors: [] }),
			},
			extensionRunner: {
				getCommandDiagnostics: () => [],
				getShortcutDiagnostics: () => [],
				getRegisteredCommands: () => [],
			},
		},
		getStartupExpansionState: () => false,
		formatDisplayPath: (resourcePath) => resourcePath,
		formatContextPath: (resourcePath) => resourcePath.replace("/repo/", ""),
		getBuiltInCommandConflictDiagnostics: () => [],
	};
}

describe("regression #5943: session_start transient UI", () => {
	it("renders loaded resources before restored messages without stale entries", () => {
		initTheme("dark", false);
		const context = createLoadedResourcesContext();
		const root = new Container();
		root.addChild(context.loadedResourcesContainer);
		root.addChild(context.chatContainer);
		context.loadedResourcesContainer.addChild(new Text("stale resources", 0, 0));
		context.chatContainer.addChild(new Text("restored message", 0, 0));

		interactiveModePrototype.showLoadedResources.call(context);

		const chatRendered = context.chatContainer.render(80).join("\n");
		expect(chatRendered).toContain("restored message");
		expect(chatRendered).not.toContain("[Context]");

		const rendered = root.render(80).join("\n");
		expect(rendered).not.toContain("stale resources");
		expect(rendered.indexOf("[Context]")).toBeLessThan(rendered.indexOf("restored message"));
	});

	it("renders replacement session state before session_start handlers can notify", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.notify("Hello Error", "error");
					});
				},
			],
		});

		try {
			const context: RebindContext = {
				applyRuntimeSettings: () => events.push("apply"),
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext((message) => events.push(`notify:${message}`)),
						mode: "tui",
					});
				},
				subscribeToAgent: () => events.push("subscribe"),
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });

			expect(events).toEqual(["apply", "render", "subscribe", "bind", "notify:Hello Error"]);
		} finally {
			harness.cleanup();
		}
	});

	it("subscribes before replacement session_start handlers send messages", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendMessage({
							customType: "session-start",
							content: "custom from start",
							display: true,
						});
					});
				},
			],
		});

		try {
			const context: RebindContext = {
				applyRuntimeSettings: () => {},
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext(() => {}),
						mode: "tui",
					});
				},
				subscribeToAgent: () => {
					events.push("subscribe");
					harness.session.subscribe((event) => {
						if (event.type !== "message_start" && event.type !== "message_end") {
							return;
						}
						events.push(`${event.type}:${event.message.role}:${getMessageText(event)}`);
					});
				},
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });

			expect(events).toEqual([
				"render",
				"subscribe",
				"bind",
				"message_start:custom:custom from start",
				"message_end:custom:custom from start",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("subscribes before replacement session_start handlers send user messages", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendUserMessage("user from start");
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("assistant from start")]);

		try {
			const context: RebindContext = {
				applyRuntimeSettings: () => {},
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext(() => {}),
						mode: "tui",
					});
				},
				subscribeToAgent: () => {
					events.push("subscribe");
					harness.session.subscribe((event) => {
						if (event.type !== "message_start" && event.type !== "message_end") {
							return;
						}
						events.push(`${event.type}:${event.message.role}:${getMessageText(event)}`);
					});
				},
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });
			await harness.session.agent.waitForIdle();

			expect(events.slice(0, 3)).toEqual(["render", "subscribe", "bind"]);
			expect(events).toContain("message_start:user:user from start");
			expect(events).toContain("message_end:user:user from start");
			expect(events).toContain("message_end:assistant:assistant from start");
		} finally {
			harness.cleanup();
		}
	});

	it("runs the reload render hook before reload session_start handlers can notify", async () => {
		const events: string[] = [];
		const beforeSessionStart = vi.fn(() => {
			events.push("render");
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event, ctx) => {
						events.push(`start:${event.reason}`);
						ctx.ui.notify(`notify:${event.reason}`, "error");
					});
				},
			],
		});

		try {
			await harness.session.bindExtensions({
				uiContext: createUiContext((message) => events.push(message)),
				mode: "tui",
			});
			expect(events).toEqual(["start:startup", "notify:startup"]);

			events.length = 0;
			await harness.session.reload({ beforeSessionStart });

			expect(beforeSessionStart).toHaveBeenCalledTimes(1);
			expect(events).toEqual(["render", "start:reload", "notify:reload"]);
		} finally {
			harness.cleanup();
		}
	});
});
