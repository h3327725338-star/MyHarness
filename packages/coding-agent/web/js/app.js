// Application shell: sidebar + conversation + optional inspector panel, plus global overlays and shortcuts.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, autofocusOnMount, Collapse, FoldIn, Icon, Modal, Overlay, Resizer, Spinner, usePresence, useRetainedRows } from "./ui.js";
import { api, attempt, dismissToast, post, setView, state, useStore } from "./store.js";
import { actions, confirmDialog, resolveConfirm } from "./actions.js";
import { Sidebar } from "./sidebar.js";
import { Transcript } from "./transcript.js";
import { Composer } from "./composer.js";
import { ExportHeaderDownload, exportReadOnly } from "./export-mode.js";
import { ChangesPanel } from "./panel-changes.js";
import { FilesPanel, FileTab } from "./panel-files.js";
import { TerminalPanel } from "./panel-terminal.js";
import { ContextPanel } from "./panel-context.js";
import { BrowserPanel } from "./panel-browser.js";
import { PanelNav, useRowFold, WorkspaceTabs, PANEL_TAB_TYPES, workspaceTabSection } from "./workspace-tabs.js";
import { GitSetupDialog } from "./overlays-git.js";
import { ProviderEditorHost, SettingsModal } from "./overlays-settings.js";
import { CommandPalette } from "./palette.js";
import { FloatingQuoteToolbar } from "./quote-toolbar.js";
import { ImageLightboxHost } from "./lightbox.js";
import { useWorkspaceTitle } from "./workspace-title.js";
import { WindowControls } from "./window-controls.js";
import { AppZoomBadge } from "./app-zoom.js";
import { SourcesPageHost } from "./sources-page.js";
import { clip, fmtBytes, plural } from "./util.js";
import { count, t, N_, serverText } from "./i18n.js";

import { eventShortcut, SHORTCUTS, shortcutFor } from "./shortcuts.js";

const OUTCOME_UI = {
	completed: { label: N_("Completed"), cls: "", icon: "checkCircle" },
	partial: { label: N_("Partially completed"), cls: "warn", icon: "alertTriangle" },
	failed: { label: N_("Failed"), cls: "danger", icon: "alertCircle" },
	cancelled: { label: N_("Cancelled"), cls: "", icon: "stopCircle" },
};

function StatusPill() {
	const snap = useStore((s) => s.snap);
	const dialogs = useStore((s) => s.dialogs);
	const compaction = useStore((s) => s.compaction);
	const completion = useStore((s) => s.completion);
	const memory = useStore((s) => s.memoryMaintenance);
	if (!snap) return null;
	if (dialogs.length && snap.active) return html`<span class="status-pill" role="status" title=${t("Waiting for you")}><${Icon} name="clock" size=${13} /><span class="pill-text">${t("Waiting for you")}</span></span>`;
	if (compaction) return html`<span class="status-pill" role="status" title=${t("Compacting context")}><${Spinner} /><span class="pill-text">${t("Compacting context")}</span></span>`;
	if (snap.active) {
		const detail = snap.run.state === "recovering" ? t("Recovering") : t("Working");
		return html`<span class="status-pill live" role="status" title=${serverText(snap.run.activity)}><${Spinner} /><span class="pill-text">${detail}</span></span>`;
	}
	if (completion) return html`<span class="status-pill" role="status" title=${t("Finishing up")}><${Spinner} /><span class="pill-text">${t("Finishing up")}</span></span>`;
	if (memory?.phase === "warning") return html`<span class="status-pill warn memory-warn" role="status" title=${memory.error ? `${t("Last failure reason")}: ${memory.error} · ${t("Open maintenance.log for details")}` : t("Memory maintenance needs attention")}><span class="mem-left"><span class="mem-dot" aria-hidden="true"></span><${Icon} name="alertTriangle" size=${13} /><span class="mem-text">${t("Memory maintenance needs attention")}</span></span><span class="mem-divider" aria-hidden="true"></span><button class="mem-btn retry" title=${t("Retry memory maintenance")} aria-label=${t("Retry memory maintenance")} onClick=${() => attempt(() => post("/api/memory/maintenance-retry", {}))}><${Icon} name="refresh" size=${12} /><span class="mem-btn-text">${t("Retry")}</span></button><button class="mem-btn dismiss" title=${t("Dismiss and archive pending memory")} aria-label=${t("Dismiss and archive pending memory")} onClick=${() => attempt(() => post("/api/memory/maintenance-dismiss", {}))}><${Icon} name="folder" size=${12} /><span class="mem-btn-text">${t("Archive")}</span></button></span>`;
	if (memory?.phase === "processing" || memory?.phase === "pending") return html`<span class="status-pill" role="status" title=${t("Memory runs in the background; you can keep working")}><${Icon} name="clock" size=${13} /><span class="pill-text">${t("Updating memory in background")}</span></span>`;
	const last = snap.lastRun;
	if (last && OUTCOME_UI[last.outcome]) {
		const ui = OUTCOME_UI[last.outcome];
		return html`<span class=${`status-pill ${ui.cls}`} role="status" title=${last.error || t(ui.label)}><${Icon} name=${ui.icon} size=${13} /><span class="pill-text">${t(ui.label)}</span></span>`;
	}
	return null;
}

