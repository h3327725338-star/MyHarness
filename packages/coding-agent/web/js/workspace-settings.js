import { html, useEffect, useRef, useState, Icon, Modal, Overlay } from "./ui.js";
import { api, post, loadWorkspaces } from "./store.js";
import { t } from "./i18n.js";
import { PersonalFullscreen } from "./overlays-settings.js";

/**
 * Both General workspace entry points use the same persisted settings editor: name and instructions in one group, the
 * two switches in another. The instructions box opens in the same fullscreen editor as the personal prompts; it writes
 * back live and the dialog's Save still submits. Sources are managed on the project sources page (sources-page.js).
 */
export function WorkspaceSettings({ id, onClose }) {
	const [workspace, setWorkspace] = useState(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const text = useRef(null);
	const expander = useRef(null);
	const caret = useRef({ start: 0, end: 0 });
	const reload = async () => {
		try {
			const data = await api(`/api/workspaces/settings?id=${encodeURIComponent(id)}`);
			setWorkspace(data.workspace);
		} catch (e) { setError(e.message); }
	};
	useEffect(() => { reload(); }, [id]);
	const change = (key, value) => setWorkspace((previous) => ({ ...previous, [key]: value }));
	const openFullscreen = () => {
		const src = text.current;
		caret.current = { start: src?.selectionStart ?? 0, end: src?.selectionEnd ?? src?.selectionStart ?? 0 };
		setFullscreen(true);
	};
	const save = async () => {
		setBusy(true); setError("");
		try {
			await post("/api/workspaces/settings", { id, name: workspace.name, instructions: workspace.instructions || "", memoryEnabled: workspace.memoryEnabled !== false, libraryEnabled: workspace.libraryEnabled !== false });
			await loadWorkspaces("general"); onClose();
		} catch (e) { setError(e.message); }
		finally { setBusy(false); }
	};
	return html`<${Overlay} show><${Modal} title=${t("Workspace settings")} onClose=${onClose} width=${540}
		footer=${html`<button class="btn" onClick=${onClose}>${t("Cancel")}</button><button class="btn primary" disabled=${busy || !workspace?.name?.trim()} onClick=${save}>${t("Save")}</button>`}>
		${!workspace ? html`<div class="dim">${t("Loading…")}</div>` : html`<div class="col ws-set">
			<section class="col ws-set-group">
				<div class="ws-set-title">${t("Basics")}</div>
				<label class="col field-label">${t("Workspace name")}<input class="field" value=${workspace.name} onInput=${(e) => change("name", e.target.value)} /></label>
				<label class="col field-label">${t("Workspace instructions")}<span class="personal-expand">
					<textarea class="field personal-prompt ws-set-instructions" rows="6" ref=${text} value=${workspace.instructions || ""} onInput=${(e) => change("instructions", e.target.value)} />
					<button type="button" class="icon-btn sm personal-expand-btn" ref=${expander} title=${t("Edit fullscreen")} aria-label=${t("Edit fullscreen")} onClick=${(e) => { e.preventDefault(); openFullscreen(); }}><${Icon} name="maximize" size=${14} /></button>
				</span></label>
			</section>
			<section class="col ws-set-group">
				<div class="ws-set-title">${t("Memory and sources")}</div>
				<label><input type="checkbox" checked=${workspace.memoryEnabled !== false} onChange=${(e) => change("memoryEnabled", e.target.checked)} /> ${t("Enable workspace memory")}</label>
				<label><input type="checkbox" checked=${workspace.libraryEnabled !== false} onChange=${(e) => change("libraryEnabled", e.target.checked)} /> ${t("Allow workspace sources")}</label>
			</section>
			<${PersonalFullscreen}
				open=${fullscreen}
				title=${t("Workspace instructions")}
				value=${workspace.instructions || ""}
				caret=${caret.current}
				anchor=${expander.current}
				onInput=${(value) => change("instructions", value)}
				onClose=${() => setFullscreen(false)}
			/>
		</div>`}
		${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
	<//><//>`;
}
