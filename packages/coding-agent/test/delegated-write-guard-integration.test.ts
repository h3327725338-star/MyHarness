import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NESTED_DISPATCH_REJECT_MARKER } from "../src/agent/runtime/role.ts";
import { createDelegatedWriteGuardExtensionSource } from "../src/tools/shell/delegated-write-guard.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function delegatedWriteGuardFactory(pi: unknown): void {
	// Load the exact extension source the parent writes for read-write Explore
	// workers. The loader invokes the default export with the extension API, so
	// the wrapper must both define and invoke the guard function.
	const guardSource = createDelegatedWriteGuardExtensionSource().replace(
		"export default function (pi) {",
		"function guard(pi) {",
	);
	new Function("pi", `${guardSource}\nguard(pi);`)(pi);
}

/**
 * The delegated read-write boundary executed through a real AgentSession:
 * the generated guard extension is loaded as the worker would load it, the
 * jail root points at the session's own temporary worktree, and file writes
 * and shell commands run through the actual tools. Anything outside the jail
 * is rejected before it touches the disk, with no confirmation step.
 */
describe("delegated write guard through AgentSession", () => {
	const harnesses: Harness[] = [];
	const temporaryOutsideDirs: string[] = [];
	let previousWorktreeEnv: string | undefined;

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (temporaryOutsideDirs.length > 0) {
			const directory = temporaryOutsideDirs.pop();
			if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
		if (previousWorktreeEnv === undefined) delete process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE;
		else process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE = previousWorktreeEnv;
		previousWorktreeEnv = undefined;
	});

	it("allows jail-internal writes and rejects paths outside the worktree", async () => {
		const harness = await createHarness({ sessionCwd: "temp", extensionFactories: [delegatedWriteGuardFactory] });
		harnesses.push(harness);
		previousWorktreeEnv = process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE;
		process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE = harness.tempDir;
		const outsideDir = mkdtempSync(join(tmpdir(), "myharness-write-guard-outside-"));
		temporaryOutsideDirs.push(outsideDir);
		const insideFile = join(harness.tempDir, "inside.txt");
		const outsideFile = join(outsideDir, "evil.txt");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "inside.txt", content: "inside\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("write", { path: outsideFile, content: "evil\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bash", { command: `echo evil > "${outsideFile}.sh"` }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write one file inside and one file outside the worktree");

		// The in-jail write went through the real tool and hit the disk.
		expect(existsSync(insideFile)).toBe(true);
		const successfulWrites = harness
			.eventsOfType("tool_execution_end")
			.filter((event) => event.toolName === "write" && !event.isError);
		expect(successfulWrites.length).toBe(1);

		// The outside write and the outside shell redirection were blocked
		// without any confirmation step and never reached the filesystem.
		expect(existsSync(outsideFile)).toBe(false);
		expect(existsSync(`${outsideFile}.sh`)).toBe(false);
		const blocked = harness.eventsOfType("tool_execution_end").filter((event) => event.isError);
		expect(blocked.length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(harness.session.messages)).toContain("[delegated-write-guard]");
	});

	it("rejects mutating git commands through the real bash tool but keeps inspection", async () => {
		const harness = await createHarness({ sessionCwd: "temp", extensionFactories: [delegatedWriteGuardFactory] });
		harnesses.push(harness);
		previousWorktreeEnv = process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE;
		process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE = harness.tempDir;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "git init" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "git commit --allow-empty -m should-never-happen" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect then try to commit");

		// `git init`/`git commit` were blocked before execution: no .git directory exists.
		expect(existsSync(join(harness.tempDir, ".git"))).toBe(false);
		const blockedToolCalls = harness
			.eventsOfType("tool_execution_end")
			.filter((event) => event.isError && event.toolName === "bash");
		expect(blockedToolCalls.length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(harness.session.messages)).toContain("不在允许范围");
	});

	it("rejects nested dispatch at the runtime chokepoint and never exposes dispatch tools", async () => {
		const harness = await createHarness({
			sessionCwd: "temp",
			resourceLoader: { ...createTestResourceLoader(), getAgentRole: () => "delegated" },
		});
		harnesses.push(harness);

		const active = harness.session.getActiveToolNames();
		expect(active).not.toContain("agent");
		expect(active).not.toContain("workflow");
		expect(active).not.toContain("ultracode");

		// The runtime hook rejects dispatch-shaped names, including renamed
		// MCP/skill tools that would sneak past an exact-name list.
		const hook = harness.session.agent.beforeToolCall;
		expect(hook).toBeDefined();
		for (const name of ["agent", "workflow", "ultracode", "agent_dispatch", "subagent-run"]) {
			const decision = await hook!(
				{
					assistantMessage: { role: "assistant", content: [] } as never,
					toolCall: { type: "toolCall", id: "call", name, arguments: {} } as never,
					args: {},
					context: {} as never,
				},
				undefined,
			);
			expect(decision?.block, name).toBe(true);
			expect(decision?.reason ?? "").toContain(NESTED_DISPATCH_REJECT_MARKER);
		}
	});
});
