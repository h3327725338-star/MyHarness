// Application shell: sidebar + conversation + optional inspector panel, plus global overlays and shortcuts.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Modal, Resizer, Spinner, usePresence } from "./ui.js";
import { attempt, dismissToast, post, setView, state, useStore } from "./store.js";
import { actions, confirmDialog, resolveConfirm } from "./actions.js";
import { Sidebar } from "./sidebar.js";
import { Transcript } from "./transcript.js";
import { Composer } from "./composer.js";
import { ChangesPanel } from "./panel-changes.js";
import { FilesPanel } from "./panel-files.js";
import { TerminalPanel } from "./panel-terminal.js";
import { ContextPanel } from "./panel-context.js";
import { GitSetupDialog } from "./overlays-git.js";
import { ProviderEditorHost, SettingsModal } from "./overlays-settings.js";
import { CommandPalette } from "./palette.js";
import { clip, plural } from "./util.js";
import { t, N_, serverText } from "./i18n.js";

const OUTCOME_UI = {
	completed: { label: N_("Completed"), cls: "ok", icon: "checkCircle" },
	partial: { label: N_("Partially completed"), cls: "warn", icon: "alertTriangle" },
	failed: { label: N_("Failed"), cls: "danger", icon: "alertCircle" },
	cancelled: { label: N_("Cancelled"), cls: "", icon: "stopCircle" },
};

function StatusPill() {
	const snap = useStore((s) => s.snap);
	const dialogs = useStore((s) => s.dialogs);
	const compaction = useStore((s) => s.compaction);
	const completion = useStore((s) => s.completion);
	if (!snap) return null;
	if (dialogs.length && snap.active) return html`<span class="status-pill warn" role="status"><${Icon} name="clock" size=${13} />${t("Waiting for you")}</span>`;
	if (compaction) return html`<span class="status-pill" role="status"><${Spinner} />${t("Compacting context")}</span>`;
	if (snap.active) {
		const detail = snap.run.state === "recovering" ? t("Recovering") : t("Working");
		return html`<span class="status-pill live" role="status" title=${serverText(snap.run.activity)}><${Spinner} />${detail}</span>`;
	}
	if (completion) return html`<span class="status-pill" role="status"><${Spinner} />${t("Finishing up")}</span>`;
	const last = snap.lastRun;
	if (last && OUTCOME_UI[last.outcome]) {
		const ui = OUTCOME_UI[last.outcome];
		return html`<span class=${`status-pill ${ui.cls}`} role="status" title=${last.error || t(ui.label)}><${Icon} name=${ui.icon} size=${13} />${t(ui.label)}</span>`;
	}
	return null;
}

function Header() {
	const snap = useStore((s) => s.snap);
	const items = useStore((s) => s.items);
	const sidebarOpen = useStore((s) => s.view.sidebarOpen);
	const panelOpen = useStore((s) => s.view.panelOpen);
	const panelTab = useStore((s) => s.view.panelTab);
	const runningBash = useStore((s) => s.snap?.flags?.bashRunning);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const firstUser = items.find((i) => i.kind === "user" && i.text);
	// A chat that has no name and no message yet has no title to show. The workspace is shown above the input, not here.
	const title = snap?.session?.name || (firstUser ? clip(firstUser.text.replace(/\s+/g, " "), 70) : "");
	const commit = async () => {
		setEditing(false);
		const next = value.trim();
		if (next && next !== snap?.session?.name && snap?.session?.file) await actions.renameSession(snap.session.file, next);
	};
	const changeCount = snap?.lastRun?.changeCount || 0;
	const tabBtn = (tab, icon, label, badge) => html`<button class=${`icon-btn ${panelOpen && panelTab === tab ? "active" : ""}`} aria-pressed=${panelOpen && panelTab === tab} title=${label} aria-label=${label} onClick=${() => actions.togglePanel(tab)}><${Icon} name=${icon} size=${17} />${badge ? html`<span class="tab-badge">${badge}</span>` : null}</button>`;
	return html`<header class="main-header">
		${!sidebarOpen ? html`<button class="icon-btn" title=${t("Show sidebar (Ctrl+B)")} aria-label=${t("Show sidebar")} onClick=${() => setView({ sidebarOpen: true })}><${Icon} name="sidebar" size=${17} /></button>` : null}
		${editing
			? html`<input class="field title-input" autofocus value=${value} onInput=${(e) => setValue(e.target.value)} onBlur=${commit} onKeyDown=${(e) => (e.key === "Enter" ? commit() : e.key === "Escape" && setEditing(false))} />`
			: title ? html`<button class="title-btn truncate" title=${t("{title} — double-click to rename", { title })} onDblClick=${() => { if (snap?.session?.file) { setValue(snap.session.name || title); setEditing(true); } }}>${title}</button>` : null}
		<span class="grow" />
		<${StatusPill} />
		${tabBtn("changes", "fileDiff", t("Changes"), changeCount ? String(changeCount) : "")}
		${tabBtn("files", "folder", t("Files"))}
		${tabBtn("terminal", "terminal", t("Terminal"), runningBash ? "•" : "")}
		${tabBtn("context", "layers", t("Session"))}
	</header>`;
}

