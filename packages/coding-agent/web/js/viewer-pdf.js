// PDF tab of the workspace: pdf.js (served from the runtime dependency under /vendor-pdf/) with its own viewer layer for
// pages, text selection, links and search. Everything the user controls sits in the one file bar above the pages: the
// page rail toggle, page number, zoom (buttons, presets, Ctrl+wheel), fit width / fit page, rotation and find. The rail
// on the left shows page thumbnails or the outline; it can be dragged wider or narrower and folded away. The original
// file is never written.
import { html, Icon, Menu, MenuItem, MenuSep, Resizer, Spinner, useEffect, useRef, useState } from "./ui.js";
import { t } from "./i18n.js";

const BASE = "/vendor-pdf/";
let pdfjs = null;

/** pdf.js and its viewer layer, loaded once per page on the first PDF tab. */
function loadPdfjs() {
	if (!pdfjs) {
		pdfjs = (async () => {
			if (!document.querySelector("style[data-pdfjs]")) {
				// pdf.js's stylesheet is written for its own full-page viewer: it also styles names this app uses
				// (`.sidebar`, `.dialog`, variables on `:root`), which repainted the app's sidebar for good once a PDF had
				// opened. Scoped to the page stage it styles the rendered pages and nothing else.
				const css = await (await fetch(`${BASE}web/pdf_viewer.css`)).text();
				const style = document.createElement("style");
				style.dataset.pdfjs = "";
				style.textContent = `@scope (.pdf-stage) {\n${css
					.replace(/:root\b/gu, ":scope")
					.replace(/url\((["']?)(?![a-z]+:|#|\/)/giu, `url($1${BASE}web/`)}\n}`;
				document.head.append(style);
			}
			const lib = await import("/vendor-pdf/build/pdf.min.mjs");
			// The viewer layer finds the library through this global.
			globalThis.pdfjsLib = lib;
			lib.GlobalWorkerOptions.workerSrc = `${BASE}build/pdf.worker.min.mjs`;
			const viewer = await import("/vendor-pdf/web/pdf_viewer.mjs");
			return { lib, viewer };
		})().catch((error) => {
			pdfjs = null;
			throw error;
		});
	}
	return pdfjs;
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const RAIL_KEY = "myharness.pdfRail";

function savedRail() {
	try {
		const value = JSON.parse(localStorage.getItem(RAIL_KEY) || "null");
		if (value && typeof value === "object") return { open: value.open !== false, width: Math.min(360, Math.max(110, Number(value.width) || 164)) };
	} catch {
		// Storage can be unavailable; the rail then starts with its defaults.
	}
	return { open: true, width: 164 };
}

function saveRail(value) {
	try {
		localStorage.setItem(RAIL_KEY, JSON.stringify(value));
	} catch {
		// Not remembered; nothing else depends on it.
	}
}

/** One lazily drawn page thumbnail; its picture is kept as a compressed image, not as a live canvas. */
function Thumb({ doc, number, current, onPick, root }) {
	const ref = useRef(null);
	const [src, setSrc] = useState(null);
	useEffect(() => {
		const element = ref.current;
		if (!element || !doc) return undefined;
		let cancelled = false;
		let url = null;
		const draw = async () => {
			const page = await doc.getPage(number);
			const base = page.getViewport({ scale: 1 });
			const scale = (220 * Math.min(2, window.devicePixelRatio || 1)) / base.width;
			const viewport = page.getViewport({ scale });
			const canvas = document.createElement("canvas");
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
			if (cancelled) return;
			canvas.toBlob((blob) => {
				if (cancelled || !blob) return;
				url = URL.createObjectURL(blob);
				setSrc(url);
			}, "image/png");
		};
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				observer.disconnect();
				draw().catch(() => undefined);
			},
			{ root: root.current, rootMargin: "300px 0px" },
		);
		observer.observe(element);
		return () => {
			cancelled = true;
			observer.disconnect();
			if (url) URL.revokeObjectURL(url);
		};
	}, [doc, number]);
	useEffect(() => {
		if (current) ref.current?.scrollIntoView({ block: "nearest" });
	}, [current]);
	return html`<button ref=${ref} class=${`pdf-thumb ${current ? "current" : ""}`} aria-current=${current ? "page" : undefined} aria-label=${t("Page {n}", { n: number })} onClick=${() => onPick(number)}>
		<span class="pdf-thumb-page">${src ? html`<img src=${src} alt="" />` : html`<span class="pdf-thumb-blank" />`}</span>
		<span class="pdf-thumb-no">${number}</span>
	</button>`;
}

