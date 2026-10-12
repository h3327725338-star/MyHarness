/**
 * W27e — export E2E reverse proof: deliberately broken exports must redden the table.
 *
 * Same gate as the main replay suite (MYHARNESS_TARGETED_BROWSER_E2E=1 plus a local
 * Chrome/Edge); otherwise every case is skipped. Builds one pristine small-session
 * export as the green control, then applies six in-memory corruptions — each written
 * to a temp file under MYHARNESS_TEMP_DIR, never into the repo — and re-opens it with
 * the shared runScenario. A reverse case passes only when the assertions it names
 * actually fail, and it logs every red row verbatim.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildReplayHtml } from "../src/exports/html/replay/build.ts";
import {
	buildSmallSession,
	EXPORT_PREFS,
	expectAllPass,
	gated,
	runScenario,
	SMALL_NAME,
} from "./fixtures/export-replay-browser/harness.ts";

// ---------------------------------------------------------------- corruptions (pure string edits)

const DATA_SCRIPT_OPEN = '<script id="myharness-export-data" type="application/json">';
const SCRIPT_CLOSE = "</script>";

/** 1. Drop the embedded JSON data block entirely. */
function removeDataBlock(html: string): string {
	const start = html.indexOf(DATA_SCRIPT_OPEN);
	if (start < 0) throw new Error("reverse fixture: data script open tag not found");
	const end = html.indexOf(SCRIPT_CLOSE, start + DATA_SCRIPT_OPEN.length);
	if (end < 0) throw new Error("reverse fixture: data script close tag not found");
	return html.slice(0, start) + html.slice(end + SCRIPT_CLOSE.length);
}

interface TranscriptData {
	routes: Record<string, { items?: Array<Record<string, unknown>>; session?: Record<string, unknown> }>;
}

/** Parses a fresh copy of the embedded export JSON (callers must re-escape on splice). */
function parseExportData(html: string): { data: TranscriptData; jsonStart: number; jsonEnd: number } {
	const start = html.indexOf(DATA_SCRIPT_OPEN);
	if (start < 0) throw new Error("reverse fixture: data script open tag not found");
	const jsonStart = start + DATA_SCRIPT_OPEN.length;
	const jsonEnd = html.indexOf(SCRIPT_CLOSE, jsonStart);
	if (jsonEnd < 0) throw new Error("reverse fixture: data script close tag not found");
	return { data: JSON.parse(html.slice(jsonStart, jsonEnd)) as TranscriptData, jsonStart, jsonEnd };
}

