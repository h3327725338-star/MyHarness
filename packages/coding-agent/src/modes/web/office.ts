/**
 * Office documents in the workspace.
 *
 * Editing: an ONLYOFFICE Docs server the user runs (Settings → Tools → Office editing server; not bundled with
 * MyHarness). A file tab asks for an editing session; the session gets a random token, and the document server reads
 * the file from `/api/office/file/<token>` and reports saves to `/api/office/callback/<token>` (the only POST route
 * that is reachable without the Web UI header, because a document server cannot send it; the unguessable token and,
 * when a secret is set, the server's JWT are what admit it). A save is written only when the file on disk is still the
 * version the session started from; otherwise the edited copy is stored next to it, so nothing anyone wrote is lost.
 *
 * Preview without a server: Microsoft Office (Word, Excel, PowerPoint, through COM, never shown) or LibreOffice
 * (headless) converts the file to PDF once per version, and the workspace shows it in its PDF viewer, read-only.
 */
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError, type WebHttpServer } from "./http-server.ts";

/** Formats the document server edits and saves back in the same format. */
const EDITABLE = new Set([".docx", ".xlsx", ".pptx", ".docm", ".xlsm", ".pptm", ".dotx", ".ppsx"]);
const DOCUMENT_TYPE: Record<string, "word" | "cell" | "slide"> = {
	".doc": "word",
	".docx": "word",
	".docm": "word",
	".dot": "word",
	".dotx": "word",
	".odt": "word",
	".rtf": "word",
	".xls": "cell",
	".xlsx": "cell",
	".xlsm": "cell",
	".ods": "cell",
	".ppt": "slide",
	".pptx": "slide",
	".pptm": "slide",
	".pps": "slide",
	".ppsx": "slide",
	".odp": "slide",
};

export interface OfficeSettings {
	url?: string;
	secret?: string;
}

interface OfficeSession {
	token: string;
	absolute: string;
	key: string;
	size: number;
	mtime: number;
	edit: boolean;
	created: number;
	lastSeen: number;
}

