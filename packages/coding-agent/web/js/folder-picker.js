// Folder picker for "Add workspace". It behaves like the Windows folder dialog: a Quick access / This PC pane, an address
// bar with clickable path segments, back / forward / up, a list you can walk with the keyboard, and "New folder".
import { html, useCallback, useEffect, useMemo, useRef, useState, Icon, Modal, Spinner } from "./ui.js";
import { api, post, state, useStore } from "./store.js";
import { t } from "./i18n.js";

const SEP = /[\\/]+/;

/** Split "C:\\a\\b" into clickable segments with the path each one leads to. */
function crumbs(path) {
	if (!path) return [];
	const parts = path.split(SEP).filter(Boolean);
	const out = [];
	let acc = "";
	parts.forEach((part, index) => {
		acc = index === 0 ? (/^[A-Za-z]:$/.test(part) ? `${part}\\` : part) : `${acc.replace(/[\\/]+$/, "")}\\${part}`;
		out.push({ name: part, path: acc });
	});
	return out;
}

const samePath = (a, b) => String(a || "").replace(/[\\/]+$/, "").toLowerCase() === String(b || "").replace(/[\\/]+$/, "").toLowerCase();

function PlaceButton({ icon, label, path, current, onGo, title }) {
	return html`<button class=${`fp-place ${current ? "on" : ""}`} title=${title || path} onClick=${() => onGo(path)}><${Icon} name=${icon} size=${15} /><span class="truncate">${label}</span></button>`;
}

