import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	TUI_SYMBOLS,
	truncateToWidth,
} from "@myharness/tui";
import type { ToolDefinition } from "../../../extensions/compat/types.ts";
import { type BuiltinToolRenderer, getBuiltinToolRenderer } from "../../../tools/presentation/index.ts";
import { getTextOutput as getRenderedTextOutput, shortenPath } from "../../../tools/presentation/render-utils.ts";
import type { ToolRenderContext } from "../../../tools/presentation/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../tools/registry.ts";
import type { ExploreTaskResult, SubAgentToolDetails } from "../../../tools/sub-agent.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { WorkflowPhaseDetails, WorkflowToolDetails, WorkflowToolInput } from "../../../workflow/tool.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	private executionStartedAt: number | undefined;
	private executionEndedAt: number | undefined;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getBuiltinRenderer(): BuiltinToolRenderer | undefined {
		return getBuiltinToolRenderer(this.toolName);
	}

	private getCallRenderer(): BuiltinToolRenderer["renderCall"] | undefined {
		const builtinRenderer = this.getBuiltinRenderer();
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return builtinRenderer?.renderCall;
		}
		return this.toolDefinition.renderCall ?? builtinRenderer?.renderCall;
	}

	private getResultRenderer(): BuiltinToolRenderer["renderResult"] | undefined {
		const builtinRenderer = this.getBuiltinRenderer();
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return builtinRenderer?.renderResult;
		}
		return this.toolDefinition.renderResult ?? builtinRenderer?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		const builtinRenderShell = this.getBuiltinRenderer()?.renderShell;
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return builtinRenderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? builtinRenderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	getToolName(): string {
		return this.toolName;
	}

	getToolCallId(): string {
		return this.toolCallId;
	}

	isSettled(): boolean {
		return this.result !== undefined && !this.isPartial;
	}

	hasError(): boolean {
		return this.result?.isError ?? false;
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.executionStartedAt ??= Date.now();
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial) {
			this.executionEndedAt ??= Date.now();
		}
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (!this.expanded) {
			if (this.toolName.toLowerCase() === "agent") {
				return this.renderCompactAgent(width);
			}
			if (this.toolName.toLowerCase() === "workflow" || this.toolName.toLowerCase() === "ultracode") {
				const label = this.toolName.toLowerCase() === "ultracode" ? "Ultracode" : "Workflow";
				return this.renderCompactWorkflow(width, label);
			}
			return this.renderCompact(width);
		}

		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		if (!this.expanded) {
			this.hideComponent = false;
			return;
		}

		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private renderCompact(width: number): string[] {
		const isSettled = this.result !== undefined && !this.isPartial;
		const marker = process.platform === "darwin" ? "⏺" : TUI_SYMBOLS.active;
		const markerColor = !isSettled
			? (text: string) => theme.fg(this.executionStarted ? "accent" : "muted", text)
			: this.result?.isError
				? (text: string) => theme.fg("error", text)
				: (text: string) => theme.fg("success", text);
		const call = theme.fg("toolTitle", theme.bold(this.formatCompactCall()));
		const result = theme.fg(this.result?.isError ? "error" : "toolOutput", this.formatCompactResult());
		return new Text(
			`${markerColor(marker)} ${call}\n  ${theme.fg("muted", TUI_SYMBOLS.result)} ${result}`,
			1,
			0,
		).render(width);
	}

	private renderCompactAgent(width: number): string[] {
		const taskArgs = Array.isArray(this.args?.tasks)
			? (this.args.tasks as Array<{ description?: unknown; prompt?: unknown }>)
			: [];
		const details = this.result?.details as SubAgentToolDetails | undefined;
		const results = details?.results ?? [];
		const taskCount = Math.max(taskArgs.length, details?.total ?? 0, results.length);
		const backgroundRunning = Boolean(details?.background && results.some((result) => result.status === "running"));
		const isSettled = this.result !== undefined && !this.isPartial && !backgroundRunning;
		const hasError = Boolean(
			this.result?.isError || results.some((result) => result.status !== "running" && result.status !== "completed"),
		);
		const marker = process.platform === "darwin" ? "⏺" : TUI_SYMBOLS.active;
		const markerColor = !isSettled
			? (text: string) => theme.fg(this.executionStarted ? "accent" : "muted", text)
			: hasError
				? (text: string) => theme.fg("error", text)
				: (text: string) => theme.fg("success", text);
		const expandHint = theme.fg("muted", `  ${keyHint("app.tools.expand", "展开")}`);

		if (taskCount <= 1) {
			const task = results[0];
			const description = this.truncate(String(task?.description ?? taskArgs[0]?.description ?? "探索任务"), 72);
			const title = theme.fg("toolTitle", theme.bold(`Explore(${description})`));
			const status = backgroundRunning ? "后台运行中…" : this.formatCompactAgentStatus(task, isSettled);
			const stats = task ? this.formatCompactAgentStats(task) : "";
			const suffix = stats ? ` · ${stats}` : "";
			return new Text(
				`${markerColor(marker)} ${title}${expandHint}\n  ${theme.fg("muted", TUI_SYMBOLS.result)} ${this.colorAgentStatus(task, `${status}${suffix}`)}`,
				1,
				0,
			).render(width);
		}

		const completed = results.filter((result) => result.status !== "running").length;
		const titleText = backgroundRunning
			? `${taskCount} 个后台 Explore 子智能体已启动`
			: isSettled
				? hasError
					? `${taskCount} 个 Explore 子智能体运行结束`
					: `${taskCount} 个 Explore 子智能体已完成`
				: `正在运行 ${taskCount} 个 Explore 子智能体…`;
		const lines = [`${markerColor(marker)} ${theme.fg("toolTitle", theme.bold(titleText))}${expandHint}`];

		for (let index = 0; index < taskCount; index++) {
			const task = results[index];
			const isLast = index === taskCount - 1;
			const branch = isLast ? TUI_SYMBOLS.treeLastBranch : TUI_SYMBOLS.treeBranch;
			const continuation = isLast ? TUI_SYMBOLS.treeLastContinuation : TUI_SYMBOLS.treeContinuation;
			const description = this.truncate(
				String(task?.description ?? taskArgs[index]?.description ?? `探索任务 ${index + 1}`),
				72,
			);
			const stats = task ? this.formatCompactAgentStats(task) : "";
			lines.push(
				`   ${theme.fg("muted", branch)} ${theme.bold(description)}${stats ? theme.fg("muted", ` · ${stats}`) : ""}`,
			);
			const status = this.formatCompactAgentStatus(task, isSettled && completed >= taskCount);
			lines.push(
				`   ${theme.fg("muted", `${continuation}${TUI_SYMBOLS.result}`)} ${this.colorAgentStatus(task, status)}`,
			);
		}

		return new Text(lines.join("\n"), 1, 0).render(width);
	}

	private renderCompactWorkflow(width: number, label: "Workflow" | "Ultracode" = "Workflow"): string[] {
		const args = (this.args ?? {}) as Partial<WorkflowToolInput>;
		const phaseArgs = Array.isArray(args.phases) ? args.phases : [];
		const details = this.result?.details as WorkflowToolDetails | undefined;
		const phases = details?.phases ?? [];
		const phaseCount = Math.max(phaseArgs.length, phases.length);
		const isSettled = this.result !== undefined && !this.isPartial;
		const hasError = Boolean(
			this.result?.isError ||
				phases.some(
					(phase) => phase.status === "failed" || phase.status === "timeout" || phase.status === "cancelled",
				),
		);
		const marker = process.platform === "darwin" ? "⏺" : TUI_SYMBOLS.active;
		const markerColor = !isSettled
			? (text: string) => theme.fg(this.executionStarted ? "accent" : "muted", text)
			: hasError
				? (text: string) => theme.fg("error", text)
				: (text: string) => theme.fg("success", text);
		const name = truncateToWidth(
			String(details?.name ?? args.name ?? (label === "Ultracode" ? "Ultracode" : "工作流")),
			Math.max(16, width - 42),
			"…",
		);
		const expandHint = theme.fg("muted", `  ${keyHint("app.tools.expand", "展开")}`);
		const title = theme.fg("toolTitle", theme.bold(`${label}(${name} · ${phaseCount} 个阶段)`));
		const lines = [`${markerColor(marker)} ${title}${expandHint}`];

		// 总览行：阶段进度、运行中任务数与最终汇总统计。
		const overview = this.formatCompactWorkflowOverview(phases, phaseCount, isSettled, hasError);
		if (overview) lines.push(`   ${theme.fg("muted", overview)}`);

		for (let index = 0; index < phaseCount; index++) {
			const phase = phases[index];
			const phaseArg = phaseArgs[index];
			const isLast = index === phaseCount - 1;
			const branch = isLast ? TUI_SYMBOLS.treeLastBranch : TUI_SYMBOLS.treeBranch;
			const continuation = isLast ? TUI_SYMBOLS.treeLastContinuation : TUI_SYMBOLS.treeContinuation;
			const phaseName = truncateToWidth(
				String(phase?.name ?? phaseArg?.name ?? `阶段 ${index + 1}`),
				Math.max(12, width - 16),
				"…",
			);
			const total = phase?.total ?? phaseArg?.tasks?.length ?? 0;
			const completed = phase?.completed ?? 0;
			const phaseStatus =
				phase?.status ??
				(isSettled && hasError && index === 0
					? "failed"
					: this.executionStarted && index === 0
						? "running"
						: "pending");
			lines.push(`   ${theme.fg("muted", branch)} ${theme.bold(phaseName)} · ${completed}/${total}`);

			// task 级信息：优先来自实时 details（results），等待中的阶段从调用参数取任务名。
			const tasks = phase?.results ?? [];
			const taskSpecs = phaseArg?.tasks ?? [];
			const taskCount = Math.max(tasks.length, taskSpecs.length);
			if (taskCount === 0) {
				const statusText = this.formatPhaseStatusText(phaseStatus, index);
				lines.push(
					`   ${theme.fg("muted", `${continuation}${TUI_SYMBOLS.result}`)} ${this.colorPhaseStatus(phaseStatus, statusText)}`,
				);
				continue;
			}

			for (let taskIndex = 0; taskIndex < taskCount; taskIndex++) {
				const task = tasks[taskIndex];
				const spec = taskSpecs[taskIndex];
				const taskIsLast = taskIndex === taskCount - 1;
				const taskBranch = taskIsLast ? TUI_SYMBOLS.treeLastBranch : TUI_SYMBOLS.treeBranch;
				const taskContinuation = taskIsLast ? TUI_SYMBOLS.treeLastContinuation : TUI_SYMBOLS.treeContinuation;
				const description = truncateToWidth(
					String(task?.description ?? spec?.description ?? `任务 ${taskIndex + 1}`),
					Math.max(12, width - 42),
					"…",
				);
				const stats = task ? this.formatCompactAgentStats(task) : "";
				lines.push(
					`   ${theme.fg("muted", `${continuation}${taskBranch}`)} ${theme.bold(description)}${
						stats ? theme.fg("muted", ` · ${stats}`) : ""
					}`,
				);
				const taskStatus = this.formatCompactWorkflowTaskStatus(task, phaseStatus, index, isSettled);
				const colored = task
					? this.colorAgentStatus(task, taskStatus)
					: this.colorPhaseStatus(phaseStatus, taskStatus);
				lines.push(`   ${theme.fg("muted", `${continuation}${taskContinuation}${TUI_SYMBOLS.result}`)} ${colored}`);
			}
		}

		if (phaseCount === 0) {
			lines.push(`  ${theme.fg("muted", TUI_SYMBOLS.result)} ${this.executionStarted ? "初始化中…" : "等待中…"}`);
		}
		return new Text(lines.join("\n"), 1, 0).render(width);
	}

	/**
	 * Workflow / Ultracode 默认视图的总览行：
	 * 运行中显示阶段与任务进度；结束后显示各阶段的汇总统计。
	 */
	private formatCompactWorkflowOverview(
		phases: WorkflowPhaseDetails[],
		phaseCount: number,
		isSettled: boolean,
		hasError: boolean,
	): string {
		if (phaseCount === 0) return "";
		if (!this.executionStarted) return "等待调度…";
		const donePhases = phases.filter((phase) => phase.status === "completed").length;
		if (isSettled) {
			if (hasError) {
				const failedPhases = phases.filter(
					(phase) => phase.status === "failed" || phase.status === "timeout" || phase.status === "cancelled",
				).length;
				return `${donePhases}/${phaseCount} 个阶段完成 · ${Math.max(1, failedPhases)} 个阶段失败`;
			}
			const results = phases.flatMap((phase) => phase.results);
			const toolUses = results.reduce((sum, task) => sum + task.toolUseCount, 0);
			const tokens = results.reduce((sum, task) => sum + task.tokens, 0);
			return `${phaseCount}/${phaseCount} 个阶段 · ${results.length} 个 Explore · ${toolUses} 次工具调用 · ${this.formatTokensCompact(tokens)} tokens`;
		}
		const results = phases.flatMap((phase) => phase.results);
		const running = results.filter((task) => task.status === "running").length;
		const waitingPhases = phases.filter((phase) => phase.status === "pending").length;
		const parts = [`${donePhases}/${phaseCount} 个阶段完成`, `${running} 个任务运行中`];
		if (waitingPhases > 0) parts.push(`${waitingPhases} 个阶段等待`);
		return parts.join(" · ");
	}

	/**
	 * 阶段状态文本：运行中 / 等待前置阶段 / 等待调度 / 完成 / 失败。
	 */
	private formatPhaseStatusText(status: string | undefined, phaseIndex: number): string {
		switch (status) {
			case "completed":
				return "完成";
			case "failed":
				return "失败";
			case "timeout":
				return "超时";
			case "cancelled":
				return "已取消";
			case "running":
				return "运行中…";
			case "pending":
				return phaseIndex === 0 ? "等待调度…" : `等待阶段 ${phaseIndex} 完成`;
			default:
				return this.executionStarted ? "运行中…" : "等待中…";
		}
	}

	private colorPhaseStatus(status: string | undefined, value: string): string {
		if (status === "failed" || status === "timeout" || status === "cancelled") return theme.fg("error", value);
		if (status === "completed") return theme.fg("success", value);
		return theme.fg("muted", value);
	}

	/**
	 * task 状态文本：运行中显示最近进展（lastToolInfo），等待中的任务显示等待原因。
	 */
	private formatCompactWorkflowTaskStatus(
		task: ExploreTaskResult | undefined,
		phaseStatus: string | undefined,
		phaseIndex: number,
		isSettled: boolean,
	): string {
		if (task) {
			if (task.status === "running" && isSettled) return "未完成";
			return this.formatCompactAgentStatus(task, isSettled);
		}
		if (phaseStatus === "pending") {
			return phaseIndex === 0 ? "等待调度…" : `等待阶段 ${phaseIndex} 完成`;
		}
		if (isSettled && this.result?.isError) {
			return `失败：${this.truncate(this.getTextOutput() || "工作流执行失败", 100)}`;
		}
		return "初始化中…";
	}

	private formatCompactAgentStatus(task: ExploreTaskResult | undefined, isSettled: boolean): string {
		if (!task) return this.executionStarted ? "初始化中…" : "等待中…";
		if (task.status === "failed") return `失败：${this.truncate(task.error ?? task.lastToolInfo ?? "未知错误", 100)}`;
		if (task.status === "timeout") return `超时：${this.truncate(task.error ?? "超过执行时限", 100)}`;
		if (task.status === "cancelled") return `已取消：${this.truncate(task.error ?? "任务已取消", 100)}`;
		if (task.status === "completed") return "完成";
		if (isSettled) return "完成";
		return this.truncate(task.lastToolInfo ?? "初始化中…", 100);
	}

	private colorAgentStatus(task: ExploreTaskResult | undefined, value: string): string {
		if (task && task.status !== "running" && task.status !== "completed") return theme.fg("error", value);
		if (task?.status === "completed") return theme.fg("success", value);
		return theme.fg("muted", value);
	}

	private formatCompactAgentStats(task: ExploreTaskResult): string {
		if (task.status === "running" && task.toolUseCount === 0 && task.tokens === 0) return "";
		const parts = [`${task.toolUseCount} 次工具调用`, `${this.formatTokensCompact(task.tokens)} tokens`];
		if (task.durationMs !== undefined) {
			const seconds = task.durationMs / 1000;
			parts.push(seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`);
		}
		return parts.join(" · ");
	}

	private formatCompactCall(): string {
		const args = this.args && typeof this.args === "object" ? (this.args as Record<string, unknown>) : {};
		const path = this.formatPath(args.path ?? args.file_path);
		switch (this.toolName.toLowerCase()) {
			case "read": {
				const offset = typeof args.offset === "number" ? args.offset : undefined;
				const limit = typeof args.limit === "number" ? args.limit : undefined;
				const range =
					offset !== undefined || limit !== undefined
						? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
						: "";
				return `Read(${path}${range})`;
			}
			case "write":
				return `Write(${path})`;
			case "edit":
				return `Edit(${path})`;
			case "bash":
				return `Bash(${this.truncate(String(args.command ?? "…"), 84)})`;
			case "grep": {
				const pattern = this.truncate(String(args.pattern ?? ""), 48);
				const location = this.formatPath(args.path ?? ".");
				return `Search(pattern: ${JSON.stringify(pattern)}, path: ${JSON.stringify(location)})`;
			}
			case "find": {
				const pattern = this.truncate(String(args.pattern ?? ""), 48);
				const location = this.formatPath(args.path ?? ".");
				return `Find(pattern: ${JSON.stringify(pattern)}, path: ${JSON.stringify(location)})`;
			}
			case "ls":
				return `List(${path || "."})`;
			default:
				return `${this.toDisplayName(this.toolName)}(${this.formatGenericArgs(args)})`;
		}
	}

	private formatCompactResult(): string {
		const output = this.getTextOutput().trim();
		const lines = output ? output.split("\n").filter((line) => line.trim() !== "") : [];
		if (!this.executionStarted && this.result === undefined) {
			return "Queued · execution has not started";
		}
		if (this.result === undefined || this.isPartial) {
			const latest = lines.at(-1)?.trim();
			return `Running…${this.formatElapsed()}${latest ? ` · ${this.truncate(latest, 80)}` : ""}`;
		}
		if (this.result.isError) {
			const error = lines.at(-1)?.trim();
			// Structured timeout marker (Core BASH_TIMEOUT): render an explicit
			// "Timed out" verdict with the configured seconds instead of a generic
			// "Failed".
			const errorCode = (this.result.details as { errorCode?: string } | undefined)?.errorCode;
			const timeoutSeconds = (this.result.details as { timeoutSeconds?: number } | undefined)?.timeoutSeconds;
			if (errorCode === "BASH_TIMEOUT") {
				return `执行超时${timeoutSeconds !== undefined ? ` · ${timeoutSeconds}s` : ""}`;
			}
			return error ? `Failed: ${this.truncate(error, 100)}` : "Failed";
		}

		switch (this.toolName.toLowerCase()) {
			case "read": {
				const reportedLines = this.result.details?.truncation?.outputLines;
				const count = typeof reportedLines === "number" ? reportedLines : output ? output.split("\n").length : 0;
				return count > 0 ? `Read ${count} line${count === 1 ? "" : "s"}` : "Read file";
			}
			case "grep": {
				const matches = lines.filter(
					(line) => !line.startsWith("[") && !line.startsWith("...") && line.trim(),
				).length;
				const files = new Set(
					lines
						.map((line) => /^(.*?):\d+(?::\d+)?:/.exec(line)?.[1])
						.filter((file): file is string => Boolean(file)),
				).size;
				return `Found ${matches} match${matches === 1 ? "" : "es"}${files > 0 ? ` in ${files} file${files === 1 ? "" : "s"}` : ""}`;
			}
			case "find":
				return `Found ${lines.length} file${lines.length === 1 ? "" : "s"}`;
			case "ls":
				return `Listed ${lines.length} entr${lines.length === 1 ? "y" : "ies"}`;
			case "write": {
				const content = typeof this.args?.content === "string" ? this.args.content : "";
				const count = content ? content.split("\n").length : 0;
				return count > 0 ? `Wrote ${count} line${count === 1 ? "" : "s"}` : "Wrote file";
			}
			case "edit": {
				const diff = typeof this.result.details?.diff === "string" ? this.result.details.diff : "";
				const added = diff
					.split("\n")
					.filter((line: string) => line.startsWith("+") && !line.startsWith("+++")).length;
				const removed = diff
					.split("\n")
					.filter((line: string) => line.startsWith("-") && !line.startsWith("---")).length;
				return added || removed ? `Updated +${added} -${removed} lines` : "Updated file";
			}
			case "bash": {
				const latest = lines.at(-1)?.trim();
				return `Completed${this.formatElapsed()}${latest ? ` · ${this.truncate(latest, 80)}` : ""}`;
			}
			default: {
				const first = lines[0]?.trim();
				return first ? this.truncate(first, 100) : "Completed";
			}
		}
	}

	private formatElapsed(): string {
		if (this.executionStartedAt === undefined) return "";
		const end = this.executionEndedAt ?? Date.now();
		const seconds = Math.max(0, (end - this.executionStartedAt) / 1000);
		return ` ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
	}

	private formatPath(value: unknown): string {
		if (typeof value !== "string" || !value) return "…";
		return this.truncate(shortenPath(formatPathRelativeToCwdOrAbsolute(value, this.cwd)), 84);
	}

	private formatGenericArgs(args: Record<string, unknown>): string {
		return Object.entries(args)
			.filter(([key]) => key !== "timeout")
			.slice(0, 2)
			.map(([key, value]) => {
				const rendered =
					typeof value === "string" ? JSON.stringify(this.truncate(value, 48)) : JSON.stringify(value);
				return `${key}: ${rendered ?? "…"}`;
			})
			.join(", ");
	}

	private formatTokensCompact(tokens: number): string {
		if (tokens < 1000) return `${tokens}`;
		if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
		return `${Math.round(tokens / 1000)}k`;
	}

	private toDisplayName(name: string): string {
		return name
			.split(/[-_]/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}

	private truncate(value: string, maxLength: number): string {
		return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}

/**
 * UI-only grouping for consecutive read/grep/find calls.
 * Tool messages and toolCallId/result pairing remain unchanged.
 */
export class ReadSearchToolGroupComponent extends Container {
	private expanded = false;

	addTool(component: ToolExecutionComponent): void {
		this.addChild(component);
		component.setExpanded(this.expanded);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const child of this.children) {
			if (child instanceof ToolExecutionComponent) child.setExpanded(expanded);
		}
	}

	setShowImages(show: boolean): void {
		for (const child of this.children) {
			if (child instanceof ToolExecutionComponent) child.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const child of this.children) {
			if (child instanceof ToolExecutionComponent) child.setImageWidthCells(width);
		}
	}

	override render(width: number): string[] {
		if (this.expanded || this.children.length < 2) {
			return super.render(width);
		}

		const tools = this.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		const readCount = tools.filter((tool) => tool.getToolName().toLowerCase() === "read").length;
		const searchCount = tools.filter((tool) => {
			const name = tool.getToolName().toLowerCase();
			return name === "grep" || name === "find";
		}).length;
		const allSettled = tools.every((tool) => tool.isSettled());
		const hasError = tools.some((tool) => tool.hasError());
		const marker = process.platform === "darwin" ? "⏺" : TUI_SYMBOLS.active;
		const markerColor = !allSettled
			? (value: string) => theme.fg("accent", value)
			: hasError
				? (value: string) => theme.fg("error", value)
				: (value: string) => theme.fg("success", value);
		const parts: string[] = [];
		if (readCount > 0) parts.push(`Read ${readCount} file${readCount === 1 ? "" : "s"}`);
		if (searchCount > 0) parts.push(`searched for ${searchCount} pattern${searchCount === 1 ? "" : "s"}`);
		const status = allSettled ? (hasError ? "部分失败" : "完成") : "运行中…";
		const title = parts.join(", ");
		const text = `${markerColor(marker)} ${theme.fg("toolTitle", theme.bold(title))}  ${keyHint("app.tools.expand", "展开")}\n  ${theme.fg("muted", TUI_SYMBOLS.result)} ${theme.fg(hasError ? "error" : "muted", status)}`;
		return new Text(text, 1, 0).render(width);
	}
}
