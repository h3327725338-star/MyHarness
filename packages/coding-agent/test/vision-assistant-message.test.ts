import { describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/agent/runtime/messages.ts";
import type { VisionAssistantMessageDetails } from "../src/agent/vision/assistant.ts";
import {
	isVisionAssistantMessage,
	VisionAssistantMessageComponent,
} from "../src/modes/interactive/components/vision-assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createMessage(status: "success" | "error"): CustomMessage<VisionAssistantMessageDetails> {
	return {
		role: "custom",
		customType: "Vision Assistant",
		content: "[Vision Assistant 图像分析]\n\n## 图片概述\n完整视觉报告",
		display: true,
		details: {
			status,
			provider: "test",
			model: "vision",
			thinkingLevel: "medium",
			imageCount: 2,
			durationMs: 2400,
			cached: false,
			cacheKey: "cache",
			occurrenceKey: "occurrence",
			errorMessage: status === "error" ? "请求失败" : undefined,
		},
		timestamp: Date.now(),
	};
}

describe("VisionAssistantMessageComponent", () => {
	it("shows a compact summary and expands the complete report", () => {
		initTheme("dark");
		const message = createMessage("success");
		const component = new VisionAssistantMessageComponent(message);

		const compact = stripAnsi(component.render(100).join("\n"));
		expect(compact).toContain("Vision Assistant (test/vision) · 完成");
		expect(compact).toContain("已识别 2 张图片 · 2.4s");
		expect(compact).not.toContain("完整视觉报告");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("完整视觉报告");
		expect(isVisionAssistantMessage(message)).toBe(true);
	});

	it("shows failures without hiding the reason", () => {
		initTheme("dark");
		const output = stripAnsi(new VisionAssistantMessageComponent(createMessage("error")).render(100).join("\n"));
		expect(output).toContain("· 失败");
		expect(output).toContain("请求失败");
	});
});
