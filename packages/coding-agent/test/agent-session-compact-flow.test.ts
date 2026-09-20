import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, SimpleStreamOptions } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const window = 256_000;
function seed(harness: Harness): void {
	for (const text of ["original work", "latest request"])
		harness.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() - 10000 });
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}
function internals(harness: Harness) {
	return harness.session as unknown as {
		_runAutoCompaction: (reason: "threshold" | "overflow", retry: boolean) => Promise<boolean>;
		_ensureContextBudget: () => Promise<{ status: string }>;
	};
}
function checkReleased(harness: Harness) {
	expect(harness.session.isCompacting).toBe(false);
	expect(harness.session.getRunStateSnapshot().state).not.toBe("recovering");
}
describe("Codex Compact lifecycle", () => {
	it.each([0.03, 0.12, 0.2, 0.95])(
		"commits exactly one successful compaction regardless of output fraction %s",
		async (ratio) => {
			const h = await createHarness({
				contextWindow: window,
				tools: [],
				responses: ["S".repeat(window * ratio * 4)],
			});
			try {
				seed(h);
				const result = await h.session.compact();
				expect(h.faux.callCount).toBe(1);
				expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
				expect(result).not.toHaveProperty("targetTokens");
				checkReleased(h);
			} finally {
				h.cleanup();
			}
		},
	);
	it("allows consecutive compactions and saves replacement history across restore", async () => {
		const h = await createHarness({ contextWindow: window, tools: [], responses: ["first", "second"] });
		const restored = await createHarness({ contextWindow: window, tools: [] });
		try {
			seed(h);
			await h.session.compact();
			await h.session.compact();
			expect(h.faux.callCount).toBe(2);
			expect(JSON.stringify(h.faux.contexts[1])).toContain("first");
			expect(JSON.stringify(h.agent.state.messages)).not.toContain("first");
			const file = join(restored.tempDir, "resume.jsonl");
			writeFileSync(
				file,
				[h.sessionManager.getHeader(), ...h.sessionManager.getEntries()].map((e) => JSON.stringify(e)).join("\n") +
					"\n",
			);
			restored.sessionManager.setSessionFile(file);
			expect(restored.sessionManager.buildSessionContext().messages).toEqual(h.agent.state.messages);
		} finally {
			h.cleanup();
			restored.cleanup();
		}
	});
	it("retries stream failures without committing intermediate checkpoints", async () => {
		const h = await createHarness({
			tools: [],
			responses: [{ error: "stream ended" }, { error: "stream ended" }, "summary"],
		});
		try {
			seed(h);
			await h.session.compact();
			expect(h.faux.callCount).toBe(3);
			expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
			checkReleased(h);
		} finally {
			h.cleanup();
		}
	});
	it("releases an empty session and permits a normal prompt", async () => {
		const h = await createHarness({ tools: [], responses: ["answer"] });
		try {
			await expect(h.session.compact()).rejects.toThrow("Nothing to compact");
			await h.session.prompt("start");
			expect(h.faux.callCount).toBe(1);
			checkReleased(h);
		} finally {
			h.cleanup();
		}
	});
	it("stops an active conversation before manual compaction without losing its events", async () => {
		const harness = await createHarness({
			contextWindow: window,
			tools: [],
			responses: [{ text: "active response", delayMs: 20 }, "summary"],
		});
		try {
			seed(harness);
			const started = new Promise<void>((resolve) =>
				harness.session.subscribe((event) => {
					if (event.type === "agent_start") resolve();
				}),
			);
			const prompt = harness.session.prompt("in-flight user request");
			await started;
			const compacted = harness.session.compact();
			await prompt;
			await compacted;
			expect(harness.session.isIdle).toBe(true);
			expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("in-flight user request");
			checkReleased(harness);
		} finally {
			harness.cleanup();
		}
	});

	it("excludes concurrent manual/automatic requests and releases cancellation", async () => {
		const harness = await createHarness({ contextWindow: window, tools: [] });
		try {
			seed(harness);
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				release = resolve;
			});
			const normal = harness.agent.streamFunction;
			harness.agent.streamFunction = async (model, context, options) => {
				release();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return normal(model, context, options);
			};
			const pending = harness.session.compact();
			await entered;
			await expect(harness.session.compact()).rejects.toThrow("already in progress");
			await expect(internals(harness)._runAutoCompaction("threshold", false)).resolves.toBe(false);
			harness.session.abortCompaction();
			await expect(pending).rejects.toThrow("cancelled");
			checkReleased(harness);
		} finally {
			harness.cleanup();
		}
	});
});
describe("Compact model settings runtime", () => {
	it.each([
		{ reasoning: false, automatic: false },
		{ reasoning: true, automatic: false },
		{ reasoning: false, automatic: true },
		{ reasoning: true, automatic: true },
	])(
		"persists independent model/effort (reasoning=$reasoning, automatic=$automatic)",
		async ({ reasoning, automatic }) => {
			const harness = await createHarness({ contextWindow: window, tools: [], responses: ["summary"] });
			try {
				seed(harness);
				harness.session.modelRuntime.registerProvider("compact-provider", {
					api: "openai-completions",
					baseUrl: "http://localhost:0",
					models: [
						{
							id: "compact-model",
							name: "Compact",
							reasoning,
							input: ["text"],
							contextWindow: 256_000,
							maxTokens: 32_000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				});
				harness.settingsManager.setCompactionModelSettings({
					provider: "compact-provider",
					model: "compact-model",
					thinkingLevel: "high",
				});
				await harness.settingsManager.flush();
				const loaded = SettingsManager.create(harness.tempDir, harness.tempDir);
				expect(loaded.getCompactionModelSettings()).toEqual({
					provider: "compact-provider",
					model: "compact-model",
					thinkingLevel: "high",
				});
				harness.settingsManager.reload();
				const requests: { model: Model<any>; options?: SimpleStreamOptions }[] = [];
				const normal = harness.agent.streamFunction;
				harness.agent.streamFunction = (model, context, options) => {
					requests.push({ model, options });
					return normal(model, context, options);
				};
				if (automatic) await internals(harness)._runAutoCompaction("threshold", false);
				else await harness.session.compact();
				expect(requests[0]?.model.provider).toBe("compact-provider");
				expect(requests[0]?.model.id).toBe("compact-model");
				expect(requests[0]?.options?.reasoning).toBe(reasoning ? "high" : undefined);
				expect(harness.session.model?.provider).toBe("faux");
				harness.settingsManager.setCompactionModelSettings({
					provider: undefined,
					model: undefined,
					thinkingLevel: "off",
				});
				await harness.settingsManager.flush();
				harness.settingsManager.reload();
				expect(harness.settingsManager.getCompactionModelSettings()).toEqual({
					provider: undefined,
					model: undefined,
					thinkingLevel: "off",
				});
				await harness.session.compact();
				expect(requests.at(-1)?.model.provider).toBe("faux");
			} finally {
				harness.cleanup();
			}
		},
	);
});
