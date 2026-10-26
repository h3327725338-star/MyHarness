/**
 * HTML files rendered in a file tab. The tab asks for a preview of one page; the server hands out an unguessable token
 * for the page's folder and serves that folder under `/api/files/site/<token>/…`, so the page's relative images, styles
 * and scripts load as they would from disk.
 *
 * The page runs sandboxed: the tab's iframe and every response here carry `sandbox` without `allow-same-origin`, so it
 * gets an opaque origin and cannot reach the Web UI, its API or its storage. It may load its own folder's files as
 * documents, images, styles, scripts, fonts and media, and https resources (CDN libraries), but it cannot read files
 * with fetch/XHR (refused below and by `connect-src 'none'`), so a page cannot collect its neighbours and send them out.
 *
 * The only thing added to a page is a small selection bridge at the start of its HTML: the Web UI cannot see a selection
 * inside an opaque-origin frame, so the bridge posts the selected words and their position to the Web UI (and nothing
 * else), which offers its "Translate" bubble there. The page's own scripts can post the same messages, so the Web UI
 * (quote-toolbar.js) shows that bubble only inside the page's frame and only right after the user's own input in it.
 * Translating still needs the user's click on the bubble.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

/**
 * Runs inside the previewed page. It reports presses, selections (frame coordinates, at most 6000 characters), scrolls
 * and Esc to the Web UI that embeds the page (`location.origin`; `frame-ancestors 'self'` keeps any other parent out).
 */
const SELECTION_BRIDGE = `(() => {
	try {
		if (window.parent === window) return;
		const target = location.origin;
		const post = (message) => {
			try { window.parent.postMessage({ type: "myharness:selection", ...message }, target); } catch {}
		};
		const editable = (node) => {
			const el = node && (node.nodeType === 1 ? node : node.parentElement);
			return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
		};
		let down = false;
		const report = (x, y) => {
			const sel = getSelection();
			const text = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString().trim() : "";
			if (!text || editable(sel.anchorNode) || editable(sel.focusNode)) return post({ kind: "clear" });
			if (x === undefined) {
				const range = sel.getRangeAt(0);
				const rects = range.getClientRects();
				const end = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
				x = end.right;
				y = end.bottom;
			}
			post({ kind: "select", text: text.slice(0, 6000), x, y });
		};
		addEventListener("mousedown", (e) => { down = true; post({ kind: "press", button: e.button }); }, true);
		addEventListener("mouseup", (e) => { down = false; setTimeout(() => report(e.clientX, e.clientY), 10); }, true);
		addEventListener("keyup", (e) => { if (e.key === "Shift" || e.shiftKey || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a")) report(); }, true);
		addEventListener("keydown", (e) => { if (e.key === "Escape") post({ kind: "escape" }); }, true);
		addEventListener("scroll", () => post({ kind: "scroll" }), { capture: true, passive: true });
		document.addEventListener("selectionchange", () => {
			if (down) return;
			const sel = getSelection();
			if (!sel || sel.isCollapsed) post({ kind: "clear" });
		});
	} catch {}
})();`;

/** Pages larger than this are served as they are (no bridge), so a huge file is never held in memory. */
const BRIDGE_MAX_BYTES = 32 * 1024 * 1024;

/** Whitespace as the HTML tokenizer knows it (tab, LF, FF, CR, space). */
const isSpace = (code: number) => code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0c || code === 0x0d;

/** The end of a comment's text: `-->`, or `--!>`, which also closes one. One search finds whichever comes first. */
const COMMENT_CLOSE = /--!?>/gu;

/**
 * Where the comment at `at` ends, as the browser's tokenizer reads it: `<!-- … -->`, or a "bogus comment" (`<?…>`, such as
 * an xml prolog, or `<!…>`) that ends at the first `>`. -1 when there is none at `at` or it never ends.
 */
function commentEnd(text: string, at: number): number {
	if (text.startsWith("<!--", at)) {
		// `<!-->` and `<!--->` are complete (empty) comments.
		if (text.startsWith(">", at + 4)) return at + 5;
		if (text.startsWith("->", at + 4)) return at + 6;
		COMMENT_CLOSE.lastIndex = at + 4;
		const close = COMMENT_CLOSE.exec(text);
		return close ? close.index + close[0].length : -1;
	}
	if (!text.startsWith("<?", at) && !text.startsWith("<!", at)) return -1;
	const close = text.indexOf(">", at + 2);
	return close < 0 ? -1 : close + 1;
}

/**
 * Where the start tag `<name …>` at `at` ends (just past its `>`), or -1 when another tag (`<header>` is not `<head>`) or
 * none is there, or it never closes. Attribute values are stepped over as values, so a `>` inside quotes is no end.
 */
function startTagEnd(text: string, at: number, name: string): number {
	if (text[at] !== "<" || text.slice(at + 1, at + 1 + name.length).toLowerCase() !== name) return -1;
	let i = at + 1 + name.length;
	const nameEnd = (code: number) => isSpace(code) || code === 0x2f || code === 0x3e; // whitespace, "/", ">"
	if (!nameEnd(text.charCodeAt(i))) return -1;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === 0x3e) return i + 1;
		if (nameEnd(code)) {
			i += 1;
			continue;
		}
		// An attribute: its name (the first character may be anything, even "="), then maybe "=" and a value.
		i += 1;
		while (i < text.length && !nameEnd(text.charCodeAt(i)) && text.charCodeAt(i) !== 0x3d) i += 1;
		while (i < text.length && isSpace(text.charCodeAt(i))) i += 1;
		if (text.charCodeAt(i) !== 0x3d) continue;
		i += 1;
		while (i < text.length && isSpace(text.charCodeAt(i))) i += 1;
		const quote = text[i];
		if (quote === '"' || quote === "'") {
			const close = text.indexOf(quote, i + 1);
			if (close < 0) return -1;
			i = close + 1;
		} else {
			while (i < text.length && !isSpace(text.charCodeAt(i)) && text.charCodeAt(i) !== 0x3e) i += 1;
		}
	}
	return -1;
}

