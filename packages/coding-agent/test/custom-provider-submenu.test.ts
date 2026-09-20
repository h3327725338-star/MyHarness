import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@myharness/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/config/settings/index.ts";
import { CustomProviderSubmenu } from "../src/modes/interactive/components/custom-provider-submenu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryModelsPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "myharness-custom-provider-menu-"));
	temporaryDirectories.push(directory);
	return join(directory, "models.json");
}

function render(component: Component): string {
	return component.render(120).join("\n");
}

function createSubmenu(
	path: string,
	options: ConstructorParameters<typeof CustomProviderSubmenu>[2] = {},
	runtimeOverrides: Partial<ModelRuntime> = {},
): CustomProviderSubmenu {
	return new CustomProviderSubmenu(
		{
			tui: { requestRender: vi.fn() } as never,
			settingsManager: {
				clearModelReferences: vi.fn(),
				flush: vi.fn(async () => {}),
			} as unknown as SettingsManager,
			modelRuntime: {
				getModelsConfigPath: () => path,
				reloadConfig: vi.fn(async () => {}),
				deleteProviderCredentials: vi.fn(async () => {}),
				...runtimeOverrides,
			} as unknown as ModelRuntime,
		},
		vi.fn(),
		options,
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CustomProviderSubmenu", () => {
	it("shows only add when no custom Provider exists", async () => {
		initTheme("dark");
		const submenu = createSubmenu(await createTemporaryModelsPath());

		await vi.waitFor(() => expect(render(submenu)).toContain("添加新的"));
		expect(render(submenu)).not.toContain("已有 Provider");
	});

	it("shows existing providers separately from the add action", async () => {
		initTheme("dark");
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					longcat: {
						name: "LongCat",
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						models: [{ id: "LongCat-2.0" }],
					},
				},
			}),
			"utf8",
		);
		const submenu = createSubmenu(path);

		await vi.waitFor(() => expect(render(submenu)).toContain("已有 Provider"));
		expect(render(submenu)).toContain("添加新的");
		submenu.handleInput("\r");
		expect(render(submenu)).toContain("LongCat");
		expect(render(submenu)).toContain("1 个模型");
	});

	it("opens explicit image and reasoning capability menus and persists both choices", async () => {
		initTheme("dark");
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					longcat: {
						name: "LongCat",
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						models: [
							{
								id: "LongCat-2.0",
								name: "LongCat 2.0",
								input: ["text"],
								reasoning: false,
							},
						],
					},
				},
			}),
			"utf8",
		);
		const submenu = createSubmenu(path);
		await vi.waitFor(() => expect(render(submenu)).toContain("已有 Provider"));

		submenu.handleInput("\r");
		submenu.handleInput("\r");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		submenu.handleInput("\r");

		expect(render(submenu)).toContain("图片输入能力");
		expect(render(submenu)).toContain("当前：仅文本");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		expect(render(submenu)).toContain("选择图片输入能力");
		expect(render(submenu)).toContain("文本和图片");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		await vi.waitFor(() => expect(render(submenu)).toContain("输入：文本、图片"));

		submenu.handleInput("\x1b[B");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		expect(render(submenu)).toContain("选择思考能力");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		await vi.waitFor(() => expect(render(submenu)).toContain("思考：支持"));

		const saved = JSON.parse(await readFile(path, "utf8")) as {
			providers: { longcat: { models: Array<{ input: string[]; reasoning: boolean }> } };
		};
		expect(saved.providers.longcat.models[0]).toMatchObject({
			input: ["text", "image"],
			reasoning: true,
		});
	});

	it("offers an add action inside an existing Provider model list and preserves the first model", async () => {
		initTheme("dark");
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					siliconflow: {
						name: "SiliconFlow",
						baseUrl: "https://api.siliconflow.cn/v1",
						api: "openai-completions",
						models: [{ id: "first-model", name: "First Model" }],
					},
				},
			}),
			"utf8",
		);
		const submenu = createSubmenu(path, { providerId: "siliconflow", embedded: true });
		await vi.waitFor(() => expect(render(submenu)).toContain("SiliconFlow"));

		submenu.handleInput("\x1b[B");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		expect(render(submenu)).toContain("管理模型");
		expect(render(submenu)).toContain("First Model");
		expect(render(submenu)).toContain("添加模型");

		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		expect(render(submenu)).toContain("自动读取模型");
		expect(render(submenu)).toContain("手动填写");

		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		submenu.handleInput("second-model");
		submenu.handleInput("\r");
		submenu.handleInput("\r");
		submenu.handleInput("\r");
		submenu.handleInput("\r");

		await vi.waitFor(
			async () => {
				const saved = JSON.parse(await readFile(path, "utf8")) as {
					providers: { siliconflow: { models: Array<{ id: string }> } };
				};
				expect(saved.providers.siliconflow.models.map((model) => model.id)).toEqual([
					"first-model",
					"second-model",
				]);
			},
			{ timeout: 5000 },
		);
	});

	it("does not require a second usage-specific key for an existing Provider model", async () => {
		initTheme("dark");
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					siliconflow: {
						name: "SiliconFlow",
						baseUrl: "https://api.siliconflow.cn/v1",
						api: "openai-completions",
						models: [{ id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" }],
					},
				},
			}),
			"utf8",
		);
		const submenu = createSubmenu(
			path,
			{ providerId: "siliconflow", embedded: true },
			{
				getProviderCredentialOverview: vi.fn(async () => ({
					providerId: "siliconflow",
					active: { type: "api_key" as const, keyId: "provider-key" },
					apiKeys: [{ id: "provider-key", label: "默认密钥", active: true }],
					hasOAuth: false,
				})),
			},
		);
		await vi.waitFor(() => expect(render(submenu)).toContain("SiliconFlow"));

		submenu.handleInput("\x1b[B");
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		submenu.handleInput("\r");

		await vi.waitFor(() => expect(render(submenu)).toContain("图片输入能力"));
		expect(render(submenu)).not.toContain("在 /model 中启用");
		expect(render(submenu)).not.toContain("复用视觉 Key");
	});

	it("deletes a custom Provider and its saved credentials", async () => {
		initTheme("dark");
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					longcat: {
						name: "LongCat",
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						models: [{ id: "model" }],
					},
				},
			}),
			"utf8",
		);
		const deleteProviderCredentials = vi.fn(async () => {});
		const submenu = createSubmenu(path, { providerId: "longcat" }, { deleteProviderCredentials });
		await vi.waitFor(() => expect(render(submenu)).toContain("LongCat"));

		for (let index = 0; index < 4; index++) submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		await vi.waitFor(() => expect(render(submenu)).toContain("确定删除 LongCat"));
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");

		await vi.waitFor(async () => {
			expect(deleteProviderCredentials).toHaveBeenCalledWith("longcat");
			expect(JSON.parse(await readFile(path, "utf8")).providers.longcat).toBeUndefined();
		});
	});

	it("deletes a custom Provider whose id matches a built-in id (overlay) from models.json", async () => {
		initTheme("dark");
		const path = await createTemporaryModelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					deepseek: {
						name: "DeepSeek (custom)",
						baseUrl: "https://api.deepseek.com",
						api: "openai-completions",
						models: [{ id: "deepseek-v4-flash" }],
					},
					"test-provider": {
						name: "Test Provider",
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						models: [{ id: "test-model" }],
					},
				},
			}),
			"utf8",
		);
		const deleteProviderCredentials = vi.fn(async () => {});
		const submenu = createSubmenu(path, { providerId: "deepseek" }, { deleteProviderCredentials });
		await vi.waitFor(() => expect(render(submenu)).toContain("DeepSeek (custom)"));

		for (let index = 0; index < 4; index++) submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");
		await vi.waitFor(() => expect(render(submenu)).toContain("确定删除 DeepSeek (custom)"));
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\r");

		await vi.waitFor(async () => {
			expect(deleteProviderCredentials).toHaveBeenCalledWith("deepseek");
			const saved = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, unknown> };
			expect(saved.providers.deepseek).toBeUndefined();
			// 其他 provider 不受影响
			expect(saved.providers["test-provider"]).toBeDefined();
		});
	});
});
