// The right-hand workspace keeps several things open at once: the changes/files/terminal/session panels, any number of
// files (text, code, PDF, image, media, Office) and any number of website tabs (each backed by a real browser view in
// the desktop host). Every tab keeps its own state; opening something new activates or adds a tab instead of replacing
// what is already there. The strip scrolls when the tabs do not fit, can be reordered by dragging, and remembers the
// open tabs in the page preferences.
import { html, Icon, useEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";
import { workspaceTabHint, workspaceTabTitle } from "./workspace-model.js";

export {
	normalizeWorkspaceTab,
	normalizeWorkspaceTabs,
	PANEL_TAB_TYPES,
	workspaceTabHint,
	workspaceTabId,
	workspaceTabTitle,
} from "./workspace-model.js";

const TYPE_ICONS = {
	changes: "fileDiff",
	files: "folder",
	terminal: "terminal",
	context: "layers",
	browser: "globe",
	file: "file",
};

/** Drag a tab onto another to move it there; the order is the user's and is saved with the rest of the workspace. */
export function WorkspaceTabs({ tabs, activeId, onActivate, onClose, onCloseOthers, onMove }) {
	const strip = useRef(null);
	const [dragging, setDragging] = useState(null);
	const [menu, setMenu] = useState(null);
	useEffect(() => {
		const close = () => setMenu(null);
		window.addEventListener("pointerdown", close, true);
		return () => window.removeEventListener("pointerdown", close, true);
	}, []);
	useEffect(() => {
		const element = strip.current?.querySelector(".ws-tab.active");
		element?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeId, tabs.length]);
	const drop = (event, target) => {
		event.preventDefault();
		const from = dragging;
		setDragging(null);
		if (from && target && from !== target) onMove(from, target);
	};
	return html`<div class="ws-tabs" role="tablist" ref=${strip}>
		${tabs.map(
			(tab) => html`<div key=${tab.id} role="tab" tabindex="0" draggable="true"
			class=${`ws-tab ${activeId === tab.id ? "active" : ""}`} aria-selected=${activeId === tab.id}
			title=${workspaceTabHint(tab)}
			onClick=${() => onActivate(tab.id)}
			onKeyDown=${(event) => {
				if (event.key === "Enter" || event.key === " ") onActivate(tab.id);
				if (event.key === "Delete" || event.key === "Backspace") onClose(tab.id);
			}}
			onAuxClick=${(event) => {
				if (event.button === 1) {
					event.preventDefault();
					onClose(tab.id);
				}
			}}
			onDragStart=${(event) => {
				setDragging(tab.id);
				event.dataTransfer?.setData("text/plain", tab.id);
				if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			}}
			onDragOver=${(event) => event.preventDefault()}
			onDrop=${(event) => drop(event, tab.id)}
			onContextMenu=${(event) => {
				event.preventDefault();
				if (tabs.length > 1) setMenu({ x: event.clientX, y: event.clientY, id: tab.id });
			}}>
			<${Icon} name=${TYPE_ICONS[tab.type] || "file"} size=${13} class="c-dim" />
			<span class="ws-tab-label truncate">${workspaceTabTitle(tab)}</span>
			<button class="ws-tab-close" aria-label=${t("Close tab")} title=${t("Close tab")} onClick=${(event) => {
				event.stopPropagation();
				onClose(tab.id);
			}}><${Icon} name="x" size=${12} /></button>
		</div>`,
		)}
		${menu ? html`<div class="ws-menu" style=${{ left: `${menu.x}px`, top: `${menu.y}px`, position: "fixed" }} onPointerDown=${(event) => event.stopPropagation()}>
			<button onClick=${() => {
				onClose(menu.id);
				setMenu(null);
			}}>${t("Close tab")}</button>
			<button onClick=${() => {
				onCloseOthers(menu.id);
				setMenu(null);
			}}>${t("Close other tabs")}</button>
		</div>` : null}
	</div>`;
}
