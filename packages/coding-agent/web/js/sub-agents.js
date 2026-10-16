// Sub-agents of the chat on screen: the activity bar above the input (the one place that shows them live, with their
// stops and a fullscreen view of the same list) and the steps of one sub-agent, which the transcript's dispatch rows
// reuse. The server's sub_agent_state (and the snapshot's `subAgents`) is the only source of truth for what is running;
// nothing here guesses a "running" state.
import { html, useEffect, useLayoutEffect, useRef, useState, Collapse, Fold, Icon, Modal, Overlay, Spinner } from "./ui.js";
import { post, toast, useStore } from "./store.js";
import { Markdown } from "./markdown.js";
import { describeAction } from "./turns.js";
import { StatusGlyph } from "./tool-rows.js";
import { count, serverText, t } from "./i18n.js";
import { clip, fmtDuration, fmtShortDuration, formatData, plural } from "./util.js";

export const EMPTY_SUB_AGENTS = Object.freeze({ items: [], running: 0 });
const DOT = { completed: "ok", partial: "warn", failed: "danger", timeout: "danger" };
const STATUS_LABEL = { running: "running", completed: "completed", partial: "partial", failed: "failed", timeout: "timeout", cancelled: "Stopped", pending: "Not started" };
const SUMMARY_MS = 6000;

/** The sub-agent state of the chat on screen; while the connection is down it is unknown, never "running". */
export function useSubAgents() {
	const state = useStore((s) => s.subAgentState) || EMPTY_SUB_AGENTS;
	const connected = useStore((s) => s.connected);
	return { ...state, unknown: connected === false };
}

/** The registry entry of the dispatch a tool call started, if the session still runs (or just ran) it. */
export function dispatchFor(state, toolCallId, batchId) {
	return state.items.find((item) => (toolCallId && item.toolCallId === toolCallId) || (batchId && item.id === batchId));
}

const isRunning = (task) => task.status === "running";
export const runningTasks = (state) => state.items.reduce((sum, item) => sum + item.tasks.filter(isRunning).length, 0);

/** When the earliest dispatch that still has a running task was started. */
export function runningSince(state) {
	let since;
	for (const item of state.items) if (item.tasks.some(isRunning) && (since === undefined || item.startedAt < since)) since = item.startedAt;
	return since;
}

export function useNow(active) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!active) return undefined;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

function taskElapsed(task, now) {
	if (task.status !== "running" && task.durationMs) return task.durationMs;
	if (!task.startedAt) return 0;
	return Math.max(0, (task.status === "running" ? now : task.endedAt || now) - task.startedAt);
}

/** What a task is doing now, in the words the tool rows use (Reading x, Searching y, Running z). */
export function taskActivity(task, cwd) {
	if (task.status !== "running") {
		if (task.stoppedBy === "user") return t("Stopped from the panel");
		if (task.stoppedBy === "agent") return t("Stopped by the main agent");
		if (task.stoppedBy === "stop") return t("Stopped with the task");
		return task.error ? clip(serverText(task.error, t(STATUS_LABEL[task.status] || task.status)), 120) : t(STATUS_LABEL[task.status] || task.status);
	}
	const tool = task.lastTool;
	if (tool && tool.status === "running") {
		const described = describeAction({ name: tool.name, args: tool.args }, undefined, { status: "running", args: tool.args }, cwd);
		return `${described.verb}${described.target ? ` ${clip(described.target, 90)}` : ""}`;
	}
	// Right after a tool, the server's text is that tool's raw output summary: name the tool call instead, as the tool rows do.
	if (tool && task.activity && task.activity === tool.summary) {
		const described = describeAction({ name: tool.name, args: tool.args }, { isError: tool.status === "failed" }, { status: tool.status === "failed" ? "error" : "done", args: tool.args }, cwd);
		return `${described.verb}${described.target ? ` ${clip(described.target, 90)}` : ""}`;
	}
	if (task.activity) return serverText(task.activity, t("Working…"));
	return t("Working…");
}

export function TaskStatusIcon({ status, unknown }) {
	if (unknown) return html`<${Icon} name="clock" size=${13} class="c-dim" />`;
	if (status === "running") return html`<${Spinner} size=${13} />`;
	if (status === "cancelled") return html`<${Icon} name="stopCircle" size=${13} class="c-dim" />`;
	return html`<span class=${`dot ${DOT[status] ?? ""}`} />`;
}

