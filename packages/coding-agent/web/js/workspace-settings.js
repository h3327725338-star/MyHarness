import { html, useEffect, useRef, useState, Modal, Overlay } from "./ui.js";
import { api, post, loadWorkspaces } from "./store.js";
import { t } from "./i18n.js";

/** Both General workspace entry points use the same persisted settings editor. */
export function WorkspaceSettings({ id, onClose }) {
	const [workspace, setWorkspace] = useState(null);
	const [sources, setSources] = useState([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const picker = useRef(null);
	const reload = async () => {
		try {
			const data = await api(`/api/workspaces/settings?id=${encodeURIComponent(id)}`);
			setWorkspace(data.workspace); setSources(data.sources);
		} catch (e) { setError(e.message); }
	};
	useEffect(() => { reload(); }, [id]);
	const change = (key, value) => setWorkspace((previous) => ({ ...previous, [key]: value }));
	const save = async () => {
		setBusy(true); setError("");
		try {
			await post("/api/workspaces/settings", { id, name: workspace.name, instructions: workspace.instructions || "", memoryEnabled: workspace.memoryEnabled !== false, libraryEnabled: workspace.libraryEnabled !== false });
			await loadWorkspaces("general"); onClose();
		} catch (e) { setError(e.message); }
		finally { setBusy(false); }
	};
	const upload = async (files) => {
		setBusy(true); setError("");
		try {
			for (const file of files) {
				if (file.size > 32 * 1024 * 1024) throw new Error(t("Files must be 32 MiB or smaller."));
				const data = await new Promise((resolve, reject) => {
					const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file);
				});
				const source = await post("/api/workspaces/sources/upload", { id, name: file.name, data });
				setSources((previous) => [...previous, source]);
			}
		} catch (e) { setError(e.message); }
		finally { setBusy(false); }
	};
	return html`<${Overlay} show><${Modal} title=${t("Workspace settings")} onClose=${onClose} width=${540}
		footer=${html`<button class="btn" onClick=${onClose}>${t("Cancel")}</button><button class="btn primary" disabled=${busy || !workspace?.name?.trim()} onClick=${save}>${t("Save")}</button>`}>
		${!workspace ? html`<div class="dim">${t("Loading…")}</div>` : html`<div class="col">
			<label class="col field-label">${t("Workspace name")}<input class="field" value=${workspace.name} onInput=${(e) => change("name", e.target.value)} /></label>
			<label class="col field-label">${t("Workspace instructions")}<textarea class="field" rows="6" value=${workspace.instructions || ""} onInput=${(e) => change("instructions", e.target.value)} /></label>
			<div class="dim">${t("Workspace instructions apply to the next message in every chat.")}</div>
			<label><input type="checkbox" checked=${workspace.memoryEnabled !== false} onChange=${(e) => change("memoryEnabled", e.target.checked)} /> ${t("Enable workspace memory")}</label>
			<label><input type="checkbox" checked=${workspace.libraryEnabled !== false} onChange=${(e) => change("libraryEnabled", e.target.checked)} /> ${t("Allow workspace sources")}</label>
			<div class="dim">${t("Controls whether chats receive this workspace's source list. Files stay on disk when disabled.")}</div>
			<strong>${t("Workspace sources")}</strong>
			<div class="dim">${t("Shared by all chats in this workspace. Uploads are saved immediately, separately from chat attachments.")}</div>
			${sources.map((source) => html`<div title=${source.path}><strong>${source.name}</strong><div class="dim mono" style=${{ overflowWrap: "anywhere" }}>${source.path}</div></div>`)}
			<input ref=${picker} type="file" multiple hidden onChange=${(e) => { upload([...e.target.files]); e.target.value = ""; }} />
			<button class="btn" disabled=${busy} onClick=${() => picker.current?.click()}>${t("Upload workspace sources")}</button>
		</div>`}
		${error ? html`<div class="notice danger" role="alert">${error}</div>` : null}
	<//><//>`;
}
