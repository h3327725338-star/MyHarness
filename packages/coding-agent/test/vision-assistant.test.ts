import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@myharness/agent-core";
import type { ImageContent } from "@myharness/ai";
import { describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../src/agent/runtime/messages.ts";
import { VisionAssistantManager, type VisionAssistantMessageDetails } from "../src/agent/vision/assistant.ts";
import {
	createDocumentCollectionManifest,
	createDocumentCorpusManifest,
	formatDocumentCollectionMarker,
	getDocumentCorpusPaths,
	writeDocumentCorpusManifest,
} from "../src/agent/vision/document-corpus.ts";
import type { SettingsManager } from "../src/config/settings/index.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";

const image = {
	type: "image" as const,
	data: "aW1hZ2U=",
	mimeType: "image/png",
};

function createHarness(
	options: {
		blockImages?: boolean;
		enabled?: boolean;
		modelInput?: ("text" | "image")[];
		inputCapabilitiesKnown?: boolean;
		visionTestStatus?: "supported" | "unsupported";
		providerEnabled?: boolean;
		visionAuthConfigured?: boolean;
		checkpointDirectory?: string;
	} = {},
) {
	const persisted: CustomMessage<VisionAssistantMessageDetails>[] = [];
	const messages: AgentMessage[] = [
		{
			role: "user",
			content: [{ type: "text", text: "这张截图报了什么错？" }, image],
			timestamp: 100,
		},
	];
	const settingsManager = {
		getBlockImages: () => options.blockImages ?? false,
		getVisionAssistantSettings: () => ({
			enabled: options.enabled ?? true,
			provider: "test",
			model: "vision",
			thinkingLevel: "medium",
		}),
		getVisionCapabilityTest: () =>
			options.visionTestStatus ? { status: options.visionTestStatus, testedAt: 1 } : undefined,
		setVisionAssistantSettings: vi.fn(),
		getProviderRetrySettings: () => ({ enabled: true, maxRetries: 0, maxRetryDelayMs: 0 }),
		getHttpIdleTimeoutMs: () => 0,
	} as unknown as SettingsManager;
	const modelRuntime = {
		isProviderEnabled: () => options.providerEnabled ?? true,
		hasVisionConfiguredAuth: () => options.visionAuthConfigured ?? true,
		getModel: () => ({
			provider: "test",
			id: "vision",
			input: options.modelInput ?? ["text", "image"],
			inputCapabilitiesKnown: options.inputCapabilitiesKnown,
		}),
	} as unknown as ModelRuntime;
	const modelRunner = vi.fn(async (parameters: unknown) => {
		const contextText = (parameters as { contextText?: string }).contextText ?? "";
		const sources = [...contextText.matchAll(/^image \d+ = (.+)$/gm)].map((match) => match[1]).filter(Boolean);
		return [
			sources.length > 0 ? sources.map((source) => `## ${source}`).join("\n") : "## 图片概述",
			"终端报错截图",
			"",
			"## 识别文字",
			"fatal: test",
		].join("\n");
	});
	const manager = new VisionAssistantManager({
		settingsManager,
		modelRuntime,
		modelRunner,
		checkpointDirectory: options.checkpointDirectory,
		onPersist: (message) => {
			persisted.push(message);
			messages.push(message);
		},
	});
	return { manager, messages, modelRunner, persisted, settingsManager };
}

describe("VisionAssistantManager", () => {
	it("sends images only to the vision model and injects a text report", async () => {
		const harness = createHarness();
		const transformed = await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).toHaveBeenCalledOnce();
		expect((harness.modelRunner.mock.calls[0]?.[0] as { images: unknown }).images).toEqual([image]);
		const user = transformed.find((message) => message.role === "user");
		expect(user?.content).toEqual([{ type: "text", text: "这张截图报了什么错？" }]);
		const report = transformed.find(
			(message) => message.role === "custom" && message.customType === "Vision Assistant",
		);
		expect(report && "content" in report ? report.content : "").toContain("fatal: test");
		expect(harness.persisted).toHaveLength(1);
	});

	it("reuses the session cache for the same image and task text", async () => {
		const harness = createHarness();
		await harness.manager.transformContext(harness.messages);
		harness.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "第一次回答" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 150,
		} as unknown as AgentMessage);
		harness.messages.push({
			role: "user",
			content: [{ type: "text", text: "这张截图报了什么错？" }, image],
			timestamp: 200,
		});

		await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).toHaveBeenCalledOnce();
		expect(harness.persisted).toHaveLength(2);
		expect(harness.persisted[1]?.details?.cached).toBe(true);
	});

	it("does not call the vision model when Block images is enabled", async () => {
		const harness = createHarness({ blockImages: true });
		const transformed = await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).not.toHaveBeenCalled();
		expect(transformed).toBe(harness.messages);
		expect(harness.persisted).toHaveLength(0);
	});

	it("leaves the original flow unchanged when disabled", async () => {
		const harness = createHarness({ enabled: false });
		const transformed = await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).not.toHaveBeenCalled();
		expect(transformed).toBe(harness.messages);
	});

	it("turns itself off without calling the model when its visual credential is unavailable", async () => {
		const harness = createHarness({ visionAuthConfigured: false });
		const transformed = await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).not.toHaveBeenCalled();
		const user = transformed.find((message) => message.role === "user");
		expect(user?.content).toEqual([{ type: "text", text: "这张截图报了什么错？" }]);
		const report = transformed.find(
			(message) => message.role === "custom" && message.customType === "Vision Assistant",
		);
		expect(report && "content" in report ? report.content : "").toContain("配置不完整");
		expect(harness.settingsManager.setVisionAssistantSettings).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false, provider: "test", model: "vision" }),
		);
	});

	it("splits a large image collection into bounded model requests", async () => {
		const harness = createHarness();
		const images = Array.from({ length: 17 }, (_, index) => ({
			type: "image" as const,
			data: Buffer.from(`image-${index}`).toString("base64"),
			mimeType: "image/png",
		}));
		harness.messages[0] = {
			role: "user",
			content: [{ type: "text", text: "批量检查" }, ...images],
			timestamp: 100,
		};

		const transformed = await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).toHaveBeenCalledTimes(3);
		expect(
			harness.modelRunner.mock.calls.map((call) => (call[0] as { images: ImageContent[] }).images.length),
		).toEqual([8, 8, 1]);
		const report = transformed.find(
			(message) => message.role === "custom" && message.customType === "Vision Assistant",
		);
		expect(report && "content" in report ? report.content : "").toContain("Batch 3/3");
	});

	it("reuses completed large-batch checkpoints after the manager is recreated", async () => {
		const checkpointDirectory = mkdtempSync(join(tmpdir(), "myharness-vision-checkpoints-"));
		const images = Array.from({ length: 9 }, (_, index) => ({
			type: "image" as const,
			data: Buffer.from(`checkpoint-image-${index}`).toString("base64"),
			mimeType: "image/png",
		}));
		try {
			const first = createHarness({ checkpointDirectory });
			first.messages[0] = {
				role: "user",
				content: [{ type: "text", text: "继续批量检查" }, ...images],
				timestamp: 100,
			};
			await first.manager.transformContext(first.messages);
			expect(first.modelRunner).toHaveBeenCalledTimes(2);

			const resumed = createHarness({ checkpointDirectory });
			resumed.messages[0] = {
				role: "user",
				content: [{ type: "text", text: "继续批量检查" }, ...images],
				timestamp: 100,
			};
			await resumed.manager.transformContext(resumed.messages);
			expect(resumed.modelRunner).not.toHaveBeenCalled();
		} finally {
			rmSync(checkpointDirectory, { recursive: true, force: true });
		}
	});

	it("keeps exhaustive document batches separated by source document and page", async () => {
		const corpusDirectory = mkdtempSync(join(tmpdir(), "myharness-document-corpus-"));
		try {
			const manifests: Array<{ path: string; accessToken: string }> = [];
			for (const [documentIndex, sourceName] of ["contract-a.pdf", "contract-b.pdf"].entries()) {
				const sourcePath = join(corpusDirectory, sourceName);
				writeFileSync(sourcePath, `source-${documentIndex}`);
				const paths = getDocumentCorpusPaths(sourcePath, 8, documentIndex + 1, corpusDirectory);
				mkdirSync(paths.imageDirectory, { recursive: true });
				mkdirSync(paths.textDirectory, { recursive: true });
				mkdirSync(paths.analysisDirectory, { recursive: true });
				const manifest = createDocumentCorpusManifest(sourcePath, 8, documentIndex + 1, "pdf", 9, paths);
				manifest.status = "complete";
				manifest.completedUnits = 9;
				manifest.units = Array.from({ length: 9 }, (_, index) => {
					const imagePath = join(paths.imageDirectory, `${String(index + 1).padStart(6, "0")}.png`);
					writeFileSync(imagePath, `image-${documentIndex}-${index}`);
					return {
						unitNumber: index + 1,
						label: `${sourceName} · 第 ${index + 1} 页`,
						status: "complete" as const,
						imagePath,
					};
				});
				await writeDocumentCorpusManifest(paths.manifestPath, manifest);
				manifests.push({ path: paths.manifestPath, accessToken: manifest.accessToken });
			}

			const harness = createHarness();
			const collection = await createDocumentCollectionManifest(manifests, join(corpusDirectory, "collections"));
			harness.messages[0] = {
				role: "user",
				content: [
					{
						type: "text",
						text: `比较两个合同。\n${formatDocumentCollectionMarker(
							collection.path,
							collection.manifest.accessToken,
						)}`,
					},
				],
				timestamp: 100,
			};

			await harness.manager.transformContext(harness.messages);
			await harness.manager.waitForBackgroundJobs();

			expect(harness.modelRunner).toHaveBeenCalledTimes(6);
			expect(
				harness.modelRunner.mock.calls.map((call) => (call[0] as { images: ImageContent[] }).images.length),
			).toEqual([4, 4, 1, 4, 4, 1]);
			const contexts = harness.modelRunner.mock.calls.map(
				(call) => (call[0] as { contextText: string }).contextText,
			);
			expect(contexts[0]).toContain("contract-a.pdf · 第 1 页");
			expect(contexts[0]).not.toContain("contract-b.pdf");
			expect(contexts[3]).toContain("contract-b.pdf · 第 1 页");
			expect(contexts[3]).not.toContain("contract-a.pdf · 第 1 页");
		} finally {
			rmSync(corpusDirectory, { recursive: true, force: true });
		}
	});

	it("runs document collections in the background and reports preprocessing failures as partial", async () => {
		const corpusDirectory = mkdtempSync(join(tmpdir(), "myharness-partial-document-corpus-"));
		try {
			const sourcePath = join(corpusDirectory, "partial.pdf");
			writeFileSync(sourcePath, "source");
			const paths = getDocumentCorpusPaths(sourcePath, 6, 1, corpusDirectory);
			mkdirSync(paths.imageDirectory, { recursive: true });
			mkdirSync(paths.textDirectory, { recursive: true });
			mkdirSync(paths.analysisDirectory, { recursive: true });
			const manifest = createDocumentCorpusManifest(sourcePath, 6, 1, "pdf", 19, paths);
			manifest.status = "partial";
			manifest.completedUnits = 18;
			manifest.failedUnits = [19];
			manifest.units = Array.from({ length: 18 }, (_, index) => {
				const pageImagePath = join(paths.imageDirectory, `${String(index + 1).padStart(6, "0")}.png`);
				writeFileSync(pageImagePath, `image-${index}`);
				return {
					unitNumber: index + 1,
					label: `partial.pdf · 第 ${index + 1} 页`,
					status: "complete" as const,
					imagePath: pageImagePath,
				};
			});
			manifest.units.push({
				unitNumber: 19,
				label: "partial.pdf · 第 19 页",
				status: "failed",
				error: "render failed",
			});
			await writeDocumentCorpusManifest(paths.manifestPath, manifest);

			const harness = createHarness({ checkpointDirectory: join(corpusDirectory, "checkpoints") });
			harness.messages[0] = {
				role: "user",
				content: [
					{
						type: "text",
						text: `检查文档。\n${Buffer.from(
							JSON.stringify({ path: paths.manifestPath, accessToken: manifest.accessToken }),
						).toString("base64url")}`,
					},
				],
				timestamp: 100,
			};
			harness.messages[0] = {
				...harness.messages[0],
				content: [
					{
						type: "text",
						text: `检查文档。\n<myharness-document-manifest>${Buffer.from(
							JSON.stringify({ path: paths.manifestPath, accessToken: manifest.accessToken }),
						).toString("base64url")}</myharness-document-manifest>`,
					},
				],
			} as AgentMessage;

			const transformed = await harness.manager.transformContext(harness.messages);
			expect(
				transformed.some(
					(message) =>
						message.role === "custom" &&
						(message.details as VisionAssistantMessageDetails | undefined)?.status === "processing",
				),
			).toBe(true);

			await harness.manager.waitForBackgroundJobs();
			const final = harness.persisted.at(-1);
			expect(final?.details?.status).toBe("partial");
			expect(final?.details?.errorMessage).toContain("1 document(s) not fully processed");
		} finally {
			rmSync(corpusDirectory, { recursive: true, force: true });
		}
	});

	it("retries a document batch one unit at a time when the model omits source labels", async () => {
		const corpusDirectory = mkdtempSync(join(tmpdir(), "myharness-source-label-corpus-"));
		try {
			const sourcePath = join(corpusDirectory, "labels.pdf");
			writeFileSync(sourcePath, "source");
			const paths = getDocumentCorpusPaths(sourcePath, 6, 1, corpusDirectory);
			mkdirSync(paths.imageDirectory, { recursive: true });
			mkdirSync(paths.textDirectory, { recursive: true });
			mkdirSync(paths.analysisDirectory, { recursive: true });
			const manifest = createDocumentCorpusManifest(sourcePath, 6, 1, "pdf", 2, paths);
			manifest.status = "complete";
			manifest.completedUnits = 2;
			manifest.units = Array.from({ length: 2 }, (_, index) => {
				const imagePath = join(paths.imageDirectory, `${String(index + 1).padStart(6, "0")}.png`);
				writeFileSync(imagePath, `image-${index}`);
				return {
					unitNumber: index + 1,
					label: `labels.pdf · 第 ${index + 1} 页`,
					status: "complete" as const,
					imagePath,
				};
			});
			await writeDocumentCorpusManifest(paths.manifestPath, manifest);

			const harness = createHarness();
			harness.modelRunner.mockImplementation(async () => "模型没有返回任何来源标签");
			harness.messages[0] = {
				role: "user",
				content: [
					{
						type: "text",
						text: `<myharness-document-manifest>${Buffer.from(
							JSON.stringify({ path: paths.manifestPath, accessToken: manifest.accessToken }),
						).toString("base64url")}</myharness-document-manifest>`,
					},
				],
				timestamp: 100,
			};

			await harness.manager.transformContext(harness.messages);

			expect(harness.modelRunner).toHaveBeenCalledTimes(3);
			const content = readFileSync(paths.visionReportPath, "utf8");
			expect(content).toContain("Batch report sources were incomplete; discarded and retried unit by unit");
			expect(content).toContain("labels.pdf · 第 1 页");
			expect(content).toContain("labels.pdf · 第 2 页");
		} finally {
			rmSync(corpusDirectory, { recursive: true, force: true });
		}
	});

	it("accepts an unknown custom model after its cached image test passes", async () => {
		const harness = createHarness({
			modelInput: ["text"],
			inputCapabilitiesKnown: false,
			visionTestStatus: "supported",
		});

		const transformed = await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).toHaveBeenCalledOnce();
		expect((harness.modelRunner.mock.calls[0]?.[0] as { model: { input: string[] } }).model.input).toEqual([
			"text",
			"image",
		]);
		expect(transformed.some((message) => message.role === "custom")).toBe(true);
	});

	it("rejects and disables a custom image claim until its probe passes", async () => {
		const harness = createHarness({
			modelInput: ["text", "image"],
			inputCapabilitiesKnown: false,
		});

		const transformed = await harness.manager.transformContext(harness.messages);

		expect(harness.modelRunner).not.toHaveBeenCalled();
		expect(harness.settingsManager.setVisionAssistantSettings).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false, provider: "test", model: "vision" }),
		);
		const report = transformed.find(
			(message) => message.role === "custom" && message.customType === "Vision Assistant",
		);
		expect(report && "content" in report ? report.content : "").toContain("尚未通过真实识图测试");
	});
});
