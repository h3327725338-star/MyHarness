import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * "Use My Browser's Cookies": copies the cookies of the browser the user browses with every day into MyHarness' own
 * profile of the same browser, so sites the user is already logged in to (or has already passed a check on) open
 * without asking again. Only cookies are taken — no history, passwords, bookmarks or extensions — and the user's
 * own profile is only read, never written or opened by a browser MyHarness starts.
 *
 * The copy happens once per time the setting is switched on (a marker file records it): MyHarness' profile keeps
 * collecting its own cookies afterwards (checks passed in its window), and a copy on every start would throw those
 * away. Switching the setting off and on again copies afresh.
 *
 * - Firefox keeps cookies in `cookies.sqlite`, unencrypted.
 * - Chrome and Edge keep them in `Network/Cookies`, encrypted with a key in `Local State` that only works for the same
 *   Windows user on the same computer; the key section is copied along. While the daily browser is running it may
 *   hold the file locked; the copy then fails with a clear reason and is tried again on the next start.
 */

export type CookieBrowser = "firefox" | "chrome" | "edge";

export interface DailyCookies {
	/** Folder of the profile the cookies come from, for messages. */
	profile: string;
	/** Files to copy: absolute source → path below MyHarness' profile folder. `optional` ones may be missing. */
	files: Array<{ from: string; to: string; optional?: boolean }>;
	/** Chrome/Edge: the `Local State` whose encryption key belongs to the cookies. */
	localState?: string;
	/** Files below MyHarness' profile folder that belong to its old cookie file and must go with it. */
	stale?: string[];
}

interface Environment {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	home: string;
	exists: (path: string) => boolean;
	read: (path: string) => string;
}

const defaultEnvironment = (): Environment => ({
	env: process.env,
	platform: process.platform,
	home: homedir(),
	exists: existsSync,
	read: (path) => readFileSync(path, "utf8"),
});

/** The profile Firefox starts with by default, from profiles.ini. */
function firefoxProfile(root: string, environment: Environment): string | undefined {
	const ini = join(root, "profiles.ini");
	if (!environment.exists(ini)) return undefined;
	const sections: Array<Record<string, string>> = [];
	for (const line of environment.read(ini).split(/\r?\n/u)) {
		const header = /^\[(.+)\]$/u.exec(line.trim());
		if (header) sections.push({ "": header[1]! });
		else {
			const pair = /^([^=]+)=(.*)$/u.exec(line.trim());
			if (pair && sections.length > 0) sections.at(-1)![pair[1]!.trim()] = pair[2]!.trim();
		}
	}
	const profiles = sections.filter((section) => /^Profile/iu.test(section[""]!) && section.Path);
	// An [Install…] section names the profile this installation really uses; the old Default=1 flag comes second.
	const installed = sections.find((section) => /^Install/iu.test(section[""]!) && section.Default)?.Default;
	const chosen =
		profiles.find((profile) => profile.Path === installed) ??
		profiles.find((profile) => profile.Default === "1") ??
		profiles[0];
	if (!chosen) return undefined;
	const path = chosen.Path!;
	return chosen.IsRelative === "0" || isAbsolute(path) ? path : join(root, path);
}

/** Where the daily browser of this kind keeps its cookies, or undefined when it has no profile on this computer. */
export function findDailyCookies(
	kind: CookieBrowser,
	environment: Partial<Environment> = {},
): DailyCookies | undefined {
	const env: Environment = { ...defaultEnvironment(), ...environment };
	const { platform, home } = env;
	if (kind === "firefox") {
		const root =
			platform === "win32"
				? env.env.APPDATA && join(env.env.APPDATA, "Mozilla", "Firefox")
				: platform === "darwin"
					? join(home, "Library", "Application Support", "Firefox")
					: join(home, ".mozilla", "firefox");
		const profile = root ? firefoxProfile(root, env) : undefined;
		if (!profile || !env.exists(join(profile, "cookies.sqlite"))) return undefined;
		return {
			profile,
			files: [
				{ from: join(profile, "cookies.sqlite"), to: "cookies.sqlite" },
				// Cookies of the running session that are not merged into the main file yet.
				{ from: join(profile, "cookies.sqlite-wal"), to: "cookies.sqlite-wal", optional: true },
			],
			stale: ["cookies.sqlite-shm"],
		};
	}
	const vendor = kind === "chrome" ? ["Google", "Chrome"] : ["Microsoft", "Edge"];
	const root =
		platform === "win32"
			? env.env.LOCALAPPDATA && join(env.env.LOCALAPPDATA, ...vendor, "User Data")
			: platform === "darwin"
				? join(home, "Library", "Application Support", ...(kind === "chrome" ? vendor : ["Microsoft Edge"]))
				: join(home, ".config", kind === "chrome" ? "google-chrome" : "microsoft-edge");
	if (!root) return undefined;
	const localState = join(root, "Local State");
	if (!env.exists(localState)) return undefined;
	let lastUsed = "Default";
	try {
		const parsed = JSON.parse(env.read(localState)) as { profile?: { last_used?: unknown } };
		// A plain folder name only: this text comes from a file and becomes part of a path.
		if (typeof parsed.profile?.last_used === "string" && /^[\w .-]+$/u.test(parsed.profile.last_used)) {
			lastUsed = parsed.profile.last_used;
		}
	} catch {
		// An unreadable Local State cannot give the key either; the copy reports it.
	}
	const profile = [lastUsed, "Default"]
		.map((name) => join(root, name))
		.find((dir) => env.exists(join(dir, "Network", "Cookies")));
	if (!profile) return undefined;
	return {
		profile,
		localState,
		files: [
			{ from: join(profile, "Network", "Cookies"), to: join("Default", "Network", "Cookies") },
			{
				from: join(profile, "Network", "Cookies-journal"),
				to: join("Default", "Network", "Cookies-journal"),
				optional: true,
			},
		],
	};
}

