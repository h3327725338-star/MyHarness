import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CustomProviderManager,
	detectSpecifiedModels,
	discoverProviderModels,
} from "../src/providers/models/custom-provider-manager.ts";
import {
	applyStatusesToMap,
	mergeLevelStatuses,
	probeThinkingLevels,
	unresolvedLevels,
} from "../src/providers/models/thinking-probe.ts";

interface Seen {
	url: string;
	body: any;
}

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function serve(
	handler: (request: IncomingMessage, response: ServerResponse, body: any) => void,
): Promise<{ baseUrl: string; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			const body = raw ? JSON.parse(raw) : undefined;
			seen.push({ url: request.url ?? "", body });
			handler(request, response, body);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return { baseUrl: `http://127.0.0.1:${address.port}`, seen };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
	response.statusCode = status;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(body));
};

const rejectEffort = (response: ServerResponse) =>
	json(response, 400, {
		error: {
			message: "Invalid value for 'reasoning_effort'.",
			param: "reasoning_effort",
			type: "invalid_request_error",
		},
	});

const headers = new Headers({ Authorization: "Bearer test-key" });

const fast = { retryDelaysMs: [0, 0, 0] } as const;

describe("thinking level probe", () => {
	it("asks about every level on its own: success is supported, an explicit rejection is unsupported", async () => {
		const accepted = new Set(["low", "medium", "high"]);
		const { baseUrl, seen } = await serve((_request, response, body) =>
			accepted.has(body.reasoning_effort) ? json(response, 200, { choices: [] }) : rejectEffort(response),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "never-seen-model",
			headers,
		});
		expect(result).toEqual({
			minimal: "unsupported",
			low: "supported",
			medium: "supported",
			high: "supported",
			xhigh: "unsupported",
			max: "unsupported",
		});
		expect(seen[0]).toMatchObject({
			url: "/v1/chat/completions",
			body: { model: "never-seen-model", max_tokens: 16 },
		});
		// One request per level, each with a real level: nothing else is sent.
		expect(seen.map((entry) => entry.body.reasoning_effort).sort()).toEqual(
			["high", "low", "max", "medium", "minimal", "xhigh"].sort(),
		);
	});

	it("does not derive a level from its neighbours", async () => {
		const { baseUrl } = await serve((_request, response, body) =>
			body.reasoning_effort === "xhigh" ? rejectEffort(response) : json(response, 200, { choices: [] }),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
			headers,
			levels: ["high", "xhigh", "max"],
		});
		expect(result).toEqual({ high: "supported", xhigh: "unsupported", max: "supported" });
	});

	it("tries an undecided level up to three more times and never calls it unsupported", async () => {
		for (const status of [429, 500, 502, 503, 404, 408]) {
			const { baseUrl, seen } = await serve((_request, response) => json(response, status, { error: "no" }));
			const result = await probeThinkingLevels({
				api: "openai-completions",
				baseUrl: `${baseUrl}/v1`,
				modelId: "m",
				headers,
				levels: ["max"],
				...fast,
			});
			expect(result, `HTTP ${status}`).toEqual({ max: "unknown" });
			expect(seen, `HTTP ${status}`).toHaveLength(4);
		}
	});

	it("stops retrying at the first success", async () => {
		let calls = 0;
		const { baseUrl, seen } = await serve((_request, response) =>
			++calls < 3 ? json(response, 503, { error: { message: "upstream overloaded" } }) : json(response, 200, {}),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
			headers,
			levels: ["max"],
			...fast,
		});
		expect(result).toEqual({ max: "supported" });
		expect(seen).toHaveLength(3);
	});

	it("does not retry after an explicit rejection, or when the credentials are refused", async () => {
		const rejected = await serve((_request, response) => rejectEffort(response));
		expect(
			await probeThinkingLevels({
				api: "openai-completions",
				baseUrl: `${rejected.baseUrl}/v1`,
				modelId: "m",
				headers,
				levels: ["max"],
				...fast,
			}),
		).toEqual({ max: "unsupported" });
		expect(rejected.seen).toHaveLength(1);
		for (const status of [401, 403]) {
			const denied = await serve((_request, response) =>
				json(response, status, { error: { message: "Invalid API key for reasoning_effort requests" } }),
			);
			expect(
				await probeThinkingLevels({
					api: "openai-completions",
					baseUrl: `${denied.baseUrl}/v1`,
					modelId: "m",
					headers,
					levels: ["low", "max"],
					...fast,
				}),
			).toEqual({ low: "unknown", max: "unknown" });
			expect(denied.seen).toHaveLength(2);
		}
	});

	it("keeps a level unknown when the rejection does not name the effort", async () => {
		const { baseUrl } = await serve((_request, response, body) =>
			body.reasoning_effort === "high"
				? json(response, 400, {
						error: { message: "The request parameters are invalid.", type: "invalid_request_error" },
					})
				: rejectEffort(response),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
			headers,
			levels: ["high", "max"],
			...fast,
		});
		expect(result).toEqual({ high: "unknown", max: "unsupported" });
	});

	it("reads a rejection that names only the value", async () => {
		const { baseUrl } = await serve((_request, response, body) =>
			body.reasoning_effort === "max"
				? json(response, 400, {
						error: { message: "Unsupported value: 'max'. Supported values are: 'low', 'high'." },
					})
				: json(response, 200, {}),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "max-model",
			headers,
			levels: ["high", "max"],
			...fast,
		});
		expect(result).toEqual({ high: "supported", max: "unsupported" });
	});

	it("treats an answer it cannot read as unknown, and an error inside a 200 like any other error", async () => {
		const html = await serve((_request, response) => {
			response.statusCode = 200;
			response.end("<html>gateway</html>");
		});
		expect(
			await probeThinkingLevels({
				api: "openai-completions",
				baseUrl: `${html.baseUrl}/v1`,
				modelId: "m",
				headers,
				levels: ["max"],
				...fast,
			}),
		).toEqual({ max: "unknown" });
		const wrapped = await serve((_request, response, body) =>
			json(response, 200, {
				error: {
					message: body.reasoning_effort === "max" ? "reasoning_effort 'max' is not supported" : "channel busy",
				},
			}),
		);
		expect(
			await probeThinkingLevels({
				api: "openai-completions",
				baseUrl: `${wrapped.baseUrl}/v1`,
				modelId: "m",
				headers,
				levels: ["high", "max"],
				...fast,
			}),
		).toEqual({ high: "unknown", max: "unsupported" });
	});

	it("gives reasoning more room when the service says 16 tokens are too few", async () => {
		const { baseUrl, seen } = await serve((_request, response, body) =>
			body.max_tokens < 100
				? json(response, 400, { error: { message: "max_tokens is too small for a reasoning model" } })
				: json(response, 200, {}),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
			headers,
			levels: ["high"],
			...fast,
		});
		expect(result).toEqual({ high: "supported" });
		expect(seen.map((entry) => entry.body.max_tokens)).toEqual([16, 1024]);
	});

	it("does not mark a level unsupported when the network fails", async () => {
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:9/v1",
			modelId: "m",
			headers,
			levels: ["low"],
			timeoutMs: 2000,
			...fast,
		});
		expect(result).toEqual({ low: "unknown" });
	});

	it("switches the output-token field when the server refuses the one it was sent", async () => {
		const { baseUrl, seen } = await serve((_request, response, body) => {
			if (body.max_tokens !== undefined) {
				return json(response, 400, {
					error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." },
				});
			}
			return body.reasoning_effort === "low" ? json(response, 200, {}) : rejectEffort(response);
		});
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
			headers,
			levels: ["low", "high"],
			...fast,
		});
		expect(result).toEqual({ low: "supported", high: "unsupported" });
		expect(seen.some((entry) => entry.body.max_completion_tokens === 16)).toBe(true);
	});

	it("uses each API's own effort parameter", async () => {
		const anthropic = await serve((_request, response, body) =>
			["low", "high"].includes(body.output_config?.effort)
				? json(response, 200, {})
				: json(response, 400, {
						error: { message: "output_config.effort: Input should be 'low', 'medium' or 'high'" },
					}),
		);
		expect(
			await probeThinkingLevels({
				api: "anthropic-messages",
				baseUrl: `${anthropic.baseUrl}/v1`,
				modelId: "claude-x",
				headers,
				levels: ["low", "medium"],
			}),
		).toEqual({ low: "supported", medium: "unsupported" });
		expect(anthropic.seen[0]).toMatchObject({ url: "/v1/messages", body: { max_tokens: 16 } });

		const responses = await serve((_request, response, body) =>
			body.reasoning?.effort === "low"
				? json(response, 200, {})
				: json(response, 400, { error: { message: "Unsupported value", param: "reasoning.effort" } }),
		);
		expect(
			await probeThinkingLevels({
				api: "openai-responses",
				baseUrl: `${responses.baseUrl}/v1`,
				modelId: "r",
				headers,
				levels: ["low", "xhigh"],
			}),
		).toEqual({ low: "supported", xhigh: "unsupported" });
		expect(responses.seen[0]).toMatchObject({ url: "/v1/responses", body: { max_output_tokens: 16, store: false } });

		const google = await serve((_request, response, body) =>
			["LOW", "HIGH"].includes(body.generationConfig?.thinkingConfig?.thinkingLevel)
				? json(response, 200, {})
				: json(response, 400, {
						error: { message: "Invalid value at 'generation_config.thinking_config.thinking_level'" },
					}),
		);
		expect(
			await probeThinkingLevels({
				api: "google-generative-ai",
				baseUrl: `${google.baseUrl}/v1beta`,
				modelId: "gem",
				headers: new Headers(),
				googleApiKey: "g-key",
				levels: ["low", "medium"],
			}),
		).toEqual({ low: "supported", medium: "unsupported" });
		expect(google.seen[0]?.url).toBe("/v1beta/models/gem:generateContent?key=g-key");
	});
});

