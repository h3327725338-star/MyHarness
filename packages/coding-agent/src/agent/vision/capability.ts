import type { Model } from "@myharness/ai";
import { contentText } from "@myharness/ai";
import type { VisionCapabilityTestRecord } from "../../config/settings/types.ts";
import type { ModelRuntime } from "../../providers/runtime/index.ts";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";

export type VisionCapabilityStatus =
	| "declared-supported"
	| "declared-unsupported"
	| "tested-supported"
	| "tested-unsupported"
	| "unknown";

export interface VisionCapabilityProbeResult {
	supported: boolean;
	response: string;
}

const VISION_PROBE_TIMEOUT_MS = 30_000;
const VISION_PROBE_IMAGE =
	"iVBORw0KGgoAAAANSUhEUgAAALQAAABkCAIAAACgkY1KAAABsklEQVR4nO3dQU7EMBAAwf3C8kl+zHfgyCWNDJ6ViVQlXzOJ7b7n8QnhcfoD+L/EQRIHSRwkcZDEQRIHSRwkcZDEQRIHSRwkcZDEQRIHSRwkcZDEQRIHSRwkcZCW4nh7/7jF2jmI55zx+Tv7unz74lPiuD6+8bscH7izu8WnxHF9fON3OT5wZ3eLT4nj+vjG73J84M7uFp8Sx/Xxjd/l+MCd3S0+JY4B43e5P3+kNnEMEMcN1uKex4njBmtxz+PEcYO1uOdx4rjBWtzzvlfXMP46cYhjeII4/kIc347fujjEIY5XvU4cL4xjvIbnb5z6fnEsEUc6fuviOPL94lgijnT81sVx5PvFcW38es5+jDjEMTxBHNfEIY4kDnEkcYgjiUMcSRziSOIQRxKHOJI4xJHG43huePXraog4lg53fKA4xJEDxSGOHCgOceRAcdw4DsTBT8RBEgdJHCRxkMRBEgdJHCRxkMRBEgdJHCRxkMRBEgdJHCRxkMRBEgdJHCQ/HSaJgyQOkjhI4iCJgyQOkjhI4iCJgyQOkjhI4iCJgyQOkjhI4iCJgyQOkjhI4iCJg/QF1pjF5hubBUYAAAAASUVORK5CYII=";

export function getVisionCapabilityStatus(
	model: Model<any>,
	testRecord?: VisionCapabilityTestRecord,
): VisionCapabilityStatus {
	if (model.inputCapabilitiesKnown === false) {
		if (testRecord?.status === "supported") return "tested-supported";
		if (testRecord?.status === "unsupported") return "tested-unsupported";
		return "unknown";
	}
	return model.input.includes("image") ? "declared-supported" : "declared-unsupported";
}

export function supportsVision(status: VisionCapabilityStatus): boolean {
	return status === "declared-supported" || status === "tested-supported";
}

export function canTestVision(status: VisionCapabilityStatus): boolean {
	return status === "unknown" || status === "tested-unsupported";
}

export function withVisionInput(model: Model<any>): Model<any> {
	if (model.input.includes("image")) return model;
	return { ...model, input: [...model.input, "image"] };
}

export async function probeVisionCapability(
	modelRuntime: ModelRuntime,
	model: Model<any>,
): Promise<VisionCapabilityProbeResult> {
	const response = await modelRuntime.completeVisionSimple(
		withVisionInput(model),
		{
			systemPrompt: loadSystemPrompt("tasks/vision-probe.md"),
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Please read this test image." },
						{ type: "image", data: VISION_PROBE_IMAGE, mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			maxRetries: 0,
			maxTokens: 64,
			timeoutMs: VISION_PROBE_TIMEOUT_MS,
		},
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "模型请求失败");
	}
	if (response.stopReason === "aborted") {
		throw new Error("模型识图能力检测超时或被取消");
	}
	const output = contentText(response.content, "\n").trim();
	if (!output) throw new Error("模型没有返回检测结果");
	return {
		supported: /\b731\b/u.test(output) && /(?:蓝|blue)/iu.test(output),
		response: output,
	};
}
