// Transcript: quiet reading surface. Each turn = user message, a collapsed run summary, the final answer,
// and (only when relevant) an outcome banner. Details open in layers: summary -> steps -> raw tool data.
import { html, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Spinner, CopyButton } from "./ui.js";
import { api, useStore, state, setView } from "./store.js";
import { Markdown } from "./markdown.js";
import { buildTurns, groupSteps, groupLabel, OUTCOME_LABEL, runForTurn, turnDuration, turnOutcome } from "./turns.js";
import { actions } from "./actions.js";
import { basename, clip, dirname, fmtBytes, fmtDuration, fmtShortDuration, plural, formatData, ansiSegments } from "./util.js";
import { t, N_, serverText, tNodes, getLang } from "./i18n.js";

const KIND_ICON = { read: "file", list: "folder", find: "search", search: "search", run: "terminal", edit: "edit", write: "fileDiff", web: "globe", fetch: "globe", agent: "layers", tool: "wrench" };
const OUTCOME_ICON = { completed: "checkCircle", partial: "alertTriangle", failed: "alertCircle", cancelled: "stopCircle", waiting: "clock", unanswered: "alertCircle" };

// ---- Small pieces ----------------------------------------------------------------------------
function Ansi({ text }) {
	const segments = useMemo(() => ansiSegments(text), [text]);
	return html`${segments.map((seg, i) => (Object.keys(seg.style).length ? html`<span key=${i} style=${seg.style}>${seg.text}</span>` : seg.text))}`;
}

function Output({ text, max = 20_000, tail = false }) {
	const [all, setAll] = useState(false);
	const shown = !all && text.length > max ? (tail ? text.slice(-max) : text.slice(0, max)) : text;
	return html`<div class="raw-block"><pre class="raw-pre"><${Ansi} text=${shown} /></pre>
		${text.length > max ? html`<button class="btn sm ghost" onClick=${() => setAll(!all)}>${all ? t("Show less") : t("Show all ({fmtBytes})", { fmtBytes: fmtBytes(text.length) })}</button>` : null}</div>`;
}

const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;

/** Text read from a Markdown file renders like the chat; everything else stays plain/code output. */
function MarkdownOutput({ text, max = 60_000 }) {
	const [all, setAll] = useState(false);
	const shown = !all && text.length > max ? text.slice(0, max) : text;
	return html`<div class="raw-block raw-md"><${Markdown} text=${shown} onOpenFile=${actions.openFile} />
		${text.length > max ? html`<button class="btn sm ghost" onClick=${() => setAll(!all)}>${all ? t("Show less") : t("Show all ({fmtBytes})", { fmtBytes: fmtBytes(text.length) })}</button>` : null}</div>`;
}

function RawDetails({ step }) {
	const { call, result, run } = step;
	const details = result?.details;
	const [showDetails, setShowDetails] = useState(false);
	const output = result?.text ?? run?.partial ?? "";
	const exitCode = details?.exitCode;
	return html`<div class="raw">
		<div class="raw-meta">
			<span class="raw-key">${t("tool")}</span><code>${call.name}</code>
			${exitCode !== undefined && exitCode !== null ? html`<span class="raw-key">${t("exit code")}</span><code class=${exitCode ? "err" : ""}>${exitCode}</code>` : null}
			${step.startedAt && step.endedAt ? html`<span class="raw-key">${t("took")}</span><code>${fmtShortDuration(step.endedAt - step.startedAt)}</code>` : null}
			<span class="raw-key">${t("id")}</span><code class="dim">${clip(call.id.split("|")[0], 24)}</code>
		</div>
		<div class="raw-label">${t("Arguments")}</div>
		<pre class="raw-pre">${formatData(call.args)}</pre>
		${output ? html`<div class="raw-label">${result ? (result.isError ? t("Error output") : t("Result")) : t("Output so far")}</div>${step.kind === "read" && result && !result.isError && MARKDOWN_PATH.test(step.path || "") ? html`<${MarkdownOutput} text=${output} />` : html`<${Output} text=${output} tail=${step.kind === "run"} />`}` : null}
		${result?.images?.length ? html`<div class="raw-images">${result.images.map((img, i) => html`<img key=${i} src=${`data:${img.mimeType};base64,${img.data}`} alt=${t("tool image")} />`)}</div>` : null}
		${details && Object.keys(details).length ? html`<button class="btn sm ghost" onClick=${() => setShowDetails(!showDetails)}>${showDetails ? t("Hide result details") : t("Show result details")}</button>${showDetails ? html`<pre class="raw-pre">${formatData(details)}</pre>` : null}` : null}
	</div>`;
}