describe("status bookkeeping", () => {
	it("never lets a weaker or unknown result replace a confirmed one", () => {
		expect(
			mergeLevelStatuses(
				{ low: "supported", medium: "unverified", high: "unsupported" },
				{ low: "unknown", medium: "supported", high: "unverified", xhigh: "unverified" },
			),
		).toEqual({ low: "supported", medium: "supported", high: "unsupported", xhigh: "unverified" });
		// Everything a real request has not confirmed as supported is asked again.
		expect(unresolvedLevels({ low: "supported", medium: "unknown", high: "unsupported" })).toEqual([
			"minimal",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("hides only confirmed unsupported levels and keeps unconfirmed ones selectable", () => {
		const map = applyStatusesToMap(
			undefined,
			{
				minimal: "unsupported",
				low: "supported",
				medium: "unverified",
				high: "unknown",
				xhigh: "unverified",
				max: "unsupported",
			},
			{ enableUnconfirmedExtras: true },
		);
		expect(map).toEqual({ minimal: null, xhigh: "xhigh" });
		// A level nobody could check is not hidden on a model without a map, and changes nothing on a configured one.
		expect(applyStatusesToMap(undefined, { max: "unknown" }, { enableUnconfirmedExtras: true })).toEqual({
			max: "max",
		});
		expect(applyStatusesToMap({ high: null }, { high: "unknown", max: "unknown" })).toEqual({ high: null });
		// Existing entries are only changed by confirmed results.
		expect(applyStatusesToMap({ high: null, low: "my-low" }, { high: "unverified", low: "supported" })).toEqual({
			high: null,
			low: "my-low",
		});
	});
});

describe("thinking detection priority", () => {
	it("probes only what the catalog left undecided, and stores the result without disturbing existing entries", async () => {
		const posts: string[] = [];
		const { baseUrl } = await serve((request, response, body) => {
			if (request.method === "POST") {
				posts.push(body.model);
				return ["low", "medium"].includes(body.reasoning_effort) ? json(response, 200, {}) : rejectEffort(response);
			}
			json(response, 200, {
				data: [
					// Catalog lists the efforts: settled by the first priority, never probed.
					{ id: "listed", reasoning: { supported_efforts: ["low", "high"] } },
					// Catalog only says it reasons: undecided, probed.
					{ id: "vague", supported_parameters: ["reasoning"] },
					{ id: "plain" },
				],
			});
		});

		const discovered = await discoverProviderModels({
			baseUrl: `${baseUrl}/v1`,
			api: "openai-completions",
			apiKey: "k",
			probeThinking: {},
		});
		expect(posts.every((model) => model === "vague")).toBe(true);
		const byId = new Map(discovered.map((model) => [model.id, model]));
		expect(byId.get("listed")?.thinkingSource).toBe("catalog");
		expect(byId.get("listed")?.thinkingLevelStatus).toBeUndefined();
		expect(byId.get("plain")?.thinkingSource).toBeUndefined();
		const vague = byId.get("vague");
		expect(vague?.thinkingSource).toBe("probe");
		expect(vague?.thinkingLevelStatus).toEqual({
			minimal: "unsupported",
			low: "supported",
			medium: "supported",
			high: "unsupported",
			xhigh: "unsupported",
			max: "unsupported",
		});
		expect(vague?.thinkingLevelMap).toEqual({ minimal: null, high: null });

		const directory = await mkdtemp(join(tmpdir(), "myharness-probe-"));
		directories.push(directory);
		const path = join(directory, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					relay: {
						baseUrl: `${baseUrl}/v1`,
						api: "openai-completions",
						models: [
							// Old versions wrote this all-hidden marker for a reasoning model with unknown efforts.
							{
								id: "vague",
								reasoning: true,
								thinkingLevelMap: { minimal: null, low: null, medium: null, high: null },
							},
							{ id: "kept", reasoning: true, thinkingLevelMap: { high: null } },
						],
					},
				},
			}),
			"utf8",
		);
		const manager = new CustomProviderManager(path);
		if (!vague) throw new Error("vague model was not discovered");
		const unverified = {
			...vague,
			id: "kept",
			name: "kept",
			thinkingLevelStatus: { high: "unverified", low: "supported" },
		} as const;
		const result = await manager.mergeDiscoveredModels("relay", [vague, unverified], "openai-completions");
		expect(result.updated).toBe(2);
		const saved = JSON.parse(await readFile(path, "utf8")).providers.relay.models;
		expect(saved[0].thinkingLevelMap).toEqual({ minimal: null, high: null });
		expect(saved[0].thinkingLevelStatus).toMatchObject({ low: "supported", high: "unsupported" });
		// An unverified level never overrides what the user already configured for it.
		expect(saved[1].thinkingLevelMap.high).toBeNull();
		expect(saved[1].thinkingLevelStatus.high).toBe("unverified");
	});

	it("probes configured models whose reasoning the catalog does not state, and settles whether they take an effort", async () => {
		const { baseUrl, seen } = await serve((request, response, body) => {
			if (request.method !== "POST")
				return json(response, 200, { data: [{ id: "thinker" }, { id: "plain" }, { id: "other" }] });
			if (body.model === "plain") {
				return json(response, 400, {
					error: {
						message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
						param: "reasoning_effort",
					},
				});
			}
			return ["low", "high"].includes(body.reasoning_effort) ? json(response, 200, {}) : rejectEffort(response);
		});
		const discovered = await discoverProviderModels({
			baseUrl: `${baseUrl}/v1`,
			api: "openai-completions",
			apiKey: "k",
			probeThinking: { candidateModelIds: new Set(["thinker", "plain"]) },
		});
		const byId = new Map(discovered.map((model) => [model.id, model]));
		// Not a candidate and not declared: never probed.
		expect(seen.some((entry) => entry.body?.model === "other")).toBe(false);
		expect(byId.get("other")?.reasoning).toBeUndefined();
		const thinker = byId.get("thinker");
		expect(thinker?.reasoning).toBe(true);
		expect(thinker?.thinkingSource).toBe("probe");
		expect(thinker?.thinkingLevelMap).toEqual({ minimal: null, medium: null });
		const plain = byId.get("plain");
		expect(plain?.reasoning).toBe(false);
		expect(plain?.thinkingLevelMap).toBeUndefined();
		expect(Object.values(plain?.thinkingLevelStatus ?? {}).every((status) => status === "unsupported")).toBe(true);

		// Stored for the configured models only (no new model added), and a later refresh keeps the decision.
		const directory = await mkdtemp(join(tmpdir(), "myharness-probe-"));
		directories.push(directory);
		const path = join(directory, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					relay: {
						baseUrl: `${baseUrl}/v1`,
						api: "openai-completions",
						models: [{ id: "thinker" }, { id: "plain" }, { id: "declared", reasoning: true }],
					},
				},
			}),
			"utf8",
		);
		const manager = new CustomProviderManager(path);
		const declaredRejected = {
			id: "declared",
			name: "declared",
			thinkingSource: "probe",
			thinkingLevelStatus: {
				minimal: "unsupported",
				low: "unsupported",
				medium: "unsupported",
				high: "unsupported",
				xhigh: "unsupported",
				max: "unsupported",
			},
		} as const;
		const result = await manager.mergeDiscoveredModels(
			"relay",
			[...discovered, declaredRejected],
			"openai-completions",
			{
				addNew: false,
			},
		);
		expect(result.added).toBe(0);
		const saved = JSON.parse(await readFile(path, "utf8")).providers.relay.models;
		expect(saved.map((model: { id: string }) => model.id)).toEqual(["thinker", "plain", "declared"]);
		expect(saved[0].reasoning).toBe(true);
		expect(saved[1].reasoning).toBe(false);
		// A user's reasoning declaration is kept; every level is hidden, and that is not mistaken for the legacy marker.
		expect(saved[2].reasoning).toBe(true);
		expect(saved[2].thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: null });
		const again = await manager.mergeDiscoveredModels(
			"relay",
			[{ id: "declared", name: "declared", reasoning: true, thinkingSource: "unconfirmed" }],
			"openai-completions",
		);
		expect(again.updated).toBe(0);
	});

	it("clears the legacy all-hidden marker when nothing settles the levels", async () => {
		const directory = await mkdtemp(join(tmpdir(), "myharness-probe-"));
		directories.push(directory);
		const path = join(directory, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					relay: {
						baseUrl: "https://relay.example/v1",
						api: "openai-completions",
						models: [
							{
								id: "vague",
								reasoning: true,
								thinkingLevelMap: { minimal: null, low: null, medium: null, high: null },
							},
						],
					},
				},
			}),
			"utf8",
		);
		const result = await new CustomProviderManager(path).mergeDiscoveredModels(
			"relay",
			[{ id: "vague", name: "vague", reasoning: true, thinkingSource: "unconfirmed" }],
			"openai-completions",
		);
		expect(result.updated).toBe(1);
		const saved = JSON.parse(await readFile(path, "utf8")).providers.relay.models[0];
		expect(saved.thinkingLevelMap).toBeUndefined();
		expect(saved.reasoning).toBe(true);
	});
});

