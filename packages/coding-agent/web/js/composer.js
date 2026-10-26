// Composer: one stable input card. Model and effort are one click away; a message sent while the agent runs follows the
// default chosen in Settings (steer / queue / interrupt, see run-modes.js), Alt+Enter queues it.
import { html, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, autofocusOnMount, Chevron, Collapse, Icon, Menu, MenuItem, Popover, Spinner, motionEnabled, usePresence } from "./ui.js";
import { api, attempt, canSendToActive, chooseThinkingLevel, clearDraft, flushDrafts, loadGitStatus, loadModels, loadResources, loadSnapshot, markDraftSaved, post, scheduleDraftSave, setChatTouched, setView, state, toast, useStore } from "./store.js";
import { actions } from "./actions.js";
import { CommandPanel } from "./command-panel.js";
import { DraftEditor } from "./draft-editor.js";
import { BranchChip, MergeBackChip } from "./branch-menu.js";
import { openImageLightbox } from "./lightbox.js";

import { ContextMeter } from "./context-usage.js";
import { EffortPicker, ModelMenu } from "./model-menu.js";
import { rankSearch } from "./search.js";
import { debounce, fmtDuration, plural, pointerMoved } from "./util.js";
import { serverText, t } from "./i18n.js";
import { RUN_MODES, runModeOf } from "./run-modes.js";
import { completionDelay, completionLabel } from "./completion-status.js";
import { retryReason } from "./retry-reason.js";
import { SubAgentBar, runningTasks } from "./sub-agents.js";

import { drafts, registerRestartDraft, takeCarriedDraft } from "./restart-state.js";
import { invalidateAttachmentCaches } from "./attachments.js";
import { chatModeOf, draftFromServer } from "./chat-modes.js";
import { clipLine, formatQuotes, quoteFromSelection } from "./quote-text.js";
import { clearQuoteHighlights, paintQuotes } from "./quote-highlight.js";
import { MAX_UPLOAD_BYTES, sendFileInChunks } from "./upload-chunks.js";

/** Images up to this size travel inline with the message (as before); a larger one is attached as a file. */
const INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
/** Images one dialog answer can carry (the server takes as many as a message). */
const MAX_DIALOG_IMAGES = 12;

function fileToImage(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result);
			const comma = result.indexOf(",");
			resolve({ mimeType: file.type || "image/png", data: result.slice(comma + 1), name: file.name || "image", url: result });
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

