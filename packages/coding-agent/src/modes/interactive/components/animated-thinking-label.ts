import type { TUI } from "@myharness/tui";
import { Text } from "@myharness/tui";

const DOTS_FRAMES = [".", "..", "..."];
const INTERVAL_MS = 400;

/**
 * Animated label that cycles dots: "Thinking.", "Thinking..", "Thinking..."
 * Self-animating via setInterval + tui.requestRender().
 */
export class AnimatedThinkingLabel extends Text {
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private currentFrame = 0;
	private tui: TUI;
	private label: string;
	private colorFn: (text: string) => string;
	private startedAt: number | undefined;

	constructor(
		tui: TUI,
		label: string,
		colorFn: (text: string) => string,
		paddingX = 0,
		paddingY = 0,
		startedAt?: number,
	) {
		super("", paddingX, paddingY);
		this.tui = tui;
		this.label = label;
		this.colorFn = colorFn;
		this.startedAt = startedAt;
		this.updateText();
		this.start();
	}

	private updateText(): void {
		const dots = DOTS_FRAMES[this.currentFrame] ?? "";
		const elapsed =
			this.startedAt === undefined ? "" : ` ${Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000))}s`;
		this.setText(this.colorFn(`${this.label}${dots}${elapsed}`));
	}

	private start(): void {
		this.stop();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % DOTS_FRAMES.length;
			this.updateText();
			this.tui.requestRender();
		}, INTERVAL_MS);
	}

	private stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	dispose(): void {
		this.stop();
	}
}
