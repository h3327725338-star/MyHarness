import { readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorkspaceToolDefinition,
	DesktopWorkspaceChannel,
	desktopWorkspaceAvailable,
	type WorkspaceToolDetails,
} from "../src/tools/workspace.ts";

interface SentCommand {
	requestId: string;
	action: string;
	command: Record<string, unknown>;
}

/** A command that never gets an answer, for the timeout case. */
const NO_ANSWER = Symbol("no answer");

/**
 * Stand-in for the Electron host: answers `browser` and `workspace` commands with whatever the test returns, and keeps
 * the commands it received so the test can check what was actually asked.
 */
function fakeHost(
	respond: (channel: string, command: Record<string, unknown>) => unknown,
	sessionId?: () => string | undefined,
) {
	const sent: SentCommand[] = [];
	let deliver: ((message: unknown) => void) | undefined;
	const channel = new DesktopWorkspaceChannel(
		(message) => {
			const incoming = message as SentCommand;
			sent.push(incoming);
			void Promise.resolve()
				.then(() =>
					incoming.action === "workspace"
						? respond("workspace", incoming.command)
						: respond("browser", incoming.command),
				)
				.then((value) => {
					if (value === NO_ANSWER) return;
					deliver?.({ type: "myharness:browser-result", requestId: incoming.requestId, ok: true, value });
				})
				.catch((error: Error) => {
					deliver?.({
						type: "myharness:browser-result",
						requestId: incoming.requestId,
						ok: false,
						error: error.message,
					});
				});
			return true;
		},
		(listen) => {
			deliver = listen;
		},
	);
	const tool = createWorkspaceToolDefinition({ channel: () => channel, ...(sessionId ? { sessionId } : {}) });
	return { channel, tool, sent };
}

const call = (tool: ReturnType<typeof createWorkspaceToolDefinition>, input: Record<string, unknown>) =>
	tool.execute("call", input as never, undefined, undefined, undefined as never) as Promise<{
		content: { type: "text"; text: string }[];
		details: WorkspaceToolDetails;
	}>;

const pageState = (
	tabs: Array<{ id: string; type: string; path?: string; url?: string }>,
	activeId: string | null,
	media: unknown = null,
) => ({
	tabs,
	activeId,
	panelOpen: true,
	closed: [],
	media,
});

const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("workspace tool: reading the workspace", () => {
	it("merges the page's tab list with the live browser state and marks the active tab", async () => {
		const { tool, sent } = fakeHost((channel, command) => {
			if (channel === "browser" && command.action === "list")
				return [
					{ tabId: "browser:https://example.com/", title: "Example Domain", loading: false, error: "" },
					{ tabId: "browser:https://example.com/slow", title: "", loading: true, error: "" },
				];
			if (channel === "workspace" && command.action === "tabs")
				return pageState(
					[
						{ id: "changes", type: "changes" },
						{ id: "file:src/a.ts", type: "file", path: "src/a.ts" },
						{ id: "browser:https://example.com/", type: "browser", url: "https://example.com/" },
					],
					"file:src/a.ts",
				);
			throw new Error(`unexpected ${channel} ${String(command.action)}`);
		});

		const result = await call(tool, { operation: "tabs" });
		expect(result.details.tabs?.map((tab) => tab.id)).toEqual([
			"changes",
			"file:src/a.ts",
			"browser:https://example.com/",
		]);
		expect(result.details.tabs?.find((tab) => tab.id === "file:src/a.ts")?.active).toBe(true);
		expect(result.details.tabs?.find((tab) => tab.id === "browser:https://example.com/")?.title).toBe(
			"Example Domain",
		);
		expect(result.content[0]!.text).toContain("tabs=3");
		expect(sent.map((command) => command.command.action).sort()).toEqual(["list", "tabs"]);
	});

	it("reports that the desktop host is unavailable instead of pretending to control anything", async () => {
		const tool = createWorkspaceToolDefinition();
		await expect(call(tool, { operation: "tabs" })).rejects.toThrow(/only works in the MyHarness desktop app/);
		const status = await call(tool, { operation: "status" });
		expect(status.content[0]!.text).toContain("desktop_host=unavailable");
	});
});

