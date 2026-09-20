import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CustomMessage, convertToLlm } from "../../src/agent/runtime/messages.ts";
import {
	type CustomMessageEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "../../src/session/manager/index.ts";

describe("Custom message persistence", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("round-trips display, customType, details, and excludeFromContext through JSONL", () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-ar4-session-"));
		tempDirs.push(directory);
		const session = SessionManager.create(directory, directory);
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const cycleDetails = { schemaVersion: 1, status: "fail", finalVerdict: false };
		const finalDetails = { schemaVersion: 1, status: "pass", finalVerdict: true };
		session.appendCustomMessageEntry("Auto Review 1/1", "cycle report", true, cycleDetails, true);
		session.appendCustomMessageEntry("ordinary-note", "ordinary context", false, { note: 1 });
		session.appendCustomMessageEntry("Auto Review Final Verdict", "final report", true, finalDetails);
		session.appendMessage(fauxAssistantMessage("done"));

		const file = session.getSessionFile();
		expect(file).toBeDefined();
		const reloaded = SessionManager.open(file!, directory);
		const customEntries = reloaded
			.getEntries()
			.filter((entry): entry is CustomMessageEntry => entry.type === "custom_message");

		const cycleEntry = customEntries.find((entry) => entry.customType === "Auto Review 1/1");
		const ordinaryEntry = customEntries.find((entry) => entry.customType === "ordinary-note");
		const finalEntry = customEntries.find((entry) => entry.customType === "Auto Review Final Verdict");
		expect(cycleEntry).toMatchObject({ display: true, excludeFromContext: true, details: cycleDetails });
		expect(ordinaryEntry).toMatchObject({ display: false });
		expect(ordinaryEntry).not.toHaveProperty("excludeFromContext");
		expect(finalEntry).toMatchObject({ display: true, details: finalDetails });

		const cycleMessage = sessionEntryToContextMessages(cycleEntry!)[0] as CustomMessage;
		expect(cycleMessage.excludeFromContext).toBe(true);
		expect(cycleMessage.display).toBe(true);
		const finalMessage = sessionEntryToContextMessages(finalEntry!)[0] as CustomMessage;
		expect(finalMessage.customType).toBe("Auto Review Final Verdict");
		expect(finalMessage.details).toEqual(finalDetails);

		const llmMessages = convertToLlm(reloaded.buildSessionContext().messages);
		const llmText = llmMessages
			.flatMap((message) =>
				typeof message.content === "string"
					? [message.content]
					: message.content.map((part) => (part.type === "text" ? part.text : "")),
			)
			.join("\n");
		expect(llmText).not.toContain("cycle report");
		expect(llmText).toContain("ordinary context");
		expect(llmText).toContain("final report");
	});

	it("old custom_message entries without the flag keep the old context behavior", () => {
		const entry: CustomMessageEntry = {
			type: "custom_message",
			id: "old-custom",
			parentId: null,
			timestamp: "2025-01-01T00:00:00.000Z",
			customType: "old-message",
			content: "old content",
			display: true,
		};
		const [message] = sessionEntryToContextMessages(entry) as [CustomMessage];
		expect(message.excludeFromContext).toBeUndefined();
		expect(convertToLlm([message])).toHaveLength(1);
	});
});