function OutlineItems({ items, onGo, depth = 0 }) {
	return html`<ul class="pdf-outline-list" role=${depth ? "group" : "tree"}>${items.map(
		(item, index) => html`<li key=${index} role="treeitem">
			<button class="pdf-outline-item truncate" style=${{ paddingLeft: `${8 + depth * 12}px` }} title=${item.title} onClick=${() => onGo(item.dest)}>${item.title}</button>
			${item.items?.length ? html`<${OutlineItems} items=${item.items} onGo=${onGo} depth=${depth + 1} />` : null}
		</li>`,
	)}</ul>`;
}

/**
 * `bar(tools)` renders the file bar of the tab with the PDF controls inside it, so the tab has a single toolbar.
 * `fallback(message)` renders the generic fallback (download / open outside) in the tab when pdf.js cannot open the file.
 */
export function PdfViewer({ url, path, bar, fallback }) {
	const stage = useRef(null);
	const inner = useRef(null);
	const railScroll = useRef(null);
	const findInput = useRef(null);
	const engine = useRef(null);
	const [doc, setDoc] = useState(null);
	const [error, setError] = useState("");
	const [pages, setPages] = useState(0);
	const [page, setPage] = useState(1);
	const [pageText, setPageText] = useState("1");
	const [scale, setScale] = useState(1);
	const [preset, setPreset] = useState("page-width");
	const [rail, setRail] = useState(savedRail);
	const [railTab, setRailTab] = useState("pages");
	const [outline, setOutline] = useState(null);
	const [findOpen, setFindOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [matches, setMatches] = useState({ current: 0, total: 0 });

	useEffect(() => {
		let cancelled = false;
		let task = null;
		let viewerObj = null;
		(async () => {
			const { lib, viewer } = await loadPdfjs();
			if (cancelled) return;
			const eventBus = new viewer.EventBus();
			const linkService = new viewer.PDFLinkService({ eventBus, externalLinkTarget: 2 });
			const findController = new viewer.PDFFindController({ eventBus, linkService });
			viewerObj = new viewer.PDFViewer({
				container: stage.current,
				viewer: inner.current,
				eventBus,
				linkService,
				findController,
				textLayerMode: 1,
			});
			linkService.setViewer(viewerObj);
			eventBus.on("pagesinit", () => {
				viewerObj.currentScaleValue = "page-width";
			});
			eventBus.on("pagechanging", (event) => {
				setPage(event.pageNumber);
				setPageText(String(event.pageNumber));
			});
			eventBus.on("scalechanging", (event) => {
				setScale(event.scale);
				setPreset(typeof event.presetValue === "string" ? event.presetValue : "");
			});
			eventBus.on("updatefindmatchescount", ({ matchesCount }) => setMatches(matchesCount || { current: 0, total: 0 }));
			eventBus.on("updatefindcontrolstate", ({ matchesCount }) => matchesCount && setMatches(matchesCount));
			engine.current = { lib, eventBus, linkService, viewer: viewerObj };
			task = lib.getDocument({
				url,
				cMapUrl: `${BASE}cmaps/`,
				cMapPacked: true,
				standardFontDataUrl: `${BASE}standard_fonts/`,
				wasmUrl: `${BASE}wasm/`,
				iccUrl: `${BASE}iccs/`,
				isEvalSupported: false,
				disableAutoFetch: true,
			});
			const loaded = await task.promise;
			if (cancelled) {
				loaded.destroy();
				return;
			}
			viewerObj.setDocument(loaded);
			linkService.setDocument(loaded);
			setDoc(loaded);
			setPages(loaded.numPages);
			loaded.getOutline().then((items) => !cancelled && setOutline(items?.length ? items : null)).catch(() => undefined);
		})().catch((e) => {
			if (!cancelled) setError(e?.message || String(e));
		});
		return () => {
			cancelled = true;
			engine.current = null;
			try {
				viewerObj?.setDocument(null);
			} catch {
				// Tearing down a viewer that never got a document.
			}
			task?.destroy();
		};
	}, [url]);

	// A fitted zoom (width, page, auto) follows the room the pages get: the panel slides in, is dragged wider, the rail
	// folds away or collaboration mode gives the tab the whole window.
	useEffect(() => {
		const element = stage.current;
		if (!element || typeof ResizeObserver === "undefined") return undefined;
		let frame = 0;
		let last = element.clientWidth;
		const observer = new ResizeObserver(() => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const viewerObj = engine.current?.viewer;
				const width = element.clientWidth;
				if (!viewerObj?.pdfDocument || width < 1 || Math.abs(width - last) < 1) return;
				last = width;
				const value = viewerObj.currentScaleValue;
				if (typeof value === "string" && /^(page-width|page-fit|auto)$/.test(value)) viewerObj.currentScaleValue = value;
			});
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, []);

	// Ctrl+wheel (and a touchpad pinch, which arrives as one) zooms the pages instead of the whole page.
	useEffect(() => {
		const element = stage.current;
		if (!element) return undefined;
		const onWheel = (event) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const viewerObj = engine.current?.viewer;
			if (!viewerObj?.pdfDocument) return;
			const factor = Math.exp(-event.deltaY * (event.deltaMode ? 0.05 : 0.0025));
			viewerObj.currentScale = Math.min(5, Math.max(0.25, viewerObj.currentScale * factor));
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, []);

	const find = (type, previous = false, text = query) => {
		engine.current?.eventBus.dispatch("find", { source: null, type, query: text, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
	};
	useEffect(() => {
		if (!findOpen) {
			if (engine.current) find("", false, "");
			return undefined;
		}
		const frame = requestAnimationFrame(() => findInput.current?.select());
		return () => cancelAnimationFrame(frame);
	}, [findOpen]);
	useEffect(() => {
		const onKey = (event) => {
			if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && stage.current?.closest(".panel-pane:not([hidden])") && !document.querySelector(".palette, [aria-modal='true']")) {
				event.preventDefault();
				setFindOpen(true);
				requestAnimationFrame(() => findInput.current?.select());
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const setZoom = (value) => {
		const viewerObj = engine.current?.viewer;
		if (!viewerObj?.pdfDocument) return;
		if (typeof value === "string") viewerObj.currentScaleValue = value;
		else viewerObj.currentScale = value;
	};
	const stepZoom = (direction) => {
		const current = engine.current?.viewer?.currentScale || scale;
		const next = direction > 0 ? ZOOM_STEPS.find((step) => step > current + 0.001) : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001);
		if (next) setZoom(next);
	};
	const goTo = (number) => {
		const viewerObj = engine.current?.viewer;
		if (!viewerObj?.pdfDocument) return;
		const target = Math.min(pages, Math.max(1, Math.round(number)));
		viewerObj.currentPageNumber = target;
		setPageText(String(target));
	};
	const rotate = () => {
		const viewerObj = engine.current?.viewer;
		if (viewerObj?.pdfDocument) viewerObj.pagesRotation = (viewerObj.pagesRotation + 90) % 360;
	};
	const updateRail = (next) => {
		setRail(next);
		saveRail(next);
	};
	const ready = !!doc;
	const zoomLabel = `${Math.round(scale * 100)}%`;
	const tools = html`<span class="file-tools pdf-tools">
		<button class=${`icon-btn sm ${rail.open ? "active" : ""}`} aria-pressed=${rail.open} title=${t("Pages and outline")} aria-label=${t("Pages and outline")} onClick=${() => updateRail({ ...rail, open: !rail.open })}><${Icon} name="columns" size=${14} /></button>
		<span class="file-tools-sep" />
		<span class="pdf-page" title=${t("Page")}>
			<input class="pdf-page-input" inputmode="numeric" aria-label=${t("Page")} value=${pageText} disabled=${!ready}
				onInput=${(event) => setPageText(event.target.value.replace(/[^\d]/g, ""))}
				onKeyDown=${(event) => { if (event.key === "Enter") goTo(Number(pageText) || page); if (event.key === "Escape") setPageText(String(page)); }}
				onBlur=${() => setPageText(String(page))} />
			<span class="dim">/ ${pages || "–"}</span>
		</span>
		<span class="file-tools-sep" />
		<button class="icon-btn sm" title=${t("Zoom out")} aria-label=${t("Zoom out")} disabled=${!ready} onClick=${() => stepZoom(-1)}><${Icon} name="zoomOut" size=${14} /></button>
		<${Menu} align="start" trigger=${({ toggle }) => html`<button class="btn sm pdf-zoom" title=${t("Zoom")} aria-label=${t("Zoom")} disabled=${!ready} onClick=${toggle}>${zoomLabel}<${Icon} name="chevronDown" size=${12} /></button>`}>
			${(close) => html`
				<${MenuItem} label=${t("Fit width")} active=${preset === "page-width"} onClick=${() => (setZoom("page-width"), close())} />
				<${MenuItem} label=${t("Fit page")} active=${preset === "page-fit"} onClick=${() => (setZoom("page-fit"), close())} />
				<${MenuItem} label=${t("Actual size")} active=${preset === "page-actual"} onClick=${() => (setZoom("page-actual"), close())} />
				<${MenuSep} />
				${[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((value) => html`<${MenuItem} key=${value} label=${`${Math.round(value * 100)}%`} active=${!preset && Math.abs(scale - value) < 0.005} onClick=${() => (setZoom(value), close())} />`)}`}
		<//>
		<button class="icon-btn sm" title=${t("Zoom in")} aria-label=${t("Zoom in")} disabled=${!ready} onClick=${() => stepZoom(1)}><${Icon} name="zoomIn" size=${14} /></button>
		<button class=${`icon-btn sm pdf-fit ${preset === "page-width" ? "active" : ""}`} title=${t("Fit width")} aria-label=${t("Fit width")} disabled=${!ready} onClick=${() => setZoom("page-width")}><${Icon} name="fitWidth" size=${14} /></button>
		<button class=${`icon-btn sm pdf-fit ${preset === "page-fit" ? "active" : ""}`} title=${t("Fit page")} aria-label=${t("Fit page")} disabled=${!ready} onClick=${() => setZoom("page-fit")}><${Icon} name="fitPage" size=${14} /></button>
		<button class="icon-btn sm pdf-rotate" title=${t("Rotate right")} aria-label=${t("Rotate right")} disabled=${!ready} onClick=${rotate}><${Icon} name="rotateRight" size=${14} /></button>
		<button class=${`icon-btn sm ${findOpen ? "active" : ""}`} title=${t("Find in document")} aria-label=${t("Find in document")} aria-pressed=${findOpen} disabled=${!ready} onClick=${() => setFindOpen(!findOpen)}><${Icon} name="search" size=${14} /></button>
	</span>`;
	if (error) return html`${bar(null)}${fallback(t("This PDF could not be shown here: {error}", { error }))}`;
	return html`${bar(tools)}
		${findOpen ? html`<form class="file-find" onSubmit=${(event) => { event.preventDefault(); find("again"); }}>
			<${Icon} name="search" size=${14} class="c-dim" />
			<input class="field grow" ref=${findInput} aria-label=${t("Find in document")} placeholder=${t("Find in document")} value=${query}
				onInput=${(event) => { setQuery(event.target.value); find("", false, event.target.value); }}
				onKeyDown=${(event) => {
					if (event.key === "Escape") { event.preventDefault(); setFindOpen(false); }
					if (event.key === "Enter") { event.preventDefault(); find("again", event.shiftKey); }
				}} />
			<span class="dim file-find-count" role="status">${query ? (matches.total ? t("{active} of {matches}", { active: matches.current, matches: matches.total }) : t("No matches")) : ""}</span>
			<button class="icon-btn sm" type="button" title=${t("Previous match")} aria-label=${t("Previous match")} disabled=${!matches.total} onClick=${() => find("again", true)}><${Icon} name="chevronUp" size=${14} /></button>
			<button class="icon-btn sm" type="button" title=${t("Next match")} aria-label=${t("Next match")} disabled=${!matches.total} onClick=${() => find("again")}><${Icon} name="chevronDown" size=${14} /></button>
			<button class="icon-btn sm" type="button" title=${t("Close find")} aria-label=${t("Close find")} onClick=${() => setFindOpen(false)}><${Icon} name="x" size=${14} /></button>
		</form>` : null}
		<div class="pdf-body">
			${rail.open ? html`<nav class="pdf-rail" style=${{ width: `${rail.width}px` }} aria-label=${t("Pages and outline")}>
				${outline ? html`<div class="pdf-rail-tabs" role="tablist">
					<button role="tab" aria-selected=${railTab === "pages"} class=${railTab === "pages" ? "on" : ""} onClick=${() => setRailTab("pages")}>${t("Pages")}</button>
					<button role="tab" aria-selected=${railTab === "outline"} class=${railTab === "outline" ? "on" : ""} onClick=${() => setRailTab("outline")}>${t("Outline")}</button>
				</div>` : null}
				<div class="pdf-rail-scroll" ref=${railScroll}>
					${railTab === "outline" && outline
						? html`<${OutlineItems} items=${outline} onGo=${(dest) => engine.current?.linkService.goToDestination(dest)} />`
						: Array.from({ length: pages }, (_, index) => html`<${Thumb} key=${index} doc=${doc} number=${index + 1} current=${page === index + 1} onPick=${goTo} root=${railScroll} />`)}
				</div>
				<${Resizer} min=${110} max=${360} getValue=${() => rail.width} onChange=${(value) => setRail((old) => ({ ...old, width: Math.round(value) }))} onEnd=${() => setRail((old) => (saveRail(old), old))} />
			</nav>` : null}
			<div class="pdf-stage-wrap">
				<div class="pdf-stage" ref=${stage} tabindex="0" aria-label=${path}>
					<div class="pdfViewer" ref=${inner} />
				</div>
				${ready ? null : html`<div class="pdf-loading"><${Spinner} /> ${t("Opening PDF…")}</div>`}
			</div>
		</div>`;
}
