/**
 * W26b — HTML export size limit tests.
 *
 * The replay always embeds the complete raw session JSONL and never silently
 * truncates it: at or below the limit the export is unchanged, above the limit
 * buildReplayHtml throws ReplayExportTooLargeError and the Web export route
 * answers HTTP 413 with a clear message.
 *
 * Boundary tests inject a tiny maxJsonlBytes instead of building a real
 * multi-megabyte session.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildReplayHtml, EXPORT_MAX_JSONL_BYTES } from "../src/exports/html/replay/build.ts";
import { buildExportTooLargeBody, formatMib, ReplayExportTooLargeError } from "../src/exports/html/replay/limits.ts";
import { DATA_ELEMENT_ID } from "../src/exports/html/replay/shell.ts";

describe("buildReplayHtml size limit", () => {
	let sessionFilePath: string;
	let rawJsonlContent: string;
	let jsonlBytes: number;

	beforeAll(() => {
		const tempDirectory = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "w26b-test-replay-limit-"));
		sessionFilePath = join(tempDirectory, "test-session.jsonl");

		const now = new Date().toISOString();
		const entries = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-w26b-limit-test",
				timestamp: now,
				cwd: "C:/test/workspace",
				mode: "coding",
			}),
			JSON.stringify({
				type: "session_info",
				id: "info-01",
				parentId: null,
				timestamp: now,
				name: "W26b limit boundary session",
			}),
			JSON.stringify({
				type: "message",
				id: "msg-user-1",
				parentId: "info-01",
				timestamp: now,
				message: {
					role: "user",
					content: [{ type: "text", text: "boundary marker alpha-7k2" }],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "msg-asst-1",
				parentId: "msg-user-1",
				timestamp: now,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "boundary marker beta-9q4" }],
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { total: 0 },
					},
				},
			}),
		];

		rawJsonlContent = `${entries.join("\n")}\n`;
		jsonlBytes = Buffer.byteLength(rawJsonlContent, "utf8");
		writeFileSync(sessionFilePath, rawJsonlContent, "utf8");
	});

	function extractRawJsonl(html: string): string {
		const match = new RegExp(`<script id="${DATA_ELEMENT_ID}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
		if (!match?.[1]) throw new Error("export data element not found in HTML");
		return (JSON.parse(match[1]) as { rawJsonl: string }).rawJsonl;
	}

	it("keeps the default limit at the W26a measured value (30 MiB)", () => {
		expect(EXPORT_MAX_JSONL_BYTES).toBe(30 * 1024 * 1024);
	});

	it("exports fully when the session is one byte below the limit", async () => {
		const html = await buildReplayHtml({ sessionFile: sessionFilePath, maxJsonlBytes: jsonlBytes + 1 });
		expect(extractRawJsonl(html)).toBe(rawJsonlContent);
	});

	it("exports fully when the session is exactly at the limit", async () => {
		const html = await buildReplayHtml({ sessionFile: sessionFilePath, maxJsonlBytes: jsonlBytes });
		expect(extractRawJsonl(html)).toBe(rawJsonlContent);
	});

	it("throws ReplayExportTooLargeError one byte above the limit", async () => {
		let caught: unknown;
		try {
			await buildReplayHtml({ sessionFile: sessionFilePath, maxJsonlBytes: jsonlBytes - 1 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ReplayExportTooLargeError);
		const tooLarge = caught as ReplayExportTooLargeError;
		expect(tooLarge.bytes).toBe(jsonlBytes);
		expect(tooLarge.limit).toBe(jsonlBytes - 1);
	});

	it("succeeds with the default limit for an ordinary small session", async () => {
		const html = await buildReplayHtml({ sessionFile: sessionFilePath });
		expect(extractRawJsonl(html)).toBe(rawJsonlContent);
	});
});

describe("export too large response body", () => {
	it("formats MiB with one decimal place", () => {
		expect(formatMib(30 * 1024 * 1024)).toBe("30.0");
		expect(formatMib(1572864)).toBe("1.5");
	});

	it("carries code, bytes, limit and actionable advice", () => {
		const body = buildExportTooLargeBody(new ReplayExportTooLargeError(1572864, 30 * 1024 * 1024));
		expect(body.code).toBe("export_too_large");
		expect(body.bytes).toBe(1572864);
		expect(body.limit).toBe(30 * 1024 * 1024);
		expect(body.error).toContain("1.5 MiB");
		expect(body.error).toContain("30.0 MiB");
		expect(body.error).toContain("Start a new chat");
	});
});
