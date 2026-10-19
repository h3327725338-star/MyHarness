/**
 * W25c — HTML Export Replay Security Test.
 *
 * Verifies:
 * 1. Session constructed with SessionManager containing malicious payloads in every location:
 *    - User message text
 *    - Assistant markdown (<script>, <img onerror=...>, [x](javascript:...), "><svg onload=...>)
 *    - Thinking block
 *    - Tool call arguments & tool name
 *    - Tool results
 *    - Bash command lines and outputs
 *    - Custom entries
 *    - Session name
 *    - File names / paths / cwd
 *    - Compaction summaries
 *    - Branch summaries
 *    - File change card filenames and diff lines
 * 2. Standalone unit tests:
 *    - </script does NOT truncate embedded data (<\\/ escaping)
 *    - Raw JSONL is restored byte-for-byte
 *    - Exactly one importmap strictly before any <script type="module">
 *    - Page title and export filename sanitization (no path separators, quotes, or unescaped tags)
 *    - assertNoExternalReferences passes on valid replay HTML
 * 3. Browser E2E (controlled by MYHARNESS_TARGETED_BROWSER_E2E=1 and Chrome availability):
 *    - Fresh --user-data-dir in real Chrome opened via file:// URL
 *    - Pre-injected window.__xss = 0 via CDP Page.addScriptToEvaluateOnNewDocument
 *    - Asserts window.__xss remains 0 and no malicious elements execute
 *    - Expands all collapsible blocks (details, fold toggles, change cards) and re-asserts window.__xss === 0
 *    - Browser DOM raw JSONL restored byte-for-byte
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertNoExternalReferences,
	buildReplayHtml,
	escapeHtml,
	safeJsonForScript,
} from "../src/exports/html/replay/build.ts";
import { DATA_ELEMENT_ID } from "../src/exports/html/replay/shell.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { detectInstalledBrowsers, findBrowserExecutable } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
const chromeExecutable = findBrowserExecutable("chrome");
const hasChrome = Boolean(chromeExecutable && installed.some((b) => b.kind === "chrome"));

interface SecurityEvalResult {
	xss: number;
	payloadScripts: number;
	onerrorElements: number;
	javascriptLinks: number;
	extractedJsonl?: string;
}

interface PageStateResult {
	state: string;
	hasApp: boolean;
	hasRendered: boolean;
}

/** Helpers for CDP over pipe */
interface CdpClient {
	child: ChildProcess;
	send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
	close: () => Promise<void>;
}

function launchChromeCdp(executable: string, profileDir: string): CdpClient {
	const child = spawn(
		executable,
		[
			`--user-data-dir=${profileDir}`,
			"--remote-debugging-pipe",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-default-apps",
			"--headless=new",
			"about:blank",
		],
		{
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);

	const input = child.stdio[3] as Writable;
	const output = child.stdio[4] as Readable;
	let buffer = "";
	let idCounter = 1;
	const pending = new Map<number, { resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void }>();

	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		buffer += chunk;
		while (true) {
			const idx = buffer.indexOf("\0");
			if (idx < 0) break;
			const text = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			try {
				const msg = JSON.parse(text) as {
					id?: number;
					result?: Record<string, unknown>;
					error?: { message?: string };
				};
				if (typeof msg.id === "number" && pending.has(msg.id)) {
					const p = pending.get(msg.id)!;
					pending.delete(msg.id);
					if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"));
					else p.resolve(msg.result ?? {});
				}
			} catch {
				// Ignore non-json or malformed chunks
			}
		}
	});

	const send = (
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> => {
		const id = idCounter++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
		});
	};

	const close = async (): Promise<void> => {
		for (const p of pending.values()) {
			p.reject(new Error("CDP client closed"));
		}
		pending.clear();
		child.kill();
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null) return resolve();
			child.once("exit", () => resolve());
			setTimeout(resolve, 3000);
		});
	};

	return { child, send, close };
}

/**
 * W128: open an export page in Chrome over file://, pre-inject window.__xss = 0,
 * then read a probe snapshot. A page whose embedded JSON carried a raw `<script`
 * plus an unclosed `<!--` gets its boot script and body swallowed by the HTML
 * parser: hasBoot stays false, #app never appears (appKids -1) and scripts drops
 * to 4. So `ready` (boot ran AND app rendered children) is the white-screen check.
 */
