// Sub-agents of the chat on screen: the activity bar above the input, the live card where they were dispatched, and
// the pieces both share (rows, timers, stopping, jumping between the two). The server's sub_agent_state (and the
// snapshot's `subAgents`) is the only source of truth for what is running; nothing here guesses a "running" state.
import { html, useEffect, useRef, useState, Collapse, Fold, Icon, Spinner } from "./ui.js";
import { post, setView, toast, useStore } from "./store.js";
import { Markdown } from "./markdown.js";
import { describeAction } from "./turns.js";
import { count, serverText, t } from "./i18n.js";
import { clip, fmtDuration, plural } from "./util.js";

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

/** Scroll to the live card of a dispatch, or to its tool row inside the run steps (which then open). */
export function revealDispatch(toolCallId) {
	if (!toolCallId) return;
	setView({ revealDispatch: { id: toolCallId, n: Date.now() } });
	const find = () => document.getElementById(`dispatch-${toolCallId}`) || document.querySelector(`[data-tool-call="${CSS.escape(toolCallId)}"]`);
	const go = (attempt) => {
		const element = find();
		if (!element) {
			if (attempt < 6) setTimeout(() => go(attempt + 1), 80);
			else toast(t("That dispatch is not in the part of the conversation shown now."), "info", 4000);
			return;
		}
		element.scrollIntoView({ block: "center", behavior: "smooth" });
		element.classList.remove("flash");
		void element.offsetWidth;
		element.classList.add("flash");
		setTimeout(() => element.classList.remove("flash"), 1600);
	};
	requestAnimationFrame(() => setTimeout(() => go(0), 60));
}

function sourceLabel(item) {
	if (item.source === "workflow") return item.name ? t("Workflow “{name}”", { name: item.name }) : t("Workflow");
	if (item.source === "ultracode") return item.name ? t("Ultracode “{name}”", { name: item.name }) : t("Ultracode");
	return count(item.tasks.length, "sub-agent");
}

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
	return html`<button class="sa-stop" onClick=${run} disabled=${disabled || busy} title=${title}>${busy ? t("Stopping…") : label}</button>`;
}

/** One sub-agent: status, name, what it does now, its own timer, and its own stop. */
function TaskRow({ item, task, now, cwd, unknown, onOpen, detail }) {
	const [open, setOpen] = useState(false);
	const running = task.status === "running" && !unknown;
	const elapsed = taskElapsed(task, now);
	const facts = [item.model, item.id, task.toolUseCount ? plural(task.toolUseCount, "tool call") : ""].filter(Boolean).join(" · ");
	return html`<div class=${`sa-task s-${unknown ? "unknown" : task.status}`}>
		<div class="sa-row" role="button" tabindex="0" onClick=${onOpen} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())} title=${facts}>
			<span class="sa-ico"><${TaskStatusIcon} status=${task.status} unknown=${unknown} /></span>
			<span class="sa-name truncate">${task.description || t("Sub-agent")}</span>
			<span class=${`sa-activity truncate ${running ? "shimmer-text" : "dim"}`}>${unknown ? t("Status unknown") : taskActivity(task, cwd)}</span>
			<span class="sa-time dim">${elapsed >= 1000 ? fmtDuration(elapsed) : ""}</span>
			${running ? html`<${StopButton} label=${t("Stop")} title=${t("Stop only this sub-agent; the main agent keeps going")} onStop=${() => stopSubAgents({ id: item.id, phase: task.phase, task: task.index })} />` : null}
			<button class="icon-btn sm sa-more" aria-expanded=${open} title=${t("Details")} onClick=${(e) => (e.stopPropagation(), setOpen(!open))}><${Fold} /></button>
		</div>
		<${Collapse} open=${open}>
			<div class="sa-detail">
				<div class="dim">${facts}</div>
				${detail ? detail(task) : null}
			</div>
		<//>
	</div>`;
}