/**
 * Stop sub-agents (one task, one dispatch, or all of them) without touching the main run. Failures are shown: a stop
 * that did not happen must never look done.
 */
export async function stopSubAgents(body) {
	try {
		return await post("/api/sub-agents/stop", body);
	} catch (error) {
		toast(t("Could not stop the sub-agents: {error}", { error: error.message || String(error) }), "error", 10000);
		return undefined;
	}
}

function sourceLabel(item) {
	if (item.source === "workflow") return item.name ? t("Workflow “{name}”", { name: item.name }) : t("Workflow");
	if (item.source === "ultracode") return item.name ? t("Ultracode “{name}”", { name: item.name }) : t("Ultracode");
	return count(item.tasks.length, "sub-agent");
}


/**
 * The stop of one task, one dispatch or all sub-agents: a quiet square icon (the player's stop) that only this small
 * button answers. It never takes the click or the keys of the row it sits in, and a stop that failed says why.
 */
function StopButton({ label, title, onStop, disabled }) {
	const [busy, setBusy] = useState(false);
	const run = async (event) => {
		event.stopPropagation();
		if (busy) return;
		setBusy(true);
		try {
			await onStop();
		} finally {
			setBusy(false);
		}
	};
	return html`<button type="button" class="icon-btn sm sa-icon-btn sa-stop" onClick=${run} onKeyDown=${(event) => event.stopPropagation()} disabled=${disabled || busy} aria-busy=${busy ? "true" : undefined} title=${busy ? t("Stopping…") : title || label} aria-label=${busy ? t("Stopping…") : label}>
		${busy ? html`<${Spinner} size=${13} />` : html`<${Icon} name="stop" size=${13} />`}
	</button>`;
}

/** Which rows are open, shared by the bar and its fullscreen view so both show the same depth. */
function useOpenSet() {
	const [keys, setKeys] = useState(() => new Set());
	return {
		has: (key) => keys.has(key),
		toggle: (key) =>
			setKeys((old) => {
				const next = new Set(old);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				return next;
			}),
	};
}

/** One tool call of a sub-agent, opened: what it was given and the summary of what came back (all the session keeps of it). */
function TraceRaw({ trace, failed }) {
	return html`<div class="raw">
		<div class="raw-meta">
			<span class="raw-key">${t("tool")}</span><code>${trace.toolName}</code>
			${Number.isFinite(trace.durationMs) ? html`<span class="raw-key">${t("took")}</span><code>${fmtShortDuration(trace.durationMs)}</code>` : null}
			${trace.errorType ? html`<span class="raw-key">${t("error type")}</span><code class="err">${trace.errorType}</code>` : null}
			${trace.toolCallId ? html`<span class="raw-key">${t("id")}</span><code class="dim">${clip(String(trace.toolCallId).split("|")[0], 24)}</code>` : null}
		</div>
		<div class="raw-body">
			<div class="raw-section">
				<div class="raw-label">${t("Arguments")}</div>
				<pre class="raw-pre">${formatData(trace.args || {})}</pre>
			</div>
			${trace.resultSummary ? html`<div class=${`raw-section${failed ? " raw-err" : ""}`}>
				<div class="raw-label">${failed ? t("Error summary") : t("Result summary")}</div>
				<pre class="raw-pre">${trace.resultSummary}</pre>
			</div>` : null}
		</div>
	</div>`;
}

/**
 * One tool call of a sub-agent the way the main agent's tool rows show it: the same glyph, wording, time and fold arrow
 * (describeAction, StatusGlyph). A call still marked running in a task that has ended did not finish.
 */
function TraceRow({ trace, taskRunning, cwd, open, onToggle }) {
	const unfinished = trace.status === "running" && !taskRunning;
	const failed = trace.status === "failed";
	const ended = failed || trace.status === "completed";
	const described = describeAction({ name: trace.toolName, args: trace.args || {} }, ended ? { isError: failed, text: "" } : undefined, trace.status === "running" && !unfinished ? { status: "running" } : undefined, cwd);
	const step = { ...described, status: unfinished ? "cancelled" : described.status, isError: failed };
	const took = trace.durationMs >= 1000 ? fmtDuration(trace.durationMs) : "";
	const keyToggle = (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), onToggle());
	return html`<div class=${`action ${failed ? "err" : ""} ${step.status}`}>
		<div class="action-row" onClick=${onToggle} role="button" tabindex="0" aria-expanded=${open} onKeyDown=${keyToggle}>
			<span class="action-ico"><${StatusGlyph} step=${step} /></span>
			<span class="action-text truncate">
				<span class=${step.status === "running" ? "shimmer-text" : "verb"}>${step.verb}</span>
				${step.target ? html` <span class=${step.kind === "run" ? "mono target" : "target"}>${step.target}</span>` : null}
				${step.detail ? html` <span class="dim">${step.detail}</span>` : null}
				${unfinished ? html` <span class="dim">${t("not finished")}</span>` : null}
			</span>
			<span class="action-tail">
				${took ? html`<span class="dim">${took}</span>` : null}
				<${Fold} />
			</span>
		</div>
		<${Collapse} open=${open}><${TraceRaw} trace=${trace} failed=${failed} /><//>
	</div>`;
}

