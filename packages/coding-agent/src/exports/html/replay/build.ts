/**
 * Standalone HTML replay builder.
 *
 * Assembles the complete single-file HTML replay:
 * - HTML skeleton
 * - Frontend CSS inlined from web/
 * - Classic vendor scripts (marked.min.js, highlight.min.js)
 * - Single <script type="importmap"> mapping bare module names to data: URLs
 * - Embedded session data (<script id="myharness-export-data">) with every '<' escaped as \u003C
 * - Replay boot script shim
 * - Bare module entry: import("main.js")
 *
 * Runs self-check for zero external references before returning.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWebUiDir } from "../../../config.ts";
import type { SessionManager } from "../../../session/manager/index.ts";
import { type BundleFrontendResult, bundleFrontend } from "./bundle-frontend.ts";
import { EXPORT_MAX_JSONL_BYTES, ReplayExportTooLargeError } from "./limits.ts";
import { type ProjectedSession, projectSession } from "./project.ts";
import { type BuildRoutesResult, buildRoutes } from "./routes.ts";
import { scanImports } from "./scan-imports.ts";
import { bootScript, DATA_ELEMENT_ID, safeJsonForScript } from "./shell.ts";

export { EXPORT_MAX_JSONL_BYTES, ReplayExportTooLargeError } from "./limits.ts";
// safeJsonForScript lives next to the boot script it also protects (shell.ts is
// the dependency-free module; build.ts must not be imported from shell.ts).
// Re-exported here so existing import sites keep working.
export { safeJsonForScript } from "./shell.ts";

export interface BuildReplayHtmlOptions {
	sessionFile?: string;
	sessionManager?: SessionManager;
	prefs?: Record<string, unknown>;
	slotInfo?: Record<string, unknown>;
	detailsLimit?: number | null;
	offlineGet?: "empty" | "fail";
	webDir?: string;
	name?: string;
	title?: string;
	maxJsonlBytes?: number;
}

export function inlineJs(text: string): string {
	return text.replace(/<\/script/gi, "\\u003C/script");
}

export function inlineCss(text: string): string {
	return text.replace(/<\/style/gi, "\\u003C/style");
}

export function escapeHtml(s: string): string {
	return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);
}

function basenameShort(p: string): string {
	const parts = String(p).split(/[\\/]/);
	return parts[parts.length - 1] || String(p);
}

export function assertNoExternalReferences(html: string): void {
	// Strip the embedded JSON data script block so user messages mentioning URLs don't trigger false positives
	const withoutData = html.replace(/<script\b[^>]*\bid=["']myharness-export-data["'][^>]*>[\s\S]*?<\/script>/gi, "");

	// Check URL-bearing HTML attributes for external HTTP(S) and protocol-relative references.
	const externalRefMatch =
		/<[a-z][\w:-]*\b[^>]*\b(?:src|href)\s*=\s*(?:"(?:https?:)?\/\/(?!\/)[^"]*"|'(?:https?:)?\/\/(?!\/)[^']*'|(?:https?:)?\/\/(?!\/)[^\s>]+)/i.exec(
			withoutData,
		);
	if (externalRefMatch) {
		throw new Error(`Export HTML contains external reference: ${externalRefMatch[0]}`);
	}

	// Module scripts may not import relative or absolute paths; bundled modules use bare names only.
	for (const script of withoutData.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		for (const imported of scanImports(script[1] ?? "")) {
			if (
				/^(?:\.\/|\.\.\/|\/|\/\/)/.test(imported.specifier) ||
				/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(imported.specifier)
			) {
				throw new Error(`Export HTML contains relative or absolute path import: ${imported.specifier}`);
			}
		}
	}

	const importmapMatches = [...html.matchAll(/<script\b[^>]*\btype=["']importmap["'][^>]*>/gi)];
	if (importmapMatches.length !== 1) {
		throw new Error(`Export HTML must have exactly one importmap (found ${importmapMatches.length})`);
	}

	const moduleMatches = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>/gi)];
	if (moduleMatches.length === 0) {
		throw new Error('Export HTML is missing <script type="module">');
	}
	const importmapIdx = importmapMatches[0]!.index!;
	const firstModuleIdx = moduleMatches[0]!.index!;
	if (importmapIdx >= firstModuleIdx) {
		throw new Error('importmap must precede any <script type="module">');
	}
}

export async function buildReplayHtml(options: BuildReplayHtmlOptions): Promise<string> {
	if (!options.sessionFile && !options.sessionManager) {
		throw new Error("buildReplayHtml requires either sessionFile or sessionManager");
	}

	const projection: ProjectedSession = projectSession({
		file: options.sessionFile,
		sessionManager: options.sessionManager,
		prefs: options.prefs,
		detailsCharLimit: options.detailsLimit ?? undefined,
		exporterVersion: "webui-w24",
	});

	const {
		routes,
		prefs: viewPrefs,
		slotStatus,
	}: BuildRoutesResult = buildRoutes({
		projection,
		prefs: options.prefs,
		detailsLimit: options.detailsLimit,
	});

	const jsonlBytes = Buffer.byteLength(projection.rawJsonl, "utf8");
	const maxJsonlBytes = options.maxJsonlBytes ?? EXPORT_MAX_JSONL_BYTES;
	if (jsonlBytes > maxJsonlBytes) {
		throw new ReplayExportTooLargeError(jsonlBytes, maxJsonlBytes);
	}

	if (options.slotInfo) {
		Object.assign(slotStatus, options.slotInfo);
		routes["/api/slots"] = { slots: [slotStatus] };
	}

	const exportedAt = new Date().toISOString();
	const exportData = {
		kind: "myharness-export-replay",
		formatVersion: 1,
		exportedAt,
		meta: {
			sessionId: projection.meta.sessionId,
			name: options.name || projection.meta.name,
			file: projection.meta.file,
			cwd: projection.meta.cwd,
			mode: projection.meta.mode,
			workspaceId: projection.meta.workspaceId,
			entryCount: projection.meta.entryCount,
			branchCount: projection.meta.branchCount,
			headerTimestamp: projection.meta.headerTimestamp,
		},
		prefs: viewPrefs,
		routes,
		rawJsonl: projection.rawJsonl,
	};

	const webDir = resolve(options.webDir ?? getWebUiDir());
	const bundle: BundleFrontendResult = bundleFrontend({ webDir });

	const vendorDir = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
	const markedPath = join(vendorDir, "marked.min.js");
	const highlightPath = join(vendorDir, "highlight.min.js");
	const markedText = existsSync(markedPath) ? readFileSync(markedPath, "utf8") : "";
	const highlightText = existsSync(highlightPath) ? readFileSync(highlightPath, "utf8") : "";

	const faviconFile = join(webDir, "favicon.svg");
	const favDataUrl = existsSync(faviconFile)
		? `data:image/svg+xml;base64,${Buffer.from(readFileSync(faviconFile)).toString("base64")}`
		: "";

	const sessionTitle =
		options.title || options.name || projection.meta.name || projection.meta.sessionId || "MyHarness";
	const boot = bootScript({
		exportedAt,
		sourceName: basenameShort(projection.meta.file ?? "session"),
		sourcePath: projection.meta.file ?? projection.meta.sessionId ?? "session",
		missingRoutePolicy: options.offlineGet ?? "empty",
	});

	const styles = bundle.css
		.map((c) => `<style data-src="${escapeHtml(c.path)}">\n${inlineCss(c.content)}\n</style>`)
		.join("\n");

	const classicScripts = [
		markedText ? `<script data-vendor="marked.min.js">\n${inlineJs(markedText)}\n</script>` : "",
		highlightText ? `<script data-vendor="highlight.min.js">\n${inlineJs(highlightText)}\n</script>` : "",
	]
		.filter(Boolean)
		.join("\n");

	// W128/L-1: the importmap block is embedded the same way as the data block;
	// both go through safeJsonForScript, which escapes every '<' as \u003C so a
	// literal `<script` + unclosed `<!--` can never enter the script escaped
	// state and swallow the boot script and body (R3a H-2 white screen).
	const importmapJson = safeJsonForScript({ imports: bundle.importMap });
	const dataJson = safeJsonForScript(exportData);
	const entry = bundle.entry.bare;

	const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta name="color-scheme" content="dark light" />
	<title>${escapeHtml(sessionTitle)} · MyHarness</title>
	<link rel="icon" href="${favDataUrl}" type="image/svg+xml" />
${styles}
${classicScripts}
	<script type="importmap">
${importmapJson}
	</script>
	<script id="${DATA_ELEMENT_ID}" type="application/json">${dataJson}</script>
	<script id="myharness-export-boot">
${inlineJs(boot)}
	</script>
</head>
<body>
	<div id="app"></div>
	<noscript>MyHarness 导出的只读副本需要 JavaScript。</noscript>
	<script type="module">
		import("${entry}");
	</script>
</body>
</html>
`;

	assertNoExternalReferences(html);
	return html;
}
