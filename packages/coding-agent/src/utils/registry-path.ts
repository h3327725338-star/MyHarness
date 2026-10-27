import { execFile, execFileSync } from "node:child_process";

/**
 * Windows keeps PATH in the registry and a process gets a copy once, from whoever starts it. The server kept the copy
 * it was started with, so agent shells and the terminal missed tools installed while it ran and, when the app had been
 * started by a process with a reduced PATH (a script or another tool's shell), every entry of the user's own PATH:
 * `python` and `g++` that the user's terminal runs were "command not found" for the agent. Shells get the entries a
 * terminal opened now would have, after the ones the server already has.
 */

const KEYS = ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"];
/** Read again (in the background) when older than this, so a tool installed meanwhile is found. */
const MAX_AGE_MS = 60_000;
const QUERY_TIMEOUT_MS = 5000;

let cached: { values: string[]; at: number } | undefined;
let refreshing = false;

/** The PATH value in `reg query <key> /v Path` output; undefined when the key has none. */
export function parseRegQueryPath(output: string): string | undefined {
	return output.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im)?.[1];
}

/** `%NAME%` replaced from env, names compared case-insensitively as Windows does; undefined when a name is unknown. */
function expandWindowsVariables(entry: string, env: NodeJS.ProcessEnv): string | undefined {
	let unknown = false;
	const expanded = entry.replace(/%([^%]+)%/g, (whole, name: string) => {
		const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
		const value = key ? env[key] : undefined;
		if (value === undefined) unknown = true;
		return value ?? whole;
	});
	return unknown ? undefined : expanded;
}

/**
 * The entries of registry PATH values, expanded. reg.exe writes in the console code page and turns what it cannot
 * show into "?", so an entry that is not plain ASCII before expansion cannot be trusted and is left out.
 */
export function pathEntriesFromRegistryValues(values: readonly string[], env: NodeJS.ProcessEnv): string[] {
	const entries: string[] = [];
	for (const value of values) {
		for (const raw of value.split(";")) {
			const entry = raw.trim();
			if (!entry || entry.includes("?") || !/^[\x20-\x7e]+$/.test(entry)) continue;
			const expanded = expandWindowsVariables(entry, env);
			if (expanded) entries.push(expanded);
		}
	}
	return entries;
}

/** `current` followed by the entries it does not have yet (compared as Windows does: any case, no trailing slash). */
export function appendMissingPathEntries(current: string, additions: readonly string[]): string {
	const comparable = (entry: string) => entry.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
	const seen = new Set(current.split(";").filter(Boolean).map(comparable));
	const missing = additions.filter((entry) => {
		const key = comparable(entry);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return missing.length === 0 ? current : [current, ...missing].filter(Boolean).join(";");
}

function queryArgs(key: string): string[] {
	return ["query", key, "/v", "Path"];
}

function readValuesSync(): string[] {
	return KEYS.map((key) => {
		try {
			const output = execFileSync("reg.exe", queryArgs(key), {
				encoding: "latin1",
				windowsHide: true,
				timeout: QUERY_TIMEOUT_MS,
				stdio: ["ignore", "pipe", "ignore"],
			});
			return parseRegQueryPath(output) ?? "";
		} catch {
			return "";
		}
	});
}

function readValues(): Promise<string[]> {
	return Promise.all(
		KEYS.map(
			(key) =>
				new Promise<string>((resolve) => {
					execFile(
						"reg.exe",
						queryArgs(key),
						{ encoding: "latin1", windowsHide: true, timeout: QUERY_TIMEOUT_MS },
						(error, stdout) => resolve(error ? "" : (parseRegQueryPath(stdout) ?? "")),
					);
				}),
		),
	);
}

/**
 * The machine and user PATH entries a process started now would get (Windows only; empty elsewhere or when the
 * registry cannot be read). The first call reads synchronously so the first command already finds the tools; later
 * calls answer from the last read and refresh it in the background once it is a minute old.
 */
export function registryPathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
	if (process.platform !== "win32") return [];
	if (!cached) {
		cached = { values: readValuesSync(), at: Date.now() };
	} else if (Date.now() - cached.at > MAX_AGE_MS && !refreshing) {
		refreshing = true;
		void readValues()
			.then((values) => {
				cached = { values, at: Date.now() };
			})
			.finally(() => {
				refreshing = false;
			});
	}
	return pathEntriesFromRegistryValues(cached.values, env);
}