function Header() {
	const copy = useStore((s) => s.boot.worktreeService);
	const snap = useStore((s) => s.snap);
	const items = useStore((s) => s.items);
	const sidebarOpen = useStore((s) => s.view.sidebarOpen);
	const panelOpen = useStore((s) => s.view.panelOpen);
	// Collaboration mode puts the workspace at the window's left edge and this column at its right edge: the sidebar
	// button then lives in the workspace's header and the close-panel button here, so each stays in its window corner.
	const maxed = useStore((s) => s.view.wsMax) && panelOpen;
	const wsActive = useStore((s) => s.view.wsActive);
	const wsTabs = useStore((s) => s.view.wsTabs);
	const runningBash = useStore((s) => s.snap?.flags?.bashRunning);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const firstUser = items.find((i) => i.kind === "user" && i.text);
	// A chat that has no name and no message yet has no title to show. The workspace is shown above the input, not here.
	const title = snap?.session?.name || (firstUser ? clip(firstUser.text.replace(/\s+/g, " "), 70) : "");
	// An edit ends once, whichever way: Enter saves, Escape keeps the title as it was. The box that closes also loses the
	// focus, and that must neither save what was typed after Escape nor save a second time after Enter.
	const ended = useRef(true);
	const finish = async (save) => {
		if (ended.current) return;
		ended.current = true;
		setEditing(false);
		const next = value.trim();
		if (save && next && next !== snap?.session?.name && snap?.session?.file) await actions.renameSession(snap.session.file, next);
	};
	// The badge counts the working tree's uncommitted files, which belong to the folder: a general chat does not show it.
	const dirtyCount = useStore((s) => s.gitStatus?.preview?.total || 0);
	const generalMode = useStore((s) => s.view.chatMode) === "general";
	const changeCount = generalMode ? 0 : dirtyCount;
	const tabBtn = (tab, icon, label, badge) => html`<button class=${`icon-btn ${panelOpen && wsActive === tab ? "active" : ""}`} aria-pressed=${panelOpen && wsActive === tab} data-export-offline=${["changes", "files", "terminal"].includes(tab) ? "true" : undefined} title=${label} aria-label=${label} onClick=${() => actions.togglePanel(tab)}><${Icon} name=${icon} size=${17} />${badge ? html`<span class="tab-badge">${badge}</span>` : null}</button>`;
	const browserActive = panelOpen && wsTabs.some((tab) => tab.id === wsActive && tab.type === "browser");
	return html`<header class="main-header">
		${!sidebarOpen && !maxed ? html`<button class="icon-btn" title=${`${t("Show sidebar")} (${shortcutFor("sidebar", state.view.shortcuts)})`} aria-label=${t("Show sidebar")} onClick=${() => setView({ sidebarOpen: true })}><${Icon} name="sidebar" size=${17} /></button>` : null}
		${editing
			? html`<input class="field title-input" autofocus ref=${autofocusOnMount} value=${value} onInput=${(e) => setValue(e.target.value)} onBlur=${() => finish(true)} onKeyDown=${(e) => (e.key === "Enter" ? finish(true) : e.key === "Escape" && finish(false))} />`
			: title ? html`<button class="title-btn truncate" title=${t("{title} — double-click to rename", { title })} onDblClick=${() => { if (snap?.session?.file) { ended.current = false; setValue(snap.session.name || title); setEditing(true); } }}>${title}</button>` : null}
		${copy ? html`<span class="badge truncate" title=${`${copy.name}\n${copy.path}`}>${t("Copy")} · ${copy.name}</span>` : null}
		<span class="grow" />
		${exportReadOnly() ? html`<span class="export-top-badge" role="status"><${Icon} name="lock" size=${13} />${t("Read-only copy")}</span>` : null}
		${exportReadOnly() && !sidebarOpen ? html`<${ExportHeaderDownload} />` : null}
		<${StatusPill} />
		${tabBtn("changes", "fileDiff", t("Changes"), changeCount ? String(changeCount) : "")}
		${tabBtn("files", "folder", t("Files"))}
		${tabBtn("terminal", "terminal", t("Terminal"), runningBash ? "•" : "")}
		${tabBtn("context", "layers", t("Session"))}
		${window.myHarnessDesktop && !exportReadOnly() ? html`<button class=${`icon-btn ${browserActive ? "active" : ""}`} aria-pressed=${browserActive} title=${t("Browser")} aria-label=${t("Browser")} onClick=${() => actions.openBrowser()}><${Icon} name="globe" size=${17} /></button>` : null}
		${maxed ? html`<button class="icon-btn" aria-label=${t("Close panel")} title=${t("Close panel")} onClick=${() => actions.closePanel()}><${Icon} name="panelRight" size=${17} /></button>` : null}
	</header>`;
}

