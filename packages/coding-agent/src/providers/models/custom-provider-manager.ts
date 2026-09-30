import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripJsonComments } from "../../utils/json.ts";
import type { ModelsJsonModel, ModelsJsonProvider } from "./config.ts";
import { ModelConfig } from "./config.ts";

export const CUSTOM_PROVIDER_API_TYPES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
] as const;

export type CustomProviderApiType = (typeof CUSTOM_PROVIDER_API_TYPES)[number];

interface ModelsJsonDocument {
	providers: Record<string, ModelsJsonProvider>;
	[key: string]: unknown;
}

export interface CustomProviderEntry {
	id: string;
	config: ModelsJsonProvider;
}

export interface ModelsJsonSnapshot {
	content: string | undefined;
}

export interface DiscoveredProviderModel {
	id: string;
	name: string;
	/** Capabilities the model catalog states explicitly; a missing field means the catalog did not say. */
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
}

export type ProviderModelDiscoveryErrorCode =
	| "provider_disabled"
	| "missing_configuration"
	| "invalid_base_url"
	| "unsupported"
	| "authentication"
	| "permission"
	| "rate_limited"
	| "connection"
	| "timeout"
	| "invalid_response"
	| "pagination"
	| "persistence";

export class ProviderModelDiscoveryError extends Error {
	readonly code: ProviderModelDiscoveryErrorCode;
	/** HTTP status the endpoint answered with, when it answered. */
	status?: number;
	/** What went wrong at the network level (for example ECONNREFUSED), when that is known. */
	detail?: string;
	/** The model-list address that was requested, without query parameters (they can carry a key). */
	requestUrl?: string;

	constructor(code: ProviderModelDiscoveryErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProviderModelDiscoveryError";
		this.code = code;
	}
}

function describeNetworkError(error: unknown): string | undefined {
	const cause = error instanceof Error ? (error.cause ?? error) : error;
	if (cause instanceof Error) {
		const code = (cause as NodeJS.ErrnoException).code;
		return code ? `${code}${cause.message && cause.message !== code ? `: ${cause.message}` : ""}` : cause.message;
	}
	return undefined;
}

function publicUrl(url: URL): string {
	return `${url.origin}${url.pathname}`;
}

export interface DiscoveredModelsSyncResult {
	added: number;
	existing: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toHeaders(values?: Record<string, string | null>): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(values ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	return headers;
}

function parseDocument(content: string, path: string): ModelsJsonDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(content));
	} catch (error) {
		throw new Error(`无法解析 models.json：${error instanceof Error ? error.message : String(error)}\n文件：${path}`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		throw new Error(`models.json 必须包含 providers 对象。\n文件：${path}`);
	}
	return parsed as ModelsJsonDocument;
}

function modelListUrl(baseUrl: string, api: string): URL {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch (error) {
		throw new ProviderModelDiscoveryError("invalid_base_url", "Provider Base URL 无效。", { cause: error });
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ProviderModelDiscoveryError("invalid_base_url", "Provider Base URL 必须使用 HTTP 或 HTTPS。");
	}

	const path = url.pathname.replace(/\/+$/u, "");
	const hasVersionPath = /\/v\d+(?:beta)?$/u.test(path);
	// Anthropic and Mistral serve the list at /v1/models, Gemini at /v1beta/models; OpenAI-style services take the
	// version from the Base URL (for example https://host/v1).
	const suffix = hasVersionPath
		? "/models"
		: api === "anthropic-messages" || api === "mistral-conversations"
			? "/v1/models"
			: api === "google-generative-ai"
				? "/v1beta/models"
				: "/models";
	url.pathname = `${path}${suffix}`;
	return url;
}

function modelIdFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!isRecord(value)) return undefined;
	const id = typeof value.id === "string" ? value.id : typeof value.name === "string" ? value.name : undefined;
	return id?.replace(/^models\//u, "").trim() || undefined;
}

