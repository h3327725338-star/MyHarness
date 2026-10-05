import { estimateTextTokens } from "@myharness/ai";
import { expect, it, vi } from "vitest";
import { generateAICommitMessage } from "../src/git/commits/ai-message.ts";

const final = JSON.stringify({
	title: "feat: connect interface and caller",
	body: ["- Update interface, caller and tests together"],
});
function analysis(input: Record<string, any>) {
	const items = input.chunks ?? input.summaries;
	const sources = input.chunks
		? items.map((item: any) => item.id)
		: items.flatMap((item: any) => item.features.flatMap((feature: any) => feature.sources));
	return JSON.stringify({
		covered: items.map((item: any) => item.id),
		features: [{ description: "Related interface and caller changes", sources: [...new Set(sources)] }],
		uncertainties: [],
	});
}
const large = {
	paths: ["src/api.ts", "src/api.test.ts", "src/client.ts"],
	history: "feat: history",
	diff: ["api", "api.test", "client"]
		.map(
			(name) =>
				`diff --git a/src/${name}.ts b/src/${name}.ts\n@@ -1 +1 @@\n-${"old interface\n".repeat(1000)}+${"new interface\n".repeat(1000)}`,
		)
		.join(""),
};

it("analyzes all large-diff fragments, retains evidence, and bounds every request", async () => {
	const received: any[] = [];
	const complete = vi.fn(async (prompt: string, text: string) => {
		expect(estimateTextTokens(prompt) + estimateTextTokens(text)).toBeLessThanOrEqual(
			Math.floor(16384 * 0.65) - 4096 - 1024,
		);
		const input = JSON.parse(text);
		received.push(input);
		return input.stage === "analyze" || input.stage === "merge" ? analysis(input) : final;
	});
	const result = await generateAICommitMessage(large, complete);
	expect(result.full).toContain("Update interface, caller and tests");
	const chunks = received.filter((input) => input.stage === "analyze").flatMap((input) => input.chunks);
	expect(chunks.map((chunk) => chunk.text).join("")).toBe(large.diff);
	expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
	for (const chunk of chunks) expect(chunk.end - chunk.start).toBe(chunk.text.length);
	expect(received.at(-1).stage).toBe("synthesize");
	expect(received[0].overview.paths).toEqual(large.paths);
});
it("reads requested original evidence before final synthesis", async () => {
	let requested = false;
	let source: string;
	const complete = vi.fn(async (_prompt: string, text: string) => {
		const input = JSON.parse(text);
		if (input.stage === "analyze" || input.stage === "merge") return analysis(input);
		if (!requested) {
			requested = true;
			source = input.summaries[0].features[0].sources[0];
			return JSON.stringify({ read: [source] });
		}
		return final;
	});
	await generateAICommitMessage(large, complete);
	const inputs = complete.mock.calls.map(([, text]) => JSON.parse(text));
	expect(inputs.filter((input) => input.stage === "synthesize")).toHaveLength(2);
	expect(
		inputs.filter((input) => input.stage === "analyze" && input.chunks.some((chunk: any) => chunk.id === source)),
	).toHaveLength(2);
});
it("stops on an omitted fragment instead of generating a partial commit message", async () => {
	await expect(
		generateAICommitMessage(large, async () => JSON.stringify({ covered: [], features: [], uncertainties: [] })),
	).rejects.toThrow("omitted evidence");
});
it("rejects summaries that acknowledge chunks but drop their evidence", async () => {
	await expect(
		generateAICommitMessage(large, async (_prompt, text) => {
			const input = JSON.parse(text);
			const result = JSON.parse(analysis(input));
			result.features[0].sources = [result.covered[0]];
			return JSON.stringify(result);
		}),
	).rejects.toThrow("dropped a diff source");
});
it("merges oversized summaries hierarchically without losing source references", async () => {
	const context = { ...large, diff: large.diff.repeat(5) };
	const stages: string[] = [];
	await generateAICommitMessage(context, async (_prompt, text) => {
		const input = JSON.parse(text);
		stages.push(input.stage);
		if (input.stage === "synthesize") return final;
		const result = JSON.parse(analysis(input));
		if (input.stage === "analyze") result.features[0].description = "evidence detail ".repeat(500);
		return JSON.stringify(result);
	});
	expect(stages).toContain("merge");
	expect(stages.at(-1)).toBe("synthesize");
});
it("stops if a batch fails", async () => {
	await expect(
		generateAICommitMessage(large, async () => {
			throw new Error("provider failed");
		}),
	).rejects.toThrow("provider failed");
});
it("honors cancellation between requests", async () => {
	const controller = new AbortController();
	const complete = vi.fn(async (_prompt: string, text: string) => {
		controller.abort();
		return analysis(JSON.parse(text));
	});
	await expect(generateAICommitMessage(large, complete, { signal: controller.signal })).rejects.toThrow();
	expect(complete).toHaveBeenCalledTimes(1);
});
it("uses the model window rather than a fixed diff-size limit", async () => {
	const context = { paths: ["large.ts"], diff: "x".repeat(301 * 1024), history: "history" };
	const complete = vi.fn().mockResolvedValue(final);
	await generateAICommitMessage(context, complete, { contextWindow: 1_000_000 });
	expect(complete).toHaveBeenCalledTimes(1);
});
it("rejects unknown raw-evidence references", async () => {
	await expect(
		generateAICommitMessage(large, async (_prompt, text) => {
			const input = JSON.parse(text);
			return input.stage === "analyze" || input.stage === "merge"
				? analysis(input)
				: JSON.stringify({ read: ["unknown"] });
		}),
	).rejects.toThrow("invalid diff references");
});
