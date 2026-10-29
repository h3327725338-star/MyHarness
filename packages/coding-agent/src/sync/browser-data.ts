/**
 * The built-in browser's own data as sync records (kind `browser`). The desktop host keeps it in its profile folder,
 * `<agentDir>/desktop-profile` (Electron's userData, see packages/desktop/main.cjs), one JSON file per store. A record
 * is one of those files exactly as the store wrote it; the host notices a file written here and reloads that store.
 *
 * Sign-ins and saved passwords travel only inside a vault the host seals with the user's sync passphrase
 * (packages/desktop/browser-sync.cjs): one `browser-vault-<id>.json` per computer, written by that computer alone, so
 * two vaults never need merging and this side never sees what is inside.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stableJson } from "./util.ts";

export const BROWSER_PROFILE_DIR = "desktop-profile";

/** Record id → file of the desktop profile. Only these files (and vaults) are ever read or written. */
const BROWSER_FILES: Record<string, string> = {
	bookmarks: "browser-bookmarks.json",
	"speed-dial": "browser-speed-dial.json",
	zoom: "browser-zoom.json",
	dark: "browser-dark.json",
	language: "browser-language.json",
	permissions: "browser-permissions.json",
};
const VAULT_ID = /^vault-([a-f0-9]{16})$/u;
const VAULT_FILE = /^browser-vault-([a-f0-9]{16})\.json$/u;
const MAX_BOOKMARKS = 500;

export function browserProfileDir(agentDir: string): string {
	return join(agentDir, BROWSER_PROFILE_DIR);
}

/** The profile file a record id stands for, or undefined for an id that is not one of the browser's files. */
export function browserFileOf(id: string): string | undefined {
	const vault = VAULT_ID.exec(id);
	if (vault) return `browser-vault-${vault[1]}.json`;
	return Object.hasOwn(BROWSER_FILES, id) ? BROWSER_FILES[id] : undefined;
}

/** The record id of a profile file name, or undefined for any other file of the profile. */
export function browserIdOf(fileName: string): string | undefined {
	const vault = VAULT_FILE.exec(fileName);
	if (vault) return `vault-${vault[1]}`;
	return Object.keys(BROWSER_FILES).find((id) => BROWSER_FILES[id] === fileName);
}

/** The browser files that exist on this computer. A file the host never wrote is no record at all. */
export function listBrowserFiles(agentDir: string): { id: string; path: string }[] {
	const directory = browserProfileDir(agentDir);
	if (!existsSync(directory)) return [];
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	const files: { id: string; path: string }[] = [];
	for (const name of names.sort()) {
		const id = browserIdOf(name);
		if (id) files.push({ id, path: join(directory, name) });
	}
	return files;
}

export function readBrowserText(agentDir: string, id: string): string | undefined {
	const file = browserFileOf(id);
	if (!file) return undefined;
	try {
		return readFileSync(join(browserProfileDir(agentDir), file), "utf8");
	} catch {
		return undefined;
	}
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Of two different values for one entry, the one both computers pick the same way (the merge must be symmetric). */
function pick<T>(a: T, b: T): T {
	return stableJson(a) >= stableJson(b) ? a : b;
}

/** Union of two maps; an entry both sides hold differently is decided by `choose`. Keys come out sorted. */
function unionMap(a: Json, b: Json, choose: (x: unknown, y: unknown) => unknown = pick): Json {
	const out: Json = {};
	for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
		if (!(key in a)) out[key] = b[key];
		else if (!(key in b)) out[key] = a[key];
		else out[key] = stableJson(a[key]) === stableJson(b[key]) ? a[key] : choose(a[key], b[key]);
	}
	return out;
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Of two versions of one bookmark, the one edited last (its name, address or what it is for); the later use of either is
 * kept, so the Agent's order of recently used sites survives. Ties fall to `pick`, so both computers choose the same.
 */
function newerBookmark(a: Json, b: Json): Json {
	const at = (item: Json) => String(item.updatedAt ?? item.addedAt ?? "");
	const chosen = at(a) === at(b) ? pick(a, b) : at(a) > at(b) ? a : b;
	const used = [a.lastUsedAt, b.lastUsedAt]
		.filter((value): value is string => typeof value === "string")
		.sort()
		.at(-1);
	return used && chosen.lastUsedAt !== used ? { ...chosen, lastUsedAt: used } : chosen;
}

function mergeBookmarks(a: Json, b: Json): string {
	const byId = new Map<string, Json>();
	for (const item of [
		...(Array.isArray(a.bookmarks) ? a.bookmarks : []),
		...(Array.isArray(b.bookmarks) ? b.bookmarks : []),
	]) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.url !== "string") continue;
		const known = byId.get(item.id);
		byId.set(item.id, known ? newerBookmark(known, item) : item);
	}
	// The order of the bar is the order bookmarks were added in; the same page saved on both computers stays once.
	const order = (x: Json, y: Json) =>
		String(x.addedAt ?? "").localeCompare(String(y.addedAt ?? "")) || String(x.id).localeCompare(String(y.id));
	const seen = new Set<string>();
	const bookmarks: Json[] = [];
	for (const item of [...byId.values()].sort(order)) {
		if (seen.has(item.url as string)) continue;
		seen.add(item.url as string);
		bookmarks.push(item);
	}
	return pretty({ version: 1, bookmarks: bookmarks.slice(0, MAX_BOOKMARKS) });
}

