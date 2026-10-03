// Composer: one stable input card. Model and effort are one click away; a message sent while the agent runs follows the
// default chosen in Settings (steer / queue / interrupt, see run-modes.js), Alt+Enter queues it.
import { html, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Chevron, Collapse, Icon, Menu, MenuItem, MenuSep, Popover, Spinner } from "./ui.js";
import { api, attempt, chooseThinkingLevel, loadGitStatus, loadModels, loadResources, loadSnapshot, post, setView, state, toast, useStore } from "./store.js";
import { actions } from "./actions.js";
import { CommandPanel } from "./command-panel.js";
import { DraftEditor } from "./draft-editor.js";
import { BranchChip } from "./branch-menu.js";

import { ContextMeter } from "./context-usage.js";
import { EffortPicker, ModelMenu } from "./model-menu.js";
import { rankSearch } from "./search.js";
import { clip, debounce, fmtDuration, plural, pointerMoved } from "./util.js";
import { serverText, t } from "./i18n.js";
import { RUN_MODES, runModeOf } from "./run-modes.js";

const drafts = new Map();

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
	const answer = (v) => attempt(() => post("/api/ui/respond", { id: dialog.id, value: v }), { quiet: false });
	const lines = String(dialog.title || "").split("\n");
	const head = lines[0];
	const rest = lines.slice(1).join("\n");
	return html`<div class="dialog-bar fade-in" role="alertdialog" aria-label=${head} ref=${root} tabindex="-1" onKeyDown=${onChoiceKey}>
		<div class="dialog-head"><${Icon} name="alertCircle" size=${15} class="c-warn" /><strong class="grow">${head}</strong>${left != null ? html`<span class="dim">${left}s</span>` : null}</div>
		${rest || dialog.message ? html`<div class="dialog-msg">${[rest, dialog.message].filter(Boolean).join("\n")}</div>` : null}
		${dialog.kind === "confirm"
			? html`<div class="dialog-actions"><button class=${`btn sm ${pick === 0 ? "kbd-sel" : ""}`} tabindex="-1" onClick=${() => answer(false)} onMouseMove=${() => setPick(0)}>${t("Deny")}</button><button class=${`btn sm primary ${pick === 1 ? "kbd-sel" : ""}`} tabindex="-1" onClick=${() => answer(true)} onMouseMove=${() => setPick(1)}>${t("Allow")}</button></div><div class="dialog-keys dim">${t("←/→ choose · Enter answer · Esc deny · Alt+A focus here")}</div>`
			: dialog.kind === "select"
				? html`<div class="dialog-options">${dialog.options.map((option, i) => html`<button class=${`btn sm ${pick === i ? "kbd-sel" : ""}`} tabindex="-1" key=${option} onClick=${() => answer(option)} onMouseMove=${() => setPick(i)}>${i < 9 ? html`<span class="dim">${i + 1}</span> ` : null}${option}</button>`)}<button class=${`btn sm ghost ${pick === dialog.options.length ? "kbd-sel" : ""}`} tabindex="-1" onClick=${() => answer(undefined)} onMouseMove=${() => setPick(dialog.options.length)}>${t("Cancel")}</button></div><div class="dialog-keys dim">${t("↑/↓ choose · Enter answer · 1-9 pick · Esc cancel · Alt+A focus here")}</div>`
				: dialog.kind === "input"
					? html`<form class="dialog-input" onSubmit=${(e) => (e.preventDefault(), answer(value))}><input class="field sm grow" autofocus value=${value} placeholder=${dialog.placeholder || ""} onInput=${(e) => setValue(e.target.value)} /><button class="btn sm ghost" type="button" onClick=${() => answer(undefined)}>${t("Cancel")}</button><button class="btn sm primary" type="submit">${t("Submit")}</button></form>`
					: html`<div class="dialog-editor"><textarea class="field" rows="6" autofocus value=${value} onInput=${(e) => setValue(e.target.value)} /><div class="dialog-actions"><button class="btn sm ghost" onClick=${() => answer(undefined)}>${t("Cancel")}</button><button class="btn sm primary" onClick=${() => answer(value)}>${t("Submit")}</button></div></div>`}
	</div>`;
}