// ---- Pending dialogs (extension select / confirm / input / editor). Approvals live here, not in a modal.
function DialogBar({ dialog }) {
	const [value, setValue] = useState(dialog.initialValue || "");
	// A text question that takes images (ask_user_question's typed answer): pasted or picked images go with the answer.
	const [pics, setPics] = useState([]);
	const picInput = useRef(null);
	const addPics = async (files) => {
		const images = [...files].filter((file) => file.type.startsWith("image/"));
		if (!images.length) return false;
		for (const file of images) {
			if (file.size > INLINE_IMAGE_BYTES) { toast(`${file.name}: ${t("Images must be 32 MiB or smaller.")}`, "warning"); continue; }
			try {
				const image = await fileToImage(file);
				setPics((prev) => (prev.length >= MAX_DIALOG_IMAGES ? prev : [...prev, image]));
			} catch { toast(`${file.name}: ${t("Could not read the file.")}`, "error"); }
		}
		return true;
	};
	const root = useRef(null);
	// Choice dialogs (Allow / Deny, a list of options) are answered from the keyboard: ←/→/↑/↓/Tab move, Enter answers,
	// Esc denies or cancels, 1-9 pick an option. Alt+A brings the keyboard here from anywhere.
	const choices =
		dialog.kind === "confirm"
			? [{ label: t("Deny"), value: false }, { label: t("Allow"), value: true }]
			: dialog.kind === "select"
				? [...dialog.options.map((option) => ({ label: option, value: option })), { label: t("Cancel"), value: undefined, ghost: true }]
				: [];
	const [pick, setPick] = useState(dialog.kind === "confirm" ? 1 : 0);
	const claimFocus = () => root.current?.focus();
	useLayoutEffect(() => {
		// Take the keyboard when a dialog appears, unless the user is in the middle of typing a message.
		const active = document.activeElement;
		const typing = active && (((active.tagName === "TEXTAREA" || active.tagName === "INPUT") && active.value) || (active.isContentEditable && active.textContent));
		if (!typing && choices.length) claimFocus();
	}, [dialog.id]);
	useEffect(() => {
		const onKey = (event) => {
			if (event.altKey && event.key.toLowerCase() === "a" && choices.length) {
				event.preventDefault();
				claimFocus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dialog.id]);
	const onChoiceKey = (event) => {
		if (!choices.length || event.isComposing) return;
		const move = (delta) => (event.preventDefault(), setPick((pick + delta + choices.length) % choices.length));
		if (event.key === "ArrowLeft" || event.key === "ArrowUp") return move(-1);
		if (event.key === "ArrowRight" || event.key === "ArrowDown") return move(1);
		if (event.key === "Tab") return move(event.shiftKey ? -1 : 1);
		if (event.key === "Enter") return event.preventDefault(), answer(choices[pick].value);
		if (event.key === "Escape") return event.preventDefault(), answer(dialog.kind === "confirm" ? false : undefined);
		const digit = Number(event.key);
		if (dialog.kind === "select" && digit >= 1 && digit <= dialog.options.length) return event.preventDefault(), answer(dialog.options[digit - 1]);
	};
	const [left, setLeft] = useState(dialog.deadline ? Math.max(0, Math.ceil((dialog.deadline - Date.now()) / 1000)) : null);
	useEffect(() => {
		if (!dialog.deadline) return undefined;
		const timer = setInterval(() => setLeft(Math.max(0, Math.ceil((dialog.deadline - Date.now()) / 1000))), 500);
		return () => clearInterval(timer);
	}, [dialog.id]);
	const answer = (v) => attempt(() => post("/api/ui/respond", { id: dialog.id, value: v, ...(v !== undefined && pics.length ? { images: pics.map(({ mimeType, data }) => ({ mimeType, data })) } : {}) }), { quiet: false });
	const lines = String(dialog.title || "").split("\n");
	const head = lines[0];
	const rest = lines.slice(1).join("\n");
	return html`<div class="dialog-bar fade-in" role="alertdialog" aria-label=${head} ref=${root} tabindex="-1" onKeyDown=${onChoiceKey}>
		<div class="dialog-head"><${Icon} name="clock" size=${15} class="c-dim" /><strong class="grow">${head}</strong>${left != null ? html`<span class="dim">${left}s</span>` : null}</div>
		${rest || dialog.message ? html`<div class="dialog-msg">${[rest, dialog.message].filter(Boolean).join("\n")}</div>` : null}
		${dialog.kind === "confirm"
			? html`<div class="dialog-actions"><button class=${`btn sm ${pick === 0 ? "kbd-sel" : ""}`} tabindex="-1" onClick=${() => answer(false)} onMouseMove=${() => setPick(0)}>${t("Deny")}</button><button class=${`btn sm primary ${pick === 1 ? "kbd-sel" : ""}`} tabindex="-1" onClick=${() => answer(true)} onMouseMove=${() => setPick(1)}>${t("Allow")}</button></div><div class="dialog-keys dim">${t("←/→ choose · Enter answer · Esc deny · Alt+A focus here")}</div>`
			: dialog.kind === "select"
				? html`<div class="dialog-options">${dialog.options.map((option, i) => html`<button class=${`btn sm ${pick === i ? "kbd-sel" : ""}`} tabindex="-1" key=${option} onClick=${() => answer(option)} onMouseMove=${() => setPick(i)}>${i < 9 ? html`<span class="dim">${i + 1}</span> ` : null}${option}</button>`)}<button class=${`btn sm ghost ${pick === dialog.options.length ? "kbd-sel" : ""}`} tabindex="-1" onClick=${() => answer(undefined)} onMouseMove=${() => setPick(dialog.options.length)}>${t("Cancel")}</button></div><div class="dialog-keys dim">${t("↑/↓ choose · Enter answer · 1-9 pick · Esc cancel · Alt+A focus here")}</div>`
				: dialog.kind === "input"
					? html`${pics.length ? html`<div class="attachments dialog-pics">${pics.map((img, i) => html`<div class="thumb" key=${i} role="button" tabindex="0" aria-label=${t("Preview image {name}", { name: img.name })} onClick=${(e) => { if (!e.target.closest(".thumb-x")) openImageLightbox(img.url, img.name); }}><img src=${img.url} alt=${img.name} /><button class="thumb-x" type="button" aria-label=${t("Remove attachment")} onClick=${(e) => { e.stopPropagation(); setPics(pics.filter((_, j) => j !== i)); }}><${Icon} name="x" size=${11} /></button></div>`)}</div>` : null}
					<form class="dialog-input" onSubmit=${(e) => (e.preventDefault(), answer(value))}><input class="field sm grow" autofocus ref=${autofocusOnMount} value=${value} placeholder=${dialog.placeholder || ""} onInput=${(e) => setValue(e.target.value)}
						onPaste=${dialog.acceptsImages ? (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void addPics(files); } } : undefined} />${dialog.acceptsImages ? html`<button class="icon-btn sm" type="button" title=${t("Attach images (or paste them)")} aria-label=${t("Attach images (or paste them)")} disabled=${pics.length >= MAX_DIALOG_IMAGES} onClick=${() => picInput.current?.click()}><${Icon} name="image" size=${15} /></button><input ref=${picInput} type="file" accept="image/*" multiple hidden onChange=${(e) => (void addPics(e.target.files), (e.target.value = ""))} />` : null}<button class="btn sm ghost" type="button" onClick=${() => answer(undefined)}>${t("Cancel")}</button><button class="btn sm primary" type="submit">${t("Submit")}</button></form>`
					: html`<div class="dialog-editor"><textarea class="field" rows="6" autofocus ref=${autofocusOnMount} value=${value} onInput=${(e) => setValue(e.target.value)} /><div class="dialog-actions"><button class="btn sm ghost" onClick=${() => answer(undefined)}>${t("Cancel")}</button><button class="btn sm primary" onClick=${() => answer(value)}>${t("Submit")}</button></div></div>`}
	</div>`;
}

/** A provider-problem strip: one line (status, short cause, action); the full error opens on hover or click. */
function ProviderStrip({ status, message, category, cancel }) {
	const [open, setOpen] = useState(false);
	const detail = String(message ?? "").trim();
	return html`<div class="strip warn strip-retry" role="status">
		<${Spinner} />
		<button class="strip-main" type="button" title=${detail} aria-expanded=${open} disabled=${!detail} onClick=${() => setOpen(!open)}>
			<span class="strip-status">${status}</span><span class="strip-reason">${retryReason(detail, category)}</span>${detail ? html`<${Icon} name="chevronDown" size=${12} class="strip-chev" />` : null}
		</button>
		${cancel || null}
		${open && detail ? html`<pre class="strip-detail-text">${detail}</pre>` : null}
	</div>`;
}

function StatusStrips({ snap }) {
	const compaction = useStore((s) => s.compaction);
	const retry = useStore((s) => s.retry);
	const recovery = useStore((s) => s.recovery);
	const fallbackTo = useStore((s) => s.fallbackTo);
	const completion = useStore((s) => s.completion);
	const [visibleCompletion, setVisibleCompletion] = useState(null);
	useEffect(() => {
		setVisibleCompletion(null);
		if (!completion) return undefined;
		const show = () => setVisibleCompletion(completion.startedAt);
		const delay = completionDelay(completion);
		if (!delay) { show(); return undefined; }
		const timer = setTimeout(show, delay);
		return () => clearTimeout(timer);
	}, [completion?.startedAt, !!completion]);
	// A page opened during a compaction has no compaction_start event: the snapshot says it runs and since when.
	const compacting = compaction || (snap?.flags?.compacting ? { reason: null, startedAt: snap.run?.lastActivityAt } : null);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!retry && !compacting) return undefined;
		const timer = setInterval(() => setTick((n) => n + 1), 500);
		return () => clearInterval(timer);
	}, [retry, !!compacting]);
	const strips = [];
	// The only place a compaction shows while it runs (the conversation does not repeat it): what runs, for how long, Cancel.
	if (compacting) {
		const label = compacting.reason ? t("Compacting context ({reason})", { reason: compacting.reason }) : t("Compacting context");
		strips.push(html`<div class="strip" key="c" role="status"><${Spinner} /> <span>${label}</span>${compacting.startedAt ? html`<span class="strip-time">${fmtDuration(Date.now() - compacting.startedAt)}</span>` : null}<button class="link-btn" onClick=${actions.stop}>${t("Cancel")}</button></div>`);
	}
	if (retry) {
		const remaining = Math.max(0, Math.ceil((retry.at + retry.delayMs - Date.now()) / 1000));
		strips.push(html`<${ProviderStrip} key="r" status=${t("Retry {attempt}/{maxAttempts} in {remaining}s", { attempt: retry.attempt, maxAttempts: retry.maxAttempts ?? "∞", remaining })} message=${retry.errorMessage} category=${retry.errorCategory} cancel=${html`<button class="link-btn" onClick=${() => post("/api/abort-retry")}>${t("Cancel retry")}</button>`} />`);
	}
	if (fallbackTo) strips.push(html`<div class="strip" key="m" role="status"><${Spinner} /> <span>${t("Switched to {model}", { model: fallbackTo })}</span></div>`);
	if (recovery) strips.push(html`<${ProviderStrip} key="v" status=${recovery.kind === "new-conversation" ? t("Rebuilding conversation (#{conversation})", { conversation: recovery.conversation }) : t("Provider recovery ({attempt}/{budget})", { attempt: recovery.attempt, budget: recovery.budget })} message=${recovery.errorMessage} />`);
	if (completion && visibleCompletion === completion.startedAt && !snap?.active) strips.push(html`<div class="strip" key="f" role="status"><${Spinner} /> <span>${t(completionLabel(completion))}</span></div>`);
	void tick;
	return strips.length ? html`<div class="strips">${strips}</div>` : null;
}