/**
 * How much of a page is read for the bridge's place: its first tokens are near the top of any real page, and a crafted
 * one cannot make the server read (and so block on) more than this.
 */
const PROLOGUE_MAX_UNITS = 1024 * 1024;

/**
 * Where the bridge goes in `text` (from `start`, past a byte-order mark), or -1 to leave the page without it. Only the
 * document's first tokens are read: whitespace, comments, `<?…>` and one doctype; then an `<html …>` tag if it comes
 * next; then whitespace and comments; then a `<head …>` tag if it comes next. The bridge goes where that reading stops.
 * So it is never inside a script, a comment or an attribute (all of those come later, or stop the reading before them),
 * and never before the doctype, which would put the page into quirks mode. Every step moves forward: linear time.
 * `complete` is false when `text` is only the page's first part; if the reading runs out there before any doctype, a
 * doctype may still follow, so the answer is -1.
 */
function bridgeOffset(text: string, start: number, complete: boolean): number {
	let at = start;
	let doctypeSeen = false;
	const skip = (doctype: boolean) => {
		for (;;) {
			while (at < text.length && isSpace(text.charCodeAt(at))) at += 1;
			let end: number;
			if (text.slice(at, at + 9).toLowerCase() === "<!doctype") {
				if (!doctype || doctypeSeen) return;
				doctypeSeen = true;
				// A doctype ends at its first ">", even inside a quoted identifier.
				end = text.indexOf(">", at);
				end = end < 0 ? -1 : end + 1;
			} else end = commentEnd(text, at);
			if (end < 0) return;
			at = end;
		}
	};
	skip(true);
	// Stopped at the cut, or at a comment or doctype that goes past it.
	if (!complete && !doctypeSeen && (at + 9 > text.length || text.startsWith("<!", at) || text.startsWith("<?", at)))
		return -1;
	const html = startTagEnd(text, at, "html");
	if (html >= 0) {
		at = html;
		skip(false);
	}
	const head = startTagEnd(text, at, "head");
	return head >= 0 ? head : at;
}

/**
 * The page's bytes with the bridge script inserted as early as possible (see bridgeOffset: after `<head …>` on a normal
 * page). An ASCII-compatible page (UTF-8, GBK, …) is read as latin1, so its bytes pass through untouched; a UTF-8
 * byte-order mark stays first. A page that starts with a UTF-16 byte-order mark (FF FE or FE FF) is decoded by the
 * browser as UTF-16 whatever the header says, so it is read in that byte order and the bridge goes in encoded the same
 * way, after the mark. A page whose first tokens run past what is read before a doctype is served as it is.
 */
export function withSelectionBridge(page: Buffer): Buffer {
	const script = `<script>${SELECTION_BRIDGE}</script>`;
	const order = page[0] === 0xff && page[1] === 0xfe ? "le" : page[0] === 0xfe && page[1] === 0xff ? "be" : "";
	if (order) {
		// Whole code units only (a trailing odd byte is none), and only the page's first part.
		const end = Math.min(page.length - ((page.length - 2) % 2), 2 + 2 * PROLOGUE_MAX_UNITS);
		const units = Buffer.from(page.subarray(2, end));
		if (order === "be") units.swap16();
		const offset = bridgeOffset(units.toString("utf16le"), 0, end + 1 >= page.length);
		if (offset < 0) return page;
		const bytes = Buffer.from(script, "utf16le");
		if (order === "be") bytes.swap16();
		const index = 2 + 2 * offset;
		return Buffer.concat([page.subarray(0, index), bytes, page.subarray(index)]);
	}
	const text = page.toString("latin1", 0, PROLOGUE_MAX_UNITS);
	// "ï»¿" is the UTF-8 byte-order mark read as latin1.
	const offset = bridgeOffset(text, text.startsWith("ï»¿") ? 3 : 0, text.length === page.length);
	if (offset < 0) return page;
	return Buffer.concat([page.subarray(0, offset), Buffer.from(script, "utf8"), page.subarray(offset)]);
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

	server.route("GET", `${SITE_PREFIX}:token/*`, async ({ params, req, res }) => {
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
		if (!file.startsWith(root + path.sep)) throw new HttpError(404, "Not found");
		const stat = statSync(file);
		if (!stat.isFile()) throw new HttpError(404, "Not found");
		const headers = {
			"content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
			"content-security-policy": CSP,
		};
		if (isHtmlFile(file) && stat.size <= BRIDGE_MAX_BYTES) {
			const page = withSelectionBridge(await readFile(file));
			res.writeHead(200, { ...headers, "content-length": String(page.length) });
			res.end(page);
			return;
		}
		res.writeHead(200, headers);
		createReadStream(file)
			.on("error", () => res.destroy())
			.pipe(res);
	});
}