function StatusStrips({ snap }) {
	const compaction = useStore((s) => s.compaction);
	const retry = useStore((s) => s.retry);
	const recovery = useStore((s) => s.recovery);
	const completion = useStore((s) => s.completion);
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
		strips.push(html`<div class="strip warn" key="r"><${Spinner} /> <span>${t("Provider error — retrying ({attempt}/{maxAttempts}) in {remaining}s: {clip}", { attempt: retry.attempt, maxAttempts: retry.maxAttempts, remaining, clip: clip(retry.errorMessage, 120) })}</span><button class="link-btn" onClick=${() => post("/api/abort-retry")}>${t("Cancel retry")}</button></div>`);
	}
	if (recovery) strips.push(html`<div class="strip warn" key="v"><${Spinner} /> <span>${recovery.kind === "new-conversation" ? t("Recovering by rebuilding the conversation (#{conversation})", { conversation: recovery.conversation }) : t("Recovering from a provider problem ({attempt}/{budget})", { attempt: recovery.attempt, budget: recovery.budget })}: ${clip(recovery.errorMessage, 100)}</span></div>`);
	if (completion && !snap?.active) strips.push(html`<div class="strip" key="f"><${Spinner} /> <span>${t("Finalizing the task (checking changes, memory)…")}</span></div>`);
	void tick;
	return strips.length ? html`<div class="strips">${strips}</div>` : null;
}

function QueueChips({ queue }) {
	const n = queue.steering.length + queue.followUp.length;
	if (!n) return null;
	return html`<div class="queue">
		<div class="queue-head dim"><${Icon} name="clock" size=${13} /> ${t("{plural} waiting", { plural: plural(n, "message") })} <button class="link-btn" onClick=${actions.clearQueue}>${t("Move back to editor")}</button></div>
		${queue.steering.map((text, i) => html`<div class="queue-item" key=${`s${i}`}><span class="badge accent">${t("steer")}</span><span class="truncate">${text}</span></div>`)}
		${queue.followUp.map((text, i) => html`<div class="queue-item" key=${`f${i}`}><span class="badge">${t("after run")}</span><span class="truncate">${text}</span></div>`)}
	</div>`;
}