function PanelContainer() {
	const tabs = useStore((s) => s.view.wsTabs);
	const tabIconsOnly = useStore((s) => s.view.wsTabIconsOnly);
	const browserIcons = useStore((s) => s.view.browserIcons);
	const browserAudio = useStore((s) => s.view.browserAudio);
	const activeId = useStore((s) => s.view.wsActive);
	const closedCount = useStore((s) => s.view.wsClosed.length);
	const wsMax = useStore((s) => s.view.wsMax);
	const sidebarOpen = useStore((s) => s.view.sidebarOpen);
	const panelRef = useRef(null);
	const headRef = useRef(null);
	const active = tabs.find((item) => item.id === activeId) || tabs[0] || null;
	// The header names every section; the section on screen adds its own tabs when it has any: the website tabs in the
	// browser, the file list and the open files in Files. Changes, Terminal and Session are one panel each. Without a
	// desktop browser (a plain web page, a read-only export) there is no browser entry unless website tabs are open.
	const section = active ? workspaceTabSection(active) : null;
	const browserTabs = tabs.filter((item) => item.type === "browser");
	const fileTabs = tabs.filter((item) => item.type === "file");
	const browserEntry = browserTabs.length > 0 || (!!window.myHarnessDesktop && !exportReadOnly());
	const rowTabs =
		section === "browser"
			? browserTabs
			: section === "files" && fileTabs.length > 0
				? [tabs.find((item) => item.id === "files") ?? { id: "files", type: "files" }, ...fileTabs]
				: null;
	// The tabs of the section sit in the navigation row itself, so the browser (and a file) keeps the full height of the
	// panel: the section names fold to icons to make room for them.
	const strip = rowTabs
		? html`<${WorkspaceTabs} key=${section} tabs=${rowTabs} activeId=${active?.id}
				iconsOnly=${section === "browser" && tabIconsOnly} icons=${browserIcons}
				audio=${browserAudio} onToggleMute=${section === "browser" && window.myHarnessDesktop ? (id) => actions.toggleBrowserMute(id) : null}
				onToggleIconsOnly=${section === "browser" ? () => actions.toggleTabIconsOnly() : null}
				titleFor=${(item) => (item.type === "files" ? t("File list") : null)} closable=${(item) => item.type !== "files"}
				onActivate=${(id) => (id === "files" ? actions.openWorkspace({ type: "files" }) : actions.activateWorkspaceTab(id))}
				onClose=${(id) => actions.closeWorkspaceTab(id)} onCloseOthers=${(id) => actions.closeOtherWorkspaceTabs(id, { sameSection: true })}
				onMove=${(from, to) => actions.moveWorkspaceTab(from, to)} />
			${section === "browser" ? html`<button class="icon-btn sm ws-new-tab" title=${t("New browser tab")} aria-label=${t("New browser tab")} onClick=${() => actions.openBrowserTab()}><${Icon} name="plus" size=${15} /></button>` : null}`
		: null;
	// A head too narrow for the section names folds them into icons, and narrower still the sections into one menu.
	const fold = useRowFold(headRef, `${section}|${rowTabs?.length ?? 0}|${closedCount > 0}|${browserEntry}|${wsMax}|${sidebarOpen}`);
	// The panel is never wider than the room the window leaves it (the cap of --panel-width in layout.css). A drag starts
	// from the width that is on screen and stops at that cap, so the handle always moves with the pointer: a width saved
	// in a larger window, or a drag past the cap, leaves no dead stretch to drag back through.
	const room = () => Math.max(340, window.innerWidth - (state.view.sidebarOpen ? state.view.sidebarW : 0) - 520);
	const onWidth = (value) => {
		const w = Math.round(Math.min(value, room()));
		state.view = { ...state.view, panelW: w };
		document.documentElement.style.setProperty("--panel-w", `${w}px`);
	};
	useWidthClass(panelRef, [], [440, 440]);
	// Panel tabs stay mounted while another tab is shown (their tree, filters and scroll survive a switch); file and
	// browser tabs mount only while active — a browser tab's page lives in the host process and is not reloaded.
	const panelTab = (type) => {
		if (type === "changes") return html`<${ChangesPanel} />`;
		if (type === "files") return html`<${FilesPanel} embedded=${true} />`;
		if (type === "terminal") return html`<${TerminalPanel} />`;
		if (type === "context") return html`<${ContextPanel} />`;
		return null;
	};
	return html`<aside class="panel" aria-label=${t("Details")} ref=${panelRef}>
		${wsMax ? null : html`<${Resizer} invert min=${360} max=${Math.round(window.innerWidth * 0.72)} getValue=${() => panelRef.current?.offsetWidth || state.view.panelW} onChange=${onWidth} onEnd=${() => setView({ panelW: state.view.panelW })} />`}
		<div class="panel-head" ref=${headRef}>
			${wsMax && !sidebarOpen ? html`<button class="icon-btn sm panel-sidebar" title=${`${t("Show sidebar")} (${shortcutFor("sidebar", state.view.shortcuts)})`} aria-label=${t("Show sidebar")} onClick=${() => setView({ sidebarOpen: true })}><${Icon} name="sidebar" size=${16} /></button>` : null}
			<${PanelNav} section=${section} browser=${browserEntry} fold=${fold} onRestore=${closedCount > 0 ? () => actions.reopenWorkspaceTab() : null} onShow=${(value) => actions.showWorkspaceSection(value)}>${strip}<//>
			<span class="grow" />
			${closedCount > 0 && fold !== "tight" ? html`<button class="icon-btn sm" title=${t("Restore closed tab")} aria-label=${t("Restore closed tab")} onClick=${() => actions.reopenWorkspaceTab()}><${Icon} name="undo" size=${14} /></button>` : null}
			<button class=${`icon-btn sm panel-max ${wsMax ? "active" : ""}`} aria-pressed=${wsMax} title=${`${t(wsMax ? "Restore the workspace (Esc)" : "Maximize the workspace and keep chatting beside it")} (${shortcutFor("workspaceMax", state.view.shortcuts)})`} aria-label=${t(wsMax ? "Restore the workspace" : "Maximize the workspace")} onClick=${() => actions.toggleWorkspaceMax()}><${Icon} name=${wsMax ? "minimize" : "maximize"} size=${14} /></button>
			${wsMax ? null : html`<button class="icon-btn sm panel-close" aria-label=${t("Close panel")} title=${t("Close panel")} onClick=${() => actions.closePanel()}><${Icon} name="panelRight" size=${15} /></button>`}
		</div>
		<div class="panel-body">
			${tabs.map((item) => html`<div class="panel-pane" key=${item.id} data-ws-tab=${item.id} hidden=${item.id !== active?.id}>
				${item.id !== active?.id ? null : item.type === "file" ? html`<${FileTab} key=${item.id} path=${item.path} />` : item.type === "browser" ? html`<${BrowserPanel} key=${item.id} tabId=${item.id} url=${item.url} muted=${item.muted === true} />` : panelTab(item.type)}
			</div>`)}
			${!active ? html`<div class="panel-empty"><span class="dim">${t("No tabs open. Use the header buttons to open Changes, Files, Terminal, Session or the browser.")}</span></div>` : null}
		</div>
	</aside>`;
}