function PanelContainer() {
	const tab = useStore((s) => s.view.panelTab);
	const snap = useStore((s) => s.snap);
	const bashRunning = !!snap?.flags?.bashRunning;
	const panelRef = useRef(null);
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
	const tabs = [
		{ id: "changes", label: t("Changes"), icon: "fileDiff" },
		{ id: "files", label: t("Files"), icon: "folder" },
		{ id: "terminal", label: t("Terminal"), icon: "terminal" },
		{ id: "context", label: t("Session"), icon: "layers" },
	];
	return html`<aside class="panel" aria-label=${t("Details")} ref=${panelRef}>
		<${Resizer} invert min=${360} max=${Math.round(window.innerWidth * 0.72)} getValue=${() => panelRef.current?.offsetWidth || state.view.panelW} onChange=${onWidth} onEnd=${() => setView({ panelW: state.view.panelW })} />
		<div class="panel-tabs" role="tablist">
			${tabs.map((tab_) => html`<button key=${tab_.id} role="tab" class="tab" title=${tab_.label} aria-selected=${tab === tab_.id} onClick=${() => setView({ panelTab: tab_.id })}><${Icon} name=${tab_.icon} size=${14} /><span class="tab-label">${tab_.label}</span>${tab_.id === "terminal" && bashRunning ? html`<${Spinner} />` : null}</button>`)}
			<span class="grow" />
			<button class="icon-btn sm" aria-label=${t("Close panel")} title=${t("Close panel")} onClick=${() => setView({ panelOpen: false })}><${Icon} name="x" size=${15} /></button>
		</div>
		<div class="panel-body">
			<div class="panel-pane" hidden=${tab !== "changes"}>${tab === "changes" ? html`<${ChangesPanel} />` : null}</div>
			<div class="panel-pane" hidden=${tab !== "files"}><${FilesPanel} /></div>
			<div class="panel-pane" hidden=${tab !== "terminal"}>${tab === "terminal" ? html`<${TerminalPanel} />` : null}</div>
			<div class="panel-pane" hidden=${tab !== "context"}>${tab === "context" ? html`<${ContextPanel} />` : null}</div>
		</div>
	</aside>`;
}

function Toasts() {
	const toasts = useStore((s) => s.toasts);
	return html`<div class="toasts" aria-live="polite">${toasts.map((item) => html`<div key=${item.id} class=${`toast ${item.type}`} role=${item.type === "error" ? "alert" : "status"}>
		<${Icon} name=${item.type === "error" ? "alertCircle" : item.type === "warning" ? "alertTriangle" : "info"} size=${15} class=${item.type === "error" ? "c-danger" : item.type === "warning" ? "c-warn" : "c-dim"} />
		<span class="msg grow">${item.message}</span>
		<button class="icon-btn sm" aria-label=${t("Dismiss")} onClick=${() => dismissToast(item.id)}><${Icon} name="x" size=${13} /></button>
	</div>`)}</div>`;
}