const spliceExportData = (html: string, data: TranscriptData, jsonStart: number, jsonEnd: number): string =>
	html.slice(0, jsonStart) + JSON.stringify(data).replace(/<\//g, "<\\/") + html.slice(jsonEnd);

/** 2. Empty the text blocks of the final assistant reply (the 收尾确认 turn). */
function emptyFinalReply(html: string): string {
	const { data, jsonStart, jsonEnd } = parseExportData(html);
	const transcript = data.routes["/api/transcript"];
	if (!transcript || !Array.isArray(transcript.items)) {
		throw new Error("reverse fixture: /api/transcript items not found");
	}
	let emptied = 0;
	for (const item of transcript.items) {
		if (item.kind !== "assistant" || !Array.isArray(item.blocks)) continue;
		const blocks = item.blocks as Array<Record<string, unknown>>;
		const isFinal = blocks.some(
			(block) => block.type === "text" && typeof block.text === "string" && block.text.includes("收尾确认"),
		);
		if (!isFinal) continue;
		for (const block of blocks) {
			if (block.type === "text") block.text = "";
		}
		emptied += 1;
	}
	if (emptied === 0) throw new Error("reverse fixture: final reply not found");
	return spliceExportData(html, data, jsonStart, jsonEnd);
}

/** 3. Load a script from an unresolvable https host. */
function injectExternalScript(html: string): string {
	const headEnd = html.indexOf("</head>");
	if (headEnd < 0) throw new Error("reverse fixture: </head> not found");
	return `${html.slice(0, headEnd)}\t<script src="https://example.invalid/reverse-proof.js"></script>\n${html.slice(headEnd)}`;
}

/** 4. Drop the boot-time data-export-readonly marker (set at runtime, not static HTML). */
function removeReadonlyFlag(html: string): string {
	const marker = 'root.dataset.exportReadonly = "1";';
	if (!html.includes(marker)) throw new Error("reverse fixture: readonly marker line not found");
	return html.replace(marker, "");
}

/** 5. Splice a raw </script> into the embedded JSON (simulates an escaping failure). */
function breakScriptEscaping(html: string): string {
	const start = html.indexOf(DATA_SCRIPT_OPEN);
	if (start < 0) throw new Error("reverse fixture: data script open tag not found");
	const cut = start + DATA_SCRIPT_OPEN.length + 600;
	return `${html.slice(0, cut)}${SCRIPT_CLOSE}${html.slice(cut)}`;
}

/**
 * 6. Rename the session everywhere: the app overwrites the static <title> from the
 * embedded session name on boot, so only renaming the data (plus the static tag)
 * actually moves document.title.
 */
function renameTitle(html: string): string {
	const { data, jsonStart, jsonEnd } = parseExportData(html);
	const state = data.routes["/api/state"];
	if (!state || typeof state.session !== "object" || state.session === null) {
		throw new Error("reverse fixture: /api/state session not found");
	}
	state.session.name = "被改掉的对话名";
	const renamed = spliceExportData(html, data, jsonStart, jsonEnd).replace(
		/<title>[\s\S]*?<\/title>/,
		"<title>被改掉的标题 · MyHarness</title>",
	);
	if (renamed === html) throw new Error("reverse fixture: <title> not found");
	return renamed;
}

// ---------------------------------------------------------------- scenarios

describe("web export replay reverse proof", () => {
	let rootDir = "";
	let pristineHtml = "";

	beforeAll(async () => {
		if (!gated) return;
		rootDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "w27e-reverse-"));
		const sm = buildSmallSession(rootDir);
		pristineHtml = await buildReplayHtml({ sessionManager: sm, prefs: EXPORT_PREFS, name: SMALL_NAME });
	}, 240_000);

	const writeBroken = (name: string, html: string): string => {
		if (html === pristineHtml) throw new Error(`reverse fixture: ${name} was not actually corrupted`);
		const htmlPath = join(rootDir, name);
		writeFileSync(htmlPath, html, "utf8");
		return htmlPath;
	};

	/** Runs one corrupted file, logs every red row verbatim, returns the red names. */
	const redNamesOf = async (label: string, fileName: string, html: string): Promise<string[]> => {
		expect(pristineHtml).not.toBe("");
		const htmlPath = writeBroken(fileName, html);
		const results = await runScenario(label, htmlPath, { offline: false, expectedName: SMALL_NAME });
		const failures = results.filter((row) => !row.ok);
		console.log(
			`[${label}] 红 ${failures.length} 条:\n${failures.map((f) => `FAIL ${f.name} —— ${f.detail}`).join("\n")}`,
		);
		return failures.map((f) => f.name);
	};

	it.skipIf(!gated)(
		"control: pristine export passes the full 41-assertion table",
		async () => {
			expect(pristineHtml).not.toBe("");
			const htmlPath = join(rootDir, "control.html");
			writeFileSync(htmlPath, pristineHtml, "utf8");
			const results = await runScenario("reverse-control", htmlPath, {
				offline: false,
				expectedName: SMALL_NAME,
			});
			expectAllPass("reverse-control", results);
		},
		240_000,
	);

	it.skipIf(!gated)(
		"reverse 1: missing data block reddens jsonl and content assertions",
		async () => {
			const names = await redNamesOf("reverse-no-data", "broken-no-data.html", removeDataBlock(pristineHtml));
			expect(names).toContain("内嵌原始 JSONL（下载入口有内容）");
			expect(names).toContain("内容类型 用户消息（.user-row ≥ 1）");
		},
		240_000,
	);

	it.skipIf(!gated)(
		"reverse 2: emptied final reply reddens msg-meta assertion",
		async () => {
			const names = await redNamesOf(
				"reverse-empty-final",
				"broken-empty-final.html",
				emptyFinalReply(pristineHtml),
			);
			expect(names).toContain("内容类型 助手逐条 Token/费用小字（.msg-meta ≥ 1）");
		},
		240_000,
	);

	it.skipIf(!gated)(
		"reverse 3: external script reddens no-external assertions",
		async () => {
			const names = await redNamesOf("reverse-external", "broken-external.html", injectExternalScript(pristineHtml));
			expect(names).toContain("无对 file:// 以外的请求");
			expect(names).toContain("performance resource 条目里没有外部资源");
			expect(names).toContain("无失败请求（Network.loadingFailed）");
		},
		240_000,
	);

	it.skipIf(!gated)(
		"reverse 4: missing readonly flag reddens export-readonly assertion",
		async () => {
			const names = await redNamesOf(
				"reverse-no-readonly",
				"broken-no-readonly.html",
				removeReadonlyFlag(pristineHtml),
			);
			expect(names).toContain("导出标识 data-export-readonly");
		},
		240_000,
	);

	it.skipIf(!gated)(
		"reverse 5: unescaped script-close reddens first-screen assertions",
		async () => {
			const names = await redNamesOf(
				"reverse-script-close",
				"broken-script-close.html",
				breakScriptEscaping(pristineHtml),
			);
			expect(names).toContain("内嵌原始 JSONL（下载入口有内容）");
			expect(names).toContain("首屏渲染出对话内容（容器里有节点）");
		},
		240_000,
	);

	it.skipIf(!gated)(
		"reverse 6: renamed title reddens title assertion",
		async () => {
			const names = await redNamesOf("reverse-title", "broken-title.html", renameTitle(pristineHtml));
			expect(names).toContain(`标题是对话名（含「${SMALL_NAME}」）`);
		},
		240_000,
	);
});
