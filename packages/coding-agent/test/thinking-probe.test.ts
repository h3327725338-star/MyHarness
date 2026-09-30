import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CustomProviderManager, discoverProviderModels } from "../src/providers/models/custom-provider-manager.ts";
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

describe("thinking level probe", () => {
	it("confirms accepted levels only when the server also rejects an invalid value", async () => {
		const accepted = new Set(["low", "medium", "high"]);
		const { baseUrl, seen } = await serve((_request, response, body) =>
			accepted.has(body.reasoning_effort) ? json(response, 200, { choices: [] }) : rejectEffort(response),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
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
		expect(seen[0]).toMatchObject({ url: "/v1/chat/completions", body: { model: "m", max_tokens: 16 } });
		// The first request is the canary with a bogus effort.
		expect(seen[0]?.body.reasoning_effort).toBe("myharness_probe_invalid");
	});

	it("does not call a level supported when the server silently accepts any value", async () => {
		const { baseUrl } = await serve((_request, response) => json(response, 200, { choices: [] }));
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
			headers,
			levels: ["low", "max"],
		});
		expect(result).toEqual({ low: "unverified", max: "unverified" });
	});

	it("keeps every level unknown on rate limits, quota, auth and server errors, without spending more requests", async () => {
		for (const status of [429, 402, 401, 403, 404, 500, 503]) {
			const { baseUrl, seen } = await serve((_request, response) => json(response, status, { error: "no" }));
			const result = await probeThinkingLevels({
				api: "openai-completions",
				baseUrl: `${baseUrl}/v1`,
				modelId: "m",
				headers,
			});
			expect(Object.values(result), `HTTP ${status}`).toEqual(Array(6).fill("unknown"));
			expect(seen).toHaveLength(1);
		}
	});

	it("keeps a level unknown when the rejection does not name the effort parameter", async () => {
		const { baseUrl } = await serve((_request, response, body) =>
			body.reasoning_effort === "high"
				? json(response, 400, { error: { message: "max_tokens is too small for a reasoning model" } })
				: rejectEffort(response),
		);
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: `${baseUrl}/v1`,
			modelId: "m",
			headers,
			levels: ["high", "max"],
		});
		expect(result).toEqual({ high: "unknown", max: "unsupported" });
	});

	it("does not mark a level unsupported when the network fails", async () => {
		const result = await probeThinkingLevels({
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:9/v1",
			modelId: "m",
			headers,
			levels: ["low"],
			timeoutMs: 2000,
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
		expect(unresolvedLevels({ low: "supported", medium: "unknown", high: "unverified" })).toEqual([
			"minimal",
			"medium",
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
