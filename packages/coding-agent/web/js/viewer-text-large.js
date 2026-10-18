// Large text files (logs, dumps, data exports) of any size: the server counts the lines once (GET /api/files/text-index)
// and the view reads only the lines on screen, in pages. Search runs on the server and walks the whole file; Go to
// line jumps anywhere. Editing works on a segment: "Edit lines" loads the lines from the top of the view (up to 1000
// lines / 2 MiB) into an editor, and saving replaces exactly those bytes after checking that they did not change.
import { html, Icon, Spinner, useEffect, useMemo, useRef, useState } from "./ui.js";
import { api } from "./store.js";
import { t } from "./i18n.js";
import { useScaledScroll } from "./scaled-scroll.js";

const BLOCK = 500;
const ROW_HEIGHT = 20;
const SEGMENT_LINES = 1000;

export function LargeTextViewer({ path, bar, onSaved }) {
	const scroller = useRef(null);
	const findInput = useRef(null);
	const blocks = useRef(new Map());
	const pending = useRef(new Set());
	const [info, setInfo] = useState(null);
	const [error, setError] = useState("");
	const [, setTick] = useState(0);
	const [goto, setGoto] = useState("");
	const [target, setTarget] = useState(-1);
	const [findOpen, setFindOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [found, setFound] = useState({ matches: [], next: null, index: -1, searching: false, query: "" });
	const [segment, setSegment] = useState(null);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");
	// The line to bring back into view once the list is drawn again (after a save the scroll element is new).
	const [restore, setRestore] = useState(-1);
	const total = info?.lines ?? 0;
	const scroll = useScaledScroll(scroller, Math.max(1, total), ROW_HEIGHT);

	const reset = () => {
		blocks.current = new Map();
		pending.current = new Set();
		setInfo(null);
		setError("");
		setSegment(null);
		setFound({ matches: [], next: null, index: -1, searching: false, query: "" });
		api(`/api/files/text-index?path=${encodeURIComponent(path)}`)
			.then(setInfo)
			.catch((e) => setError(e.message));
	};
	useEffect(reset, [path]);
	const loadBlock = (block) => {
		if (blocks.current.has(block) || pending.current.has(block)) return;
		pending.current.add(block);
		api(`/api/files/text-lines?path=${encodeURIComponent(path)}&start=${block * BLOCK}&count=${BLOCK}`)
			.then((data) => {
				blocks.current.set(block, { lines: data.lines, cut: new Set(data.cut) });
				if (blocks.current.size > 80) for (const key of [...blocks.current.keys()].slice(0, 20)) blocks.current.delete(key);
				setTick((value) => value + 1);
			})
			.catch((e) => setError(e.message))
			.finally(() => pending.current.delete(block));
	};
	useEffect(() => {
		if (!info) return;
		const first = Math.floor(scroll.first / BLOCK);
		const last = Math.floor((scroll.first + scroll.visible) / BLOCK);
		for (let block = first; block <= last; block++) if (block * BLOCK < total) loadBlock(block);
	}, [scroll.first, scroll.visible, info]);
	const lineAt = (line) => {
		const block = blocks.current.get(Math.floor(line / BLOCK));
		if (!block) return null;
		return { text: block.lines[line % BLOCK] ?? "", cut: block.cut.has(line) };
	};
	const show = (line) => {
		setTarget(line);
		scroll.scrollToRow(line, "center");
	};
	const jump = () => {
		const line = Number(goto);
		if (!Number.isFinite(line) || line < 1) return;
		show(Math.min(total, Math.floor(line)) - 1);
	};

	const search = async (more = false) => {
		const text = query.trim();
		if (!text) return;
		const from = more ? found.next : 0;
		if (more && from === null) return;
		setFound((old) => ({ ...(more ? old : { matches: [], next: null, index: -1 }), searching: true, query: text }));
		try {
			const result = await api(`/api/files/text-search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(text)}&from=${from}&limit=500`);
			setFound((old) => {
				const matches = more ? [...old.matches, ...result.matches] : result.matches;
				const index = more ? old.index : matches.findIndex((match) => match.line >= scroll.first);
				const pick = index < 0 ? (matches.length ? 0 : -1) : index;
				if (!more && pick >= 0) show(matches[pick].line);
				return { matches, next: result.next, index: pick, searching: false, query: text };
			});
		} catch (e) {
			setFound((old) => ({ ...old, searching: false }));
			setError(e.message);
		}
	};
	const step = (direction) => {
		if (!found.matches.length) return search(false);
		const index = (found.index + direction + found.matches.length) % found.matches.length;
		if (direction > 0 && index === 0 && found.next !== null) return search(true);
		setFound((old) => ({ ...old, index }));
		show(found.matches[index].line);
	};
	useEffect(() => {
		const onKey = (event) => {
			if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && scroller.current?.closest(".panel-pane:not([hidden])") && !segment) {
				event.preventDefault();
				setFindOpen(true);
				requestAnimationFrame(() => findInput.current?.select());
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [segment]);

	const startEdit = async () => {
		setSaveError("");
		try {
			const data = await api(`/api/files/text-segment?path=${encodeURIComponent(path)}&start=${scroll.first}&count=${SEGMENT_LINES}`);
			setSegment(data);
			setDraft(data.text);
		} catch (e) {
			setSaveError(e.message);
		}
	};
	const cancelEdit = () => {
		if (segment && draft !== segment.text && !window.confirm(t("Discard unsaved changes?"))) return;
		setSegment(null);
		setSaveError("");
	};
	const save = async () => {
		if (!segment || saving) return;
		setSaving(true);
		setSaveError("");
		try {
			await api("/api/files/text-segment", { method: "POST", body: { path, size: segment.size, startByte: segment.startByte, endByte: segment.endByte, original: segment.text, content: draft } });
			const at = segment.start;
			setSegment(null);
			blocks.current = new Map();
			const next = await api(`/api/files/text-index?path=${encodeURIComponent(path)}`);
			setInfo(next);
			setTick((value) => value + 1);
			setRestore(at);
			onSaved?.();
		} catch (e) {
			setSaveError(e.message);
		} finally {
			setSaving(false);
		}
	};
	useEffect(() => {
		if (!segment || draft === segment.text) return undefined;
		const warn = (event) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [segment, draft]);

	useEffect(() => {
		if (restore < 0 || !info || segment) return undefined;
		const frame = requestAnimationFrame(() => {
			scroll.scrollToRow(restore, "start");
			setRestore(-1);
		});
		return () => cancelAnimationFrame(frame);
	}, [restore, info, segment]);
	const numberWidth = Math.max(3, String(total).length);
	const matchLines = useMemo(() => new Set(found.matches.map((match) => match.line)), [found.matches]);
	const current = found.index >= 0 ? found.matches[found.index]?.line : -1;
	const tools = segment
		? html`<span class="file-tools"><span class="hex-dirty">${t("Lines {from}–{to}", { from: segment.start + 1, to: segment.start + segment.lines })}</span>
			<button class="btn sm primary" disabled=${saving || draft === segment.text} onClick=${save}>${saving ? t("Saving…") : t("Save")}</button>
			<button class="btn sm" disabled=${saving} onClick=${cancelEdit}>${t("Cancel")}</button></span>`
		: html`<span class="file-tools">
			<input class="hex-goto" inputmode="numeric" aria-label=${t("Go to line")} placeholder=${t("Line")} title=${t("Go to line")} value=${goto} onInput=${(e) => setGoto(e.target.value.replace(/[^\d]/g, ""))} onKeyDown=${(e) => e.key === "Enter" && jump()} />
			<button class=${`icon-btn sm ${findOpen ? "active" : ""}`} title=${t("Find in file")} aria-label=${t("Find in file")} aria-pressed=${findOpen} onClick=${() => setFindOpen(!findOpen)}><${Icon} name="search" size=${14} /></button>
			<button class="icon-btn sm" title=${t("Edit lines from the top of the view")} aria-label=${t("Edit lines")} disabled=${!info} onClick=${startEdit}><${Icon} name="edit" size=${14} /></button>
		</span>`;
	if (error) return html`${bar(null, reset)}<div class="panel-scroll"><div class="notice danger">${error}</div></div>`;
	if (!info) return html`${bar(null, reset)}<div class="panel-scroll"><div class="empty"><${Spinner} /> ${t("Counting lines…")}</div></div>`;
	if (segment)
		return html`${bar(tools, reset)}
			${saveError ? html`<div class="notice danger">${saveError}</div>` : null}
			<div class="text-editor"><textarea class="field mono" spellcheck="false" value=${draft} onInput=${(e) => setDraft(e.target.value)}
				onKeyDown=${(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } if (e.key === "Escape") { e.preventDefault(); cancelEdit(); } }} /></div>`;
	const rows = [];
	for (let line = scroll.first; line < Math.min(total, scroll.first + scroll.visible); line++) {
		const value = lineAt(line);
		rows.push(html`<div key=${line} class=${`cl lt-row ${line === target ? "target" : ""} ${matchLines.has(line) ? "find-hit" : ""} ${line === current ? "find-current" : ""}`}>
			<span class="cl-no">${line + 1}</span><span class=${`cl-text ${value?.cut ? "cut" : ""}`}>${value === null ? html`<span class="lt-pending" />` : value.text || " "}</span>
		</div>`);
	}
	return html`${bar(tools, reset)}
		${findOpen ? html`<form class="file-find" onSubmit=${(e) => (e.preventDefault(), query.trim() === found.query ? step(1) : search(false))}>
			<input class="field grow" ref=${findInput} aria-label=${t("Find in file")} placeholder=${t("Find in file")} value=${query}
				onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === "Escape") { e.preventDefault(); setFindOpen(false); } if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); step(-1); } }} />
			<span class="dim file-find-count" role="status">${found.searching ? html`<${Spinner} />` : found.query ? (found.matches.length ? `${t("{active} of {matches}", { active: found.index + 1, matches: found.matches.length })}${found.next !== null ? "+" : ""}` : t("No matches")) : ""}</span>
			<button class="icon-btn sm" type="button" title=${t("Previous match")} aria-label=${t("Previous match")} disabled=${!found.matches.length} onClick=${() => step(-1)}><${Icon} name="chevronUp" size=${14} /></button>
			<button class="icon-btn sm" type="button" title=${t("Next match")} aria-label=${t("Next match")} onClick=${() => step(1)}><${Icon} name="chevronDown" size=${14} /></button>
			<button class="icon-btn sm" type="button" title=${t("Close find")} aria-label=${t("Close find")} onClick=${() => setFindOpen(false)}><${Icon} name="x" size=${14} /></button>
		</form>` : null}
		${saveError ? html`<div class="notice danger">${saveError}</div>` : null}
		<div class="lt-scroll code-view" ref=${scroller} tabindex="0" style=${{ "--lt-digits": numberWidth }}>
			<div class="lt-spacer" style=${{ height: `${scroll.height}px` }}>
				<div class="code-lines mono lt-rows" style=${{ transform: `translateY(${scroll.top}px)` }}>${rows}</div>
			</div>
		</div>
		<div class="file-status mono">
			<span>${t("Line {n}", { n: (scroll.first + 1).toLocaleString() })}</span>
			<span class="grow" />
			<span>${t("{lines} lines · {size}", { lines: total.toLocaleString(), size: `${(info.size / 1048576).toFixed(1)} MiB` })}</span>
		</div>`;
}