const sessions = new Map<string, OfficeSession>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function base64url(value: Buffer | string): string {
	return Buffer.from(value).toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

/** HS256 JWT, as ONLYOFFICE expects for the editor config and its callbacks. */
export function signJwt(payload: unknown, secret: string): string {
	const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64url(JSON.stringify(payload));
	return `${head}.${body}.${base64url(createHmac("sha256", secret).update(`${head}.${body}`).digest())}`;
}

export function verifyJwt(token: string, secret: string): unknown {
	const parts = token.split(".");
	if (parts.length !== 3) throw new HttpError(403, "Invalid Office server token");
	const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
	const given = Buffer.from(parts[2]!.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
	if (given.length !== expected.length || !timingSafeEqual(given, expected))
		throw new HttpError(403, "Invalid Office server token");
	try {
		return JSON.parse(Buffer.from(parts[1]!.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8"));
	} catch {
		throw new HttpError(403, "Invalid Office server token");
	}
}

/** Is the document server answering? `GET <url>/healthcheck` returns `true` on ONLYOFFICE Docs. */
async function serverReachable(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/healthcheck`, { signal: AbortSignal.timeout(2500) });
		return response.ok && (await response.text()).trim() === "true";
	} catch {
		return false;
	}
}

let healthCache: { url: string; at: number; ok: boolean } | null = null;
async function cachedReachable(url: string): Promise<boolean> {
	if (healthCache && healthCache.url === url && Date.now() - healthCache.at < 10_000) return healthCache.ok;
	const ok = await serverReachable(url);
	healthCache = { url, at: Date.now(), ok };
	return ok;
}

// ---- Local preview ---------------------------------------------------------------------------------------------

type PreviewEngine = "msoffice" | "libreoffice";

function findLibreOffice(): string | null {
	const candidates =
		process.platform === "win32"
			? [
					path.join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice", "program", "soffice.exe"),
					path.join(
						process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
						"LibreOffice",
						"program",
						"soffice.exe",
					),
				]
			: ["/usr/bin/soffice", "/usr/local/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function msOfficeApp(ext: string): "Word" | "Excel" | "PowerPoint" | null {
	const type = DOCUMENT_TYPE[ext];
	return type === "word" ? "Word" : type === "cell" ? "Excel" : type === "slide" ? "PowerPoint" : null;
}

let msOfficeCache: Promise<Set<string>> | null = null;
/** Which Office applications are registered for COM automation on this Windows machine. */
function msOfficeApps(): Promise<Set<string>> {
	if (process.platform !== "win32") return Promise.resolve(new Set());
	if (!msOfficeCache) {
		msOfficeCache = new Promise((resolve) => {
			const script =
				"$r=@();foreach($n in 'Word','Excel','PowerPoint'){if(Test-Path \"Registry::HKEY_CLASSES_ROOT\\$n.Application\\CLSID\"){$r+=$n}};$r -join ','";
			execFile(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", script],
				{ windowsHide: true, timeout: 15_000 },
				(error, stdout) => {
					resolve(new Set(error ? [] : String(stdout).trim().split(",").filter(Boolean)));
				},
			);
		});
	}
	return msOfficeCache;
}

async function previewEngine(ext: string): Promise<PreviewEngine | null> {
	const app = msOfficeApp(ext);
	if (app && (await msOfficeApps()).has(app)) return "msoffice";
	if (findLibreOffice()) return "libreoffice";
	return null;
}

function psQuote(value: string): string {
	return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * Convert with the installed Office application, invisible and without prompts. `input` is a private copy of the file:
 * PowerPoint (and sometimes Word or Excel) runs as one shared instance, so the conversion may attach to the copy of
 * Office the user is working in. It opens and closes only its own document and quits the application only when nothing
 * else is open in it, never touching the user's windows or unsaved work.
 */
function convertWithMsOffice(app: "Word" | "Excel" | "PowerPoint", input: string, output: string): Promise<void> {
	const scripts = {
		Word: `$a=New-Object -ComObject Word.Application;$a.Visible=$false;$a.DisplayAlerts=0;try{$d=$a.Documents.Open(${psQuote(input)},$false,$true,$false);$d.ExportAsFixedFormat(${psQuote(output)},17);$d.Close(0)}finally{if($a.Documents.Count -eq 0){$a.Quit()}}`,
		Excel: `$a=New-Object -ComObject Excel.Application;$a.Visible=$false;$a.DisplayAlerts=$false;$a.AskToUpdateLinks=$false;try{$w=$a.Workbooks.Open(${psQuote(input)},0,$true);$w.ExportAsFixedFormat(0,${psQuote(output)});$w.Close($false)}finally{if($a.Workbooks.Count -eq 0){$a.Quit()}}`,
		PowerPoint: `$a=New-Object -ComObject PowerPoint.Application;try{$p=$a.Presentations.Open(${psQuote(input)},-1,0,0);$p.SaveAs(${psQuote(output)},32);$p.Close()}finally{if($a.Presentations.Count -eq 0){$a.Quit()}}`,
	};
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", scripts[app]],
			{ windowsHide: true, timeout: 120_000 },
			(error, _stdout, stderr) => {
				if (error)
					reject(
						new Error(
							String(stderr || error.message)
								.trim()
								.split(/\r?\n/u)[0] || "Conversion failed",
						),
					);
				else resolve();
			},
		);
	});
}

function convertWithLibreOffice(input: string, outDir: string): Promise<void> {
	const soffice = findLibreOffice();
	if (!soffice) return Promise.reject(new Error("LibreOffice is not installed"));
	return new Promise((resolve, reject) => {
		execFile(
			soffice,
			[
				// Its own profile, so the conversion never joins (or waits on) a LibreOffice the user has open.
				`-env:UserInstallation=${pathToFileURL(path.join(previewDir(), "lo-profile")).href}`,
				"--headless",
				"--norestore",
				"--convert-to",
				"pdf",
				"--outdir",
				outDir,
				input,
			],
			{ windowsHide: true, timeout: 120_000 },
			(error) => (error ? reject(error) : resolve()),
		);
	});
}

const previewDir = () => path.join(tmpdir(), "myharness-office-preview");
const converting = new Map<string, Promise<string>>();

/** A PDF of this version of the file (path + size + mtime), converted once and reused. */
async function previewPdf(absolute: string): Promise<string> {
	const info = await stat(absolute).catch(() => {
		throw new HttpError(404, "File not found");
	});
	const ext = path.extname(absolute).toLowerCase();
	const engine = await previewEngine(ext);
	if (!engine) throw new HttpError(501, "No local Office application can convert this file.");
	const id = createHash("sha256").update(`${absolute}\0${info.size}\0${info.mtimeMs}`).digest("hex").slice(0, 32);
	const target = path.join(previewDir(), `${id}.pdf`);
	if (existsSync(target)) return target;
	const running = converting.get(id);
	if (running) return running;
	const job = (async () => {
		await mkdir(previewDir(), { recursive: true });
		const work = path.join(previewDir(), `${id}-work`);
		await mkdir(work, { recursive: true });
		try {
			// Convert a copy: the original may be open (and locked) in Office while the user edits it.
			const source = path.join(work, `source${ext}`);
			await copyFile(absolute, source);
			if (engine === "msoffice") await convertWithMsOffice(msOfficeApp(ext)!, source, path.join(work, "out.pdf"));
			else await convertWithLibreOffice(source, work);
			const produced = (await readdir(work)).find((name) => name.toLowerCase().endsWith(".pdf"));
			if (!produced) throw new Error("The converter produced no PDF");
			await rename(path.join(work, produced), target);
			return target;
		} catch (error) {
			throw new HttpError(
				500,
				`Could not prepare the preview: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			await rm(work, { recursive: true, force: true }).catch(() => undefined);
		}
	})();
	converting.set(id, job);
	try {
		return await job;
	} finally {
		converting.delete(id);
	}
}

// ---- Editing sessions -------------------------------------------------------------------------------------------

function sessionFor(token: string): OfficeSession {
	const session = sessions.get(token);
	if (!session || Date.now() - session.lastSeen > SESSION_TTL_MS) {
		sessions.delete(token);
		throw new HttpError(404, "Unknown Office session");
	}
	session.lastSeen = Date.now();
	return session;
}

function documentKey(absolute: string, size: number, mtime: number): string {
	// The document server caches by key: a new version of the file must get a new key, the same version the same one.
	return createHash("sha256")
		.update(`${absolute}\0${size}\0${Math.round(mtime)}`)
		.digest("hex")
		.slice(0, 40);
}

/** The origin the document server reaches MyHarness at: the address the browser used (the server runs on this machine). */
function selfOrigin(req: IncomingMessage): string {
	return `http://${req.headers.host ?? "127.0.0.1"}`;
}

function editorPage(config: Record<string, unknown>, serverUrl: string, nonce: string): string {
	const json = JSON.stringify(config).replace(/</gu, "\\u003c");
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#editor{height:100%}#fail{display:none;font:14px system-ui;color:#999;padding:24px}</style>
<script nonce="${nonce}" src="${serverUrl}/web-apps/apps/api/documents/api.js"></script></head>
<body><div id="editor"></div><div id="fail"></div>
<script nonce="${nonce}">
var config=${json};
function report(kind,detail){try{parent.postMessage({source:"myharness-office",kind:kind,detail:detail},location.origin)}catch(e){}}
config.events={onAppReady:function(){report("ready")},onDocumentStateChange:function(e){report("dirty",!!e.data)},onError:function(e){report("error",e&&e.data)},onRequestClose:function(){report("close")}};
if(typeof DocsAPI==="undefined"){var f=document.getElementById("fail");f.style.display="block";f.textContent="The Office editing server did not load.";report("error","unavailable")}
else{window.docEditor=new DocsAPI.DocEditor("editor",config)}
</script></body></html>`;
}

export function registerOfficeRoutes(
	server: WebHttpServer,
	options: {
		settings: () => OfficeSettings;
		resolve: (input: string) => string;
		onSaved?: (absolute: string) => void;
	},
): void {
	server.route("GET", "/api/office/status", async ({ url }) => {
		const { url: serverUrl, secret } = options.settings();
		const ext = path.extname(url.searchParams.get("path") ?? "").toLowerCase();
		const engine = ext ? await previewEngine(ext) : null;
		return {
			server: serverUrl ? { url: serverUrl, reachable: await cachedReachable(serverUrl), jwt: !!secret } : null,
			preview: engine,
			editable: EDITABLE.has(ext),
		};
	});

	server.route("POST", "/api/office/session", async ({ body }) => {
		const payload = (body ?? {}) as { path?: unknown; theme?: unknown; lang?: unknown };
		if (typeof payload.path !== "string" || !payload.path) throw new HttpError(400, "Missing path");
		if (!options.settings().url) throw new HttpError(409, "No Office editing server is set up.");
		const absolute = options.resolve(payload.path);
		const ext = path.extname(absolute).toLowerCase();
		const documentType = DOCUMENT_TYPE[ext];
		if (!documentType) throw new HttpError(400, "Not an Office document");
		const info = await stat(absolute).catch(() => {
			throw new HttpError(404, "File not found");
		});
		if (!info.isFile()) throw new HttpError(400, "Not a file");
		for (const [token, session] of sessions)
			if (Date.now() - session.lastSeen > SESSION_TTL_MS) sessions.delete(token);
		const token = base64url(randomBytes(24));
		const edit = EDITABLE.has(ext);
		sessions.set(token, {
			token,
			absolute,
			key: documentKey(absolute, info.size, info.mtimeMs),
			size: info.size,
			mtime: info.mtimeMs,
			edit,
			created: Date.now(),
			lastSeen: Date.now(),
		});
		return {
			token,
			editorUrl: `/api/office/editor?token=${token}&theme=${payload.theme === "light" ? "light" : "dark"}&lang=${String(payload.lang ?? "").startsWith("zh") ? "zh-CN" : "en"}`,
			edit,
		};
	});

	server.route("GET", "/api/office/editor", ({ url, req, res }) => {
		const session = sessionFor(url.searchParams.get("token") ?? "");
		const { url: serverUrl, secret } = options.settings();
		if (!serverUrl) throw new HttpError(409, "No Office editing server is set up.");
		const origin = selfOrigin(req);
		const ext = path.extname(session.absolute).toLowerCase();
		const lang = url.searchParams.get("lang") === "zh-CN" ? "zh-CN" : "en";
		const config: Record<string, unknown> = {
			type: "desktop",
			width: "100%",
			height: "100%",
			documentType: DOCUMENT_TYPE[ext],
			document: {
				fileType: ext.slice(1),
				key: session.key,
				title: path.basename(session.absolute),
				url: `${origin}/api/office/file/${session.token}`,
				permissions: {
					edit: session.edit,
					download: true,
					print: true,
					review: session.edit,
					comment: session.edit,
				},
			},
			editorConfig: {
				mode: session.edit ? "edit" : "view",
				lang,
				callbackUrl: `${origin}/api/office/callback/${session.token}`,
				user: { id: "myharness-user", name: lang === "zh-CN" ? "我" : "You" },
				customization: {
					autosave: true,
					forcesave: true,
					compactHeader: true,
					compactToolbar: false,
					toolbarHideFileName: true,
					hideRightMenu: false,
					uiTheme: url.searchParams.get("theme") === "light" ? "theme-light" : "theme-dark",
					goback: false,
					about: false,
					feedback: false,
				},
			},
		};
		if (secret) config.token = signJwt(config, secret);
		const nonce = base64url(randomBytes(16));
		const csp = [
			"default-src 'self'",
			`script-src 'nonce-${nonce}' ${serverUrl}`,
			`frame-src ${serverUrl}`,
			`connect-src 'self' ${serverUrl}`,
			`style-src 'self' 'unsafe-inline' ${serverUrl}`,
			`img-src 'self' data: blob: ${serverUrl}`,
			`font-src 'self' data: ${serverUrl}`,
			"frame-ancestors 'self'",
		].join("; ");
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": csp,
			"x-content-type-options": "nosniff",
		});
		res.end(editorPage(config, serverUrl, nonce));
	});

	// Has the file on disk moved past the version this session edits (the Agent or another program wrote it)?
	server.route("GET", "/api/office/session-state", async ({ url }) => {
		const session = sessionFor(url.searchParams.get("token") ?? "");
		const current = await stat(session.absolute).catch(() => null);
		return {
			changedOnDisk: !current || current.size !== session.size || Math.abs(current.mtimeMs - session.mtime) >= 1,
		};
	});

	// The document server downloads the file it edits. GET routes need no Web UI header; the token is the key.
	server.route("GET", "/api/office/file/:token", ({ params, res }) => {
		const session = sessionFor(params.token ?? "");
		res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
		createReadStream(session.absolute)
			.on("error", () => res.destroy())
			.pipe(res);
	});

	server.route("POST", "/api/office/callback/:token", async ({ params, body, req }) => {
		const session = sessionFor(params.token ?? "");
		let data = (body ?? {}) as { status?: number; url?: string; key?: string; token?: string; filetype?: string };
		const { secret } = options.settings();
		if (secret) {
			const header = String(req.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
			if (typeof data.token === "string" && data.token) data = verifyJwt(data.token, secret) as typeof data;
			else if (header) data = ((verifyJwt(header, secret) as { payload?: unknown }).payload ?? {}) as typeof data;
			else throw new HttpError(403, "Missing Office server token");
		}
		if ((data.status === 2 || data.status === 6) && session.edit && typeof data.url === "string") {
			const ext = path.extname(session.absolute).toLowerCase();
			if (data.filetype && `.${String(data.filetype).toLowerCase()}` !== ext)
				throw new HttpError(400, "The Office server returned another format");
			const response = await fetch(data.url, { signal: AbortSignal.timeout(120_000) });
			if (!response.ok) throw new HttpError(502, "Could not download the saved document");
			const bytes = Buffer.from(await response.arrayBuffer());
			const current = await stat(session.absolute).catch(() => null);
			const unchanged = current && current.size === session.size && Math.abs(current.mtimeMs - session.mtime) < 1;
			// The file changed on disk since the session started (the Agent or another program wrote it): keep both.
			const target = unchanged || !current ? session.absolute : conflictName(session.absolute);
			const temporary = `${target}.myharness-${process.pid}-${Date.now()}.tmp`;
			await writeFile(temporary, bytes);
			await rename(temporary, target);
			if (target === session.absolute) {
				const written = await stat(session.absolute);
				session.size = written.size;
				session.mtime = written.mtimeMs;
			}
			options.onSaved?.(target);
		}
		return { error: 0 };
	});
}

function conflictName(absolute: string): string {
	const ext = path.extname(absolute);
	const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
	return `${absolute.slice(0, -ext.length)} (edited ${stamp})${ext}`;
}

export function registerOfficePreview(server: WebHttpServer, resolve: (input: string) => string): void {
	server.route("GET", "/api/office/preview", async ({ url, res }) => {
		const absolute = resolve(url.searchParams.get("path") ?? "");
		const pdf = await previewPdf(absolute);
		// prepare=1: convert now and answer in JSON, so the tab can show progress and a readable error first.
		if (url.searchParams.get("prepare") === "1") return { ready: true };
		const info = await stat(pdf);
		res.writeHead(200, {
			"content-type": "application/pdf",
			"content-length": info.size,
			"cache-control": "no-cache",
			"accept-ranges": "none",
		});
		createReadStream(pdf)
			.on("error", () => res.destroy())
			.pipe(res);
	});
}