export function Toasts() {
	const toasts = useStore((s) => s.toasts);
	// A dismissed toast stays while it fades and folds away, so the ones below it slide up instead of jumping.
	const { rows, present } = useRetainedRows(toasts, "id");
	return html`<div class="toasts" aria-live="polite">${rows.map((item) => html`<${Collapse} key=${item.id} open=${present.has(item.id)} class="toast-slot"><div class=${`toast ${item.type}`} role=${item.type === "error" ? "alert" : "status"}>
		<${Icon} name=${item.type === "error" ? "alertCircle" : item.type === "warning" ? "alertTriangle" : "info"} size=${15} class=${item.type === "error" ? "c-danger" : item.type === "warning" ? "c-warn" : "c-dim"} />
		<span class="msg grow">${item.message}</span>
		<button class="icon-btn sm" aria-label=${t("Dismiss")} onClick=${() => dismissToast(item.id)}><${Icon} name="x" size=${13} /></button>
	</div><//>`)}</div>`;
}

export function ConfirmModal({ dialog }) {
	const [deleteArtifacts, setDeleteArtifacts] = useState(false);
	return html`<${Modal} title=${dialog.title} onClose=${() => resolveConfirm(false)} width=${480}
		footer=${html`<button class="btn" autofocus=${dialog.artifactChoice} onClick=${() => resolveConfirm(false)}>${dialog.cancelLabel || t("Cancel")}</button><button class=${`btn ${dialog.danger ? "danger solid" : "primary"}`} autofocus=${!dialog.artifactChoice} onClick=${() => resolveConfirm(dialog.artifactChoice ? { deleteArtifacts } : true)}>${dialog.confirmLabel}</button>`}>
		<div class="pre-wrap">${dialog.message}</div>
		${dialog.artifactChoice ? html`<label class="row"><input type="checkbox" checked=${deleteArtifacts} onChange=${(e) => setDeleteArtifacts(e.target.checked)} />${t("Also permanently delete artifacts")}</label><p class="dim">${deleteArtifacts ? t("Artifact files and their workspace/global references will be removed. Project files are not affected.") : t("Artifacts and their origin remain available in workspace/global indexes.")}</p>` : null}
		${dialog.detail ? html`<pre class="git-lines">${dialog.detail}</pre>` : null}
	<//>`;
}

