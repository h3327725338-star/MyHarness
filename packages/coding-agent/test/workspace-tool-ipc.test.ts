/**
 * The `workspace` tool with a real child-process IPC channel and an isolated faux model. This is the transport the
 * desktop app uses (`process.send` / `process.on('message')` between the web service and Electron main); the parent here
 * plays the host and answers with page/browser state. The model turn is a faux stream, not a real provider.
 */
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const childFile = fileURLToPath(new URL("./fixtures/workspace-tool-ipc-child.ts", import.meta.url));
const loader = pathToFileURL(join(repoRoot, "scripts/dev-fast-loader.mjs")).href;

interface HostCommand {
	action: string;
	command: Record<string, unknown>;
}

function loadPageState() {
	const browserTabId = "browser:https://example.com/";
	return {
		tabs: [
			{ id: "changes", type: "changes" },
			{ id: "file:note.txt", type: "file", path: "note.txt" },
			{ id: browserTabId, type: "browser", url: "https://example.com/" },
		],
		activeId: browserTabId,
		panelOpen: true,
		closed: [],
		media: null,
	};
}

/** What the fake desktop host answers for one command. */
function answer(action: string, command: Record<string, unknown>): unknown {
	const browserTabId = "browser:https://example.com/";
	const state = {
		tabId: browserTabId,
		url: "https://example.com/",
		title: "Example Domain",
		loading: false,
		error: "",
		canGoBack: false,
		canGoForward: false,
		visible: true,
		active: true,
	};
	if (action === "workspace") {
		switch (command.action) {
			case "status":
			case "tabs":
			case "open":
			case "close":
			case "activate":
			case "closeOthers":
			case "move":
			case "reopen":
			case "media":
				return loadPageState();
			default:
				throw new Error(`unexpected workspace command ${String(command.action)}`);
		}
	}
	switch (command.action) {
		case "list":
			return [
				{ tabId: browserTabId, url: "https://example.com/", title: "Example Domain", loading: false, error: "" },
			];
		case "ensure":
		case "activate":
		case "bounds":
		case "state":
			return state;
		case "find":
			return { ...state, ok: true, text: command.text, matches: 2, activeMatch: 1, finalUpdate: true };
		case "upload":
			return { ok: true, name: "note.txt", size: 4, count: 1, path: "note.txt" };
		default:
			throw new Error(`unexpected browser command ${String(command.action)}`);
	}
}

it("the workspace tool reaches the host over real IPC and reports the answers of an isolated faux model turn", async () => {
	const temp = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-workspace-ipc-"));
	const received: HostCommand[] = [];
	const child = fork(childFile, [], {
		execArgv: ["--import", loader],
		env: { ...process.env, MYHARNESS_DESKTOP_HOST: "1", MYHARNESS_TEMP_DIR: temp },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let output = "";
	let errors = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		errors += chunk.toString();
	});
	child.on(
		"message",
		(message: { type?: string; requestId?: string; action?: string; command?: Record<string, unknown> }) => {
			if (message?.type !== "myharness:browser-command") return;
			const action = String(message.action || "");
			const command = message.command || {};
			received.push({ action, command });
			try {
				const value = answer(action, command);
				child.send?.({ type: "myharness:browser-result", requestId: message.requestId, ok: true, value });
			} catch (error) {
				child.send?.({
					type: "myharness:browser-result",
					requestId: message.requestId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	);
	const exit = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
	const timeout = setTimeout(() => child.kill(), 90_000);
	let code: number | null = null;
	try {
		code = await exit;
	} finally {
		clearTimeout(timeout);
		rmSync(temp, { recursive: true, force: true });
	}
	const report = (() => {
		const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
		try {
			return JSON.parse(line || "{}");
		} catch {
			return {};
		}
	})();
	expect(errors).toBe("");
	expect(report.ok, `${errors}\n${output}`).toBe(true);
	expect(code).toBe(0);
	expect(report.results.join("\n")).toContain("desktop_host=connected");
	expect(report.results.join("\n")).toContain("opened browser tab browser:https://example.com/");
	expect(report.results.join("\n")).toContain("2 match(es)");
	expect(report.results.join("\n")).toContain("uploaded note.txt");
	const actions = received.map((entry) => `${entry.action}:${String(entry.command.action)}`);
	expect(actions).toContain("workspace:tabs");
	expect(actions).toContain("workspace:open");
	expect(actions).toContain("browser:list");
	expect(actions).toContain("browser:ensure");
	expect(actions).toContain("browser:find");
	expect(actions).toContain("browser:upload");
	expect(received.every((entry) => entry.action === "workspace" || entry.action === "browser")).toBe(true);
}, 120_000);