// ---- Model and thinking effort: two separate text chips, each opening its own small popover above itself ------
function ModelPicker() {
	const snap = useStore((s) => s.snap);
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
		<button class="chip" onClick=${() => setOpen(!open)} title=${running ? t("Models can be switched when the agent is idle") : t("Model")} aria-haspopup="listbox" aria-expanded=${open}>
			<span class="truncate chip-text">${model ? model.name || model.id : t("No model")}</span><${Chevron} />
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
	const dialogs = useStore((s) => s.dialogs);
	const surface = useStore((s) => s.surface);
	const editorInsert = useStore((s) => s.editorInsert);
	const items = useStore((s) => s.items);
	const gitStatus = useStore((s) => s.gitStatus);
	const activeSlot = useStore((s) => s.activeSlot);
	const sessionId = snap?.session?.id;
	const active = !!snap?.active;
	// The branch / worktree chips above the input: read when the folder or the chat on screen changes and after each run.
	useEffect(() => {
		if (snap?.cwd && !active) loadGitStatus();
	}, [snap?.cwd, active, activeSlot]);
	const busyCompact = !!snap?.flags?.compacting;
	const noModel = !snap?.model;
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [images, setImages] = useState([]);
	// What Enter does while the agent runs: the default chosen in Settings.
	const runMode = runModeOf(useStore((s) => s.view.runMode));
	const [sending, setSending] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [sel, setSel] = useState(0);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const area = useRef(null);
	const fileInput = useRef(null);
	const lastSession = useRef(null);
	// The command registry (names, aliases) is needed the moment a command is typed; load it up front.
	useEffect(() => {
		if (!state.resources) loadResources().catch(() => {});
	}, [sessionId]);

	// Drafts follow the session so switching chats does not lose typed text.
	useEffect(() => {
		if (lastSession.current !== null && lastSession.current !== sessionId) drafts.set(lastSession.current, { text, images });
		if (lastSession.current !== sessionId) {
			const draft = drafts.get(sessionId);
			setText(draft?.text || "");
			setImages(draft?.images || []);
			setHistoryIndex(-1);
		}
		lastSession.current = sessionId;
	}, [sessionId]);
	const touched = useRef(new Set());
	useEffect(() => {
		if (lastSession.current !== sessionId || (!text && !images.length) || touched.current.has(sessionId)) return;
		touched.current.add(sessionId);
		post("/api/sessions/touched", {}).catch(() => touched.current.delete(sessionId));
	}, [text, images, sessionId]);
	const latest = useRef({ text, images, sessionId });
	latest.current = { text, images, sessionId };
	useEffect(
		() => () => {
			const { text: t0, images: i0, sessionId: id } = latest.current;
			if (id) drafts.set(id, { text: t0, images: i0 });
		},
		[],
	);
	useEffect(() => {
		if (!editorInsert) return;
		setText((prev) => (editorInsert.replace || !prev ? editorInsert.text : `${prev}${prev.endsWith("\n") || !prev ? "" : "\n"}${editorInsert.text}`));
		setTimeout(() => area.current?.focus(), 0);
	}, [editorInsert?.nonce]);
	// More than three lines: an icon in the card's corner opens the same card as a large, centred editor.
	const [tall, setTall] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [closing, setClosing] = useState(false);
	const ghost = useRef(0);
	useLayoutEffect(() => {
		const el = area.current?.element;
		if (!el) return undefined;
		// Lines as seen on screen: a long line that wraps counts once per row, a heading once.
		const measure = () => {
			let lines = 0;
			for (const line of el.children) {
				const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight) || 20;
				lines += Math.max(1, Math.round(line.offsetHeight / lineHeight));
			}
			setTall(lines > 3);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [text]);
	const expand = () => {
		ghost.current = card.current?.offsetHeight || 0;
		setExpanded(true);
		setTimeout(() => area.current?.focus(), 0);
	};
	const collapse = () => {
		if (closing) return;
		setClosing(true);
		setTimeout(() => {
			setClosing(false);
			setExpanded(false);
			area.current?.focus();
		}, 180);
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
	useEffect(() => setExpanded(false), [sessionId]);
	useEffect(() => setSel(0), [token?.type, token?.query]);
	// Closing the list (Esc, a click outside the input card) only hides it for the token being typed; the draft is untouched.
	const tokenKey = token ? `${token.type}:${token.start}:${token.query}` : "";
	const [dismissed, setDismissed] = useState("");
	// A closed list stays closed only for that token: once the token is gone, typing "/" (or "@") opens the list again.
	useEffect(() => {
		if (dismissed && dismissed !== tokenKey) setDismissed("");
	}, [tokenKey]);
	const menuOpen = !!token && suggestions.length > 0 && dismissed !== tokenKey;
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
		suggestList.current?.children[sel]?.scrollIntoView({ block: "nearest" });
	}, [sel, menuOpen, suggestions.length]);

	const history = useMemo(() => items.filter((i) => i.kind === "user" && i.text).map((i) => i.text), [items]);

	/**
	 * Confirm a highlighted "/" command: run it now. Commands with several levels of choices open their panel; the rest
	 * are sent like typed text. (Tab only completes the name, see applySuggestion.)
	 */
	const runCommand = async (item) => {
		const value = `/${item.command}`;
		setText("");
		setHistoryIndex(-1);
		const result = await actions.submit(value, { mode: active ? runMode : "auto" });
		if (!result.handled && !result.ok) setText(value);
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

	const addFiles = async (fileList) => {
		const picked = [...fileList].filter((f) => f.type.startsWith("image/"));
		if (!picked.length) return;
		if (state.snap?.model && !state.snap.model.input.includes("image")) toast(t("The current model does not list image input; the image may be ignored or trigger the vision assistant if enabled."), "warning", 6000);
		try {
			const converted = await Promise.all(picked.map(fileToImage));
			setImages((prev) => [...prev, ...converted].slice(0, 12));
		} catch {
			toast(t("Could not read the image."), "error");
		}
	};

	const send = async (mode) => {
		const value = text;
		if ((!value.trim() && images.length === 0) || sending) return;
		if (!active && !value.trim() && images.length === 0) return;
		setSending(true);
		const attached = images.map(({ mimeType, data }) => ({ mimeType, data }));
		const previousText = text;
		const previousImages = images;
		setText("");
		setImages([]);
		setHistoryIndex(-1);
		const result = await actions.submit(value, { images: attached, mode: mode || (active ? runMode : "auto") });
		setSending(false);
		if (!result.handled && !result.ok) {
			setText(previousText);
			setImages(previousImages);
		}
	};

	const onKeyDown = (event) => {
		if (event.isComposing || event.keyCode === 229) return;
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
			send(event.altKey && active ? "followUp" : undefined);
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

	const canSend = (text.trim() || images.length) && !sending && !busyCompact && !(noModel && !text.trim().startsWith("/") && !text.trim().startsWith("!"));
	const showStop = active && !text.trim() && images.length === 0;
	const placeholder = noModel ? t("Add a provider in Settings to start…") : active ? t("Add to the running task… (Enter: {action})", { action: t(RUN_MODES[runMode].label) }) : t("Ask MyHarness to work on something…  / commands · @ files · ! shell");

	return html`<div class="composer-zone">
		<div class="composer-col">
			<${StatusStrips} snap=${snap} />
			<${QueueChips} queue=${queue} />
			${dialogs.map((dialog) => html`<${DialogBar} key=${dialog.id} dialog=${dialog} />`)}
			<${CommandPanel} />
			${Object.values(surface.widgets || {}).filter((w) => w.placement === "aboveEditor").map((w, i) => html`<pre class="widget" key=${`wa${i}`}>${w.lines.join("\n")}</pre>`)}
			<div class="composer-env">
				${snap?.cwd ? html`<span class="env-chip" title=${`${t("Workspace folder")}: ${snap.cwd}`}><${Icon} name="folder" size=${12} /><span class="truncate">${snap.cwd}</span></span>` : null}
				${gitStatus?.isRepository ? html`<${BranchChip} gitStatus=${gitStatus} />` : null}
				${snap && !snap.trust.trusted && snap.trust.requiresTrust ? html`<button class="env-chip warn" onClick=${() => setView({ settingsOpen: true, settingsSection: "safety" })} title=${t("Project resources are ignored until the project is trusted")}><${Icon} name="shield" size=${12} />${t("Untrusted project")}</button>` : null}
				${Object.entries(surface.statuses || {}).map(([key, value]) => html`<span class="env-status truncate" key=${key}>${value}</span>`)}
			</div>
			${expanded ? html`<div class="composer-ghost" style=${{ height: `${ghost.current}px` }} /><div class=${`composer-scrim ${closing ? "leaving" : ""}`} onMouseDown=${collapse} />` : null}
			<div ref=${card} class=${`composer ${dragOver ? "drag" : ""} ${active ? "running" : ""} ${expanded ? "expanded" : ""} ${closing ? "leaving" : ""} ${tall || expanded ? "has-expand" : ""}`}
				role=${expanded ? "dialog" : undefined} aria-modal=${expanded ? "true" : undefined} aria-label=${expanded ? t("Message editor") : undefined}
				onDragOver=${(e) => (e.preventDefault(), setDragOver(true))} onDragLeave=${() => setDragOver(false)}
				onDrop=${(e) => (e.preventDefault(), setDragOver(false), addFiles(e.dataTransfer.files))}>
				${expanded
					? html`<button class="icon-btn sm composer-expand" onClick=${collapse} title=${t("Collapse (Esc)")} aria-label=${t("Collapse the editor")}><${Icon} name="minimize" size=${14} /></button>`
					: tall
						? html`<button class="icon-btn sm composer-expand fade-in" onClick=${expand} title=${t("Expand the editor")} aria-label=${t("Expand the editor")}><${Icon} name="maximize" size=${14} /></button>`
						: null}
				${menuOpen ? html`<div class="suggest" role="listbox" ref=${suggestList}>${suggestions.map((item, i) => html`<button key=${item.key} role="option" aria-selected=${i === sel} class=${`suggest-item ${i === sel ? "sel" : ""}`} onMouseMove=${(e) => i !== sel && pointerMoved(e) && setSel(i)} onMouseDown=${(e) => (e.preventDefault(), confirmSuggestion(item))}>
					${item.icon ? html`<${Icon} name=${item.icon} size=${14} />` : null}<span class="mono">${item.label}</span>${item.tag ? html`<span class="badge">${item.tag}</span>` : null}${item.hint ? html`<span class="dim truncate">${item.hint}</span>` : null}</button>`)}</div>` : null}
				${images.length ? html`<div class="attachments">${images.map((img, i) => html`<div class="thumb" key=${i}><img src=${img.url} alt=${img.name} /><button class="thumb-x" aria-label=${t("Remove image")} onClick=${() => setImages(images.filter((_, j) => j !== i))}><${Icon} name="x" size=${11} /></button></div>`)}</div>` : null}
				<${DraftEditor} apiRef=${area} class="composer-input" value=${text} placeholder=${placeholder}
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
							<${MenuItem} icon="image" label=${t("Attach image")} onClick=${() => (close(), fileInput.current?.click())} />
							<${MenuItem} icon="file" label=${t("Mention a file")} hint="@" onClick=${() => (close(), setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@`), setTimeout(() => area.current?.focus(), 0))} />
							<${MenuItem} icon="terminal" label=${t("Run a shell command")} hint="!" onClick=${() => (close(), setText("!"), setTimeout(() => area.current?.focus(), 0))} />
							<${MenuItem} icon="bolt" label=${t("Slash commands & skills")} hint="/" onClick=${() => (close(), setText("/"), setTimeout(() => area.current?.focus(), 0))} />
							<${MenuSep} />
							<${MenuItem} icon="layers" label=${t("Compact context now")} disabled=${active} onClick=${() => (close(), actions.compact())} />`}
					<//>
					<input ref=${fileInput} type="file" accept="image/*" multiple hidden onChange=${(e) => (addFiles(e.target.files), (e.target.value = ""))} />
					<span class="grow" />
					<${ModelPicker} />
					<${MainEffortPicker} />
					<${ContextMeter} />
					${showStop
						? html`<button class="send stop" onClick=${actions.stop} title=${t("Stop the current run (Esc)")} aria-label=${t("Stop")}><${Icon} name="stop" size=${13} sw=${0} /></button>`
						: html`<button class=${`send ${canSend ? "ready" : ""}`} disabled=${!canSend} onClick=${() => send()} title=${active ? t("{long} (Enter)", { long: t(RUN_MODES[runMode].long) }) : t("Send (Enter)")} aria-label=${t("Send")}><${Icon} name="arrowUp" size=${16} sw=${2.2} /></button>`}
				</div>
			</div>
			${Object.values(surface.widgets || {}).filter((w) => w.placement === "belowEditor").map((w, i) => html`<pre class="widget" key=${`wb${i}`}>${w.lines.join("\n")}</pre>`)}
		</div>
	</div>`;
}
