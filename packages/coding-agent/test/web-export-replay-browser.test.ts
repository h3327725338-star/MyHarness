/**
 * W25 — HTML export step 5: offline-opened browser end-to-end main tests.
 *
 * Runs only with MYHARNESS_TARGETED_BROWSER_E2E=1 and a local Chrome/Edge (CDP pipe);
 * otherwise every case is skipped (existing convention from web-number-unit-settings-browser.test.ts).
 *
 * Builds small and big sessions with SessionManager, assembles the standalone replay with
 * buildReplayHtml, opens the file via file:// in a real Chrome with a brand-new
 * --user-data-dir per scenario, and runs the 41-assertion table prototyped in
 * data/webui-2026-10-11/export-spike/verify-export.mjs (ported here; the spike directory is
 * not part of the repo and is never referenced at runtime).
 *
 * Console/network events are collected with a small CDP helper from the shared harness
 * (fixtures/export-replay-browser/harness.ts, W27b): it borrows CdpBridge's private
 * send()/onEvent() at runtime, like the spike did, without touching src.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReplayHtml } from "../src/exports/html/replay/build.ts";
import {
	buildSmallSession,
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

describe("web export replay browser e2e", () => {
	let rootDir = "";
	let smallHtmlPath = "";
	let smallHtml = "";

	beforeAll(async () => {
		if (!gated) return;
		rootDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "w25-export-e2e-"));
		const sm = buildSmallSession(rootDir);
		smallHtml = await buildReplayHtml({ sessionManager: sm, prefs: EXPORT_PREFS, name: SMALL_NAME });
		smallHtmlPath = writeExportHtml(rootDir, "small-export.html", smallHtml);
	}, 240_000);

	afterAll(async () => {
		void launchedPids;
	});

	it.skipIf(!gated)(
		"small session opened online passes the full 41-assertion table",
		async () => {
			expect(smallHtmlPath).not.toBe("");
			const results = await runScenario("small-online", smallHtmlPath, { offline: false, expectedName: SMALL_NAME });
			expectAllPass("small-online", results);
		},
		240_000,
	);

	it.skipIf(!gated)(
		"read-only replay keeps outcome facts but hides retry and Git mutation actions",
		async () => {
			const profileDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "replay-outcome-"));
			const browser = new ExportCdpBrowser(
				chromeInstall?.kind === "edge" ? "edge" : "chrome",
				chromeInstall?.executable ?? "",
				profileDir,
				true,
			);
			try {
				await browser.start();
				expect(await browser.open(pathToFileURL(smallHtmlPath).href, ".banner.o-unanswered", 60_000, 500)).toBe(
					true,
				);
				const outcome = await browser.evaluate<{ facts: number; actions: number }>(
					"({ facts: document.querySelectorAll('.banner .banner-facts').length, actions: document.querySelectorAll('.banner-actions button').length })",
				);
				expect(outcome.facts).toBeGreaterThan(0);
				expect(outcome.actions, "offline outcome must not offer Retry or Undo/commit").toBe(0);
			} finally {
				await browser.close();
			}
		},
		120_000,
	);
});