/** The report a task has so far: its error, its answer, what it found and what it left open. */
function TaskReport({ result }) {
	if (!result) return html`<div class="dim">${t("No report yet.")}</div>`;
	return html`<div class="sa-report">
		${result.error ? html`<div class="c-danger">${result.error}</div>` : null}
		${result.output ? html`<${Markdown} text=${result.output} />` : html`<div class="dim">${t("No report yet.")}</div>`}
		${result.findings?.length ? html`<div class="raw-label">${t("Findings")}</div><ul class="sub-list">${result.findings.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
		${result.unresolved?.length ? html`<div class="raw-label">${t("Unresolved")}</div><ul class="sub-list">${result.unresolved.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
	</div>`;
}

/**
 * What one sub-agent did: its tool calls in order (the steps the session records for it; it keeps no reasoning text),
 * then its report. Without recorded steps it says so; nothing is made up. `opened` shares the open tool rows with
 * another view of the same task (the bar and its fullscreen view); without it the rows keep their own state.
 */
export function SubAgentProcess({ result, running, cwd, facts, opened, idPrefix = "" }) {
	const own = useOpenSet();
	const open = opened || own;
	const traces = Array.isArray(result?.transcript) ? result.transcript : [];
	return html`<div class="sa-process">
		${facts ? html`<div class="dim sa-facts">${facts}</div>` : null}
		${traces.length
			? html`<div class="steps sa-steps">${traces.map((trace, index) => {
					const key = `${idPrefix}${trace.toolCallId || index}`;
					return html`<div class=${`step ${index < traces.length - 1 ? "linked" : ""}`} key=${key}><${TraceRow} trace=${trace} taskRunning=${running} cwd=${cwd} open=${open.has(key)} onToggle=${() => open.toggle(key)} /></div>`;
				})}</div>`
			: html`<div class="dim sa-empty">${t("No process yet")}</div>`}
		<${TaskReport} result=${result} />
	</div>`;
}

function resultOf(details, task) {
	if (!details) return undefined;
	if (details.phases) return details.phases[task.phase ?? 0]?.results?.[task.index];
	return details.results?.[task.index];
}

const taskKey = (item, task) => `${item.id}:${task.phase ?? 0}:${task.index}`;

/** The mouse opens a row anywhere but on its icon buttons; the keyboard uses the row's toggle button (whose click lands here too). */
const rowClick = (toggle) => (event) => {
	if (event.target.closest?.(".sa-icon-btn")) return;
	toggle();
};

/**
 * One sub-agent: status, name, what it does now (or how it ended), its own tool calls and timer, and its own stop.
 * The row opens in place to what the sub-agent did; it never jumps anywhere.
 */
function TaskRow({ item, task, now, cwd, unknown, result, rows, traces }) {
	const key = taskKey(item, task);
	const open = rows.has(key);
	const toggle = () => rows.toggle(key);
	const running = task.status === "running" && !unknown;
	const elapsed = taskElapsed(task, now);
	const meta = [task.toolUseCount ? plural(task.toolUseCount, "tool call") : "", elapsed >= 1000 ? fmtDuration(elapsed) : ""].filter(Boolean).join(" · ");
	const facts = [result?.model || item.model, item.id].filter(Boolean).join(" · ");
	return html`<div class=${`sa-task s-${unknown ? "unknown" : task.status}`}>
		<div class="sa-row" onClick=${rowClick(toggle)}>
			<button type="button" class="sa-toggle" aria-expanded=${open} title=${task.description || t("Sub-agent")}>
				<span class="sa-ico"><${TaskStatusIcon} status=${task.status} unknown=${unknown} /></span>
				<span class="sa-name truncate">${task.description || t("Sub-agent")}</span>
				<span class=${`sa-activity truncate ${running ? "shimmer-text" : "dim"}`}>${unknown ? t("Status unknown") : taskActivity(task, cwd)}</span>
				<span class="sa-time">${meta}</span>
			</button>
			${running ? html`<${StopButton} label=${t("Stop only this sub-agent; the main agent keeps going")} onStop=${() => stopSubAgents({ id: item.id, phase: task.phase, task: task.index })} />` : null}
			<span class="sa-chev" aria-hidden="true"><${Fold} /></span>
		</div>
		<${Collapse} open=${open}>
			<div class="sa-detail"><${SubAgentProcess} result=${result} running=${task.status === "running"} cwd=${cwd} facts=${facts} opened=${traces} idPrefix=${`${key}:`} /></div>
		<//>
	</div>`;
}

/** One dispatch: its head (what it is, its model, whether it runs in the background, its own stop), then its sub-agents; a workflow by phase. */
function DispatchRows({ item, details, now, cwd, unknown, rows, traces }) {
	const running = item.tasks.some(isRunning) && !unknown;
	const row = (task) => html`<${TaskRow} key=${task.index} item=${item} task=${task} now=${now} cwd=${cwd} unknown=${unknown} result=${resultOf(details, task)} rows=${rows} traces=${traces} />`;
	return html`<div class="sa-dispatch">
		<div class="sa-dispatch-head">
			<span class="sa-ico"><${TaskStatusIcon} status=${item.status} unknown=${unknown} /></span>
			<span class="sa-dispatch-name truncate">${sourceLabel(item)}${item.model ? html`<span class="dim"> · ${item.model}</span>` : null}</span>
			${item.background ? html`<span class="badge">${item.detached ? t("moved to the background") : t("background")}</span>` : null}
			${running ? html`<${StopButton} label=${t("Stop these sub-agents; the main agent keeps going")} onStop=${() => stopSubAgents({ id: item.id })} />` : null}
		</div>
		${item.phases
			? item.phases.map((phase, index) => html`<div class="sa-phase" key=${index}>
					<div class="sa-phase-head dim"><span class="sa-ico"><${TaskStatusIcon} status=${phase.status === "pending" ? "pending" : phase.status} unknown=${unknown} /></span><span class="truncate">${t("Phase {n}: {name}", { n: index + 1, name: phase.name })}</span><span class="sa-time">${phase.status === "pending" ? t("Not started") : `${phase.completed}/${phase.total}`}</span></div>
					${item.tasks.filter((task) => task.phase === index).map(row)}
				</div>`)
			: item.tasks.map(row)}
	</div>`;
}

function SubAgentList({ items, subAgents, now, cwd, unknown, rows, traces }) {
	return html`<div class="sa-list">
		${items.map((item) => html`<${DispatchRows} key=${item.id} item=${item} details=${subAgents[item.id] ?? item.details} now=${now} cwd=${cwd} unknown=${unknown} rows=${rows} traces=${traces} />`)}
	</div>`;
}

function failedCount(items) {
	return items.reduce((sum, item) => sum + item.tasks.filter((task) => task.status === "failed" || task.status === "timeout").length, 0);
}

/**
 * Above the input, only while the chat has sub-agents: how many run and since when, open by default to one row per
 * sub-agent. Everything opens in place, one layer at a time (the list, one sub-agent's steps, one step's data); nothing
 * here scrolls the conversation. The fullscreen view shows the same list, open to the same depth. When the last one
 * ends the bar says briefly whether all went well, then goes away (not while its list or the fullscreen view is open).
 */
export function SubAgentBar() {
	const state = useSubAgents();
	const subAgents = useStore((s) => s.subAgents);
	const cwd = useStore((s) => s.snap?.cwd || "");
	const session = useStore((s) => s.snap?.session?.id);
	const openSignal = useStore((s) => s.view.subAgentPanel);
	const [open, setOpen] = useState(true);
	const [full, setFull] = useState(false);
	const [summary, setSummary] = useState(null);
	const rows = useOpenSet();
	const traces = useOpenSet();
	const previous = useRef({ session, running: 0 });
	const running = runningTasks(state);
	const live = state.items.length > 0 && (running > 0 || state.unknown);
	const now = useNow(running > 0 && !state.unknown);

	// Sub-agents that start (again) show their list open.
	const wasLive = useRef(live);
	useLayoutEffect(() => {
		if (live && !wasLive.current) setOpen(true);
		wasLive.current = live;
	}, [live]);

	useEffect(() => {
		const before = previous.current;
		previous.current = { session, running };
		if (before.session !== session) {
			setSummary(null);
			setFull(false);
			return;
		}
		if (running > 0 || state.unknown) {
			setSummary(null);
			return;
		}
		if (before.running > 0 && state.items.length > 0) {
			const items = state.items;
			const stopped = items.reduce((sum, item) => sum + item.tasks.filter((task) => task.status === "cancelled").length, 0);
			setSummary({ failed: failedCount(items), stopped, total: items.reduce((sum, item) => sum + item.tasks.length, 0), items });
			setOpen(false);
		}
	}, [session, running, state.items, state.unknown]);

	// The closing summary goes after a few seconds, but not while its list or the fullscreen view is open.
	useEffect(() => {
		if (!summary || open || full) return undefined;
		const timer = setTimeout(() => setSummary(null), SUMMARY_MS);
		return () => clearTimeout(timer);
	}, [summary, open, full]);

	useEffect(() => {
		if (openSignal) setOpen(true);
	}, [openSignal]);

	const ended = !!summary && running === 0 && !state.unknown;
	if (!live && !ended) return null;
	const items = ended && state.items.length === 0 ? summary.items : state.items;
	const since = runningSince(state);
	const bad = ended && summary.failed > 0;
	const text = ended
		? bad
			? t("Sub-agents finished: {failed} failed", { failed: summary.failed })
			: summary.stopped > 0
				? t("Sub-agents finished: {stopped} stopped", { stopped: summary.stopped })
				: t("All {agents} finished", { agents: count(summary.total, "sub-agent") })
		: state.unknown
			? t("Sub-agent status unknown (reconnecting…)")
			: t("{agents} running", { agents: count(running, "sub-agent") });
	const icon = ended
		? html`<${Icon} name=${bad ? "alertCircle" : "checkCircle"} size=${14} />`
		: state.unknown
			? html`<${Icon} name="clock" size=${14} class="c-dim" />`
			: html`<${Spinner} size=${14} />`;
	const elapsed = !ended && since && !state.unknown ? html`<span class="strip-time">${t("{duration} elapsed", { duration: fmtDuration(Math.max(0, now - since)) })}</span>` : null;
	const stopAll = !ended && !state.unknown ? html`<${StopButton} label=${t("Stop all sub-agents")} title=${t("Stops only the sub-agents. The main agent's current turn is not stopped (the stop button in the input box stops everything).")} onStop=${() => stopSubAgents({ all: true })} />` : null;
	const list = html`<${SubAgentList} items=${items} subAgents=${subAgents} now=${now} cwd=${cwd} unknown=${state.unknown} rows=${rows} traces=${traces} />`;
	const toggle = () => setOpen(!open);
	return html`<div class="strips"><div class=${`strip sa-bar ${open ? "open" : ""} ${ended ? `sa-summary ${bad ? "bad" : "good"}` : ""}`} role="status">
		<div class="sa-head" onClick=${rowClick(toggle)}>
			<button type="button" class="sa-toggle" aria-expanded=${open} title=${open ? t("Hide sub-agents") : t("Show sub-agents")}>
				<span class="sa-ico">${icon}</span>
				<span class="sa-head-text truncate">${text}</span>
				${elapsed}
			</button>
			<button type="button" class="icon-btn sm sa-icon-btn" onClick=${(event) => (event.stopPropagation(), setFull(true))} onKeyDown=${(event) => event.stopPropagation()} title=${t("Show sub-agents fullscreen")} aria-label=${t("Show sub-agents fullscreen")}><${Icon} name="maximize" size=${13} /></button>
			${stopAll}
			<span class="sa-chev" aria-hidden="true"><${Fold} /></span>
		</div>
		<${Collapse} open=${open}>${list}<//>
	</div>
		<${Overlay} show=${full}>
			<${Modal} title=${t("Sub-agents")} onClose=${() => setFull(false)} width=${1100} class="sa-full" closeIcon="minimize" closeLabel=${t("Exit fullscreen (Esc)")} focusInput=${false}>
				<div class=${`sa-full-head ${ended ? `sa-summary ${bad ? "bad" : "good"}` : ""}`}><span class="sa-ico">${icon}</span><span class="sa-head-text truncate">${text}</span>${elapsed}${stopAll}</div>
				${list}
			<//>
		<//>
	</div>`;
}
