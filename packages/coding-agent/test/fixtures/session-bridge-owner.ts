/**
 * Child process for session-bridge.test.ts: owns a persisted Session (and so serves the session bridge) and runs
 * prompts typed on stdin as "prompt:<text>". Prints `ready <sessionFile>` once the first answer is on disk.
 */
import { fauxAssistantMessage } from "@myharness/ai/compat";
import { createHarness } from "../suite/harness.ts";

const harness = await createHarness({
	persisted: true,
	responses: [
		fauxAssistantMessage("owner answer 1"),
		fauxAssistantMessage("owner answer 2"),
		fauxAssistantMessage("owner answer 3"),
	],
});
await harness.session.prompt("first question");
console.log(`ready ${harness.session.sessionFile}`);

/**
 * Runs a prompt typed in this process. The previous run can still be publishing its settled state when the line
 * arrives, and a session in that window rejects a new prompt, so retry until it is accepted.
 */
async function promptWhenAccepted(text: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		await harness.session.waitForIdle();
		try {
			await harness.session.prompt(text);
			console.log("prompt-finished");
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("already preparing or processing")) {
				console.log(`prompt-failed ${message}`);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	console.log("prompt-failed the session never accepted the prompt");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.startsWith("prompt:")) void promptWhenAccepted(line.slice("prompt:".length));
		if (line === "exit") process.exit(0);
	}
});
