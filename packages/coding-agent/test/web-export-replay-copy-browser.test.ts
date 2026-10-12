/**
 * W27d — HTML export E2E: small session offline, and copied to another directory with a
 * renamed file before opening.
 *
 * Runs only with MYHARNESS_TARGETED_BROWSER_E2E=1 and a local Chrome/Edge (CDP pipe);
 * otherwise every case is skipped (existing convention from web-number-unit-settings-browser.test.ts).
 *
 * Simulates "double-click the single HTML on another computer while offline": a brand-new
 * --user-data-dir per scenario, CDP offline emulation, and (for the copy cases) the export
 * file copied into a freshly created directory whose name contains Chinese characters and
 * spaces, under a renamed file (also Chinese + spaces), then opened via file://.
 *
 * Each of the three cases runs the full 41-assertion table from the shared harness
 * (fixtures/export-replay-browser/harness.ts, W27b); the copy cases add extra assertions:
 * sha256 of the copy matches the original, page location.href is the new path, and no
 * performance resource entry points back at the original path.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReplayHtml } from "../src/exports/html/replay/build.ts";
import {
	buildSmallSession,
	CONTAINER,
	chromeInstall,
	EXPORT_PREFS,
	ExportCdpBrowser,
	expectAllPass,
	gated,
	runScenario,
	SMALL_NAME,
	writeExportHtml,
} from "./fixtures/export-replay-browser/harness.ts";

// ---------------------------------------------------------------- scenarios

const launchedPids: number[] = [];

function sha256OfFile(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Copies the export into a fresh directory (Chinese + spaces) under a renamed file (Chinese + spaces). */
function copyToRenamedDir(originalPath: string): string {
	const copiedDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "别的 电脑 目录-"));
	const copiedPath = join(copiedDir, "改名后的 导出 文件.html");
	copyFileSync(originalPath, copiedPath);
	return copiedPath;
}

/** Opens the copied file in a fresh browser and checks location + resource entries. */
async function verifyCopiedPage(
	label: string,
	copiedPath: string,
	originalPath: string,
	offline: boolean,
): Promise<void> {
	const kind: "chrome" | "edge" = chromeInstall?.kind === "edge" ? "edge" : "chrome";
	const profileDir = mkdtempSync(
		join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), `w27d-verify-${label.replace(/[^a-z0-9]+/gi, "-")}-`),
	);
	const browser = new ExportCdpBrowser(kind, chromeInstall?.executable ?? "", profileDir, offline);
	try {
		await browser.start();
		const expectedUrl = pathToFileURL(copiedPath).href;
		const opened = await browser.open(expectedUrl, `${CONTAINER} > *`, 120_000, 4_000);
		expect(opened, `[${label}] copied page opened`).toBe(true);
		const href = await browser.evaluate<string>("location.href");
		console.log(`[${label}] location.href=${href}`);
		console.log(`[${label}] expected=${expectedUrl}`);
		expect(href, `[${label}] location.href 是新路径`).toBe(expectedUrl);
		const resources = await browser.evaluate<string[]>(
			`performance.getEntriesByType("resource").map(function (r) { return r.name })`,
		);
		console.log(`[${label}] resources=${JSON.stringify(resources)}`);
		const originalFileUrl = pathToFileURL(originalPath).href;
		const originalDirUrl = pathToFileURL(dirname(originalPath)).href;
		const originalBase = basename(originalPath);
		for (const name of resources) {
			expect(
				name.includes(originalFileUrl) || name.includes(originalDirUrl) || name.includes(originalBase),
				`[${label}] resource 不指向原路径：${name}`,
			).toBe(false);
		}
	} finally {
		await browser.close();
	}
}

describe("web export replay copy browser e2e", () => {
	let rootDir = "";
	let smallHtmlPath = "";

	beforeAll(async () => {
		if (!gated) return;
		rootDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "w27d-export-e2e-"));
		const sm = buildSmallSession(rootDir);
		const smallHtml = await buildReplayHtml({ sessionManager: sm, prefs: EXPORT_PREFS, name: SMALL_NAME });
		smallHtmlPath = writeExportHtml(rootDir, "small-export.html", smallHtml);
	}, 240_000);

	afterAll(async () => {
		void launchedPids;
	});

	it.skipIf(!gated)(
		"small-offline passes the full 41-assertion table with CDP offline",
		async () => {
			expect(smallHtmlPath).not.toBe("");
			const results = await runScenario("small-offline", smallHtmlPath, {
				offline: true,
				expectedName: SMALL_NAME,
			});
			expectAllPass("small-offline", results);
		},
		240_000,
	);

	it.skipIf(!gated)(
		"small-copied-renamed-online passes the full 41-assertion table from a copied and renamed file",
		async () => {
			expect(smallHtmlPath).not.toBe("");
			const copiedPath = copyToRenamedDir(smallHtmlPath);
			const originalHash = sha256OfFile(smallHtmlPath);
			const copiedHash = sha256OfFile(copiedPath);
			console.log(`[small-copied-renamed-online] sha256 原文件=${originalHash}`);
			console.log(`[small-copied-renamed-online] sha256 复制后=${copiedHash}`);
			expect(copiedHash, "复制后文件 sha256 与原文件一致").toBe(originalHash);
			const results = await runScenario("small-copied-renamed-online", copiedPath, {
				offline: false,
				expectedName: SMALL_NAME,
			});
			expectAllPass("small-copied-renamed-online", results);
			await verifyCopiedPage("small-copied-renamed-online", copiedPath, smallHtmlPath, false);
		},
		240_000,
	);

	it.skipIf(!gated)(
		"small-copied-renamed-offline passes the full 41-assertion table from a copied and renamed file with CDP offline",
		async () => {
			expect(smallHtmlPath).not.toBe("");
			const copiedPath = copyToRenamedDir(smallHtmlPath);
			const originalHash = sha256OfFile(smallHtmlPath);
			const copiedHash = sha256OfFile(copiedPath);
			console.log(`[small-copied-renamed-offline] sha256 原文件=${originalHash}`);
			console.log(`[small-copied-renamed-offline] sha256 复制后=${copiedHash}`);
			expect(copiedHash, "复制后文件 sha256 与原文件一致").toBe(originalHash);
			const results = await runScenario("small-copied-renamed-offline", copiedPath, {
				offline: true,
				expectedName: SMALL_NAME,
			});
			expectAllPass("small-copied-renamed-offline", results);
			await verifyCopiedPage("small-copied-renamed-offline", copiedPath, smallHtmlPath, true);
		},
		240_000,
	);
});