/**
 * One optional part of a chat deletion. The whole row, the drawn switch included, is clickable through one native switch
 * button laid over it (Space and Enter work as on any button); a link in the label (`children`) sits above that button,
 * so using the link never flips the switch. The toggle on the right only shows the state.
 */
function DeleteOption({ icon, label, detail, checked, disabled, onChange, children }) {
	return html`<div class=${`del-row opt${checked ? " on" : ""}${disabled ? " off" : ""}`}>
		<button type="button" class="del-hit" role="switch" aria-checked=${checked ? "true" : "false"} aria-label=${label} title=${detail} disabled=${disabled} onClick=${() => onChange(!checked)} />
		<span class="del-icon"><${Icon} name=${icon} size=${16} /></span>
		<span class="del-text"><span class="del-label">${label}${children}</span><span class="del-detail">${detail}</span></span>
		<span class=${`toggle${checked ? " on" : ""}`} aria-hidden="true" />
	</div>`;
}

const MEMORY_SCOPE_LABELS = { global: N_("Global"), workspace: N_("Workspace"), session: N_("This chat") };

/**
 * "Delete this chat?": the messages always go; artifacts and the memories that came only from this chat are switches
 * with their counts (`GET /api/sessions/delete-impact`). The dialog opens at once and the counts fill in; every line is
 * one line, so nothing moves when they arrive or a switch flips.
 */
export function DeleteChatModal({ dialog }) {
	const [deleteArtifacts, setDeleteArtifacts] = useState(false);
	const [deleteMemory, setDeleteMemory] = useState(false);
	const [showMemories, setShowMemories] = useState(false);
	// undefined while counting, null when the count failed (the switches still work then).
	const [impact, setImpact] = useState(undefined);
	useEffect(() => {
		let live = true;
		api(`/api/sessions/delete-impact?path=${encodeURIComponent(dialog.path)}`, { slot: "" }).then(
			(value) => live && setImpact(value ?? null),
			() => live && setImpact(null),
		);
		return () => {
			live = false;
		};
	}, [dialog.path]);
	const loading = impact === undefined;
	const art = impact?.artifacts ?? { files: 0, bytes: 0 };
	const owned = impact?.memories?.owned ?? [];
	const shared = impact?.memories?.shared ?? 0;
	// Old versions that only this chat wrote and that go with its memories even when none of them is active any more.
	const retired = impact?.memories?.retired ?? 0;
	// Uploads and tool outputs stay on disk: copies of this chat (forks, worktree copies) may still point at them.
	const keptFiles = (impact?.history?.uploads?.files ?? 0) + (impact?.history?.toolResults?.files ?? 0);
	const historyDetail = keptFiles ? t("All messages · {kept} stay", { kept: count(keptFiles, "attachment") }) : t("All messages in this chat");
	const artifactDetail = loading ? t("Counting…") : !impact ? t("Count unavailable") : art.files ? t("{files} · {size}", { files: count(art.files, "file"), size: fmtBytes(art.bytes) }) : t("This chat saved no artifacts");
	const memoryDetail = loading
		? t("Counting…")
		: !impact
			? t("Count unavailable")
			: owned.length
				? shared
					? t("{memories} · {shared} shared with other chats stay", { memories: count(owned.length, "memory", "memories"), shared })
					: count(owned.length, "memory", "memories")
				: retired
					? t("{versions} in the archive", { versions: count(retired, "old version") })
					: t("No memories came from only this chat");
	const showLink = owned.length
		? html`<button type="button" class="link-btn" onClick=${() => setShowMemories((open) => !open)}>${showMemories ? t("Hide list") : t("Show which")}</button>`
		: null;
	return html`<${Modal} title=${t("Delete this chat?")} subtitle=${t("“{title}” will be permanently deleted. This cannot be undone.", { title: dialog.title })} width=${440} class="delete-chat" onClose=${() => resolveConfirm(false)}
		footer=${html`<button class="btn" autofocus onClick=${() => resolveConfirm(false)}>${t("Cancel")}</button><button class="btn danger solid" onClick=${() => resolveConfirm({ deleteArtifacts, deleteMemory })}>${t("Delete")}</button>`}>
		<div class="del-rows">
			<div class="del-row always">
				<span class="del-icon"><${Icon} name="chat" size=${16} /></span>
				<span class="del-text"><span class="del-label">${t("Chat history")}</span><span class="del-detail" title=${keptFiles ? t("Uploaded files and tool outputs stay on disk, because copies of this chat may still use them.") : undefined}>${historyDetail}</span></span>
				<span class="del-pill">${t("Always deleted")}</span>
			</div>
			<${DeleteOption} icon="layers" label=${t("Artifacts")} detail=${artifactDetail} checked=${deleteArtifacts} disabled=${loading || (impact && art.files === 0)} onChange=${setDeleteArtifacts} />
			<${DeleteOption} icon="brain" label=${t("Memories from this chat")} detail=${memoryDetail} checked=${deleteMemory} disabled=${loading || (impact && owned.length === 0 && !retired)} onChange=${setDeleteMemory}>${showLink}<//>
			<${Collapse} open=${showMemories && owned.length > 0}><ul class="del-list">${owned.map((memory) => html`<li key=${memory.id}>${memory.name || memory.id}<span class="dim">${t(MEMORY_SCOPE_LABELS[memory.scope] ?? memory.scope)}</span></li>`)}</ul><//>
		</div>
		<p class="del-hint">${t("Files this chat wrote into your project folder are never deleted here.")}</p>
	<//>`;
}

