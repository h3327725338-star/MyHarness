import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "myharness-cli-smoke-"));
const config = join(root, "config");
await mkdir(config);
await writeFile(join(root, "fixture.txt"), "LOCAL_TOOL_PROOF_8147\n");
const requests = [];
let toolObserved = false;

function terminateProcessTree(child) {
	const pid = child.pid;
	if (!pid) {
		try {
			child.kill("SIGKILL");
		} catch {
			// The process exited between the timeout and the fallback kill.
		}
		return Promise.resolve();
	}

	if (process.platform === "win32") {
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// The process may already have exited.
				}
				finish();
			}, 5_000);
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", finish);
			killer.once("close", finish);
		});
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// The process may already have exited.
		}
	}
	return Promise.resolve();
}

const server = createServer(async (req, res) => {
	try {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		if (requests.length === 1) {
			res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
			res.end(JSON.stringify({ error: { message: "Controlled transient rate limit", type: "rate_limit_error" } }));
			return;
		}
		const toolMessages = body.messages.filter((m) => m.role === "tool");
		const tool = toolMessages.at(-1);
		const resume = body.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("RESUME_PROBE"));
		if (tool) {
			assert.match(JSON.stringify(tool.content), /LOCAL_TOOL_PROOF_8147/);
			toolObserved = true;
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = resume ? { content: "LOCAL_RESUME_OK" } : toolMessages.length >= 12 ? { content: "LOCAL_TOOL_OK" } : {
			tool_calls: [{ index: 0, id: `call_smoke_read_${toolMessages.length}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(root, "fixture.txt") }) } }],
		};
		res.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	} catch (error) {
		res.writeHead(500);
		res.end(String(error));
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await writeFile(join(config, "models.json"), JSON.stringify({ providers: { "smoke-local": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-fixture-only", models: [{ id: "smoke", contextWindow: 32768, maxTokens: 1024 }] } } }));
await writeFile(join(config, "settings.json"), JSON.stringify({ defaultProvider: "smoke-local", defaultModel: "smoke", telemetry: { enabled: false } }));

async function run(extra) {
	const args = [join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "packages/coding-agent/src/cli.ts"), "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve", "--provider", "smoke-local", "--model", "smoke", "--tools", "read", "--print", ...extra];
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: root,
			env: { ...process.env, MYHARNESS_CODING_AGENT_DIR: config },
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		let settled = false;
		const finish = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(() => {
			void terminateProcessTree(child).finally(() => {
				finish(() => reject(new Error(`CLI timed out and its process tree was terminated: ${output}`)));
			});
		}, 90000);
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => finish(() => code === 0 ? resolve(output) : reject(new Error(`CLI exit ${code}: ${output}`))));
	});
}
try {
	const first = await run(["Read the fixture file once, then report completion."]);
	assert.match(first, /LOCAL_TOOL_OK/);
	assert.equal(toolObserved, true);
	const requestCount = requests.length;
	const resumed = await run(["--continue", "RESUME_PROBE"]);
	assert.match(resumed, /LOCAL_RESUME_OK/);
	assert.ok(requests.length > requestCount);
	assert.ok(requests.at(-1).messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("LOCAL_TOOL_OK")));
	assert.equal(requests.at(-1).messages.filter((m) => m.role === "tool").length, 12);
	console.log(JSON.stringify({ result: "PASS", checks: ["source CLI startup", "custom Provider HTTP SSE", "429 recovery", "12 successive real read-tool rounds", "tool-result roundtrip", "session persistence", "restart and continue"], requests: requests.length, fixtureDirectory: root }, null, 2));
} finally {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(root, { recursive: true, force: true });
}