/** The rows of one dispatch: an agent batch is a flat list; a workflow shows its phases with their tasks. */
export function DispatchRows({ item, now, cwd, unknown, onOpen, detail }) {
	if (!item.phases) return item.tasks.map((task) => html`<${TaskRow} key=${task.index} item=${item} task=${task} now=${now} cwd=${cwd} unknown=${unknown} onOpen=${onOpen} detail=${detail} />`);
	return item.phases.map((phase, index) => {
		const tasks = item.tasks.filter((task) => task.phase === index);
		return html`<div class="sa-phase" key=${index}>
			<div class="sa-phase-head dim"><span class="sa-ico"><${TaskStatusIcon} status=${phase.status === "pending" ? "pending" : phase.status} unknown=${unknown} /></span><span class="truncate">${t("Phase {n}: {name}", { n: index + 1, name: phase.name })}</span><span class="sa-time">${phase.status === "pending" ? t("Not started") : `${phase.completed}/${phase.total}`}</span></div>
			${tasks.map((task) => html`<${TaskRow} key=${task.index} item=${item} task=${task} now=${now} cwd=${cwd} unknown=${unknown} onOpen=${onOpen} detail=${detail} />`)}
		</div>`;
	});
}

function failedCount(items) {
	return items.reduce((sum, item) => sum + item.tasks.filter((task) => task.status === "failed" || task.status === "timeout").length, 0);
}

/**
 * Above the input, only while the chat has sub-agents: how many run and since when, unfolding to one row per
 * sub-agent. When the last one ends it says briefly whether all went well, then goes away.
 */