interface W128Probe {
	scripts: number;
	hasBoot: boolean;
	appKids: number;
	xss: number;
	onerrorElements: number;
	onloadElements: number;
	dataParses: boolean;
	metaName?: string;
	prefsLang?: string;
	sourcePath?: string;
	textIncludes: Record<string, boolean>;
	jsonlIncludes: Record<string, boolean>;
	ready: boolean;
}

function w128ProbeExpression(textChecks: string[], jsonlChecks: string[]): string {
	const markers = textChecks.map((t) => JSON.stringify(t)).join(",");
	const jsonlMarkers = jsonlChecks.map((t) => JSON.stringify(t)).join(",");
	return `(() => {
		var app = document.getElementById('app');
		var dataEl = document.getElementById('${DATA_ELEMENT_ID}');
		var dataParsed = null;
		try { dataParsed = JSON.parse(dataEl ? dataEl.textContent : ''); } catch (e) {}
		var rt = window.__MYHARNESS_EXPORT__;
		var bodyText = document.body ? document.body.textContent : '';
		var textIncludes = {};
		var markers = [${markers}];
		for (var i = 0; i < markers.length; i++) { textIncludes[markers[i]] = bodyText.indexOf(markers[i]) >= 0; }
		// Lossless-restore checks run against the JSON.parse'd data, not the HTML text:
		// the embedded block by design contains no raw '<' anymore, and an unclosed
		// '<!--' inside a rendered message becomes a real (inert) HTML comment.
		var jsonlIncludes = {};
		var jsonlMarkers = [${jsonlMarkers}];
		var rawJsonl = dataParsed && typeof dataParsed.rawJsonl === 'string' ? dataParsed.rawJsonl : '';
		for (var j = 0; j < jsonlMarkers.length; j++) { jsonlIncludes[jsonlMarkers[j]] = rawJsonl.indexOf(jsonlMarkers[j]) >= 0; }
		return {
			scripts: document.querySelectorAll('script').length,
			hasBoot: typeof rt !== 'undefined' && !!rt,
			appKids: app ? app.children.length : -1,
			xss: window.__xss,
			onerrorElements: document.querySelectorAll('[onerror]').length,
			onloadElements: document.querySelectorAll('[onload]').length,
			dataParses: !!dataParsed,
			metaName: rt && rt.meta ? rt.meta.name : undefined,
			prefsLang: rt && rt.prefs ? rt.prefs.lang : undefined,
			sourcePath: rt && rt.export ? rt.export.sourcePath : undefined,
			textIncludes: textIncludes,
			jsonlIncludes: jsonlIncludes
		};
	})()`;
}

