/**
 * Web UI mode: serves the local browser UI for the same AgentSessionRuntime the
 * TUI uses. The server binds to loopback only and is single-user.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@myharness/ai";
import type { AgentSessionRuntime } from "../../agent/runtime/session-runtime.ts";
import { getExportTemplateDir, getWebUiDir, VERSION } from "../../config.ts";
import type { ProjectTrustContext } from "../../extensions/compat/types.ts";
import { WorktreeDisplayNames } from "../../git/worktrees/display-name.ts";
import { setMirrorSessionsAllowed } from "../../session/manager/index.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { WebDialogBridge } from "./dialogs.ts";
import { WebHttpServer } from "./http-server.ts";
import { WebHostHub } from "./hub.ts";
import { WebLifecycle } from "./lifecycle.ts";
import { registerAccountRoutes } from "./routes-accounts.ts";
import { registerCoreRoutes } from "./routes-core.ts";
import { registerFileRoutes, registerFolderBrowser } from "./routes-files.ts";
import { registerGitRoutes } from "./routes-git.ts";
import { registerModeRoutes } from "./routes-modes.ts";
import { registerProviderRoutes } from "./routes-providers.ts";
import { registerSessionRoutes } from "./routes-sessions.ts";
import { registerSettingsRoutes } from "./routes-settings.ts";
import { registerTerminalRoutes } from "./routes-terminal.ts";
import { WebTerminals } from "./terminal.ts";
import { worktreeServiceIdentity } from "./worktree-launch.ts";

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
	// A session that the terminal UI (or another Web UI process) runs can be opened here and followed live.
	setMirrorSessionsAllowed(true);
	const server = new WebHttpServer();
	const dialogs = new WebDialogBridge();
	const instanceId = randomUUID();
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
	const copyIdentity = worktreeServiceIdentity();
	const serviceIdentity = () =>
		copyIdentity
			? {
					id: copyIdentity.id,
					path: copyIdentity.path,
					name:
						new WorktreeDisplayNames(copyIdentity.metadataAgentDir).get(copyIdentity.path) ??
						copyIdentity.path.split(/[\\/]/u).pop(),
				}
			: null;
	server.route("GET", "/api/worktree-service", () =>
		copyIdentity ? { ...serviceIdentity(), token: copyIdentity.token } : {},
	);
	server.route("GET", "/api/boot", () => ({
		instanceId,
		worktreeService: serviceIdentity(),
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
	const copyIdentity = worktreeServiceIdentity();
	const nameTimer = copyIdentity
		? setInterval(
				() =>
					server.broadcast("worktree_name", {
						id: copyIdentity.id,
						path: copyIdentity.path,
						name:
							new WorktreeDisplayNames(copyIdentity.metadataAgentDir).get(copyIdentity.path) ??
							copyIdentity.path.split(/[\\/]/u).pop(),
					}),
				2000,
			)
		: undefined;
	nameTimer?.unref();
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	let shuttingDown = false;
	let restarting = false;
	let restartSessionFile: string | undefined;
	const restartEnvironment = { ...process.env };
	const restartExecutable = process.execPath;
	const restartArguments = [...process.execArgv];
	const restartEntry = process.argv[1]!;
	const hub = new WebHostHub({ server, version: VERSION, onShutdown: () => void shutdown(0) });
	bootstrap.addDialogResponder((id, value) => hub.respondToDialog(id, value));
	const host = hub.host;
	registerCoreRoutes(server, host);
	registerSessionRoutes(server, host, hub);
	registerModeRoutes(server, host, hub);
	registerFileRoutes(server, host);
	registerFolderBrowser(server, host);
	registerGitRoutes(server, host);
	registerSettingsRoutes(server, host);
	registerProviderRoutes(server, host, hub);
	registerAccountRoutes(server);
	// The Terminal panel's shells belong to the server, not to a chat: they outlive the chats that show them.
	const terminals = new WebTerminals((event, data) => server.broadcast(event, data));
	registerTerminalRoutes(server, host, terminals);

	// The server belongs to its browser pages: once the last one is gone for the grace period, it exits.
	const lifecycle = new WebLifecycle({
		getGraceSeconds: () => {
			if (!copyIdentity) return runtimeHost.services.settingsManager.getWebShutdownGraceSeconds();
			try {
				const settings = JSON.parse(readFileSync(join(copyIdentity.metadataAgentDir, "settings.json"), "utf8"));
				const value = settings.worktreeShutdownGraceSeconds;
				if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3600) return value;
			} catch {
				/* Use the isolated startup settings if the source is unavailable. */
			}
			return runtimeHost.services.settingsManager.getWorktreeShutdownGraceSeconds();
		},
		onExpire: () => void shutdown(0),
	});
	server.onClientCountChange = (count) => lifecycle.clientCountChanged(count);
	// A page may have connected while the runtime was still starting.
	lifecycle.attach(server.clientCount, server.hadClient);

	const shutdown = async (code: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		lifecycle.dispose();
		if (nameTimer) clearInterval(nameTimer);
		server.broadcast(restarting ? "restarting" : "shutdown", {});
		try {
			dialogs.dismissAll();
			terminals.dispose();
			await hub.dispose();
		} catch (error) {
			console.error(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			try {
				await server.close();
			} catch (error) {
				console.error(`Server close error: ${error instanceof Error ? error.message : String(error)}`);
				code = 1;
			}
			if (restarting && code === 0) {
				const restartLog = openSync(join(runtimeHost.services.agentDir, "web-restart.log"), "a");
				const childArgs = [
					...restartArguments,
					restartEntry,
					...process.argv
						.slice(2)
						.filter((arg) =>
							["--offline", "--no-extensions", "--no-context-files", "--approve", "--no-approve"].includes(arg),
						),
					"--port",
					String(bootstrap.port),
					"--no-open",
					...(restartSessionFile ? ["--session", restartSessionFile] : []),
				];
				const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
				const windowsCommand = `Start-Process -FilePath ${quote(restartExecutable)} -ArgumentList ${quote(childArgs.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(" "))} -WorkingDirectory ${quote(process.cwd())} -WindowStyle Hidden -RedirectStandardOutput ${quote(join(runtimeHost.services.agentDir, "web-restart.out.log"))} -RedirectStandardError ${quote(join(runtimeHost.services.agentDir, "web-restart.err.log"))}`;
				const child = spawn(
					process.platform === "win32" ? "powershell.exe" : restartExecutable,
					process.platform === "win32"
						? ["-NoProfile", "-EncodedCommand", Buffer.from(windowsCommand, "utf16le").toString("base64")]
						: childArgs,
					{
						env: restartEnvironment,
						cwd: process.cwd(),
						detached: process.platform !== "win32",
						stdio: ["ignore", restartLog, restartLog],
						windowsHide: true,
					},
				);
				closeSync(restartLog);
				child.on("error", (error) => console.error(`Restart failed: ${error.message}`));
				await new Promise<void>((resolveSpawn, rejectSpawn) => {
					if (process.platform === "win32")
						child.once("exit", (code) =>
							code === 0 ? resolveSpawn() : rejectSpawn(new Error(`Restart launcher exited: ${code}`)),
						);
					else child.once("spawn", resolveSpawn);
					child.once("error", rejectSpawn);
				});
				child.unref();
			}
			resolveExit(code);
		}
	};
	server.route("POST", "/api/restart", () => {
		if (shuttingDown) throw new Error("The service is already stopping.");
		if (hub.all().some((slot) => !slot.session.isIdle || slot.completionActive || slot.gitTask)) {
			throw new Error("Stop running tasks before restarting the service.");
		}
		const manager = host.session.sessionManager;
		if (manager.isPersisted() && host.session.sessionFile && !existsSync(host.session.sessionFile)) {
			manager.appendCustomMessageEntry("web-service-restart", "Service restart", true, undefined, true);
		}
		restartSessionFile = manager.isPersisted() ? host.session.sessionFile : undefined;
		restarting = true;
		setTimeout(() => void shutdown(0), 100);
		return { ok: true };
	});
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
