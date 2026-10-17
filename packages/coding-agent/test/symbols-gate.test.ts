/**
 * W11 gate: while `codeIntelligence.symbolsEnabled` is off (the default), the symbols tool must not
 * exist anywhere in a session: not in the model's tool list, not among the configured tools
 * (getAllTools / the sidebar source), not in the delegated whitelist or the worker `--tools` argument,
 * and therefore not in the system prompt. While it is on, behaviour must match the pre-gate build.
 */
import { describe, expect, it } from "vitest";
import { restrictToolNamesForRole } from "../src/agent/runtime/role.ts";
import { buildSubAgentArgs, hasSuccessfulInvestigationEvidence } from "../src/tools/sub-agent.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const SYMBOLS_GUIDELINE = "call find_existing with the intent in plain words";

function toolsArgument(args: string[]): string[] {
	const index = args.indexOf("--tools");
	expect(index).toBeGreaterThanOrEqual(0);
	return args[index + 1].split(",");
}

describe("codeIntelligence.symbolsEnabled gate", () => {
	it("keeps symbols out of a default main session (tool list, configured tools, prompt)", async () => {
		const harness = await createHarness();
		try {
			expect(harness.settingsManager.getCodeIntelligenceSettings().symbolsEnabled).toBe(false);
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("symbols");
			expect(harness.session.getActiveToolNames()).not.toContain("symbols");
			expect(harness.session.getToolDefinition("symbols")).toBeUndefined();
			expect(harness.session.isBuiltinEnabled("symbols")).toBe(false);
			// apply_rename only applies plans made by symbols, so it is gated with it.
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("apply_rename");
			expect(harness.session.getActiveToolNames()).not.toContain("apply_rename");
			expect(harness.session.systemPrompt).not.toContain(SYMBOLS_GUIDELINE);
			// Asking for the tool by name cannot bring it back: it is not registered, so the active set
			// drops the unknown name instead of erroring.
			harness.session.setActiveToolsByName(["symbols"]);
			expect(harness.session.getActiveToolNames()).not.toContain("symbols");
		} finally {
			harness.cleanup();
		}
	});

	it("registers symbols in a main session when symbolsEnabled is on (same as before the gate)", async () => {
		const harness = await createHarness({ settings: { codeIntelligence: { symbolsEnabled: true } } });
		try {
			expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("symbols");
			expect(harness.session.getActiveToolNames()).toContain("symbols");
			expect(harness.session.getActiveToolNames()).toContain("apply_rename");
			expect(harness.session.getToolDefinition("symbols")?.name).toBe("symbols");
			expect(harness.session.isBuiltinEnabled("symbols")).toBe(true);
			expect(harness.session.systemPrompt).toContain(SYMBOLS_GUIDELINE);
		} finally {
			harness.cleanup();
		}
	});

	it("saves the switch per session and does not apply it live (restart-after-effect)", async () => {
		const harness = await createHarness();
		try {
			const current = harness.settingsManager.getCodeIntelligenceSettings();
			harness.settingsManager.setCodeIntelligenceSettings({ ...current, symbolsEnabled: true });
			// The saved settings now say on, but this session decided its tool set when it started.
			expect(harness.session.isBuiltinEnabled("symbols")).toBe(false);
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("symbols");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps symbols out of the delegated whitelist when the switch is off", async () => {
		const resourceLoader = {
			...createTestResourceLoader(),
			getAgentRole: () => "delegated" as const,
		};
		const delegated = await createHarness({ resourceLoader });
		try {
			expect(delegated.session.getAllTools().map((tool) => tool.name)).not.toContain("symbols");
			expect(delegated.session.getActiveToolNames()).not.toContain("symbols");
		} finally {
			delegated.cleanup();
		}
	});

	it("includes symbols in the delegated whitelist when the switch is on", async () => {
		const resourceLoader = {
			...createTestResourceLoader(),
			getAgentRole: () => "delegated" as const,
		};
		const delegated = await createHarness({
			resourceLoader,
			settings: { codeIntelligence: { symbolsEnabled: true } },
		});
		try {
			expect(delegated.session.getAllTools().map((tool) => tool.name)).toContain("symbols");
			expect(delegated.session.getActiveToolNames()).toContain("symbols");
		} finally {
			delegated.cleanup();
		}
	});

	it("restrictToolNamesForRole removes the gated tool only when the caller reports it off", () => {
		const off = (name: string) => name !== "symbols";
		expect(restrictToolNamesForRole("delegated", undefined, off)).not.toContain("symbols");
		expect(restrictToolNamesForRole("delegated", undefined, () => true)).toContain("symbols");
		// A caller with no settings manager keeps the historical whitelist.
		expect(restrictToolNamesForRole("delegated", undefined)).toContain("symbols");
		expect(restrictToolNamesForRole("delegated", ["read", "symbols", "edit"], off)).toEqual(["read"]);
		expect(restrictToolNamesForRole("main", ["read", "symbols"], off)).toEqual(["read"]);
		expect(restrictToolNamesForRole("main", ["read", "symbols"], () => true)).toEqual(["read", "symbols"]);
	});

	it("buildSubAgentArgs leaves symbols out of the worker's --tools when symbolsEnabled is false", () => {
		const base = {
			provider: "faux",
			model: "faux-model",
			thinkingLevel: "off" as const,
			systemPromptPath: "prompt.md",
			guardPath: "guard.mjs",
		};
		expect(toolsArgument(buildSubAgentArgs({ ...base, symbolsEnabled: false }))).not.toContain("symbols");
		expect(toolsArgument(buildSubAgentArgs({ ...base, symbolsEnabled: false, mode: "read-write" }))).not.toContain(
			"symbols",
		);
		expect(toolsArgument(buildSubAgentArgs({ ...base, symbolsEnabled: true }))).toContain("symbols");
		// apply_rename follows the same switch, and only read-write workers get it.
		expect(toolsArgument(buildSubAgentArgs({ ...base, symbolsEnabled: false, mode: "read-write" }))).not.toContain(
			"apply_rename",
		);
		expect(toolsArgument(buildSubAgentArgs({ ...base, symbolsEnabled: true, mode: "read-write" }))).toContain(
			"apply_rename",
		);
		expect(toolsArgument(buildSubAgentArgs({ ...base, symbolsEnabled: true }))).not.toContain("apply_rename");
		// Callers that never learned about the switch keep the historical list (the child session still
		// applies its own settings gate when it builds).
		expect(toolsArgument(buildSubAgentArgs(base))).toContain("symbols");
	});

	it("does real-work verification without any symbols call", () => {
		const transcript = [{ toolCallId: "1", toolName: "read", args: { path: "a.ts" }, status: "completed" as const }];
		expect(hasSuccessfulInvestigationEvidence(transcript, "read-only")).toBe(true);
		expect(hasSuccessfulInvestigationEvidence(transcript, "read-write")).toBe(true);
		expect(
			hasSuccessfulInvestigationEvidence(
				[{ toolCallId: "1", toolName: "read", args: { path: "a.ts" }, status: "failed" as const }],
				"read-only",
			),
		).toBe(false);
	});
});
