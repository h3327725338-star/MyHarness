import { describe, expect, it, vi } from "vitest";
import { generateAICommitMessage } from "../src/git/commits/ai-message.ts";
import { buildDirectCommitMessage } from "../src/git/commits/message.ts";
import {
	INVALID_MODEL_JSON,
	ModelJsonError,
	normalizeModelJson,
	parseModelJson,
	parseModelJsonWithRepair,
} from "../src/git/commits/model-json.ts";
import { reviewWithInstructions } from "../src/git/commits/review.ts";

const small = { paths: ["a.ts"], history: "feat: history", diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n" };

describe("model JSON", () => {
	it("drops a Markdown fence and text around the object", () => {
		expect(parseModelJson('Here it is:\n```json\n{"title":"t","body":["b"]}\n```')).toEqual({
			title: "t",
			body: ["b"],
		});
		expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it("repairs escapes JSON does not have and raw line breaks inside strings", () => {
		// The real failure of 2026-10-26: `\<` inside a long Chinese body.
		expect(parseModelJson('{"body":["按 sourceSessionId\\<空格\\> 判断"]}')).toEqual({
			body: ["按 sourceSessionId<空格> 判断"],
		});
		expect(parseModelJson('{"title":"a\nb\tc"}')).toEqual({ title: "a\nb\tc" });
		// Valid escapes stay as they are.
		expect(parseModelJson('{"a":"x\\"y\\\\z\\u00e9\\n"}')).toEqual({ a: 'x"y\\zé\n' });
		expect(normalizeModelJson('{"a":"\\u12"}')).toBe('{"a":"u12"}');
	});

	it("explains a malformed answer with the text around the parser's position", () => {
		const answer = `{"title":"t","body":["${"x".repeat(3000)}" "y"]}`;
		const error = (() => {
			try {
				parseModelJson(answer);
			} catch (caught) {
				return caught as ModelJsonError;
			}
		})()!;
		expect(error).toBeInstanceOf(ModelJsonError);
		expect(error.message.split("\n")[0]).toBe(INVALID_MODEL_JSON);
		expect(error.message).toContain("Around position");
		expect(error.message).toContain('" "y"');
	});

	it("asks the model once to fix an answer that is still not JSON", async () => {
		const complete = vi.fn().mockResolvedValue('{"title":"fixed","body":["b"]}');
		await expect(parseModelJsonWithRepair('{"title":"t" "body":[]}', complete)).resolves.toEqual({
			title: "fixed",
			body: ["b"],
		});
		expect(complete).toHaveBeenCalledTimes(1);
		const [prompt, input] = complete.mock.calls[0]!;
		expect(prompt).toContain("parser rejected it");
		expect(JSON.parse(input)).toMatchObject({ answer: '{"title":"t" "body":[]}' });
	});

	it("keeps the first answer for the details when the fix is not JSON either", async () => {
		const complete = vi.fn().mockResolvedValue("still not json");
		const error = await parseModelJsonWithRepair('{"title":"t" "body":[]}', complete).catch((caught) => caught);
		expect(error).toBeInstanceOf(ModelJsonError);
		expect((error as Error).message).toContain('{"title":"t" "body":[]}');
	});
});

describe("commit description", () => {
	it("succeeds on the answer that failed before (an invalid escape)", async () => {
		const answer = '{"title":"feat: 删除对话","body":["- 按 sourceSessionId\\<空格\\> 判断"]}';
		const message = await generateAICommitMessage(small, async () => answer);
		expect(message.title).toBe("feat: 删除对话");
		expect(message.body).toEqual(["- 按 sourceSessionId<空格> 判断"]);
	});

	it("keeps a body entry the model broke over several lines", async () => {
		const answer = JSON.stringify({ title: "feat: one", body: ["- a\n- b"] });
		const message = await generateAICommitMessage(small, async () => answer);
		expect(message.title).toBe("feat: one");
		expect(message.body).toEqual(["- a", "- b"]);
	});

	it("passes the user's commit instructions to the description request", async () => {
		const complete = vi.fn().mockResolvedValue(JSON.stringify({ title: "t", body: ["b"] }));
		await generateAICommitMessage(small, complete, { instructions: "Write in French." });
		expect(complete.mock.calls[0]![0]).toContain(
			"<user_commit_instructions>\nWrite in French.\n</user_commit_instructions>",
		);
		complete.mockClear();
		await generateAICommitMessage(small, complete, { instructions: "  " });
		expect(complete.mock.calls[0]![0]).not.toContain("user_commit_instructions");
	});
});

describe("checks against the user's instructions", () => {
	it("checks nothing without instructions", async () => {
		const complete = vi.fn();
		await expect(reviewWithInstructions(small, "commit", "  ", complete)).resolves.toEqual({ fixCi: false });
		expect(complete).not.toHaveBeenCalled();
	});

	it("stops with the model's reason, or continues with the CI wish", async () => {
		const stop = vi.fn().mockResolvedValue('{"stop":"a.ts holds an API key (sk-1…)","fixCi":false}');
		await expect(reviewWithInstructions(small, "commit", "No secrets.", stop)).resolves.toEqual({
			stop: "a.ts holds an API key (sk-1…)",
			fixCi: false,
		});
		expect(stop.mock.calls[0]![0]).toContain("<user_instructions>\nNo secrets.\n</user_instructions>");
		expect(JSON.parse(stop.mock.calls[0]![1])).toMatchObject({ operation: "commit", paths: ["a.ts"] });
		const go = vi.fn().mockResolvedValue('{"stop":false,"fixCi":true}');
		await expect(reviewWithInstructions(small, "push", "CI must pass.", go)).resolves.toEqual({ fixCi: true });
	});

	it("checks a large change part by part and ends at the first stop", async () => {
		const large = {
			paths: ["a.ts", "b.ts", "c.ts"],
			history: "",
			diff: ["a", "b", "c"]
				.map((name) => `diff --git a/${name}.ts b/${name}.ts\n@@ -1 +1 @@\n+${"line\n".repeat(3000)}`)
				.join(""),
		};
		const complete = vi.fn(async (_prompt: string, input: string) => {
			const part = JSON.parse(input);
			return part.part?.startsWith("2/")
				? '{"stop":"b.ts: password","fixCi":false}'
				: '{"stop":false,"fixCi":false}';
		});
		const review = await reviewWithInstructions(large, "commit", "No secrets.", complete, { contextWindow: 16_384 });
		expect(review.stop).toBe("b.ts: password");
		expect(complete.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(JSON.parse(complete.mock.calls.at(-1)![1]).part).toMatch(/^2\//u);
	});

	it("rejects an answer that is neither a stop nor a go", async () => {
		await expect(reviewWithInstructions(small, "commit", "x", async () => '{"stop":12}')).rejects.toThrow(
			"invalid result",
		);
	});
});

describe("direct commit message", () => {
	it("describes the diff without a model: paths, status, counts and symbols", () => {
		const message = buildDirectCommitMessage({
			paths: ["src/app.ts", "src/gone.ts", "notes/new.md"],
			diff: [
				"diff --git a/src/app.ts b/src/app.ts\nindex 1..2 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+export function start() {}\n",
				"diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
				'\nNew file "notes/new.md":\n# Notes\n\nhello\n',
			].join(""),
		});
		expect(message.body).toContain("- M src/app.ts (+1/-1)");
		expect(message.body).toContain("  - start()");
		expect(message.body).toContain("- D src/gone.ts (+0/-1)");
		expect(message.body).toContain("- A notes/new.md (+2/-0)");
		expect(message.full.startsWith(`${message.title}\n\n`)).toBe(true);
	});

	it("lists a path the diff has no section for instead of dropping it", () => {
		const message = buildDirectCommitMessage({ paths: ["bin.dat"], diff: "" });
		expect(message.body).toEqual(["- M bin.dat"]);
	});
});