export interface CookieImportRecord {
	ok: boolean;
	at: number;
	/** The daily profile the cookies came from. */
	source?: string;
	/** Why nothing was copied. */
	error?: string;
}

const MARKER = "cookies-imported.json";

function readRecord(rootDir: string): CookieImportRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(rootDir, MARKER), "utf8")) as CookieImportRecord;
	} catch {
		return undefined;
	}
}

/** The setting is off: the next time it is switched on, the cookies are copied again. */
export function forgetCookieImport(rootDir: string): void {
	rmSync(join(rootDir, MARKER), { force: true });
}

/**
 * Copy the daily browser's cookies (`source`, from findDailyCookies; undefined when there is no daily profile) into
 * MyHarness' profile, unless that was already done since the setting was switched on. Must run while MyHarness' browser is not running. Returns what happened; a failure is reported, not
 * thrown, and leaves the profile as it was.
 */
export function importDailyCookiesOnce(
	label: string,
	rootDir: string,
	profileDir: string,
	source: DailyCookies | undefined,
	now: () => number = Date.now,
): CookieImportRecord {
	const done = readRecord(rootDir);
	if (done?.ok) return done;
	const fail = (error: string): CookieImportRecord => ({ ok: false, at: now(), source: source?.profile, error });
	if (!source) return fail(`没有找到你日常使用的 ${label} 配置，没有可导入的 Cookie。`);
	// Everything is read into ".import" copies first: MyHarness' profile changes only once all of it could be read,
	// so a file the daily browser holds locked leaves the profile exactly as it was.
	const staged: Array<{ temp: string; target: string }> = [];
	const absent: string[] = (source.stale ?? []).map((path) => join(profileDir, path));
	try {
		mkdirSync(profileDir, { recursive: true });
		let localState: string | undefined;
		if (source.localState) {
			// Only the key the cookies are encrypted with; everything else in MyHarness' own Local State stays.
			const daily = JSON.parse(readFileSync(source.localState, "utf8")) as { os_crypt?: unknown };
			if (!daily.os_crypt) return fail(`${label} 的配置里没有 Cookie 加密密钥，无法导入。`);
			let own: Record<string, unknown> = {};
			try {
				own = JSON.parse(readFileSync(join(profileDir, "Local State"), "utf8")) as Record<string, unknown>;
			} catch {
				// No Local State yet: the browser creates the rest on its first start.
			}
			localState = JSON.stringify({ ...own, os_crypt: daily.os_crypt });
		}
		for (const file of source.files) {
			const target = join(profileDir, file.to);
			if (!existsSync(file.from)) {
				if (!file.optional) return fail(`没有找到 ${label} 的 Cookie 文件。`);
				// A leftover of MyHarness' old cookie file would not belong to the new one.
				absent.push(target);
				continue;
			}
			mkdirSync(dirname(target), { recursive: true });
			staged.push({ temp: `${target}.import`, target });
			copyFileSync(file.from, `${target}.import`);
		}
		if (localState !== undefined) writeFileSync(join(profileDir, "Local State"), localState);
		for (const file of staged) renameSync(file.temp, file.target);
		for (const path of absent) rmSync(path, { force: true });
	} catch (error) {
		for (const file of staged) rmSync(file.temp, { force: true });
		const code = (error as NodeJS.ErrnoException).code;
		const record = fail(
			code === "EBUSY" || code === "EPERM" || code === "EACCES"
				? `${label} 正在运行，它的 Cookie 文件被占用，没能导入。关闭 ${label} 后，下次使用浏览器兜底时会再次尝试。`
				: `导入 ${label} 的 Cookie 失败：${error instanceof Error ? error.message : String(error)}`,
		);
		// Not written as done: the next start tries again.
		return record;
	}
	const record: CookieImportRecord = { ok: true, at: now(), source: source.profile };
	mkdirSync(rootDir, { recursive: true });
	writeFileSync(join(rootDir, MARKER), `${JSON.stringify(record)}\n`);
	return record;
}
