/**
 * W27c — HTML export step 5: big-session (70+ turns, a few MB) browser end-to-end tests.
 *
 * Runs only with MYHARNESS_TARGETED_BROWSER_E2E=1 and a local Chrome/Edge (CDP pipe);
 * otherwise every case is skipped (existing convention from web-number-unit-settings-browser.test.ts).
 *
 * Builds the big session with buildBigSession (fixtures/export-replay-browser/big-session.ts),
 * assembles the standalone replay with buildReplayHtml, opens the file via file:// in a real
 * Chrome with a brand-new --user-data-dir per scenario, and runs the 41-assertion table from
 * the shared harness (fixtures/export-replay-browser/harness.ts, W27b) — once online and once
 * with emulated offline network. The big session exceeds the transcript's 60-turn first-screen
 * limit so the "show earlier messages" paging and both summary markers get covered.
 */

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildReplayHtml } from "../src/exports/html/replay/build.ts";
import { BIG_NAME, buildBigSession } from "./fixtures/export-replay-browser/big-session.ts";
import {
	EXPORT_PREFS,
	expectAllPass,
	gated,
	runScenario,
	writeExportHtml,
} from "./fixtures/export-replay-browser/harness.ts";

// ---------------------------------------------------------------- scenarios

describe("web export replay big browser e2e", () => {
	let rootDir = "";
	let bigHtmlPath = "";
	let bigHtml = "";

	beforeAll(async () => {
		if (!gated) return;
		rootDir = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "w27c-export-big-e2e-"));
		const sm = buildBigSession(rootDir);
		const started = Date.now();
		bigHtml = await buildReplayHtml({ sessionManager: sm, prefs: EXPORT_PREFS, name: BIG_NAME });
		const buildMs = Date.now() - started;
		bigHtmlPath = writeExportHtml(rootDir, "big-export.html", bigHtml);
		const sessionFile = sm.getSessionFile();
		const jsonlBytes = sessionFile ? statSync(sessionFile).size : -1;
		let users = 0;
		let standalone = 0;
		for (const entry of sm.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") users++;
			else if (
				entry.type === "compaction" ||
				entry.type === "branch_summary" ||
				entry.type === "custom" ||
				entry.type === "custom_message" ||
				(entry.type === "message" && entry.message.role === "bashExecution")
			)
				standalone++;
		}
		console.log(
			`[big-fixture] users=${users} standalone≈${standalone} turns≈${users + standalone} jsonl=${jsonlBytes}B html=${bigHtml.length}B buildMs=${buildMs} sessionFile=${sessionFile ?? "(missing)"}`,
		);
	}, 240_000);

	it.skipIf(!gated)(
		"big session opened online passes the full 41-assertion table (big-online)",
		async () => {
			expect(bigHtmlPath).not.toBe("");
			const results = await runScenario("big-online", bigHtmlPath, { offline: false, expectedName: BIG_NAME });
			expectAllPass("big-online", results);
		},
		240_000,
	);

	it.skipIf(!gated)(
		"big session opened offline passes the full 41-assertion table (big-offline)",
		async () => {
			expect(bigHtmlPath).not.toBe("");
			const results = await runScenario("big-offline", bigHtmlPath, { offline: true, expectedName: BIG_NAME });
			expectAllPass("big-offline", results);
		},
		240_000,
	);
});
