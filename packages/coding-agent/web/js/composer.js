// Composer: one stable input card. Model and effort are one click away; running-state choices
// (steer / queue / interrupt) map onto the real AgentSession mechanisms.
import { html, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Menu, MenuItem, MenuSep, Popover, Spinner } from "./ui.js";
import { api, attempt, loadModels, loadResources, loadSnapshot, post, setView, state, toast, useStore } from "./store.js";
import { actions, INTERACTIVE_COMMANDS, openCommand } from "./actions.js";
import { CommandPanel } from "./command-panel.js";
import { ContextMeter } from "./context-usage.js";
import { clip, debounce, effortHint, effortName, fmtTokens, plural } from "./util.js";
import { N_, serverText, t } from "./i18n.js";

const drafts = new Map();
const RUN_MODES = {
	steer: { label: N_("Steer"), long: N_("Steer the current run"), hint: N_("Delivered before the agent's next model step, after its current tool calls.") },
	followUp: { label: N_("Queue"), long: N_("Queue for after this run"), hint: N_("Waits until the agent has finished all of its work.") },
	interrupt: { label: N_("Interrupt"), long: N_("Interrupt and send"), hint: N_("Stops the current run right away, then sends this message.") },
};

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
	return html`<div class="dialog-bar fade-in" role="alertdialog" aria-label=${head}>
		<div class="dialog-head"><${Icon} name="alertCircle" size=${15} class="c-warn" /><strong class="grow">${head}</strong>${left != null ? html`<span class="dim">${left}s</span>` : null}</div>
		${rest || dialog.message ? html`<div class="dialog-msg">${[rest, dialog.message].filter(Boolean).join("\n")}</div>` : null}
		${dialog.kind === "confirm"
			? html`<div class="dialog-actions"><button class="btn sm" onClick=${() => answer(false)}>${t("Deny")}</button><button class="btn sm primary" autofocus onClick=${() => answer(true)}>${t("Allow")}</button></div>`
			: dialog.kind === "select"
				? html`<div class="dialog-options">${dialog.options.map((option) => html`<button class="btn sm" key=${option} onClick=${() => answer(option)}>${option}</button>`)}<button class="btn sm ghost" onClick=${() => answer(undefined)}>${t("Cancel")}</button></div>`
				: dialog.kind === "input"
					? html`<form class="dialog-input" onSubmit=${(e) => (e.preventDefault(), answer(value))}><input class="field grow" autofocus value=${value} placeholder=${dialog.placeholder || ""} onInput=${(e) => setValue(e.target.value)} /><button class="btn sm ghost" type="button" onClick=${() => answer(undefined)}>${t("Cancel")}</button><button class="btn sm primary" type="submit">${t("Submit")}</button></form>`
					: html`<div class="dialog-editor"><textarea class="field" rows="6" autofocus value=${value} onInput=${(e) => setValue(e.target.value)} /><div class="dialog-actions"><button class="btn sm ghost" onClick=${() => answer(undefined)}>${t("Cancel")}</button><button class="btn sm primary" onClick=${() => answer(value)}>${t("Submit")}</button></div></div>`}
	</div>`;
}

