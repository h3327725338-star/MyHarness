import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Shares logins between MyHarness' own profiles of one browser. A second MyHarness process that needs the browser
 * while the first one runs it gets a profile of its own (see LocalBrowser's profile slots); before that profile's
 * browser starts, the cookies of the other profiles are merged into it, so a login or check passed in any of them is
 * reused. Cookies are kept per site exactly as the browser stores them (host, path, name and partition); for the
 * same cookie the copy that was used or updated last wins. A cookie deleted in one profile (a logout) is not deleted
 * in the others.
 *
 * Only the profile that is about to start is written; the others are read through read-only snapshots, so they may
 * be in use by a running browser. Never touches the user's daily profiles.
 */

interface CookieStore {
	/** The SQLite cookie database below the profile folder. */
	file: string;
	table: string;
	/** Column that grows when a cookie is used or updated; decides which copy of the same cookie wins. */
	freshness: string[];
}

const STORES: Record<"firefox" | "chromium", CookieStore> = {
	firefox: { file: "cookies.sqlite", table: "moz_cookies", freshness: ["lastAccessed", "creationTime"] },
	chromium: {
		file: join("Default", "Network", "Cookies"),
		table: "cookies",
		freshness: ["last_update_utc", "last_access_utc", "creation_utc"],
	},
};

export interface CookieMergeResult {
	/** Profiles whose cookies were merged in. */
	merged: number;
	/** Why a profile could not be merged in; reported, never thrown. */
	errors: string[];
}

function quote(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** Consistent copy of a cookie database that a running browser may be writing. */
function snapshot(file: string, target: string): void {
	const database = new DatabaseSync(file, { readOnly: true });
	try {
		database.exec("PRAGMA busy_timeout = 2000");
		database.exec(`VACUUM INTO '${target.replace(/'/gu, "''")}'`);
	} finally {
		database.close();
	}
}

/** Chrome/Edge encrypt cookie values with the key in `Local State`; cookies only move between profiles with the same key. */
function chromiumKey(profileDir: string): unknown {
	try {
		const parsed = JSON.parse(readFileSync(join(profileDir, "Local State"), "utf8")) as { os_crypt?: unknown };
		return parsed.os_crypt;
	} catch {
		return undefined;
	}
}

function sameKey(a: unknown, b: unknown): boolean {
	return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge the cookies of `sources` (other MyHarness profiles of the same browser) into `targetProfile`, which must not
 * be in use by a running browser.
 */
export function mergeProfileCookies(
	kind: "firefox" | "chrome" | "edge",
	targetProfile: string,
	sources: string[],
): CookieMergeResult {
	const store = STORES[kind === "firefox" ? "firefox" : "chromium"];
	const result: CookieMergeResult = { merged: 0, errors: [] };
	const targetFile = join(targetProfile, store.file);
	for (const sourceProfile of sources) {
		const sourceFile = join(sourceProfile, store.file);
		if (!existsSync(sourceFile)) continue;
		const temp = join(tmpdir(), `myharness-cookies-${randomBytes(8).toString("hex")}.sqlite`);
		try {
			if (kind !== "firefox") {
				const sourceKey = chromiumKey(sourceProfile);
				const targetKey = chromiumKey(targetProfile);
				if (sourceKey === undefined) continue;
				if (targetKey === undefined) {
					// A profile that never started yet takes the key of the cookies it receives.
					mkdirSync(targetProfile, { recursive: true });
					writeFileSync(join(targetProfile, "Local State"), JSON.stringify({ os_crypt: sourceKey }));
				} else if (!sameKey(sourceKey, targetKey)) {
					result.errors.push(`${sourceProfile} 的 Cookie 加密密钥不同，无法共享。`);
					continue;
				}
			}
			snapshot(sourceFile, temp);
			if (!existsSync(targetFile)) {
				mkdirSync(dirname(targetFile), { recursive: true });
				for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${targetFile}${suffix}`, { force: true });
				renameSync(temp, targetFile);
				result.merged += 1;
				continue;
			}
			mergeInto(targetFile, temp, store);
			result.merged += 1;
		} catch (error) {
			result.errors.push(`${sourceProfile}：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			rmSync(temp, { force: true });
		}
	}
	return result;
}

function mergeInto(targetFile: string, sourceFile: string, store: CookieStore): void {
	const database = new DatabaseSync(targetFile);
	try {
		database.exec("PRAGMA busy_timeout = 2000");
		database.exec(`ATTACH DATABASE '${sourceFile.replace(/'/gu, "''")}' AS src`);
		try {
			const columnsOf = (schema: string) =>
				(
					database.prepare("SELECT name, pk FROM pragma_table_info(?, ?)").all(store.table, schema) as Array<{
						name: string;
						pk: number;
					}>
				).filter((column) => column.pk === 0);
			const sourceColumns = new Set(columnsOf("src").map((column) => column.name));
			// Columns both copies have; the row id is left to the target.
			const columns = columnsOf("main")
				.map((column) => column.name)
				.filter((name) => sourceColumns.has(name));
			const unique = (
				database
					.prepare("SELECT name FROM pragma_index_list(?, 'main') WHERE \"unique\" = 1 AND origin != 'pk'")
					.all(store.table) as Array<{ name: string }>
			)[0];
			if (!unique) throw new Error("Cookie 表没有唯一索引，无法按网站合并。");
			const key = (
				database.prepare("SELECT name FROM pragma_index_info(?, 'main')").all(unique.name) as Array<{
					name: string;
				}>
			).map((column) => column.name);
			const freshness = store.freshness.find((name) => columns.includes(name));
			if (!freshness || key.some((name) => !columns.includes(name))) {
				throw new Error("两个配置的 Cookie 表结构不一致，无法合并。");
			}
			const list = columns.map(quote).join(", ");
			const matches = key.map((name) => `m.${quote(name)} IS s.${quote(name)}`).join(" AND ");
			database.exec("BEGIN");
			try {
				database.exec(
					`INSERT OR REPLACE INTO main.${quote(store.table)} (${list})
					 SELECT ${list} FROM src.${quote(store.table)} AS s
					 WHERE NOT EXISTS (
					   SELECT 1 FROM main.${quote(store.table)} AS m
					   WHERE ${matches} AND m.${quote(freshness)} >= s.${quote(freshness)}
					 )`,
				);
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		} finally {
			database.exec("DETACH DATABASE src");
		}
	} finally {
		database.close();
	}
}