function QueueChips({ queue, outbox }) {
	const n = queue.steering.length + queue.followUp.length + outbox.length;
	if (!n) return null;
	return html`<div class="queue">
		<div class="queue-head dim"><${Icon} name="clock" size=${13} /> ${t("{plural} waiting", { plural: plural(n, "message") })} <button class="link-btn" onClick=${actions.clearQueue}>${t("Move back to editor")}</button></div>
		${queue.steering.map((text, i) => html`<div class="queue-item" key=${`s${i}`}><span class="badge accent">${t("steer")}</span><span class="truncate">${text}</span></div>`)}
		${queue.followUp.map((text, i) => html`<div class="queue-item" key=${`f${i}`}><span class="badge">${t("after run")}</span><span class="truncate">${text}</span></div>`)}
		${outbox.map((entry) => html`<div class="queue-item" key=${`o${entry.clientMessageId}`}><span class=${entry.mode === "steer" ? "badge accent" : "badge"}>${entry.mode === "steer" ? t("steer") : t("after run")}</span><span class="truncate">${entry.text}</span></div>`)}
	</div>`;
}

// ---- Model and thinking effort: two separate text chips, each opening its own small popover above itself ------
function ModelPicker() {
	const snap = useStore((s) => s.snap);
	// A chat that is still being opened has no snapshot yet: that is not "no model".
	const opening = useStore((s) => !!s.switching && !s.snap?.model);
	const models = useStore((s) => s.models);
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (open) loadModels();
	}, [open]);
	const model = snap?.model;
	const running = !!snap?.active;
	const choose = async ({ provider, model: id }) => {
		setBusy(true);
		const ok = await attempt(() => post("/api/model", { provider, id }));
		setBusy(false);
		if (ok) {
			setOpen(false);
			// The new model's efforts and the effort in use come with the snapshot: the effort chip follows the model.
			await attempt(loadSnapshot, { quiet: true });
		}
	};
	return html`<span ref=${anchor} class="picker-anchor">
		<button class="chip" onClick=${() => setOpen(!open)} title=${running ? t("Models can be switched when the agent is idle") : `${t("Model")}: ${model ? model.name || model.id : t("No model")}`} aria-haspopup="listbox" aria-expanded=${open}>
			<span class="truncate chip-text">${model ? model.name || model.id : opening ? "…" : t("No model")}</span><${Chevron} />
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="end" width=${300} maxHeight=${380} class="model-pop">
			<${ModelMenu} models=${models} disabled=${busy || running}
				selected=${model ? { provider: model.provider, model: model.id } : null}
				onPick=${choose}
				footer=${html`<div class="pop-foot">${running ? html`<span class="dim pop-meta grow">${t("Models can be switched when the agent is idle")}</span>` : html`<span class="grow" />`}<button class="link-btn" onClick=${() => (setOpen(false), setView({ settingsOpen: true, settingsSection: "providers" }))}>${t("Manage providers")}</button></div>`} />
		<//>
	</span>`;
}

/** The effort of the model in use: one slider stop per level this model supports; hidden when there is nothing to choose. */
function MainEffortPicker() {
	const thinking = useStore((s) => s.snap?.thinking);
	if (!thinking?.supported) return null;
	return html`<${EffortPicker} levels=${thinking.levels} value=${thinking.level} onChange=${chooseThinkingLevel} />`;
}

// ---- Suggestion popovers (/ commands and @ files) --------------------------------------------------------
/**
 * A Chinese input method types a full-width slash (U+FF0F) or an enumeration comma (U+3001) for the "/" key: as the
 * first character of a message that is still one word, it is the command slash.
 */
const slashStart = (value) => (/^[\uFF0F\u3001]/u.test(value) && !/\s/u.test(value) ? `/${value.slice(1)}` : value);

function useSuggestions(text, caret) {
	const resources = useStore((s) => s.resources);
	const [files, setFiles] = useState([]);
	const token = useMemo(() => {
		const before = text.slice(0, caret);
		const slash = /^\/([^\s]*)$/.exec(before);
		if (slash) return { type: "slash", query: slash[1], start: 0 };
		const at = /(?:^|\s)@([^\s]*)$/.exec(before);
		if (at) return { type: "file", query: at[1], start: before.length - at[1].length - 1 };
		return null;
	}, [text, caret]);
	useEffect(() => {
		if (token?.type === "slash" && !resources) loadResources();
	}, [token?.type]);
	useEffect(() => {
		if (token?.type !== "file") {
			setFiles([]);
			return undefined;
		}
		let cancelled = false;
		const run = debounce(async () => {
			try {
				const data = await api(`/api/files/search?q=${encodeURIComponent(token.query)}&limit=12`);
				if (!cancelled) setFiles(data.files);
			} catch {
				if (!cancelled) setFiles([]);
			}
		}, 120);
		run();
		return () => {
			cancelled = true;
			run.cancel();
		};
	}, [token?.type, token?.query]);
	const items = useMemo(() => {
		if (!token) return [];
		if (token.type === "slash") {
			// The list arrives most-used first (the terminal's order). A search puts relevance before usage: an exact
			// name, then a prefix, then a part of the name, then the description.
			return rankSearch(resources?.commands || [], token.query, {
				names: (c) => [c.name, ...(c.aliases || [])],
				keywords: (c) => (c.source === "builtin" ? serverText(c.description) : c.description) || "",
				usage: (c) => c.uses,
			})
				.slice(0, 12)
				.map((c) => ({ command: c.name, key: `/${c.name}`, label: `/${c.name}`, hint: c.source === "builtin" ? serverText(c.description) : c.description, tag: t(c.source), insert: `/${c.name} ` }));
		}
		return files.map((f) => ({ key: f, label: f, insert: `@${f} `, icon: "file" }));
	}, [token, resources, files]);
	return { token, items };
}

