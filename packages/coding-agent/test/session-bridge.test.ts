import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/agent/runtime/agent-session.ts";
import { MirrorAgentSession } from "../src/agent/runtime/mirror-agent-session.ts";
import { SessionBridgeClient } from "../src/agent/runtime/session-bridge.ts";
import { readSessionBridgeDescriptor } from "../src/session/bridge/descriptor.ts";
import { SessionManager, setMirrorSessionsAllowed } from "../src/session/manager/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const fixture = fileURLToPath(new URL("./fixtures/session-bridge-owner.ts", import.meta.url));

async function until(condition: () => boolean, what: string, timeoutMs = 45_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("session bridge", () => {
	let owner: ChildProcess | undefined;
	let harness: Harness | undefined;

	afterEach(() => {
		setMirrorSessionsAllowed(false);
		harness?.cleanup();
		harness = undefined;
		owner?.kill();
		owner = undefined;
	});

	async function startOwner(): Promise<string> {
		const child = spawn(process.execPath, ["--import", "tsx", fixture], {
			cwd: dirname(fixture),
			stdio: ["pipe", "pipe", "inherit"],
		});
		owner = child;
		let output = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			output += chunk;
		});
		await until(() => /ready .+\n/.test(output), "the owner process to be ready", 60_000);
		return /ready (.+)\n/.exec(output)![1]!.trim();
	}

	it("lets a second process follow a session another process owns and drive it", async () => {
		const sessionFile = await startOwner();

		// Without permission the session stays exclusive, as before.
		expect(() => SessionManager.open(sessionFile).acquireWriterLock()).toThrow(/already active/);

		setMirrorSessionsAllowed(true);
		const manager = SessionManager.open(sessionFile);
		harness = await createHarness({
			sessionManager: manager,
			createSession: (config) => new MirrorAgentSession(config),
		});
		const mirror = harness.session as MirrorAgentSession;
		expect(manager.isMirror()).toBe(true);
		expect(mirror.isMirror).toBe(true);

		const descriptor = readSessionBridgeDescriptor(sessionFile);
		expect(descriptor).toBeDefined();
		const { client, hello } = await SessionBridgeClient.connect(descriptor!);
		let closed = false;
		mirror.attachBridge(client, hello);
		expect(mirror.messages).toHaveLength(2);
		mirror.onMirrorClosed(() => {
			closed = true;
		});
		const types: AgentSessionEvent["type"][] = [];
		mirror.subscribe((event) => types.push(event.type));

		// A prompt sent from this process runs in the owner and comes back as events and file entries.
		await mirror.prompt("from the web");
		await until(() => types.includes("agent_end"), "the owner to finish the run");
		await until(() => mirror.isIdle && mirror.messages.length === 4, "the conversation to sync");
		expect(types).toContain("agent_start");
		expect(types).toContain("message_end");
		expect(mirror.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);

		// A prompt typed in the owner shows up here too.
		types.length = 0;
		owner!.stdin!.write("prompt:from the terminal\n");
		await until(() => types.includes("agent_end"), "the terminal prompt to finish");
		await until(() => mirror.messages.length === 6, "the terminal prompt to sync");

		// When the owner ends, the mirror reports it so the host can take the session over.
		owner!.stdin!.write("exit\n");
		await until(() => closed, "the mirror to notice the owner ended");
		rmSync(sessionFile, { force: true });
	}, 240_000);
});