/** What the desktop window's close button does: keep running in the tray, quit, or nothing. */
function CloseAppModal() {
	const [remember, setRemember] = useState(false);
	const pick = (choice) => resolveConfirm({ choice, remember: choice !== "cancel" && remember });
	const option = (choice, icon, label, detail) => html`<button class=${`close-choice ${choice}`} autofocus=${choice === "tray"} onClick=${() => pick(choice)}>
		<span class="close-choice-icon"><${Icon} name=${icon} size=${20} /></span>
		<span class="close-choice-text"><span class="close-choice-label">${label}</span><span class="close-choice-detail">${detail}</span></span>
		<${Icon} name="chevronRight" size=${15} class="close-choice-go" />
	</button>`;
	return html`<${Modal} title=${t("Close MyHarness?")} onClose=${() => pick("cancel")} width=${440} class="close-app"
		footer=${html`<label class="close-remember"><input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} />${t("Remember my choice")}</label><span class="grow" /><button class="btn" onClick=${() => pick("cancel")}>${t("Cancel")}</button>`}>
		<div class="close-choices">
			${option("tray", "desktop", t("Minimize to tray"), t("The window hides in the taskbar corner; running tasks keep going."))}
			${option("quit", "quit", t("Quit MyHarness"), t("Ends MyHarness and every task it is running."))}
		</div>
		<p class="close-hint">${t("You can change this later in Settings → Appearance → Desktop app.")}</p>
	<//>`;
}

function InputModal({ dialog }) {
	const [value, setValue] = useState(dialog.initial || "");
	const submit = () => resolveConfirm(value.trim() ? value.trim() : undefined);
	return html`<${Modal} title=${dialog.title} onClose=${() => resolveConfirm(undefined)} width=${440}
		footer=${html`<button class="btn" onClick=${() => resolveConfirm(undefined)}>${t("Cancel")}</button><button class="btn primary" onClick=${submit}>${dialog.confirmLabel}</button>`}>
		<label class="col field-label">${dialog.label}<input class="field" autofocus value=${value} placeholder=${dialog.placeholder} onInput=${(e) => setValue(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && submit()} /></label>
	<//>`;
}

/**
 * Each overlay subscribes to the single view (or boot) field that shows it, so opening or closing a dialog re-renders
 * only this host and not the whole App tree (W203: the settings close used to re-render the root once per store change
 * the whole `view` object was read at the root).
 */
function SettingsOverlayHost() {
	const open = useStore((s) => s.view.settingsOpen);
	return html`<${Overlay} show=${!!open}>${open ? html`<${SettingsModal} />` : null}<//>`;
}

function ProviderEditorOverlayHost() {
	const editor = useStore((s) => s.view.providerEditor);
	return html`<${Overlay} show=${!!editor}>${editor ? html`<${ProviderEditorHost} key=${editor.id ?? ""} id=${editor.id} />` : null}<//>`;
}

function PaletteOverlayHost() {
	const open = useStore((s) => s.view.palette);
	return html`<${Overlay} show=${!!open}>${open ? html`<${CommandPalette} />` : null}<//>`;
}

