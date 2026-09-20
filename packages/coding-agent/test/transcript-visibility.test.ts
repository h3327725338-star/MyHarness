import type { AssistantMessage } from "@myharness/ai";
import { Container } from "@myharness/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function thinkingMessage(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type TranscriptVisibilityContext = {
	chatContainer: Container;
	hideThinkingBlock: boolean;
};

type ApplyTranscriptVisibility = (this: TranscriptVisibilityContext) => void;

type SetTranscriptContext = {
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	settingsManager: { setHideThinkingBlock: ReturnType<typeof vi.fn> };
	setToolsExpanded: ReturnType<typeof vi.fn>;
	applyThinkingTranscriptVisibility: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
};

type SetTranscriptExpanded = (this: SetTranscriptContext, expanded: boolean, persist?: boolean) => void;

function render(component: AssistantMessageComponent): string {
	return stripAnsi(component.render(100).join("\n"));
}

describe("interactive transcript thinking visibility", () => {
	beforeAll(() => initTheme("dark"));

	test("only expands the latest thinking block in transcript mode", () => {
		const first = new AssistantMessageComponent(thinkingMessage("older reasoning"), true);
		const second = new AssistantMessageComponent(thinkingMessage("latest reasoning"), true);
		const chatContainer = new Container();
		chatContainer.addChild(first);
		chatContainer.addChild(second);
		const context: TranscriptVisibilityContext = { chatContainer, hideThinkingBlock: false };
		const apply = (
			InteractiveMode.prototype as unknown as { applyThinkingTranscriptVisibility: ApplyTranscriptVisibility }
		).applyThinkingTranscriptVisibility;

		apply.call(context);

		expect(render(first)).toContain("· Thought");
		expect(render(first)).not.toContain("older reasoning");
		expect(render(second)).toContain("∴ Thinking…");
		expect(render(second)).toContain("latest reasoning");

		context.hideThinkingBlock = true;
		apply.call(context);
		expect(render(second)).toContain("· Thought");
		expect(render(second)).not.toContain("latest reasoning");
	});

	test("uses one state transition for tool and thinking details", () => {
		const context: SetTranscriptContext = {
			toolOutputExpanded: false,
			hideThinkingBlock: true,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			setToolsExpanded: vi.fn((expanded: boolean) => {
				context.toolOutputExpanded = expanded;
			}),
			applyThinkingTranscriptVisibility: vi.fn(),
			showStatus: vi.fn(),
		};
		const setExpanded = (InteractiveMode.prototype as unknown as { setTranscriptExpanded: SetTranscriptExpanded })
			.setTranscriptExpanded;

		setExpanded.call(context, true, true);

		expect(context.toolOutputExpanded).toBe(true);
		expect(context.hideThinkingBlock).toBe(false);
		expect(context.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(false);
		expect(context.applyThinkingTranscriptVisibility).toHaveBeenCalledOnce();
		expect(context.showStatus).toHaveBeenCalledWith("Transcript details: expanded");
	});
});