describe("workspace tool: opening and closing tabs", () => {
	it("names its own chat on every page command, so a chat in the background never fills the panel on screen", async () => {
		const { tool, sent } = fakeHost(
			(channel) =>
				channel === "workspace"
					? pageState([{ id: "file:notes.md", type: "file", path: "notes.md" }], "file:notes.md")
					: [],
			() => "general-session-1",
		);
		await call(tool, { operation: "open", type: "file", path: "notes.md" });
		await call(tool, { operation: "tabs" });
		const pageCommands = sent.filter((entry) => entry.action === "workspace");
		expect(pageCommands.length).toBeGreaterThan(1);
		for (const entry of pageCommands) expect(entry.command.sessionId).toBe("general-session-1");
		// Browser commands go to the host's views, which are keyed by tab id; they carry no chat.
		for (const entry of sent.filter((item) => item.action === "browser"))
			expect(entry.command.sessionId).toBeUndefined();
	});

	it("opens a file tab through the page and returns the tab it became", async () => {
		const { tool, sent } = fakeHost((channel, command) => {
			if (channel !== "workspace") throw new Error("the page owns file tabs");
			expect(command.action).toBe("open");
			expect(command.tab).toEqual({ type: "file", path: "docs/report.pdf" });
			return pageState(
				[{ id: "file:docs/report.pdf", type: "file", path: "docs/report.pdf" }],
				"file:docs/report.pdf",
			);
		});
		const result = await call(tool, { operation: "open", type: "file", path: "docs/report.pdf" });
		expect(result.details.activeId).toBe("file:docs/report.pdf");
		expect(result.content[0]!.text).toContain("opened file tab file:docs/report.pdf");
		expect(sent).toHaveLength(1);
	});

	it("creates the browser tab in the page and the host view under the same id", async () => {
		const events: string[] = [];
		const { tool } = fakeHost((channel, command) => {
			if (channel === "workspace") {
				events.push(`page:${String(command.action)}`);
				const tab = (command.tab || {}) as { url?: string };
				return pageState([{ id: `browser:${tab.url}`, type: "browser", url: tab.url }], `browser:${tab.url}`);
			}
			// The tool waits for the page to finish loading, so state answers without loading.
			if (command.action === "state")
				return { tabId: command.tabId, url: "https://example.com/", title: "", loading: false, error: "" };
			events.push(`host:${String(command.action)}:${String(command.tabId)}`);
			return { tabId: command.tabId, url: command.url, title: "", loading: true, error: "" };
		});
		const result = await call(tool, { operation: "open", type: "browser", url: "https://example.com" });
		expect(events[0]).toBe("page:open");
		expect(events[1]).toBe("host:ensure:browser:https://example.com/");
		expect(result.details.activeId).toBe("browser:https://example.com/");
	});

	it("refuses non-web URLs before touching the workspace", async () => {
		const { tool, sent } = fakeHost(() => {
			throw new Error("must not be called");
		});
		await expect(call(tool, { operation: "open", type: "browser", url: "file:///C:/Windows" })).rejects.toThrow(
			/http/,
		);
		await expect(call(tool, { operation: "navigate", url: "javascript:alert(1)" })).rejects.toThrow(/http/);
		await expect(call(tool, { operation: "open", type: "browser", url: "not a url" })).rejects.toThrow(/valid http/);
		expect(sent).toHaveLength(0);
	});

	it("treats a close that leaves the tab open as a failure", async () => {
		const { tool } = fakeHost((channel, command) => {
			if (channel !== "workspace") throw new Error("unexpected");
			expect(command.action).toBe("close");
			return pageState([{ id: "file:a.ts", type: "file", path: "a.ts" }], "file:a.ts");
		});
		await expect(call(tool, { operation: "close", tabId: "file:a.ts" })).rejects.toThrow(/still in the tab list/);
	});

	it("answers with the reached state for activate, close-others and reopen", async () => {
		const { tool, sent } = fakeHost((channel, command) => {
			if (channel !== "workspace") throw new Error("unexpected");
			if (command.action === "activate") return pageState([{ id: "files", type: "files" }], "files");
			if (command.action === "closeOthers")
				return pageState([{ id: "file:a.ts", type: "file", path: "a.ts" }], "file:a.ts");
			if (command.action === "reopen")
				return pageState([{ id: "file:b.ts", type: "file", path: "b.ts" }], "file:b.ts");
			throw new Error("unexpected action");
		});
		expect((await call(tool, { operation: "activate", tabId: "files" })).details.activeId).toBe("files");
		expect((await call(tool, { operation: "close_others", tabId: "file:a.ts" })).details.page?.tabs).toHaveLength(1);
		expect((await call(tool, { operation: "reopen" })).details.activeId).toBe("file:b.ts");
		expect(sent.map((command) => command.command.action)).toEqual(["activate", "closeOthers", "reopen"]);
	});
});

