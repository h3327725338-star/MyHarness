/**
 * Minimal SDK Usage
 *
 * Uses default resource discovery: skills, extensions, tools, and context files
 * from cwd and ~/.myharness/agent. A Provider/model must already be configured;
 * the model is chosen from settings or the first available configured model.
 */

import { createAgentSession } from "@myharness/coding-agent";

const { session } = await createAgentSession();

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("What files are in the current directory?");
	session.state.messages.forEach((msg) => {
		console.log(msg);
	});
	console.log();
} finally {
	session.dispose();
}
