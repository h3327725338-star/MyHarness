import type { Model } from "@myharness/ai";
import { describe, expect, it, vi } from "vitest";
import { getVisionCapabilityStatus, probeVisionCapability, supportsVision } from "../src/agent/vision/capability.ts";
import type { ModelRuntime } from "../src/providers/runtime/index.ts";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "test",
		name: "Test",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...overrides,
	};
}

describe("vision capability detection", () => {
	it("trusts image capability from a verified model catalog", () => {
		const status = getVisionCapabilityStatus(model({ input: ["text", "image"], inputCapabilitiesKnown: true }));
		expect(status).toBe("declared-supported");
		expect(supportsVision(status)).toBe(true);
	});

	it("requires a probe when a custom model only claims image capability", () => {
		const unverified = model({ input: ["text", "image"], inputCapabilitiesKnown: false });
		expect(getVisionCapabilityStatus(unverified)).toBe("unknown");
		expect(getVisionCapabilityStatus(unverified, { status: "supported", testedAt: 1 })).toBe("tested-supported");
		expect(getVisionCapabilityStatus(unverified, { status: "unsupported", testedAt: 1 })).toBe("tested-unsupported");
	});

	it("treats a declared text-only model as unsupported", () => {
		expect(getVisionCapabilityStatus(model())).toBe("declared-unsupported");
	});

	it("uses cached probe results only for models whose capability is unknown", () => {
		const unknown = model({ inputCapabilitiesKnown: false });
		expect(getVisionCapabilityStatus(unknown)).toBe("unknown");
		expect(getVisionCapabilityStatus(unknown, { status: "supported", testedAt: 1 })).toBe("tested-supported");
		expect(getVisionCapabilityStatus(unknown, { status: "unsupported", testedAt: 1 })).toBe("tested-unsupported");
	});

	it("recognizes a correct response to the built-in probe image", async () => {
		const completeVisionSimple = vi.fn(async (_model: Model<any>, _context: unknown) => ({
			stopReason: "stop",
			content: [{ type: "text", text: "731|蓝色" }],
		}));
		const runtime = { completeVisionSimple } as unknown as ModelRuntime;

		const result = await probeVisionCapability(runtime, model({ inputCapabilitiesKnown: false }));

		expect(result.supported).toBe(true);
		expect((completeVisionSimple.mock.calls[0]?.[0] as Model<any>).input).toEqual(["text", "image"]);
		const context = completeVisionSimple.mock.calls[0]?.[1] as {
			messages: Array<{ content: Array<{ type: string; mimeType?: string }> }>;
		};
		expect(context.messages[0]?.content.some((item) => item.type === "image" && item.mimeType === "image/png")).toBe(
			true,
		);
	});

	it("does not turn request errors into unsupported capability records", async () => {
		const runtime = {
			completeVisionSimple: vi.fn(async () => ({
				stopReason: "error",
				errorMessage: "invalid api key",
				content: [],
			})),
		} as unknown as ModelRuntime;

		await expect(probeVisionCapability(runtime, model({ inputCapabilitiesKnown: false }))).rejects.toThrow(
			"invalid api key",
		);
	});
});