describe("workspace tool: browser page control", () => {
	it("clicks by interactive index and reports a page-side failure as an error", async () => {
		const browserTabId = "browser:https://example.com/";
		const ok = fakeHost((channel, command) => {
			if (channel === "workspace" && command.action === "tabs")
				return pageState([{ id: browserTabId, type: "browser" }], browserTabId);
			if (channel === "browser" && command.action === "list") return [{ tabId: browserTabId }];
			if (channel === "browser" && command.action === "click") {
				expect(command).toMatchObject({ tabId: browserTabId, index: 3 });
				return { ok: true, tag: "BUTTON", text: "Sign in" };
			}
			throw new Error("unexpected");
		});
		const clicked = await call(ok.tool, { operation: "click", index: 3 });
		expect(clicked.content[0]!.text).toContain("Sign in");

		const missing = fakeHost((channel, command) => {
			if (channel === "workspace" && command.action === "tabs")
				return pageState([{ id: browserTabId, type: "browser" }], browserTabId);
			if (channel === "browser" && command.action === "list") return [{ tabId: browserTabId }];
			if (channel === "browser" && command.action === "click")
				return { ok: false, error: "no interactive element at index 9" };
			throw new Error("unexpected");
		});
		await expect(call(missing.tool, { operation: "click", index: 9 })).rejects.toThrow(/the click failed.*index 9/);
	});

	it("reports the URL a navigation actually reached and fails when the page reports an error", async () => {
		const browserTabId = "browser:https://example.com/";
		const good = fakeHost((channel, command) => {
			if (channel === "workspace") return pageState([{ id: browserTabId, type: "browser" }], browserTabId);
			if (command.action === "list") return [{ tabId: browserTabId }];
			if (command.action === "navigate")
				return { tabId: browserTabId, url: "https://example.com/final", loading: false, error: "" };
			throw new Error("unexpected");
		});
		const navigated = await call(good.tool, { operation: "navigate", url: "https://example.com/start" });
		expect(navigated.content[0]!.text).toContain("https://example.com/final");

		const bad = fakeHost((channel, command) => {
			if (channel === "workspace") return pageState([{ id: browserTabId, type: "browser" }], browserTabId);
			if (command.action === "list") return [{ tabId: browserTabId }];
			if (command.action === "navigate")
				return { tabId: browserTabId, url: "https://nope.invalid/", error: "ERR_NAME_NOT_RESOLVED" };
			throw new Error("unexpected");
		});
		await expect(call(bad.tool, { operation: "navigate", url: "https://nope.invalid/" })).rejects.toThrow(
			/navigation failed/,
		);
	});

	it("uploads a workspace file into the page's file input and reports the real file count", async () => {
		const browserTabId = "browser:https://example.com/";
		const { tool } = fakeHost((channel, command) => {
			if (channel === "workspace") return pageState([{ id: browserTabId, type: "browser" }], browserTabId);
			if (command.action === "list") return [{ tabId: browserTabId }];
			if (command.action === "upload") {
				expect(command).toMatchObject({ tabId: browserTabId, path: "docs/report.pdf", selector: "#file" });
				return { ok: true, name: "report.pdf", size: 1024, count: 1, path: "docs/report.pdf" };
			}
			throw new Error("unexpected");
		});
		const result = await call(tool, { operation: "upload", path: "docs/report.pdf", selector: "#file" });
		expect(result.content[0]!.text).toContain("uploaded report.pdf (1024 bytes)");
		expect(result.details.result).toMatchObject({ count: 1, name: "report.pdf" });
	});

	it("finds in the page, moves to the next match and stops the find", async () => {
		const browserTabId = "browser:https://example.com/";
		const seen: string[] = [];
		const { tool } = fakeHost((channel, command) => {
			if (channel === "workspace") return pageState([{ id: browserTabId, type: "browser" }], browserTabId);
			if (command.action === "list") return [{ tabId: browserTabId }];
			seen.push(String(command.action));
			if (command.action === "find") {
				expect(command).toMatchObject({ tabId: browserTabId, text: "needle", findNext: true });
				return { ok: true, matches: 4, activeMatch: 2 };
			}
			if (command.action === "stopFind") return { ok: true };
			throw new Error("unexpected");
		});
		const found = await call(tool, { operation: "find", text: "needle", findNext: true });
		expect(found.content[0]!.text).toContain("4 match(es), active 2");
		const stopped = await call(tool, { operation: "stop_find" });
		expect(stopped.content[0]!.text).toContain("stopped the find");
		expect(seen).toEqual(["find", "stopFind"]);
	});

	it("reads session site-permission decisions and pending requests without granting anything", async () => {
		const { tool } = fakeHost((channel, command) => {
			if (channel !== "browser") throw new Error("unexpected");
			expect(command).toMatchObject({ action: "permissions", origin: "https://example.com" });
			return {
				permissions: [
					{ origin: "https://example.com", permission: "notifications", allowed: true },
					{ origin: "https://example.com", permission: "geolocation", allowed: false },
				],
				pending: [{ requestId: "p7", permission: "clipboard-read", origin: "https://example.com" }],
			};
		});
		const result = await call(tool, { operation: "permissions", origin: "https://example.com" });
		expect(result.content[0]!.text).toContain("site permissions=2 pending=1");
		expect(result.content[0]!.text).toContain("allowed notifications");
		expect(result.content[0]!.text).toContain("denied geolocation");
		expect(result.content[0]!.text).toContain("pending clipboard-read");
	});

	it("saves a screenshot as a PNG file and returns the path instead of a huge data URL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "myharness-workspace-shot-"));
		temporaryRoots.push(dir);
		const previous = process.env.MYHARNESS_TEMP_DIR;
		process.env.MYHARNESS_TEMP_DIR = dir;
		try {
			for (let index = 0; index < 55; index += 1) {
				const old = join(dir, `workspace-old-${String(index).padStart(2, "0")}.png`);
				writeFileSync(old, "old");
				const at = new Date(1_600_000_000_000 + index * 1000);
				utimesSync(old, at, at);
			}
			const browserTabId = "browser:https://example.com/";
			const { tool } = fakeHost((channel, command) => {
				if (channel === "workspace") return pageState([{ id: browserTabId, type: "browser" }], browserTabId);
				if (command.action === "list") return [{ tabId: browserTabId }];
				if (command.action === "snapshot")
					return { snapshot: `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}` };
				throw new Error("unexpected");
			});
			const result = await call(tool, { operation: "screenshot" });
			const shot = result.details.screenshot;
			expect(shot?.bytes).toBe(7);
			expect(shot?.path.startsWith(dir)).toBe(true);
			expect(await readFile(shot!.path, "utf8")).toBe("PNGDATA");
			const kept = readdirSync(dir).filter((name) => name.startsWith("workspace-") && name.endsWith(".png"));
			expect(kept.length).toBeLessThanOrEqual(50);
			expect(kept.includes("workspace-old-00.png")).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.MYHARNESS_TEMP_DIR;
			else process.env.MYHARNESS_TEMP_DIR = previous;
		}
	});
});