const TASK_DOT = { running: "accent", completed: "ok", partial: "warn", failed: "danger", timeout: "danger", cancelled: "" };

function TaskResult({ task }) {
	const [open, setOpen] = useState(false);
	return html`<div class="sub-task">
		<div class="action-row" onClick=${() => setOpen(!open)} role="button" tabindex="0" onKeyDown=${(e) => e.key === "Enter" && setOpen(!open)}>
			<span class="action-ico">${task.status === "running" ? html`<${Spinner} />` : html`<span class=${`dot ${TASK_DOT[task.status] ?? ""}`} />`}</span>
			<span class="action-text truncate">${task.description || clip(task.prompt || "", 80)}</span>
			<span class="action-tail dim">${task.toolUseCount ? plural(task.toolUseCount, "tool call") : ""}${task.durationMs ? ` · ${fmtDuration(task.durationMs)}` : ""}<${Icon} name=${open ? "chevronUp" : "chevronDown"} size=${13} class="c-dim" /></span>
		</div>
		${task.status === "running" && task.lastToolInfo ? html`<div class="dim sub-last truncate">${task.lastToolInfo}</div>` : null}
		${open
			? html`<div class="sub-detail">
			${task.error ? html`<div class="c-danger">${task.error}</div>` : null}
			${task.output ? html`<${Markdown} text=${task.output} onOpenFile=${actions.openFile} />` : html`<div class="dim">${t("No report yet.")}</div>`}
			${task.findings?.length ? html`<div class="raw-label">${t("Findings")}</div><ul class="sub-list">${task.findings.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
			${task.unresolved?.length ? html`<div class="raw-label">${t("Unresolved")}</div><ul class="sub-list">${task.unresolved.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
		</div>`
			: null}
	</div>`;
}

/** Sub-agent batch or workflow progress, from tool details (live or final). */
function AgentDetails({ details }) {
	if (!details) return null;
	if (details.phases) {
		return html`<div class="sub-agent">
			<div class="dim sub-head">${t("Workflow")} ${details.name ? html`<strong>${details.name}</strong>` : ""} · ${t(details.status)}${details.model ? ` · ${details.model}` : ""}</div>
			${details.phases.map(
				(phase, i) => html`<div class="sub-phase" key=${i}>
				<div class="row"><span class=${`badge ${phase.status === "completed" ? "ok" : phase.status === "running" ? "accent" : ""}`}>${t(phase.status)}</span><strong class="truncate grow">${phase.name}</strong><span class="dim">${phase.completed}/${phase.total}</span></div>
				${phase.results.map((task, j) => html`<${TaskResult} key=${j} task=${task} />`)}
			</div>`,
			)}
		</div>`;
	}
	if (details.results) {
		return html`<div class="sub-agent"><div class="dim sub-head">${`${t("{completed}/{total} tasks done", { completed: details.completed, total: details.total })}${details.background ? ` · ${t("running in the background")}` : ""}${details.model ? ` · ${details.model}` : ""}`}</div>${details.results.map((task, j) => html`<${TaskResult} key=${j} task=${task} />`)}</div>`;
	}
	return null;
}

const ActionRow = memo(function ActionRow({ step, defaultOpen }) {
	const [open, setOpen] = useState(!!defaultOpen);
	const subAgents = useStore((st) => st.subAgents);
	const resultDetails = step.result?.details;
	const liveDetails = step.kind === "agent" ? (resultDetails?.batchId && subAgents[resultDetails.batchId]) || resultDetails || step.run?.partialDetails : undefined;
	const statusIcon = step.status === "running" || step.status === "pending" ? html`<${Spinner} />` : step.isError ? html`<${Icon} name="alertCircle" size=${14} class="c-danger" />` : step.status === "cancelled" ? html`<${Icon} name="stopCircle" size=${14} class="c-dim" />` : html`<${Icon} name=${KIND_ICON[step.kind] || "wrench"} size=${14} class="c-dim" />`;
	const took = step.startedAt && step.endedAt && step.endedAt - step.startedAt >= 1000 ? fmtDuration(step.endedAt - step.startedAt) : "";
	const exit = step.result?.details?.exitCode;
	return html`<div class=${`action ${step.isError ? "err" : ""} ${step.status}`}>
		<div class="action-row" onClick=${() => setOpen(!open)} role="button" tabindex="0" onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}>
			<span class="action-ico">${statusIcon}</span>
			<span class="action-text truncate">
				<span class=${step.status === "running" ? "shimmer-text" : "verb"}>${step.verb}</span>
				${step.target ? html` <span class=${step.kind === "run" ? "mono target" : "target"}>${step.target}</span>` : null}
				${step.detail ? html` <span class="dim">${step.detail}</span>` : null}
				${step.extra ? html` <span class="add">+${step.extra.additions}</span> <span class="del">−${step.extra.deletions}</span>` : null}
				${exit ? html` <span class="err-text">${t("exit {exit}", { exit })}</span>` : null}
				${step.status === "cancelled" ? html` <span class="dim">${t("not finished")}</span>` : null}
			</span>
			<span class="action-tail">
				${took ? html`<span class="dim">${took}</span>` : null}
				${step.kind === "run" ? html`<button class="link-btn" title=${t("Open in Terminal")} onClick=${(e) => (e.stopPropagation(), actions.openTerminal(step.call.id))}>${t("Terminal")}</button>` : null}
				${(step.kind === "edit" || step.kind === "write") && step.path && !step.isError ? html`<button class="link-btn" title=${t("Open in Changes")} onClick=${(e) => (e.stopPropagation(), actions.openChanges({ path: step.path }))}>${t("Diff")}</button>` : null}
				${step.kind === "read" && step.path ? html`<button class="link-btn" title=${t("Open file")} onClick=${(e) => (e.stopPropagation(), actions.openFile(step.path))}>${t("Open")}</button>` : null}
				<${Icon} name=${open ? "chevronUp" : "chevronDown"} size=${13} class="c-dim" />
			</span>
		</div>
		${step.kind === "agent" ? html`<${AgentDetails} details=${liveDetails} />` : null}
		${open ? html`<${RawDetails} step=${step} />` : null}
	</div>`;
});

function Group({ group, forceOpen }) {
	const [open, setOpen] = useState(!!forceOpen);
	const list = group.actions;
	if (list.length === 1) return html`<${ActionRow} step=${list[0]} />`;
	const failed = list.filter((a) => a.isError).length;
	const running = list.some((a) => a.status === "running" || a.status === "pending");
	return html`<div class="group">
		<button class="group-head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
			<span class="action-ico"><${Icon} name=${KIND_ICON[group.kind] || "wrench"} size=${14} class="c-dim" /></span>
			<span class=${`group-label truncate ${running ? "shimmer-text" : ""}`}>${groupLabel(group.kind, list)}</span>
			${failed ? html`<span class="badge danger">${t("{failed} failed", { failed })}</span>` : null}
			<${Icon} name=${open ? "chevronUp" : "chevronDown"} size=${13} class="c-dim" />
		</button>
		${open ? html`<div class="group-body">${list.map((step) => html`<${ActionRow} key=${step.key} step=${step} />`)}</div>` : null}
	</div>`;
}

/** Reasoning summaries usually start with a bold one-line title; use it as the row's name and keep the rest as the body. */
const HEADING = /^\s*\*\*([^*\n]{1,120})\*\*[ \t]*(?:\r?\n|$)/;

function splitThinking(text) {
	const match = HEADING.exec(text || "");
	return match ? { title: match[1].trim(), body: text.slice(match[0].length).trim() } : { title: "", body: (text || "").trim() };
}

function Thinking({ step }) {
	const [open, setOpen] = useState(false);
	const { title, body } = useMemo(() => splitThinking(step.text), [step.text]);
	const has = !!(title || body);
	const label = step.live ? (title ? clip(title, 90) : t("Thinking…")) : has ? (title ? clip(title, 90) : t("Reasoning")) : t("Reasoning (not exposed by the model)");
	return html`<div class="thinking">
		<button class="group-head" onClick=${() => body && setOpen(!open)} disabled=${!body} aria-expanded=${open}>
			<span class="action-ico"><${Icon} name="brain" size=${14} class="c-dim" /></span>
			<span class=${`group-label truncate ${step.live ? "shimmer-text" : ""}`}>${label}</span>
			${body ? html`<${Icon} name=${open ? "chevronUp" : "chevronDown"} size=${13} class="c-dim" />` : null}
		</button>
		${open && body ? html`<div class="thinking-text"><${Markdown} text=${body} onOpenFile=${actions.openFile} /></div>` : null}
	</div>`;
}

function CustomStep({ step, onOpenFile }) {
	const item = step.item;
	const [open, setOpen] = useState(false);
	const label = item.customType.replace(/[-_]/g, " ");
	return html`<div class="thinking">
		<button class="group-head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
			<span class="action-ico"><${Icon} name="info" size=${14} class="c-dim" /></span>
			<span class="group-label truncate">${label}</span>
			<${Icon} name=${open ? "chevronUp" : "chevronDown"} size=${13} class="c-dim" />
		</button>
		${open ? html`<div class="thinking-text"><${Markdown} text=${item.text} onOpenFile=${onOpenFile} /></div>` : null}
	</div>`;
}

function StepList({ turn, onOpenFile }) {
	const groups = useMemo(() => groupSteps(turn.steps), [turn.steps]);
	if (!groups.length) return html`<div class="dim steps-empty">${t("No intermediate steps.")}</div>`;
	return html`<div class="steps">
		${groups.map((entry) => {
			if (entry.type === "note") return html`<div class="note" key=${entry.key}><${Markdown} text=${entry.text} onOpenFile=${onOpenFile} /></div>`;
			if (entry.type === "thinking") return html`<${Thinking} key=${entry.key} step=${entry} />`;
			if (entry.type === "custom") return html`<${CustomStep} key=${entry.key} step=${entry} onOpenFile=${onOpenFile} />`;
			return html`<${Group} key=${entry.key} group=${entry} />`;
		})}
	</div>`;
}

// ---- Run summary -------------------------------------------------------------------------------
function currentActivity(turn, run) {
	const steps = turn.steps;
	for (let i = steps.length - 1; i >= 0; i--) {
		const s = steps[i];
		if (s.type === "action" && (s.status === "running" || s.status === "pending")) return `${s.verb}${s.target ? ` ${clip(s.target, 70)}` : ""}`;
		if (s.type === "thinking" && s.live) return t("Thinking…");
	}
	if (run?.activity) return serverText(run.activity, t("Working…"));
	return t("Working…");
}

function summaryText({ outcome, duration, stats, changeCount, live }) {
	const bits = [];
	if (stats.actions) bits.push(plural(stats.actions, "action"));
	if (changeCount) bits.push(t("{files} changed", { files: plural(changeCount, "file") }));
	const tail = bits.length ? ` · ${bits.join(" · ")}` : "";
	const dur = duration ? fmtDuration(duration) : "";
	if (live) return "";
	switch (outcome) {
		case "completed":
			return `${dur ? t("Worked for {duration}", { duration: dur }) : t("Worked")}${tail}`;
		case "partial":
			return `${t("Partially completed")}${dur ? ` · ${dur}` : ""}${tail}`;
		case "failed":
			return `${dur ? t("Failed after {duration}", { duration: dur }) : t("Failed")}${tail}`;
		case "cancelled":
			return `${dur ? t("Cancelled after {duration}", { duration: dur }) : t("Cancelled")}${tail}`;
		default:
			return `${OUTCOME_LABEL[outcome] ? t(OUTCOME_LABEL[outcome]) : outcome}${tail}`;
	}
}

function ProcessSummary({ turn, outcome, live, run, changeCount, duration, snapRun, defaultOpen, onOpenFile }) {
	const [open, setOpen] = useState(defaultOpen);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!live) return undefined;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [live]);
	if (!turn.steps.length && !live) return null;
	const stats = turn.stats;
	const elapsed = live ? now - (snapRun?.startedAt || turn.startedAt || now) : duration;
	const icon = live ? html`<${Spinner} />` : html`<${Icon} name=${OUTCOME_ICON[outcome] || "checkCircle"} size=${14} class=${`c-${outcome}`} />`;
	const label = live ? currentActivity(turn, snapRun) : summaryText({ outcome, duration, stats, changeCount });
	return html`<div class=${`summary ${live ? "live" : ""} o-${outcome}`}>
		<button class="summary-head" onClick=${() => setOpen(!open)} aria-expanded=${open} title=${open ? t("Hide steps") : t("Show what the agent did")}>
			<span class="summary-ico">${icon}</span>
			<span class=${`summary-text truncate ${live ? "shimmer-text" : ""}`}>${label}</span>
			${live ? html`<span class="summary-meta dim">${fmtDuration(elapsed)}${stats.actions ? ` · ${plural(stats.actions, "action")}` : ""}</span>` : null}
			${stats.failedActions && !live ? html`<span class="badge danger">${plural(stats.failedActions, "failed action")}</span>` : null}
			<${Icon} name=${open ? "chevronUp" : "chevronDown"} size=${14} class="c-dim" />
		</button>
		${open ? html`<div class="summary-body fade-in"><${StepList} turn=${turn} onOpenFile=${onOpenFile} /></div>` : null}
	</div>`;
}

