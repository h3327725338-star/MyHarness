// Image lightbox: one fullscreen preview overlay shared by the composer thumbnails and the message images,
// wired up by a later ticket; this one owns the singleton state, the host and the open/close entries.
import { html, useEffect, useLayoutEffect, useRef, useState, Icon, motionEnabled, usePresence } from "./ui.js";
import { t } from "./i18n.js";

// Small module-local signal (the store's style, without persistence): a value plus a listener set.
const listeners = new Set();
let current = null;
let previousFocus = null;
function get() {
	return current;
}
function emit() {
	for (const fn of [...listeners]) fn(current);
}
function subscribe(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
function useLightbox() {
	const [, force] = useState(0);
	useLayoutEffect(() => subscribe(() => force((n) => n + 1)), []);
	return get();
}

/**
 * Show `src` fullscreen. A missing image never opens (the caller asked for nothing), and the keyboard is handed
 * back to what had it once the preview closes.
 */
export function openImageLightbox(src, alt) {
	if (!src || typeof src !== "string" || get()?.src === src) return;
	if (typeof document !== "undefined" && !get()) previousFocus = document.activeElement;
	current = { src, alt: typeof alt === "string" && alt ? alt : "" };
	emit();
}

export function closeImageLightbox() {
	if (!get()) return;
	current = null;
	emit();
	if (typeof document === "undefined") return;
	// Hand the keyboard back unless the focus already moved on (the overlay may still be fading out).
	const active = document.activeElement;
	if (!active || active === document.body || active.closest?.(".lightbox-scrim")) previousFocus?.focus?.();
	previousFocus = null;
}

/**
 * The host mounted once at the root of the app. The Escape listener is permanent (so it runs before the dialogs'
 * own capture listeners and a press never closes what sits below the preview), the overlay only while it shows.
 */
export function ImageLightboxHost() {
	const preview = useLightbox();
	const { mounted, shown } = usePresence(!!preview, motionEnabled() ? 170 : 0);
	const closeRef = useRef(null);
	const last = useRef(null);
	if (preview) last.current = preview;
	useEffect(() => {
		const onKey = (event) => {
			if (event.key !== "Escape" || !get()) return;
			// A press while the preview is open ends here: not in the settings/quote dialog below, not in the composer.
			event.stopImmediatePropagation();
			event.preventDefault();
			closeImageLightbox();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
	useEffect(() => {
		if (preview) closeRef.current?.focus?.({ preventScroll: true });
	}, [preview]);
	if (!mounted) return null;
	const image = preview || last.current;
	return html`<div class=${`lightbox-scrim ${shown ? "open" : ""}`} onMouseDown=${(event) => event.target === event.currentTarget && closeImageLightbox()}>
		<div class="lightbox-dialog" role="dialog" aria-modal="true" aria-label=${t("Image preview")}
			onKeyDown=${(event) => {
				// The close button is the only stop: Tab stays on it instead of reaching the page below.
				if (event.key === "Tab") {
					event.preventDefault();
					closeRef.current?.focus?.();
				}
			}}>
			<img class="lightbox-img" src=${image.src} alt=${image.alt || t("Image preview")} draggable=${false}
				onError=${() => closeImageLightbox()} />
			<button ref=${closeRef} type="button" class="lightbox-close" aria-label=${t("Close preview")} onClick=${() => closeImageLightbox()}>
				<${Icon} name="x" size=${18} />
			</button>
		</div>
	</div>`;
}
