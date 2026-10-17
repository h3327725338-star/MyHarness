import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { mergeProfileCookies } from "../src/tools/web-search/browser/profile-cookies.ts";

const roots: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "myharness-profile-cookies-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Firefox cookie database with the columns and unique index that matter here. */
function firefoxProfile(
	dir: string,
	cookies: Array<[host: string, name: string, value: string, lastAccessed: number]>,
) {
	mkdirSync(dir, { recursive: true });
	const database = new DatabaseSync(join(dir, "cookies.sqlite"));
	database.exec(`CREATE TABLE moz_cookies (
		id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT,
		expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER,
		CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes))`);
	const insert = database.prepare(
		"INSERT INTO moz_cookies (name, value, host, path, expiry, lastAccessed, creationTime) VALUES (?, ?, ?, '/', 9999999999, ?, 1)",
	);
	for (const [host, name, value, lastAccessed] of cookies) insert.run(name, value, host, lastAccessed);
	database.close();
}

function firefoxCookies(dir: string): Record<string, string> {
	const database = new DatabaseSync(join(dir, "cookies.sqlite"), { readOnly: true });
	try {
		const rows = database.prepare("SELECT host, name, value FROM moz_cookies").all() as Array<{
			host: string;
			name: string;
			value: string;
		}>;
		return Object.fromEntries(rows.map((row) => [`${row.host} ${row.name}`, row.value]));
	} finally {
		database.close();
	}
}

describe("sharing cookies between MyHarness' own profiles", () => {
	it("merges per site and keeps the copy that was used last", () => {
		const root = tempDir();
		const target = join(root, "slot-0");
		const source = join(root, "slot-1");
		firefoxProfile(target, [
			[".reddit.com", "reddit_session", "old", 100],
			[".example.com", "keep", "target", 500],
		]);
		firefoxProfile(source, [
			[".reddit.com", "reddit_session", "new", 200],
			[".bilibili.com", "SESSDATA", "bili", 300],
			[".example.com", "keep", "stale", 400],
		]);
		const result = mergeProfileCookies("firefox", target, [source]);
		expect(result).toEqual({ merged: 1, errors: [] });
		expect(firefoxCookies(target)).toEqual({
			".reddit.com reddit_session": "new",
			".bilibili.com SESSDATA": "bili",
			".example.com keep": "target",
		});
		// The source profile is only read.
		expect(firefoxCookies(source)[".example.com keep"]).toBe("stale");
	});

	it("gives a profile that has no cookies yet a copy, and skips profiles without cookies", () => {
		const root = tempDir();
		const source = join(root, "slot-0");
		firefoxProfile(source, [[".reddit.com", "reddit_session", "s", 1]]);
		const target = join(root, "slot-1");
		const result = mergeProfileCookies("firefox", target, [source, join(root, "missing")]);
		expect(result).toEqual({ merged: 1, errors: [] });
		expect(firefoxCookies(target)).toEqual({ ".reddit.com reddit_session": "s" });
	});

	it("reports a broken source instead of throwing", () => {
		const root = tempDir();
		const target = join(root, "slot-0");
		firefoxProfile(target, []);
		const source = join(root, "slot-1");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "cookies.sqlite"), "not a database");
		const result = mergeProfileCookies("firefox", target, [source]);
		expect(result.merged).toBe(0);
		expect(result.errors).toHaveLength(1);
	});

	it("moves Chrome/Edge cookies only between profiles encrypted with the same key", () => {
		const root = tempDir();
		const chromium = (dir: string, key: string | undefined, value: string, lastUpdate: number) => {
			mkdirSync(join(dir, "Default", "Network"), { recursive: true });
			if (key) writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: key } }));
			const database = new DatabaseSync(join(dir, "Default", "Network", "Cookies"));
			database.exec(`CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT,
				value TEXT, encrypted_value BLOB, path TEXT, last_access_utc INTEGER, last_update_utc INTEGER,
				source_scheme INTEGER, source_port INTEGER)`);
			database.exec(
				"CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, name, path, source_scheme, source_port)",
			);
			database
				.prepare("INSERT INTO cookies VALUES (1, '.reddit.com', '', 'token', ?, x'00', '/', 1, ?, 2, 443)")
				.run(value, lastUpdate);
			database.close();
		};
		const read = (dir: string) => {
			const database = new DatabaseSync(join(dir, "Default", "Network", "Cookies"), { readOnly: true });
			try {
				return (database.prepare("SELECT value FROM cookies").get() as { value: string }).value;
			} finally {
				database.close();
			}
		};
		chromium(join(root, "a"), "key-1", "a", 1);
		chromium(join(root, "b"), "key-1", "b", 2);
		chromium(join(root, "c"), "key-2", "c", 3);
		expect(mergeProfileCookies("chrome", join(root, "a"), [join(root, "b"), join(root, "c")])).toMatchObject({
			merged: 1,
			errors: [expect.stringContaining("加密密钥不同")],
		});
		expect(read(join(root, "a"))).toBe("b");
	});
});
