import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/session/manager/index.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function message(role: "user" | "assistant", text: string, id: string, parentId: string | null, at: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(at).toISOString(),
		message: { role, content: [{ type: "text", text }], timestamp: at },
	};
}

describe("listing sessions reads each file once and then only what was appended", () => {
	it("keeps counts, first message, name and search text right while the file grows and when it is rewritten", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-list-incremental-"));
		roots.push(root);
		const file = join(root, "s1.jsonl");
		const header = { type: "session", id: "s1", version: 3, timestamp: new Date(1000).toISOString(), cwd: root };
		writeFileSync(
			file,
			`${JSON.stringify(header)}\n${JSON.stringify(message("user", "alpha question", "a1", null, 2000))}\n`,
		);

		const list = async () => (await SessionManager.list(root, root)).find((info) => info.path === file)!;
		let info = await list();
		expect(info.messageCount).toBe(1);
		expect(info.firstMessage).toBe("alpha question");
		expect(info.modified.getTime()).toBe(2000);

		// Unchanged file: the same answer, and the returned object is the caller's own.
		const again = await list();
		expect(again).toEqual(info);
		again.firstMessage = "changed by a caller";
		expect((await list()).firstMessage).toBe("alpha question");

		// The file grows: only the new lines are added to what is known.
		appendFileSync(
			file,
			`${JSON.stringify(message("assistant", "beta answer", "a2", "a1", 3000))}\n${JSON.stringify({ type: "session_info", id: "n1", parentId: "a2", timestamp: new Date(3100).toISOString(), name: "Named" })}\n`,
		);
		info = await list();
		expect(info.messageCount).toBe(2);
		expect(info.name).toBe("Named");
		expect(info.allMessagesText).toBe("alpha question beta answer");
		expect(info.modified.getTime()).toBe(3000);

		// A half-written last line is not counted until it is complete.
		appendFileSync(
			file,
			`{"type":"message","id":"a3","parentId":"a2","timestamp":"${new Date(4000).toISOString()}","message":{"role":"user"`,
		);
		expect((await list()).messageCount).toBe(2);
		appendFileSync(file, `,"content":[{"type":"text","text":"gamma"}],"timestamp":4000}}\n`);
		info = await list();
		expect(info.messageCount).toBe(3);
		expect(info.allMessagesText).toBe("alpha question beta answer gamma");

		// The file is replaced by a different, longer one: nothing of the old scan is kept.
		const replaced = [
			header,
			message(
				"user",
				"omega question that is long enough to make this file longer than the old one",
				"b1",
				null,
				5000,
			),
			message(
				"assistant",
				"omega answer, also long enough to keep the new file bigger than the old one was",
				"b2",
				"b1",
				6000,
			),
			message("user", "more", "b3", "b2", 7000),
			message("assistant", "more again", "b4", "b3", 8000),
		];
		rmSync(file);
		writeFileSync(file, replaced.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
		info = await list();
		expect(info.messageCount).toBe(4);
		expect(info.firstMessage.startsWith("omega question")).toBe(true);
		expect(info.name).toBeUndefined();
	});

	it("marks a file with nothing but the setup written at creation as blank, until anything else is written", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-list-blank-"));
		roots.push(root);
		const header = { type: "session", id: "b1", version: 3, timestamp: new Date(1000).toISOString(), cwd: root };
		const setup = [
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: new Date(1001).toISOString(),
				provider: "p",
				modelId: "m",
			},
			{
				type: "thinking_level_change",
				id: "t1",
				parentId: "m1",
				timestamp: new Date(1002).toISOString(),
				thinkingLevel: "medium",
			},
		];
		const lines = (entries: unknown[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
		const list = async (file: string) => (await SessionManager.list(root, root)).find((info) => info.path === file)!;

		const file = join(root, "b1.jsonl");
		writeFileSync(file, lines([header, ...setup]));
		let info = await list(file);
		expect(info.messageCount).toBe(0);
		expect(info.blank).toBe(true);

		// A half-written line says nothing yet: the file is still blank until it is complete.
		appendFileSync(file, `{"type":"message","id":"a1","parentId":"t1"`);
		expect((await list(file)).blank).toBe(true);
		appendFileSync(
			file,
			`,"timestamp":"${new Date(2000).toISOString()}","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n`,
		);
		info = await list(file);
		expect(info.messageCount).toBe(1);
		expect(info.blank).toBe(false);

		// Anything a person or an operation made keeps a chat from being blank, whatever else it holds.
		const others: Record<string, unknown> = {
			name: {
				type: "session_info",
				id: "n1",
				parentId: "t1",
				timestamp: new Date(3000).toISOString(),
				name: "Named",
			},
			"operation card": {
				type: "custom",
				id: "c1",
				parentId: "t1",
				timestamp: new Date(3000).toISOString(),
				customType: "web-git-status",
				data: {},
			},
			label: {
				type: "label",
				id: "l1",
				parentId: "t1",
				timestamp: new Date(3000).toISOString(),
				targetId: "t1",
				label: "x",
			},
		};
		for (const [name, entry] of Object.entries(others)) {
			const other = join(root, `other-${name.replace(/\W/g, "")}.jsonl`);
			writeFileSync(other, lines([{ ...header, id: `o-${name}` }, ...setup, entry]));
			expect((await list(other)).blank, name).toBe(false);
		}
		// A line this reader does not understand is not "nothing".
		const odd = join(root, "odd.jsonl");
		writeFileSync(odd, `${lines([{ ...header, id: "odd" }, ...setup])}not json at all\n`);
		expect((await list(odd)).blank).toBe(false);
	});
});
