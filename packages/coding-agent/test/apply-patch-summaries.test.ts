import type { AgentMessage } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/context/compact/utils.ts";
import { describeRunWork, summarizeRunWork } from "../src/utils/popup-notification.ts";

const patch = [
	"*** Begin Patch",
	"*** Update File: src/a.ts",
	"@@",
	" keep",
	"-old",
	"+new",
	"*** Add File: b.ts",
	"+fresh",
	"*** Update File: c.ts",
	"*** Move to: d.ts",
	"*** Delete File: e.ts",
	"*** End Patch",
].join("\n");

const userMessage: AgentMessage = { role: "user", content: "patch the files", timestamp: 0 };

function applyPatchCall(text: string): AgentMessage {
	return fauxAssistantMessage([fauxToolCall("apply_patch", { patch: text })], { stopReason: "toolUse" });
}

describe("apply_patch in the run summaries", () => {
	it("names every file the patch touches, both ends of a move, in the popup summary", () => {
		const work = summarizeRunWork([userMessage, applyPatchCall(patch)]);

		expect(work.edited).toEqual(["src/a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
		expect(work.otherTools).toBe(0);
		expect(describeRunWork(work)).toBe("修改 5 个文件（a.ts、b.ts、c.ts 等）");
	});

	it("names nothing in the popup summary for a patch that does not parse", () => {
		const work = summarizeRunWork([userMessage, applyPatchCall("not a patch")]);

		expect(work.edited).toEqual([]);
		expect(work.otherTools).toBe(0);
		expect(describeRunWork(work)).toBeUndefined();
	});

	it("lists every file the patch touches as modified in the compaction file lists", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(applyPatchCall(patch), fileOps);

		expect(computeFileLists(fileOps)).toEqual({
			readFiles: [],
			modifiedFiles: ["b.ts", "c.ts", "d.ts", "e.ts", "src/a.ts"],
		});
	});

	it("records nothing in the compaction file lists for a patch that does not parse", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(applyPatchCall("not a patch"), fileOps);

		expect(computeFileLists(fileOps)).toEqual({ readFiles: [], modifiedFiles: [] });
	});
});
