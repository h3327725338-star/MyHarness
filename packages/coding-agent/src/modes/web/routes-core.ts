/** Core Web API routes: state, prompting, models, thinking, compaction and direct shell commands. */

import type { ThinkingLevel } from "@myharness/agent-core";
import type { ImageContent } from "@myharness/ai";
import { modelsAreEqual } from "@myharness/ai/compat";
import { AUTO_MEMORY_SYSTEM_PROMPT } from "../../agent/runtime/auto-memory.ts";
import { buildContextBreakdown } from "../../context/context-breakdown.ts";
import { formatSkillsForPrompt } from "../../skills/loader/index.ts";
import { resizeImage } from "../../utils/image-resize.ts";
import { collectInputImageAttachments } from "../../utils/input-image-attachments.ts";
import type { WebHost } from "./host.ts";
import type { WebHttpServer } from "./http-server.ts";
import { HttpError } from "./http-server.ts";
import { toWireModel } from "./wire.ts";

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BASH_CHUNK_INTERVAL_MS = 60;
const MAX_UPLOAD_IMAGES = 12;

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

function asString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new HttpError(400, `"${name}" must be a string`);
	return value;
}

async function toImageContent(host: WebHost, raw: unknown): Promise<ImageContent[]> {
	if (!Array.isArray(raw) || raw.length === 0) return [];
	const settings = host.session.settingsManager;
	if (settings.getBlockImages()) throw new HttpError(400, "Images are blocked by the current settings (blockImages).");
	if (raw.length > MAX_UPLOAD_IMAGES) throw new HttpError(400, `At most ${MAX_UPLOAD_IMAGES} images per message.`);
	const images: ImageContent[] = [];
	for (const entry of raw as Array<{ mimeType?: unknown; data?: unknown }>) {
		if (typeof entry?.mimeType !== "string" || typeof entry?.data !== "string") continue;
		if (!entry.mimeType.startsWith("image/")) continue;
		if (settings.getImageAutoResize()) {
			const resized = await resizeImage(Buffer.from(entry.data, "base64"), entry.mimeType);
			if (resized) {
				images.push({ type: "image", mimeType: resized.mimeType, data: resized.data });
				continue;
			}
		}
		images.push({ type: "image", mimeType: entry.mimeType, data: entry.data });
	}
	return images;
}

