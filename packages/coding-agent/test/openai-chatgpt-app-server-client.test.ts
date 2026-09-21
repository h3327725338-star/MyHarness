import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/providers/openai-chatgpt/app-server-client.ts";

describe("OpenAI App Server JSONL client", () => {
	it("handshakes, correlates requests, handles server requests, and shuts down", async () => {
		const script = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { codexHome: process.env.CODEX_HOME } });
  if (message.method === "initialized") send({ method: "test/ready", params: { ok: true } });
  if (message.method === "ping") send({ id: 99, method: "item/tool/call", params: { callId: "call-1" } });
  if (message.id === 99) send({ id: 2, result: { ok: true } });
});
`;
		const client = new AppServerClient({
			executablePath: process.execPath,
			codexHome: "C:\\myharness-test-codex-home",
			cwd: process.cwd(),
			args: ["-e", script],
		});
		try {
			await client.initialize({ name: "test", title: "test", version: "1" });
			expect(await client.waitForNotification("test/ready")).toEqual({ ok: true });
			client.setServerRequestHandler(async (method, params) => {
				expect(method).toBe("item/tool/call");
				expect(params).toEqual({ callId: "call-1" });
				return { success: true };
			});
			expect(await client.request("ping")).toEqual({ ok: true });
		} finally {
			await client.close();
		}
	});

	it("rejects pending protocol work when the App Server crashes", async () => {
		const script = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { codexHome: process.env.CODEX_HOME } });
  if (message.method === "initialized") process.exit(17);
});
`;
		const client = new AppServerClient({
			executablePath: process.execPath,
			codexHome: "C:\\myharness-test-codex-home",
			cwd: process.cwd(),
			args: ["-e", script],
		});
		try {
			await client.initialize({ name: "test", title: "test", version: "1" });
			await expect(client.request("ping")).rejects.toThrow(/App Server exited|closed/);
		} finally {
			await client.close();
		}
	});
});
