import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import type { Component, Focusable } from "../src/tui.ts";

const testTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

const items = [
	{ id: "first", label: "First", currentValue: "true", description: "第一项中文说明", values: ["true", "false"] },
	{ id: "second", label: "Longer label", currentValue: "off", description: "第二项中文说明", values: ["on", "off"] },
];

describe("SettingsList inline descriptions", () => {
	it("uses explicit toggle, navigation, action, and status semantics", () => {
		const activated = { count: 0 };
		const changes: string[] = [];
		const list = new SettingsList(
			[
				{
					id: "toggle",
					label: "Toggle",
					interaction: "toggle",
					currentValue: "Off",
					values: ["Off", "On"],
				},
				{
					id: "details",
					label: "Details",
					interaction: "navigate",
					currentValue: "Current",
					submenu: () => ({ render: () => ["submenu"], handleInput: () => {}, invalidate: () => {} }) as Component,
				},
				{
					id: "run",
					label: "Run",
					interaction: "action",
					currentValue: "Run",
					onActivate: () => {
						activated.count += 1;
					},
				},
				{ id: "status", label: "Status", interaction: "status", currentValue: "Ready" },
			],
			10,
			testTheme,
			(id, value) => changes.push(`${id}:${value}`),
			() => {},
		);

		const initial = list.render(100).join("\n");
		assert.match(initial, /Current {2}›/);
		assert.match(initial, /Run {2}▶/);
		assert.doesNotMatch(initial, /true|false/);

		list.handleInput("\r");
		assert.deepEqual(changes, ["toggle:On"]);
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		assert.equal(activated.count, 1);
		assert.equal(list.render(100).join("\n").includes("Enter/Space to run"), true);
		list.handleInput("\x1b[B");
		assert.equal(list.render(100).join("\n").includes("Read-only"), true);
		list.handleInput("\r");
		assert.deepEqual(changes, ["toggle:On"]);
	});

	it("shows disabled state and ignores activation", () => {
		let activated = false;
		const list = new SettingsList(
			[
				{
					id: "unavailable",
					label: "Unavailable",
					interaction: "action",
					currentValue: "Requires setup",
					disabled: true,
					onActivate: () => {
						activated = true;
					},
				},
			],
			1,
			testTheme,
			() => {},
			() => {},
		);

		const rendered = list.render(100).join("\n");
		assert.match(rendered, /Requires setup {2}⊘/);
		assert.match(rendered, /Disabled/);
		list.handleInput("\r");
		assert.equal(activated, false);
	});

	it("shows every visible description in an aligned right-side column", () => {
		const list = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
			{ inlineDescriptions: true },
		);
		const rendered = list.render(100);

		assert.ok(rendered[0].includes("第一项中文说明"));
		assert.ok(rendered[1].includes("第二项中文说明"));
		assert.equal(rendered[0].indexOf("第一项中文说明"), rendered[1].indexOf("第二项中文说明"));
	});

	it("falls back to the selected description below the list when the terminal is narrow", () => {
		const list = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
			{ inlineDescriptions: true },
		);
		const rendered = list.render(36).join("\n");

		assert.ok(rendered.includes("第一项中文说明"));
		assert.ok(!rendered.includes("第二项中文说明"));
	});

	it("preserves the original selected-description layout by default", () => {
		const list = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
		);
		const rendered = list.render(100);

		assert.ok(!rendered[0].includes("第一项中文说明"));
		assert.ok(rendered.join("\n").includes("第一项中文说明"));
		assert.ok(!rendered.join("\n").includes("第二项中文说明"));
	});

	it("propagates focus to a nested focusable submenu and clears it on return", () => {
		const input = new Input();
		let done: (() => void) | undefined;
		const submenu = {
			focused: false,
			handleInput: (data: string) => {
				if (data === "\x1b") done?.();
			},
			invalidate: () => {},
			render: () => input.render(40),
		} as Component & Focusable;
		const list = new SettingsList(
			[
				{
					id: "nested",
					label: "Nested",
					currentValue: "open",
					submenu: (_value, close) => {
						done = close;
						return submenu;
					},
				},
			],
			10,
			testTheme,
			() => {},
			() => {},
		);

		list.focused = true;
		list.handleInput("\r");
		assert.equal(submenu.focused, true);
		list.handleInput("\x1b");
		assert.equal(submenu.focused, false);
	});
});