function cursorParameter(api: string): string {
	if (api === "google-generative-ai") return "pageToken";
	if (api === "anthropic-messages") return "after_id";
	return "after";
}

function nextCursor(body: Record<string, unknown>, api: string): string | undefined {
	const candidates = [
		body.nextPageToken,
		body.next_page_token,
		body.next_page,
		body.next,
		body.nextCursor,
		body.next_cursor,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	if (body.has_more === true || body.hasMore === true) {
		const lastId = body.last_id ?? body.lastId;
		if (typeof lastId === "string" && lastId.trim()) return lastId.trim();
		throw new ProviderModelDiscoveryError(
			"pagination",
			`Provider 返回了未完成的分页结果，但没有提供 ${cursorParameter(api)} 游标。`,
		);
	}
	return undefined;
}

function positiveInteger(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	}
	return undefined;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/**
 * Reads the capabilities a model catalog entry states explicitly. Catalogs differ a lot: OpenAI lists only ids,
 * OpenRouter adds context length, modalities and supported parameters, Anthropic and Gemini add token limits and
 * thinking/image support. Only facts that are actually present are returned; nothing is guessed from the model id.
 */
function detectModelCapabilities(candidate: unknown): Partial<DiscoveredProviderModel> {
	if (!isRecord(candidate)) return {};
	const result: Partial<DiscoveredProviderModel> = {};
	const topProvider = isRecord(candidate.top_provider) ? candidate.top_provider : undefined;
	const capabilities = isRecord(candidate.capabilities) ? candidate.capabilities : undefined;

	const contextWindow = positiveInteger(
		candidate.context_length,
		candidate.context_window,
		candidate.contextWindow,
		candidate.max_context_length,
		candidate.max_input_tokens,
		candidate.inputTokenLimit,
		topProvider?.context_length,
	);
	if (contextWindow !== undefined) result.contextWindow = contextWindow;
	const maxTokens = positiveInteger(
		candidate.max_completion_tokens,
		candidate.max_output_tokens,
		candidate.maxOutputTokens,
		candidate.outputTokenLimit,
		candidate.max_tokens,
		topProvider?.max_completion_tokens,
	);
	if (maxTokens !== undefined) result.maxTokens = maxTokens;

	const supportedParameters = stringList(candidate.supported_parameters);
	const thinking = capabilities && isRecord(capabilities.thinking) ? capabilities.thinking : undefined;
	if (supportedParameters) {
		result.reasoning = supportedParameters.includes("reasoning") || supportedParameters.includes("include_reasoning");
	} else if (thinking && typeof thinking.supported === "boolean") {
		result.reasoning = thinking.supported;
	} else if (typeof candidate.thinking === "boolean") {
		result.reasoning = candidate.thinking;
	} else if (capabilities && typeof capabilities.reasoning === "boolean") {
		result.reasoning = capabilities.reasoning;
	}

	const architecture = isRecord(candidate.architecture) ? candidate.architecture : undefined;
	const modalities = isRecord(candidate.modalities) ? candidate.modalities : undefined;
	const inputModalities = stringList(architecture?.input_modalities) ?? stringList(modalities?.input);
	const imageInput = capabilities && isRecord(capabilities.image_input) ? capabilities.image_input : undefined;
	if (inputModalities) {
		result.input = inputModalities.includes("image") ? ["text", "image"] : ["text"];
	} else if (imageInput && typeof imageInput.supported === "boolean") {
		result.input = imageInput.supported ? ["text", "image"] : ["text"];
	}
	return result;
}

/** Gemini lists embedding and other non-chat models too; keep only the ones that can generate content. */
function isGenerativeModel(candidate: unknown): boolean {
	if (!isRecord(candidate)) return true;
	const methods = stringList(candidate.supportedGenerationMethods);
	return !methods || methods.includes("generateContent") || methods.includes("streamGenerateContent");
}

function isCopilotModelSelectable(value: Record<string, unknown>): boolean {
	const policy = isRecord(value.policy) ? value.policy : undefined;
	const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
	const supports = capabilities && isRecord(capabilities.supports) ? capabilities.supports : undefined;
	return (
		(value.model_picker_enabled === undefined || value.model_picker_enabled === true) &&
		(!policy || policy.state !== "disabled") &&
		(!supports || supports.tool_calls !== false)
	);
}

function parseModelPage(
	body: unknown,
	api: string,
	providerId?: string,
): { models: DiscoveredProviderModel[]; next?: string } {
	if (!isRecord(body)) throw new ProviderModelDiscoveryError("invalid_response", "模型目录返回的不是 JSON 对象。");
	const candidates = Array.isArray(body.data)
		? body.data
		: Array.isArray(body.models)
			? body.models
			: Array.isArray(body.items)
				? body.items
				: undefined;
	if (!candidates) {
		throw new ProviderModelDiscoveryError("invalid_response", "模型目录响应中没有可识别的模型列表。");
	}

	const models: DiscoveredProviderModel[] = [];
	for (const candidate of candidates) {
		if (providerId === "github-copilot" && isRecord(candidate) && !isCopilotModelSelectable(candidate)) continue;
		if (!isGenerativeModel(candidate)) continue;
		const id = modelIdFromUnknown(candidate);
		if (!id) continue;
		const displayName =
			isRecord(candidate) && typeof candidate.displayName === "string"
				? candidate.displayName.trim()
				: isRecord(candidate) && typeof candidate.display_name === "string"
					? candidate.display_name.trim()
					: isRecord(candidate) && typeof candidate.name === "string"
						? candidate.name.replace(/^models\//u, "").trim()
						: id;
		models.push({ id, name: displayName || id, ...detectModelCapabilities(candidate) });
	}
	if (candidates.length > 0 && models.length === 0 && providerId !== "github-copilot") {
		throw new ProviderModelDiscoveryError("invalid_response", "模型目录中的模型记录缺少有效 ID。");
	}
	return { models, next: nextCursor(body, api) };
}

function discoveryHeaders(options: {
	providerId?: string;
	api: string;
	apiKey?: string;
	authType?: "api_key" | "oauth";
	headers?: Record<string, string | null>;
}): Headers {
	const headers = toHeaders(options.headers);
	if (!headers.has("Accept")) headers.set("Accept", "application/json");
	const apiKey = options.apiKey && options.apiKey !== "local" ? options.apiKey : undefined;
	if (options.providerId === "github-copilot") {
		if (!headers.has("User-Agent")) headers.set("User-Agent", "GitHubCopilotChat/0.35.0");
		if (!headers.has("Editor-Version")) headers.set("Editor-Version", "vscode/1.107.0");
		if (!headers.has("Editor-Plugin-Version")) headers.set("Editor-Plugin-Version", "copilot-chat/0.35.0");
		if (!headers.has("Copilot-Integration-Id")) headers.set("Copilot-Integration-Id", "vscode-chat");
		if (!headers.has("X-GitHub-Api-Version")) headers.set("X-GitHub-Api-Version", "2026-06-01");
	}
	if (options.api === "anthropic-messages") {
		const isOAuth = options.authType === "oauth" || apiKey?.includes("sk-ant-oat") === true;
		if (isOAuth) {
			if (apiKey && !headers.has("authorization")) headers.set("Authorization", `Bearer ${apiKey}`);
			if (!headers.has("anthropic-beta")) headers.set("anthropic-beta", "oauth-2025-04-20");
			if (!headers.has("user-agent")) headers.set("user-agent", "claude-cli/2.1.75");
			if (!headers.has("x-app")) headers.set("x-app", "cli");
		} else if (apiKey && !headers.has("x-api-key") && !headers.has("authorization")) {
			headers.set("x-api-key", apiKey);
		}
		if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
	} else if (options.api !== "google-generative-ai" && apiKey && !headers.has("authorization")) {
		headers.set("Authorization", `Bearer ${apiKey}`);
	}
	return headers;
}

function createResponseError(status: number): ProviderModelDiscoveryError {
	const error = ((): ProviderModelDiscoveryError => {
		if (status === 401) return new ProviderModelDiscoveryError("authentication", "Provider 拒绝了当前认证信息。");
		if (status === 403) return new ProviderModelDiscoveryError("permission", "当前认证信息没有读取模型目录的权限。");
		if (status === 404 || status === 405 || status === 501) {
			return new ProviderModelDiscoveryError("unsupported", "该 Provider 不支持模型发现接口。");
		}
		if (status === 408) return new ProviderModelDiscoveryError("timeout", "Provider 模型目录请求超时。");
		if (status === 429) return new ProviderModelDiscoveryError("rate_limited", "Provider 请求过于频繁，请稍后重试。");
		if (status >= 500) {
			return new ProviderModelDiscoveryError("connection", `Provider 服务暂时不可用（HTTP ${status}）。`);
		}
		return new ProviderModelDiscoveryError("invalid_response", `模型发现请求被拒绝（HTTP ${status}）。`);
	})();
	error.status = status;
	return error;
}

export async function discoverProviderModels(options: {
	providerId?: string;
	baseUrl: string;
	api: string;
	apiKey?: string;
	authType?: "api_key" | "oauth";
	headers?: Record<string, string | null>;
	signal?: AbortSignal;
}): Promise<DiscoveredProviderModel[]> {
	if (
		options.api !== "openai-completions" &&
		options.api !== "openai-responses" &&
		options.api !== "anthropic-messages" &&
		options.api !== "google-generative-ai" &&
		options.api !== "mistral-conversations"
	) {
		throw new ProviderModelDiscoveryError("unsupported", `当前 API 类型不支持模型发现：${options.api || "未设置"}。`);
	}

	const baseUrl = modelListUrl(options.baseUrl, options.api);
	const suppliedHeaders = toHeaders(options.headers);
	if (
		options.api === "google-generative-ai" &&
		options.apiKey &&
		options.apiKey !== "local" &&
		!suppliedHeaders.has("x-goog-api-key")
	) {
		baseUrl.searchParams.set("key", options.apiKey);
	}
	const headers = discoveryHeaders(options);
	const unique = new Map<string, DiscoveredProviderModel>();
	const cursors = new Set<string>();
	let cursor: string | undefined;

	for (let page = 0; page < 100; page++) {
		const url = new URL(baseUrl);
		if (cursor) url.searchParams.set(cursorParameter(options.api), cursor);
		let response: Response;
		try {
			response = await fetch(url, { method: "GET", headers, signal: options.signal });
		} catch (error) {
			const failure =
				options.signal?.aborted ||
				(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
					? new ProviderModelDiscoveryError("timeout", "模型发现请求超时或已取消。", { cause: error })
					: new ProviderModelDiscoveryError("connection", "无法连接到 Provider 模型发现接口。", { cause: error });
			failure.detail = describeNetworkError(error);
			failure.requestUrl = publicUrl(url);
			throw failure;
		}
		if (!response.ok) {
			const failure = createResponseError(response.status);
			failure.requestUrl = publicUrl(url);
			throw failure;
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			throw new ProviderModelDiscoveryError("invalid_response", "Provider 返回的不是有效 JSON。", { cause: error });
		}
		const parsed = parseModelPage(body, options.api, options.providerId);
		for (const model of parsed.models) {
			const previous = unique.get(model.id);
			if (!previous || previous.name === previous.id) unique.set(model.id, model);
		}
		if (!parsed.next) return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
		if (cursors.has(parsed.next)) {
			throw new ProviderModelDiscoveryError("pagination", "Provider 返回了重复的分页游标。");
		}
		cursors.add(parsed.next);
		cursor = parsed.next;
	}

	throw new ProviderModelDiscoveryError("pagination", "模型目录分页超过安全上限。");
}

/**
 * Safely updates user-defined providers in models.json.
 *
 * The manager preserves all parsed providers and unknown JSON properties. Since
 * JSON comments cannot be represented after parsing, every successful rewrite
 * keeps the immediately previous source text in models.json.bak.
 */
export class CustomProviderManager {
	private readonly builtinIds = new Set<string>();
	private readonly modelsPath: string | undefined;

	constructor(modelsPath: string | undefined) {
		this.modelsPath = modelsPath;
	}

	getPath(): string | undefined {
		return this.modelsPath;
	}

	isBuiltinProviderId(providerId: string): boolean {
		return this.builtinIds.has(providerId.trim().toLowerCase());
	}

	/**
	 * List user-defined provider entries in models.json.
	 *
	 * MyHarness does not ship built-in Provider IDs, so every entry in models.json
	 * is user-owned and can be renamed or deleted.
	 */
	async list(): Promise<CustomProviderEntry[]> {
		const document = await this.readDocument();
		return Object.entries(document.providers)
			.map(([id, config]) => ({ id, config: structuredClone(config) }))
			.sort((a, b) => (a.config.name ?? a.id).localeCompare(b.config.name ?? b.id));
	}

	async get(providerId: string): Promise<ModelsJsonProvider | undefined> {
		const document = await this.readDocument();
		const provider = document.providers[providerId];
		return provider ? structuredClone(provider) : undefined;
	}

	/**
	 * Append newly discovered models to one provider without replacing any
	 * existing definitions. This deliberately has no removal or metadata update
	 * path because models.json currently does not record whether a model was
	 * entered manually or discovered remotely.
	 */
	async mergeDiscoveredModels(
		providerId: string,
		models: readonly DiscoveredProviderModel[],
		api: string,
	): Promise<DiscoveredModelsSyncResult> {
		const document = await this.readDocument();
		const provider = document.providers[providerId] ?? {};
		const existingModels = provider.models ?? [];
		const existingIds = new Set(existingModels.map((model) => model.id));
		const additions: ModelsJsonModel[] = [];
		const seen = new Set(existingIds);

		for (const model of models) {
			const id = model.id.trim();
			if (!id || seen.has(id)) continue;
			seen.add(id);
			additions.push({
				id,
				...(model.name.trim() && model.name.trim() !== id ? { name: model.name.trim() } : {}),
				api,
			});
		}

		if (additions.length === 0) {
			return { added: 0, existing: models.length };
		}

		document.providers[providerId] = {
			...provider,
			models: [...existingModels, ...additions],
		};
		await this.writeDocument(document);
		return { added: additions.length, existing: models.length - additions.length };
	}

	async snapshot(): Promise<ModelsJsonSnapshot> {
		const path = this.requirePath();
		try {
			return { content: await readFile(path, "utf8") };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: undefined };
			throw error;
		}
	}

	async restore(snapshot: ModelsJsonSnapshot): Promise<void> {
		const path = this.requirePath();
		if (snapshot.content === undefined) {
			try {
				await unlink(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return;
		}
		await this.writeValidatedSource(snapshot.content, false);
	}

	async upsert(providerId: string, provider: ModelsJsonProvider, previousProviderId?: string): Promise<void> {
		const normalizedId = providerId.trim();
		this.validateProviderId(normalizedId);
		if (previousProviderId && previousProviderId !== normalizedId && this.isBuiltinProviderId(previousProviderId)) {
			throw new Error("不能通过自定义 Provider 设置重命名保留 Provider。");
		}
		const document = await this.readDocument();
		if (previousProviderId !== normalizedId && Object.hasOwn(document.providers, normalizedId)) {
			throw new Error(`Provider ID“${normalizedId}”已经存在。`);
		}
		if (previousProviderId && previousProviderId !== normalizedId) {
			delete document.providers[previousProviderId];
		}
		document.providers[normalizedId] = structuredClone(provider);
		await this.writeDocument(document);
	}

	/**
	 * Delete a provider entry from models.json.
	 *
	 * Only removes what is stored in models.json (user data). Returns false when
	 * no such entry exists.
	 */
	async delete(providerId: string): Promise<boolean> {
		const document = await this.readDocument();
		if (!Object.hasOwn(document.providers, providerId)) return false;
		delete document.providers[providerId];
		await this.writeDocument(document);
		await this.scrubBackup((backup) => {
			if (!Object.hasOwn(backup.providers, providerId)) return false;
			delete backup.providers[providerId];
			return true;
		});
		return true;
	}

	/**
	 * Delete the API key written into a provider's models.json entry (the rest of the entry stays). Returns false when
	 * the entry has no such key.
	 */
	async removeApiKey(providerId: string): Promise<boolean> {
		const document = await this.readDocument();
		const provider = document.providers[providerId];
		if (!provider || provider.apiKey === undefined) return false;
		delete provider.apiKey;
		await this.writeDocument(document);
		await this.scrubBackup((backup) => {
			const previous = backup.providers[providerId];
			if (!previous || previous.apiKey === undefined) return false;
			delete previous.apiKey;
			return true;
		});
		return true;
	}

	/**
	 * writeDocument keeps the previous file as models.json.bak, which still holds what was just deleted (including any
	 * literal API key or header). Let `scrub` drop it there too so a deletion leaves no secrets behind.
	 */
	private async scrubBackup(scrub: (backup: ModelsJsonDocument) => boolean): Promise<void> {
		const backupPath = `${this.requirePath()}.bak`;
		try {
			const backup = parseDocument(await readFile(backupPath, "utf8"), backupPath);
			if (!scrub(backup)) return;
			await writeFile(
				backupPath,
				`${JSON.stringify(backup, null, 2)}
`,
				{ encoding: "utf8", mode: 0o600 },
			);
		} catch {
			// The backup is a convenience copy; a missing or unreadable one is not a reason to fail the deletion.
		}
	}

	private validateProviderId(providerId: string): void {
		if (!providerId) throw new Error("Provider ID 不能为空。");
		if (!/^[a-z0-9][a-z0-9._-]*$/u.test(providerId)) {
			throw new Error("Provider ID 只能使用小写字母、数字、点、下划线和短横线。");
		}
		if (this.isBuiltinProviderId(providerId)) {
			throw new Error(`“${providerId}”是保留 Provider ID，请换一个名称。`);
		}
	}

	private requirePath(): string {
		if (!this.modelsPath) throw new Error("当前运行方式没有启用 models.json，无法保存自定义 Provider。");
		return this.modelsPath;
	}

	private async readDocument(): Promise<ModelsJsonDocument> {
		const path = this.requirePath();
		try {
			return parseDocument(await readFile(path, "utf8"), path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
			throw error;
		}
	}

	private async writeDocument(document: ModelsJsonDocument): Promise<void> {
		await this.writeValidatedSource(`${JSON.stringify(document, null, 2)}\n`, true);
	}

	private async writeValidatedSource(content: string, createBackup: boolean): Promise<void> {
		const path = this.requirePath();
		await mkdir(dirname(path), { recursive: true });
		const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
		try {
			await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
			const validation = await ModelConfig.load(temporaryPath);
			const validationError = validation.getError();
			if (validationError) throw new Error(validationError);

			if (createBackup) {
				try {
					await copyFile(path, `${path}.bak`);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			await rename(temporaryPath, path);
		} catch (error) {
			try {
				await unlink(temporaryPath);
			} catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
					throw new AggregateError([error, cleanupError], "保存 models.json 失败，且临时文件清理失败。");
				}
			}
			throw error;
		}
	}
}
