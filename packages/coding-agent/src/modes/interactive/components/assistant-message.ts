import type { AssistantMessage } from "@myharness/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text, type TUI } from "@myharness/tui";
import { explainProviderError } from "../../../providers/recovery/error-explanation.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { AnimatedThinkingLabel } from "./animated-thinking-label.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private tui?: TUI;
	private animatedLabels: AnimatedThinkingLabel[] = [];
	private streaming: boolean;
	private thinkingStartedAt: number | undefined;
	private thinkingEndedAt: number | undefined;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking",
		outputPad = 1,
		tui?: TUI,
		streaming = false,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.tui = tui;
		this.streaming = streaming;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setStreaming(streaming: boolean): void {
		if (this.streaming === streaming) return;
		this.streaming = streaming;
		if (!streaming && this.thinkingStartedAt !== undefined && this.thinkingEndedAt === undefined) {
			this.thinkingEndedAt = Date.now();
		}
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	hasThinking(): boolean {
		return (
			this.lastMessage?.content.some((content) => content.type === "thinking" && content.thinking.trim()) ?? false
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Dispose old animated labels
		for (const label of this.animatedLabels) {
			label.dispose();
		}
		this.animatedLabels = [];

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		const hasThinking = message.content.some((c) => c.type === "thinking" && c.thinking.trim());
		if (hasThinking && this.streaming && this.thinkingStartedAt === undefined) {
			this.thinkingStartedAt = Date.now();
		}
		let lastThinkingIndex = -1;
		for (let i = message.content.length - 1; i >= 0; i--) {
			const content = message.content[i];
			if (content.type === "thinking" && content.thinking.trim()) {
				lastThinkingIndex = i;
				break;
			}
		}
		const thinkingHasFinished =
			lastThinkingIndex >= 0 &&
			message.content
				.slice(lastThinkingIndex + 1)
				.some(
					(content) => content.type === "toolCall" || (content.type === "text" && content.text.trim().length > 0),
				);
		if (
			this.streaming &&
			thinkingHasFinished &&
			this.thinkingStartedAt !== undefined &&
			this.thinkingEndedAt === undefined
		) {
			this.thinkingEndedAt = Date.now();
		}

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		if (this.hideThinkingBlock) {
			if (hasThinking) {
				const thinkingInProgress = this.streaming && this.thinkingEndedAt === undefined;
				if (thinkingInProgress && this.tui) {
					const animatedLabel = new AnimatedThinkingLabel(
						this.tui,
						`· ${this.hiddenThinkingLabel}`,
						(text: string) => theme.italic(theme.fg("thinkingText", text)),
						this.outputPad,
						0,
						this.thinkingStartedAt,
					);
					this.animatedLabels.push(animatedLabel);
					this.contentContainer.addChild(animatedLabel);
				} else {
					const duration =
						this.thinkingStartedAt !== undefined && this.thinkingEndedAt !== undefined
							? Math.max(0, (this.thinkingEndedAt - this.thinkingStartedAt) / 1000)
							: undefined;
					const label = thinkingInProgress
						? `· ${this.hiddenThinkingLabel}...`
						: duration === undefined
							? "· Thought"
							: `· Thought for ${duration < 10 ? duration.toFixed(1) : Math.round(duration)}s`;
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", label)), this.outputPad, 0),
					);
				}
			}

			const hasTextAfterThinking = message.content.some((c) => c.type === "text" && c.text.trim());
			if (hasThinking && hasTextAfterThinking) {
				this.contentContainer.addChild(new Spacer(1));
			}

			for (const content of message.content) {
				if (content.type === "text" && content.text.trim()) {
					this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));
				}
			}
		} else {
			// Render thinking blocks inline (visible)
			for (let i = 0; i < message.content.length; i++) {
				const content = message.content[i];
				if (content.type === "text" && content.text.trim()) {
					this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));
				} else if (content.type === "thinking") {
					const thinkingBlocks: string[] = [];
					for (; i < message.content.length; i++) {
						const thinkingContent = message.content[i];
						if (thinkingContent.type !== "thinking") {
							break;
						}
						const thinking = thinkingContent.thinking.trim();
						if (thinking) {
							thinkingBlocks.push(thinking);
						}
					}
					i--;

					if (thinkingBlocks.length === 0) {
						continue;
					}

					const hasVisibleContentAfter = message.content
						.slice(i + 1)
						.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

					this.contentContainer.addChild(new Text(theme.fg("thinkingText", "∴ Thinking…"), this.outputPad, 0));
					this.contentContainer.addChild(
						new Markdown(thinkingBlocks.join("\n\n"), this.outputPad + 2, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				// Cause and next step first; the raw provider text follows inside the explanation.
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("error", explainProviderError(message.errorMessage)), this.outputPad, 0),
				);
			}
		}
	}
}
