// How the Web UI opens the rows of the /settings menu. The menu itself (rows, order, names, descriptions and fixed
// choices) is defined once, in src/cli/settings-menu.ts, and arrives with GET /api/settings (`menu`); the terminal builds
// its menu from the same definition. A row that edits one setting says so there (`setting`) and needs nothing here. The
// rows below open a page of their own in the inline command panel; this table only names them and their icon.
// test/web-frontend-logic.test.ts checks that every row of the menu can be opened and that nothing here is left over.
export const SETTINGS_MENU_PAGES = {
	providers: "key",
	"github-connect": "gitBranch",
	"default-model": "cpu",
	"web-search": "globe",
	"context-window": "layers",
	"git-integration": "gitBranch",
	warnings: "alertTriangle",
	thinking: "brain",
	appearance: "eye",
	"project-trust": "shield",
	about: "info",
};

/** Icons of the rows that edit one setting in place (a row not named here gets the general one). */
const SETTING_ICONS = {
	"show-images": "image",
	"image-width-cells": "image",
	"auto-resize-images": "image",
	"block-images": "image",
	"skill-commands": "bolt",
	"show-hardware-cursor": "terminal",
	"editor-padding": "columns",
	"output-padding": "columns",
	"autocomplete-max-visible": "list",
	"clear-on-shrink": "terminal",
	"terminal-progress": "terminal",
	"popup-notifications": "alertCircle",
	"auto-memory": "book",
	"sub-agent": "tree",
	"code-intelligence": "sparkle",
	"vision-assistant": "eye",
	"compact-model": "layers",
	autocompact: "layers",
	"steering-mode": "send",
	"follow-up-mode": "send",
	transport: "plug",
	"http-idle-timeout": "clock",
	"hide-thinking": "brain",
	"cache-miss-notices": "info",
	"collapse-changelog": "list",
	"quiet-startup": "play",
	"install-telemetry": "hash",
	"default-project-trust": "shield",
	"double-escape-action": "undo",
	"auto-retry": "refresh",
	"model-cycling-scope": "cpu",
	"web-exit-delay": "clock",
	"shell-path": "terminal",
	"shell-command-prefix": "terminal",
	analytics: "hash",
};

/** The icon of a /settings row. */
export const settingsMenuIcon = (id) => SETTINGS_MENU_PAGES[id] || SETTING_ICONS[id] || "sliders";