// ---- Outcome banner: never folded away ---------------------------------------------------------
function OutcomeBanner({ turn, outcome, run, changeCount }) {
	if (outcome === "completed" || outcome === "running") return null;
	if (outcome === "waiting") {
		return html`<div class="banner o-waiting" role="status"><div class="banner-head"><${Icon} name="clock" size=${15} /><strong>${t("Waiting for you")}</strong><span class="dim">${t("The agent is paused until you answer the question above the input box.")}</span></div></div>`;
	}
	const error = run?.error || turn.error?.message;
	const commands = run?.bashRuns ?? turn.stats.commands;
	const facts = [];
	if (run) facts.push(changeCount ? t("{files} changed", { files: plural(changeCount, "file") }) : t("No files were changed"));
	else facts.push(changeCount ? t("{files} edited", { files: plural(changeCount, "file") }) : t("No file edits were recorded"));
	if (commands) facts.push(run ? t("{commands} ran (side effects outside the workspace cannot be ruled out)", { commands: plural(commands, "command") }) : t("{commands} ran and may have changed files — check the Changes panel", { commands: plural(commands, "command") }));
	if (turn.stats.failedActions) facts.push(t("{actions} failed", { actions: plural(turn.stats.failedActions, "action") }));
	const titles = { partial: N_("Partially completed"), failed: N_("Failed"), cancelled: N_("Cancelled"), waiting: N_("Waiting for you"), unanswered: N_("No response") };
	const blurbs = { cancelled: N_("You stopped this run before it finished."), unanswered: N_("The message was sent but the agent did not respond.") };
	const blurb = blurbs[outcome] ? t(blurbs[outcome]) : "";
	return html`<div class=${`banner o-${outcome}`} role="status">
		<div class="banner-head"><${Icon} name=${OUTCOME_ICON[outcome]} size=${15} /><strong>${titles[outcome] ? t(titles[outcome]) : outcome}</strong></div>
		${error ? html`<div class="banner-error">${clip(serverText(error, t("The task did not finish.")), 800)}</div>` : blurb ? html`<div class="banner-error">${blurb}</div>` : null}
		<div class="banner-facts dim">${facts.join(" · ")}${run?.reliability === "indeterminate" ? ` · ${t("change detection may be incomplete")}` : ""}</div>
		<div class="banner-actions">
			${changeCount ? html`<button class="btn sm" onClick=${() => actions.openChanges({ runId: run?.runId })}>${t("View changes")}</button>` : null}
			${turn.user && outcome !== "cancelled" ? html`<button class="btn sm" onClick=${() => actions.retry(turn.user)}>${t("Retry")}</button>` : null}
			${run?.uncommitted ? html`<button class="btn sm" onClick=${() => actions.openChanges({ runId: run?.runId, git: true })}>${t("Undo or commit")}</button>` : null}
		</div>
	</div>`;
}

