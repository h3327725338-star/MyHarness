/**
 * W24 — HTML export step 4: assembly and integration tests.
 *
 * Verifies:
 * - importmap is unique and precedes any <script type="module">
 * - </script is escaped in embedded data, importmap, and inline scripts
 * - No external references (assertNoExternalReferences passes, throws on violations)
 * - Raw JSONL restored byte-for-byte
 * - User prefs take effect in embedded data and boot script
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertNoExternalReferences, buildReplayHtml, safeJsonForScript } from "../src/exports/html/replay/build.ts";
import { DATA_ELEMENT_ID } from "../src/exports/html/replay/shell.ts";
import { SessionManager } from "../src/session/manager/index.ts";

describe("buildReplayHtml assembly", () => {
	let tempDirectory: string;
	let sessionFilePath: string;
	let rawJsonlContent: string;

	beforeAll(() => {
		tempDirectory = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "w24-test-replay-build-"));
		sessionFilePath = join(tempDirectory, "test-session.jsonl");

		const entries = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-w24-build-test",
				timestamp: new Date().toISOString(),
				cwd: "C:/test/workspace",
				mode: "coding",
				workspaceId: "test-ws-id",
			}),
			JSON.stringify({
				type: "session_info",
				id: "info-01",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "W24 导出组装测试会话",
			}),
			JSON.stringify({
				type: "message",
				id: "msg-user-1",
				parentId: "info-01",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "请测试一下 </script> 攻击和 https://example.com 链接" }],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "msg-asst-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "收到！这里是助手回复：\n```html\n<script>alert('xss')</script>\n```" }],
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { total: 0 },
					},
				},
			}),
		];

		rawJsonlContent = `${entries.join("\n")}\n`;
		writeFileSync(sessionFilePath, rawJsonlContent, "utf8");
	});

	it('ensures importmap is strictly before any <script type="module"> and unique', async () => {
		const html = await buildReplayHtml({
			sessionFile: sessionFilePath,
		});

		const importmapMatches = [...html.matchAll(/<script\b[^>]*\btype=["']importmap["'][^>]*>/gi)];
		expect(importmapMatches).toHaveLength(1);

		const moduleMatches = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>/gi)];
		expect(moduleMatches.length).toBeGreaterThanOrEqual(1);

		const importmapIndex = html.indexOf('<script type="importmap">');
		const firstModuleIndex = html.indexOf('<script type="module">');

		expect(importmapIndex).toBeGreaterThan(0);
		expect(firstModuleIndex).toBeGreaterThan(importmapIndex);
	});

	it("escapes </script in embedded JSON data and importmap", async () => {
		const html = await buildReplayHtml({
			sessionFile: sessionFilePath,
		});

		// Inside script tags, raw "</script" must never appear unescaped
		const scriptTagContents = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
		for (const [_fullMatch, inner] of scriptTagContents) {
			// Inside the inner content of a script tag, there should be no unescaped </script
			expect(inner).not.toMatch(/<\/script/i);
		}

		// Check safeJsonForScript unit behaviour
		// W128: every '<' is escaped as \u003C, so no '<' literal can appear in a JSON block.
		const dangerous = { payload: "</script><script>alert(1)</script>" };
		const escaped = safeJsonForScript(dangerous);
		expect(escaped).not.toContain("</");
		expect(escaped).not.toContain("<");
		expect(escaped).toContain("\\u003C");
		expect(JSON.parse(escaped)).toEqual(dangerous);
	});

	it("validates zero external references in HTML skeleton", async () => {
		const html = await buildReplayHtml({
			sessionFile: sessionFilePath,
		});

		// Must pass self-check
		expect(() => assertNoExternalReferences(html)).not.toThrow();

		// Negative checks: assertNoExternalReferences must reject external src/href or relative imports
		expect(() => assertNoExternalReferences(`${html}<script src="https://cdn.example.com/lib.js"></script>`)).toThrow(
			/external reference/,
		);

		expect(() =>
			assertNoExternalReferences(`${html}<custom-element href="http://fonts.googleapis.com/css"></custom-element>`),
		).toThrow(/external reference/);

		expect(() =>
			assertNoExternalReferences(`${html}<script type="module">import("./relative.js");</script>`),
		).toThrow(/relative or absolute path import/);

		expect(() =>
			assertNoExternalReferences(`${html}<script type="module">import "../relative.js";</script>`),
		).toThrow(/relative or absolute path import/);

		expect(() =>
			assertNoExternalReferences(`${html}<script type="module">export { value } from "/absolute.js";</script>`),
		).toThrow(/relative or absolute path import/);
	});

	it("restores raw JSONL byte-for-byte from embedded data", async () => {
		const html = await buildReplayHtml({
			sessionFile: sessionFilePath,
		});

		const match = html.match(
			new RegExp(`<script id="${DATA_ELEMENT_ID}" type="application/json">([\\s\\S]*?)<\\/script>`),
		);
		expect(match).not.toBeNull();

		const parsed = JSON.parse(match![1]);
		expect(parsed.rawJsonl).toBeDefined();

		const originalBuffer = Buffer.from(rawJsonlContent, "utf8");
		const extractedBuffer = Buffer.from(parsed.rawJsonl, "utf8");
		expect(extractedBuffer.equals(originalBuffer)).toBe(true);
	});

	it("embeds user prefs and applies them in boot script", async () => {
		const testPrefs = {
			lang: "zh-CN",
			theme: "light",
			colorThemes: { coding: "forest", general: "amber" },
			colorTheme: "forest",
			motion: "reduce",
		};

		const html = await buildReplayHtml({
			sessionFile: sessionFilePath,
			prefs: testPrefs,
		});

		const match = html.match(
			new RegExp(`<script id="${DATA_ELEMENT_ID}" type="application/json">([\\s\\S]*?)<\\/script>`),
		);
		expect(match).not.toBeNull();

		const parsed = JSON.parse(match![1]);
		expect(parsed.prefs).toMatchObject({
			lang: "zh-CN",
			theme: "light",
			colorTheme: "forest",
		});

		expect(html).toContain('import("main.js")');
		expect(html).toContain("data-export-readonly");
	});

	it("builds replay HTML directly from an in-memory SessionManager", async () => {
		const sm = SessionManager.create(tempDirectory, undefined, undefined, {
			dataRoot: join(tempDirectory, "data"),
			agentDir: tempDirectory,
		});
		sm.appendSessionInfo("In-memory Session");
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Hello from in-memory session" }],
			timestamp: Date.now(),
		});

		const html = await buildReplayHtml({
			sessionManager: sm,
			name: "In-memory Session",
		});

		expect(html).toContain("<!doctype html>");
		expect(html).toContain("In-memory Session");
		expect(() => assertNoExternalReferences(html)).not.toThrow();
	});

	it("escapes every '<' in the data and importmap blocks so <script + unclosed <!-- cannot swallow the page", async () => {
		// H-2 (R3a): a session text carrying `<script` plus an unclosed `<!--`
		// puts the HTML parser in the script escaped state inside the embedded
		// JSON block; the real `</script>` no longer closes it, boot and body get
		// swallowed and the export page renders blank. Full `<` escaping in the
		// embedded JSON is the fix (JSON.parse restores the original text).
		const comboPath = join(tempDirectory, "w128-lt-escape-session.jsonl");
		const comboEntries = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-w128-lt-escape",
				timestamp: new Date().toISOString(),
				cwd: "C:/test/workspace",
				mode: "coding",
				workspaceId: "test-ws-id",
			}),
			JSON.stringify({
				type: "session_info",
				id: "info-w128",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "W128 lt escape probe",
			}),
			JSON.stringify({
				type: "message",
				id: "msg-w128-1",
				parentId: "info-w128",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "A <script> B <!-- C" }],
				},
			}),
		];
		writeFileSync(comboPath, `${comboEntries.join("\n")}\n`, "utf8");

		const html = await buildReplayHtml({ sessionFile: comboPath });

		// The inline data block must not contain a single raw '<'.
		const dataMatch = html.match(
			new RegExp(`<script id="${DATA_ELEMENT_ID}" type="application/json">([\\s\\S]*?)<\\/script>`),
		);
		expect(dataMatch).not.toBeNull();
		expect(dataMatch![1]).not.toContain("<");

		// JSON.parse succeeds and the original user text is restored losslessly.
		const parsed = JSON.parse(dataMatch![1]);
		expect(parsed.rawJsonl).toContain("A <script> B <!-- C");

		// The importmap block is embedded the same way and must carry no raw '<' either.
		const importmapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(importmapMatch).not.toBeNull();
		expect(importmapMatch![1]).not.toContain("<");
		expect(Object.keys(JSON.parse(importmapMatch![1]).imports).length).toBeGreaterThan(0);

		// Self-checks still pass on the fixed output.
		expect(() => assertNoExternalReferences(html)).not.toThrow();
	});
});
