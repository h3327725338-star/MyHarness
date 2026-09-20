import type { AuthInteraction, AuthPrompt, Model } from "@myharness/ai";
import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
	type TUI,
} from "@myharness/tui";
import type { SettingsManager } from "../../../config/settings/index.ts";
import { DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_TOKENS } from "../../../providers/models/composer.ts";
import type { ModelsJsonModel, ModelsJsonProvider } from "../../../providers/models/config.ts";
import {
	type CustomProviderApiType,
	type CustomProviderEntry,
	CustomProviderManager,
	type DiscoveredProviderModel,
	discoverProviderModels,
} from "../../../providers/models/custom-provider-manager.ts";
import type { ModelRuntime } from "../../../providers/runtime/index.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { ExtensionInputComponent } from "./extension-input.ts";

interface CustomProviderDependencies {
	tui: TUI;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	reconcileModelAfterConfigChange?: () => Promise<void>;
}

export interface CustomProviderSubmenuOptions {
	providerId?: string;
	startCreate?: boolean;
	embedded?: boolean;
}

const CUSTOM_PROVIDER_SELECT_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ADD_MODEL_ACTION = "__myharness_add_model__";

class SelectSubmenu extends Container {
	private readonly selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			CUSTOM_PROVIDER_SELECT_LAYOUT,
		);
		const selectedIndex = options.findIndex((option) => option.value === currentValue);
		if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

type CredentialTarget = "provider" | "none";

interface ProviderDraft {
	id: string;
	name: string;
	api: CustomProviderApiType;
	baseUrl: string;
	model: ModelsJsonModel;
	credentialTarget: CredentialTarget;
	keyLabel: string;
	apiKey: string;
}

const API_TYPE_ITEMS: SelectItem[] = [
	{
		value: "openai-completions",
		label: "OpenAI Chat Completions",
		description: "适合大多数 OpenAI 兼容服务",
	},
	{
		value: "openai-responses",
		label: "OpenAI Responses",
		description: "服务明确支持 Responses API 时使用",
	},
	{
		value: "anthropic-messages",
		label: "Anthropic Messages",
		description: "适合 Anthropic 兼容服务",
	},
	{
		value: "google-generative-ai",
		label: "Google Generative AI",
		description: "适合 Gemini 兼容服务",
	},
	{
		value: "mistral-conversations",
		label: "Mistral Conversations",
		description: "适合 Mistral API",
	},
];

function apiTypeLabel(api: string | undefined): string {
	return API_TYPE_ITEMS.find((item) => item.value === api)?.label ?? api ?? "未设置";
}

function providerDisplayName(entry: CustomProviderEntry): string {
	return entry.config.name ?? entry.id;
}

function slugifyProviderId(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return slug || "custom-provider";
}

function normalizeBaseUrl(value: string): string {
	const normalized = value.trim().replace(/\/+$/u, "");
	let url: URL;
	try {
		url = new URL(normalized);
	} catch {
		throw new Error("Base URL 不是有效网址。");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Base URL 只能使用 http 或 https。");
	}
	return normalized;
}

