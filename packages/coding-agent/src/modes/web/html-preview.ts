/**
 * HTML files rendered in a file tab. The tab asks for a preview of one page; the server hands out an unguessable token
 * for the page's folder and serves that folder under `/api/files/site/<token>/…`, so the page's relative images, styles
 * and scripts load as they would from disk.
 *
 * The page runs sandboxed: the tab's iframe and every response here carry `sandbox` without `allow-same-origin`, so it
 * gets an opaque origin and cannot reach the Web UI, its API or its storage. It may load its own folder's files as
 * documents, images, styles, scripts, fonts and media, and https resources (CDN libraries), but it cannot read files
 * with fetch/XHR (refused below and by `connect-src 'none'`), so a page cannot collect its neighbours and send them out.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { HttpError, type WebHttpServer } from "./http-server.ts";

export const SITE_PREFIX = "/api/files/site/";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".vtt": "text/vtt; charset=utf-8",
	".wasm": "application/wasm",
};

/** Destinations a page may load its folder's files as; plain fetch/XHR ("empty") is not one of them. */
const LOADABLE = new Set([
	"document",
	"iframe",
	"frame",
	"image",
	"style",
	"script",
	"font",
	"audio",
	"video",
	"track",
	"manifest",
	"worker",
]);

const CSP = [
	"sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
	"default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'",
	"connect-src 'none'",
	"frame-ancestors 'self'",
].join("; ");

export function isHtmlFile(file: string): boolean {
	return /\.html?$/iu.test(file);
}

export function registerHtmlPreview(server: WebHttpServer, resolve: (input: unknown) => string): void {
	const sites = new Map<string, string>();

	server.route("POST", "/api/files/site", ({ body }) => {
		const absolute = resolve(((body ?? {}) as { path?: unknown }).path);
		if (!isHtmlFile(absolute)) throw new HttpError(400, "Not an HTML file");
		const root = realpathSync(path.dirname(absolute));
		let token = [...sites].find(([, folder]) => folder === root)?.[0];
		if (!token) {
			token = randomBytes(18).toString("base64url");
			sites.set(token, root);
		}
		return { url: `${SITE_PREFIX}${token}/${encodeURIComponent(path.basename(absolute))}` };
	});

	server.route("GET", `${SITE_PREFIX}:token/*`, ({ params, req, res }) => {
		const root = sites.get(params.token ?? "");
		if (!root) throw new HttpError(404, "Unknown preview");
		const site = String(req.headers["sec-fetch-site"] ?? "");
		const dest = String(req.headers["sec-fetch-dest"] ?? "");
		if (site && site !== "same-origin" && site !== "none" && !LOADABLE.has(dest))
			throw new HttpError(403, "The page cannot read files");
		const relative = params.rest ?? "";
		if (relative.split(/[\\/]/u).some((part) => part.startsWith(".") && part !== "." && part !== ".."))
			throw new HttpError(404, "Not found");
		let file: string;
		try {
			file = realpathSync(path.resolve(root, relative));
		} catch {
			throw new HttpError(404, "Not found");
		}
		if (!file.startsWith(root + path.sep) || !statSync(file).isFile()) throw new HttpError(404, "Not found");
		res.writeHead(200, {
			"content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
			"content-security-policy": CSP,
		});
		createReadStream(file)
			.on("error", () => res.destroy())
			.pipe(res);
	});
}
