import { describe, expect, it } from "vitest";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness } from "./harness.ts";

describe("sub-agent tool availability", () => {
	it("exposes the agent tool only when the global setting is enabled", async () => {
		const disabled = await createHarness();
		try {
			expect(disabled.session.getAllTools().map((tool) => tool.name)).toContain("agent");
			expect(disabled.session.getActiveToolNames()).not.toContain("agent");
		} finally {
			disabled.cleanup();
		}

		const enabled = await createHarness({
			settings: {
				subAgent: {
					enabled: true,
					provider: "faux",
					model: "faux-model",
					thinkingLevel: "medium",
				},
			},
		});
		try {
			expect(enabled.session.getActiveToolNames()).toContain("agent");
			expect(enabled.session.getActiveToolNames()).toContain("workflow");
			expect(enabled.session.getActiveToolNames()).toContain("ultracode");
			expect(enabled.session.systemPrompt).toContain("- agent:");
			expect(enabled.session.systemPrompt).toContain("- ultracode:");
		} finally {
			enabled.cleanup();
		}
	});

	it("updates the active tool list when the setting changes", async () => {
		const harness = await createHarness();
		try {
			harness.session.setSubAgentEnabled(true);
			expect(harness.session.getActiveToolNames()).toContain("agent");

			harness.session.setSubAgentEnabled(false);
			expect(harness.session.getActiveToolNames()).not.toContain("agent");
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.session.getActiveToolNames()).not.toContain("ultracode");
			expect(harness.session.systemPrompt).not.toContain("- agent:");
		} finally {
			harness.cleanup();
		}
	});

	it("does not bypass an explicit tool allowlist", async () => {
		const harness = await createHarness({
			settings: { subAgent: { enabled: true } },
			allowedToolNames: ["read"],
			initialActiveToolNames: ["read"],
		});
		try {
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("agent");
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			harness.cleanup();
		}
	});

	it("enforces the delegated tool boundary even when a session requests write tools", async () => {
		const resourceLoader = {
			...createTestResourceLoader(),
			getAgentRole: () => "delegated" as const,
		};
		const delegated = await createHarness({
			resourceLoader,
			allowedToolNames: ["read", "bash", "edit", "write", "symbols", "agent", "workflow", "ultracode", "custom"],
			initialActiveToolNames: [
				"read",
				"bash",
				"edit",
				"write",
				"symbols",
				"agent",
				"workflow",
				"ultracode",
				"custom",
			],
		});
		try {
			expect(
				delegated.session
					.getAllTools()
					.map((tool) => tool.name)
					.sort(),
			).toEqual(["bash", "read", "symbols"].sort());
			expect(delegated.session.getActiveToolNames().sort()).toEqual(["bash", "read", "symbols"].sort());
		} finally {
			delegated.cleanup();
		}
	});
});
