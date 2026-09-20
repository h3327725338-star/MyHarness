import type { TextContent } from "@myharness/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@myharness/tui";
import type { CustomMessage } from "../../../agent/runtime/messages.ts";
import { VISION_ASSISTANT_CUSTOM_TYPE, type VisionAssistantMessageDetails } from "../../../agent/vision/assistant.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

function getMessageText(message: CustomMessage<unknown>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function getDetails(message: CustomMessage<unknown>): VisionAssistantMessageDetails | undefined {
	if (!message.details || typeof message.details !== "object") return undefined;
	const details = message.details as Partial<VisionAssistantMessageDetails>;
	if (
		!["processing", "success", "partial", "error"].includes(details.status ?? "") ||
		typeof details.provider !== "string" ||
		typeof details.model !== "string" ||
		typeof details.imageCount !== "number" ||
		typeof details.durationMs !== "number" ||
		typeof details.cached !== "boolean"
	) {
		return undefined;
	}
	return details as VisionAssistantMessageDetails;
}

export function isVisionAssistantMessage(message: CustomMessage<unknown>): boolean {
	return message.customType === VISION_ASSISTANT_CUSTOM_TYPE && getDetails(message) !== undefined;
}

export class VisionAssistantMessageComponent extends Container {
	private expanded = false;
	private readonly message: CustomMessage<unknown>;
	private readonly markdownTheme: MarkdownTheme;

	constructor(message: CustomMessage<unknown>, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		const details = getDetails(this.message);
		const success = details?.status === "success";
		const processing = details?.status === "processing";
		const partial = details?.status === "partial";
		const color = success ? "success" : processing || partial ? "warning" : "error";
		const status = success ? "完成" : processing ? "后台处理中" : partial ? "部分完成" : "失败";
		const provider = details?.provider ?? "未知";
		const model = details?.model ?? "未知";
		this.addChild(
			new Text(
				theme.fg(color, "●") +
					theme.fg("text", ` Vision Assistant (${provider}/${model}) · `) +
					theme.fg(color, status),
				0,
				0,
			),
		);

		if (this.expanded) {
			this.addChild(new Spacer(1));
			this.addChild(new Markdown(getMessageText(this.message), 2, 0, this.markdownTheme));
			this.addChild(new Text(theme.fg("dim", `  ${keyText("app.tools.expand")} 收起`), 0, 0));
			return;
		}

		if ((success || partial || processing) && details) {
			const seconds = Math.max(0, details.durationMs / 1_000).toFixed(1);
			const cached = details.cached ? " · 使用缓存" : "";
			const summary = processing
				? "文档任务已进入后台，完成后会写入会话"
				: partial
					? (details.errorMessage ?? "部分页面或附件未完成")
					: `已识别 ${details.imageCount} 张图片 · ${seconds}s${cached}`;
			this.addChild(new Text(theme.fg("muted", `  ⎿ ${summary}`), 0, 0));
		} else {
			this.addChild(new Text(theme.fg("muted", `  ⎿ ${details?.errorMessage ?? "图片识别未完成"}`), 0, 0));
		}
		this.addChild(new Text(theme.fg("dim", `    ${keyText("app.tools.expand")} 展开`), 0, 0));
	}
}
