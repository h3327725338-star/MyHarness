/**
 * Small, presentation-only tokens shared by TUI components.
 *
 * Semantic colors remain owned by the product theme. These tokens only keep
 * repeated glyphs and spacing measurements consistent across components.
 */
export const TUI_SYMBOLS = Object.freeze({
	active: "●",
	success: "✓",
	error: "✕",
	blocked: "⛔",
	warning: "⚠",
	interrupted: "■",
	retry: "↻",
	selected: "→ ",
	navigate: "›",
	action: "▶",
	cycle: "↻",
	disabled: "⊘",
	result: "⎿",
	treeBranch: "├─",
	treeLastBranch: "└─",
	treeContinuation: "│  ",
	treeLastContinuation: "   ",
} as const);

export const TUI_SPACING = Object.freeze({
	inline: 2,
	indent: 2,
	section: 1,
} as const);
