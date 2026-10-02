/**
 * The Terminal panel's shells: real shells running on a pseudo terminal (ConPTY on Windows) in a chat's folder. The
 * page draws what a shell writes (xterm.js) and sends what the user types; nothing here interprets commands.
 *
 * A folder has at most one shell of each kind (Windows PowerShell, CMD, …). It belongs to the folder, not
 * to a chat: every chat of that folder shows the same one, and it keeps running while chats are opened, closed or
 * released in the background. It ends when its shell exits, when the user ends or restarts it, or with the server.
 *
 * The pseudo terminal comes from the optional package @lydell/node-pty (prebuilt binaries, no install script). It is
 * loaded on first use: where it is missing or has no binary for the platform, opening a terminal fails with a clear
 * message and everything else keeps working.
 */

import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { release } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IPty } from "@lydell/node-pty";
import { pathIdentityKey } from "../../utils/paths.ts";
import { getShellEnv, killProcessTree } from "../../utils/shell.ts";
import { HttpError } from "./http-server.ts";

/** Output kept for a page that opens (or reloads) later, so it sees what is on the terminal and not an empty one. */
const MAX_SCROLLBACK_CHARS = 400_000;
/** Output arrives in many small pieces; they are sent together after this long. */
const OUTPUT_FLUSH_MS = 8;
const MIN_SIZE = 2;
const MAX_COLS = 500;
const MAX_ROWS = 300;
/** Shells that may run at the same time. One more is refused: ending one that may still be in use is the user's call. */
export const MAX_RUNNING_TERMINALS = 16;

export interface TerminalShell {
	/** What the page remembers as the chosen shell: "powershell", "cmd", "pwsh", "git-bash", … */
	id: string;
	/** Name shown in the shell menu. */
	name: string;
	file: string;
	args: string[];
}

/** What a page needs to show a terminal it has just opened or come back to. */
export interface TerminalSnapshot {
	id: string;
	shell: { id: string; name: string };
	cwd: string;
	cols: number;
	rows: number;
	/** Everything the shell has written that is still kept (see MAX_SCROLLBACK_CHARS). */
	buffer: string;
	/** Number of the last output piece that `buffer` contains; later pieces arrive as `terminal_data` events. */
	seq: number;
	/** Set once the shell has exited. */
	exitCode: number | null;
	/** On Windows: what xterm.js needs to know about the pseudo terminal to redraw correctly when the size changes. */
	windowsPty: { backend: "conpty"; buildNumber: number } | null;
}

export interface TerminalOpenOptions {
	/** A shell id from `shells()`; the default shell when missing or unknown. */
	shell?: string;
	/** Independent tab identity; omitted for legacy folder/shell reuse. */
	instance?: string;
	/** Size of the page's terminal, used when a new shell is started. */
	cols: number;
	rows: number;
	/** End the running shell of this kind and start a new one. */
	restart?: boolean;
	/** Id of the terminal the page already shows: it is returned as it is, even when its shell has exited meanwhile. */
	attached?: string;
}

interface WebTerminalEvents {
	onData(data: string, seq: number): void;
	onExit(exitCode: number): void;
}

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

async function firstExisting(paths: Array<string | undefined>): Promise<string | undefined> {
	for (const path of paths) if (path && (await exists(path))) return path;
	return undefined;
}

async function findOnPath(name: string): Promise<string | undefined> {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const dirs = (process.env[pathKey] ?? "").split(delimiter).filter(Boolean);
	return firstExisting(dirs.map((dir) => join(dir, name)));
}

/**
 * The shells this computer offers, the default one first. On Windows these are the two built-in shells (Windows
 * PowerShell, CMD), then PowerShell 7 and Git Bash when they are installed. Elsewhere: the user's own shell, then the
 * common ones that exist.
 */
export async function listTerminalShells(): Promise<TerminalShell[]> {
	const shells: TerminalShell[] = [];
	const add = (id: string, name: string, file: string | undefined, args: string[]) => {
		if (file && !shells.some((shell) => shell.id === id || shell.file === file))
			shells.push({ id, name, file, args });
	};
	if (process.platform === "win32") {
		const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
		const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
		add(
			"powershell",
			"Windows PowerShell",
			await firstExisting([join(system, "WindowsPowerShell", "v1.0", "powershell.exe")]),
			["-NoLogo"],
		);
		add("cmd", "CMD", await firstExisting([process.env.ComSpec, join(system, "cmd.exe")]), []);
		const pwsh =
			(await findOnPath("pwsh.exe")) ??
			(await firstExisting(programFiles.map((dir) => dir && join(dir, "PowerShell", "7", "pwsh.exe"))));
		add("pwsh", "PowerShell 7", pwsh, ["-NoLogo"]);
		const gitBash = await firstExisting(programFiles.map((dir) => dir && join(dir, "Git", "bin", "bash.exe")));
		add("git-bash", "Git Bash", gitBash, ["--login", "-i"]);
		return shells;
	}
	const own = process.env.SHELL;
	if (own) add(basename(own), basename(own), await firstExisting([own]), ["-l"]);
	for (const name of ["bash", "zsh", "sh"])
		add(name, name, await firstExisting([`/bin/${name}`, `/usr/bin/${name}`]), []);
	return shells;
}