export function registerCoreRoutes(server: WebHttpServer, host: WebHost): void {
	server.route("GET", "/api/state", () => host.snapshot());
	server.route("GET", "/api/transcript", () => host.transcript());

	server.route("POST", "/api/prompt", async ({ body }) => {
		const payload = asObject(body);
		const text = asString(payload.text, "text").trim();
		const images = await toImageContent(host, payload.images);
		if (!text && images.length === 0) throw new HttpError(400, "Empty message");
		const modeRaw = payload.mode;
		const mode =
			modeRaw === "steer" || modeRaw === "followUp" || modeRaw === "interrupt" || modeRaw === "auto"
				? modeRaw
				: "auto";
		// Same as the TUI: standalone local image paths in the text become attachments.
		const pathImages = await collectInputImageAttachments(text, {
			autoResizeImages: host.session.settingsManager.getImageAutoResize(),
		});
		await host.submit(text, { images: [...images, ...pathImages], mode });
		return { ok: true };
	});

	server.route("POST", "/api/abort", async () => {
		await host.session.abort();
		return { ok: true };
	});
	server.route("POST", "/api/abort-compaction", () => {
		host.session.abortCompaction();
		return { ok: true };
	});
	server.route("POST", "/api/abort-retry", () => {
		host.session.abortRetry();
		return { ok: true };
	});

	server.route("POST", "/api/queue/clear", () => {
		const cleared = host.session.clearQueue();
		return { steering: cleared.steering, followUp: cleared.followUp };
	});

	server.route("POST", "/api/ui/respond", ({ body }) => {
		const payload = asObject(body);
		const id = asString(payload.id, "id");
		const value = payload.value;
		const ok = host.dialogs.respond(id, typeof value === "string" || typeof value === "boolean" ? value : undefined);
		return { ok };
	});
	server.route("POST", "/api/editor-text", ({ body }) => {
		host.dialogs.setEditorTextFromClient(asString(asObject(body).text, "text"));
		return { ok: true };
	});

	// ---- Models -----------------------------------------------------------------
	server.route("GET", "/api/models", async ({ url }) => {
		const runtime = host.session.modelRuntime;
		if (url.searchParams.get("refresh") === "1" && process.env.MYHARNESS_OFFLINE !== "1") {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15_000);
			try {
				await runtime.refresh({ signal: controller.signal });
			} catch {
				// A failed catalog refresh keeps the last known catalog.
			} finally {
				clearTimeout(timer);
			}
			// The refresh can change what the current model supports (thinking efforts included).
			if (!host.session.isStreaming) await host.session.reconcileModelAfterConfigChange().catch(() => {});
		}
		const available = await runtime.getAvailable();
		const current = host.session.model;
		const settings = host.session.settingsManager;
		const providers = new Map<string, { id: string; name: string; models: ReturnType<typeof toWireModel>[] }>();
		for (const model of available) {
			let entry = providers.get(model.provider);
			if (!entry) {
				entry = {
					id: model.provider,
					name: runtime.getProvider(model.provider)?.name ?? model.provider,
					models: [],
				};
				providers.set(model.provider, entry);
			}
			entry.models.push(toWireModel(model));
		}
		const scoped = host.session.scopedModels.map((entry) => ({
			provider: entry.model.provider,
			id: entry.model.id,
			thinkingLevel: entry.thinkingLevel,
		}));
		return {
			current: current ? { provider: current.provider, id: current.id } : null,
			providers: [...providers.values()],
			scoped,
			defaults: {
				provider: settings.getDefaultProvider() ?? null,
				model: settings.getDefaultModel() ?? null,
				thinkingLevel: settings.getDefaultThinkingLevel() ?? null,
			},
			error: runtime.getError() ?? null,
			currentAvailable: current ? available.some((model) => modelsAreEqual(model, current)) : false,
		};
	});

	server.route("POST", "/api/model", async ({ body }) => {
		const payload = asObject(body);
		const provider = asString(payload.provider, "provider");
		const id = asString(payload.id, "id");
		const model = host.session.modelRuntime.getModel(provider, id);
		if (!model) throw new HttpError(404, `Unknown model ${provider}/${id}`);
		if (host.session.isStreaming) throw new HttpError(409, "Cannot switch models while the agent is running.");
		await host.session.setModel(model);
		return { ok: true };
	});

	server.route("POST", "/api/model/cycle", async ({ body }) => {
		const direction = asObject(body).direction === "backward" ? "backward" : "forward";
		const result = await host.session.cycleModel(direction);
		return { changed: result !== undefined };
	});

	server.route("POST", "/api/thinking", ({ body }) => {
		const level = asString(asObject(body).level, "level");
		if (!VALID_THINKING.has(level)) throw new HttpError(400, `Invalid thinking level: ${level}`);
		host.session.setThinkingLevel(level as ThinkingLevel);
		return { ok: true, level: host.session.thinkingLevel };
	});

	// ---- Context ---------------------------------------------------------------
	/** What the next model request is made of, measured on the real system prompt, tool definitions and messages. */
	server.route("GET", "/api/context", () => {
		const session = host.session;
		const { agent } = session;
		const loader = session.resourceLoader;
		const extensionTools = new Set<string>();
		for (const extension of loader.getExtensions().extensions)
			for (const name of extension.tools.keys()) extensionTools.add(name);
		const active = new Set(session.getActiveToolNames());
		const tools = session
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				extension: extensionTools.has(tool.name),
			}));
		const messages = agent.state.messages;
		const compat = session.model?.compat as
			| { supportsToolSearch?: boolean; supportsToolReferences?: boolean }
			| undefined;
		const deferred = new Set<string>();
		if (compat?.supportsToolSearch === true || compat?.supportsToolReferences === true) {
			const called = new Set<string>();
			for (const message of messages) {
				if (message.role === "assistant") {
					for (const block of message.content) if (block.type === "toolCall") called.add(block.name);
				} else if (message.role === "toolResult") {
					for (const name of message.addedToolNames ?? [])
						if (!called.has(name) && active.has(name)) deferred.add(name);
				}
			}
		}
		const skills = loader.getSkills().skills;
		return buildContextBreakdown({
			budget: session.contextBudget,
			systemPrompt: agent.state.systemPrompt,
			contextFiles: loader.getAgentsFiles().agentsFiles,
			skillsPromptText: active.has("read") ? formatSkillsForPrompt(skills).trim() : "",
			memoryPolicyText: session.settingsManager.getAutoMemorySettings().enabled ? AUTO_MEMORY_SYSTEM_PROMPT : "",
			tools,
			deferredTools: [...deferred],
			messages,
		});
	});

	server.route("POST", "/api/compact", async ({ body }) => {
		const instructions =
			typeof asObject(body ?? {}).instructions === "string" ? (asObject(body).instructions as string) : undefined;
		if (host.session.isStreaming) throw new HttpError(409, "Cannot compact while the agent is running.");
		try {
			const result = await host.session.compact(instructions?.trim() || undefined);
			return { ok: true, tokensAfter: result.estimatedTokensAfter };
		} catch (error) {
			throw new HttpError(500, error instanceof Error ? error.message : String(error));
		}
	});

	// ---- Direct shell command ("!" / "!!") ---------------------------------------
	let bashSeq = 0;
	server.route("POST", "/api/bash", async ({ body }) => {
		const payload = asObject(body);
		const command = asString(payload.command, "command").trim();
		if (!command) throw new HttpError(400, "Empty command");
		const excludeFromContext = payload.excludeFromContext === true;
		const session = host.session;
		if (session.isBashRunning) throw new HttpError(409, "A shell command is already running.");
		const id = `bash-${Date.now()}-${++bashSeq}`;
		const cwd = session.sessionManager.getCwd();
		host.broadcast("bash_start", { id, command, cwd, excludeFromContext, ts: Date.now() });

		let buffer = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flush = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			if (!buffer) return;
			const chunk = buffer;
			buffer = "";
			host.broadcast("bash_chunk", { id, chunk });
		};
		const finish = (result: {
			output: string;
			exitCode: number | undefined;
			cancelled: boolean;
			timedOut?: boolean;
			truncated: boolean;
			fullOutputPath?: string;
		}) => {
			flush();
			host.broadcast("bash_end", {
				id,
				output: result.output,
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				timedOut: result.timedOut === true,
				truncated: result.truncated,
				fullOutputPath: result.fullOutputPath,
				ts: Date.now(),
			});
		};
		void (async () => {
			try {
				const hook = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd,
				});
				if (hook?.result) {
					session.recordBashResult(command, hook.result, { excludeFromContext });
					finish(hook.result);
					return;
				}
				const result = await session.executeBash(
					command,
					(chunk) => {
						buffer += chunk;
						if (!timer) timer = setTimeout(flush, BASH_CHUNK_INTERVAL_MS);
					},
					{ excludeFromContext, operations: hook?.operations },
				);
				finish(result);
			} catch (error) {
				flush();
				host.broadcast("bash_end", {
					id,
					output: "",
					exitCode: undefined,
					cancelled: false,
					timedOut: false,
					truncated: false,
					error: error instanceof Error ? error.message : String(error),
					ts: Date.now(),
				});
			}
		})();
		return { id };
	});
	server.route("POST", "/api/bash/abort", () => {
		host.session.abortBash();
		return { ok: true };
	});
}
