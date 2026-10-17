/**
 * Child side of `workspace-tool-ipc.test.ts`: a real Node process with a real IPC channel to its parent, the same
 * `process.send` / `process.on('message')` link the desktop app's web service uses. The model is the isolated faux
 * stream from the test harness; it is not a real provider turn.
 */
process.env.MYHARNESS_DESKTOP_HOST = "1";

const { createHarness } = await import("../test-harness.ts");
const { createWorkspaceTool } = await import("../../src/tools/workspace.ts");

const pageUrl = process.env.WORKSPACE_IPC_PAGE_URL || "https://example.com/";
const findText = process.env.WORKSPACE_IPC_FIND || "needle";
const uploadPath = process.env.WORKSPACE_IPC_UPLOAD || "note.txt";

const responses = [
	{ toolCalls: [{ name: "workspace", args: { operation: "status" } }] },
	{ toolCalls: [{ name: "workspace", args: { operation: "tabs" } }] },
	{ toolCalls: [{ name: "workspace", args: { operation: "open", type: "browser", url: pageUrl } }] },
	{ toolCalls: [{ name: "workspace", args: { operation: "find", text: findText } }] },
	{ toolCalls: [{ name: "workspace", args: { operation: "upload", path: uploadPath, selector: "#file" } }] },
	"done",
];

try {
	const harness = await createHarness({ responses, tools: [createWorkspaceTool()] });
	await harness.session.prompt("exercise the workspace tool over IPC");
	const results = harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) =>
			(Array.isArray(message.content) ? message.content : [message.content])
				.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
				.join("\n"),
		);
	const text = harness.session.messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
		.join("\n");
	harness.cleanup();
	process.stdout.write(`${JSON.stringify({ ok: true, results, text })}\n`);
	process.exit(0);
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) })}\n`,
	);
	process.exit(1);
}