describe("workspace tool: media", () => {
	it("applies a media command and fails when the media did not actually start", async () => {
		const stillPaused = fakeHost((channel, command) => {
			if (channel !== "workspace") throw new Error("unexpected");
			expect(command).toMatchObject({ action: "media", command: "play" });
			return {
				tabs: [{ id: "file:a.mp4", type: "file", path: "a.mp4" }],
				activeId: "file:a.mp4",
				panelOpen: true,
				media: {
					kind: "video",
					paused: true,
					currentTime: 0,
					duration: 12,
					volume: 1,
					muted: false,
					playbackRate: 1,
				},
			};
		});
		await expect(call(stillPaused.tool, { operation: "media", command: "play" })).rejects.toThrow(
			/still paused after play/,
		);

		const playing = fakeHost((channel, command) => {
			if (channel !== "workspace") throw new Error("unexpected");
			expect(command).toMatchObject({ action: "media", command: "seek", value: 4.5 });
			return {
				tabs: [{ id: "file:a.mp4", type: "file", path: "a.mp4" }],
				activeId: "file:a.mp4",
				panelOpen: true,
				media: {
					kind: "video",
					paused: false,
					currentTime: 4.5,
					duration: 12,
					volume: 1,
					muted: false,
					playbackRate: 1,
				},
			};
		});
		const result = await call(playing.tool, { operation: "media", command: "seek", value: 4.5 });
		expect(result.content[0]!.text).toContain("time=4.5/12");
	});

	it("fails clearly when the page has no media element", async () => {
		const { tool } = fakeHost((channel) => {
			if (channel !== "workspace") throw new Error("unexpected");
			return pageState([{ id: "file:a.txt", type: "file", path: "a.txt" }], "file:a.txt", null);
		});
		await expect(call(tool, { operation: "media", command: "pause" })).rejects.toThrow(/no media element/);
	});
});