describe("detecting the Model IDs the user named", () => {
	it("tests a model the endpoint does not list, even when the model list cannot be read", async () => {
		const { baseUrl } = await serve((request, response, body) => {
			if (request.method !== "POST") return json(response, 404, { error: "no model list here" });
			return body.reasoning_effort === "minimal" ? rejectEffort(response) : json(response, 200, { choices: [] });
		});
		const result = await detectSpecifiedModels({
			baseUrl: `${baseUrl}/v1`,
			api: "openai-completions",
			apiKey: "k",
			modelIds: ["brand-new-model"],
			retryDelaysMs: [0, 0, 0],
		});
		expect(result.catalogError?.code).toBe("unsupported");
		expect(result.models).toHaveLength(1);
		expect(result.models[0]).toMatchObject({
			id: "brand-new-model",
			reasoning: true,
			thinkingSource: "probe",
			thinkingLevelStatus: { minimal: "unsupported", high: "supported", xhigh: "supported", max: "supported" },
			thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
		});
	});

	it("does not hide max when the service only fails temporarily, and keeps what is configured", async () => {
		const { baseUrl } = await serve((request, response, body) => {
			if (request.method !== "POST") return json(response, 200, { data: [{ id: "relay-model" }] });
			if (body.reasoning_effort === "max")
				return json(response, 503, { error: { message: "no available channel" } });
			return json(response, 200, { choices: [] });
		});
		const result = await detectSpecifiedModels({
			baseUrl: `${baseUrl}/v1`,
			api: "openai-completions",
			apiKey: "k",
			modelIds: ["relay-model"],
			retryDelaysMs: [0, 0, 0],
		});
		const model = result.models[0];
		expect(model?.thinkingLevelStatus?.max).toBe("unknown");
		expect(model?.thinkingLevelStatus?.xhigh).toBe("supported");
		// Unknown is not unsupported: the level stays available.
		expect(model?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });

		// A model already configured keeps what it has for a level the detection could not settle.
		const directory = await mkdtemp(join(tmpdir(), "myharness-probe-"));
		directories.push(directory);
		const path = join(directory, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					relay: {
						baseUrl: `${baseUrl}/v1`,
						api: "openai-completions",
						models: [{ id: "relay-model", reasoning: true, thinkingLevelMap: { minimal: null, max: "max" } }],
					},
				},
			}),
			"utf8",
		);
		if (!model) throw new Error("model was not detected");
		await new CustomProviderManager(path).mergeDiscoveredModels("relay", [model], "openai-completions");
		const saved = JSON.parse(await readFile(path, "utf8")).providers.relay.models[0];
		expect(saved.thinkingLevelMap).toEqual({ max: "max", xhigh: "xhigh" });
		expect(saved.thinkingLevelStatus.max).toBe("unknown");
	});

	it("leaves everything as it is when nothing could be checked", async () => {
		const { baseUrl } = await serve((_request, response) => json(response, 500, { error: "down" }));
		const result = await detectSpecifiedModels({
			baseUrl: `${baseUrl}/v1`,
			api: "openai-completions",
			apiKey: "k",
			modelIds: ["m"],
			retryDelaysMs: [0, 0, 0],
		});
		const model = result.models[0];
		expect(model?.reasoning).toBeUndefined();
		expect(model?.thinkingSource).toBeUndefined();
		expect(Object.values(model?.thinkingLevelStatus ?? {})).toEqual(Array(6).fill("unknown"));
	});
});