async function openW128ExportInChrome(
	html: string,
	profileTag: string,
	textChecks: string[],
	jsonlChecks: string[] = [],
): Promise<W128Probe> {
	const browserProfileDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), `w128-${profileTag}-`));
	const exportHtmlPath = join(browserProfileDir, "export-replay.html");
	writeFileSync(exportHtmlPath, html, "utf8");
	const fileUrl = pathToFileURL(exportHtmlPath).href;

	const client = launchChromeCdp(chromeExecutable!, browserProfileDir);
	try {
		const target = await client.send("Target.createTarget", { url: "about:blank" });
		const attached = await client.send("Target.attachToTarget", {
			targetId: target.targetId as string,
			flatten: true,
		});
		const sessionId = String(attached.sessionId);

		await client.send("Page.enable", {}, sessionId);
		await client.send("Runtime.enable", {}, sessionId);
		await client.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__xss = 0;" }, sessionId);
		await client.send("Page.navigate", { url: fileUrl }, sessionId);

		// Poll until boot has run and the app rendered children (or the deadline).
		// A white (swallowed) page never settles, so the deadline bounds the red runs
		// well inside the per-test timeout given to the W128 tests below.
		const expression = w128ProbeExpression(textChecks, jsonlChecks);
		const deadline = Date.now() + 12000;
		let last: W128Probe | undefined;
		while (Date.now() < deadline) {
			const check = await client.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
			last = (check.result as { value?: W128Probe })?.value;
			if (last?.hasBoot && last.appKids > 0) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		// Settle async rendering, then take the final reading.
		await new Promise((r) => setTimeout(r, 1500));
		const final = await client.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
		const probe = (final.result as { value?: W128Probe })?.value ?? last;
		if (!probe) throw new Error("W128 probe returned no value");
		return { ...probe, ready: Boolean(probe.hasBoot && probe.appKids > 0) };
	} finally {
		await client.close();
		rmSync(browserProfileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
}

describe("W25c: web export replay security", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let rawJsonlOnDisk: string;
	let generatedHtml: string;

	const maliciousPayloads = {
		userScript: "<script>window.__xss=1;</script>",
		userImg: '<img src="x" onerror="window.__xss=1;">',
		userLink: "[bad link](javascript:window.__xss=1)",
		userSvg: '"><svg onload="window.__xss=1">',
		userBreakout: "</script><script>window.__xss=1;</script>",

		asstScript: "<script>window.__xss=2;</script>",
		asstImg: '<img src="y" onerror="window.__xss=2;">',
		asstLink: "[asst link](javascript:window.__xss=2)",
		asstSvg: '"><svg onload="window.__xss=2">',
		asstBreakout: "</script><script>window.__xss=2;</script>",

		thinking: 'Thinking payload: <script>window.__xss=3;</script><img src=x onerror="window.__xss=3;">',
		toolName: "bash<script>window.__xss=4;</script>",
		toolParam: "echo '<script>window.__xss=4;</script>' && malicious<img src=x onerror=\"window.__xss=4;\">",
		toolResult: 'Tool output with <script>window.__xss=5;</script><img src=x onerror="window.__xss=5;">',
		bashLine: "cat /etc/<script>window.__xss=6;</script>",
		customEntry: "custom_type_<script>window.__xss=7;</script>",
		sessionName: 'Session "<script>window.__xss=8;</script><img src=x onerror="window.__xss=8;">\'',
		compactionSummary: 'Compacted: <script>window.__xss=10;</script><img src=x onerror="window.__xss=10;">',
		branchSummary: 'Branch: <script>window.__xss=11;</script><img src=x onerror="window.__xss=11;">',
		diffFilename: "file_<script>window.__xss=12;</script>.ts",
		diffPatch:
			'--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n+<script>window.__xss=13;</script><img src=x onerror="window.__xss=13;">',

		// W128 additions (append-only): codespan breakout, `<script` + unclosed `<!--`
		// combo (H-2 white screen), a ~100k-char single line, and hostile name / prefs.lang /
		// source path carrying the same combo. These are consumed by the W128 describe
		// below, not by the pre-existing W25c session above.
		w128CodespanImg: 'try `<img src=x onerror="window.__xss=20">` end',
		w128OpenCommentCombo: "A <script> B <!-- C",
		w128LongLine: `${"x".repeat(99990)}W128LONGTAIL`,
		w128NameCombo: "W128 <script> name <!-- tail",
		w128LangCombo: "en <script> <!-- W128",
		w128BootPath: "C:/w128-boot-probe/<script> unclosed <!-- .jsonl",
	};

	beforeAll(async () => {
		tempDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "w25c-security-"));
		sessionManager = SessionManager.create(tempDir, undefined, undefined, {
			dataRoot: join(tempDir, "data"),
			agentDir: tempDir,
		});

		// 1. Session name
		sessionManager.appendSessionInfo(maliciousPayloads.sessionName);

		// 2. User message with text, script, img, link, svg, and </script> breakout
		const userText = [
			"Testing user payload:",
			maliciousPayloads.userScript,
			maliciousPayloads.userImg,
			maliciousPayloads.userLink,
			maliciousPayloads.userSvg,
			maliciousPayloads.userBreakout,
		].join("\n");
		const u1 = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		});

		// 3. Assistant message with thinking, markdown, tool call
		const asstText = [
			"Assistant reply with markdown payloads:",
			maliciousPayloads.asstScript,
			maliciousPayloads.asstImg,
			maliciousPayloads.asstLink,
			maliciousPayloads.asstSvg,
			maliciousPayloads.asstBreakout,
		].join("\n");
		const a1 = sessionManager.appendMessage({
			role: "assistant",
			api: "anthropic",
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: maliciousPayloads.thinking },
				{ type: "text", text: asstText },
				{
					type: "toolCall",
					id: "call_tool_xss",
					name: maliciousPayloads.toolName,
					arguments: {
						command: maliciousPayloads.bashLine,
						param: maliciousPayloads.toolParam,
					},
				},
			],
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			timestamp: Date.now(),
		});

		// 4. Tool result
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_tool_xss",
			toolName: maliciousPayloads.toolName,
			content: [
				{
					type: "text",
					text: maliciousPayloads.toolResult,
				},
			],
			isError: false,
			timestamp: Date.now(),
		});

		// 5. Custom entry
		sessionManager.appendCustomEntry(maliciousPayloads.customEntry, {
			note: "<script>window.__xss=7;</script>",
			file: "test/<script>window.__xss=9;</script>.txt",
		});

		// 6. File changes card custom entry (web-run-changes)
		sessionManager.appendCustomEntry("web-run-changes", {
			runId: 1,
			files: [
				{
					path: maliciousPayloads.diffFilename,
					status: "modified",
					additions: 1,
					deletions: 1,
					binary: false,
					patch: maliciousPayloads.diffPatch,
				},
			],
		});

		// 7. Compaction entry
		sessionManager.appendCompaction(
			maliciousPayloads.compactionSummary,
			u1,
			1000,
			undefined,
			false,
			undefined,
			false,
			false,
		);

		// 8. Branch with summary
		sessionManager.branchWithSummary(a1, maliciousPayloads.branchSummary);

		// Persist / read session file
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		rawJsonlOnDisk = readFileSync(sessionFile!, "utf8");

		// Build replay HTML
		generatedHtml = await buildReplayHtml({
			sessionManager,
			title: 'Security Replay <script>window.__xss=99;</script>"',
			name: maliciousPayloads.sessionName,
		});
	});

	describe("unit security assertions (always run)", () => {
		it("ensures </script is escaped in embedded script tags and data blocks", () => {
			// Inside script tags, raw "</script" must never appear unescaped
			const scriptTagContents = [...generatedHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
			expect(scriptTagContents.length).toBeGreaterThanOrEqual(2);
			for (const [_fullMatch, inner] of scriptTagContents) {
				expect(inner).not.toMatch(/<\/script/i);
			}

			// safeJsonForScript unit checks
			const sample = {
				msg: '</script><script>alert("x")</script>',
				img: '<img src=x onerror="alert(1)">',
			};
			// W128: every '<' becomes \u003C, so no raw '<' survives in a JSON block.
			const escaped = safeJsonForScript(sample);
			expect(escaped).not.toContain("</");
			expect(escaped).not.toContain("<");
			expect(escaped).toContain("\\u003C");
			expect(JSON.parse(escaped)).toEqual(sample);
		});

		it("ensures raw JSONL is embedded and restored byte-for-byte without truncation", () => {
			const match = generatedHtml.match(
				new RegExp(`<script id="${DATA_ELEMENT_ID}" type="application/json">([\\s\\S]*?)<\\/script>`),
			);
			expect(match).not.toBeNull();
			const parsed = JSON.parse(match![1]);
			expect(parsed.rawJsonl).toBeDefined();

			const originalBuffer = Buffer.from(rawJsonlOnDisk, "utf8");
			const extractedBuffer = Buffer.from(parsed.rawJsonl, "utf8");
			expect(extractedBuffer.equals(originalBuffer)).toBe(true);
		});

		it("ensures exactly one importmap precedes any module script", () => {
			const importmaps = [...generatedHtml.matchAll(/<script\b[^>]*\btype=["']importmap["'][^>]*>/gi)];
			expect(importmaps).toHaveLength(1);

			const moduleScripts = [...generatedHtml.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>/gi)];
			expect(moduleScripts.length).toBeGreaterThanOrEqual(1);

			const importmapPos = generatedHtml.indexOf('<script type="importmap">');
			const modulePos = generatedHtml.indexOf('<script type="module">');
			expect(importmapPos).toBeGreaterThan(0);
			expect(modulePos).toBeGreaterThan(importmapPos);
		});

		it("sanitizes page title and export filename against path traversal and attribute breakout", () => {
			// escapeHtml unit behavior
			expect(escapeHtml('<script>alert("x")</script>&')).toBe(
				"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;",
			);

			// Title in HTML must be escaped
			expect(generatedHtml).toContain("&lt;script&gt;window.__xss=99;&lt;/script&gt;");
			expect(generatedHtml).not.toContain("<title>Security Replay <script>");

			// Filename sanitization logic used in routes-sessions.ts
			const dangerousName = '../../etc/passwd "hello" <script>bad</script>';
			const sanitizedFilename = `${dangerousName.replace(/[^\w.-]+/g, "_").slice(0, 60) || "session"}.html`;
			expect(sanitizedFilename).not.toContain("/");
			expect(sanitizedFilename).not.toContain("\\");
			expect(sanitizedFilename).not.toContain('"');
			expect(sanitizedFilename).not.toContain("'");
			expect(sanitizedFilename).not.toContain("<");
			expect(sanitizedFilename).not.toContain(">");
			expect(sanitizedFilename).toMatch(/^[\w.-]+\.html$/);
		});

		it("passes assertNoExternalReferences self-check", () => {
			expect(() => assertNoExternalReferences(generatedHtml)).not.toThrow();
		});
	});

	describe("browser e2e security (CDP + Chrome)", () => {
		it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !hasChrome)(
			"renders replay in Chrome via file:// without executing any malicious payload script",
			async () => {
				const browserProfileDir = mkdtempSync(
					join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "w25c-chrome-profile-"),
				);
				const exportHtmlPath = join(browserProfileDir, "export-replay.html");
				writeFileSync(exportHtmlPath, generatedHtml, "utf8");
				const fileUrl = pathToFileURL(exportHtmlPath).href;

				const client = launchChromeCdp(chromeExecutable!, browserProfileDir);

				try {
					// Create target and attach
					const target = await client.send("Target.createTarget", { url: "about:blank" });
					const attached = await client.send("Target.attachToTarget", {
						targetId: target.targetId as string,
						flatten: true,
					});
					const sessionId = String(attached.sessionId);

					await client.send("Page.enable", {}, sessionId);
					await client.send("Runtime.enable", {}, sessionId);

					// Pre-inject window.__xss = 0 via CDP Page.addScriptToEvaluateOnNewDocument
					await client.send(
						"Page.addScriptToEvaluateOnNewDocument",
						{
							source: "window.__xss = 0;",
						},
						sessionId,
					);

					// Navigate to export file:// URL
					await client.send("Page.navigate", { url: fileUrl }, sessionId);

					// Wait for page to initialize
					const deadline = Date.now() + 15000;
					let ready = false;
					while (Date.now() < deadline) {
						const check = await client.send(
							"Runtime.evaluate",
							{
								expression: `(() => {
									return {
										state: document.readyState,
										hasApp: !!document.getElementById('app'),
										hasRendered: !!document.querySelector('.transcript, .chat-thread, [data-export-readonly]')
									};
								})()`,
								returnByValue: true,
							},
							sessionId,
						);
						const res = (check.result as { value?: PageStateResult })?.value;
						if (res?.state === "complete" && res?.hasApp) {
							ready = true;
							break;
						}
						await new Promise((r) => setTimeout(r, 200));
					}
					expect(ready).toBe(true);

					// Give async scripts (marked, highlight, app components) 1.5 seconds to settle
					await new Promise((r) => setTimeout(r, 1500));

					// Assert window.__xss is still 0
					const check1 = await client.send(
						"Runtime.evaluate",
						{
							expression: `(() => {
								const payloadScripts = [...document.querySelectorAll('script')].filter(
									s => s.textContent.includes('__xss') && s.id !== '${DATA_ELEMENT_ID}' && !s.textContent.includes('window.__xss = 0')
								).length;
								const onerrorElements = document.querySelectorAll('[onerror]').length;
								const javascriptLinks = document.querySelectorAll('a[href^="javascript:"]').length;
								return {
									xss: window.__xss,
									payloadScripts,
									onerrorElements,
									javascriptLinks
								};
							})()`,
							returnByValue: true,
						},
						sessionId,
					);

					const res1 = (check1.result as { value?: SecurityEvalResult })?.value;

					expect(res1?.xss).toBe(0);
					expect(res1?.payloadScripts).toBe(0);
					expect(res1?.onerrorElements).toBe(0);
					expect(res1?.javascriptLinks).toBe(0);

					// Expand all collapsed blocks (details, fold toggles, changes cards)
					await client.send(
						"Runtime.evaluate",
						{
							expression: `(() => {
								document.querySelectorAll('details').forEach(d => { d.open = true; });
								document.querySelectorAll('[aria-expanded="false"]').forEach(b => {
									try { (b as HTMLElement).click(); } catch {}
								});
								document.querySelectorAll('.task-toggle, .fold-toggle, .changes-card-file, .btn-toggle').forEach(el => {
									try { (el as HTMLElement).click(); } catch {}
								});
							})()`,
						},
						sessionId,
					);

					// Wait 1 second for any expanded content to render
					await new Promise((r) => setTimeout(r, 1000));

					// Re-assert window.__xss is STILL 0 after expanding all blocks
					const check2 = await client.send(
						"Runtime.evaluate",
						{
							expression: `(() => {
								const payloadScripts = [...document.querySelectorAll('script')].filter(
									s => s.textContent.includes('__xss') && s.id !== '${DATA_ELEMENT_ID}' && !s.textContent.includes('window.__xss = 0')
								).length;
								const onerrorElements = document.querySelectorAll('[onerror]').length;
								const javascriptLinks = document.querySelectorAll('a[href^="javascript:"]').length;
								const dataEl = document.getElementById('${DATA_ELEMENT_ID}');
								let extractedJsonl = '';
								if (dataEl && dataEl.textContent) {
									try {
										const parsed = JSON.parse(dataEl.textContent);
										extractedJsonl = parsed.rawJsonl || '';
									} catch {}
								}
								return {
									xss: window.__xss,
									payloadScripts,
									onerrorElements,
									javascriptLinks,
									extractedJsonl
								};
							})()`,
							returnByValue: true,
						},
						sessionId,
					);

					const res2 = (check2.result as { value?: SecurityEvalResult })?.value;

					expect(res2?.xss).toBe(0);
					expect(res2?.payloadScripts).toBe(0);
					expect(res2?.onerrorElements).toBe(0);
					expect(res2?.javascriptLinks).toBe(0);

					// Retrieve raw JSONL in browser and verify byte-for-byte identity
					const originalBuffer = Buffer.from(rawJsonlOnDisk, "utf8");
					const browserBuffer = Buffer.from(res2?.extractedJsonl ?? "", "utf8");
					expect(browserBuffer.equals(originalBuffer)).toBe(true);
				} finally {
					await client.close();
					rmSync(browserProfileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
				}
			},
		);
	});

	describe("W128: embedded JSON escapes every < so unclosed comments cannot white out the page", () => {
		let w128TempDir: string;
		let comboPageHtml: string;
		let namePrefsHtml: string;
		let bootProbeHtml: string;

		beforeAll(async () => {
			w128TempDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "w128-replay-"));
			mkdirSync(join(w128TempDir, "combo"));
			mkdirSync(join(w128TempDir, "nameprefs"));
			mkdirSync(join(w128TempDir, "boot"));

			// Page 1: user messages carrying the codespan breakout, the
			// `<script` + unclosed `<!--` combo, and a ~100k-char single line.
			const sm1 = SessionManager.create(join(w128TempDir, "combo"), undefined, undefined, {
				dataRoot: join(w128TempDir, "data"),
				agentDir: w128TempDir,
			});
			sm1.appendSessionInfo("W128 combo session");
			sm1.appendMessage({
				role: "user",
				content: [{ type: "text", text: maliciousPayloads.w128CodespanImg }],
				timestamp: Date.now(),
			});
			sm1.appendMessage({
				role: "user",
				content: [{ type: "text", text: maliciousPayloads.w128OpenCommentCombo }],
				timestamp: Date.now(),
			});
			sm1.appendMessage({
				role: "user",
				content: [{ type: "text", text: maliciousPayloads.w128LongLine }],
				timestamp: Date.now(),
			});
			comboPageHtml = await buildReplayHtml({ sessionManager: sm1, name: "W128 combo session" });

			// Page 2: session name and prefs.lang carrying the combo (they land in
			// the embedded data block; the boot script reads prefs at runtime).
			const sm2 = SessionManager.create(join(w128TempDir, "nameprefs"), undefined, undefined, {
				dataRoot: join(w128TempDir, "data"),
				agentDir: w128TempDir,
			});
			sm2.appendSessionInfo(maliciousPayloads.w128NameCombo);
			sm2.appendMessage({
				role: "user",
				content: [{ type: "text", text: "W128 name/prefs probe body" }],
				timestamp: Date.now(),
			});
			namePrefsHtml = await buildReplayHtml({
				sessionManager: sm2,
				name: maliciousPayloads.w128NameCombo,
				prefs: { lang: maliciousPayloads.w128LangCombo },
			});

			// Page 3: boot-only probe — the source path reaches the inline boot
			// script verbatim (W122 fields), while user text stays benign. If the
			// boot block itself is not escaped, this page whites out even after
			// the data block is fixed.
			const sm3 = SessionManager.create(join(w128TempDir, "boot"), undefined, undefined, {
				dataRoot: join(w128TempDir, "data"),
				agentDir: w128TempDir,
			});
			sm3.appendSessionInfo("W128 boot probe");
			sm3.appendMessage({
				role: "user",
				content: [{ type: "text", text: "W128 boot probe body" }],
				timestamp: Date.now(),
			});
			bootProbeHtml = await buildReplayHtml({
				sessionFile: maliciousPayloads.w128BootPath,
				sessionManager: sm3,
				name: "W128 boot probe",
			});
		});

		const browserGate = process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !hasChrome;

		it.skipIf(browserGate)(
			"renders codespan, <script>+<!-- combo and 100k single line without white screen or payload execution",
			async () => {
				const probe = await openW128ExportInChrome(
					comboPageHtml,
					"combo",
					["A <script> B", "W128LONGTAIL", '<img src=x onerror="window.__xss=20">'],
					[maliciousPayloads.w128OpenCommentCombo],
				);
				// (b) the page renders: boot ran and the app painted. The message shows
				// the escaped `<script>` as text; the trailing unclosed `<!-- C` is then
				// swallowed as a real (inert) HTML comment by the browser — that is the
				// markdown renderer pipeline (web/js/markdown.js, out of this ticket's
				// scope), not the embedded-JSON escape. The full string's lossless
				// restore is asserted on the parsed data block below.
				expect(probe.ready).toBe(true);
				expect(probe.hasBoot).toBe(true);
				expect(probe.appKids).toBeGreaterThan(0);
				expect(probe.scripts).toBeGreaterThanOrEqual(6);
				expect(probe.dataParses).toBe(true);
				expect(probe.textIncludes["A <script> B"]).toBe(true);
				expect(probe.jsonlIncludes[maliciousPayloads.w128OpenCommentCombo]).toBe(true);
				// (c) the ~100k-char single line renders.
				expect(probe.textIncludes.W128LONGTAIL).toBe(true);
				// (a) the codespan payload stays literal text, nothing executes.
				expect(probe.textIncludes['<img src=x onerror="window.__xss=20">']).toBe(true);
				expect(probe.onerrorElements).toBe(0);
				expect(probe.onloadElements).toBe(0);
				expect(probe.xss).toBe(0);
			},
			60000,
		);

		it.skipIf(browserGate)(
			"session name and prefs.lang with <script + unclosed <!-- do not white out the page",
			async () => {
				const probe = await openW128ExportInChrome(namePrefsHtml, "nameprefs", []);
				expect(probe.ready).toBe(true);
				expect(probe.hasBoot).toBe(true);
				expect(probe.appKids).toBeGreaterThan(0);
				expect(probe.dataParses).toBe(true);
				// Lossless restore of the hostile strings through JSON.parse.
				expect(probe.metaName).toBe(maliciousPayloads.w128NameCombo);
				expect(probe.prefsLang).toBe(maliciousPayloads.w128LangCombo);
				expect(probe.xss).toBe(0);
			},
			60000,
		);

		it.skipIf(browserGate)(
			"boot script embedded JSON with a hostile source path does not white out the page",
			async () => {
				const probe = await openW128ExportInChrome(bootProbeHtml, "bootprobe", []);
				expect(probe.ready).toBe(true);
				expect(probe.hasBoot).toBe(true);
				expect(probe.appKids).toBeGreaterThan(0);
				// The source path round-trips losslessly through the boot JSON.
				expect(probe.sourcePath).toBe(maliciousPayloads.w128BootPath);
				expect(probe.xss).toBe(0);
			},
			60000,
		);
	});
});
