import type { Model } from "@myharness/ai";
import { describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/config/settings/index.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";

const multimodalModel: Model<any> = {
	id: "vision-model",
	name: "Vision Model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const textModel: Model<any> = {
	...multimodalModel,
	id: "text-model",
	name: "Text Model",
	input: ["text"],
};

describe("ModelSelectorComponent presentation", () => {
	it("renders a caller-specific title, explanation, and capability label", () => {
		initTheme("dark");
		const runtime = {
			getAvailableSnapshot: () => [multimodalModel],
			getModel: () => multimodalModel,
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			getError: () => undefined,
		} as unknown as ModelRuntime;
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as never,
			multimodalModel,
			{} as SettingsManager,
			runtime,
			[],
			vi.fn(),
			vi.fn(),
			undefined,
			false,
			undefined,
			{
				title: "选择主推理模型",
				description: "用于对话和工具调用",
				getModelDescription: () => "文本、图片",
			},
		);

		const output = selector.render(120).join("\n");
		expect(output).toContain("选择主推理模型");
		expect(output).toContain("用于对话和工具调用");
		expect(output).toContain("文本、图片");
	});

	it("uses a dedicated model source for the visual selector", () => {
		initTheme("dark");
		const runtime = {
			getAvailableSnapshot: () => [textModel],
			getModel: () => undefined,
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			getError: () => undefined,
		} as unknown as ModelRuntime;
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as never,
			undefined,
			{} as SettingsManager,
			runtime,
			[],
			vi.fn(),
			vi.fn(),
			undefined,
			false,
			(model) => model.input.includes("image"),
			{
				title: "选择视觉模型",
				getModels: () => [multimodalModel],
				emptyHint: "只显示视觉密钥对应的模型",
			},
		);

		const output = selector.render(120).join("\n");
		expect(output).toContain("选择视觉模型");
		expect(output).toContain("Vision Model");
		expect(output).not.toContain("Text Model");
		expect(output).not.toContain("只显示视觉密钥对应的模型");
	});

	it("shows the caller-specific empty hint only when the model source is empty", () => {
		initTheme("dark");
		const runtime = {
			getAvailableSnapshot: () => [],
			getModel: () => undefined,
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			getError: () => undefined,
		} as unknown as ModelRuntime;
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as never,
			undefined,
			{} as SettingsManager,
			runtime,
			[],
			vi.fn(),
			vi.fn(),
			undefined,
			false,
			undefined,
			{
				title: "选择视觉模型",
				getModels: () => [],
				emptyHint: "没有与已保存视觉 API Key 对应的模型。",
			},
		);

		const output = selector.render(120).join("\n");
		expect(output).toContain("没有与已保存视觉 API Key 对应的模型。");
	});

	it("clears the refresh status when model refresh fails", async () => {
		initTheme("dark");
		const runtime = {
			getAvailableSnapshot: () => [textModel],
			getModel: () => textModel,
			refresh: vi.fn(async () => {
				throw new Error("network unavailable");
			}),
			getError: () => undefined,
		} as unknown as ModelRuntime;
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as never,
			textModel,
			{} as SettingsManager,
			runtime,
			[],
			vi.fn(),
			vi.fn(),
		);

		await vi.waitFor(() => expect(selector.render(120).join("\n")).toContain("network unavailable"));
		const output = selector.render(120).join("\n");
		expect(output).not.toContain("正在刷新模型目录…");
	});
});