/**
 * The new-tab layout is arranged by hand, so it is not interleaved: one whole layout is kept and the shortcuts only
 * the other one has are added after it, in their own order.
 */
function mergeSpeedDial(a: Json, b: Json): string {
	const itemsA = Array.isArray(a.items) ? a.items : [];
	const itemsB = Array.isArray(b.items) ? b.items : [];
	const [base, other] = stableJson(itemsA) >= stableJson(itemsB) ? [itemsA, itemsB] : [itemsB, itemsA];
	const sitesOf = (items: unknown[]) =>
		items.flatMap((item) =>
			isRecord(item) && item.type === "group" && Array.isArray(item.items) ? item.items : [item],
		);
	const ids = new Set<string>();
	const urls = new Set<string>();
	for (const item of base) if (isRecord(item) && typeof item.id === "string") ids.add(item.id);
	for (const site of sitesOf(base)) {
		if (!isRecord(site)) continue;
		if (typeof site.id === "string") ids.add(site.id);
		if (typeof site.url === "string") urls.add(site.url);
	}
	const items = [...base];
	for (const site of sitesOf(other)) {
		if (!isRecord(site) || typeof site.url !== "string" || urls.has(site.url)) continue;
		if (typeof site.id === "string" && ids.has(site.id)) continue;
		urls.add(site.url);
		items.push(site);
	}
	return pretty({ version: 1, items });
}

function mergePermissions(a: Json, b: Json): string {
	const decisions: Json = {};
	const add = (list: unknown) => {
		for (const entry of Array.isArray(list) ? list : []) {
			if (!isRecord(entry) || typeof entry.origin !== "string" || typeof entry.permission !== "string") continue;
			if (typeof entry.allowed !== "boolean") continue;
			const key = `${entry.origin}\u0000${entry.permission}`;
			// A site refused on either computer stays refused until the user allows it again.
			decisions[key] = key in decisions ? decisions[key] === true && entry.allowed : entry.allowed;
		}
	};
	add(a.permissions);
	add(b.permissions);
	const permissions = Object.keys(decisions)
		.sort()
		.map((key) => {
			const at = key.indexOf("\u0000");
			return { origin: key.slice(0, at), permission: key.slice(at + 1), allowed: decisions[key] };
		});
	return pretty({ version: 1, permissions });
}

/**
 * Merge the same browser file changed on two computers. The result is the same on both sides whichever is "local",
 * so both reach one text and the next pass sees equal content. Undefined: not mergeable here (a vault, a damaged file),
 * and the engine keeps both versions instead.
 */
export function mergeBrowserText(id: string, localText: string, remoteText: string): string | undefined {
	if (!browserFileOf(id) || VAULT_ID.test(id)) return undefined;
	let a: unknown;
	let b: unknown;
	try {
		a = JSON.parse(localText);
		b = JSON.parse(remoteText);
	} catch {
		return undefined;
	}
	if (!isRecord(a) || !isRecord(b)) return undefined;
	switch (id) {
		case "bookmarks":
			return mergeBookmarks(a, b);
		case "speed-dial":
			return mergeSpeedDial(a, b);
		case "permissions":
			return mergePermissions(a, b);
		case "zoom":
			return pretty({
				version: 1,
				sites: unionMap(isRecord(a.sites) ? a.sites : {}, isRecord(b.sites) ? b.sites : {}),
			});
		case "dark":
			return pretty({
				version: 1,
				mode: a.mode === b.mode ? a.mode : pick(a.mode, b.mode),
				sites: unionMap(isRecord(a.sites) ? a.sites : {}, isRecord(b.sites) ? b.sites : {}),
			});
		case "language":
			return pretty({ version: 1, language: a.language === b.language ? a.language : pick(a.language, b.language) });
		default:
			return undefined;
	}
}
