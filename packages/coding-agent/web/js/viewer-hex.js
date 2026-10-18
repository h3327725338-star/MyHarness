// Hex view and editor for any file, of any size: rows of bytes with their offsets and printable characters, read in
// pages from GET /api/files/bytes. Editing overwrites bytes in place (the length never changes): click a byte or move
// with the arrow keys and type hex digits; changed bytes stay marked until they are saved or discarded. Saving sends
// each changed run with the bytes it replaces, and the server refuses (409) when the file no longer has them.
import { html, Icon, Spinner, useEffect, useMemo, useRef, useState } from "./ui.js";
import { api } from "./store.js";
import { t } from "./i18n.js";
import { useScaledScroll } from "./scaled-scroll.js";

const PAGE = 64 * 1024;
const ROW_HEIGHT = 20;
const HEX = "0123456789abcdef";

const hex2 = (value) => HEX[value >> 4] + HEX[value & 15];
const printable = (value) => (value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : "·");

function decode(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function encode(bytes) {
	let binary = "";
	for (const value of bytes) binary += String.fromCharCode(value);
	return btoa(binary);
}

/** "0x1f40", "1f40h" or "8000" → a byte offset; null when it is not a number. */
export function parseOffset(text) {
	const value = String(text || "").trim().toLowerCase();
	if (!value) return null;
	if (/^0x[0-9a-f]+$/.test(value)) return Number.parseInt(value.slice(2), 16);
	if (/^[0-9a-f]+h$/.test(value)) return Number.parseInt(value.slice(0, -1), 16);
	if (/^\d+$/.test(value)) return Number(value);
	return null;
}

/** Contiguous runs of edited offsets: [{ offset, length }]. */
export function editRuns(edits) {
	const offsets = [...edits.keys()].sort((a, b) => a - b);
	const runs = [];
	for (const offset of offsets) {
		const last = runs[runs.length - 1];
		if (last && last.offset + last.length === offset) last.length++;
		else runs.push({ offset, length: 1 });
	}
	return runs;
}

export function HexViewer({ path, bar, onSaved }) {
	const scroller = useRef(null);
	const findInput = useRef(null);
	const pages = useRef(new Map());
	const pending = useRef(new Set());
	const [meta, setMeta] = useState(null);
	const [error, setError] = useState("");
	const [, setTick] = useState(0);
	const [cursor, setCursor] = useState(0);
	const [nibble, setNibble] = useState(0);
	const [edits, setEdits] = useState(() => new Map());
	const [history, setHistory] = useState([]);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");
	const [goto, setGoto] = useState("");
	const [findOpen, setFindOpen] = useState(false);
	const [findMode, setFindMode] = useState("text");
	const [findText, setFindText] = useState("");
	const [findState, setFindState] = useState("");
	const [width, setWidth] = useState(16);
	const size = meta?.size ?? 0;
	const rows = Math.max(1, Math.ceil(size / width));
	const scroll = useScaledScroll(scroller, rows, ROW_HEIGHT);

	const load = (page) => {
		if (pages.current.has(page) || pending.current.has(page)) return;
		pending.current.add(page);
		api(`/api/files/bytes?path=${encodeURIComponent(path)}&offset=${page * PAGE}&length=${PAGE}`)
			.then((data) => {
				pages.current.set(page, decode(data.data));
				// Pages far from the view are dropped so a long scroll through a huge file keeps memory flat.
				if (pages.current.size > 64) for (const key of [...pages.current.keys()].slice(0, 16)) pages.current.delete(key);
				setMeta((old) => (old && old.size === data.size ? old : { size: data.size, mtime: data.mtime }));
				setTick((value) => value + 1);
			})
			.catch((e) => setError(e.message))
			.finally(() => pending.current.delete(page));
	};
	const byteAt = (offset) => {
		if (edits.has(offset)) return edits.get(offset).value;
		const page = pages.current.get(Math.floor(offset / PAGE));
		return page ? page[offset % PAGE] : undefined;
	};
	const original = (offset) => pages.current.get(Math.floor(offset / PAGE))?.[offset % PAGE];

	useEffect(() => {
		pages.current = new Map();
		setEdits(new Map());
		setHistory([]);
		setMeta(null);
		setError("");
		api(`/api/files/bytes?path=${encodeURIComponent(path)}&offset=0&length=${PAGE}`)
			.then((data) => {
				pages.current.set(0, decode(data.data));
				setMeta({ size: data.size, mtime: data.mtime });
			})
			.catch((e) => setError(e.message));
	}, [path]);
	useEffect(() => {
		const element = scroller.current;
		if (!element || typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(() => setWidth(element.clientWidth < 560 ? 8 : 16));
		observer.observe(element);
		return () => observer.disconnect();
	}, [meta !== null]);

	const firstOffset = scroll.first * width;
	const lastOffset = Math.min(size, (scroll.first + scroll.visible) * width);
	useEffect(() => {
		if (!meta) return;
		for (let page = Math.floor(firstOffset / PAGE); page <= Math.floor(Math.max(firstOffset, lastOffset - 1) / PAGE); page++) load(page);
	}, [firstOffset, lastOffset, meta]);

	const moveTo = (offset, keepNibble = false) => {
		const next = Math.max(0, Math.min(size - 1, offset));
		setCursor(next);
		if (!keepNibble) setNibble(0);
		scroll.scrollToRow(Math.floor(next / width), "nearest");
	};
	const writeNibble = (digit) => {
		const current = byteAt(cursor);
		if (current === undefined || saving) return;
		const value = nibble === 0 ? (digit << 4) | (current & 15) : (current & 0xf0) | digit;
		// Each edit keeps the byte it replaces, so saving never depends on a page that was dropped from memory meanwhile.
		const before = edits.has(cursor) ? edits.get(cursor).before : original(cursor);
		setHistory((old) => [...old.slice(-999), { offset: cursor, had: edits.has(cursor), previous: edits.get(cursor) }]);
		setEdits((old) => {
			const next = new Map(old);
			if (value === before) next.delete(cursor);
			else next.set(cursor, { value, before });
			return next;
		});
		if (nibble === 0) setNibble(1);
		else moveTo(cursor + 1);
	};
	const undo = () => {
		const last = history[history.length - 1];
		if (!last) return;
		setHistory((old) => old.slice(0, -1));
		setEdits((old) => {
			const next = new Map(old);
			if (last.had) next.set(last.offset, last.previous);
			else next.delete(last.offset);
			return next;
		});
		moveTo(last.offset);
	};
	const onKeyDown = (event) => {
		if (!meta || !size) return;
		const key = event.key;
		const page = Math.max(1, scroll.visible - 2) * width;
		const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -width, ArrowDown: width, PageUp: -page, PageDown: page };
		if (key in moves) {
			event.preventDefault();
			moveTo(cursor + moves[key]);
		} else if (key === "Home") {
			event.preventDefault();
			moveTo(event.ctrlKey ? 0 : cursor - (cursor % width));
		} else if (key === "End") {
			event.preventDefault();
			moveTo(event.ctrlKey ? size - 1 : Math.min(size - 1, cursor - (cursor % width) + width - 1));
		} else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
			event.preventDefault();
			undo();
		} else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "s") {
			event.preventDefault();
			save();
		} else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "f") {
			event.preventDefault();
			setFindOpen(true);
			requestAnimationFrame(() => findInput.current?.select());
		} else if (!event.ctrlKey && !event.metaKey && !event.altKey && /^[0-9a-f]$/i.test(key)) {
			event.preventDefault();
			writeNibble(Number.parseInt(key, 16));
		}
	};

	const save = async () => {
		if (!edits.size || saving || !meta) return;
		setSaving(true);
		setSaveError("");
		try {
			const payload = editRuns(edits).map((run) => {
				const before = new Uint8Array(run.length);
				const after = new Uint8Array(run.length);
				for (let index = 0; index < run.length; index++) {
					before[index] = edits.get(run.offset + index).before;
					after[index] = edits.get(run.offset + index).value;
				}
				return { offset: run.offset, original: encode(before), data: encode(after) };
			});
			const result = await api("/api/files/bytes", { method: "POST", body: { path, size: meta.size, edits: payload } });
			for (const [offset, edit] of edits) {
				const page = pages.current.get(Math.floor(offset / PAGE));
				if (page) page[offset % PAGE] = edit.value;
			}
			setEdits(new Map());
			setHistory([]);
			setMeta({ size: result.size, mtime: result.mtime });
			onSaved?.();
		} catch (e) {
			setSaveError(e.message);
		} finally {
			setSaving(false);
		}
	};
	const discard = () => {
		if (edits.size && !window.confirm(t("Discard unsaved changes?"))) return;
		setEdits(new Map());
		setHistory([]);
		setSaveError("");
	};
	const reload = () => {
		pages.current = new Map();
		setEdits(new Map());
		setHistory([]);
		setSaveError("");
		api(`/api/files/bytes?path=${encodeURIComponent(path)}&offset=0&length=${PAGE}`)
			.then((data) => {
				pages.current.set(0, decode(data.data));
				setMeta({ size: data.size, mtime: data.mtime });
				setTick((value) => value + 1);
			})
			.catch((e) => setError(e.message));
	};
	useEffect(() => {
		if (!edits.size) return undefined;
		const warn = (event) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [edits.size > 0]);

	const find = async (backwards = false) => {
		const query = findText.trim();
		if (!query) return;
		const pattern = findMode === "hex" ? `hex=${encodeURIComponent(query.replace(/\s+/g, ""))}` : `text=${encodeURIComponent(query)}`;
		if (findMode === "hex" && !/^([0-9a-f]{2})+$/i.test(query.replace(/\s+/g, ""))) {
			setFindState(t("Type whole bytes, for example 4d 5a 90"));
			return;
		}
		setFindState(t("Searching…"));
		try {
			const from = backwards ? cursor : cursor + 1;
			const result = await api(`/api/files/bytes-search?path=${encodeURIComponent(path)}&${pattern}&from=${from}${backwards ? "&dir=back" : ""}`);
			if (result.offset < 0) setFindState(t("No matches"));
			else {
				setFindState(t("At {offset}", { offset: `0x${result.offset.toString(16)}` }));
				moveTo(result.offset);
				scroll.scrollToRow(Math.floor(result.offset / width), "center");
			}
		} catch (e) {
			setFindState(e.message);
		}
	};
	const jump = () => {
		const offset = parseOffset(goto);
		if (offset === null || offset >= size) return;
		moveTo(offset);
		scroll.scrollToRow(Math.floor(offset / width), "center");
		scroller.current?.focus();
	};

	const digits = Math.max(8, size.toString(16).length);
	const rowsOnScreen = useMemo(() => {
		const list = [];
		for (let row = scroll.first; row < Math.min(rows, scroll.first + scroll.visible); row++) list.push(row);
		return list;
	}, [scroll.first, scroll.visible, rows]);
	const tools = html`<span class="file-tools hex-tools">
		<input class="hex-goto" aria-label=${t("Go to offset")} placeholder=${t("Offset")} title=${t("Go to offset (decimal, 0x… or …h)")} value=${goto} onInput=${(e) => setGoto(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && jump()} />
		<button class=${`icon-btn sm ${findOpen ? "active" : ""}`} title=${t("Find bytes or text")} aria-label=${t("Find bytes or text")} aria-pressed=${findOpen} onClick=${() => setFindOpen(!findOpen)}><${Icon} name="search" size=${14} /></button>
		${edits.size
			? html`<span class="file-tools-sep" /><span class="hex-dirty">${t("{n} changed", { n: edits.size })}</span>
				<button class="btn sm primary" disabled=${saving} onClick=${save}>${saving ? t("Saving…") : t("Save")}</button>
				<button class="btn sm" disabled=${saving} onClick=${discard}>${t("Discard")}</button>`
			: null}
	</span>`;
	if (error) return html`${bar(null, reload)}<div class="panel-scroll"><div class="notice danger">${error}</div></div>`;
	if (!meta) return html`${bar(null, reload)}<div class="panel-scroll"><div class="empty"><${Spinner} /></div></div>`;
	return html`${bar(tools, reload)}
		${findOpen ? html`<form class="file-find" onSubmit=${(e) => (e.preventDefault(), find())}>
			<select class="field sm hex-find-mode" aria-label=${t("Search for")} value=${findMode} onChange=${(e) => setFindMode(e.target.value)}>
				<option value="text">${t("Text")}</option><option value="hex">${t("Hex bytes")}</option>
			</select>
			<input class="field grow mono" ref=${findInput} aria-label=${t("Find bytes or text")} placeholder=${findMode === "hex" ? "4d 5a 90 00" : t("Text to find")} value=${findText}
				onInput=${(e) => setFindText(e.target.value)} onKeyDown=${(e) => { if (e.key === "Escape") { e.preventDefault(); setFindOpen(false); } if (e.key === "Enter") { e.preventDefault(); find(e.shiftKey); } }} />
			<span class="dim file-find-count" role="status">${findState}</span>
			<button class="icon-btn sm" type="button" title=${t("Previous match")} aria-label=${t("Previous match")} onClick=${() => find(true)}><${Icon} name="chevronUp" size=${14} /></button>
			<button class="icon-btn sm" type="button" title=${t("Next match")} aria-label=${t("Next match")} onClick=${() => find(false)}><${Icon} name="chevronDown" size=${14} /></button>
			<button class="icon-btn sm" type="button" title=${t("Close find")} aria-label=${t("Close find")} onClick=${() => setFindOpen(false)}><${Icon} name="x" size=${14} /></button>
		</form>` : null}
		${saveError ? html`<div class="notice danger">${saveError}</div>` : null}
		<div class="hex-head mono" aria-hidden="true" style=${{ "--hex-digits": digits }}>
			<span class="hex-off">${t("Offset")}</span>
			<span class="hex-bytes" style=${{ "--hex-cols": width }}>${Array.from({ length: width }, (_, i) => html`<span class=${`hex-b ${cursor % width === i ? "col" : ""}`}>${hex2(i)}</span>`)}</span>
			<span class="hex-ascii">${t("Text")}</span>
		</div>
		<div class="hex-scroll mono" ref=${scroller} tabindex="0" role="grid" aria-label=${t("Bytes of {name}", { name: path })} onKeyDown=${onKeyDown} style=${{ "--hex-digits": digits }}>
			<div class="hex-spacer" style=${{ height: `${scroll.height}px` }}>
				<div class="hex-rows" style=${{ transform: `translateY(${scroll.top}px)` }}>
					${rowsOnScreen.map((row) => {
						const base = row * width;
						const cells = [];
						const text = [];
						for (let column = 0; column < width; column++) {
							const offset = base + column;
							if (offset >= size) break;
							const value = byteAt(offset);
							const changed = edits.has(offset);
							const at = offset === cursor;
							cells.push(html`<span class=${`hex-b ${changed ? "changed" : ""} ${at ? "cursor" : ""} ${at && nibble ? "low" : ""}`} onMouseDown=${(e) => (e.preventDefault(), scroller.current?.focus(), moveTo(offset))}>${value === undefined ? "··" : hex2(value)}</span>`);
							text.push(html`<span class=${`hex-c ${changed ? "changed" : ""} ${at ? "cursor" : ""}`} onMouseDown=${(e) => (e.preventDefault(), scroller.current?.focus(), moveTo(offset))}>${value === undefined ? " " : printable(value)}</span>`);
						}
						return html`<div class="hex-row" key=${row}>
							<span class="hex-off">${base.toString(16).padStart(digits, "0")}</span>
							<span class="hex-bytes" style=${{ "--hex-cols": width }}>${cells}</span>
							<span class="hex-ascii">${text}</span>
						</div>`;
					})}
				</div>
			</div>
		</div>
		<div class="file-status mono">
			<span>${t("Offset")} 0x${cursor.toString(16)} (${cursor})</span>
			<span>${byteAt(cursor) === undefined ? "" : `${hex2(byteAt(cursor))} · ${byteAt(cursor)} · ${printable(byteAt(cursor))}`}</span>
			<span class="grow" />
			<span>${t("{size} bytes", { size: size.toLocaleString() })}</span>
		</div>`;
}
