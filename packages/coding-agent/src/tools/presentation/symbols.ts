import { Text } from "@myharness/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SymbolsToolDetails, SymbolsToolInput } from "../symbols.ts";
import { getTextOutput, renderToolPath, str } from "./render-utils.ts";
import type { BuiltinToolRenderer, ToolRenderResultOptions } from "./types.ts";

function recordOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function formatCall(args: Partial<SymbolsToolInput> | undefined, theme: Theme, cwd: string): string {
	const raw = recordOf(args);
	const operation = str(raw.operation) ?? "";
	const query = str(raw.query) ?? str(raw.namePath);
	let text = `${theme.fg("toolTitle", theme.bold("symbols"))} ${theme.fg("accent", operation)}`;
	if (query) text += ` ${theme.fg("toolOutput", JSON.stringify(query))}`;
	if (typeof raw.path === "string") text += ` ${renderToolPath(raw.path, theme, cwd)}`;
	if (raw.target) text += ` ${theme.fg("muted", "target")}`;
	return text;
}

function formatResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SymbolsToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const output = getTextOutput(result, false).trim();
	if (!output) return theme.fg("muted", "No symbols output");
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 30;
	const visible = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		visible.push(
			theme.fg(
				"muted",
				`Tool output truncated for presentation. (${lines.length - maxLines} more lines; expand to view)`,
			),
		);
	}
	return `\n${visible.join("\n")}`;
}

export function createSymbolsToolRenderer(): BuiltinToolRenderer {
	return {
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, _context) {
			const text = new Text("", 0, 0);
			text.setText(formatResult(result as any, options, theme));
			return text;
		},
	};
}
