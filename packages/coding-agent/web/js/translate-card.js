// The selection translation card, laid out like a selection translator's popup: a head with the language pair (the
// target is a menu; picking one translates again and keeps it as the preference of Settings → Agent → Assistants → Translation), a
// word card for a word or a short phrase (the word, its reading, the translation, meanings by part of speech) or the
// passage with its translation, and the model that answered. The head drags the card; it fades in and out, and it goes
// away when the user works anywhere else (a click outside, the app losing focus, Escape).
import { html, useEffect, useRef, useState, Icon, Spinner, motionEnabled } from "./ui.js";
import { t } from "./i18n.js";

/** Languages the card translates into: the server's list (selection-translation.ts), "auto" is the interface language. */
export const TRANSLATION_TARGETS = [
	["auto", "Interface language"],
	["zh-CN", "Simplified Chinese"],
	["zh-TW", "Traditional Chinese"],
	["en", "English"],
	["ja", "Japanese"],
	["ko", "Korean"],
	["fr", "French"],
	["de", "German"],
	["es", "Spanish"],
	["ru", "Russian"],
];
const SOURCE_NAMES = { zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", fr: "French", de: "German", es: "Spanish", ru: "Russian" };

function languageLabel(tag) {
	const known = TRANSLATION_TARGETS.find(([value]) => value === tag);
	if (known) return t(known[1]);
	const base = String(tag || "").split("-")[0];
	return SOURCE_NAMES[base] ? t(SOURCE_NAMES[base]) : tag;
}

/**
 * The installed voice for `lang` (en-GB, en-US, …): an exact match first, then one of the same language. Setting only
 * the utterance's language leaves Windows on its default voice, so British and American would sound the same.
 */
function voiceFor(lang) {
	const voices = typeof speechSynthesis !== "undefined" ? speechSynthesis.getVoices() : [];
	const wanted = String(lang).toLowerCase().replace("_", "-");
	const tagOf = (voice) => String(voice.lang || "").toLowerCase().replace("_", "-");
	return voices.find((voice) => tagOf(voice) === wanted) || (wanted.includes("-") ? null : voices.find((voice) => tagOf(voice).startsWith(`${wanted}-`))) || null;
}

/** Time the card takes to fade out (matches the leave animation in composer.css). */
export const TRANSLATE_LEAVE_MS = 140;

/**
 * `translation`: { text, status: "loading" | "done" | "error", result, entry, target, preference, model, error, leaving }.
 * `pos`: { left, top, up } where the card opens; `onMove` takes the position the user dragged it to.
 */
export function TranslateCard({ translation, pos, cardRef, onMove, onClose, onRetarget, onRetry }) {
	const [menu, setMenu] = useState(false);
	const [copied, setCopied] = useState(false);
	const [showSource, setShowSource] = useState(false);
	const head = useRef(null);
	const done = translation.status === "done";
	const entry = done ? translation.entry : undefined;

	// Focus the card when it opens, so moving the focus anywhere else (another field, a website tab) closes it.
	useEffect(() => {
		cardRef.current?.focus({ preventScroll: true });
	}, []);
	useEffect(() => setCopied(false), [translation.result]);

	const onFocusOut = (event) => {
		const next = event.relatedTarget;
		// Focus leaving to nothing (a click on plain text) is handled by the click itself, which knows where it landed.
		if (next && !cardRef.current?.contains(next)) onClose();
	};

	const startDrag = (event) => {
		if (event.button !== 0 || event.target.closest("button")) return;
		const card = cardRef.current;
		if (!card) return;
		event.preventDefault();
		const box = card.getBoundingClientRect();
		const dx = event.clientX - box.left;
		const dy = event.clientY - box.top;
		head.current?.setPointerCapture?.(event.pointerId);
		card.classList.add("dragging");
		const move = (e) => {
			const left = Math.max(4, Math.min(window.innerWidth - box.width - 4, e.clientX - dx));
			const top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - dy));
			onMove({ left, top, up: false });
		};
		const end = () => {
			card.classList.remove("dragging");
			head.current?.removeEventListener("pointermove", move);
			head.current?.removeEventListener("pointerup", end);
			head.current?.removeEventListener("pointercancel", end);
		};
		head.current?.addEventListener("pointermove", move);
		head.current?.addEventListener("pointerup", end);
		head.current?.addEventListener("pointercancel", end);
	};

	const copy = () => {
		const text = translation.result || "";
		if (text) navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
	};
	const speak = (lang = entry?.source) => {
		const voice = lang ? voiceFor(lang) : null;
		const say = () => {
			try {
				const utterance = new SpeechSynthesisUtterance(translation.text);
				if (lang) utterance.lang = lang;
				if (voice) utterance.voice = voice;
				speechSynthesis.cancel();
				speechSynthesis.speak(utterance);
			} catch {
				/* No speech on this system. */
			}
		};
		// British and American readings both come from the dictionary voice through the server (routes-translate.ts), even
		// when Windows has a voice of that accent: an installed en-GB voice is much quieter than the recorded US one, so the
		// two buttons would not sound alike. The system voice reads it when the recording cannot be loaded.
		const accent = lang === "en-GB" ? "uk" : lang === "en-US" ? "us" : "";
		if (accent) {
			try {
				speechSynthesis.cancel();
				const audio = new Audio(`/api/translate/voice?text=${encodeURIComponent(translation.text)}&accent=${accent}`);
				audio.play().catch(say);
				return;
			} catch {
				/* fall back to the system voice */
			}
		}
		say();
	};
	const pick = (value) => {
		setMenu(false);
		if (value !== (translation.preference ?? "auto")) onRetarget(value);
	};

	const sourceLabel = entry?.source ? languageLabel(entry.source) : t("Detect language");
	const targetLabel = translation.target ? languageLabel(translation.target) : languageLabel(translation.preference || "auto");
	const short = !!entry;

	let body;
	if (translation.status === "loading") {
		body = html`<div class="tr-loading" role="status"><${Spinner} /> ${t("Translating…")}</div>`;
	} else if (translation.status === "error") {
		body = html`<div class="tr-error c-danger" role="alert">${translation.error}<div><button class="btn sm" onClick=${onRetry}>${t("Try again")}</button></div></div>`;
	} else if (short) {
		const canSpeak = typeof speechSynthesis !== "undefined";
		const speaker = (lang, label) =>
			canSpeak ? html`<button class="icon-btn sm" onClick=${() => speak(lang)} title=${label} aria-label=${label}><${Icon} name="volume" size=${13} /></button>` : null;
		// An English word is read both ways, like a dictionary: British and American, each with its own IPA.
		const english = /^en(?:-|$)/i.test(entry.source || "");
		body = html`<div class="tr-word">
			<div class="tr-headword"><span class="tr-term">${translation.text}</span>${english ? null : speaker(entry.source, t("Read aloud"))}</div>
			${english
				? html`<div class="tr-voices">
						<span class="tr-voice"><span class="tr-accent">${t("UK")}</span>${entry.phonetic ? html`<span class="tr-phonetic">${entry.phonetic}</span>` : null}${speaker("en-GB", t("British pronunciation"))}</span>
						<span class="tr-voice"><span class="tr-accent">${t("US")}</span>${entry.phoneticUs || entry.phonetic ? html`<span class="tr-phonetic">${entry.phoneticUs || entry.phonetic}</span>` : null}${speaker("en-US", t("American pronunciation"))}</span>
					</div>`
				: entry.phonetic
					? html`<div class="tr-phonetic">${entry.phonetic}</div>`
					: null}
			<div class="tr-main">${translation.result}</div>
			${entry.senses.length ? html`<ul class="tr-senses">${entry.senses.map((sense, i) => html`<li key=${i}>${sense.pos ? html`<span class="tr-pos">${sense.pos}</span>` : null}<span class="tr-meaning">${sense.meaning}</span></li>`)}</ul>` : null}
		</div>`;
	} else {
		body = html`<div class="tr-passage">
			<button class=${`tr-source ${showSource ? "open" : ""}`} onClick=${() => setShowSource(!showSource)} title=${showSource ? t("Collapse") : t("Show the original")}>${translation.text}</button>
			<div class="tr-target">${translation.result}</div>
		</div>`;
	}

	return html`<div
		ref=${cardRef}
		class=${`quote-note-card translate-card ${pos.up ? "up" : "down"}${translation.leaving ? " leaving" : ""}${pos.dragged ? " placed" : ""}`}
		style=${{ top: `${pos.top}px`, left: `${pos.left}px` }}
		role="dialog"
		aria-label=${t("Translation")}
		tabindex="-1"
		onFocusOut=${onFocusOut}
	>
		<div class="translate-head" ref=${head} onPointerDown=${startDrag} title=${t("Drag to move")}>
			<${Icon} name="language" size=${14} />
			<span class="tr-pair">
				<span class="tr-lang dim truncate">${sourceLabel}</span>
				<${Icon} name="arrowRight" size=${11} class="dim" />
				<button class=${`tr-lang-btn ${menu ? "open" : ""}`} onClick=${() => setMenu(!menu)} aria-haspopup="listbox" aria-expanded=${menu} title=${t("Translate into")}>
					<span class="truncate">${targetLabel}</span><${Icon} name="chevronDown" size=${11} />
				</button>
			</span>
			<span class="grow" />
			${done ? html`<button class="icon-btn sm" onClick=${copy} title=${copied ? t("Copied") : t("Copy translation")} aria-label=${t("Copy translation")}><${Icon} name=${copied ? "check" : "copy"} size=${13} /></button>` : null}
			<button class="icon-btn sm" onClick=${onClose} title=${t("Close translation")} aria-label=${t("Close translation")}><${Icon} name="x" size=${13} /></button>
		</div>
		${menu
			? html`<div class="tr-menu" role="listbox" aria-label=${t("Translate into")}>
				${TRANSLATION_TARGETS.map(([value, label]) => {
					const chosen = value === (translation.preference ?? "auto");
					return html`<button key=${value} role="option" aria-selected=${chosen} class=${`tr-menu-item ${chosen ? "on" : ""}`} onClick=${() => pick(value)}>
						<span class="grow">${t(label)}</span>${chosen ? html`<${Icon} name="check" size=${12} />` : null}
					</button>`;
				})}
			</div>`
			: null}
		<div class="translate-body" tabindex="0">${body}</div>
		${translation.model ? html`<div class="translate-foot dim truncate" title=${translation.model}>${translation.model}</div>` : null}
	</div>`;
}

/** Whether closing should wait for the leave animation. */
export const animateLeave = () => motionEnabled();