function DialogOverlayHost() {
	const dialog = useStore((s) => s.view.dialog);
	const type = dialog?.type;
	return html`<${Overlay} show=${type === "git-setup"}>${type === "git-setup" ? html`<${GitSetupDialog} />` : null}<//>
		<${Overlay} show=${type === "confirm"}>${type === "confirm" ? html`<${ConfirmModal} dialog=${dialog} />` : null}<//>
		<${Overlay} show=${type === "input"}>${type === "input" ? html`<${InputModal} dialog=${dialog} />` : null}<//>
		<${Overlay} show=${type === "close-app"}>${type === "close-app" ? html`<${CloseAppModal} />` : null}<//>
		<${Overlay} show=${type === "delete-chat"}>${type === "delete-chat" ? html`<${DeleteChatModal} dialog=${dialog} />` : null}<//>`;
}

function BootDialogHost() {
	const dialogs = useStore((s) => s.boot.dialogs);
	if (!dialogs?.length) return null;
	return html`<${BootDialogs} dialogs=${dialogs} />`;
}

/** Startup / no-session dialogs (e.g. Project Trust) that arrive before the app is ready. */
function BootDialogs({ dialogs }) {
	const answer = (id, value) => attempt(() => post("/api/ui/respond", { id, value }));
	return html`${dialogs.map((d) => html`<${Modal} key=${d.id} title=${String(d.title).split("\n")[0]} onClose=${null} width=${520} closeOnScrim=${false}>
		<div class="pre-wrap">${[String(d.title).split("\n").slice(1).join("\n"), d.message].filter(Boolean).join("\n")}</div>
		<div class="modal-options">${d.kind === "select" ? d.options.map((o) => html`<button class="btn" key=${o} onClick=${() => answer(d.id, o)}>${o}</button>`) : d.kind === "confirm" ? html`<div class="row"><button class="btn" onClick=${() => answer(d.id, false)}>${t("No")}</button><button class="btn primary" onClick=${() => answer(d.id, true)}>${t("Yes")}</button></div>` : null}</div>
	<//>`)}`;
}

function useShortcuts() {
	useEffect(() => {
		const onKey = (e) => {
			if (e.defaultPrevented || e.target.closest?.(".xterm, [data-shortcut-editor]")) return;
			const key = eventShortcut(e);
			const item = SHORTCUTS.find((item) => shortcutFor(item.id, state.view.shortcuts) === key);
			if (!item) return;
			// Read-only export copies ignore the shortcuts whose actions do not exist there (D-18): no new chat,
			// no settings panel, no composer focus. Palette/sidebar/filter stay available as pure view features.
			if (exportReadOnly() && (item.id === "newChat" || item.id === "settings" || item.id === "focus")) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.repeat) return;
			if (item.id === "palette") setView({ palette: !state.view.palette });
			else if (item.id === "newChat") actions.newChat();
			else if (item.id === "sidebar") setView({ sidebarOpen: !state.view.sidebarOpen });
			else if (item.id === "settings") setView({ settingsOpen: true });
			else if (item.id === "focus") document.querySelector(".composer-input")?.focus();
			else if (item.id === "workspaceMax") actions.toggleWorkspaceMax();
			else if (item.id === "filter") { setView({ sidebarOpen: true }); document.querySelector(".sidebar-search input")?.focus(); }
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}

/**
 * Narrowest chat column in collaboration mode. On the frameless desktop window the column's header also holds the
 * window buttons, so it keeps their width plus its own icon row (the `--chat-min-ws` floor in layout.css).
 */
function chatColumnMin() {
	const controls = document.querySelector(".window-controls");
	return controls ? Math.max(320, controls.offsetWidth + 6 + 268) : 320;
}

/** In collaboration mode the chat column is as wide as the user dragged it, within the room the workspace leaves. */
function onChatWidth(value) {
	const w = Math.round(Math.max(chatColumnMin(), Math.min(value, Math.max(320, window.innerWidth - 480))));
	state.view = { ...state.view, chatW: w };
	document.documentElement.style.setProperty("--chat-w", `${w}px`);
}

/**
 * Esc leaves collaboration mode, unless something else is using it: a dialog or menu that is open, a field or editor that
 * has the focus, or a handler that already took the key.
 */
function useWorkspaceMaxEscape(active) {
	useEffect(() => {
		if (!active) return undefined;
		const onKey = (event) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
			const target = event.target;
			if (target?.closest?.("input, textarea, select, [contenteditable='true'], .xterm, [role='menu'], [aria-modal='true']")) return;
			// The selection bubble and the translation or quote card close first (quote-toolbar.js takes this Esc).
			if (document.querySelector(".overlay-host [aria-modal='true'], .local-file-menu, .ws-menu, .popover, .lightbox-scrim, .composer.expanded, .floating-quote-bar, .quote-note-card")) return;
			event.preventDefault();
			actions.toggleWorkspaceMax(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);
}

function useWidthClass(ref, deps, limits = [430, 620]) {
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return undefined;
		const apply = () => {
			const w = el.clientWidth;
			const next = w < limits[0] ? "xs" : w < limits[1] ? "s" : "m";
			// Only a real change touches the DOM: a drag resizes every frame but crosses a limit rarely.
			if (el.dataset.w !== next) el.dataset.w = next;
		};
		apply();
		let frame = 0;
		const ro = new ResizeObserver(() => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				apply();
			});
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(frame);
		};
	}, deps);
}

