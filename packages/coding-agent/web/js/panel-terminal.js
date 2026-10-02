// Terminal panel: a real shell in the chat's folder (terminal-session.js), and the list of every shell command of the
// chat (the agent's bash/pwsh tool and your own !commands) with its real output.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Segmented, Spinner, CopyButton } from "./ui.js";
import { api, setView, toast, useStore } from "./store.js";
import { actions } from "./actions.js";
import { openTerminalView } from "./terminal-session.js";
import { ansiSegments, clip, fmtDuration, shellOutcome, stripAnsi } from "./util.js";
import { t, N_, tNodes } from "./i18n.js";

function statusOf(entry) {
	if (entry.status === "running") return "running";
	if (entry.status === "error") return "error";
	if (entry.status === "cancelled") return "cancelled";
	if (entry.status === "timeout") return "timeout";
	if (entry.status === "failed") return "failed";
	if (entry.exitCode) return "failed";
	return "done";
}

/** Derive terminal entries from the transcript (history) plus live tool/bash state. */
export function terminalEntries(items, toolRuns, userBash, userBashOrder, cwd) {
	const results = new Map();
	for (const item of items) if (item.kind === "toolResult") results.set(item.toolCallId, item);
	const entries = [];
	for (const item of items) {
		if (item.kind === "assistant") {
			for (const block of item.blocks) {
				if (block.type !== "toolCall" || (block.name !== "bash" && block.name !== "pwsh")) continue;
				const result = results.get(block.id);
				const run = toolRuns[block.id];
				const running = !result && run?.status === "running";
				const details = result?.details || run?.partialDetails || {};
				entries.push({
					id: block.id,
					source: "agent",
					shell: block.name === "pwsh" ? "PowerShell" : "bash",
					command: String(block.args?.command ?? ""),
					cwd,
					output: result?.text ?? run?.partial ?? "",
					status: running ? "running" : result ? (shellOutcome(result) ?? (result.isError ? "failed" : "done")) : run?.status === "error" ? "failed" : "pending",
					exitCode: details.exitCode,
					startedAt: run?.startedAt || item.ts,
					endedAt: result?.ts || run?.endedAt,
					truncated: !!details.truncation?.truncated,
					fullOutputPath: details.fullOutputPath,
					timeout: block.args?.timeout,
				});
			}
		} else if (item.kind === "bash") {
			entries.push({
				id: item.id || `bash-${item.ts}`,
				source: "you",
				shell: "shell",
				command: item.command,
				cwd,
				output: item.output,
				status: item.cancelled ? "cancelled" : item.timedOut ? "timeout" : item.exitCode ? "failed" : "done",
				exitCode: item.exitCode,
				startedAt: item.ts,
				endedAt: item.ts,
				truncated: item.truncated,
				fullOutputPath: item.fullOutputPath,
				excluded: item.excludeFromContext,
			});
		}
	}
	for (const id of userBashOrder) {
		const live = userBash[id];
		if (!live) continue;
		// Skip once the recorded transcript message has the same command/time.
		if (live.status !== "running" && entries.some((e) => e.source === "you" && e.command === live.command && Math.abs((e.startedAt || 0) - (live.endedAt || 0)) < 30_000)) continue;
		entries.push({ id: live.id, source: "you", shell: "shell", command: live.command, cwd: live.cwd || cwd, output: live.output, status: live.status, exitCode: live.exitCode, startedAt: live.startedAt, endedAt: live.endedAt, truncated: live.truncated, fullOutputPath: live.fullOutputPath, excluded: live.excludeFromContext, live: true });
	}
	return entries.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

const STATUS_BADGE = { running: ["accent", N_("Running")], done: ["ok", N_("Done")], failed: ["danger", N_("Failed")], error: ["danger", N_("Could not start")], cancelled: ["", N_("Cancelled")], timeout: ["danger", N_("Timed out")], pending: ["", N_("Queued")] };

function Output({ text, wrap, follow }) {
	const ref = useRef(null);
	const stick = useRef(true);
	const segments = useMemo(() => ansiSegments(text), [text]);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el && stick.current && follow) el.scrollTop = el.scrollHeight;
	}, [text, follow]);
	return html`<div class="term-out" ref=${ref} onScroll=${(e) => {
		const el = e.currentTarget;
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
	}}><pre class=${`term-pre ${wrap ? "wrap" : ""}`}>${text ? segments.map((seg, i) => (Object.keys(seg.style).length ? html`<span key=${i} style=${seg.style}>${seg.text}</span>` : seg.text)) : html`<span class="dim">${t("(no output)")}</span>`}</pre></div>`;
}

