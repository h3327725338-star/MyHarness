import { buildCodexCompactedHistory, CODEX_SUMMARY_PREFIX } from "@myharness/agent-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction, shouldCompact } from "../src/context/compact/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";

describe("Codex compaction preparation and history", () => {
	it("uses the Codex model default trigger, independent of old reserves", () => {
		expect(shouldCompact(89999, 100000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(90000, 100000, { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 1 })).toBe(true);
		expect(shouldCompact(100000, 100000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false })).toBe(false);
	});
	it("prepares all active messages and does not retain a raw assistant/tool tail", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "original", timestamp: 1 });
		session.appendMessage({ role: "user", content: "latest", timestamp: 2 });
		const preparation = prepareCompaction(session.getBranch(), DEFAULT_COMPACTION_SETTINGS)!;
		expect(preparation.messagesToSummarize).toEqual(session.buildSessionContext().messages);
		const replacement = buildCodexCompactedHistory(preparation.messagesToSummarize, "checkpoint");
		session.appendCompaction(
			"checkpoint",
			preparation.firstKeptEntryId,
			preparation.tokensBefore,
			undefined,
			false,
			undefined,
			undefined,
			true,
			replacement,
		);
		expect(session.buildSessionContext().messages).toEqual(replacement);
		expect(JSON.stringify(replacement.at(-1))).toContain(CODEX_SUMMARY_PREFIX);
	});
	it("prepares a checkpoint again and carries its summary as ordinary source context", () => {
		const session = SessionManager.inMemory();
		const id = session.appendMessage({ role: "user", content: "task", timestamp: 1 });
		const replacement = buildCodexCompactedHistory(session.buildSessionContext().messages, "previous");
		session.appendCompaction("previous", id, 100, undefined, false, undefined, undefined, true, replacement);
		const preparation = prepareCompaction(session.getBranch(), DEFAULT_COMPACTION_SETTINGS)!;
		expect(preparation.messagesToSummarize).toEqual(replacement);
		const next = buildCodexCompactedHistory(preparation.messagesToSummarize, "next");
		expect(next).toHaveLength(2);
		expect(JSON.stringify(next)).not.toContain("previous");
	});
	it("has nothing to compact in a new session", () => {
		expect(prepareCompaction(SessionManager.inMemory().getBranch(), DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});
});
