import type * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as openai } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

async function capture(api: "anthropic-messages" | "openai-completions", apiKey: string) {
	let payload: Record<string, any> | undefined;
	const server = createServer(async (request, response) => {
		let text = "";
		for await (const chunk of request) text += chunk;
		payload = JSON.parse(text);
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const model: Model<any> = {
		id: "test-model",
		name: "Test",
		api,
		provider: "test-provider",
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		reasoning: false,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	try {
		const context: Context = {
			systemPrompt: "GLOBAL_SENTINEL",
			messages: [{ role: "user", content: "test", timestamp: 0 }],
		};
		const options = { apiKey, cacheRetention: "none" as const };
		const stream =
			api === "anthropic-messages"
				? anthropic(model as Model<"anthropic-messages">, context, options)
				: openai(model as Model<"openai-completions">, context, options);
		for await (const event of stream) if (event.type === "done" || event.type === "error") break;
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	expect(payload).toBeDefined();
	return payload!;
}

afterEach(() => vi.restoreAllMocks());

describe("provider instruction scope on actual HTTP requests", () => {
	it("adds the file identity before global text only for Anthropic OAuth", async () => {
		const oauth = await capture("anthropic-messages", "sk-ant-oat01-test");
		expect(oauth.system.map((block: { text: string }) => block.text)).toEqual([
			"# Identity\n- You are Claude Code, Anthropic's Claude CLI.",
			"GLOBAL_SENTINEL",
		]);
		const ordinary = await capture("anthropic-messages", "test-key");
		expect(ordinary.system.map((block: { text: string }) => block.text)).toEqual(["GLOBAL_SENTINEL"]);
		const other = await capture("openai-completions", "test-key");
		expect(other.messages[0]).toEqual({ role: "system", content: "GLOBAL_SENTINEL" });
		expect(JSON.stringify(other)).not.toContain("Claude Code");
	});
	it("uses edited file content and skips unreadable identity without losing global text", async () => {
		const nativeFs = process.getBuiltinModule("fs") as typeof fs;
		const original = nativeFs.readFileSync;
		let fail = false;
		vi.spyOn(nativeFs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
			if (String(file).replaceAll("\\", "/").endsWith("providers/anthropic/oauth-identity.md")) {
				if (fail) throw new Error("EACCES: test denial");
				return Buffer.from("EDITED_IDENTITY\n");
			}
			return Reflect.apply(original, nativeFs, [file, ...args]);
		}) as typeof original);
		const edited = await capture("anthropic-messages", "sk-ant-oat01-test");
		expect(edited.system[0].text).toBe("EDITED_IDENTITY");
		fail = true;
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const skipped = await capture("anthropic-messages", "sk-ant-oat01-test");
		expect(skipped.system.map((block: { text: string }) => block.text)).toEqual(["GLOBAL_SENTINEL"]);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
	});
});