// ---- Messages ----------------------------------------------------------------------------------
function UserMessage({ item, turn }) {
	return html`<div class="user-row">
		<div class="user-bubble" title=${new Date(item.ts).toLocaleString(getLang())}>
			${item.command ? html`<div class="chip-line"><span class="badge accent">/${item.command.name}</span></div>` : null}
			${item.skill ? html`<div class="chip-line"><span class="badge accent">${t("skill: {name}", { name: item.skill.name })}</span></div>` : null}
			${item.images?.length ? html`<div class="user-images">${item.images.map((img, i) => html`<img key=${i} src=${`data:${img.mimeType};base64,${img.data}`} alt=${t("attached image")} />`)}</div>` : null}
			${item.text ? html`<div class="user-text">${item.text}</div>` : null}
		</div>
		<div class="msg-actions">
			<${CopyButton} text=${item.text} label=${t("Copy message")} />
			${item.id ? html`<button class="icon-btn sm" title=${t("Edit and resend from here (forks the session)")} aria-label=${t("Edit and resend")} onClick=${() => actions.editAndResend(item)}><${Icon} name="edit" size=${14} /></button>` : null}
		</div>
	</div>`;
}

const fmtCount = (n) => Math.round(n).toLocaleString(getLang());

function FinalMessage({ final, onOpenFile }) {
	const message = final.message;
	const usage = message.usage;
	return html`<div class=${`final ${final.streaming ? "streaming" : ""}`}>
		<${Markdown} text=${final.text} onOpenFile=${onOpenFile} />
		${final.partial ? html`<div class="dim partial-note">${t("The response was cut off.")}</div>` : null}
		${!final.streaming ? html`<div class="msg-actions final-actions">
			<${CopyButton} text=${final.text} label=${t("Copy answer")} />
			<span class="dim msg-meta truncate">${message.model}${usage ? ` · ${[usage.input + usage.cacheRead > 0 ? t("{n} tokens in", { n: fmtCount(usage.input + usage.cacheRead) }) : "", usage.output ? t("{n} tokens out", { n: fmtCount(usage.output) }) : ""].filter(Boolean).join(" / ")}` : ""}</span>
		</div>` : null}
	</div>`;
}

