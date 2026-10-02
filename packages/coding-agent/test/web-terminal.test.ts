import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerTerminalRoutes } from "../src/modes/web/routes-terminal.ts";
import { listTerminalShells, MAX_RUNNING_TERMINALS, WebTerminals } from "../src/modes/web/terminal.ts";

// The pseudo terminal is an optional package with one binary per platform. Windows x64 is where MyHarness runs and is
// tested, so the tests always run there; elsewhere they run when the binary is installed.
function ptyInstalled(): boolean {
	try {
		const binary = process.platform === "win32" ? "conpty.node" : "pty.node";
		createRequire(import.meta.url).resolve(`@lydell/node-pty-${process.platform}-${process.arch}/${binary}`);
		return true;
	} catch {
		return false;
	}
}
const runnable = (process.platform === "win32" && process.arch === "x64") || ptyInstalled();

/** What a shell prints without its colour and cursor codes. */
const plain = (text: string) =>
	text.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

describe.skipIf(!runnable)("Web UI terminal (real shells on a pseudo terminal)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	const folders: string[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		// The folders are the working directories of shells that are being ended: Windows frees them once those are gone.
		for (const dir of folders.splice(0)) {
			for (let attempt = 0; ; attempt++) {
				try {
					rmSync(dir, { recursive: true, force: true });
					break;
				} catch (error) {
					if (attempt >= 50) throw error;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}
		}
	});

	function tempDir(): string {
		const dir = join(tmpdir(), `myharness-web-terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		folders.push(dir);
		return dir;
	}

	async function start() {
		const folder = { cwd: tempDir() };
		const events: Array<{ event: string; data: any }> = [];
		const listeners = new Set<() => void>();
		const terminals = new WebTerminals((event, data) => {
			events.push({ event, data });
			for (const listener of [...listeners]) listener();
		});
		const server = new WebHttpServer();
		// The routes only ask the host for the folder of the chat a request belongs to.
		registerTerminalRoutes(server, folder as unknown as WebHost, terminals);
		const address = await server.listen(0);
		cleanups.push(() => server.close());
		cleanups.push(() => terminals.dispose());

		const call = async (method: string, path: string, body?: unknown) => {
			const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
				method,
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const json = (await response.json()) as any;
			if (!response.ok) throw new Error(`${response.status}: ${json.error}`);
			return json;
		};
		const shells = await listTerminalShells();
		// CMD starts fastest and prints the same on every Windows; elsewhere the default shell.
		const shell = (shells.find((candidate) => candidate.id === "cmd") ?? shells[0]).id;
		return {
			folder,
			events,
			terminals,
			shell,
			/** A command whose output (2468) is not part of what is typed. */
			sum: shell === "cmd" ? "set /a 1234*2\r" : "echo $((1234*2))\r",
			get: (path: string) => call("GET", path),
			post: (path: string, body: unknown = {}) => call("POST", path, body),
			output: (id: string) =>
				plain(
					events
						.filter((entry) => entry.event === "terminal_data" && entry.data.id === id)
						.map((entry) => entry.data.data)
						.join(""),
				),
			until: (check: () => boolean, what: string, timeoutMs = 20_000) =>
				new Promise<void>((resolve, reject) => {
					if (check()) return resolve();
					const timer = setTimeout(() => {
						listeners.delete(listener);
						reject(new Error(`timeout waiting for ${what}`));
					}, timeoutMs);
					const listener = () => {
						if (!check()) return;
						clearTimeout(timer);
						listeners.delete(listener);
						resolve();
					};
					listeners.add(listener);
				}),
		};
	}

	it("lists the shells of this computer, the built-in ones first", async () => {
		const fx = await start();
		const { shells } = await fx.get("/api/terminal/shells");
		expect(shells.length).toBeGreaterThan(0);
		for (const shell of shells) expect(Object.keys(shell).sort()).toEqual(["id", "name"]);
		if (process.platform === "win32") {
			expect(shells.slice(0, 2)).toEqual([
				{ id: "powershell", name: "Windows PowerShell" },
				{ id: "cmd", name: "CMD" },
			]);
		}
	});

	it("runs a real shell in the chat's folder and shows a page that opens it later what it has written", async () => {
		const fx = await start();
		const opened = await fx.post("/api/terminal/open", { shell: fx.shell, cols: 100, rows: 30 });
		expect(opened).toMatchObject({
			shell: { id: fx.shell },
			cwd: fx.folder.cwd,
			cols: 100,
			rows: 30,
			exitCode: null,
		});
		expect(opened.windowsPty?.backend).toBe(process.platform === "win32" ? "conpty" : undefined);

		expect(await fx.post("/api/terminal/input", { id: opened.id, data: fx.sum })).toEqual({ ok: true });
		await fx.until(() => fx.output(opened.id).includes("2468"), "the command's output");
		// Output pieces are numbered without gaps, continuing after what the opening answer already contained.
		const seqs = fx.events
			.filter((entry) => entry.event === "terminal_data" && entry.data.id === opened.id)
			.map((entry) => entry.data.seq as number)
			.filter((seq) => seq > opened.seq);
		expect(seqs.length).toBeGreaterThan(0);
		expect(seqs).toEqual(seqs.map((_, index) => opened.seq + 1 + index));

		// Opening it again (another page, a reload, another chat of the folder) is the same shell with its output so far.
		const again = await fx.post("/api/terminal/open", { shell: fx.shell, cols: 60, rows: 20 });
		expect(again).toMatchObject({ id: opened.id, cols: 100, rows: 30, exitCode: null });
		expect(plain(again.buffer)).toContain("2468");
		expect(again.seq).toBeGreaterThanOrEqual(seqs[seqs.length - 1]);

		expect(await fx.post("/api/terminal/resize", { id: opened.id, cols: 60, rows: 20 })).toEqual({ ok: true });
		expect(await fx.post("/api/terminal/open", { shell: fx.shell, cols: 80, rows: 24 })).toMatchObject({
			id: opened.id,
			cols: 60,
			rows: 20,
		});

		// A shell id the computer does not have is answered with the default shell, not with an error.
		const fallback = await fx.post("/api/terminal/open", { shell: "no-such-shell", cols: 80, rows: 24 });
		expect(fallback.shell.id).toBe((await fx.get("/api/terminal/shells")).shells[0].id);

		// Another folder has its own terminal.
		const first = fx.folder.cwd;
		fx.folder.cwd = tempDir();
		const elsewhere = await fx.post("/api/terminal/open", { shell: fx.shell, cols: 80, rows: 24 });
		expect(elsewhere.id).not.toBe(opened.id);
		expect(elsewhere.cwd).toBe(fx.folder.cwd);
		fx.folder.cwd = first;
		expect((await fx.post("/api/terminal/open", { shell: fx.shell, cols: 80, rows: 24 })).id).toBe(opened.id);

		await expect(fx.post("/api/terminal/open", { shell: fx.shell })).rejects.toThrow(/400/);
		await expect(fx.post("/api/terminal/input", { id: opened.id })).rejects.toThrow(/400/);
	});

	it("keeps independent tabs in one folder, including mixed shells", async () => {
		const fx = await start();
		const open = (instance: string, shell = fx.shell, restart = false) =>
			fx.post("/api/terminal/open", { instance, shell, restart, cols: 80, rows: 24 });
		const first = await open("one");
		const second = await open("two");
		expect(first.id).not.toBe(second.id);
		await fx.post("/api/terminal/input", { id: first.id, data: fx.sum });
		await fx.until(() => fx.output(first.id).includes("2468"), "independent output");
		expect(plain((await open("one")).buffer)).toContain("2468");
		expect(plain((await open("two")).buffer)).not.toContain("2468");
		const shells = (await fx.get("/api/terminal/shells")).shells;
		if (shells.length > 1) {
			const other = shells.find((candidate: { id: string }) => candidate.id !== fx.shell);
			expect((await open("mixed", other.id)).shell.id).toBe(other.id);
		}
		await open("one", fx.shell, true);
		expect((await open("two")).id).toBe(second.id);
	});

	it("ends, restarts and replaces terminals, and reports a shell that exits by itself", async () => {
		const fx = await start();
		const open = (extra: Record<string, unknown> = {}) =>
			fx.post("/api/terminal/open", { shell: fx.shell, cols: 80, rows: 24, ...extra });
		const exitOf = (id: string) =>
			fx.events.find((entry) => entry.event === "terminal_exit" && entry.data.id === id)?.data;

		// Restart: the running shell is ended and a new one takes its place.
		const first = await open();
		const second = await open({ restart: true });
		expect(second.id).not.toBe(first.id);
		expect(exitOf(first.id)).toEqual({ id: first.id, exitCode: null });
		expect(await fx.post("/api/terminal/input", { id: first.id, data: "x" })).toEqual({ ok: false });

		// End: the terminal is gone; the next opening starts a new one.
		expect(await fx.post("/api/terminal/close", { id: second.id })).toEqual({ ok: true });
		expect(exitOf(second.id)).toEqual({ id: second.id, exitCode: null });
		expect(await fx.post("/api/terminal/close", { id: second.id })).toEqual({ ok: false });
		expect(await fx.post("/api/terminal/resize", { id: second.id, cols: 90, rows: 30 })).toEqual({ ok: false });
		const third = await open();
		expect(third.id).not.toBe(second.id);

		// The shell exits by itself: the pages are told its exit code.
		await fx.until(() => fx.output(third.id).length > 0, "the shell's first output");
		await fx.post("/api/terminal/input", { id: third.id, data: "exit 3\r" });
		await fx.until(() => exitOf(third.id) !== undefined, "the shell's exit");
		expect(exitOf(third.id)).toEqual({ id: third.id, exitCode: 3 });
		expect(await fx.post("/api/terminal/input", { id: third.id, data: "x" })).toEqual({ ok: false });
		// The page that was showing it gets it back as it ended; any other opening starts a new shell.
		expect(await open({ attached: third.id })).toMatchObject({ id: third.id, exitCode: 3 });
		const fourth = await open();
		expect(fourth.id).not.toBe(third.id);
		expect(fourth.exitCode).toBeNull();

		// After the server has shut its terminals down nothing can be started.
		fx.terminals.dispose();
		await expect(open()).rejects.toThrow(/503/);
	});

	it("refuses one more shell than may run at the same time, without ending any", async () => {
		const fx = await start();
		const opened: string[] = [];
		for (let index = 0; index < MAX_RUNNING_TERMINALS; index++) {
			fx.folder.cwd = tempDir();
			opened.push((await fx.post("/api/terminal/open", { shell: fx.shell, cols: 80, rows: 24 })).id);
		}
		fx.folder.cwd = tempDir();
		await expect(fx.post("/api/terminal/open", { shell: fx.shell, cols: 80, rows: 24 })).rejects.toThrow(/409/);
		expect(new Set(opened).size).toBe(MAX_RUNNING_TERMINALS);
		expect(fx.events.some((entry) => entry.event === "terminal_exit")).toBe(false);
		// Ending one makes room again.
		expect(await fx.post("/api/terminal/close", { id: opened[0] })).toEqual({ ok: true });
		expect((await fx.post("/api/terminal/open", { shell: fx.shell, cols: 80, rows: 24 })).exitCode).toBeNull();
	});
});