type PtySpawn = typeof import("@lydell/node-pty").spawn;
let ptySpawn: PtySpawn | undefined;

/** Same two places the other optional native package (the clipboard) is looked up in: this module, then the executable. */
function loadPtySpawn(): PtySpawn {
	if (ptySpawn) return ptySpawn;
	const roots = [import.meta.url, pathToFileURL(join(dirname(process.execPath), "package.json")).href];
	let reason = "";
	for (const root of roots) {
		try {
			const spawn = (createRequire(root)("@lydell/node-pty") as { spawn?: PtySpawn }).spawn;
			if (typeof spawn === "function") {
				ptySpawn = spawn;
				return spawn;
			}
		} catch (error) {
			reason ||= firstLine(error);
		}
	}
	throw new HttpError(
		501,
		`The terminal is not available here: the optional package @lydell/node-pty could not be loaded${reason ? ` (${reason})` : ""}.`,
	);
}

const firstLine = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).split("\n")[0].trim();

function terminalEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(getShellEnv())) if (value !== undefined) env[key] = value;
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	return env;
}

const clampSize = (value: number, max: number): number =>
	Math.min(max, Math.max(MIN_SIZE, Math.floor(Number.isFinite(value) ? value : MIN_SIZE)));

/** "10.0.26200" → 26200. */
const WINDOWS_PTY: TerminalSnapshot["windowsPty"] =
	process.platform === "win32" ? { backend: "conpty", buildNumber: Number(release().split(".")[2]) || 0 } : null;

let nextTerminal = 1;

/** One shell on a pseudo terminal, with the output it has written so far. */
class WebTerminal {
	readonly id = `term-${Date.now().toString(36)}-${nextTerminal++}`;
	readonly shell: TerminalShell;
	readonly cwd: string;
	private readonly pty: IPty;
	private readonly events: WebTerminalEvents;
	private cols: number;
	private rows: number;
	private scrollback = "";
	private pending = "";
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private seq = 0;
	private exited: number | undefined;
	private closed = false;

	constructor(shell: TerminalShell, cwd: string, cols: number, rows: number, events: WebTerminalEvents) {
		this.shell = shell;
		this.cwd = cwd;
		this.cols = clampSize(cols, MAX_COLS);
		this.rows = clampSize(rows, MAX_ROWS);
		this.events = events;
		const spawn = loadPtySpawn();
		try {
			this.pty = spawn(shell.file, shell.args, {
				name: "xterm-256color",
				cols: this.cols,
				rows: this.rows,
				cwd,
				env: terminalEnv(),
			});
		} catch (error) {
			throw new HttpError(500, `Could not start ${shell.name}: ${firstLine(error)}`);
		}
		this.pty.onData((data) => {
			if (this.closed) return;
			this.pending += data;
			this.flushTimer ??= setTimeout(() => this.flush(), OUTPUT_FLUSH_MS);
		});
		this.pty.onExit(({ exitCode }) => {
			if (this.closed) return;
			this.flush();
			this.exited = exitCode;
			this.events.onExit(exitCode);
		});
	}

	/** The shell is still there to type into. */
	get running(): boolean {
		return !this.closed && this.exited === undefined;
	}

	private flush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (!this.pending) return;
		const data = this.pending;
		this.pending = "";
		this.seq += 1;
		this.scrollback += data;
		if (this.scrollback.length > MAX_SCROLLBACK_CHARS) {
			// Drop the oldest output up to a line end, so what is kept does not start in the middle of a line.
			const cut = this.scrollback.length - MAX_SCROLLBACK_CHARS;
			const lineEnd = this.scrollback.indexOf("\n", cut);
			this.scrollback = this.scrollback.slice(lineEnd >= 0 ? lineEnd + 1 : cut);
		}
		this.events.onData(data, this.seq);
	}

	snapshot(): TerminalSnapshot {
		this.flush();
		return {
			id: this.id,
			shell: { id: this.shell.id, name: this.shell.name },
			cwd: this.cwd,
			cols: this.cols,
			rows: this.rows,
			buffer: this.scrollback,
			seq: this.seq,
			exitCode: this.exited ?? null,
			windowsPty: WINDOWS_PTY,
		};
	}

	write(data: string): void {
		if (!this.running) return;
		try {
			this.pty.write(data);
		} catch {
			// The shell ended between the check and the call.
		}
	}

	resize(cols: number, rows: number): void {
		const nextCols = clampSize(cols, MAX_COLS);
		const nextRows = clampSize(rows, MAX_ROWS);
		if (!this.running || (nextCols === this.cols && nextRows === this.rows)) return;
		this.cols = nextCols;
		this.rows = nextRows;
		try {
			this.pty.resize(nextCols, nextRows);
		} catch {
			// The shell ended between the check and the call.
		}
	}

	/**
	 * Ends the shell and everything it started, and stops reporting. The process tree is ended the way the rest of
	 * MyHarness ends one: node-pty's own kill() starts a helper with the running executable, which is only right for a
	 * plain Node.js process. A shell that has already exited is left alone.
	 */
	close(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.pending = "";
		const wasRunning = this.running;
		this.closed = true;
		if (wasRunning) killProcessTree(this.pty.pid);
	}
}