export function FolderPicker({ onClose, onPick, title, subtitle, confirmLabel, initialPath }) {
	const workspaces = useStore((s) => s.workspaces.list);
	const [places, setPlaces] = useState(null);
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [selected, setSelected] = useState(null);
	const [filter, setFilter] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const [editing, setEditing] = useState(false);
	const [address, setAddress] = useState("");
	const [creating, setCreating] = useState(null);
	const [nav, setNav] = useState({ stack: [], index: -1 });
	const listRef = useRef(null);
	const pathNow = data?.path ?? "";

	const load = useCallback(async (target, mode = "push") => {
		setLoading(true);
		try {
			const next = await api(`/api/fs/browse?path=${encodeURIComponent(target || "")}`, { slot: "" });
			setData(next);
			setError("");
			setSelected(null);
			setFilter("");
			setEditing(false);
			setNav((current) => {
				if (mode === "none") return current;
				if (mode === "replace") return { stack: [...current.stack.slice(0, Math.max(0, current.index)), next.path], index: Math.max(0, current.index) };
				const stack = [...current.stack.slice(0, current.index + 1), next.path];
				return { stack, index: stack.length - 1 };
			});
			return true;
		} catch (e) {
			setError(e.message);
			return false;
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		api("/api/fs/places", { slot: "" })
			.then((result) => !cancelled && setPlaces(result))
			.catch(() => !cancelled && setPlaces({ places: [], drives: [], current: "" }));
		(async () => {
			const start = initialPath || state.snap?.cwd || "";
			if (!(await load(start))) await load("");
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const goBack = () => nav.index > 0 && (setNav({ ...nav, index: nav.index - 1 }), load(nav.stack[nav.index - 1], "none"));
	const goForward = () => nav.index < nav.stack.length - 1 && (setNav({ ...nav, index: nav.index + 1 }), load(nav.stack[nav.index + 1], "none"));
	const goUp = () => data && data.path !== "" && load(data.parent ?? "");

	const rows = useMemo(() => {
		const q = filter.trim().toLowerCase();
		return (data?.dirs || []).filter((dir) => (q ? dir.name.toLowerCase().includes(q) : showHidden || !dir.hidden));
	}, [data, filter, showHidden]);

	useEffect(() => {
		if (selected) listRef.current?.querySelector(".fp-row.sel")?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	const target = selected || (pathNow && pathNow !== "" ? pathNow : "");
	const confirm = () => target && onPick(target);
	const move = (delta) => {
		if (!rows.length) return;
		const index = rows.findIndex((row) => row.path === selected);
		const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + delta));
		setSelected(rows[next].path);
	};
	const onListKey = (e) => {
		if (e.key === "ArrowDown") return e.preventDefault(), move(1);
		if (e.key === "ArrowUp") return e.preventDefault(), move(-1);
		if (e.key === "Home") return e.preventDefault(), rows[0] && setSelected(rows[0].path);
		if (e.key === "End") return e.preventDefault(), rows.length && setSelected(rows[rows.length - 1].path);
		if (e.key === "Enter") {
			e.preventDefault();
			if (selected) load(selected);
			else confirm();
			return;
		}
		if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) return e.preventDefault(), goUp();
		if (e.altKey && e.key === "ArrowLeft") return e.preventDefault(), goBack();
		if (e.altKey && e.key === "ArrowRight") return e.preventDefault(), goForward();
		if (e.key === "F5") return e.preventDefault(), load(pathNow, "none");
		if ((e.ctrlKey && e.key.toLowerCase() === "l") || e.key === "F4") {
			e.preventDefault();
			setAddress(pathNow);
			setEditing(true);
			return;
		}
		// Type a few letters to jump to a folder, like in Explorer.
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const now = Date.now();
			const typed = (listRef.current.__typed && now - listRef.current.__typedAt < 800 ? listRef.current.__typed : "") + e.key.toLowerCase();
			listRef.current.__typed = typed;
			listRef.current.__typedAt = now;
			const hit = rows.find((row) => row.name.toLowerCase().startsWith(typed));
			if (hit) setSelected(hit.path);
		}
	};

	const submitAddress = async () => {
		const value = address.trim().replace(/^"(.*)"$/, "$1");
		if (!value) return setEditing(false);
		if (!(await load(value))) setEditing(true);
	};

	const createFolder = async () => {
		const name = creating?.name?.trim();
		if (!name || !pathNow) return setCreating(null);
		try {
			const result = await post("/api/fs/mkdir", { parent: pathNow, name }, "");
			setCreating(null);
			await load(pathNow, "none");
			setSelected(result.path);
		} catch (e) {
			setCreating({ name, error: e.message });
		}
	};

	const segments = crumbs(pathNow);
	const atThisPc = pathNow === "" && data;
	return html`<${Modal} title=${title} subtitle=${subtitle} onClose=${onClose} width=${780} class="fp-modal"
		footer=${html`<div class="fp-target grow truncate" title=${target}><span class="dim">${t("Folder")}:</span> <span class="mono">${target || t("Choose a folder")}</span></div>
			<button class="btn" onClick=${onClose}>${t("Cancel")}</button>
			<button class="btn primary" disabled=${!target} onClick=${confirm}>${confirmLabel}</button>`}>
		<div class="fp">
			<div class="fp-bar">
				<button class="icon-btn sm" title=${`${t("Back")} (Alt+←)`} aria-label=${t("Back")} disabled=${nav.index <= 0} onClick=${goBack}><${Icon} name="arrowLeft" size=${15} /></button>
				<button class="icon-btn sm" title=${`${t("Forward")} (Alt+→)`} aria-label=${t("Forward")} disabled=${nav.index >= nav.stack.length - 1} onClick=${goForward}><${Icon} name="arrowRight" size=${15} /></button>
				<button class="icon-btn sm" title=${`${t("Up one level")} (Alt+↑)`} aria-label=${t("Up one level")} disabled=${!data || data.path === ""} onClick=${goUp}><${Icon} name="arrowUp" size=${15} /></button>
				${editing
					? html`<input class="field mono fp-address" autofocus value=${address} onInput=${(e) => setAddress(e.target.value)} onBlur=${() => setEditing(false)}
						onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" ? submitAddress() : e.key === "Escape" && (e.preventDefault(), setEditing(false)))} aria-label=${t("Folder path")} />`
					: html`<div class="fp-address crumbs" role="navigation" aria-label=${t("Folder path")} onClick=${(e) => { if (e.target === e.currentTarget) { setAddress(pathNow); setEditing(true); } }}>
						<button class="crumb" onClick=${() => load("")}><${Icon} name="desktop" size=${14} /><span>${t("This PC")}</span></button>
						${segments.map((seg) => html`<${Icon} name="chevronRight" size=${12} class="c-dim" /><button class="crumb" key=${seg.path} onClick=${() => load(seg.path)}><span class="truncate">${seg.name}</span></button>`)}
					</div>`}
				<button class="icon-btn sm" title=${`${t("Refresh")} (F5)`} aria-label=${t("Refresh")} onClick=${() => load(pathNow, "none")}><${Icon} name="refresh" size=${15} /></button>
				<div class="fp-search"><${Icon} name="search" size=${14} /><input placeholder=${t("Filter folders")} value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label=${t("Filter folders")} /></div>
			</div>
			<div class="fp-main">
				<nav class="fp-nav" aria-label=${t("Places")}>
					<div class="fp-group">${t("Quick access")}</div>
					${(places?.places || []).map((place) => html`<${PlaceButton} key=${place.id} icon=${place.id === "home" ? "home" : place.id === "desktop" ? "desktop" : place.id === "downloads" ? "download" : "folder"} label=${place.id === "home" ? place.name : t(place.name)} path=${place.path} current=${samePath(place.path, pathNow)} onGo=${load} />`)}
					<div class="fp-group">${t("This PC")}</div>
					${(places?.drives || []).map((drive) => html`<${PlaceButton} key=${drive.id} icon="drive" label=${drive.name} path=${drive.path} current=${samePath(drive.path, pathNow)} onGo=${load} />`)}
					${workspaces.length ? html`<div class="fp-group">${t("Workspaces")}</div>${workspaces.map((w) => html`<${PlaceButton} key=${w.id} icon="folderOpen" label=${w.name} path=${w.rootPath} current=${samePath(w.rootPath, pathNow)} onGo=${load} />`)}` : null}
				</nav>
				<div class="fp-listwrap">
					${error ? html`<div class="notice danger">${error}</div>` : null}
					<div class="fp-list" ref=${listRef} tabindex="0" role="listbox" aria-label=${t("Folders")} onKeyDown=${onListKey} autofocus>
						<div class="fp-head"><span>${t("Name")}</span><span class="fp-flag" /></div>
						${creating ? html`<div class="fp-row creating"><${Icon} name="folderPlus" size=${16} /><input class="field" autofocus placeholder=${t("New folder name")} value=${creating.name} onInput=${(e) => setCreating({ name: e.target.value })}
							onKeyDown=${(e) => (e.stopPropagation(), e.key === "Enter" ? createFolder() : e.key === "Escape" && setCreating(null))} onBlur=${() => !creating.error && setCreating(null)} />${creating.error ? html`<span class="c-danger">${creating.error}</span>` : null}</div>` : null}
						${loading && !data ? html`<div class="empty"><${Spinner} /></div>` : null}
						${rows.map((dir) => html`<div key=${dir.path} role="option" aria-selected=${selected === dir.path} class=${`fp-row ${selected === dir.path ? "sel" : ""} ${dir.hidden ? "hidden-dir" : ""}`}
							onClick=${() => setSelected(dir.path)} onDblClick=${() => load(dir.path)}>
							<${Icon} name=${atThisPc ? "drive" : "folder"} size=${16} /><span class="truncate grow">${dir.name}</span>
							${dir.workspace ? html`<span class="badge accent">${t("Workspace")}</span>` : null}
							<button class="icon-btn sm fp-open" tabindex="-1" title=${t("Open")} aria-label=${t("Open")} onClick=${(e) => (e.stopPropagation(), load(dir.path))}><${Icon} name="chevronRight" size=${14} /></button>
						</div>`)}
						${data && !rows.length && !loading ? html`<div class="empty">${filter ? t("No folders match.") : t("No sub-folders")}</div>` : null}
					</div>
					<div class="fp-tools">
						<button class="btn sm ghost" disabled=${!pathNow} onClick=${() => setCreating({ name: "" })}><${Icon} name="folderPlus" size=${14} />${t("New folder")}</button>
						<label class="row dim fp-hidden"><input type="checkbox" checked=${showHidden} onChange=${(e) => setShowHidden(e.target.checked)} />${t("Show hidden folders")}</label>
						<span class="grow" />
						<span class="dim">${t("{n} folders", { n: rows.length })}</span>
					</div>
				</div>
			</div>
		</div>
	<//>`;
}