/** The commands of this chat: what the agent ran with its shell tool and what you ran with !, each with its output. */
function CommandLog({ entries }) {
	const cwd = useStore((s) => s.snap?.cwd) || "";
	const active = useStore((s) => !!s.snap?.active);
	const bashRunning = useStore((s) => !!s.snap?.flags?.bashRunning);
	const selectedId = useStore((s) => s.view.selectedTerminal);
	const [input, setInput] = useState("");
	const [inContext, setInContext] = useState(true);
	const [wrap, setWrap] = useState(false);
	const [now, setNow] = useState(Date.now());
	const [full, setFull] = useState({});
	const selected = entries.find((e) => e.id === selectedId) || entries[entries.length - 1];
	const listRef = useRef(null);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => {
		if (selectedId === undefined || selectedId === null) return;
		const row = listRef.current?.querySelector(`[data-id="${CSS.escape(String(selectedId))}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [selectedId]);
	const run = async () => {
		const command = input.trim();
		if (!command) return;
		setInput("");
		await actions.runShell(command, !inContext);
	};
	const duration = (e) => (e.startedAt ? (e.endedAt || (statusOf(e) === "running" ? now : e.startedAt)) - e.startedAt : 0);
	const st = selected ? statusOf(selected) : null;
	const [badgeClass, badgeKey] = st ? STATUS_BADGE[st] || ["", st] : ["", ""];
	const badgeText = badgeKey ? t(badgeKey) : "";
	return html`<div class="term-log">
		<div class="term-list" ref=${listRef}>
			${!entries.length ? html`<div class="empty">${t("No commands yet. Commands the agent runs — and anything you run below — appear here with their real output.")}</div>` : null}
			${entries.map((entry) => {
				const s = statusOf(entry);
				return html`<button class=${`term-item ${selected?.id === entry.id ? "sel" : ""}`} data-id=${entry.id} key=${entry.id} onClick=${() => setView({ selectedTerminal: entry.id })}>
					<span class="term-ico">${s === "running" ? html`<${Spinner} />` : html`<span class=${`dot ${s === "done" ? "ok" : s === "cancelled" || s === "pending" ? "" : "danger"}`} />`}</span>
					<span class="mono truncate grow">${clip(entry.command.split("\n")[0], 90)}</span>
					<span class="dim term-src">${entry.source === "you" ? t("you") : t("agent")}</span>
				</button>`;
			})}
		</div>
		${selected ? html`<div class="term-detail">
			<div class="term-head">
				<div class="mono term-cmd"><span class="dim">$</span> ${selected.command}</div>
				<div class="term-meta">
					<span class=${`badge ${badgeClass}`}>${badgeText}</span>
					<span class="dim mono truncate term-cwd" title=${selected.cwd}>${selected.cwd}</span>
					<span class="dim">${selected.shell}</span>
					${duration(selected) > 0 ? html`<span class="dim">${fmtDuration(duration(selected))}</span>` : null}
					${selected.exitCode !== undefined && selected.exitCode !== null ? html`<span class=${`mono ${selected.exitCode ? "c-danger" : "dim"}`}>${t("exit {exitCode}", { exitCode: selected.exitCode })}</span>` : null}
					${selected.excluded ? html`<span class="badge">${t("not in context")}</span>` : null}
					<span class="grow" />
					<button class=${`icon-btn sm ${wrap ? "active" : ""}`} title=${t("Wrap long lines")} aria-pressed=${wrap} onClick=${() => setWrap(!wrap)}><${Icon} name="list" size=${14} /></button>
					<${CopyButton} text=${selected.command} label=${t("Copy command")} />
					<${CopyButton} text=${() => stripAnsi(selected.output || "")} label=${t("Copy output")} />
					${st === "running" && selected.source === "you" ? html`<button class="btn sm danger" onClick=${actions.abortShell}>${t("Stop")}</button>` : null}
					${st === "running" && selected.source === "agent" ? html`<button class="btn sm danger" onClick=${actions.stop} title=${t("The agent's command runs inside its task; stopping cancels the whole task")}>${t("Stop task")}</button>` : null}
				</div>
				${selected.truncated ? html`<div class="notice warn"><span>${selected.fullOutputPath ? tNodes("Output was truncated; the complete output is saved at {path}.", { path: html`<code>${selected.fullOutputPath}</code>` }) : t("Output was truncated.")}</span>${selected.fullOutputPath && !full[selected.id] ? html`<button class="link-btn" onClick=${async () => { try { const data = await api(`/api/tool-output?path=${encodeURIComponent(selected.fullOutputPath)}`); setFull((f) => ({ ...f, [selected.id]: data.text })); } catch (e) { toast(e.message, "error"); } }}>${t("Load full output")}</button>` : null}</div>` : null}
			</div>
			<${Output} text=${full[selected.id] ?? (selected.output || "")} wrap=${wrap} follow=${st === "running"} />
		</div>` : null}
		<form class="term-input" onSubmit=${(e) => (e.preventDefault(), run())}>
			<span class="mono dim">$</span>
			<input class="field sm mono grow" value=${input} placeholder=${bashRunning ? t("A command is running…") : t("Run in {workspace}…", { workspace: cwd ? cwd.split(/[\\/]/).pop() : t("workspace") })} disabled=${bashRunning} onInput=${(e) => setInput(e.target.value)} aria-label=${t("Shell command")} />
			<label class="check-label sm dim" title=${t("When on, the command and its output become part of the agent's context (like typing !cmd). When off it stays local (!!cmd).")}><input type="checkbox" checked=${inContext} onChange=${(e) => setInContext(e.target.checked)} />${t("in context")}</label>
			<button class="btn sm primary" type="submit" disabled=${!input.trim() || bashRunning}>${t("Run")}</button>
		</form>
		${active ? html`<div class="term-note dim">${t("The agent is running; your command's output joins the context after the task ends.")}</div>` : null}
	</div>`;
}

/**
 * The real terminal: the shell `shell` in the folder of the chat on screen. `control.current` is the open view
 * (restart, end) for the toolbar; `onPhase` tells it whether there is a running shell to act on.
 */
function ShellView({ shell, control, onPhase }) {
	const cwd = useStore((s) => s.snap?.cwd) || "";
	const mount = useRef(null);
	const [live, setLive] = useState({ phase: "starting", exitCode: null, error: "" });
	// Counts the "Try again" presses: a terminal that could not be shown is set up from scratch.
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (!cwd) return undefined;
		const view = openTerminalView(mount.current, { shell: shell.id, onState: (next) => (setLive(next), onPhase(next.phase)) });
		control.current = view;
		return () => {
			control.current = null;
			view.dispose();
		};
	}, [cwd, shell.id, attempt]);
	return html`<div class="term-shell">
		<div class="term-screen" hidden=${live.phase === "error"}><div class="term-mount" ref=${mount} /></div>
		${live.phase === "error" ? html`<div class="empty"><div>${t("The terminal could not be started.")}</div><div class="dim term-error">${live.error}</div><button class="btn sm" onClick=${() => setAttempt(attempt + 1)}>${t("Retry")}</button></div>` : null}
		${live.phase === "exited" ? html`<div class="term-bar" role="status">
			<span class="grow">${live.exitCode === null ? t("{shell} was ended.", { shell: shell.name }) : t("{shell} has exited (exit code {exitCode}).", { shell: shell.name, exitCode: live.exitCode })}</span>
			<button class="btn sm" title=${t("You can also press Enter in the terminal")} onClick=${() => (control.current?.retry(), control.current?.focus())}>${t("Start again")}</button>
		</div>` : null}
	</div>`;
}

// The shells the server offers. The list of the last visit is shown at once and read again on every visit.
let knownShells = null;

export function TerminalPanel() {
	const view = useStore((s) => s.view.termView);
	const wanted = useStore((s) => s.view.termShell);
	const items = useStore((s) => s.items);
	const toolRuns = useStore((s) => s.toolRuns);
	const userBash = useStore((s) => s.userBash);
	const order = useStore((s) => s.userBashOrder);
	const cwd = useStore((s) => s.snap?.cwd) || "";
	const entries = useMemo(() => terminalEntries(items, toolRuns, userBash, order, cwd), [items, toolRuns, userBash, order, cwd]);
	const commandRunning = entries.some((entry) => statusOf(entry) === "running");
	// null while the list is on its way; `failed` is why it could not be read.
	const [shells, setShells] = useState(knownShells);
	const [failed, setFailed] = useState("");
	const [phase, setPhase] = useState("starting");
	const control = useRef(null);
	const loadShells = () => {
		setFailed("");
		api("/api/terminal/shells", { slot: "" }).then(
			(data) => setShells((knownShells = data.shells)),
			(error) => knownShells || (setShells([]), setFailed(error.message)),
		);
	};
	useEffect(loadShells, []);
	const shell = shells?.find((candidate) => candidate.id === wanted) || shells?.[0];
	const live = view === "shell" && !!shell;
	return html`<div class="terminal-panel">
		<div class="panel-toolbar">
			<${Segmented} value=${view} onChange=${(value) => setView({ termView: value })} options=${[
				{ value: "shell", label: t("Terminal") },
				{ value: "commands", label: html`${t("Command log")}${commandRunning ? html`<${Spinner} />` : null}`, title: t("Commands the agent and you ran in this chat, with their output") },
			]} />
			${live ? html`<select class="select sm" value=${shell.id} aria-label=${t("Shell")} title=${t("Shell")} onChange=${(e) => setView({ termShell: e.target.value })}>${shells.map((option) => html`<option key=${option.id} value=${option.id}>${option.name}</option>`)}</select>` : null}
			<span class="grow" />
			${live ? html`<button class="icon-btn sm" title=${t("Restart the shell")} aria-label=${t("Restart the shell")} onClick=${() => (control.current?.restart(), control.current?.focus())}><${Icon} name="refresh" size=${15} /></button>
				<button class="icon-btn sm" title=${t("End the shell")} aria-label=${t("End the shell")} disabled=${phase !== "running"} onClick=${() => control.current?.end()}><${Icon} name="trash" size=${15} /></button>` : null}
		</div>
		${view !== "shell" ? html`<${CommandLog} entries=${entries} />`
			: shell ? html`<${ShellView} key=${shell.id} shell=${shell} control=${control} onPhase=${setPhase} />`
			: shells ? html`<div class="empty"><div>${failed || t("No shell was found on this computer.")}</div>${failed ? html`<button class="btn sm" onClick=${loadShells}>${t("Retry")}</button>` : null}</div>`
			: html`<div class="empty"><${Spinner} /></div>`}
	</div>`;
}