/** All terminals of one Web UI server. `broadcast` sends an event to every open page. */
export class WebTerminals {
	/** By folder and shell. An entry stays after its shell exited, until that shell is opened again. */
	private readonly terminals = new Map<string, WebTerminal>();
	private readonly broadcast: (event: string, data: unknown) => void;
	private disposed = false;

	constructor(broadcast: (event: string, data: unknown) => void) {
		this.broadcast = broadcast;
	}

	async shells(): Promise<Array<{ id: string; name: string }>> {
		return (await listTerminalShells()).map(({ id, name }) => ({ id, name }));
	}

	/**
	 * The terminal of the wanted shell in `cwd`: the one that is running there, otherwise a new one. A shell that has
	 * exited is replaced by a new one; so is a running one when `restart` is set.
	 */
	async open(cwd: string, options: TerminalOpenOptions): Promise<TerminalSnapshot> {
		if (this.disposed) throw new HttpError(503, "The server is shutting down.");
		const shells = await listTerminalShells();
		const shell = shells.find((candidate) => candidate.id === options.shell) ?? shells[0];
		if (!shell) throw new HttpError(501, "No shell was found on this computer.");
		// From here to the new entry nothing waits, so two pages opening the same terminal at once get the same shell.
		const key = `${pathIdentityKey(cwd)}\n${shell.id}\n${options.instance ?? ""}`;
		const current = this.terminals.get(key);
		if (current && !options.restart && (current.running || current.id === options.attached || !!options.instance))
			return current.snapshot();
		return this.start(key, shell, cwd, options).snapshot();
	}

	private start(key: string, shell: TerminalShell, cwd: string, options: TerminalOpenOptions): WebTerminal {
		const running = [...this.terminals.entries()].filter(([id, terminal]) => id !== key && terminal.running).length;
		if (running >= MAX_RUNNING_TERMINALS) {
			throw new HttpError(
				409,
				`${MAX_RUNNING_TERMINALS} terminals are already running. End one of them before starting another.`,
			);
		}
		const terminal: WebTerminal = new WebTerminal(shell, cwd, options.cols, options.rows, {
			onData: (data, seq) => this.broadcast("terminal_data", { id: terminal.id, seq, data }),
			onExit: (exitCode) => this.broadcast("terminal_exit", { id: terminal.id, exitCode }),
		});
		this.end(key);
		this.terminals.set(key, terminal);
		return terminal;
	}

	/** Ends the terminal stored under `key`, if any, and tells the pages that show it. */
	private end(key: string): void {
		const terminal = this.terminals.get(key);
		if (!terminal) return;
		this.terminals.delete(key);
		const wasRunning = terminal.running;
		terminal.close();
		if (wasRunning) this.broadcast("terminal_exit", { id: terminal.id, exitCode: null });
	}

	private find(id: string): [string, WebTerminal] | undefined {
		for (const entry of this.terminals) if (entry[1].id === id) return entry;
		return undefined;
	}

	/** What the user typed. Returns false when the terminal is gone or its shell has exited. */
	write(id: string, data: string): boolean {
		const terminal = this.find(id)?.[1];
		if (!terminal?.running) return false;
		terminal.write(data);
		return true;
	}

	resize(id: string, cols: number, rows: number): boolean {
		const terminal = this.find(id)?.[1];
		if (!terminal?.running) return false;
		terminal.resize(cols, rows);
		return true;
	}

	/** Ends a terminal on the user's request. */
	close(id: string): boolean {
		const entry = this.find(id);
		if (!entry) return false;
		this.end(entry[0]);
		return true;
	}

	/** Ends every shell. Called when the server shuts down. */
	dispose(): void {
		this.disposed = true;
		for (const terminal of this.terminals.values()) terminal.close();
		this.terminals.clear();
	}
}