function StatusStrips({ snap }) {
	const compaction = useStore((s) => s.compaction);
	const retry = useStore((s) => s.retry);
	const recovery = useStore((s) => s.recovery);
	const gitTask = useStore((s) => s.gitTask);
	const completion = useStore((s) => s.completion);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!retry) return undefined;
		const timer = setInterval(() => setTick((n) => n + 1), 500);
		return () => clearInterval(timer);
	}, [retry]);
	const strips = [];
	if (compaction) strips.push(html`<div class="strip" key="c"><${Spinner} /> <span>${t("Compacting context ({reason})…", { reason: compaction.reason })}</span><button class="link-btn" onClick=${actions.stop}>${t("Cancel")}</button></div>`);
	if (retry) {
		const remaining = Math.max(0, Math.ceil((retry.at + retry.delayMs - Date.now()) / 1000));
		strips.push(html`<div class="strip warn" key="r"><${Spinner} /> <span>${t("Provider error — retrying ({attempt}/{maxAttempts}) in {remaining}s: {clip}", { attempt: retry.attempt, maxAttempts: retry.maxAttempts, remaining, clip: clip(retry.errorMessage, 120) })}</span><button class="link-btn" onClick=${() => post("/api/abort-retry")}>${t("Cancel retry")}</button></div>`);
	}
	if (recovery) strips.push(html`<div class="strip warn" key="v"><${Spinner} /> <span>${recovery.kind === "new-conversation" ? t("Recovering by rebuilding the conversation (#{conversation})", { conversation: recovery.conversation }) : t("Recovering from a provider problem ({attempt}/{budget})", { attempt: recovery.attempt, budget: recovery.budget })}: ${clip(recovery.errorMessage, 100)}</span></div>`);
	if (gitTask) strips.push(html`<div class="strip" key="g"><${Spinner} /> <span>${serverText(gitTask.activity, t("Working…"))}</span><button class="link-btn" onClick=${() => post("/api/git/task/abort")}>${t("Cancel")}</button></div>`);
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