export function SubAgentBar() {
	const state = useSubAgents();
	const cwd = useStore((s) => s.snap?.cwd || "");
	const session = useStore((s) => s.snap?.session?.id);
	const openSignal = useStore((s) => s.view.subAgentPanel);
	const [open, setOpen] = useState(false);
	const [summary, setSummary] = useState(null);
	const previous = useRef({ session, running: 0 });
	const running = runningTasks(state);
	const now = useNow(running > 0 && !state.unknown);

	useEffect(() => {
		const before = previous.current;
		previous.current = { session, running };
		if (before.session !== session) {
			setSummary(null);
			return undefined;
		}
		if (running > 0 || state.unknown) {
			setSummary(null);
			return undefined;
		}
		if (before.running > 0 && state.items.length > 0) {
			const items = state.items;
			const failed = failedCount(items);
			const stopped = items.reduce((sum, item) => sum + item.tasks.filter((task) => task.status === "cancelled").length, 0);
			const target = (items.find((item) => item.tasks.some((task) => task.status === "failed" || task.status === "timeout")) ?? items[items.length - 1])?.toolCallId;
			setSummary({ failed, stopped, total: items.reduce((sum, item) => sum + item.tasks.length, 0), target });
			const timer = setTimeout(() => setSummary(null), SUMMARY_MS);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [session, running, state.items, state.unknown]);

	useEffect(() => {
		if (openSignal) setOpen(true);
	}, [openSignal]);

	if (summary && running === 0) {
		const bad = summary.failed > 0;
		const text = bad
			? t("Sub-agents finished: {failed} failed", { failed: summary.failed })
			: summary.stopped > 0
				? t("Sub-agents finished: {stopped} stopped", { stopped: summary.stopped })
				: t("All {agents} finished", { agents: count(summary.total, "sub-agent") });
		return html`<div class="strips"><button class=${`strip sa-bar sa-summary ${bad ? "bad" : "good"}`} onClick=${() => revealDispatch(summary.target)} title=${t("Show in the conversation")}>
			<${Icon} name=${bad ? "alertCircle" : "checkCircle"} size=${14} /><span>${text}</span>
		</button></div>`;
	}
	if (state.items.length === 0 || (running === 0 && !state.unknown)) return null;

	const since = runningSince(state);
	const head = state.unknown
		? t("Sub-agent status unknown (reconnecting…)")
		: t("{agents} running", { agents: count(running, "sub-agent") });
	return html`<div class="strips"><div class=${`strip sa-bar ${open ? "open" : ""}`} role="status">
		<button class="sa-head" onClick=${() => setOpen(!open)} aria-expanded=${open} title=${open ? t("Hide sub-agents") : t("Show sub-agents")}>
			<span class="sa-ico">${state.unknown ? html`<${Icon} name="clock" size=${14} class="c-dim" />` : html`<${Spinner} size=${14} />`}</span>
			<span class="sa-head-text truncate">${head}</span>
			${since && !state.unknown ? html`<span class="strip-time">${t("{duration} elapsed", { duration: fmtDuration(Math.max(0, now - since)) })}</span>` : null}
			<${Fold} />
		</button>
		${!state.unknown ? html`<${StopButton} label=${t("Stop all sub-agents")} title=${t("Stops only the sub-agents. The main agent's current turn is not stopped (the stop button in the input box stops everything).")} onStop=${() => stopSubAgents({ all: true })} />` : null}
		<${Collapse} open=${open}>
			<div class="sa-list">
				${state.items.map((item) => html`<div class="sa-dispatch" key=${item.id}>
					${item.phases ? html`<div class="sa-dispatch-head"><span class="sa-ico"><${TaskStatusIcon} status=${item.status} unknown=${state.unknown} /></span><span class="truncate">${sourceLabel(item)}</span></div>` : null}
					<${DispatchRows} item=${item} now=${now} cwd=${cwd} unknown=${state.unknown} onOpen=${() => revealDispatch(item.toolCallId)} />
				</div>`)}
			</div>
		<//>
	</div></div>`;
}

/** The report a task has so far (shown under its row in the live card). */
function TaskReport({ result }) {
	if (!result) return html`<div class="dim">${t("No report yet.")}</div>`;
	return html`<div class="sub-detail">
		${result.error ? html`<div class="c-danger">${result.error}</div>` : null}
		${result.output ? html`<${Markdown} text=${result.output} />` : html`<div class="dim">${t("No report yet.")}</div>`}
		${result.findings?.length ? html`<div class="raw-label">${t("Findings")}</div><ul class="sub-list">${result.findings.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
		${result.unresolved?.length ? html`<div class="raw-label">${t("Unresolved")}</div><ul class="sub-list">${result.unresolved.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
	</div>`;
}

function resultOf(details, task) {
	if (!details) return undefined;
	if (details.phases) return details.phases[task.phase ?? 0]?.results?.[task.index];
	return details.results?.[task.index];
}

/**
 * The live card of one dispatch, beside the turn that started it. It stays (also after that turn ended or was
 * interrupted) until its sub-agents have all ended; then the run steps keep the result as before.
 */
export function DispatchCard({ item, details }) {
	const state = useSubAgents();
	const cwd = useStore((s) => s.snap?.cwd || "");
	const unknown = state.unknown;
	const running = item.tasks.filter(isRunning).length;
	const now = useNow(running > 0 && !unknown);
	const done = item.tasks.filter((task) => task.status === "completed").length;
	const since = item.startedAt;
	return html`<div class="sa-card" id=${`dispatch-${item.toolCallId}`}>
		<div class="sa-card-head">
			<span class="sa-ico">${unknown ? html`<${Icon} name="clock" size=${14} class="c-dim" />` : running ? html`<${Spinner} size=${14} />` : html`<${TaskStatusIcon} status=${item.status} />`}</span>
			<span class="sa-head-text truncate"><strong>${sourceLabel(item)}</strong> · ${unknown ? t("Status unknown") : running ? t("{running} running · {done}/{total} done", { running, done, total: item.tasks.length }) : t(STATUS_LABEL[item.status] || item.status)}</span>
			${item.background ? html`<span class="badge">${item.detached ? t("moved to the background") : t("background")}</span>` : null}
			${since && !unknown ? html`<span class="strip-time dim">${fmtDuration(Math.max(0, (running ? now : item.endedAt || now) - since))}</span>` : null}
			${running && !unknown ? html`<${StopButton} label=${t("Stop")} title=${t("Stop these sub-agents; the main agent keeps going")} onStop=${() => stopSubAgents({ id: item.id })} />` : null}
		</div>
		<div class="sa-card-body">
			<${DispatchRows} item=${item} now=${now} cwd=${cwd} unknown=${unknown} onOpen=${() => {}} detail=${(task) => html`<${TaskReport} result=${resultOf(details ?? item.details, task)} />`} />
		</div>
	</div>`;
}
