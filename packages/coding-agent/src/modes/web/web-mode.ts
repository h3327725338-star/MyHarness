/**
 * Web UI mode: serves the local browser UI for the same AgentSessionRuntime the
 * TUI uses. The server binds to loopback only and is single-user.
 */

import { join } from "node:path";
import type { ImageContent } from "@myharness/ai";
import type { AgentSessionRuntime } from "../../agent/runtime/session-runtime.ts";
import { getExportTemplateDir, getWebUiDir, VERSION } from "../../config.ts";
import type { ProjectTrustContext } from "../../extensions/compat/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { WebDialogBridge } from "./dialogs.ts";
import { WebHttpServer } from "./http-server.ts";
import { WebHostHub } from "./hub.ts";
import { registerCoreRoutes } from "./routes-core.ts";
import { registerFileRoutes, registerFolderBrowser } from "./routes-files.ts";
import { registerGitRoutes } from "./routes-git.ts";
import { registerProviderRoutes } from "./routes-providers.ts";
import { registerSessionRoutes } from "./routes-sessions.ts";
import { registerSettingsRoutes } from "./routes-settings.ts";

export const DEFAULT_WEB_PORT = 7878;
const PORT_FALLBACK_ATTEMPTS = 10;

export interface WebBootstrap {
	server: WebHttpServer;
	dialogs: WebDialogBridge;
	port: number;
	url: string;
	/** ProjectTrustContext dialogs answered in the browser. */
	trustUi: ProjectTrustContext["ui"];
	/** Lets dialogs owned by other sessions be answered through the same /api/ui/respond route. */
	addDialogResponder(responder: (id: string, value: string | boolean | undefined) => boolean): void;
	setPhase(phase: "starting" | "ready" | "error", detail?: string): void;
}

export interface WebModeOptions {
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMessages?: string[];
	verbose?: boolean;
}

/** Start the HTTP server before the runtime exists so startup questions (Project Trust) can reach the browser. */
export async function startWebBootstrap(options: { port?: number; openBrowser: boolean }): Promise<WebBootstrap> {
	const server = new WebHttpServer();
	const dialogs = new WebDialogBridge();
	let phase: "starting" | "ready" | "error" = "starting";
	let detail: string | undefined;
	const dialogResponders: Array<(id: string, value: string | boolean | undefined) => boolean> = [];

	server.mount({ prefix: "/assets/", directory: getWebUiDir() });
	server.mount({ prefix: "/vendor/", directory: join(getWebUiDir(), "vendor") });
	server.mount({
		prefix: "/vendor-md/",
		directory: join(getExportTemplateDir(), "vendor"),
		files: ["marked.min.js", "highlight.min.js"],
	});
	server.setIndexFile(join(getWebUiDir(), "index.html"));
	server.route("GET", "/api/boot", () => ({
		phase,
		detail: detail ?? null,
		version: VERSION,
		dialogs: dialogs.requests,
	}));
	server.route("POST", "/api/ui/respond", ({ body }) => {
		const payload = (body ?? {}) as { id?: unknown; value?: unknown };
		const value = typeof payload.value === "string" || typeof payload.value === "boolean" ? payload.value : undefined;
		const id = payload.id;
		const ok =
			typeof id === "string" &&
			(dialogs.respond(id, value) || dialogResponders.some((respond) => respond(id, value)));
		return { ok };
	});
	dialogs.onDialogsChanged = () => server.broadcast("dialogs", { requests: dialogs.requests });

	const preferred = options.port ?? DEFAULT_WEB_PORT;
	let address: Awaited<ReturnType<WebHttpServer["listen"]>> | undefined;
	let lastError: unknown;
	const attempts = preferred === 0 ? 1 : PORT_FALLBACK_ATTEMPTS;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			address = await server.listen(preferred === 0 ? 0 : preferred + attempt, "127.0.0.1");
			break;
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
		}
	}
	if (!address) {
		throw new Error(
			`Cannot start the Web UI server: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	}
	const url = `http://127.0.0.1:${address.port}/`;
	if (preferred !== 0 && address.port !== preferred) {
		console.error(`Port ${preferred} is in use; the Web UI is listening on ${address.port} instead.`);
	}
	console.error(`MyHarness Web UI: ${url}`);
	if (options.openBrowser) openBrowser(url);

	return {
		server,
		dialogs,
		port: address.port,
		url,
		trustUi: {
			select: (title, choices) => dialogs.ask("select", { title, options: choices }) as Promise<string | undefined>,
			confirm: async (title, message) => (await dialogs.ask("confirm", { title, message })) === true,
			input: (title, placeholder) => dialogs.ask("input", { title, placeholder }) as Promise<string | undefined>,
			notify: (message, type) => {
				console.error(`${type ?? "info"}: ${message}`);
			},
		},
		addDialogResponder(responder) {
			dialogResponders.push(responder);
		},
		setPhase(next, nextDetail) {
			phase = next;
			detail = nextDetail;
			server.broadcast("boot", { phase, detail: detail ?? null });
		},
	};
}

/** Run the Web UI until shutdown is requested (Ctrl+C in the terminal, the Quit action or SIGTERM). */
export async function runWebMode(
	runtimeHost: AgentSessionRuntime,
	bootstrap: WebBootstrap,
	options: WebModeOptions = {},
): Promise<number> {
	const { server, dialogs } = bootstrap;
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	let shuttingDown = false;
	const hub = new WebHostHub({ server, version: VERSION, onShutdown: () => void shutdown(0) });
	bootstrap.addDialogResponder((id, value) => hub.respondToDialog(id, value));
	const host = hub.host;
	registerCoreRoutes(server, host);
	registerSessionRoutes(server, host, hub);
	registerFileRoutes(server, host);
	registerFolderBrowser(server, host);
	registerGitRoutes(server, host);
	registerSettingsRoutes(server, host);
	registerProviderRoutes(server, host, hub);

	const shutdown = async (code: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.broadcast("shutdown", {});
		dialogs.dismissAll();
		try {
			await hub.dispose();
		} catch (error) {
			console.error(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`);
		}
		await server.close();
		resolveExit(code);
	};
	server.route("POST", "/api/shutdown", () => {
		setTimeout(() => void shutdown(0), 50);
		return { ok: true };
	});

	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	const handlers = signals.map((signal) => {
		const handler = () => void shutdown(signal === "SIGINT" ? 130 : 143);
		process.on(signal, handler);
		return { signal, handler };
	});

	const primary = await hub.addPrimary(runtimeHost, dialogs);
	bootstrap.setPhase("ready");

	const startup = [options.initialMessage, ...(options.initialMessages ?? [])].filter((text): text is string =>
		Boolean(text),
	);
	if (startup.length > 0) {
		void (async () => {
			try {
				await primary.submit(startup[0], { images: options.initialImages });
				for (const message of startup.slice(1)) {
					await primary.session.waitForIdle();
					await primary.waitForCompletion();
					await primary.submit(message);
				}
			} catch (error) {
				server.broadcast("notice", {
					id: `startup-${Date.now()}`,
					message: error instanceof Error ? error.message : String(error),
					type: "error",
					ts: Date.now(),
				});
			}
		})();
	}

	const code = await exited;
	for (const { signal, handler } of handlers) process.off(signal, handler);
	return code;
}
