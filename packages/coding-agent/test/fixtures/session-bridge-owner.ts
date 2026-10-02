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

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.startsWith("prompt:")) void harness.session.prompt(line.slice("prompt:".length));
		if (line === "exit") process.exit(0);
	}
});