function parsePositiveInteger(value: string, field: string): number {
	const normalized = value.trim();
	if (!/^\d+$/u.test(normalized)) throw new Error(`${field}必须是正整数。`);
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field}必须是有效的正整数。`);
	return parsed;
}

function responseText(response: Awaited<ReturnType<ModelRuntime["completeSimple"]>>): string {
	return response.content
		.filter((part): part is Extract<(typeof response.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export class CustomProviderSubmenu extends Container {
	private inputComponent: Component | undefined;
	private notice = "";
	private readonly manager: CustomProviderManager;
	private readonly dependencies: CustomProviderDependencies;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly options: CustomProviderSubmenuOptions;

	constructor(
		dependencies: CustomProviderDependencies,
		onDone: (selectedValue?: string) => void,
		options: CustomProviderSubmenuOptions = {},
	) {
		super();
		this.dependencies = dependencies;
		this.onDone = onDone;
		this.options = options;
		this.manager = new CustomProviderManager(dependencies.modelRuntime.getModelsConfigPath());
		this.setContent(new Text(theme.fg("muted", "正在读取自定义 Provider…"), 0, 0));
		void this.initialize();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = component;
		this.dependencies.tui.requestRender();
	}

	private async initialize(): Promise<void> {
		if (this.options.startCreate) {
			this.startCreateFlow();
			return;
		}
		if (this.options.providerId) {
			try {
				const providers = await this.manager.list();
				const entry = providers.find((candidate) => candidate.id === this.options.providerId);
				if (!entry) {
					this.showError("找不到 Provider", `models.json 中没有“${this.options.providerId}”。`, () =>
						this.onDone(),
					);
					return;
				}
				this.showProviderActions(entry);
			} catch (error) {
				this.showError("读取自定义 Provider 失败", error, () => this.onDone());
			}
			return;
		}
		await this.showRootMenu();
	}

	private returnToRoot(): void {
		if (this.options.embedded) this.onDone();
		else void this.showRootMenu();
	}

	private async showRootMenu(): Promise<void> {
		try {
			const providers = await this.manager.list();
			const options: SelectItem[] = [];
			if (providers.length > 0) {
				options.push({
					value: "existing",
					label: "已有 Provider",
					description: `${providers.length} 个自定义服务`,
				});
			}
			options.push({ value: "add", label: "添加新的", description: "创建自定义 Provider" });
			this.setContent(
				new SelectSubmenu(
					"Custom Providers",
					[
						this.notice,
						"在图形界面中接入 OpenAI、Anthropic、Google 或兼容 API。",
						"API Key 单独保存在密钥仓库，不会写入 models.json。",
					]
						.filter(Boolean)
						.join("\n"),
					options,
					providers.length > 0 ? "existing" : "add",
					(value) => {
						if (value === "existing") this.showExistingProviders(providers);
						else this.startCreateFlow();
					},
					() => this.onDone(`${providers.length} 个`),
				),
			);
		} catch (error) {
			this.showError("读取自定义 Provider 失败", error, () => this.onDone());
		}
	}

	private showExistingProviders(providers: CustomProviderEntry[]): void {
		this.setContent(
			new SelectSubmenu(
				"已有 Provider",
				"选择要查看、修改、测试或删除的自定义 Provider。",
				providers.map((entry) => ({
					value: entry.id,
					label: providerDisplayName(entry),
					description: `${entry.id} · ${entry.config.models?.length ?? 0} 个模型`,
				})),
				providers[0]?.id ?? "",
				(providerId) => {
					const entry = providers.find((candidate) => candidate.id === providerId);
					if (entry) this.showProviderActions(entry);
				},
				() => this.returnToRoot(),
			),
		);
	}

	private showProviderActions(entry: CustomProviderEntry): void {
		const models = entry.config.models ?? [];
		this.setContent(
			new SelectSubmenu(
				providerDisplayName(entry),
				[
					`ID：${entry.id}`,
					`API：${apiTypeLabel(entry.config.api)}`,
					`Base URL：${entry.config.baseUrl ?? "未设置"}`,
				].join("\n"),
				[
					{ value: "test", label: "连接测试", description: "发送一个最小文本请求" },
					{ value: "edit", label: "修改基本信息", description: "修改名称、API 和网址" },
					{ value: "models", label: "管理模型", description: `${models.length} 个模型` },
					{ value: "add-model", label: "添加模型", description: "读取目录或手动添加" },
					{ value: "delete", label: "删除 Provider", description: "删除本地 Provider 配置" },
					{ value: "refresh-models", label: "刷新模型", description: "追加当前 Provider 可用模型" },
					{ value: "back", label: "返回", description: "返回 Provider 列表" },
				],
				"test",
				(value) => {
					if (value === "test") void this.testProvider(entry);
					else if (value === "edit") this.editProviderName(entry);
					else if (value === "models") this.showModels(entry);
					else if (value === "add-model") this.showAddModelSource(entry);
					else if (value === "delete") this.confirmDeleteProvider(entry);
					else if (value === "refresh-models") void this.refreshProviderModels(entry);
					else this.returnToRoot();
				},
				() => this.returnToRoot(),
			),
		);
	}

	private startCreateFlow(): void {
		const draft: ProviderDraft = {
			id: "",
			name: "",
			api: "openai-completions",
			baseUrl: "",
			model: {
				id: "",
				name: "",
				reasoning: false,
				input: ["text"],
				contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MODEL_MAX_TOKENS,
			},
			credentialTarget: "provider",
			keyLabel: "默认密钥",
			apiKey: "",
		};
		this.promptProviderName(draft);
	}

	private promptProviderName(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"Provider 显示名称",
				"例如：LongCat",
				(value) => {
					const name = value.trim();
					if (!name) return this.showDraftError("名称不能为空", () => this.promptProviderName(draft));
					draft.name = name;
					draft.id = slugifyProviderId(name);
					this.promptProviderId(draft);
				},
				() => this.returnToRoot(),
				{ initialValue: draft.name },
			),
		);
	}

	private promptProviderId(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"Provider ID（配置中的唯一名称）",
				"例如：longcat",
				async (value) => {
					const id = value.trim().toLowerCase();
					try {
						if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
							throw new Error("只能使用小写字母、数字、点、下划线和短横线。");
						}
						if (this.manager.isBuiltinProviderId(id)) throw new Error("这个 ID 已被内置 Provider 使用。");
						if (await this.manager.get(id)) throw new Error("这个 Provider ID 已存在。");
						draft.id = id;
						this.selectApiType(draft);
					} catch (error) {
						this.showDraftError(error, () => this.promptProviderId(draft));
					}
				},
				() => this.promptProviderName(draft),
				{ initialValue: draft.id },
			),
		);
	}

	private selectApiType(draft: ProviderDraft): void {
		this.setContent(
			new SelectSubmenu(
				"选择 API 类型",
				"不确定时，优先选择 OpenAI Chat Completions。",
				API_TYPE_ITEMS,
				draft.api,
				(value) => {
					draft.api = value as CustomProviderApiType;
					this.promptBaseUrl(draft);
				},
				() => this.promptProviderId(draft),
			),
		);
	}

	private promptBaseUrl(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"API Base URL",
				"例如：https://api.example.com/v1",
				(value) => {
					try {
						draft.baseUrl = normalizeBaseUrl(value);
						this.selectCredentialTarget(draft);
					} catch (error) {
						this.showDraftError(error, () => this.promptBaseUrl(draft));
					}
				},
				() => this.selectApiType(draft),
				{ initialValue: draft.baseUrl },
			),
		);
	}

	private selectCredentialTarget(draft: ProviderDraft): void {
		this.setContent(
			new SelectSubmenu(
				"认证方式",
				"一个 API Key 可供这个 Provider 下的所有模型使用；不会自动轮换。",
				[
					{ value: "provider", label: "API Key", description: "供这个 Provider 的所有模型使用" },
					{ value: "none", label: "无需认证", description: "本地或不检查密钥的服务" },
				],
				draft.credentialTarget,
				(value) => {
					draft.credentialTarget = value as CredentialTarget;
					if (value === "none") {
						draft.apiKey = "";
						this.selectModelSource(draft);
					} else {
						this.promptKeyLabel(draft);
					}
				},
				() => this.promptBaseUrl(draft),
			),
		);
	}

	private promptKeyLabel(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"给 API Key 起一个名称",
				"例如：默认密钥",
				(value) => {
					const label = value.trim();
					if (!label) return this.showDraftError("名称不能为空", () => this.promptKeyLabel(draft));
					draft.keyLabel = label;
					this.promptApiKey(draft);
				},
				() => this.selectCredentialTarget(draft),
				{ initialValue: draft.keyLabel },
			),
		);
	}

	private promptApiKey(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"输入 API Key（内容会隐藏）",
				"",
				(value) => {
					const apiKey = value.trim();
					if (!apiKey) return this.showDraftError("API Key 不能为空", () => this.promptApiKey(draft));
					draft.apiKey = apiKey;
					this.selectModelSource(draft);
				},
				() => this.promptKeyLabel(draft),
				{ maskInput: true },
			),
		);
	}

	private selectModelSource(draft: ProviderDraft): void {
		this.setContent(
			new SelectSubmenu(
				"添加模型",
				"可以尝试读取服务的 /models 目录；不支持时可手动填写。",
				[
					{ value: "discover", label: "自动读取模型", description: "从 API 模型目录获取" },
					{ value: "manual", label: "手动填写", description: "直接输入模型 ID" },
				],
				"discover",
				(value) => {
					if (value === "discover") void this.discoverModels(draft);
					else this.promptModelId(draft);
				},
				() => (draft.credentialTarget === "none" ? this.selectCredentialTarget(draft) : this.promptApiKey(draft)),
			),
		);
	}

	private async discoverModels(draft: ProviderDraft): Promise<void> {
		this.setContent(new Text(theme.fg("muted", "正在读取模型目录…"), 0, 0));
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 20_000);
		try {
			const models = await discoverProviderModels({
				baseUrl: draft.baseUrl,
				api: draft.api,
				apiKey: draft.apiKey || undefined,
				signal: controller.signal,
			});
			if (models.length === 0) throw new Error("模型目录返回成功，但没有可用模型。");
			this.selectDiscoveredModel(draft, models);
		} catch (error) {
			this.setContent(
				new SelectSubmenu(
					"自动读取失败",
					error instanceof Error ? error.message : String(error),
					[
						{ value: "manual", label: "手动填写", description: "改为直接输入模型 ID" },
						{ value: "retry", label: "重试", description: "再次读取模型目录" },
						{ value: "back", label: "返回", description: "返回上一步" },
					],
					"manual",
					(value) => {
						if (value === "manual") this.promptModelId(draft);
						else if (value === "retry") void this.discoverModels(draft);
						else this.selectModelSource(draft);
					},
					() => this.selectModelSource(draft),
				),
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private selectDiscoveredModel(draft: ProviderDraft, models: DiscoveredProviderModel[]): void {
		this.setContent(
			new SelectSubmenu(
				"选择模型",
				`已读取 ${models.length} 个模型。先选择一个，保存后还可以继续添加。`,
				models.map((model) => ({ value: model.id, label: model.name, description: model.id })),
				models[0]?.id ?? "",
				(value) => {
					const selected = models.find((model) => model.id === value);
					if (!selected) return;
					draft.model.id = selected.id;
					draft.model.name = selected.name;
					this.promptModelName(draft);
				},
				() => this.selectModelSource(draft),
			),
		);
	}

	private promptModelId(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"模型 ID",
				"例如：LongCat-2.0",
				(value) => {
					const id = value.trim();
					if (!id) return this.showDraftError("模型 ID 不能为空", () => this.promptModelId(draft));
					draft.model.id = id;
					draft.model.name = draft.model.name || id;
					this.promptModelName(draft);
				},
				() => this.selectModelSource(draft),
				{ initialValue: draft.model.id },
			),
		);
	}

	private promptModelName(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"模型显示名称",
				draft.model.id,
				(value) => {
					draft.model.name = value.trim() || draft.model.id;
					this.selectVisionCapability(draft);
				},
				() => this.promptModelId(draft),
				{ initialValue: draft.model.name || draft.model.id },
			),
		);
	}

	private selectVisionCapability(draft: ProviderDraft): void {
		this.setContent(
			new SelectSubmenu(
				"图片输入能力",
				"只有明确支持图片输入的模型才能出现在 Vision Assistant 中。",
				[
					{ value: "text", label: "仅文本", description: "不能接收图片" },
					{ value: "image", label: "文本和图片", description: "支持图片输入" },
				],
				draft.model.input?.includes("image") ? "image" : "text",
				(value) => {
					draft.model.input = value === "image" ? ["text", "image"] : ["text"];
					this.selectReasoningCapability(draft);
				},
				() => this.promptModelName(draft),
			),
		);
	}

	private selectReasoningCapability(draft: ProviderDraft): void {
		this.setContent(
			new SelectSubmenu(
				"思考能力",
				"只有服务文档明确支持额外思考参数时才选择“支持”。",
				[
					{ value: "false", label: "不支持或不确定", description: "不发送额外思考设置" },
					{ value: "true", label: "支持", description: "允许 /effort 调整思考强度" },
				],
				draft.model.reasoning ? "true" : "false",
				(value) => {
					draft.model.reasoning = value === "true";
					this.promptContextWindow(draft);
				},
				() => this.selectVisionCapability(draft),
			),
		);
	}

	private promptContextWindow(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"上下文窗口 Token 数",
				"例如：128000",
				(value) => {
					try {
						draft.model.contextWindow = parsePositiveInteger(value, "上下文窗口");
						this.promptMaxTokens(draft);
					} catch (error) {
						this.showDraftError(error, () => this.promptContextWindow(draft));
					}
				},
				() => this.selectReasoningCapability(draft),
				{ initialValue: String(draft.model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW) },
			),
		);
	}

	private promptMaxTokens(draft: ProviderDraft): void {
		this.setContent(
			new ExtensionInputComponent(
				"单次最大输出 Token 数",
				"例如：8192",
				(value) => {
					try {
						draft.model.maxTokens = parsePositiveInteger(value, "最大输出");
						this.showDraftSummary(draft);
					} catch (error) {
						this.showDraftError(error, () => this.promptMaxTokens(draft));
					}
				},
				() => this.promptContextWindow(draft),
				{ initialValue: String(draft.model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS) },
			),
		);
	}

	private showDraftSummary(draft: ProviderDraft): void {
		const vision = draft.model.input?.includes("image") ? "文本、图片" : "仅文本";
		this.setContent(
			new SelectSubmenu(
				"确认创建 Provider",
				[
					`${draft.name}（${draft.id}）`,
					`${apiTypeLabel(draft.api)} · ${draft.baseUrl}`,
					`模型：${draft.model.name}（${draft.model.id}）`,
					`能力：${vision} · ${draft.model.reasoning ? "支持思考" : "不启用思考"}`,
					`上下文：${draft.model.contextWindow} · 最大输出：${draft.model.maxTokens}`,
				].join("\n"),
				[
					{ value: "save", label: "保存", description: "写入配置并重载模型" },
					{ value: "model", label: "修改模型信息", description: "返回模型设置" },
					{ value: "cancel", label: "取消", description: "不保存" },
				],
				"save",
				(value) => {
					if (value === "save") void this.saveDraft(draft);
					else if (value === "model") this.promptModelId(draft);
					else this.returnToRoot();
				},
				() => this.promptMaxTokens(draft),
			),
		);
	}

	private async saveDraft(draft: ProviderDraft): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在保存 ${draft.name}…`), 0, 0));
		const snapshot = await this.manager.snapshot();
		let savedKeyId: string | undefined;
		const provider: ModelsJsonProvider = {
			name: draft.name,
			baseUrl: draft.baseUrl,
			api: draft.api,
			...(draft.credentialTarget === "none" ? { apiKey: "local" } : {}),
			models: [draft.model],
		};
		try {
			await this.manager.upsert(draft.id, provider);
			await this.dependencies.modelRuntime.reloadConfig();
			if (draft.credentialTarget !== "none") {
				const saved = await this.dependencies.modelRuntime.addProviderApiKey(
					draft.id,
					draft.keyLabel,
					this.fixedKeyInteraction(draft.apiKey),
				);
				savedKeyId = saved.id;
			}
			this.notice = `${draft.name} 已创建。`;
			const entry = { id: draft.id, config: provider };
			this.showSavedProvider(entry);
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			if (savedKeyId) {
				try {
					await this.dependencies.modelRuntime.deleteProviderApiKey(draft.id, savedKeyId);
				} catch (cleanupError) {
					rollbackErrors.push(cleanupError);
				}
			}
			try {
				await this.manager.restore(snapshot);
				await this.dependencies.modelRuntime.reloadConfig();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			this.showError(
				"创建 Provider 失败",
				rollbackErrors.length > 0
					? new AggregateError([error, ...rollbackErrors], "保存失败，回滚时也遇到问题。")
					: error,
				() => this.showDraftSummary(draft),
			);
		}
	}

	private showSavedProvider(entry: CustomProviderEntry): void {
		this.setContent(
			new SelectSubmenu(
				"Provider 已保存",
				`${providerDisplayName(entry)} 已写入 models.json，并已重新加载。`,
				[
					{ value: "test", label: "连接测试", description: "发送一个最小文本请求" },
					{ value: "done", label: "完成", description: "返回设置列表" },
				],
				"test",
				(value) => {
					if (value === "test") void this.testProvider(entry);
					else this.onDone(`${(entry.config.models ?? []).length} 个模型`);
				},
				() => this.onDone(`${(entry.config.models ?? []).length} 个模型`),
			),
		);
	}

	private fixedKeyInteraction(key: string): AuthInteraction {
		return {
			prompt: async (prompt: AuthPrompt) => {
				if (prompt.type === "select") return prompt.options[0]?.id ?? "";
				return key;
			},
			notify: () => {},
		};
	}

	private async testProvider(entry: CustomProviderEntry): Promise<void> {
		const configuredModel = entry.config.models?.[0];
		if (!configuredModel) {
			this.showError("无法测试", "这个 Provider 还没有模型。", () => this.showProviderActions(entry));
			return;
		}
		const model = this.dependencies.modelRuntime.getModel(entry.id, configuredModel.id);
		if (!model) {
			this.showError("无法测试", "运行时没有加载到这个模型。", () => this.showProviderActions(entry));
			return;
		}
		this.setContent(new Text(theme.fg("muted", `正在测试 ${entry.id}/${model.id}…`), 0, 0));
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30_000);
		try {
			const response = await this.dependencies.modelRuntime.completeSimple(
				model as Model<any>,
				{
					messages: [
						{
							role: "user",
							content: "这是连接测试。请只回复 OK。",
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 32, maxRetries: 0, signal: controller.signal, timeoutMs: 30_000 },
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage || `请求结束状态：${response.stopReason}`);
			}
			const output = responseText(response);
			this.setContent(
				new SelectSubmenu(
					"连接测试通过",
					`模型已返回响应${output ? `：\n${output.slice(0, 300)}` : "。"}`,
					[{ value: "back", label: "返回", description: "返回 Provider 设置" }],
					"back",
					() => this.showProviderActions(entry),
					() => this.showProviderActions(entry),
				),
			);
		} catch (error) {
			this.showError(
				"连接测试失败",
				error instanceof Error && error.name === "AbortError" ? "请求超过 30 秒，已取消。" : error,
				() => this.showProviderActions(entry),
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async refreshProviderModels(entry: CustomProviderEntry): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在从 ${providerDisplayName(entry)} 获取模型列表…`), 0, 0));
		try {
			const result = await this.dependencies.modelRuntime.refreshProviderModels(entry.id);
			await this.dependencies.reconcileModelAfterConfigChange?.();
			this.setContent(
				new SelectSubmenu(
					"模型刷新完成",
					[
						`发现：${result.discovered} 个`,
						`新增：${result.added} 个`,
						`已存在：${result.existing} 个`,
						`删除：${result.removed} 个（刷新失败或结果不完整时不会删除）`,
					].join("\n"),
					[{ value: "back", label: "返回", description: "返回 Provider 设置" }],
					"back",
					() => this.showProviderActions(entry),
					() => this.showProviderActions(entry),
				),
			);
		} catch (error) {
			this.showError("模型刷新失败", error, () => this.showProviderActions(entry));
		}
	}

	private editProviderName(entry: CustomProviderEntry): void {
		this.setContent(
			new ExtensionInputComponent(
				"Provider 显示名称",
				providerDisplayName(entry),
				(value) => {
					const name = value.trim();
					if (!name) return this.showDraftError("名称不能为空", () => this.editProviderName(entry));
					const updated = { ...entry, config: { ...entry.config, name } };
					this.editProviderApi(updated);
				},
				() => this.showProviderActions(entry),
				{ initialValue: providerDisplayName(entry) },
			),
		);
	}

	private editProviderApi(entry: CustomProviderEntry): void {
		this.setContent(
			new SelectSubmenu(
				"选择 API 类型",
				"修改后会重新加载 Provider。",
				API_TYPE_ITEMS,
				entry.config.api ?? "openai-completions",
				(value) => this.editProviderBaseUrl({ ...entry, config: { ...entry.config, api: value } }),
				() => this.editProviderName(entry),
			),
		);
	}

	private editProviderBaseUrl(entry: CustomProviderEntry): void {
		this.setContent(
			new ExtensionInputComponent(
				"API Base URL",
				entry.config.baseUrl,
				(value) => {
					try {
						const updated = {
							...entry,
							config: { ...entry.config, baseUrl: normalizeBaseUrl(value) },
						};
						void this.persistEntry(updated, "Provider 基本信息已更新。");
					} catch (error) {
						this.showDraftError(error, () => this.editProviderBaseUrl(entry));
					}
				},
				() => this.editProviderApi(entry),
				{ initialValue: entry.config.baseUrl },
			),
		);
	}

	private showModels(entry: CustomProviderEntry): void {
		const models = entry.config.models ?? [];
		const options: SelectItem[] = [
			...models.map((model) => ({
				value: model.id,
				label: model.name ?? model.id,
				description: `${model.input?.includes("image") ? "文本、图片" : "仅文本"} · ${model.reasoning ? "思考" : "普通"}`,
			})),
			{
				value: ADD_MODEL_ACTION,
				label: "添加模型",
				description: "复用当前 Provider 的 API Key",
			},
		];
		this.setContent(
			new SelectSubmenu(
				"管理模型",
				"选择现有模型进行修改，或继续为这个 Provider 添加其他模型。",
				options,
				models[0]?.id ?? ADD_MODEL_ACTION,
				(modelId) => {
					if (modelId === ADD_MODEL_ACTION) {
						this.showAddModelSource(entry);
						return;
					}
					const model = models.find((candidate) => candidate.id === modelId);
					if (model) this.showModelActions(entry, model);
				},
				() => this.showProviderActions(entry),
			),
		);
	}

	private showAddModelSource(entry: CustomProviderEntry): void {
		this.setContent(
			new SelectSubmenu(
				"添加模型",
				"同一 Provider 可以保存多个模型，并复用已经保存的 API Key。",
				[
					{ value: "discover", label: "自动读取模型", description: "从 Provider 的 /models 目录获取" },
					{ value: "manual", label: "手动填写", description: "直接输入模型 ID" },
				],
				"discover",
				(value) => {
					if (value === "discover") void this.discoverAdditionalModels(entry);
					else this.addModelId(entry);
				},
				() => this.showModels(entry),
			),
		);
	}

	private async discoverAdditionalModels(entry: CustomProviderEntry): Promise<void> {
		this.setContent(new Text(theme.fg("muted", "正在读取模型目录…"), 0, 0));
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 20_000);
		try {
			const mainAuth = await this.dependencies.modelRuntime.getAuth(entry.id);
			const apiKey = mainAuth?.auth.apiKey;
			if (!apiKey) throw new Error("这个 Provider 没有可用的 API Key。");
			const discovered = await discoverProviderModels({
				baseUrl: entry.config.baseUrl ?? "",
				api: entry.config.api as CustomProviderApiType,
				apiKey,
				authType: mainAuth.source === "OAuth" ? "oauth" : "api_key",
				signal: controller.signal,
			});
			const existingIds = new Set((entry.config.models ?? []).map((model) => model.id));
			const available = discovered.filter((model) => !existingIds.has(model.id));
			if (available.length === 0) {
				throw new Error("模型目录中没有尚未添加的模型。");
			}
			this.selectAdditionalDiscoveredModel(entry, available);
		} catch (error) {
			this.setContent(
				new SelectSubmenu(
					"自动读取失败",
					error instanceof Error ? error.message : String(error),
					[
						{ value: "manual", label: "手动填写", description: "直接输入模型 ID" },
						{ value: "retry", label: "重试", description: "再次读取模型目录" },
						{ value: "back", label: "返回", description: "返回添加方式" },
					],
					"manual",
					(value) => {
						if (value === "manual") this.addModelId(entry);
						else if (value === "retry") void this.discoverAdditionalModels(entry);
						else this.showAddModelSource(entry);
					},
					() => this.showAddModelSource(entry),
				),
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private selectAdditionalDiscoveredModel(entry: CustomProviderEntry, models: DiscoveredProviderModel[]): void {
		this.setContent(
			new SelectSubmenu(
				"选择新模型",
				`发现 ${models.length} 个尚未添加的模型。`,
				models.map((model) => ({ value: model.id, label: model.name, description: model.id })),
				models[0]?.id ?? "",
				(value) => {
					const selected = models.find((model) => model.id === value);
					if (!selected) return;
					this.addModelName(entry, {
						id: selected.id,
						name: selected.name,
						reasoning: false,
						input: ["text"],
						contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
						maxTokens: DEFAULT_MODEL_MAX_TOKENS,
					});
				},
				() => this.showAddModelSource(entry),
			),
		);
	}

	private showModelActions(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		this.setContent(
			new SelectSubmenu(
				model.name ?? model.id,
				[
					`ID：${model.id}`,
					`输入：${model.input?.includes("image") ? "文本、图片" : "仅文本"}`,
					`思考：${model.reasoning ? "支持" : "不启用"}`,
					`上下文：${model.contextWindow ?? "默认"} · 最大输出：${model.maxTokens ?? "默认"}`,
				].join("\n"),
				[
					{ value: "name", label: "修改显示名称", description: "不修改模型 ID" },
					{
						value: "vision",
						label: "图片输入能力",
						description: model.input?.includes("image") ? "当前：文本和图片" : "当前：仅文本",
					},
					{
						value: "reasoning",
						label: "思考能力",
						description: model.reasoning ? "当前：支持" : "当前：不启用",
					},
					{ value: "context", label: "修改上下文窗口", description: "设置 Token 上限" },
					{ value: "max", label: "修改最大输出", description: "设置输出 Token 上限" },
					{ value: "delete", label: "删除模型", description: "从此 Provider 移除" },
					{ value: "back", label: "返回", description: "返回模型列表" },
				],
				"name",
				(value) => {
					if (value === "name") this.editModelName(entry, model);
					else if (value === "vision") this.editModelVisionCapability(entry, model);
					else if (value === "reasoning") this.editModelReasoningCapability(entry, model);
					else if (value === "context") this.editModelNumber(entry, model, "contextWindow");
					else if (value === "max") this.editModelNumber(entry, model, "maxTokens");
					else if (value === "delete") this.confirmDeleteModel(entry, model);
					else this.showModels(entry);
				},
				() => this.showModels(entry),
			),
		);
	}

	private editModelVisionCapability(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		const currentValue = model.input?.includes("image") ? "image" : "text";
		this.setContent(
			new SelectSubmenu(
				"选择图片输入能力",
				"只有模型官方说明明确支持图片时，才选择“文本和图片”。",
				[
					{ value: "text", label: "仅文本", description: "不能读取图片" },
					{ value: "image", label: "文本和图片", description: "可以读取图片" },
				],
				currentValue,
				(value) => {
					if (value === currentValue) {
						this.showModelActions(entry, model);
						return;
					}
					void this.updateModel(entry, model, {
						input: value === "image" ? ["text", "image"] : ["text"],
					});
				},
				() => this.showModelActions(entry, model),
			),
		);
	}

	private editModelReasoningCapability(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		const currentValue = model.reasoning ? "enabled" : "disabled";
		this.setContent(
			new SelectSubmenu(
				"选择思考能力",
				"只有服务明确支持额外思考参数时，才选择“支持”。",
				[
					{ value: "disabled", label: "不启用", description: "不发送额外思考设置" },
					{ value: "enabled", label: "支持", description: "允许 /effort 调整" },
				],
				currentValue,
				(value) => {
					if (value === currentValue) {
						this.showModelActions(entry, model);
						return;
					}
					void this.updateModel(entry, model, { reasoning: value === "enabled" });
				},
				() => this.showModelActions(entry, model),
			),
		);
	}

	private editModelName(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		this.setContent(
			new ExtensionInputComponent(
				"模型显示名称",
				model.name ?? model.id,
				(value) => {
					const name = value.trim();
					if (!name) return this.showDraftError("名称不能为空", () => this.editModelName(entry, model));
					void this.updateModel(entry, model, { name });
				},
				() => this.showModelActions(entry, model),
				{ initialValue: model.name ?? model.id },
			),
		);
	}

	private editModelNumber(
		entry: CustomProviderEntry,
		model: ModelsJsonModel,
		field: "contextWindow" | "maxTokens",
	): void {
		const label = field === "contextWindow" ? "上下文窗口" : "最大输出";
		this.setContent(
			new ExtensionInputComponent(
				`${label} Token 数`,
				String(
					model[field] ?? (field === "contextWindow" ? DEFAULT_MODEL_CONTEXT_WINDOW : DEFAULT_MODEL_MAX_TOKENS),
				),
				(value) => {
					try {
						void this.updateModel(entry, model, { [field]: parsePositiveInteger(value, label) });
					} catch (error) {
						this.showDraftError(error, () => this.editModelNumber(entry, model, field));
					}
				},
				() => this.showModelActions(entry, model),
				{
					initialValue: String(
						model[field] ?? (field === "contextWindow" ? DEFAULT_MODEL_CONTEXT_WINDOW : DEFAULT_MODEL_MAX_TOKENS),
					),
				},
			),
		);
	}

	private async updateModel(
		entry: CustomProviderEntry,
		model: ModelsJsonModel,
		changes: Partial<ModelsJsonModel>,
	): Promise<void> {
		const updatedModel = { ...model, ...changes };
		const updatedEntry = {
			...entry,
			config: {
				...entry.config,
				models: (entry.config.models ?? []).map((candidate) =>
					candidate.id === model.id ? updatedModel : candidate,
				),
			},
		};
		await this.persistEntry(updatedEntry, `${updatedModel.name ?? updatedModel.id} 已更新。`, () =>
			this.showModelActions(updatedEntry, updatedModel),
		);
	}

	private addModelId(entry: CustomProviderEntry): void {
		this.setContent(
			new ExtensionInputComponent(
				"新模型 ID",
				"例如：model-name",
				(value) => {
					const id = value.trim();
					if (!id) return this.showDraftError("模型 ID 不能为空", () => this.addModelId(entry));
					if ((entry.config.models ?? []).some((model) => model.id === id)) {
						return this.showDraftError("这个模型 ID 已存在。", () => this.addModelId(entry));
					}
					this.addModelName(entry, {
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
						maxTokens: DEFAULT_MODEL_MAX_TOKENS,
					});
				},
				() => this.showProviderActions(entry),
			),
		);
	}

	private addModelName(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		this.setContent(
			new ExtensionInputComponent(
				"模型显示名称",
				model.id,
				(value) => {
					model.name = value.trim() || model.id;
					this.addModelVision(entry, model);
				},
				() => this.addModelId(entry),
				{ initialValue: model.name },
			),
		);
	}

	private addModelVision(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		this.setContent(
			new SelectSubmenu(
				"图片输入能力",
				"只有明确支持图片输入时才选择“文本和图片”。",
				[
					{ value: "text", label: "仅文本", description: "不能接收图片" },
					{ value: "image", label: "文本和图片", description: "支持图片输入" },
				],
				"text",
				(value) => {
					model.input = value === "image" ? ["text", "image"] : ["text"];
					this.addModelReasoning(entry, model);
				},
				() => this.addModelName(entry, model),
			),
		);
	}

	private addModelReasoning(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		this.setContent(
			new SelectSubmenu(
				"思考能力",
				"服务文档明确支持额外思考参数时才选择“支持”。",
				[
					{ value: "false", label: "不支持或不确定", description: "不发送额外思考设置" },
					{ value: "true", label: "支持", description: "允许 /effort 调整" },
				],
				"false",
				(value) => {
					model.reasoning = value === "true";
					const updated = {
						...entry,
						config: { ...entry.config, models: [...(entry.config.models ?? []), model] },
					};
					void this.persistEntry(updated, `${model.name ?? model.id} 已添加。`);
				},
				() => this.addModelVision(entry, model),
			),
		);
	}

	private confirmDeleteModel(entry: CustomProviderEntry, model: ModelsJsonModel): void {
		this.setContent(
			new SelectSubmenu(
				"删除模型",
				`确定从 ${providerDisplayName(entry)} 删除 ${model.name ?? model.id}？`,
				[
					{ value: "cancel", label: "取消", description: "保留模型" },
					{ value: "delete", label: "删除", description: "删除模型配置" },
				],
				"cancel",
				(value) => {
					if (value !== "delete") return this.showModelActions(entry, model);
					const updated = {
						...entry,
						config: {
							...entry.config,
							models: (entry.config.models ?? []).filter((candidate) => candidate.id !== model.id),
						},
					};
					void this.persistEntry(
						updated,
						`${model.name ?? model.id} 已删除。`,
						() => this.showProviderActions(updated),
						{ providerId: entry.id, modelId: model.id },
					);
				},
				() => this.showModelActions(entry, model),
			),
		);
	}

	private confirmDeleteProvider(entry: CustomProviderEntry): void {
		this.setContent(
			new SelectSubmenu(
				"删除 Provider",
				[
					`确定删除 ${providerDisplayName(entry)}（${entry.id}）？`,
					"这会删除 models.json 中的 Provider 和模型配置。",
					"这个 Provider 下已经保存的 API Key 也会删除，其他 Provider 不受影响。",
				].join("\n"),
				[
					{ value: "cancel", label: "取消", description: "保留 Provider" },
					{ value: "delete", label: "删除", description: "删除本地配置" },
				],
				"cancel",
				(value) => {
					if (value === "delete") void this.deleteProvider(entry);
					else this.showProviderActions(entry);
				},
				() => this.showProviderActions(entry),
			),
		);
	}

	private async deleteProvider(entry: CustomProviderEntry): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在删除 ${providerDisplayName(entry)}…`), 0, 0));
		const snapshot = await this.manager.snapshot();
		try {
			await this.manager.delete(entry.id);
			await this.dependencies.modelRuntime.deleteProviderCredentials(entry.id);
			this.dependencies.settingsManager.clearModelReferences(entry.id, undefined, true);
			await this.dependencies.settingsManager.flush();
			await this.dependencies.modelRuntime.reloadConfig();
			await this.dependencies.reconcileModelAfterConfigChange?.();
			await this.dependencies.settingsManager.flush();
			this.notice = `${providerDisplayName(entry)} 已删除；Provider、模型配置和已保存 API Key 均已删除。`;
			this.returnToRoot();
		} catch (error) {
			try {
				await this.manager.restore(snapshot);
				await this.dependencies.modelRuntime.reloadConfig();
			} catch (rollbackError) {
				this.showError(
					"删除 Provider 失败",
					new AggregateError([error, rollbackError], "删除失败，恢复配置时也遇到问题。"),
					() => this.showProviderActions(entry),
				);
				return;
			}
			this.showError("删除 Provider 失败", error, () => this.showProviderActions(entry));
		}
	}

	private async persistEntry(
		entry: CustomProviderEntry,
		successNotice: string,
		onSuccess: () => void | Promise<void> = () => this.showProviderActions(entry),
		removedModel?: { providerId: string; modelId: string },
	): Promise<void> {
		this.setContent(new Text(theme.fg("muted", `正在保存 ${providerDisplayName(entry)}…`), 0, 0));
		const snapshot = await this.manager.snapshot();
		try {
			await this.manager.upsert(entry.id, entry.config, entry.id);
			await this.dependencies.modelRuntime.reloadConfig();
			if (removedModel) {
				this.dependencies.settingsManager.clearModelReferences(removedModel.providerId, removedModel.modelId);
				await this.dependencies.settingsManager.flush();
			}
			await this.dependencies.reconcileModelAfterConfigChange?.();
			await this.dependencies.settingsManager.flush();
			this.notice = successNotice;
			await onSuccess();
		} catch (error) {
			try {
				await this.manager.restore(snapshot);
				await this.dependencies.modelRuntime.reloadConfig();
			} catch (rollbackError) {
				this.showError(
					"保存 Provider 失败",
					new AggregateError([error, rollbackError], "保存失败，恢复配置时也遇到问题。"),
					() => this.showProviderActions(entry),
				);
				return;
			}
			this.showError("保存 Provider 失败", error, () => this.showProviderActions(entry));
		}
	}

	private showDraftError(error: unknown, onBack: () => void): void {
		this.showError("输入有误", error, onBack);
	}

	private showError(title: string, error: unknown, onBack: () => void): void {
		const message = error instanceof Error ? error.message : String(error);
		this.setContent(
			new SelectSubmenu(
				title,
				message,
				[{ value: "back", label: "返回", description: "返回上一步" }],
				"back",
				onBack,
				onBack,
			),
		);
	}
}