/** Added / removed lines of one file, or nothing when the diff could not be counted (binary, too large, no baseline). */
const lineCounts = (file) => (file.binary || file.unavailable ? null : html`<span class="counts"><span class="add">+${file.additions}</span><span class="del">−${file.deletions}</span></span>`);

/**
 * What a finished task changed, at the end of its turn: the files it really changed with their added and removed
 * lines, from the task's own diff (GET /api/changes, the same data as Changes → This task). A row opens that file's
 * diff in the Changes panel. Nothing is shown for a task the server no longer has a record of.
 */
function ChangeCard({ run }) {
	const [files, setFiles] = useState(null);
	useEffect(() => {
		let cancelled = false;
		api(`/api/changes?scope=run&runId=${run.runId}`)
			.then((data) => !cancelled && setFiles(data.run ? data.files : []))
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [run.runId, run.changeCount]);
	if (!files?.length) return null;
	const counted = files.every((file) => !file.binary && !file.unavailable);
	const open = (path) => actions.openChanges({ runId: run.runId, path, scope: "run" });
	return html`<div class="change-card fade-in">
		<button class="change-head" onClick=${() => open()} title=${t("Review what this task changed")}>
			<span class="grow truncate">${t("Edited {files}", { files: plural(files.length, "file") })}</span>
			${counted ? lineCounts({ additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) }) : null}
		</button>
		${files.map((file) => {
			const dir = dirname(file.path);
			return html`<button class="change-file" key=${file.path} onClick=${() => open(file.path)} title=${t("Open the diff of {path}", { path: file.path })}>
				<span class="change-path truncate">${dir ? html`<span class="dim">${dir}/</span>` : null}${basename(file.path)}</span>
				${lineCounts(file)}
				<${Icon} name="chevronRight" size=${13} class="c-dim" />
			</button>`;
		})}
	</div>`;
}

const TurnView = memo(function TurnView({ turn, isLast, live, waiting, run, cwd, processDefault, snapRun }) {
	const outcome = turnOutcome(turn, { run, live, waiting });
	const changeCount = run ? run.changeCount : turn.stats.files;
	const duration = turnDuration(turn, run);
	const onOpenFile = actions.openFile;
	return html`<section class=${`turn ${live ? "live" : ""}`}>
		${turn.user ? html`<${UserMessage} item=${turn.user} turn=${turn} />` : null}
		<${ProcessSummary} turn=${turn} outcome=${outcome} live=${live || waiting} run=${run} changeCount=${changeCount} duration=${duration} snapRun=${snapRun} defaultOpen=${processDefault === "expanded"} onOpenFile=${onOpenFile} key=${`sum-${turn.key}-${live}`} />
		${turn.final ? html`<${FinalMessage} final=${turn.final} onOpenFile=${onOpenFile} />` : null}
		${run?.changeCount ? html`<${ChangeCard} run=${run} />` : null}
		<${OutcomeBanner} turn=${turn} outcome=${outcome} run=${run} changeCount=${changeCount} />
	</section>`;
});

function BashCard({ item }) {
	const [open, setOpen] = useState(false);
	const status = item.status || (item.cancelled ? "cancelled" : item.timedOut ? "timeout" : item.exitCode ? "failed" : item.exitCode === undefined && item.status === "running" ? "running" : "done");
	const output = item.output || "";
	const lines = output.split("\n");
	const preview = lines.slice(-8).join("\n");
	const label = { running: t("Running"), done: t("Ran"), failed: t("Exited {code}", { code: item.exitCode }), cancelled: t("Cancelled"), timeout: t("Timed out"), error: t("Failed to start") }[status] || t("Ran");
	return html`<div class=${`bash-card s-${status}`}>
		<div class="bash-head">
			<span class="mono bash-cmd truncate"><span class="dim">$</span> ${item.command}</span>
			${item.excludeFromContext ? html`<span class="badge">${t("not in context")}</span>` : null}
			<span class=${`badge ${status === "done" ? "ok" : status === "running" ? "accent" : "danger"}`}>${status === "running" ? html`<${Spinner} />` : null}${label}</span>
			<button class="icon-btn sm" title=${t("Open in Terminal")} onClick=${() => actions.openTerminal(item.id || item.command)}><${Icon} name="terminal" size=${14} /></button>
		</div>
		${output ? html`<pre class="bash-out"><${Ansi} text=${open ? output : preview} /></pre>${lines.length > 8 ? html`<button class="btn sm ghost" onClick=${() => setOpen(!open)}>${open ? t("Show less") : t("Show all {length} lines", { length: lines.length })}</button>` : null}` : null}
		${item.truncated && item.fullOutputPath ? html`<div class="dim bash-note">${t("Output truncated. Full output saved at {fullOutputPath}", { fullOutputPath: item.fullOutputPath })}</div>` : null}
	</div>`;
}

function Standalone({ item }) {
	const [open, setOpen] = useState(false);
	if (item.kind === "bash") return html`<${BashCard} item=${item} />`;
	if (item.kind === "compaction" || item.kind === "branchSummary") {
		const title = item.kind === "compaction" ? (item.tokensBefore ? t("Context compacted (was ~{k}k tokens)", { k: Math.round(item.tokensBefore / 1000) }) : t("Context compacted")) : t("Returned from another branch");
		return html`<div class="marker"><button class="marker-head" onClick=${() => setOpen(!open)}><span class="marker-line" /><span class="marker-text"><${Icon} name=${item.kind === "compaction" ? "layers" : "gitBranch"} size=${13} /> ${title}<${Icon} name=${open ? "chevronUp" : "chevronDown"} size=${12} /></span><span class="marker-line" /></button>
			${open ? html`<div class="marker-body"><${Markdown} text=${item.summary} onOpenFile=${actions.openFile} /></div>` : null}</div>`;
	}
	if (item.kind === "reload") return html`<div class="marker"><span class="marker-text">${item.ok ? t("Configuration reloaded") : t("Reload failed: {error}", { error: item.error })}</span></div>`;
	if (item.kind === "custom") {
		return html`<div class="custom-card"><div class="dim custom-type">${item.customType.replace(/[-_]/g, " ")}</div><${Markdown} text=${item.text} onOpenFile=${actions.openFile} /></div>`;
	}
	return null;
}

function Welcome({ snap, models }) {
	const ws = snap?.workspace?.name;
	const model = snap?.model;
	return html`<div class="welcome">
		<h1>${ws ? tNodes("What should we work on in {workspace}?", { workspace: html`<span class="ws">${ws}</span>` }) : t("What should we work on?")}</h1>
		<div class="welcome-meta dim mono truncate">${snap?.cwd || ""}</div>
		<div class="welcome-tips dim">
			<span><span class="kbd">/</span> ${t("commands & skills")}</span>
			<span><span class="kbd">@</span> ${t("mention a file")}</span>
			<span><span class="kbd">!</span> ${t("run a shell command")}</span>
			<span><span class="kbd">${t("Ctrl")}</span>+<span class="kbd">K</span> ${t("command palette")}</span>
		</div>
		${!model ? html`<div class="welcome-warn"><${Icon} name="alertTriangle" size=${15} /> ${tNodes("No model is available yet. {add} to start.", { add: html`<button class="link-btn" onClick=${() => setView({ settingsOpen: true, settingsSection: "providers" })}>${t("Add a provider")}</button>` })}</div>` : null}
	</div>`;
}

// ---- Transcript container ------------------------------------------------------------------------
export function Transcript() {
	const items = useStore((s) => s.items);
	const toolRuns = useStore((s) => s.toolRuns);
	const runs = useStore((s) => s.runs);
	const snap = useStore((s) => s.snap);
	const dialogs = useStore((s) => s.dialogs);
	const userBash = useStore((s) => s.userBash);
	const order = useStore((s) => s.userBashOrder);
	const processDefault = useStore((s) => s.view.processDefault);
	const models = useStore((s) => s.models);
	const cwd = snap?.cwd || "";
	const active = !!snap?.active || !!snap?.flags?.completion;
	const prevTurns = useRef(null);
	const turns = useMemo(() => {
		const built = buildTurns(items, { cwd, toolRuns }, prevTurns.current);
		prevTurns.current = built;
		return built;
	}, [items, toolRuns, cwd]);

	// Scroll behaviour: follow new output only while the reader is at the bottom.
	const scroller = useRef(null);
	const content = useRef(null);
	const stick = useRef(true);
	const lastInteract = useRef(0);
	const [away, setAway] = useState(false);
	const lastTop = useRef(0);
	const programmatic = useRef(false);
	const onScroll = () => {
		const el = scroller.current;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
		// Only an upward move by the reader releases the follow-lock; content growth never does.
		if (programmatic.current) programmatic.current = false;
		else if (el.scrollTop < lastTop.current - 2) stick.current = false;
		if (near) stick.current = true;
		lastTop.current = el.scrollTop;
		setAway((prev) => (prev === !near ? prev : !near));
		const header = document.querySelector(".main-header");
		header?.classList.toggle("scrolled", el.scrollTop > 4);
	};
	const noteInteraction = () => {
		lastInteract.current = Date.now();
	};
	const toBottom = (smooth = false) => {
		const el = scroller.current;
		if (!el) return;
		programmatic.current = true;
		if (smooth) return el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
		el.scrollTop = el.scrollHeight;
		lastTop.current = el.scrollTop;
	};
	useLayoutEffect(() => {
		if (stick.current && Date.now() - lastInteract.current > 500) toBottom();
	}, [items, order, userBash, toolRuns]);
	useEffect(() => {
		if (!content.current || typeof ResizeObserver === "undefined") return undefined;
		const ro = new ResizeObserver(() => {
			if (stick.current && Date.now() - lastInteract.current > 500) toBottom();
		});
		ro.observe(content.current);
		return () => ro.disconnect();
	}, []);
	const session = snap?.session?.id;
	useLayoutEffect(() => {
		stick.current = true;
		toBottom();
	}, [session]);

	const lastTurnIndex = (() => {
		for (let i = turns.length - 1; i >= 0; i--) if (!turns[i].standalone) return i;
		return -1;
	})();
	// Long sessions: render the most recent turns and let the reader load earlier ones on demand.
	const [limit, setLimit] = useState(60);
	const hidden = Math.max(0, turns.length - limit);
	const shown = hidden ? turns.slice(hidden) : turns;
	const heightBefore = useRef(0);
	useLayoutEffect(() => {
		if (heightBefore.current && scroller.current) {
			scroller.current.scrollTop += scroller.current.scrollHeight - heightBefore.current;
			heightBefore.current = 0;
		}
	}, [limit]);
	useEffect(() => setLimit(60), [session]);
	const waiting = dialogs.length > 0 && active;
	const liveBash = order.map((id) => userBash[id]).filter((entry) => entry && entry.status === "running");
	const empty = turns.length === 0 && liveBash.length === 0;

	return html`<div class="transcript-wrap">
		<div class="transcript" ref=${scroller} onScroll=${onScroll} onWheel=${noteInteraction} onMouseDown=${noteInteraction} onKeyDown=${noteInteraction}>
			<div class="transcript-inner" ref=${content}>
				${empty ? html`<${Welcome} snap=${snap} models=${models} />` : null}
				${hidden ? html`<button class="btn sm ghost earlier" onClick=${() => { heightBefore.current = scroller.current?.scrollHeight || 0; stick.current = false; setLimit(limit + 60); }}>${t("Show earlier messages ({hidden} hidden)", { hidden })}</button>` : null}
				${shown.map((turn, i) => {
					const index = hidden + i;
					if (turn.standalone) return html`<${Standalone} key=${turn.key} item=${turn.standalone} />`;
					const isLast = index === lastTurnIndex;
					const live = isLast && active;
					const run = live ? undefined : runForTurn(turn, runs, isLast);
					return html`<${TurnView} key=${turn.key} turn=${turn} isLast=${isLast} live=${live} waiting=${live && waiting} run=${run} cwd=${cwd} processDefault=${processDefault} snapRun=${live ? snap?.run : undefined} />`;
				})}
				${liveBash.map((entry) => html`<${BashCard} key=${entry.id} item=${entry} />`)}
				<div class="transcript-end" />
			</div>
		</div>
		${away ? html`<button class="jump-btn" onClick=${() => { stick.current = true; toBottom(true); }} title=${active ? t("Follow live output") : t("Jump to latest")} aria-label=${active ? t("Follow live output") : t("Jump to latest")}><${Icon} name="arrowDown" size=${16} /></button>` : null}
	</div>`;
}
