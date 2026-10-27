/** Core Web API routes: state, prompting, models, thinking, compaction and direct shell commands. */

import type { ThinkingLevel } from "@myharness/agent-core";
import type { ImageContent } from "@myharness/ai";
import { modelsAreEqual } from "@myharness/ai/compat";
import { AUTO_MEMORY_SYSTEM_PROMPT } from "../../agent/runtime/auto-memory.ts";
import { buildContextBreakdown } from "../../context/context-breakdown.ts";
import { WorktreeMergedRecords } from "../../git/worktrees/merged-records.ts";
import { formatSkillsForPrompt } from "../../skills/loader/index.ts";
import { resizeImage } from "../../utils/image-resize.ts";
import { collectInputImageAttachments } from "../../utils/input-image-attachments.ts";
import type { WebHost } from "./host.ts";
import type { WebHttpServer } from "./http-server.ts";
import { HttpError } from "./http-server.ts";
import { pagePresence } from "./page-presence.ts";
import {
	entryImages,
	subAgentStateToWire,
	TRANSCRIPT_IMAGE_TYPES,
	toWireModel,
	withTranscriptImageRefs,
} from "./wire.ts";

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
	// A copy that was merged back stays as a read-only record: writing there again would leave work main never sees.
	const requireWritableCopy = () => {
		if (new WorktreeMergedRecords(host.runtimeHost.services.agentDir).covers(host.cwd))
			throw new HttpError(
				409,
				"This copy was merged back into main and is now read-only. Continue in the main copy.",
			);
	};

	server.route("GET", "/api/state", () => host.snapshot());
	// Optional `limit` (newest items) and `before` (item-id cursor) page the transcript; without them the response is unchanged.
	server.route("GET", "/api/transcript", ({ url }) => {
		const page = host.transcript({ limit: url.searchParams.get("limit"), before: url.searchParams.get("before") });
		// The page asks for large images by address (`images=ref`); everyone else keeps the inline response.
		return url.searchParams.get("images") === "ref" ? withTranscriptImageRefs(page) : page;
	});

	/** One image of a persisted transcript entry (the `src` that `images=ref` hands out). */
	server.route("GET", "/api/transcript/image", ({ url, res }) => {
		const entryId = url.searchParams.get("entry") ?? "";
		const index = Number(url.searchParams.get("index"));
		const image =
			Number.isInteger(index) && index >= 0
				? entryImages(host.session.sessionManager.getEntry(entryId))[index]
				: undefined;
		if (!image || !TRANSCRIPT_IMAGE_TYPES.has(image.mimeType)) throw new HttpError(404, "Image not found");
		const bytes = Buffer.from(image.data, "base64");
		res.writeHead(200, {
			"content-type": image.mimeType,
			"content-length": bytes.length,
			// A persisted entry never changes; the address names the chat, the entry and the position.
			"cache-control": "private, max-age=86400, immutable",
			"x-content-type-options": "nosniff",
		});
		res.end(bytes);
	});

	server.route("POST", "/api/prompt", async ({ body }) => {
		requireWritableCopy();
		const payload = asObject(body);
		const rawText = asString(payload.text, "text").trim();
		const images = await toImageContent(host, payload.images);
		const attachments = Array.isArray((payload as { attachments?: unknown }).attachments)
			? (payload as { attachments: unknown[] }).attachments
					.filter((entry) => entry !== null && typeof entry === "object")
					.map((entry) => {
						const record = entry as { id?: unknown; path?: unknown };
						const ref =
							typeof record.path === "string" && record.path
								? record.path
								: typeof record.id === "string"
									? record.id
									: "";
						return ref.trim();
					})
					.filter((ref) => ref.length > 0)
			: [];
		const header = "Attached files (use read to inspect):";
		const refs = attachments.map((ref) => JSON.stringify(ref)).join("\n");
		const text = attachments.length ? (rawText ? `${header}\n${refs}\n\n${rawText}` : `${header}\n${refs}`) : rawText;
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
		const clientMessageId =
			typeof payload.clientMessageId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(payload.clientMessageId)
				? payload.clientMessageId
				: undefined;
		await host.submit(text, { images: [...images, ...pathImages], mode, clientMessageId });
		return { ok: true };
	});

	server.route("POST", "/api/abort", async () => {
		await host.session.abort();
		return { ok: true };
	});
	/**
	 * Stop sub-agents from the activity panel: one task, one dispatch, or all of them. Only the sub-agents stop; the
	 * main run goes on. Fails (with the reason) when nothing could be stopped or a stop was not confirmed.
	 */
	server.route("POST", "/api/sub-agents/stop", async ({ body }) => {
		const input = (body ?? {}) as { all?: unknown; id?: unknown; phase?: unknown; task?: unknown };
		const id = typeof input.id === "string" ? input.id : undefined;
		const task = typeof input.task === "number" && Number.isInteger(input.task) ? input.task : undefined;
		const phase = typeof input.phase === "number" && Number.isInteger(input.phase) ? input.phase : undefined;
		if (input.all !== true && !id) throw new HttpError(400, "Say which sub-agents to stop (id or all).");
		const target =
			input.all === true
				? { all: true }
				: task !== undefined
					? { tasks: [{ id: id as string, phase, task }] }
					: { ids: [id as string] };
		const session = host.session;
		const report = await session.stopSubAgents(target);
		const stopped = report.stopped.reduce((sum, item) => sum + item.tasks.length, 0);
		if (!session.isMirror && stopped === 0)
			throw new HttpError(
				409,
				"Nothing was stopped: those sub-agents have already finished or were already stopped.",
			);
		if (report.unconfirmed > 0)
			throw new HttpError(500, "Some sub-agents did not confirm the stop in time and may still be running.");
		return { ok: true, stopped, errors: report.errors, state: subAgentStateToWire(session.subAgentState) };
	});
	server.route("POST", "/api/abort-compaction", () => {
		host.session.abortCompaction();
		return { ok: true };
	});
	server.route("POST", "/api/abort-retry", () => {
		host.session.abortRetry();
		return { ok: true };
	});

	/** A page says which chat it shows and whether its window has the focus (`gone`: the page is closing). */
	server.route("POST", "/api/presence", ({ body }) => {
		const payload = asObject(body);
		const page = asString(payload.page, "page");
		if (payload.gone === true) pagePresence(server).drop(page);
		else
			pagePresence(server).report(
				page,
				typeof payload.slot === "string" ? payload.slot : "",
				payload.focused === true,
			);
		return { ok: true };
	});
	/**
	 * A page says whether it showed a task-end notification itself (see WebHost.announceTaskEnd): first that it is
	 * showing it (`claim`), then whether it could (`shown`). A claim the server no longer holds answers
	 * `claimed: false`, which means the system popup already took the notification over.
	 */
	server.route("POST", "/api/notifications/answer", ({ body }) => {
		const payload = asObject(body);
		const id = asString(payload.id, "id");
		if (payload.claim === true) return { ok: true, claimed: host.claimTaskNotice(id) };
		host.answerTaskNotice(id, payload.shown === true);
		return { ok: true };
	});

	server.route("POST", "/api/queue/clear", () => {
		const cleared = host.session.clearQueue();
		host.broadcast("queue_cleared", {});
		return { steering: cleared.steering, followUp: cleared.followUp };
	});

	server.route("POST", "/api/ui/respond", async ({ body }) => {
		const payload = asObject(body);
		const id = asString(payload.id, "id");
		const value = payload.value;
		const images = await toImageContent(host, payload.images);
		const ok = host.dialogs.respond(
			id,
			typeof value === "string" || typeof value === "boolean" ? value : undefined,
			images,
		);
		return { ok };
	});
	server.route("POST", "/api/editor-text", ({ body }) => {
		host.dialogs.setEditorTextFromClient(asString(asObject(body).text, "text"));
		return { ok: true };
	});

	// ---- Models -----------------------------------------------------------------
	server.route("GET", "/api/models", async () => {
		const runtime = host.session.modelRuntime;
		// Each session's runtime keeps the credentials it read from auth.json in memory. A key saved by another runtime is
		// on disk only: read the file again, so a provider the Providers page shows as configured is offered here too.
		runtime.reloadCredentials();
		// Only what is already known (models.json and earlier detections): opening a model list never contacts a
		// provider. Models are checked only from Providers → Detect, for the Model IDs the user names.
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
		// The effort chosen next to the model in the model menu; without one the session keeps (and clamps) its own.
		const level = payload.thinkingLevel;
		if (level !== undefined && (typeof level !== "string" || !VALID_THINKING.has(level)))
			throw new HttpError(400, `Invalid thinking level: ${String(level)}`);
		await host.session.setModel(model);
		if (typeof level === "string") host.session.setThinkingLevel(level as ThinkingLevel);
		// The context window, the thinking levels and the session totals all follow the new model: push them now, so
		// every open tab shows the switch itself instead of waiting for the next request to end.
		host.broadcast("usage", host.usage());
		return { ok: true };
	});

	server.route("POST", "/api/model/cycle", async ({ body }) => {
		const direction = asObject(body).direction === "backward" ? "backward" : "forward";
		const result = await host.session.cycleModel(direction);
		// Cycling switches the model too, so it owes the same push as POST /api/model.
		if (result !== undefined) host.broadcast("usage", host.usage());
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
		// Cache use of the whole session so far, summed from what the provider reported for every request (compaction
		// and branch summaries included). Without any reported cache activity the rate is unknown, not 0%.
		const measured = session.getSessionStats().cache;
		const cache = {
			input: measured.prompt.value,
			read: measured.read.value,
			write: measured.write.value,
			hitRate: measured.hitRate.value,
			estimated: measured.hitRate.estimated,
		};
		const breakdown = buildContextBreakdown({
			budget: session.contextBudget,
			systemPrompt: agent.state.systemPrompt,
			contextFiles: loader.getAgentsFiles().agentsFiles,
			skillsPromptText: active.has("read") ? formatSkillsForPrompt(skills).trim() : "",
			memoryPolicyText: session.settingsManager.getAutoMemorySettings().enabled ? AUTO_MEMORY_SYSTEM_PROMPT : "",
			tools,
			deferredTools: [...deferred],
			messages,
		});
		return { ...breakdown, cache };
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
		requireWritableCopy();
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