export function App() {
	// Only the fields the shell itself lays out or shows are read here; everything a dialog or overlay owns is read in
	// that overlay's own host component, so a view change that concerns only a dialog leaves the App tree alone.
	const bootPhase = useStore((s) => s.boot.phase);
	const bootDetail = useStore((s) => s.boot.detail);
	const snap = useStore((s) => s.snap);
	const panelOpen = useStore((s) => s.view.panelOpen);
	const sidebarOpen = useStore((s) => s.view.sidebarOpen);
	const wsMax = useStore((s) => s.view.wsMax);
	const connected = useStore((s) => s.connected);
	const everConnected = useStore((s) => s.everConnected);
	const restarting = useStore((s) => s.restarting);
	const shutdown = useStore((s) => s.shutdown);
	useShortcuts();
	// The panel stays mounted while it slides out, and only turns "open" a frame after it is mounted, so both directions animate.
	const panel = usePresence(panelOpen, 320);
	const mainRef = useRef(null);
	useWidthClass(mainRef, [snap != null, panelOpen, sidebarOpen, wsMax]);
	useWorkspaceMaxEscape(wsMax);
	// Entering or leaving collaboration mode swaps the order of the columns; their widths must not animate across the
	// swap (the conversation would sweep through the middle), so the layout switches at once and the motion is the View
	// Transition of layout-morph.js, which moves each column's picture from its old box to its new one.
	const appRef = useRef(null);
	const wasMax = useRef(wsMax);
	useLayoutEffect(() => {
		if (wasMax.current === wsMax || !appRef.current) return undefined;
		wasMax.current = wsMax;
		const app = appRef.current;
		app.classList.add("ws-switching");
		const timer = setTimeout(() => app.classList.remove("ws-switching"), 60);
		return () => clearTimeout(timer);
	}, [wsMax]);
	useWorkspaceTitle();


	if (shutdown) return html`<div class="splash"><div class="splash-card"><${Icon} name="quit" size=${28} /><h2>${t("MyHarness has stopped")}</h2><div class="dim">${t("The local server was shut down. You can close this tab; start MyHarness again to continue.")}</div></div><${WindowControls} bare /></div>`;
	if ((!restarting && bootPhase !== "ready") || !snap) {
		return html`<div class="splash"><div class="splash-card">
			${bootPhase === "error" ? html`<${Icon} name="alertCircle" size=${28} class="c-danger" /><h2>${t("MyHarness could not start")}</h2><div class="dim">${bootDetail}</div>` : html`<${Spinner} /><div>${bootPhase === "connecting" ? t("Connecting to the local MyHarness server…") : t("Starting MyHarness…")}</div>`}
		</div><${BootDialogHost} /><${WindowControls} bare /></div>`;
	}
	const layoutClass = `app ${panel.shown ? "panel-open" : ""} ${wsMax && panel.mounted ? "ws-max" : ""}`;
	return html`<div class=${layoutClass} ref=${appRef}>
		<${Sidebar} />
		<main class="main" ref=${mainRef}>
			${wsMax ? html`<${Resizer} invert min=${chatColumnMin()} max=${Math.round(window.innerWidth * 0.6)} getValue=${() => mainRef.current?.offsetWidth || state.view.chatW} onChange=${onChatWidth} onEnd=${() => setView({ chatW: state.view.chatW })} />` : null}
			<${FoldIn} content=${!restarting && everConnected && !connected ? html`<div class="conn-banner" role="status">${t("Connection to the local server lost — reconnecting…")}</div>` : null} />
			<${Header} />
			<${Transcript} />
			${exportReadOnly() ? null : html`<${Composer} />`}
			${exportReadOnly() ? null : html`<${SourcesPageHost} />`}
			<${Toasts} />
			<${AppZoomBadge} />
			${exportReadOnly() ? null : html`<${FloatingQuoteToolbar} />`}
		</main>
		${panel.mounted ? html`<div class="panel-slot"><${PanelContainer} /></div>` : null}
		<${SettingsOverlayHost} />
		<${ProviderEditorOverlayHost} />
		<${PaletteOverlayHost} />
		<${DialogOverlayHost} />
		<${ImageLightboxHost} />
		<${WindowControls} />
	</div>`;
}

export { confirmDialog };