function ChangesPill() {
	const lastRun = useStore((s) => s.snap?.lastRun);
	const active = useStore((s) => s.snap?.active);
	const [stats, setStats] = useState(null);
	useEffect(() => {
		let cancelled = false;
		setStats(null);
		if (!lastRun || !lastRun.changeCount) return undefined;
		api(`/api/changes?scope=run&runId=${lastRun.runId}`)
			.then((data) => {
				if (cancelled) return;
				setStats({ files: data.total, add: data.files.reduce((n, f) => n + f.additions, 0), del: data.files.reduce((n, f) => n + f.deletions, 0) });
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [lastRun?.runId, lastRun?.changeCount]);
	if (active || !lastRun || !lastRun.changeCount) return null;
	return html`<button class="changes-pill fade-in" onClick=${() => actions.openChanges({ runId: lastRun.runId })} title=${t("Review what the last task changed")}>
		<${Icon} name="fileDiff" size=${14} /><span>${t("{plural} changed", { plural: plural(stats?.files ?? lastRun.changeCount, "file") })}</span>
		${stats ? html`<span class="add">+${stats.add}</span><span class="del">−${stats.del}</span>` : null}
		${lastRun.uncommitted ? html`<span class="badge warn">${t("uncommitted")}</span>` : null}
	</button>`;
}

// ---- Model & effort pickers ------------------------------------------------------------------------
function ModelPicker() {
	const snap = useStore((s) => s.snap);
	const models = useStore((s) => s.models);
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (open) loadModels(false);
	}, [open]);
	const model = snap?.model;
	const running = !!snap?.active;
	const q = query.trim().toLowerCase();
	const groups = (models?.providers || [])
		.map((provider) => ({ ...provider, models: provider.models.filter((m) => !q || `${provider.name} ${m.id} ${m.name}`.toLowerCase().includes(q)) }))
		.filter((provider) => provider.models.length);
	const choose = async (m) => {
		setBusy(true);
		const ok = await attempt(() => post("/api/model", { provider: m.provider, id: m.id }));
		setBusy(false);
		if (ok) {
			setOpen(false);
			await attempt(loadSnapshot, { quiet: true });
		}
	};
	return html`<span ref=${anchor} class="picker-anchor">
		<button class="chip" onClick=${() => setOpen(!open)} title=${running ? t("Models can be switched when the agent is idle") : t("Switch model")} aria-haspopup="menu" aria-expanded=${open}>
			<${Icon} name="cpu" size=${14} /><span class="truncate chip-text">${model ? model.name || model.id : t("No model")}</span><${Icon} name="chevronDown" size=${12} />
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" width=${380} maxHeight=${460}>
			<div class="pop-search"><${Icon} name="search" size=${14} /><input autofocus placeholder=${t("Search models…")} value=${query} onInput=${(e) => setQuery(e.target.value)} /></div>
			<div class="pop-scroll">
				${!models ? html`<div class="empty"><${Spinner} /></div>` : null}
				${groups.map((provider) => html`<div key=${provider.id}>
					<div class="pop-group">${provider.name}</div>
					${provider.models.map((m) => html`<button class=${`pop-item ${model && model.provider === m.provider && model.id === m.id ? "active" : ""}`} key=${m.id} disabled=${busy || running} onClick=${() => choose(m)}>
						<span class="truncate grow">${m.name || m.id}</span>
						${m.reasoning ? html`<span class="badge" title=${t("Supports reasoning")}>${t("reasoning")}</span>` : null}
						${m.input.includes("image") ? html`<span class="badge" title=${t("Accepts images")}>${t("image")}</span>` : null}
						<span class="dim pop-meta">${fmtTokens(m.contextWindow)}</span>
						${model && model.provider === m.provider && model.id === m.id ? html`<${Icon} name="check" size=${14} />` : null}
					</button>`)}
				</div>`)}
				${models && !groups.length ? html`<div class="empty">${models.providers.length ? t("No models match.") : t("No model is available. Add a provider in Settings.")}</div>` : null}
			</div>
			<div class="pop-foot">
				<button class="link-btn" onClick=${() => loadModels(true)}>${t("Refresh catalog")}</button>
				<button class="link-btn" onClick=${() => (setOpen(false), setView({ settingsOpen: true, settingsSection: "providers" }))}>${t("Manage providers…")}</button>
			</div>
		<//>
	</span>`;
}

function EffortPicker() {
	const snap = useStore((s) => s.snap);
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	const thinking = snap?.thinking;
	if (!thinking || !thinking.supported) return null;
	const choose = async (level) => {
		setOpen(false);
		await attempt(() => post("/api/thinking", { level }));
	};
	return html`<span ref=${anchor} class="picker-anchor">
		<button class="chip" onClick=${() => setOpen(!open)} title=${t("Reasoning effort")} aria-haspopup="menu" aria-expanded=${open}>
			<${Icon} name="brain" size=${14} /><span class="chip-text">${effortName(thinking.level)}</span><${Icon} name="chevronDown" size=${12} />
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" width=${240}>
			<div class="pop-group">${t("Reasoning effort")}</div>
			${thinking.levels.map((level) => html`<button class=${`pop-item ${thinking.level === level ? "active" : ""}`} key=${level} onClick=${() => choose(level)}><span class="grow">${effortName(level)}</span><span class="dim">${effortHint(level)}</span>${thinking.level === level ? html`<${Icon} name="check" size=${14} />` : null}</button>`)}
		<//>
	</span>`;
}

// ---- Suggestion popovers (/ commands and @ files) --------------------------------------------------------
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
			const q = token.query.toLowerCase();
			return (resources?.commands || [])
				.filter((c) => c.name.toLowerCase().includes(q))
				.sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
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
	const sessionId = snap?.session?.id;
	const active = !!snap?.active;
	const busyCompact = !!snap?.flags?.compacting;
	const noModel = !snap?.model;
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [images, setImages] = useState([]);
	const [runMode, setRunMode] = useState("steer");
	const [sending, setSending] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [sel, setSel] = useState(0);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const area = useRef(null);
	const fileInput = useRef(null);
	const lastSession = useRef(null);
	const modeAnchor = useRef(null);
	const [modeOpen, setModeOpen] = useState(false);

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
	useLayoutEffect(() => {
		const el = area.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
	}, [text]);
	useEffect(() => {
		const onKey = (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
				event.preventDefault();
				area.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const { token, items: suggestions } = useSuggestions(text, caret);
	useEffect(() => setSel(0), [token?.type, token?.query]);
	const menuOpen = !!token && suggestions.length > 0;

	const history = useMemo(() => items.filter((i) => i.kind === "user" && i.text).map((i) => i.text), [items]);

	const applySuggestion = (item) => {
		const start = token.start;
		const next = `${text.slice(0, start)}${item.insert}${text.slice(caret)}`;
		setText(next);
		const pos = start + item.insert.length;
		setTimeout(() => {
			area.current?.focus();
			area.current?.setSelectionRange(pos, pos);
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
			// Commands with several levels of choices open their panel straight away; the others are completed for you to finish.
			if (event.key === "Enter" && !event.shiftKey && picked.command && INTERACTIVE_COMMANDS.has(picked.command)) return event.preventDefault(), setText(""), openCommand(picked.command);
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) return event.preventDefault(), applySuggestion(picked);
			if (event.key === "Escape") return event.preventDefault(), setText((t) => t + " ");
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			send(event.altKey && active ? "followUp" : undefined);
			return;
		}
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
	const placeholder = noModel ? t("Add a provider in Settings to start…") : active ? t("Add to the running task… (Enter: steer, Alt+Enter: queue)") : t("Ask MyHarness to work on something…  / commands · @ files · ! shell");

	return html`<div class="composer-zone">
		<div class="composer-col">
			<${ChangesPill} />
			<${StatusStrips} snap=${snap} />
			<${QueueChips} queue=${queue} />
			${dialogs.map((dialog) => html`<${DialogBar} key=${dialog.id} dialog=${dialog} />`)}
			<${CommandPanel} />
			${Object.values(surface.widgets || {}).filter((w) => w.placement === "aboveEditor").map((w, i) => html`<pre class="widget" key=${`wa${i}`}>${w.lines.join("\n")}</pre>`)}
			<div class=${`composer ${dragOver ? "drag" : ""} ${active ? "running" : ""}`}
				onDragOver=${(e) => (e.preventDefault(), setDragOver(true))} onDragLeave=${() => setDragOver(false)}
				onDrop=${(e) => (e.preventDefault(), setDragOver(false), addFiles(e.dataTransfer.files))}>
				${menuOpen ? html`<div class="suggest" role="listbox">${suggestions.map((item, i) => html`<button key=${item.key} role="option" aria-selected=${i === sel} class=${`suggest-item ${i === sel ? "sel" : ""}`} onMouseEnter=${() => setSel(i)} onMouseDown=${(e) => (e.preventDefault(), applySuggestion(item))}>
					${item.icon ? html`<${Icon} name=${item.icon} size=${14} />` : null}<span class="mono">${item.label}</span>${item.tag ? html`<span class="badge">${item.tag}</span>` : null}${item.hint ? html`<span class="dim truncate">${item.hint}</span>` : null}</button>`)}</div>` : null}
				${images.length ? html`<div class="attachments">${images.map((img, i) => html`<div class="thumb" key=${i}><img src=${img.url} alt=${img.name} /><button class="thumb-x" aria-label=${t("Remove image")} onClick=${() => setImages(images.filter((_, j) => j !== i))}><${Icon} name="x" size=${11} /></button></div>`)}</div>` : null}
				<textarea ref=${area} class="composer-input" rows="1" value=${text} placeholder=${placeholder} spellcheck="false"
					onInput=${(e) => (setText(e.target.value), setCaret(e.target.selectionStart))}
					onKeyUp=${(e) => setCaret(e.target.selectionStart)} onClick=${(e) => setCaret(e.target.selectionStart)}
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
							<${MenuItem} icon="image" label=${t("Attach image…")} onClick=${() => (close(), fileInput.current?.click())} />
							<${MenuItem} icon="file" label=${t("Mention a file")} hint="@" onClick=${() => (close(), setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@`), setTimeout(() => area.current?.focus(), 0))} />
							<${MenuItem} icon="terminal" label=${t("Run a shell command")} hint="!" onClick=${() => (close(), setText("!"), setTimeout(() => area.current?.focus(), 0))} />
							<${MenuItem} icon="bolt" label=${t("Slash commands & skills")} hint="/" onClick=${() => (close(), setText("/"), setTimeout(() => area.current?.focus(), 0))} />
							<${MenuSep} />
							<${MenuItem} icon="layers" label=${t("Compact context now")} disabled=${active} onClick=${() => (close(), actions.compact())} />`}
					<//>
					<input ref=${fileInput} type="file" accept="image/*" multiple hidden onChange=${(e) => (addFiles(e.target.files), (e.target.value = ""))} />
					<${ModelPicker} />
					<${EffortPicker} />
					<span class="grow" />
					<${ContextMeter} />
					${active
						? html`<button ref=${modeAnchor} class="mode-btn" title=${`${t(RUN_MODES[runMode].long)}: ${t(RUN_MODES[runMode].hint)}`} onClick=${() => setModeOpen(!modeOpen)} aria-haspopup="menu" aria-expanded=${modeOpen}>${t(RUN_MODES[runMode].label)}<${Icon} name="chevronUp" size=${11} /></button>
						<${Popover} anchor=${modeAnchor} open=${modeOpen} onClose=${() => setModeOpen(false)} placement="top" align="end" width=${320}>
							${Object.entries(RUN_MODES).map(([key, info]) => html`<button class=${`pop-item two-line ${runMode === key ? "active" : ""}`} key=${key} onClick=${() => (setRunMode(key), setModeOpen(false))}><span class="col grow"><span>${t(info.long)}</span><span class="dim">${t(info.hint)}</span></span>${runMode === key ? html`<${Icon} name="check" size=${14} />` : null}</button>`)}
						<//>` : null}
					${showStop
						? html`<button class="send stop" onClick=${actions.stop} title=${t("Stop the current run (Esc)")} aria-label=${t("Stop")}><${Icon} name="stop" size=${13} sw=${0} style="fill:currentColor" /></button>`
						: html`<button class=${`send ${canSend ? "ready" : ""}`} disabled=${!canSend} onClick=${() => send()} title=${active ? t("{long} (Enter)", { long: t(RUN_MODES[runMode].long) }) : t("Send (Enter)")} aria-label=${t("Send")}><${Icon} name="arrowUp" size=${16} sw=${2.2} /></button>`}
				</div>
			</div>
			${Object.values(surface.widgets || {}).filter((w) => w.placement === "belowEditor").map((w, i) => html`<pre class="widget" key=${`wb${i}`}>${w.lines.join("\n")}</pre>`)}
			<div class="composer-foot dim">
				<button class="foot-btn truncate" onClick=${() => actions.togglePanel("files")} title=${t("Workspace folder")}><${Icon} name="folder" size=${12} /><span class="truncate">${snap?.cwd || ""}</span></button>
				${gitStatus?.isRepository && gitStatus.branch ? html`<button class="foot-btn" onClick=${() => actions.openChanges({ git: true })} title=${t("Git branch")}><${Icon} name="gitBranch" size=${12} />${gitStatus.branch}${gitStatus.preview?.total ? html`<span class="badge warn">${gitStatus.preview.total}</span>` : null}</button>` : null}
				${snap && !snap.trust.trusted && snap.trust.requiresTrust ? html`<button class="foot-btn warn" onClick=${() => setView({ settingsOpen: true, settingsSection: "safety" })} title=${t("Project resources are ignored until the project is trusted")}><${Icon} name="shield" size=${12} />${t("Untrusted project")}</button>` : null}
				${Object.entries(surface.statuses || {}).map(([key, value]) => html`<span class="foot-status truncate" key=${key}>${value}</span>`)}
			</div>
		</div>
	</div>`;
}
