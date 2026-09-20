import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@myharness/tui";
import type { AgentSession } from "../../../agent/runtime/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../application/experimental.ts";
import type { ContextBudgetSnapshot } from "../../../context/context-budget.ts";
import { formatContextWindow } from "../../../context/context-window.ts";
import {
	type BalanceInfo,
	type BalanceScope,
	formatBalance,
	getBalance,
} from "../../../providers/runtime/balance-tracker.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private readonly balanceReader: (scope?: BalanceScope) => BalanceInfo | null;

	constructor(
		session: AgentSession,
		footerData: ReadonlyFooterDataProvider,
		balanceReader: (scope?: BalanceScope) => BalanceInfo | null = getBalance,
	) {
		this.session = session;
		this.footerData = footerData;
		this.balanceReader = balanceReader;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Render the context segment from the canonical ContextBudgetSnapshot only.
	 * The UI never re-derives tokens, the window or the threshold itself.
	 * Estimated values (no provider anchor, e.g. right after compaction) are
	 * prefixed with "~"; percentages are never clamped so >100% stays visible.
	 */
	private renderContextUsage(budget: ContextBudgetSnapshot): string {
		const estimated = budget.usageSource === "provider-anchor" ? "" : "~";
		const percent = budget.percent.toFixed(1);
		const modelLimited =
			budget.configuredWindow !== undefined &&
			budget.modelWindow > 0 &&
			budget.configuredWindow > budget.modelWindow &&
			budget.effectiveWindow === budget.modelWindow;
		const statusLabel = budget.autoCompactEnabled ? "auto" : budget.overBudget ? "auto off" : "";
		const limitLabel = modelLimited ? (statusLabel ? `${statusLabel} · model limit` : "model limit") : statusLabel;
		const autoIndicator = limitLabel ? ` (${limitLabel})` : "";
		// formatContextWindow only renders K/M units for exact binary multiples
		// (e.g. 512K, 1M); other windows such as a 1,000,000-token model limit
		// fall back to the raw integer, so render those compactly too.
		const formattedWindow = formatContextWindow(budget.effectiveWindow);
		const compactWindow =
			formattedWindow === String(budget.effectiveWindow) ? formatTokens(budget.effectiveWindow) : formattedWindow;
		return `${estimated}${formatTokens(budget.activeTokens)}/${compactWindow} · ${percent}%${autoIndicator}`;
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Single runtime source of truth: the canonical ContextBudgetSnapshot.
		const budget = this.session.getContextBudgetSnapshot();
		const contextDisplay = budget && budget.effectiveWindow > 0 ? this.renderContextUsage(budget) : undefined;

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];

		const balance = this.balanceReader("main");
		if (balance) {
			statsParts.push(formatBalance(balance));
		}

		// Colorize context state based on the canonical snapshot: over budget or
		// past 100% is an error state, above 70% is a warning.
		if (contextDisplay && budget) {
			const contextPercentValue = budget.percent;
			if (budget.overBudget || contextPercentValue > 100) {
				statsParts.push(theme.fg("error", contextDisplay));
			} else if (contextPercentValue > 70) {
				statsParts.push(theme.fg("warning", contextDisplay));
			} else {
				statsParts.push(contextDisplay);
			}
		}
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Combine the provider and model when multiple providers are available.
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `${state.model.provider}-${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		const visionSettings = this.session.settingsManager.getVisionAssistantSettings();
		const visionBalance = this.balanceReader("vision");
		if (
			visionSettings.enabled &&
			visionSettings.provider &&
			visionSettings.model &&
			this.session.modelRuntime.isProviderEnabled(visionSettings.provider) &&
			this.session.modelRuntime.hasVisionConfiguredAuth(visionSettings.provider)
		) {
			const visionLeft = visionBalance ? formatBalance(visionBalance) : "";
			const visionThinkingLevel = visionSettings.thinkingLevel ?? "off";
			const visionRight = `${visionSettings.provider}/${visionSettings.model} • ${visionThinkingLevel}`;

			const mainLeftWidth = visibleWidth(statsLeft);
			const visionLeftWidth = visibleWidth(visionLeft);
			const maxLeftWidth = Math.max(mainLeftWidth, visionLeftWidth);
			const availableForRight = width - maxLeftWidth - minPadding;

			if (availableForRight > 0) {
				const visibleMainRight = truncateToWidth(rightSide, availableForRight, "");
				const visibleVisionRight = truncateToWidth(visionRight, availableForRight, "");
				const rightBlockWidth = Math.max(visibleWidth(visibleMainRight), visibleWidth(visibleVisionRight));
				const rightBlockStart = width - rightBlockWidth;

				const mainPadding = " ".repeat(Math.max(0, rightBlockStart - mainLeftWidth));
				const visionPadding = " ".repeat(Math.max(0, rightBlockStart - visionLeftWidth));
				lines[1] = theme.fg("dim", statsLeft) + theme.fg("dim", mainPadding + visibleMainRight);
				lines.push(theme.fg("dim", visionLeft) + theme.fg("dim", visionPadding + visibleVisionRight));
			} else if (visionLeft) {
				lines.push(theme.fg("dim", truncateToWidth(visionLeft, width, "...")));
			} else {
				lines.push(theme.fg("dim", truncateToWidth(visionRight, width, "...")));
			}
		}

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
