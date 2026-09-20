import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@myharness/tui";
import type { ReloadSummaryMessage } from "../../../agent/runtime/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a runtime reload completion message with collapsed/expanded state.
 * Mirrors CompactionSummaryMessageComponent for visual consistency.
 */
export class ReloadSummaryMessageComponent extends Box {
	private expanded = false;
	private message: ReloadSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: ReloadSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const label = theme.fg("customMessageLabel", `\x1b[1m[reload]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			let body: string;
			if (!this.message.ok) {
				body = `**Reload failed**\n\n${this.message.error ?? "Unknown error"}`;
			} else {
				body = `**Configuration reloaded**\n\nSystem prompt synced. Conversation context preserved.`;
				if (this.message.reloadError) {
					body += `\n\n模型配置（models.json）重载失败：${this.message.reloadError}`;
				}
			}
			if (this.message.resources) {
				body += `\n\n${this.message.resources}`;
			}
			this.addChild(
				new Markdown(body, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const title = this.message.ok ? "Configuration reloaded" : "Reload failed";
			this.addChild(
				new Text(
					theme.fg("customMessageText", `${title} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