function ConfirmModal({ dialog }) {
	return html`<${Modal} title=${dialog.title} onClose=${() => resolveConfirm(false)} width=${480}
		footer=${html`<button class="btn" onClick=${() => resolveConfirm(false)}>${dialog.cancelLabel || t("Cancel")}</button><button class=${`btn ${dialog.danger ? "danger solid" : "primary"}`} autofocus onClick=${() => resolveConfirm(true)}>${dialog.confirmLabel}</button>`}>
		<div class="pre-wrap">${dialog.message}</div>${dialog.detail ? html`<pre class="git-lines">${dialog.detail}</pre>` : null}
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
			const mod = e.ctrlKey || e.metaKey;
			if (!mod) return;
			const key = e.key.toLowerCase();
			if (key === "k") {
				e.preventDefault();
				setView({ palette: !state.view.palette });
			} else if (key === "n" && !e.shiftKey) {
				e.preventDefault();
				actions.newChat();
			} else if (key === "b") {
				e.preventDefault();
				setView({ sidebarOpen: !state.view.sidebarOpen });
			} else if (key === ",") {
				e.preventDefault();
				setView({ settingsOpen: true });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
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
	const boot = useStore((s) => s.boot);
	const snap = useStore((s) => s.snap);
	const view = useStore((s) => s.view);
	const connected = useStore((s) => s.connected);
	const everConnected = useStore((s) => s.everConnected);
	const shutdown = useStore((s) => s.shutdown);
	useShortcuts();
	// The panel stays mounted while it slides out, and only turns "open" a frame after it is mounted, so both directions animate.
	const panel = usePresence(view.panelOpen, 320);
	const mainRef = useRef(null);
	useWidthClass(mainRef, [snap != null, view.panelOpen, view.sidebarOpen]);
	useEffect(() => {
		document.title = snap?.session?.name ? `${snap.session.name} · MyHarness` : "MyHarness";
	}, [snap?.session?.name]);

	if (shutdown) return html`<div class="splash"><div class="splash-card"><${Icon} name="quit" size=${28} /><h2>${t("MyHarness has stopped")}</h2><div class="dim">${t("The local server was shut down. You can close this tab; start MyHarness again to continue.")}</div></div></div>`;
	if (boot.phase !== "ready" || !snap) {
		return html`<div class="splash"><div class="splash-card">
			${boot.phase === "error" ? html`<${Icon} name="alertCircle" size=${28} class="c-danger" /><h2>${t("MyHarness could not start")}</h2><div class="dim">${boot.detail}</div>` : html`<${Spinner} /><div>${boot.phase === "connecting" ? t("Connecting to the local MyHarness server…") : t("Starting MyHarness…")}</div>`}
		</div>${boot.dialogs?.length ? html`<${BootDialogs} dialogs=${boot.dialogs} />` : null}</div>`;
	}
	const layoutClass = `app ${view.sidebarOpen ? "" : "sidebar-collapsed"} ${panel.shown ? "panel-open" : ""}`;
	return html`<div class=${layoutClass}>
		<${Sidebar} />
		<main class="main" ref=${mainRef}>
			${everConnected && !connected ? html`<div class="conn-banner" role="alert">${t("Connection to the local server lost — reconnecting…")}</div>` : null}
			<${Header} />
			<${Transcript} />
			<${Composer} />
			<${Toasts} />
		</main>
		${panel.mounted ? html`<div class="panel-slot"><${PanelContainer} /></div>` : null}
		${view.settingsOpen ? html`<${SettingsModal} />` : null}
		${view.providerEditor ? html`<${ProviderEditorHost} key=${view.providerEditor.id ?? ""} id=${view.providerEditor.id} />` : null}
		${view.palette ? html`<${CommandPalette} />` : null}
		${view.dialog?.type === "git-setup" ? html`<${GitSetupDialog} />` : null}
		${view.dialog?.type === "confirm" ? html`<${ConfirmModal} dialog=${view.dialog} />` : null}
		${view.dialog?.type === "input" ? html`<${InputModal} dialog=${view.dialog} />` : null}
	</div>`;
}

export { confirmDialog };
