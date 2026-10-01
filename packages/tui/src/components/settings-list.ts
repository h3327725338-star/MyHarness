import { TUI_SPACING, TUI_SYMBOLS } from "../design-tokens.ts";
import { rankedFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/**
	 * Semantic interaction contract for the row.
	 *
	 * - toggle: an immediate binary setting; Enter/Space toggles it.
	 * - select: Enter/Space opens a single-selection submenu.
	 * - navigate: Enter/Space enters a detail page/submenu.
	 * - action: Enter/Space runs an immediate command.
	 * - status: read-only information.
	 * - cycle: legacy compatibility for older callers that still cycle values inline.
	 */
	interaction?: "toggle" | "select" | "navigate" | "action" | "status" | "cycle";
	/** Binary or legacy inline values. New UI should use `toggle` or a submenu instead. */
	values?: string[];
	/** Disabled rows remain visible but never activate. Explain the reason in the description or hint. */
	disabled?: boolean;
	/** Immediate command used by `action` rows. */
	onActivate?: () => void;
	/** If provided, Enter/Space opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
	/** Show every visible item's description in a right-side column when the terminal is wide enough. */
	inlineDescriptions?: boolean;
}

export class SettingsList implements Component, Focusable {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;
	private inlineDescriptions: boolean;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.updateFocusedChild();
	}

	// Submenu state
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;
	private focusedChild?: Component & Focusable;

	private updateFocusedChild(): void {
		if (this.focusedChild) {
			this.focusedChild.focused = false;
			this.focusedChild = undefined;
		}
		const child = this.submenuComponent ?? this.searchInput;
		if (child && "focused" in child) {
			this.focusedChild = child as Component & Focusable;
			this.focusedChild.focused = this._focused;
		}
	}

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		this.inlineDescriptions = options.inlineDescriptions ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));
		const prefixColumnWidth = Math.max(2, visibleWidth(this.theme.cursor));
		const maxValueWidth = Math.min(
			44,
			Math.max(...this.items.map((item) => visibleWidth(this.getDisplayValue(item)))),
		);
		const inlineDescriptionSeparator = " ".repeat(TUI_SPACING.inline);
		const inlineValueWidth = Math.max(8, maxValueWidth);
		const inlineDescriptionMinWidth = 16;
		const showInlineDescriptions =
			this.inlineDescriptions &&
			width >=
				prefixColumnWidth +
					maxLabelWidth +
					visibleWidth("  ") +
					inlineValueWidth +
					visibleWidth(inlineDescriptionSeparator) +
					inlineDescriptionMinWidth;

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value and optional inline description
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			if (showInlineDescriptions) {
				const value = truncateToWidth(this.getDisplayValue(item), inlineValueWidth, "");
				const valuePadded = value + " ".repeat(Math.max(0, inlineValueWidth - visibleWidth(value)));
				const valueText = this.theme.value(valuePadded, isSelected);
				const descriptionMaxWidth = width - usedWidth - inlineValueWidth - visibleWidth(inlineDescriptionSeparator);
				const description = (item.description ?? "").replace(/\s+/g, " ").trim();
				const descriptionText = this.theme.description(truncateToWidth(description, descriptionMaxWidth));
				lines.push(
					truncateToWidth(
						prefix + labelText + separator + valueText + inlineDescriptionSeparator + descriptionText,
						width,
					),
				);
			} else {
				const valueMaxWidth = width - usedWidth - 2;
				const valueText = this.theme.value(
					truncateToWidth(this.getDisplayValue(item), valueMaxWidth, ""),
					isSelected,
				);
				lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
			}
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		const selectedItem = displayItems[this.selectedIndex];
		if (!showInlineDescriptions && selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width, displayItems[this.selectedIndex]);

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(data, "tui.select.confirm") || data === " ") {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			const sanitized = data.replace(/ /g, "");
			if (!sanitized) {
				return;
			}
			this.searchInput.handleInput(sanitized);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private activateItem(): void {
		const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
		if (!item) return;
		if (item.disabled) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.closeSubmenu();
			});
			this.updateFocusedChild();
		} else if (item.onActivate) {
			item.onActivate();
		} else if (this.getInteraction(item) === "toggle") {
			const values = item.values?.length === 2 ? item.values : ["Off", "On"];
			const currentIndex = values.indexOf(item.currentValue);
			const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % values.length;
			const newValue = values[nextIndex];
			if (newValue === undefined) return;
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		} else if (item.values && item.values.length > 0) {
			// Keep the old inline-cycle behavior for compatibility with extensions and
			// older callers. Product UI should use `toggle` or a submenu instead.
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private getInteraction(item: SettingItem): NonNullable<SettingItem["interaction"]> {
		if (item.interaction) return item.interaction;
		if (item.submenu) return "navigate";
		if (item.values && item.values.length > 0) return "cycle";
		return "status";
	}

	private getDisplayValue(item: SettingItem): string {
		if (item.disabled) return item.currentValue ? `${item.currentValue}  ${TUI_SYMBOLS.disabled}` : "Disabled";
		const interaction = this.getInteraction(item);
		if (interaction === "navigate" || interaction === "select") {
			return item.currentValue ? `${item.currentValue}  ${TUI_SYMBOLS.navigate}` : TUI_SYMBOLS.navigate;
		}
		if (interaction === "action") {
			return item.currentValue ? `${item.currentValue}  ${TUI_SYMBOLS.action}` : TUI_SYMBOLS.action;
		}
		if (interaction === "cycle") return `${item.currentValue}  ${TUI_SYMBOLS.cycle}`;
		return item.currentValue;
	}

	private getInteractionHint(item: SettingItem | undefined): string {
		if (!item) return "Enter/Space to interact";
		if (item.disabled) return "Disabled";
		if (item.submenu || item.interaction === "navigate" || item.interaction === "select") {
			return "Enter/Space to open";
		}
		if (item.onActivate || item.interaction === "action") return "Enter/Space to run";
		if (item.interaction === "toggle") return "Enter/Space to toggle";
		if (item.values && item.values.length > 0) return "Enter/Space to cycle";
		return "Read-only";
	}

	private closeSubmenu(): void {
		if (this.submenuComponent && "focused" in this.submenuComponent) {
			(this.submenuComponent as Component & Focusable).focused = false;
		}
		this.submenuComponent = null;
		// Restore selection to the item that opened the submenu
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
		this.updateFocusedChild();
	}

	private applyFilter(query: string): void {
		// Relevance first (exact > prefix > contains > description); the given order (by usage) decides ties.
		this.filteredItems = rankedFilter(this.items, query, (item) => item.label, {
			getKeywords: (item) => item.description ?? "",
		});
		this.selectedIndex = 0;
	}

	private addHintLine(lines: string[], width: number, selectedItem?: SettingItem): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? `  Type to search · ${this.getInteractionHint(selectedItem)} · Esc to cancel`
						: `  ${this.getInteractionHint(selectedItem)} · Esc to cancel`,
				),
				width,
			),
		);
	}
}