// ---- Composer proper -------------------------------------------------------------------------------------
export function Composer() {
	const snap = useStore((s) => s.snap);
	const queue = useStore((s) => s.queue);
	const outbox = useStore((s) => s.outbox);
	const dialogs = useStore((s) => s.dialogs);
	const surface = useStore((s) => s.surface);
	const editorInsert = useStore((s) => s.editorInsert);
	const quoteInsert = useStore((s) => s.quoteInsert);
	const items = useStore((s) => s.items);
	const gitStatus = useStore((s) => s.gitStatus);
	const activeSlot = useStore((s) => s.activeSlot);
	const stopping = useStore((s) => !!s.stopping[s.activeSlot]);
	const restarting = useStore((s) => s.restarting);
	const connected = useStore((s) => s.connected);
	const switching = useStore((s) => s.switching);
	const draftIdentity = snap?.session?.id || (switching ? `target:${switching.mode}:${switching.path || "latest"}` : undefined);
	const sessionId = snap?.session?.id;
	const draftReady = !!sessionId && snap?.session?.persisted && !String(activeSlot).startsWith("pending:");
	const chatMode = chatModeOf(snap?.mode);
	const active = !!snap?.active;
	// The branch / worktree chips above the input: read when the folder or the chat on screen changes and after each run.
	useEffect(() => {
		if (snap?.cwd && !active) loadGitStatus();
	}, [snap?.cwd, active, activeSlot]);
	const busyCompact = !!snap?.flags?.compacting;
	// While a chat is being opened its model is not known yet; the placeholder must not ask for a provider meanwhile.
	const noModel = !snap?.model && !switching;
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [images, setImages] = useState([]);
	const [quotes, setQuotes] = useState([]);
	// Editing a saved quote card: popup grows from the clicked card to the screen centre.
	const [editingId, setEditingId] = useState(null);
	const [editNote, setEditNote] = useState("");
	const [editFrom, setEditFrom] = useState(null);
	const [editCentered, setEditCentered] = useState(false);
	const editArea = useRef(null);
	// What Enter does while the agent runs: the default chosen in Settings.
	const runMode = runModeOf(useStore((s) => s.view.runMode));
	const subAgentsRunning = useStore((s) => runningTasks(s.subAgentState || { items: [] }) > 0);
	const [sending, setSending] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [sel, setSel] = useState(0);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const area = useRef(null);
	const fileInput = useRef(null);
	const folderInput = useRef(null);
	const lastSession = useRef(null);
	const provisionalTarget = useRef(null);
	const draftMatches = lastSession.current === draftIdentity;
	// The command registry (names, aliases) is needed the moment a command is typed; load it up front.
	useEffect(() => {
		if (!state.resources) loadResources().catch(() => {});
	}, [sessionId]);

	// The draft is also saved on the server (per chat, in its mode) a moment after each edit, so it comes back when the
	// chat is reopened later, in another tab or after the browser was closed. The render-time identity guard
	// skips a target-adoption render so the previous chat's text is never saved under the new one.
	useEffect(() => {
		if (!draftReady || !draftMatches || lastSession.current !== draftIdentity) return;
		scheduleDraftSave({ slot: activeSlot, mode: chatMode, sessionId, text, images, quotes });
	}, [text, images, quotes, sessionId, activeSlot, draftReady, draftMatches]);

	// Adopt a target before paint/input so its first keystroke never edits the previous Chat's draft.
	useLayoutEffect(() => {
		if (lastSession.current !== null && lastSession.current !== draftIdentity) drafts.set(lastSession.current, { text, images, quotes });
		if (lastSession.current !== draftIdentity) {
			// The chat moved into a worktree copy or back (a new session in the same slot): its unsent draft moves with it.
			const carried = takeCarriedDraft(lastSession.current, sessionId);
			if (lastSession.current !== null) flushDrafts();
			// What the server saved for this chat; the text edited in this tab (if any) is newer and wins.
			const saved = sessionId ? draftFromServer(state.modeState?.[chatMode]?.drafts?.[sessionId]) : null;
			if (saved) markDraftSaved(sessionId, saved);
			const target = provisionalTarget.current;
			const sameTarget = target && target.mode === chatMode && (!target.path || target.path === snap?.session?.file);
			const provisional = sessionId && sameTarget ? drafts.get(target.key) : null;
			const draft = carried || provisional || drafts.get(draftIdentity) || saved;
			if (provisional) drafts.delete(target.key);
			setText(draft?.text || "");
			setImages(draft?.images || []);
			setQuotes(draft?.quotes || []);
			setHistoryIndex(-1);
		}
		lastSession.current = draftIdentity;
		provisionalTarget.current = !sessionId && switching ? { key: draftIdentity, mode: switching.mode, path: switching.path } : null;
	}, [draftIdentity]);
	// What the server was last told about each chat: it holds input (it stays listed) or it was emptied again (it is a blank
	// chat like a new one). Only a change is sent.
	const touched = useRef(new Map());
	useEffect(() => {
		if (!draftReady || !draftMatches || lastSession.current !== draftIdentity) return;
		const has = !!text.trim() || images.length > 0 || quotes.length > 0;
		if ((touched.current.get(sessionId) ?? false) === has) return;
		touched.current.set(sessionId, has);
		setChatTouched(activeSlot, has).then((ok) => ok || touched.current.set(sessionId, !has));
	}, [text, images, quotes, sessionId, activeSlot, draftReady, draftMatches]);
	const latest = useRef({ text, images, quotes, sessionId, draftIdentity });
	latest.current = { text, images, quotes, sessionId, draftIdentity };
	useEffect(() => registerRestartDraft(() => latest.current), []);
	useEffect(
		() => () => {
			const { text: t0, images: i0, quotes: q0, draftIdentity: id } = latest.current;
			if (id) drafts.set(id, { text: t0, images: i0, quotes: q0 });
		},
		[],
	);
	useEffect(() => {
		if (!editorInsert) return;
		setText((prev) => (editorInsert.replace || !prev ? editorInsert.text : `${prev}${prev.endsWith("\n") || !prev ? "" : "\n"}${editorInsert.text}`));
		setTimeout(() => area.current?.focus(), 0);
	}, [editorInsert?.nonce]);
	useEffect(() => {
		if (!quoteInsert?.text) return;
		const quote = quoteFromSelection(quoteInsert.text, { note: quoteInsert.note, hint: quoteInsert.hint });
		if (quote) setQuotes((prev) => [...prev, quote]);
		// A file picked with the quote goes through the same attachment pipeline as one picked in the input.
		if (quoteInsert.files?.length) importFiles.current(quoteInsert.files);
		setTimeout(() => area.current?.focus(), 0);
	}, [quoteInsert?.nonce]);
	// A mounted quote keeps its fragment painted in the conversation; removing the card, sending it away or opening
	// another chat takes the feedback away again.
	useEffect(() => {
		paintQuotes(quotes);
	}, [quotes, sessionId]);
	useEffect(() => () => clearQuoteHighlights(), []);
	// More than three lines: an icon in the card's corner opens the same card as a large, centred editor.
	const [tall, setTall] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [closing, setClosing] = useState(false);
	const ghost = useRef(0);
	const lineHeights = useRef(new Map());
	const editorElement = area.current?.element;
	useLayoutEffect(() => {
		const el = editorElement ?? area.current?.element;
		if (!el) return undefined;
		// Lines as seen on screen: a long line that wraps counts once per row, a heading once.
		// A row's line height comes from its style, so it is measured once per style and then reused;
		// the observer is mounted once and re-measures only when the input's size actually changes.
		const measure = () => {
			let lines = 0;
			for (const line of el.children) {
				// The caret mark does not change the style: keep it out of the cache key.
				const key = line.className.replace(" active", "");
				let lineHeight = lineHeights.current.get(key);
				if (lineHeight === undefined) {
					lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight) || 20;
					lineHeights.current.set(key, lineHeight);
				}
				lines += Math.max(1, Math.round(line.offsetHeight / lineHeight));
			}
			setTall(lines > 3);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [editorElement]);
	// The large editor grows out of the input's own box and folds back into it: the card's box moves between its place
	// in the column (kept by the ghost) and the middle of the window, so the change of size never jumps. `morphing`
	// replaces the plain fade of the card while its box moves; without motion the editor still opens and closes at once.
	const ghostBox = useRef(null);
	const morphFrom = useRef(null);
	const morph = useRef(null);
	const [morphing, setMorphing] = useState(false);
	const canMorph = () => typeof card.current?.animate === "function" && motionEnabled();
	const boxOf = (rect) => ({ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, translate: "0 0" });
	const morphBox = (from, to, duration, fill = "none") => {
		morph.current?.cancel();
		morph.current = null;
		const el = card.current;
		if (!el || !from || !to || !canMorph()) return null;
		const animation = el.animate([boxOf(from), boxOf(to)], { duration, fill, easing: "cubic-bezier(0.2, 0, 0, 1)" });
		morph.current = animation;
		return animation;
	};
	const expand = () => {
		const rect = card.current?.getBoundingClientRect();
		ghost.current = rect?.height || card.current?.offsetHeight || 0;
		morphFrom.current = rect && canMorph() ? rect : null;
		setMorphing(!!morphFrom.current);
		setExpanded(true);
		setTimeout(() => area.current?.focus(), 0);
	};
	useLayoutEffect(() => {
		if (!expanded || !morphFrom.current) return;
		const from = morphFrom.current;
		morphFrom.current = null;
		const animation = card.current ? morphBox(from, card.current.getBoundingClientRect(), 260) : null;
		if (!animation) setMorphing(false);
		else animation.finished.then(() => setMorphing(false), () => undefined);
	}, [expanded]);
	const collapse = ({ focus = true } = {}) => {
		if (closing || !expanded) return;
		const el = card.current;
		const target = ghostBox.current?.getBoundingClientRect();
		const animation = el && target ? morphBox(el.getBoundingClientRect(), { left: target.left, top: target.top, width: target.width, height: Math.max(target.height, 40) }, 220, "forwards") : null;
		setMorphing(!!animation);
		setClosing(true);
		const done = () => {
			setClosing(false);
			setExpanded(false);
			setMorphing(false);
			if (focus) area.current?.focus();
		};
		// The box keeps its folded place until the column has taken the card back, so nothing flashes in between.
		if (animation) animation.finished.then(() => { done(); requestAnimationFrame(() => animation.cancel()); }, () => undefined);
		else setTimeout(done, 180);
	};
	useEffect(() => {
		if (!expanded) return undefined;
		// Esc closes the large editor wherever the keyboard is, unless something on top of it (a menu, the suggestions) used it.
		const onKey = (event) => {
			if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
				event.preventDefault();
				collapse();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [expanded, closing]);

	const { token, items: suggestions } = useSuggestions(text, caret);
	// Another chat starts with the small input.
	useEffect(() => {
		morph.current?.cancel();
		setExpanded(false);
		setClosing(false);
		setMorphing(false);
	}, [sessionId]);
	useEffect(() => setSel(0), [token?.type, token?.query]);
	// Closing the list (Esc, a click outside the input card) only hides it for the token being typed; the draft is untouched.
	const tokenKey = token ? `${token.type}:${token.start}:${token.query}` : "";
	const [dismissed, setDismissed] = useState("");
	// A closed list stays closed only for that token: once the token is gone, typing "/" (or "@") opens the list again.
	useEffect(() => {
		if (dismissed && dismissed !== tokenKey) setDismissed("");
	}, [tokenKey]);
	const menuOpen = !!token && suggestions.length > 0 && dismissed !== tokenKey;
	// Closing keeps the list mounted for the shared pop-out (same --t-close window as Popover in ui.js), so it fades instead of vanishing.
	const suggestPresence = usePresence(menuOpen, 110);
	// The token can already be gone by the time the list fades; rows frozen from the last open list avoid a collapse mid-animation.
	const lastSuggestItems = useRef([]);
	if (menuOpen) lastSuggestItems.current = suggestions;
	const card = useRef(null);
	const suggestList = useRef(null);
	useEffect(() => {
		if (!menuOpen) return undefined;
		const onDown = (event) => {
			if (card.current?.contains(event.target)) return;
			setDismissed(tokenKey);
		};
		document.addEventListener("mousedown", onDown, true);
		return () => document.removeEventListener("mousedown", onDown, true);
	}, [menuOpen, tokenKey]);
	// The highlighted row is always visible, also when ↑ on the first row wraps to the last one (and ↓ on the last to the first).
	useLayoutEffect(() => {
		if (!menuOpen) return;
		const list = suggestList.current;
		const row = list?.children[sel];
		if (!row) return;
		// Scroll only the candidates, never the editor or its ancestors (scrollIntoView did both).
		const top = row.offsetTop;
		const bottom = top + row.offsetHeight;
		const scrolled = list.scrollTop;
		const shown = list.clientHeight;
		if (top < scrolled) list.scrollTop = top;
		else if (bottom > scrolled + shown) list.scrollTop = bottom - shown;
	}, [sel, menuOpen, suggestions.length]);

	const history = useMemo(() => items.filter((i) => i.kind === "user" && i.text).map((i) => i.text), [items]);

	/**
	 * Confirm a highlighted "/" command: run it now. Commands with several levels of choices open their panel; the rest
	 * are sent like typed text. (Tab only completes the name, see applySuggestion.)
	 */
	const runCommand = async (item) => {
		if (!canSendToActive()) return;
		const target = { slot: activeSlot, mode: chatMode, sessionId };
		const value = `/${item.command}`;
		setText("");
		setHistoryIndex(-1);
		const result = await actions.submit(value, { mode: active ? runMode : "auto" });
		if (!result.handled && !result.ok) {
			if (latest.current.sessionId === target.sessionId) setText(value);
			else if (target.sessionId) {
				const restored = { text: value, images: [], quotes: [] };
				drafts.set(target.sessionId, restored);
				scheduleDraftSave({ ...target, ...restored });
			}
		}
	};
	const confirmSuggestion = (item) => (item.command ? runCommand(item) : applySuggestion(item));

	const applySuggestion = (item) => {
		const start = token.start;
		const next = `${text.slice(0, start)}${item.insert}${text.slice(caret)}`;
		setText(next);
		const pos = start + item.insert.length;
		setTimeout(() => {
			area.current?.focus();
			area.current?.setCaret(pos);
			setCaret(pos);
		}, 0);
	};

	const importing = useRef(false);
	const [loadingFiles, setLoadingFiles] = useState(false);
	const addFiles = async (fileList) => {
		if (!draftReady) { toast(t("Loading…")); return; }
		const picked = [...fileList];
		if (!picked.length) return;
		if (importing.current) { toast(t("Wait for the current file import to finish."), "warning"); return; }
		const targetSession = sessionId;
		const targetSlot = activeSlot;
		const targetMode = chatMode;
		const initial = latest.current;
		importing.current = true;
		setLoadingFiles(true);
		try {
			// One file at a time, and a file that is not an inline image goes up in chunks: no batch, and no large file,
			// is ever held whole in memory. A file that fails or is too large is skipped; the rest still go.
			for (const file of picked) {
				if (file.size > MAX_UPLOAD_BYTES) { toast(`${file.name}: ${t("Files must be 500 MiB or smaller.")}`, "warning"); continue; }
				try {
					let attachment;
					if (file.type.startsWith("image/") && file.size <= INLINE_IMAGE_BYTES) {
						attachment = await fileToImage(file);
						if (state.snap?.model && !state.snap.model.input.includes("image")) toast(t("The current model does not list image input; the image may be ignored or trigger the vision assistant if enabled."), "warning", 6000);
					} else {
						const { uploadId } = await post("/api/files/upload/begin", { name: file.name, size: file.size }, targetSlot);
						await sendFileInChunks(file, (offset, data) => post("/api/files/upload/chunk", { uploadId, offset, data }, targetSlot));
						const uploaded = await post("/api/files/upload/finish", { uploadId }, targetSlot);
						attachment = { name: uploaded.name, path: uploaded.path, id: uploaded.id ?? uploaded.path, mime: uploaded.mime ?? file.type ?? null, size: uploaded.size ?? file.size ?? null };
					}
					if (latest.current.sessionId === targetSession) setImages((prev) => [...prev, attachment]);
					else {
						const draft = drafts.get(targetSession) || initial;
						const next = { text: draft.text, images: [...draft.images, attachment] };
						drafts.set(targetSession, next);
						scheduleDraftSave({ slot: targetSlot, mode: targetMode, sessionId: targetSession, ...next });
					}
				} catch (error) { toast(`${file.name}: ${serverText(error.message, t("Could not read the file."))}`, "error"); }
			}
			// Newly uploaded files appear in the sidebar's per-chat group at once.
			try { invalidateAttachmentCaches(); } catch { /* sidebar hook is optional */ }
		} finally { importing.current = false; setLoadingFiles(false); }
	};
	const importFiles = useRef(addFiles);
	importFiles.current = addFiles;
	useEffect(() => {
		const isFileDrag = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
		// The highlight must never outlive the drag. A drop that another area handles (and stops), a drag that leaves
		// over the built-in browser's native view or is cancelled may send no event here, but a drag still over the
		// page repeats `dragover` several times a second, so missing it for a moment means the drag is gone.
		let idle = 0;
		const clear = () => { clearTimeout(idle); setDragOver(false); };
		const over = (event) => {
			if (!isFileDrag(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			setDragOver(true);
			clearTimeout(idle);
			idle = setTimeout(clear, 700);
		};
		const leave = (event) => { if (!event.relatedTarget) clear(); };
		const drop = (event) => {
			if (!isFileDrag(event)) return;
			event.preventDefault();
			clear();
			importFiles.current(event.dataTransfer.files);
		};
		// Capture phase: seen even when the element under the pointer handles the drop itself.
		const dropped = () => clear();
		window.addEventListener("dragover", over);
		window.addEventListener("dragleave", leave);
		window.addEventListener("drop", drop);
		window.addEventListener("drop", dropped, true);
		window.addEventListener("dragend", clear, true);
		return () => {
			clearTimeout(idle);
			window.removeEventListener("dragover", over);
			window.removeEventListener("dragleave", leave);
			window.removeEventListener("drop", drop);
			window.removeEventListener("drop", dropped, true);
			window.removeEventListener("dragend", clear, true);
		};
	}, []);

const send = async (mode) => {
		if (state.restarting || !state.connected || !canSendToActive()) return;
		const quotePrefix = formatQuotes(quotes);
		const body = quotePrefix ? (text ? `${quotePrefix}\n\n${text}` : quotePrefix) : text;
		const value = body;
		if ((!value.trim() && images.length === 0) || sending || importing.current) return;
		if (!active && !value.trim() && images.length === 0) return;
		setSending(true);
		const target = { slot: activeSlot, mode: chatMode, sessionId };
		const attached = images.filter((item) => !item.path).map(({ mimeType, data, name }) => ({ mimeType, data, name }));
		const attachments = images.filter((item) => item.path).map((item) => ({ id: item.id ?? item.path, name: item.name, mime: item.mime ?? null, size: item.size ?? null, path: item.path }));
		const previousText = text;
		const previousImages = images;
		const previousQuotes = quotes;
		setText("");
		setImages([]);
		setQuotes([]);
		setHistoryIndex(-1);
		// What was written in the large editor is on its way: the editor folds back into the input under the conversation.
		if (expanded) collapse();
		const restore = () => {
			if (latest.current.sessionId === target.sessionId) {
				setText(previousText);
				setImages(previousImages);
				setQuotes(previousQuotes);
			} else if (target.sessionId) {
				const restored = { text: previousText, images: previousImages, quotes: previousQuotes };
				drafts.set(target.sessionId, restored);
				scheduleDraftSave({ ...target, ...restored });
			}
		};
		const result = await actions.submit(value, { images: attached, attachments, mode: mode || (active ? runMode : "auto"), onRejected: restore });
		setSending(false);
		if (!result.handled && !result.ok) restore();
		else if (target.sessionId) clearDraft(target);
	};

	// Capture and render now; the shared action delays queued delivery, not the user's bubble.
	const sendOrQueue = (mode) => send(mode);

	const onKeyDown = (event) => {
		if (event.isComposing || event.keyCode === 229) return;
		// Saved quote cards are only removed with the mouse on their own \u00d7: Backspace/Delete
		// in an empty input must never eat a card, so there is intentionally no handler here.
		if (menuOpen) {
			if (event.key === "ArrowDown") return event.preventDefault(), setSel((sel + 1) % suggestions.length);
			if (event.key === "ArrowUp") return event.preventDefault(), setSel((sel - 1 + suggestions.length) % suggestions.length);
			const picked = suggestions[sel];
			// Enter confirms and runs the highlighted command (an "@" file has nothing to run, so it is inserted); Tab only completes.
			if (event.key === "Tab") return event.preventDefault(), applySuggestion(picked);
			if (event.key === "Enter" && !event.shiftKey) return event.preventDefault(), confirmSuggestion(picked);
			if (event.key === "Escape") return event.preventDefault(), setDismissed(tokenKey);
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			// Alt+Enter always queues; plain Enter follows the runMode default (followUp).
			sendOrQueue(event.altKey && active ? "followUp" : undefined);
			return;
		}
		// In the large editor Esc closes it (a window listener does that), never stops the run.
		if (event.key === "Escape" && expanded) return;
		if (event.key === "Escape" && active && !text) {
			event.preventDefault();
			actions.stop();
			return;
		}
		if (event.key === "ArrowUp" && !text.slice(0, caret).includes("\n") && (historyIndex >= 0 || !text)) {
			const next = Math.min(history.length - 1, historyIndex + 1);
			if (next >= 0 && history[history.length - 1 - next] !== undefined) {
				event.preventDefault();
				setHistoryIndex(next);
				setText(history[history.length - 1 - next]);
			}
			return;
		}
		if (event.key === "ArrowDown" && historyIndex >= 0 && !text.slice(caret).includes("\n")) {
			event.preventDefault();
			const next = historyIndex - 1;
			setHistoryIndex(next);
			setText(next >= 0 ? history[history.length - 1 - next] : "");
		}
	};

	// A saved card pops in the screen centre; only its note is editable. The grow direction
	// points back at the clicked card, but the window itself never travels across the screen:
	// only transform + opacity animate (GPU), so there is no top/left/width layout judder.
	const openEdit = (q, e) => {
		const rect = e?.currentTarget?.closest?.(".quote-card")?.getBoundingClientRect();
		if (rect) {
			const cx = window.innerWidth / 2;
			const cy = window.innerHeight / 2;
			setEditFrom({ origin: `${rect.left + rect.width / 2 < cx ? "0%" : "100%"} ${rect.top + rect.height / 2 < cy ? "0%" : "100%"}` });
		} else setEditFrom(null);
		setEditingId(q.id);
		setEditNote(q.note || "");
		setEditCentered(false);
		requestAnimationFrame(() => setEditCentered(true));
		setTimeout(() => editArea.current?.focus(), 140);
	};
	const closeEdit = () => {
		setEditingId(null);
		setEditNote("");
		setEditFrom(null);
		setEditCentered(false);
	};
	const saveEdit = () => {
		if (!editingId) return;
		const next = editNote.trim();
		setQuotes((prev) => prev.map((q) => (q.id === editingId ? { ...q, note: next } : q)));
		closeEdit();
		setTimeout(() => area.current?.focus(), 0);
	};
	const onEditKey = (e) => {
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), closeEdit();
		// Enter here only writes the note back to its card, never sends the message.
		if (e.key === "Enter" && !e.shiftKey) return e.preventDefault(), e.stopPropagation(), saveEdit();
	};
	const editing = editingId ? quotes.find((q) => q.id === editingId) : null;
	const editStyle = {
		top: "50%",
		left: "50%",
		width: "min(420px, calc(100vw - 48px))",
		transform: editCentered ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.86)",
		opacity: editCentered ? "1" : "0",
		transformOrigin: editFrom?.origin || "50% 50%",
	};

	const canSend = !switching && !restarting && connected && (text.trim() || images.length || quotes.length) && !sending && !loadingFiles && !busyCompact && !(noModel && !text.trim().startsWith("/") && !text.trim().startsWith("!"));
	const showStop = active && !text.trim() && images.length === 0 && quotes.length === 0;
	// The input box's stop ends everything, the sub-agents included; the activity bar's stop ends only sub-agents.
	const stopTitle = subAgentsRunning ? t("Stop the run and all sub-agents (Esc)") : t("Stop the current run (Esc)");
	const placeholder = noModel ? t("Add a provider in Settings to start…") : active ? t("Add to the running task… (Enter: {action})", { action: t(RUN_MODES[runMode].label) }) : t("Ask MyHarness to work on something…  / commands · @ files · ! shell");
	// A narrow input box shows the short form, so the / @ ! hints stay readable (composer.css, @container composer-input).
	const placeholderShort = noModel || active ? undefined : t("Ask MyHarness…  / commands · @ files · ! shell");

	return html`<div class="composer-zone">
		<div class="composer-col">
			<${StatusStrips} snap=${snap} />
			<${SubAgentBar} />
			<${QueueChips} queue=${queue} outbox=${outbox} />
			${dialogs.map((dialog) => html`<${DialogBar} key=${dialog.id} dialog=${dialog} />`)}
			<${CommandPanel} />
			${Object.values(surface.widgets || {}).filter((w) => w.placement === "aboveEditor").map((w, i) => html`<pre class="widget" key=${`wa${i}`}>${w.lines.join("\n")}</pre>`)}
			<div class="composer-env">
				${snap?.cwd ? html`<span class="env-chip" title=${`${t("Workspace folder")}: ${snap.cwd}`}><${Icon} name="folder" size=${12} /><span class="truncate">${snap.cwd}</span></span>` : null}
				${gitStatus?.isRepository ? html`<${BranchChip} gitStatus=${gitStatus} />` : null}
				${gitStatus?.isRepository && gitStatus.linkedWorktree ? html`<${MergeBackChip} gitStatus=${gitStatus} />` : null}
				${snap?.trust && !snap.trust.trusted && snap.trust.requiresTrust ? html`<button class="env-chip warn" onClick=${() => setView({ settingsOpen: true, settingsSection: "safety" })} title=${t("Project resources are ignored until the project is trusted")}><${Icon} name="shield" size=${12} />${t("Untrusted project")}</button>` : null}
				${Object.entries(surface.statuses || {}).map(([key, value]) => html`<span class="env-status truncate" key=${key}>${value}</span>`)}
			</div>
			${expanded ? html`<div class="composer-ghost" ref=${ghostBox} style=${{ height: `${ghost.current}px` }} /><div class=${`composer-scrim ${closing ? "leaving" : ""}`} onMouseDown=${collapse} />` : null}
			<div ref=${card} class=${`composer ${dragOver ? "drag" : ""} ${active ? "running" : ""} ${expanded ? "expanded" : ""} ${closing ? "leaving" : ""} ${morphing ? "morphing" : ""} ${tall || expanded ? "has-expand" : ""}`}
				role=${expanded ? "dialog" : undefined} aria-modal=${expanded ? "true" : undefined} aria-label=${expanded ? t("Message editor") : undefined}>
				${expanded
					? html`<button class="icon-btn sm composer-expand" onClick=${collapse} title=${t("Collapse (Esc)")} aria-label=${t("Collapse the editor")}><${Icon} name="minimize" size=${14} /></button>`
					: tall
						? html`<button class="icon-btn sm composer-expand fade-in" onClick=${expand} title=${t("Expand the editor")} aria-label=${t("Expand the editor")}><${Icon} name="maximize" size=${14} /></button>`
						: null}
				${suggestPresence.mounted ? html`<div class=${`suggest ${menuOpen ? "" : "closing"}`} role="listbox" ref=${suggestList}>${lastSuggestItems.current.map((item, i) => html`<button key=${item.key} role="option" aria-selected=${i === sel} class=${`suggest-item ${i === sel ? "sel" : ""}`} onMouseMove=${(e) => i !== sel && pointerMoved(e) && setSel(i)} onMouseDown=${(e) => (e.preventDefault(), confirmSuggestion(item))}>
					${item.icon ? html`<${Icon} name=${item.icon} size=${14} />` : null}<span class="mono">${item.label}</span>${item.tag ? html`<span class="badge">${item.tag}</span>` : null}${item.hint ? html`<span class="dim truncate">${item.hint}</span>` : null}</button>`)}</div>` : null}
				${quotes.length ? html`<div class="quote-shelf">${quotes.map((q, i) => html`<div
					class="quote-card"
					key=${q.id}
					title=${q.note ? `${q.note}\n\n${q.text}` : q.text}
					role="button"
					tabindex="0"
					aria-label=${t("Edit quote note")}
					onClick=${(e) => openEdit(q, e)}
					onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEdit(q, e); } }}
				>
					<button class="quote-card-x" aria-label=${t("Remove quote")} title=${t("Remove quote")} onClick=${(e) => (e.stopPropagation(), setQuotes(quotes.filter((_, j) => j !== i)))}><${Icon} name="x" size=${10} /></button>
					<span class="quote-card-src"><${Icon} name="quote" size=${11} /><span class="truncate">${clipLine(q.text, 44)}</span></span>
					${q.note ? html`<span class="quote-card-note truncate">${q.note}</span>` : null}
				</div>`)}</div>` : null}
				${editing ? html`<div class="quote-edit-scrim" onMouseDown=${(e) => { if (e.target === e.currentTarget) closeEdit(); }}>
					<div class="quote-edit-pop" style=${editStyle} role="dialog" aria-modal="true" aria-label=${t("Edit quote note")}>
						<div class="quote-edit-src"><${Icon} name="quote" size=${11} /><span class="truncate">${clipLine(editing.text, 60)}</span></div>
						<textarea
							ref=${editArea}
							class="quote-edit-input"
							rows="3"
							value=${editNote}
							placeholder=${t("Add a note about this passage (optional)")}
							onInput=${(e) => setEditNote(e.target.value)}
							onKeyDown=${onEditKey}
						></textarea>
						<div class="quote-edit-bar">
							<span class="grow" />
							<button class="icon-btn sm quote-tool quote-note-save" onClick=${saveEdit} title=${t("Save quote")} aria-label=${t("Save quote")}><${Icon} name="enter" size=${13} /></button>
						</div>
					</div>
				</div>` : null}
				${images.length ? html`<div class="attachments">${images.map((img, i) => {
					// Only an image opens the preview: a file chip (it has a path) stays exactly as it was. The × removes, never previews (stopPropagation here, guard in the thumb handlers).
					const zoomable = !img.path;
					const open = (e) => { if (e.target.closest(".thumb-x")) return; openImageLightbox(img.url, img.name); };
					const onKey = (e) => { if (e.target.closest(".thumb-x")) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openImageLightbox(img.url, img.name); } };
					return html`<div class="thumb" key=${i} role=${zoomable ? "button" : undefined} tabindex=${zoomable ? 0 : undefined} aria-label=${zoomable ? t("Preview image {name}", { name: img.name }) : undefined} onClick=${zoomable ? open : undefined} onKeyDown=${zoomable ? onKey : undefined}>${img.path ? html`<span class="file-attachment" title=${img.path}><${Icon} name="file" size=${18} /><span class="truncate">${img.name}</span></span>` : html`<img src=${img.url} alt=${img.name} />`}<button class="thumb-x" aria-label=${t("Remove attachment")} onClick=${(e) => { e.stopPropagation(); setImages(images.filter((_, j) => j !== i)); }}><${Icon} name="x" size=${11} /></button></div>`;
				})}</div>` : null}
				${loadingFiles ? html`<div class="branch-note dim" role="status"><${Spinner} />${t("Loading files…")}</div>` : null}
				<${DraftEditor} apiRef=${area} class="composer-input" value=${text} placeholder=${placeholder} placeholderShort=${placeholderShort}
					onChange=${(value, at) => (setText(slashStart(value)), setCaret(at))}
					onSelect=${setCaret}
					onKeyDown=${onKeyDown}
					onPaste=${(e) => {
						const files = [...(e.clipboardData?.files || [])];
						if (files.some((f) => f.type.startsWith("image/"))) {
							e.preventDefault();
							addFiles(files);
						}
					}} />
				<div class="composer-bar">
					<${Menu} placement="top" trigger=${({ toggle }) => html`<button class="icon-btn" title=${t("Attach or insert")} aria-label=${t("Attach or insert")} onClick=${toggle}><${Icon} name="plus" size=${17} /></button>`}>
						${(close) => html`
							<${MenuItem} icon="file" label=${t("Add files")} disabled=${loadingFiles} onClick=${() => { close(); if (fileInput.current) { fileInput.current.accept = ""; fileInput.current.click(); } }}  />
							<${MenuItem} icon="folder" label=${t("Add folder")} disabled=${loadingFiles} onClick=${() => { close(); folderInput.current?.click(); }}  />`}
					<//>
					<input ref=${fileInput} type="file" multiple hidden onChange=${(e) => (addFiles(e.target.files), (e.target.value = ""))} />
					<input ref=${folderInput} type="file" multiple hidden webkitdirectory directory onChange=${(e) => (addFiles(e.target.files), (e.target.value = ""))} />
					<span class="grow" />
					<${ModelPicker} />
					<${MainEffortPicker} />
					<${ContextMeter} />
					${showStop
						? stopping
							? html`<button class="send stop" disabled title=${t("Stopping…")} aria-label=${t("Stopping…")}><${Spinner} /></button>`
							: html`<button class="send stop" onClick=${actions.stop} title=${stopTitle} aria-label=${t("Stop")}><${Icon} name="stop" size=${13} /></button>`
						: html`<button class=${`send ${canSend ? "ready" : ""}`} disabled=${!canSend} onClick=${() => sendOrQueue()} title=${switching ? t("Loading…") : active ? t("{long} (Enter)", { long: t(RUN_MODES[runMode].long) }) : t("Send (Enter)")} aria-label=${t("Send")}><${Icon} name="arrowUp" size=${16} sw=${2.2} /></button>`}
				</div>
			</div>
			${Object.values(surface.widgets || {}).filter((w) => w.placement === "belowEditor").map((w, i) => html`<pre class="widget" key=${`wb${i}`}>${w.lines.join("\n")}</pre>`)}
		</div>
	</div>`;
}