describe("desktop channel", () => {
	it("needs the desktop host switch, not just a live IPC link", () => {
		// A vitest worker does have process.send (it is a child of the runner), so the switch is what separates a
		// desktop service from any other child process: without MYHARNESS_DESKTOP_HOST=1 the tool is unavailable.
		expect(desktopWorkspaceAvailable({})).toBe(false);
		expect(desktopWorkspaceAvailable({ MYHARNESS_DESKTOP_HOST: "0" })).toBe(false);
	});

	it("times out a command the host never answers instead of hanging", async () => {
		const quiet = fakeHost(() => NO_ANSWER);
		const started = Date.now();
		await expect(quiet.channel.request({ action: "state" }, 30)).rejects.toThrow(/did not answer/);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(quiet.channel.pendingCount).toBe(0);
	});

	it("ignores answers that belong to no request and rejects everything still pending on dispose", async () => {
		const host = fakeHost(() => NO_ANSWER);
		host.channel.handle({ type: "myharness:browser-result", requestId: "unknown", ok: true, value: {} });
		const pending = host.channel.request({ action: "state" }, 5_000);
		expect(host.channel.pendingCount).toBe(1);
		host.channel.dispose("host closed");
		await expect(pending).rejects.toThrow(/host closed/);
		expect(host.channel.pendingCount).toBe(0);
	});
});
