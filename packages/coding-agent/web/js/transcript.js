// Transcript: quiet reading surface. Each turn = user message, a collapsed run summary, the final answer,
// and (only when relevant) an outcome banner. Details open in layers: summary -> steps -> raw tool data.
import { html, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, Collapse, Counts, Fold, Icon, Spinner, CopyButton, usePresence, useHeightGlide } from "./ui.js";
import { activeSlotId, api, fetchMoreTranscript, getTurnsCache, setTurnsCache, setView, useStore } from "./store.js";
import { GitRecord } from "./git-record.js";
import { Markdown } from "./markdown.js";
import { DiffView, languageFor, parsePatch } from "./diff.js";
import { buildTurns, buildTurnsAsync, cachedTurns, changeTotals, groupSteps, groupLabel, runForTurn, turnDuration, turnOutcome, turnSegments } from "./turns.js";
import { actions, openCommand } from "./actions.js";
import { KIND_ICON, StatusGlyph, WebSteps } from "./tool-rows.js";
import { StepCounts } from "./step-counts.js";
import { basename, clip, dirname, fmtBytes, fmtDuration, fmtShortDuration, fmtTokens, plural, formatData, ansiSegments } from "./util.js";
import { t, N_, serverText, tNodes, getLang } from "./i18n.js";
import { openImageLightbox } from "./lightbox.js";
import { exportReadOnly } from "./export-mode.js";

import { OUTCOME_ICON, processSummaryState } from "./process-summary.js";

// ---- Small pieces ----------------------------------------------------------------------------
function Ansi({ text }) {
	const segments = useMemo(() => ansiSegments(text), [text]);
	return html`${segments.map((seg, i) => (Object.keys(seg.style).length ? html`<span key=${i} style=${seg.style}>${seg.text}</span>` : seg.text))}`;
}

// "Show all" of a large text used to paste the whole thing into one <pre> in a single synchronous
// render (a 1 MB output measured 590-860 ms of blocked main thread on a 2026-10-12 lab run). The
// expanded text is therefore appended in blocks: the first block renders immediately, the rest is
// appended through requestIdleCallback — one block per idle slot, with a plain setTimeout as the
// backstop because idle callbacks are throttled to a standstill while the page is hidden. Collapsing
// the card or unmounting the component stops the chain and drops every pending callback.
// Blocks are separate child nodes of the <pre> and never rewritten: setting `textContent` again with
// the longer string made the browser lay out the whole block again each time (~70 ms for the last
// 100 KB of a 1 MB pre, measured in isolation 2026-10-12), which would put every append back over
// the long-task budget. Appending one node at the end keeps the cost at the new block only.
const SHOW_ALL_CHUNK = 100 * 1024;

/** The first `pos` characters of `text` as stable 100 KB blocks — one `Ansi` child per block. */
function ChunkedAnsi({ text, pos }) {
	const blocks = [];
	for (let start = 0; start < pos; start += SHOW_ALL_CHUNK) blocks.push(html`<${Ansi} key=${start} text=${text.slice(start, Math.min(start + SHOW_ALL_CHUNK, pos))} />`);
	return blocks;
}

function useChunkedShowAll(text) {
	const [pos, setPos] = useState(0);
	const posRef = useRef(0);
	const textRef = useRef(text);
	textRef.current = text;
	const handles = useRef([]);
	const clearPending = () => {
		for (const handle of handles.current) {
			if (handle.idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(handle.idle);
			clearTimeout(handle.timeout);
		}
		handles.current = [];
	};
	useEffect(() => () => clearPending(), []);
	const scheduleNext = () => {
		const handle = { timeout: undefined, idle: undefined, done: false };
		const run = () => {
			if (handle.done) return;
			handle.done = true;
			appendBlock();
		};
		if (typeof requestIdleCallback === "function") handle.idle = requestIdleCallback(run, { timeout: 100 });
		handle.timeout = setTimeout(run, 100);
		handles.current.push(handle);
	};
	const appendBlock = () => {
		clearPending();
		const full = textRef.current.length;
		posRef.current = Math.min(posRef.current + SHOW_ALL_CHUNK, full);
		setPos(posRef.current);
		if (posRef.current < full) scheduleNext();
	};
	const expand = () => {
		clearPending();
		const full = textRef.current.length;
		posRef.current = Math.min(SHOW_ALL_CHUNK, full);
		setPos(posRef.current);
		if (posRef.current < full) scheduleNext();
	};
	const collapse = () => {
		clearPending();
		posRef.current = 0;
		setPos(0);
	};
	return { expanded: pos > 0, pos, expand, collapse };
}

function Output({ text, max = 20_000, tail = false }) {
	const glide = useHeightGlide();
	const show = useChunkedShowAll(text);
	const inner = show.expanded
		? html`<${ChunkedAnsi} text=${text} pos=${show.pos} />`
		: html`<${Ansi} text=${text.length > max ? (tail ? text.slice(-max) : text.slice(0, max)) : text} />`;
	return html`<div class="raw-block" ref=${glide.ref}><pre class="raw-pre">${inner}</pre>
		${text.length > max ? html`<button class="btn sm ghost" onClick=${() => glide.run(() => (show.expanded ? show.collapse() : show.expand()))}>${show.expanded ? t("Show less") : t("Show all ({fmtBytes})", { fmtBytes: fmtBytes(text.length) })}</button>` : null}</div>`;
}

const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;
// Above this size running the text through the markdown parser is itself the long task: the block
// stays a plain <pre> (still appended in chunks by the same "show all" mechanism).
const MARKDOWN_PLAIN_LIMIT = 200 * 1024;

/** Text read from a Markdown file renders like the chat; everything else stays plain/code output. */
function MarkdownOutput({ text, max = 60_000 }) {
	const glide = useHeightGlide();
	const show = useChunkedShowAll(text);
	const plain = text.length > MARKDOWN_PLAIN_LIMIT;
	const shown = show.expanded ? text.slice(0, show.pos) : text.length > max ? text.slice(0, max) : text;
	const body = !plain
		? html`<${Markdown} text=${shown} />`
		: show.expanded
			? html`<pre class="raw-pre"><${ChunkedAnsi} text=${text} pos=${show.pos} /></pre>`
			: html`<pre class="raw-pre"><${Ansi} text=${shown} /></pre>`;
	return html`<div class="raw-block raw-md" ref=${glide.ref}>${body}
		${text.length > max ? html`<button class="btn sm ghost" onClick=${() => glide.run(() => (show.expanded ? show.collapse() : show.expand()))}>${show.expanded ? t("Show less") : t("Show all ({fmtBytes})", { fmtBytes: fmtBytes(text.length) })}</button>` : null}</div>`;
}

function RawDetails({ step }) {
	const { call, result, run } = step;
	const details = result?.details;
	const [showDetails, setShowDetails] = useState(false);
	const output = result?.text ?? run?.partial ?? "";
	const exitCode = details?.exitCode;
	// The server replaces oversized details with { truncatedDetails, originalChars }; show a quiet note instead of the raw fields.
	const originalChars = typeof details?.originalChars === "number" && Number.isFinite(details.originalChars) ? details.originalChars : undefined;
	return html`<div class="raw">
		<div class="raw-meta">
			<span class="raw-key">${t("tool")}</span><code>${call.name}</code>
			${exitCode !== undefined && exitCode !== null ? html`<span class="raw-key">${t("exit code")}</span><code class=${exitCode ? "err" : ""}>${exitCode}</code>` : null}
			${step.startedAt && step.endedAt ? html`<span class="raw-key">${t("took")}</span><code>${fmtShortDuration(step.endedAt - step.startedAt)}</code>` : null}
			<span class="raw-key">${t("id")}</span><code class="dim">${clip(call.id.split("|")[0], 24)}</code>
		</div>
		<div class="raw-body">
			<div class="raw-section">
				<div class="raw-label">${t("Arguments")}</div>
				<pre class="raw-pre">${formatData(call.args)}</pre>
			</div>
			${output ? html`<div class=${`raw-section${result?.isError ? " raw-err" : ""}`}>
				<div class="raw-label">${result ? (result.isError ? t("Error output") : t("Result")) : t("Output so far")}</div>
				${step.kind === "read" && result && !result.isError && MARKDOWN_PATH.test(step.path || "") ? html`<${MarkdownOutput} text=${output} />` : html`<${Output} text=${output} tail=${step.kind === "run"} />`}
			</div>` : null}
			${result?.images?.length ? html`<div class="raw-images">${result.images.map((img, i) => {
				const src = `data:${img.mimeType};base64,${img.data}`;
				const name = t("tool image");
				const zoomable = src.startsWith("data:") || src.startsWith("blob:"); // the page CSP only allows these two
				return html`<img key=${i} src=${src} alt=${name} role=${zoomable ? "button" : undefined} tabindex=${zoomable ? 0 : undefined} aria-label=${zoomable ? t("Preview image {name}", { name }) : undefined} onClick=${zoomable ? () => openImageLightbox(src, name) : undefined} onKeyDown=${zoomable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openImageLightbox(src, name); } } : undefined} />`;
			})}</div>` : null}
			${details && Object.keys(details).length
				? details.truncatedDetails === true
					? html`<div class="raw-note">${originalChars !== undefined
							? t("Result details are too large to show ({chars} characters). The full content is kept in the session JSONL file.", { chars: originalChars.toLocaleString(getLang()) })
							: t("Result details are too large to show. The full content is kept in the session JSONL file.")}</div>`
					: html`<div class="raw-extra">
						<button class="raw-extra-head" aria-expanded=${showDetails} title=${showDetails ? t("Hide result details") : t("Show result details")} onClick=${() => setShowDetails(!showDetails)}>
							<${Icon} name="chevronRight" size=${13} class="disclose" /><span class="raw-extra-title">${t("Result details")}</span><span class="grow" /><span class="raw-extra-hint">${showDetails ? t("Hide") : t("Show")}</span>
						</button>
						<${Collapse} open=${showDetails}><pre class="raw-pre">${formatData(details)}</pre><//>
					</div>`
				: null}
		</div>
	</div>`;
}

const TASK_DOT = { running: "accent", completed: "ok", partial: "warn", failed: "danger", timeout: "danger", cancelled: "" };

function TaskResult({ task }) {
	const [open, setOpen] = useState(false);
	const toggle = () => setOpen(!open);
	return html`<div class="sub-task">
		<div class="action-row" onClick=${toggle} role="button" tabindex="0" aria-expanded=${open} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<span class="action-ico">${task.status === "running" ? html`<${Spinner} />` : html`<span class=${`dot ${TASK_DOT[task.status] ?? ""}`} />`}</span>
			<span class="action-text truncate">${task.description || clip(task.prompt || "", 80)}</span>
			<span class="action-tail dim">${task.toolUseCount ? plural(task.toolUseCount, "tool call") : ""}${task.durationMs ? ` · ${fmtDuration(task.durationMs)}` : ""}<${Fold} /></span>
		</div>
		${task.status === "running" && task.lastToolInfo ? html`<div class="dim sub-last truncate">${task.lastToolInfo}</div>` : null}
		<${Collapse} open=${open}>
			<div class="sub-detail">
				${task.error ? html`<div class="c-danger">${task.error}</div>` : null}
				${task.output ? html`<${Markdown} text=${task.output} />` : html`<div class="dim">${t("No report yet.")}</div>`}
				${task.findings?.length ? html`<div class="raw-label">${t("Findings")}</div><ul class="sub-list">${task.findings.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
				${task.unresolved?.length ? html`<div class="raw-label">${t("Unresolved")}</div><ul class="sub-list">${task.unresolved.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : null}
			</div>
		<//>
	</div>`;
}

/** Sub-agent tasks that were still marked running when nothing is running any more (the main task was cancelled or ended): shown as stopped, without spinner or "running in the background". */
function settleDetails(details) {
	const stop = (task) => (task.status === "running" ? { ...task, status: "cancelled", lastToolInfo: undefined } : task);
	if (details.phases) {
		return { ...details, status: details.status === "running" ? "cancelled" : details.status, phases: details.phases.map((phase) => ({ ...phase, status: phase.status === "running" ? "cancelled" : phase.status, results: phase.results.map(stop) })) };
	}
	if (details.results) return { ...details, background: false, results: details.results.map(stop) };
	return details;
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

/** One tool call. Every kind of call has the same row: its glyph, what it did, a real count of lines when it changed a file, how long it took, and the fold arrow. */
const ActionRow = memo(function ActionRow({ step, defaultOpen }) {
	const [open, setOpen] = useState(!!defaultOpen);
	const subAgents = useStore((st) => st.subAgents);
	// Background batches legitimately outlive the call that started them, but only while the session still has some.
	const nothingRunning = useStore((st) => !st.snap?.active && !st.snap?.flags?.background);
	const resultDetails = step.result?.details;
	const rawDetails = step.kind === "agent" ? (resultDetails?.batchId && subAgents[resultDetails.batchId]) || resultDetails || step.run?.partialDetails : undefined;
	const stale = rawDetails && step.status !== "running" && (!rawDetails.background || nothingRunning);
	const liveDetails = stale ? settleDetails(rawDetails) : rawDetails;
	const took = step.startedAt && step.endedAt && step.endedAt - step.startedAt >= 1000 ? fmtDuration(step.endedAt - step.startedAt) : "";
	const exit = step.result?.details?.exitCode;
	const toggle = () => setOpen(!open);
	return html`<div class=${`action ${step.isError ? "err" : ""} ${step.status}`}>
		<div class="action-row" onClick=${toggle} role="button" tabindex="0" aria-expanded=${open} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<span class="action-ico"><${StatusGlyph} step=${step} /></span>
			<span class="action-text truncate">
				<span class=${step.status === "running" ? "shimmer-text" : "verb"}>${step.verb}</span>
				${step.target ? html` <span class=${step.kind === "run" ? "mono target" : "target"}>${step.target}</span>` : null}
				${step.detail ? html` <span class="dim">${step.detail}</span>` : null}
				${step.kind === "edit" || step.kind === "write" ? html` <${StepCounts} ...${step.extra} removed=${step.isError || step.status === "cancelled" ? 1 : 0} running=${!nothingRunning && (step.status === "running" || step.status === "pending")} />` : null}
				${exit ? html` <span class="err-text">${t("exit {exit}", { exit })}</span>` : null}
				${step.status === "cancelled" ? html` <span class="dim">${t("not finished")}</span>` : null}
			</span>
			<span class="action-tail">
				${took ? html`<span class="dim">${took}</span>` : null}
				<${Fold} />
			</span>
		</div>
		<${Collapse} open=${open}><${RawDetails} step=${step} /><//>
		${step.kind === "agent" ? html`<${AgentDetails} details=${liveDetails} />` : null}
	</div>`;
});

/** Consecutive calls of one kind. The web (searching and reading pages) is always one aggregate line, even for a single call. */
function Group({ group, forceOpen }) {
	const [open, setOpen] = useState(!!forceOpen);
	const nothingRunning = useStore((st) => !st.snap?.active && !st.snap?.flags?.background);
	const list = group.actions;
	if (list.length === 1 && !["web", "edit", "write"].includes(group.kind)) return html`<${ActionRow} step=${list[0]} />`;
	const failed = list.filter((a) => a.isError).length;
	const running = list.some((a) => a.status === "running" || a.status === "pending");
	let removed = 0;
	// Counts are only ever the real diffs the tools reported; a failed or cancelled call drops out.
	const counted = list.map((step) => {
		if (step.isError || step.status === "cancelled") {
			removed++;
			return { ...step, extra: undefined };
		}
		return step;
	});
	const totals = group.kind === "edit" || group.kind === "write" ? changeTotals(counted) : undefined;
	return html`<div class="group">
		<button class="group-head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
			<span class="action-ico">${running ? html`<${Spinner} />` : html`<${Icon} name=${KIND_ICON[group.kind] || "wrench"} size=${14} class="c-dim" />`}</span>
			<span class=${`group-label truncate ${running ? "shimmer-text" : ""}`}>${groupLabel(group.kind, list)}</span>
			${group.kind === "edit" || group.kind === "write" ? html`<${StepCounts} ...${totals} removed=${removed} running=${running && !nothingRunning} />` : null}
			${failed ? html`<span class="badge danger">${t("{failed} failed", { failed })}</span>` : null}
			<span class="grow" />
			<${Fold} />
		</button>
		<${Collapse} open=${open}>
			<div class="group-body">
				${group.kind === "web" ? html`<${WebSteps} actions=${list} rawFor=${(step) => html`<${RawDetails} step=${step} />`} />` : list.map((step) => html`<${ActionRow} key=${step.key} step=${step} />`)}
			</div>
		<//>
	</div>`;
}

/** Reasoning summaries usually start with a bold one-line title; use it as the row's name and keep the rest as the body. */
const HEADING = /^\s*\*\*([^*\n]{1,120})\*\*[ \t]*(?:\r?\n|$)/;

function splitThinking(text) {
	const match = HEADING.exec(text || "");
	return match ? { title: match[1].trim(), body: text.slice(match[0].length).trim() } : { title: "", body: (text || "").trim() };
}

/** High-frequency thinking text, merged to at most one commit per animation frame while live. The server sends the cumulative full text on every message_update, so keeping only the newest value in latestRef is lossless. When live becomes false (final state) the newest value is synced immediately for one full-fidelity calibration. Unmount cancels the pending frame. */
export function useRafBufferedText(liveText, live) {
	const [buffered, setBuffered] = useState(liveText);
	const latestRef = useRef(liveText);
	const rafRef = useRef(0);
	latestRef.current = liveText;
	useEffect(() => {
		if (!live) {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = 0;
			}
			if (buffered !== latestRef.current) setBuffered(latestRef.current);
			return undefined;
		}
		if (buffered === latestRef.current) return undefined;
		if (!rafRef.current) {
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = 0;
				setBuffered(latestRef.current);
			});
		}
		return undefined;
	}, [liveText, live]);
	useEffect(() => () => {
		if (rafRef.current) cancelAnimationFrame(rafRef.current);
	}, []);
	return buffered;
}

/** Split text into a markdown-safe stable part and a plain-text tail at the last blank line. When the stable part holds an unclosed ``` or ~~~ fence, the boundary steps back to the previous blank line until the fences close (or stable is empty), so stable never contains an unclosed code block. Pure function for unit tests. */
export function splitStableTail(text) {
	const s = text || "";
	if (!s) return { stable: "", tail: "" };
	const hasUnclosedFence = (part) => ((part.match(/```/g) || []).length % 2 === 1) || ((part.match(/~~~/g) || []).length % 2 === 1);
	let idx = s.lastIndexOf("\n\n");
	if (idx === -1) return { stable: "", tail: s };
	let stable = s.slice(0, idx);
	let tail = s.slice(idx + 2);
	while (stable && hasUnclosedFence(stable)) {
		const prev = stable.lastIndexOf("\n\n");
		if (prev === -1) return { stable: "", tail: s };
		stable = s.slice(0, prev);
		tail = s.slice(prev + 2);
	}
	return { stable, tail };
}

/** Stable part, rendered as Markdown. Props are only text, so Preact skips re-parsing while it is unchanged. */
const ThinkingStable = memo(function ThinkingStable({ text }) {
	return html`<${Markdown} text=${text} />`;
});

/** Tail part, plain text only (no marked parsing), so unclosed bold markers and lists never flicker. Whitespace is left to CSS. */
function ThinkingTail({ text }) {
	return html`<div class="thinking-tail">${text}</div>`;
}

function Thinking({ step }) {
	const [open, setOpen] = useState(false);
	const buffered = useRafBufferedText(step.text, step.live);
	const { title, body } = useMemo(() => splitThinking(buffered), [buffered]);
	const { stable, tail } = useMemo(() => splitStableTail(body), [body]);
	const has = !!(title || body);
	const label = step.live ? (title ? clip(title, 90) : t("Thinking…")) : has ? (title ? clip(title, 90) : t("Reasoning")) : t("Reasoning (not exposed by the model)");
	return html`<div class="thinking">
		<button class="group-head" onClick=${() => body && setOpen(!open)} disabled=${!body} aria-expanded=${open}>
			<span class="action-ico"><${Icon} name="brain" size=${14} class="c-dim" /></span>
			<span class=${`group-label truncate ${step.live ? "shimmer-text" : ""}`}>${label}</span>
			<span class="grow" />
			${body ? html`<${Fold} />` : null}
		</button>
		<${Collapse} open=${open && !!body}><div class="thinking-text">${step.live ? html`<div class="thinking-stream">${stable ? html`<${ThinkingStable} text=${stable} />` : null}${tail ? html`<${ThinkingTail} text=${tail} />` : null}</div>` : html`<${Markdown} text=${body} />`}</div><//>
	</div>`;
}

function CustomStep({ step }) {
	const item = step.item;
	const [open, setOpen] = useState(false);
	const label = item.customType.replace(/[-_]/g, " ");
	return html`<div class="thinking">
		<button class="group-head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
			<span class="action-ico"><${Icon} name="info" size=${14} class="c-dim" /></span>
			<span class="group-label truncate">${label}</span>
			<span class="grow" />
			<${Fold} />
		</button>
		<${Collapse} open=${open}><div class="thinking-text"><${Markdown} text=${item.text} /></div><//>
	</div>`;
}

/**
 * The steps behind an answer. A thin line joins a step to the next one when both have a glyph (a written note between
 * two steps breaks it), so the line is only ever drawn between steps that really exist and follows how tall they are.
 */
function StepList({ steps }) {
	const groups = useMemo(() => groupSteps(steps.filter((step) => step.type !== "note")), [steps]);
	return html`<div class="steps">
		${groups.map((entry, index) => {
			const next = groups[index + 1];
			const linked = entry.type !== "note" && !!next && next.type !== "note";
			const body =
				entry.type === "note"
					? html`<div class="note"><${Markdown} text=${entry.text} /></div>`
					: entry.type === "thinking"
						? html`<${Thinking} step=${entry} />`
						: entry.type === "custom"
							? html`<${CustomStep} step=${entry} />`
							: html`<${Group} group=${entry} />`;
			return html`<div class=${`step ${linked ? "linked" : ""}`} key=${entry.key}>${body}</div>`;
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

/**
 * One foldable block of reasoning and tool calls. A turn has one block per stretch of work between the texts the model
 * wrote (see turnSegments); the last block carries the turn's state: working (glyph, current action, timer) or how it
 * ended. An earlier block says what it did. A block opens while output goes into it and folds when it is done, unless
 * the user opened or folded it, which then stays.
 */
function ProcessSummary({ turn, steps = turn.steps, stats = turn.stats, last = true, outcome, live: running, compacting, run, changeCount, duration, snapRun, defaultOpen }) {
	const [open, setOpen] = useState(defaultOpen);
	const interacted = useRef(false);
	useEffect(() => { if (!interacted.current) setOpen(defaultOpen); }, [defaultOpen]);
	// While the context is compacted the strip above the input shows it, with its own timer and Cancel: this row stays
	// still (no working glyph, activity or timer) and is not drawn at all when the turn has no steps yet.
	const summary = processSummaryState({ last, running, compacting, outcome, duration, stats, changeCount });
	const live = summary.live;
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!live) return undefined;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [live]);
	if (!steps.length && !live) return null;
	const elapsed = live ? now - (snapRun?.turnStartedAt || snapRun?.startedAt || turn.startedAt || now) : duration;
	const icon = live ? html`<${Spinner} />` : html`<${Icon} name=${summary.icon} size=${14} class=${`c-${summary.outcome}`} />`;
	const label = live ? currentActivity(turn, snapRun) : summary.label;
	const head = html`<span class="summary-ico">${icon}</span>
		<span class=${`summary-text truncate ${live ? "shimmer-text" : ""}`}>${label}</span>
		${live ? html`<span class="summary-meta dim">${fmtDuration(elapsed)}${stats.actions ? ` · ${plural(stats.actions, "action")}` : ""}</span>` : null}
		${stats.failedActions && !live ? html`<span class="badge danger">${plural(stats.failedActions, "failed action")}</span>` : null}`;
	// Waiting for the model's first step: there is nothing to unfold yet, so the row is only the working glyph, what is
	// happening and the timer (no arrow, and no empty area under it).
	if (!steps.length) return html`<div class=${`summary live o-${outcome}`}><div class="summary-head" role="status">${head}</div></div>`;
	return html`<div class=${`summary ${live ? "live" : ""} o-${summary.outcome}`}>
		<button class="summary-head" onClick=${() => { interacted.current = true; setOpen(!open); }} aria-expanded=${open} title=${open ? t("Hide steps") : t("Show what the agent did")}>
			${head}
			<span class="grow" />
			<${Fold} />
		</button>
		<${Collapse} open=${open} keepMounted=${true}><div class="summary-body"><${StepList} steps=${steps} /></div><//>
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
	// A network failure after output started: what was shown stays, nothing is resent on its own, "Retry" continues it.
	const interrupted = run?.terminalReason === "output-interrupted";
	const blurb = interrupted ? t("The connection dropped while the answer was being written. What was shown is kept; nothing is resent automatically.") : blurbs[outcome] ? t(blurbs[outcome]) : "";
	return html`<div class=${`banner o-${outcome}`} role="status">
		<div class="banner-head"><${Icon} name=${OUTCOME_ICON[outcome]} size=${15} /><strong>${interrupted ? t("Interrupted") : titles[outcome] ? t(titles[outcome]) : outcome}</strong></div>
		${interrupted ? html`<div class="banner-error">${blurb}${error ? html`<br />${clip(serverText(error, ""), 300)}` : null}</div>` : error ? html`<div class="banner-error">${clip(serverText(error, t("The task did not finish.")), 800)}</div>` : blurb ? html`<div class="banner-error">${blurb}</div>` : null}
		<div class="banner-facts dim">${facts.join(" · ")}${run?.reliability === "indeterminate" ? ` · ${t("change detection may be incomplete")}` : ""}</div>
		${!exportReadOnly() ? html`<div class="banner-actions">
			${turn.user && outcome !== "cancelled" ? html`<button class="btn sm" onClick=${() => actions.retry()}>${t("Retry")}</button>` : null}
			${run?.uncommitted ? html`<button class="btn sm" onClick=${() => openCommand("git")}>${t("Undo or commit")}</button>` : null}
		</div>` : null}
	</div>`;
}

// ---- Messages ----------------------------------------------------------------------------------
function UserMessage({ item, turn }) {
	return html`<div class="user-row">
		<div class="user-bubble" title=${new Date(item.ts).toLocaleString(getLang())}>
			${item.command ? html`<div class="chip-line"><span class="badge accent">/${item.command.name}</span></div>` : null}
			${item.skill ? html`<div class="chip-line"><span class="badge accent">${t("skill: {name}", { name: item.skill.name })}</span></div>` : null}
			${item.images?.length ? html`<div class="user-images">${item.images.map((img, i) => {
				const src = `data:${img.mimeType};base64,${img.data}`;
				const name = t("attached image");
				const zoomable = src.startsWith("data:") || src.startsWith("blob:"); // the page CSP only allows these two
				return html`<img key=${i} src=${src} alt=${name} role=${zoomable ? "button" : undefined} tabindex=${zoomable ? 0 : undefined} aria-label=${zoomable ? t("Preview image {name}", { name }) : undefined} onClick=${zoomable ? () => openImageLightbox(src, name) : undefined} onKeyDown=${zoomable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openImageLightbox(src, name); } } : undefined} />`;
			})}</div>` : null}
			${item.text ? html`<${Markdown} text=${item.text} class="user-text" breaks=${true} />` : null}
		</div>
		<div class="msg-actions">
			<${CopyButton} text=${item.text} label=${t("Copy message")} />
			${item.id ? html`<button class="icon-btn sm" title=${t("Edit and resend from here (forks the session)")} aria-label=${t("Edit and resend")} onClick=${() => actions.editAndResend(item)}><${Icon} name="edit" size=${14} /></button>` : null}
		</div>
	</div>`;
}

/** Tokens of one reply: always with a unit and one decimal (0.2K, 12.7K, 1.3M). */
const fmtCount = (n) => (n < 1000 ? `${(n / 1000).toFixed(1)}K` : fmtTokens(n));

function FinalMessage({ final }) {
	const message = final.message;
	const usage = message.usage;
	return html`<div class=${`final ${final.streaming ? "streaming" : ""}`}>
		<${Markdown} text=${final.text} />
		${final.partial ? html`<div class="dim partial-note">${t("The response was cut off.")}</div>` : null}
		${!final.streaming ? html`<div class="msg-actions final-actions">
			<${CopyButton} text=${final.text} label=${t("Copy answer")} />
			<span class="dim msg-meta truncate">${message.model}${usage ? ` · ${[usage.input + usage.cacheRead > 0 ? t("{n} tokens in", { n: fmtCount(usage.input + usage.cacheRead) }) : "", usage.output ? t("{n} tokens out", { n: fmtCount(usage.output) }) : ""].filter(Boolean).join(" / ")}` : ""}</span>
		</div>` : null}
	</div>`;
}

/** Added / removed lines of one file, or nothing when the diff could not be counted (binary, too large, no baseline). */
const lineCounts = (file) => (file.binary || file.unavailable ? null : html`<${Counts} additions=${file.additions} deletions=${file.deletions} />`);

/** A Markdown file's diff as formatted text: each run of unchanged, removed and added lines is rendered as Markdown. */
function MarkdownDiff({ patch }) {
	const blocks = useMemo(() => {
		const out = [];
		for (const hunk of parsePatch(patch)) {
			for (const line of hunk.lines) {
				if (line.type === "meta") continue;
				const last = out[out.length - 1];
				if (last && last.type === line.type && last.hunk === hunk) last.lines.push(line.text);
				else out.push({ type: line.type, hunk, lines: [line.text] });
			}
		}
		return out;
	}, [patch]);
	if (!blocks.length) return html`<div class="diff-empty dim">${t("No textual changes.")}</div>`;
	return html`<div class="md-diff">${blocks.map((block, i) => html`<div class=${`md-diff-block ${block.type}`} key=${i}>
		<span class="md-diff-sign" aria-hidden="true">${block.type === "add" ? "+" : block.type === "del" ? "−" : ""}</span>
		<${Markdown} text=${block.lines.join("\n")} />
	</div>`)}</div>`;
}

/** The diff of one file of a change card, loaded the first time the file is opened. */
function ChangeDiff({ card, file }) {
	const [entry, setEntry] = useState(null);
	const markdown = MARKDOWN_PATH.test(file.path);
	useEffect(() => {
		let cancelled = false;
		api(`/api/changes/card-diff?id=${encodeURIComponent(card.id)}&runId=${card.runId}&path=${encodeURIComponent(file.path)}`)
			.then((data) => !cancelled && setEntry({ data }))
			.catch((e) => !cancelled && setEntry({ error: e.message }));
		return () => {
			cancelled = true;
		};
	}, [card.id, file.path]);
	const data = entry?.data;
	if (entry?.error) return html`<div class="change-note c-danger">${entry.error}</div>`;
	if (!data) return html`<div class="change-note"><${Spinner} /></div>`;
	if (data.summary.binary) return html`<div class="change-note dim">${t("Binary file — no text diff.")}</div>`;
	if (data.summary.unavailable) return html`<div class="change-note dim">${serverText(data.summary.unavailable)}</div>`;
	if (!data.patch) return html`<div class="change-note dim">${t("No content changes.")}</div>`;
	return html`<div class="change-diff">
		${markdown ? html`<${MarkdownDiff} patch=${data.patch} />` : html`<${DiffView} patch=${data.patch} language=${languageFor(file.path)} />`}
	</div>`;
}

/** One file of a change card: a row that opens the file's diff in place. The diff is only mounted once it was opened. */
function ChangeFile({ card, file }) {
	const [open, setOpen] = useState(false);
	const [opened, setOpened] = useState(false);
	const dir = dirname(file.path);
	const toggle = () => (setOpened(true), setOpen(!open));
	return html`<div class="change-item">
		<button class="change-file" aria-expanded=${open} title=${file.path} onClick=${toggle}>
			<${Icon} name="chevronRight" size=${13} class="disclose" />
			<span class="change-path truncate">${dir ? html`<span class="dim">${dir}/</span>` : null}${basename(file.path)}${file.oldPath ? html` <span class="dim">← ${file.oldPath}</span>` : null}</span>
			${lineCounts(file)}
		</button>
		<${Collapse} open=${open}>${opened ? html`<${ChangeDiff} card=${card} file=${file} />` : null}<//>
	</div>`;
}

/**
 * What a finished task changed, at the end of its turn: the files it really changed with their added and removed
 * lines. The card is an entry of the session (kind "runChanges"), written when the task ended, so it stays in the
 * conversation when later tasks follow, and each card holds only its own task's changes. A file opens in place to
 * its line diff (added lines green, removed lines red); a Markdown file can also be read as formatted text. The card
 * never opens the Changes panel. A task from before cards were saved has none.
 */
function ChangeCard({ card }) {
	const files = card.files;
	if (!files?.length) return null;
	const counted = files.every((file) => !file.binary && !file.unavailable);
	return html`<div class="change-card fade-in">
		<div class="change-head">
			<span class="grow truncate">${t("Edited {files}", { files: plural(files.length, "file") })}</span>
			${counted ? html`<${Counts} additions=${files.reduce((n, f) => n + f.additions, 0)} deletions=${files.reduce((n, f) => n + f.deletions, 0)} />` : null}
		</div>
		${files.map((file) => html`<${ChangeFile} key=${file.path} card=${card} file=${file} />`)}
	</div>`;
}

const TurnView = memo(function TurnView({ turn, isLast, live, waiting, run, cwd, processDefault, snapRun, compacting }) {
	const outcome = turnOutcome(turn, { run, live, waiting });
	const changeCount = run ? run.changeCount : turn.stats.files;
	const duration = turnDuration(turn, run);
	// Reasoning and tool calls fold into blocks between the texts the model wrote, in the order they happened.
	const segments = useMemo(() => turnSegments(turn), [turn]);
	const working = live || waiting;
	const tail = segments[segments.length - 1];
	// Nothing is being written into a block (no block yet, or the model last wrote text): the working state is a row of
	// its own at the end, the way the turn starts.
	const pending = working && !turn.final && (!tail || tail.type === "text");
	const lastBlock = pending ? undefined : segments.filter((segment) => segment.type === "process").pop();
	const expanded = processDefault === "expanded";
	return html`<section class=${`turn ${live ? "live" : ""}`}>
		${turn.user ? html`<${UserMessage} item=${turn.user} turn=${turn} />` : null}
		${segments.map((segment) =>
			segment.type === "text"
				? html`<div class="final" key=${segment.key}><${Markdown} text=${segment.step.text} /></div>`
				: html`<${ProcessSummary} key=${`sum-${turn.key}-${segment.key}`} turn=${turn} steps=${segment.steps} stats=${segment === lastBlock ? turn.stats : segment.stats} last=${segment === lastBlock} outcome=${outcome} live=${working} compacting=${compacting} run=${run} changeCount=${segment === lastBlock ? changeCount : segment.stats.files} duration=${duration} snapRun=${snapRun} defaultOpen=${expanded || (working && segment === tail && !turn.final)} />`,
		)}
		${pending ? html`<${ProcessSummary} key=${`sum-${turn.key}-pending`} turn=${turn} steps=${[]} outcome=${outcome} live=${working} compacting=${compacting} snapRun=${snapRun} defaultOpen=${false} />` : null}
		${turn.final ? html`<${FinalMessage} final=${turn.final} />` : null}
		${turn.changes ? html`<${ChangeCard} card=${turn.changes} />` : null}
		<${OutcomeBanner} turn=${turn} outcome=${outcome} run=${run} changeCount=${changeCount} />
	</section>`;
});

/** A command the user ran with "!": the same row as a command the agent runs (glyph, what it did, the command), then its output. */
function BashCard({ item }) {
	const [open, setOpen] = useState(false);
	const glide = useHeightGlide();
	const status = item.status || (item.cancelled ? "cancelled" : item.timedOut ? "timeout" : item.exitCode ? "failed" : item.exitCode === undefined && item.status === "running" ? "running" : "done");
	const output = item.output || "";
	const lines = output.split("\n");
	const preview = lines.slice(-8).join("\n");
	const label = { running: t("Running"), done: t("Ran"), failed: t("Exited {code}", { code: item.exitCode }), cancelled: t("Cancelled"), timeout: t("Timed out"), error: t("Failed to start") }[status] || t("Ran");
	const failed = status === "failed" || status === "timeout" || status === "error";
	const step = { status: status === "running" ? "running" : status === "cancelled" ? "cancelled" : "done", isError: failed, kind: "run" };
	return html`<div class=${`action bash-entry s-${status} ${failed ? "err" : ""}`} ref=${glide.ref}>
		<div class="action-row static">
			<span class="action-ico"><${StatusGlyph} step=${step} /></span>
			<span class="action-text truncate"><span class=${status === "running" ? "shimmer-text" : "verb"}>${label}</span> <span class="mono target">${item.command}</span></span>
			${item.excludeFromContext ? html`<span class="action-tail"><span class="badge">${t("not in context")}</span></span>` : null}
		</div>
		${output ? html`<pre class="bash-out"><${Ansi} text=${open ? output : preview} /></pre>${lines.length > 8 ? html`<button class="btn sm ghost" onClick=${() => glide.run(() => setOpen(!open))}>${open ? t("Show less") : t("Show all {length} lines", { length: lines.length })}</button>` : null}` : null}
		${item.truncated && item.fullOutputPath ? html`<div class="dim bash-note">${t("Output truncated. Full output saved at {fullOutputPath}", { fullOutputPath: item.fullOutputPath })}</div>` : null}
	</div>`;
}

function Standalone({ item, task, snap, runs, processDefault }) {
	const [open, setOpen] = useState(false);
	if (item.kind === "gitStatus" || item.kind === "gitRepair") {
		const repairTurns = item.repairTurns || item.turns;
		const liveTask = item.kind === "gitRepair" ? task : undefined;
		const latest = repairTurns?.[repairTurns.length - 1];
		return html`<${GitRecord} result=${item.result} task=${liveTask} activity=${liveTask && latest?.steps ? currentActivity(latest, snap?.run) : undefined}>${repairTurns?.length ? html`${repairTurns.map((turn) => turn.standalone
			? html`<${Standalone} key=${turn.key} item=${turn.standalone} />`
			: html`<${TurnView} key=${turn.key} turn=${turn} live=${!!snap?.active && item.kind === "gitRepair"} waiting=${false} run=${runForTurn(turn, runs || {})} processDefault=${processDefault} snapRun=${snap?.run} />`)}` : null}<//>`;
	}
	if (item.kind === "runChanges") return html`<${ChangeCard} card=${item} />`;
	if (item.kind === "bash") return html`<${BashCard} item=${item} />`;
	if (item.kind === "compaction" || item.kind === "branchSummary") {
		const title = item.kind === "compaction" ? (item.tokensBefore ? t("Context compacted (was ~{tokens} tokens)", { tokens: fmtTokens(item.tokensBefore) }) : t("Context compacted")) : t("Returned from another branch");
		return html`<div class="marker"><button class="marker-head" onClick=${() => setOpen(!open)} aria-expanded=${open}><span class="marker-line" /><span class="marker-text"><${Icon} name=${item.kind === "compaction" ? "layers" : "gitBranch"} size=${13} /> ${title}<${Fold} /></span><span class="marker-line" /></button>
			<${Collapse} open=${open}><div class="marker-body">${item.summary?.trim() ? html`<${Markdown} text=${item.summary} />` : html`<div class="dim">${t("This compaction saved no readable summary.")}</div>`}</div><//></div>`;
	}
	if (item.kind === "reload") return html`<div class="marker"><span class="marker-text">${item.ok ? t("Configuration reloaded") : t("Reload failed: {error}", { error: item.error })}</span></div>`;
	if (item.kind === "custom") {
		return html`<div class="custom-card"><div class="dim custom-type">${item.customType.replace(/[-_]/g, " ")}</div><${Markdown} text=${item.text} /></div>`;
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
// Turn mounting arrives in chunks: the first frame paints only the newest turns, then one batch per
// animation frame is appended above until the whole window is mounted. The reader sees content sooner
// and no single frame carries the full mount.
const CHUNK_FIRST = 20;
const CHUNK_NEXT = 20;
export function Transcript() {
	const items = useStore((s) => s.items);
	const gitTask = useStore((s) => s.gitTask);
	const toolRuns = useStore((s) => s.toolRuns);
	const runs = useStore((s) => s.runs);
	const snap = useStore((s) => s.snap);
	const dialogs = useStore((s) => s.dialogs);
	const compaction = useStore((s) => s.compaction);
	const userBash = useStore((s) => s.userBash);
	const order = useStore((s) => s.userBashOrder);
	const processDefault = useStore((s) => s.view.processDefault);
	const models = useStore((s) => s.models);
	const cwd = snap?.cwd || "";
	const active = !!snap?.active || !!snap?.flags?.completion;
	const prevTurns = useRef(null);
	const turnsSlot = activeSlotId();
	const [asyncTurns, setAsyncTurns] = useState(null);
	const turns = useMemo(() => {
		// Cross-session cache: when this bag's last build still describes exactly these references, reuse the very
		// same turn objects (skipping buildTurns and the sameTurn pass). Mount chunking stays as it is: reusing the
		// objects does not spare the DOM insert, and a full-window first commit measured 3x slower to first paint.
		const cached = cachedTurns(getTurnsCache(turnsSlot), items, toolRuns, cwd);
		if (cached) {
			prevTurns.current = cached;
			return cached;
		}
		if (items.length > 400) {
			return asyncTurns?.slot === turnsSlot ? asyncTurns.turns : [];
		}
		const built = buildTurns(items, { cwd, toolRuns }, prevTurns.current);
		setTurnsCache({ items, toolRuns, cwd, turns: built }, turnsSlot);
		prevTurns.current = built;
		return built;
	}, [items, toolRuns, cwd, turnsSlot, asyncTurns]);
	useEffect(() => {
		if (items.length <= 400 || cachedTurns(getTurnsCache(turnsSlot), items, toolRuns, cwd)) return undefined;
		let cancelled = false;
		void buildTurnsAsync(items, { cwd, toolRuns }, prevTurns.current, () => cancelled).then((built) => {
			if (cancelled || !built) return;
			setTurnsCache({ items, toolRuns, cwd, turns: built }, turnsSlot);
			prevTurns.current = built;
			setAsyncTurns({ slot: turnsSlot, turns: built });
		});
		return () => { cancelled = true; };
	}, [items, toolRuns, cwd, turnsSlot]);

	// Scroll behaviour: follow new output only while the reader is at the bottom.
	const scroller = useRef(null);
	const content = useRef(null);
	const stick = useRef(true);
	const lastInteract = useRef(0);
	const [away, setAway] = useState(false);
	// The jump button fades out when it is no longer needed (it keeps its place while it does).
	const jump = usePresence(away, 160);
	const lastTop = useRef(0);
	const programmatic = useRef(false);
	const holdPlace = useRef(false);
	// At most one real scroll per frame: toBottom only schedules, the frame callback does one read plus one write.
	const bottomFrame = useRef(0);
	// The ResizeObserver reports the mounted content height; while pinned we scroll to that cached number instead
	// of re-reading scrollHeight. The scroller keeps its own padding, so the cached height is never below the real
	// maximum scroll position and the assignment clamps exactly onto the bottom (sub-pixel rounding aside).
	const contentHeight = useRef(0);
	const roActive = useRef(false);
	// Scroll events arrive faster than frames and re-measuring per event reads the same layout repeatedly.
	// One coalesced measurement per animation frame reads each geometry property once, and the header class is
	// written only when the boolean actually flips (toggling it every event invalidates styles for nothing).
	const measureFrame = useRef(0);
	const headerRef = useRef(null);
	const headerScrolled = useRef(false);
	const measureScroll = () => {
		measureFrame.current = 0;
		const el = scroller.current;
		if (!el) return;
		const top = el.scrollTop;
		const distance = Math.max(0, el.scrollHeight - el.clientHeight - top);
		const near = distance <= 10;
		// Size changes and scroll anchoring are not reader intent.
		if (!programmatic.current && Date.now() - lastInteract.current < 500 && top < lastTop.current - 2 && distance > 72) stick.current = false;
		if (near && !holdPlace.current) { stick.current = true; programmatic.current = false; }
		lastTop.current = top;
		const show = !stick.current && distance > 72;
		setAway((prev) => (prev === show ? prev : show));
		if (!headerRef.current || !headerRef.current.isConnected) headerRef.current = document.querySelector(".main-header");
		const scrolled = top > 4;
		if (scrolled !== headerScrolled.current) {
			headerScrolled.current = scrolled;
			headerRef.current?.classList.toggle("scrolled", scrolled);
		}
	};
	const scheduleMeasure = () => {
		if (!measureFrame.current) measureFrame.current = requestAnimationFrame(measureScroll);
	};
	const onScroll = () => scheduleMeasure();
	const noteInteraction = (event) => {
		if (event.type === "wheel" || event.type === "keydown" || event.target === scroller.current) holdPlace.current = false;
		const scrollInput = event.type === "wheel" ? event.deltaY < 0
			: event.type === "keydown" ? ["ArrowUp", "PageUp", "Home"].includes(event.key)
			: event.target === scroller.current;
		if (scrollInput) {
			lastInteract.current = Date.now();
			programmatic.current = false;
		}
	};
	// Opening a file's diff makes the page taller below the row that was clicked. Following the bottom would scroll that
	// row up (and the first pixels of the growth would count as "still at the bottom"), so while a diff is open the page
	// holds its place: the row stays where it is and the diff grows downwards. Scrolling by hand, or closing the diff, ends it.
	const holdOnOpen = (event) => {
		const row = event.target.closest?.(".change-file");
		if (!row) return;
		holdPlace.current = row.getAttribute("aria-expanded") !== "true";
		if (holdPlace.current) stick.current = false;
	};
	const flushBottom = () => {
		bottomFrame.current = 0;
		const el = scroller.current;
		if (!el || !stick.current) { programmatic.current = false; return; }
		el.scrollTop = el.scrollHeight;
		lastTop.current = el.scrollTop;
		programmatic.current = false;
	};
	const toBottom = (smooth = false) => {
		const el = scroller.current;
		if (!el) return;
		programmatic.current = true;
		setAway(false);
		if (smooth) { cancelAnimationFrame(bottomFrame.current); bottomFrame.current = 0; return el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }
		if (!bottomFrame.current) bottomFrame.current = requestAnimationFrame(flushBottom);
	};
	// ResizeObserver fires after layout but before paint: scrolling to the cached height here follows new
	// output in the same frame it grows, with one write and no scrollHeight read. The height is at or above the
	// real maximum scroll position (see contentHeight), so the browser clamps the write exactly onto the bottom.
	const followToBottom = () => {
		const el = scroller.current;
		if (!el) return;
		if (!contentHeight.current) { toBottom(); return; }
		el.scrollTop = contentHeight.current;
		lastTop.current = el.scrollTop;
	};
	useLayoutEffect(() => {
		// Without a ResizeObserver (or before its first callback) the item signal still has to drive the follow.
		if (!roActive.current && stick.current && Date.now() - lastInteract.current > 500) toBottom();
	}, [items, order, userBash, toolRuns]);
	useEffect(() => {
		if (!content.current || typeof ResizeObserver === "undefined") return undefined;
		roActive.current = true;
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target !== content.current) continue;
				const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
				const height = box && typeof box.blockSize === "number" ? box.blockSize : entry.contentRect.height;
				if (height > 0) contentHeight.current = height;
			}
			if (stick.current) followToBottom();
			else scheduleMeasure();
		});
		ro.observe(content.current);
		ro.observe(scroller.current);
		return () => {
			roActive.current = false;
			ro.disconnect();
		};
	}, []);
	const session = snap?.session?.id;
	useLayoutEffect(() => {
		stick.current = true;
		// The cached height belongs to the previous session; the first follow after a switch reads once.
		contentHeight.current = 0;
		toBottom();
	}, [session]);
	useEffect(() => () => {
		cancelAnimationFrame(bottomFrame.current);
		bottomFrame.current = 0;
		cancelAnimationFrame(measureFrame.current);
		measureFrame.current = 0;
		cancelAnimationFrame(chunkFrame.current);
		chunkFrame.current = 0;
	}, []);

	const repairing = turns.some((turn) => turn.standalone?.kind === "gitRepair");
	const lastTurnIndex = (() => {
		for (let i = turns.length - 1; i >= 0; i--) if (!turns[i].standalone) return i;
		return -1;
	})();
	// Long sessions: render the most recent turns and let the reader load earlier ones on demand.
	const [limit, setLimit] = useState(60);
	const hidden = Math.max(0, turns.length - limit);
	// A paged transcript still has older items on the server once everything in memory is shown.
	const transcriptHasMore = useStore((s) => s.transcriptHasMore);
	const transcriptFetching = useStore((s) => s.transcriptFetching);
	const showEarlier = hidden > 0 || transcriptHasMore;
	const shown = hidden ? turns.slice(hidden) : turns;
	// How many of `shown` are mounted so far: mounting starts with the newest CHUNK_FIRST turns and grows
	// by CHUNK_NEXT per animation frame. When another session is shown (the new bag arrives with a new session
	// id in the same commit) chunking restarts from the first batch; while one session keeps streaming the
	// batch count only grows, so the transcript never collapses back. Derived during render on purpose: the
	// first commit after a switch already shows 20, never a stale full mount.
	const [batches, setBatches] = useState(1);
	const batchSession = useRef(session);
	const switched = batchSession.current !== session;
	if (switched) batchSession.current = session;
	const liveBatches = switched ? 1 : batches;
	const mounted = liveBatches <= 1 ? Math.min(shown.length, CHUNK_FIRST) : Math.min(shown.length, CHUNK_FIRST + (liveBatches - 1) * CHUNK_NEXT);
	const rendered = mounted >= shown.length ? shown : shown.slice(shown.length - mounted);
	const renderedStart = hidden + (shown.length - rendered.length);
	const chunkFrame = useRef(0);
	const chunkHeightBefore = useRef(0);
	const cancelChunks = () => {
		cancelAnimationFrame(chunkFrame.current);
		chunkFrame.current = 0;
	};
	useLayoutEffect(() => {
		// A switch renders batch 1 from derived state; sync the counter before paint so later frames keep counting up.
		if (switched && batches !== 1) setBatches(1);
	});
	useEffect(() => {
		if (rendered.length >= shown.length) return undefined;
		chunkFrame.current = requestAnimationFrame(() => {
			chunkFrame.current = 0;
			// Older turns mount above what is already on screen; the height taken before the commit lets the
			// layout effect below shift the scroll by exactly the growth, so the newest message does not move.
			chunkHeightBefore.current = scroller.current?.scrollHeight || 0;
			setBatches(liveBatches + 1);
		});
		return cancelChunks;
	}, [rendered.length, shown.length, liveBatches]);
	useLayoutEffect(() => {
		if (chunkHeightBefore.current && scroller.current) {
			scroller.current.scrollTop += scroller.current.scrollHeight - chunkHeightBefore.current;
			chunkHeightBefore.current = 0;
		}
	}, [rendered.length]);
	const heightBefore = useRef(0);
	// "Show earlier" first shows what is already in memory; once that runs out on a paged transcript it fetches
	// the next older page from the server and then shows a further window of it. The scroll anchor is taken before
	// the fetch (older turns mount above) and applied when the limit grows, so the reader keeps their place.
	const showEarlierNow = () => {
		cancelChunks();
		setBatches(Number.MAX_SAFE_INTEGER);
		heightBefore.current = scroller.current?.scrollHeight || 0;
		stick.current = false;
		setLimit((shown) => shown + 60);
	};
	const showEarlierClick = () => {
		if (hidden > 0 || !transcriptHasMore || transcriptFetching) {
			if (hidden > 0) showEarlierNow();
			return;
		}
		const slot = turnsSlot;
		heightBefore.current = scroller.current?.scrollHeight || 0;
		stick.current = false;
		fetchMoreTranscript(slot).then((result) => {
			if (result !== "ok") return;
			cancelChunks();
			setBatches(Number.MAX_SAFE_INTEGER);
			setLimit((shown) => shown + 60);
		});
	};
	useLayoutEffect(() => {
		if (heightBefore.current && scroller.current) {
			scroller.current.scrollTop += scroller.current.scrollHeight - heightBefore.current;
			heightBefore.current = 0;
		}
	}, [limit]);
	useEffect(() => setLimit(60), [session]);
	const waiting = dialogs.length > 0 && active;
	const compacting = !!compaction || !!snap?.flags?.compacting;
	const liveBash = order.map((id) => userBash[id]).filter((entry) => entry && entry.status === "running");
	const empty = turns.length === 0 && liveBash.length === 0;

	return html`<div class="transcript-wrap">
		<div class="transcript" ref=${scroller} onScroll=${onScroll} onWheel=${noteInteraction} onClickCapture=${holdOnOpen} onMouseDown=${noteInteraction} onKeyDown=${noteInteraction}>
			<div class="transcript-inner" ref=${content}>
				${empty ? html`<${Welcome} snap=${snap} models=${models} />` : null}
				${showEarlier ? html`<button class="btn sm ghost earlier" disabled=${!hidden && transcriptFetching} onClick=${showEarlierClick}>${hidden ? t("Show earlier messages ({hidden} hidden)", { hidden }) : transcriptFetching ? t("Loading…") : t("Show more")}</button>` : null}
				${rendered.map((turn, i) => {
					const index = renderedStart + i;
					if (turn.standalone) return html`<${Standalone} key=${turn.key} item=${turn.standalone} task=${gitTask} snap=${snap} runs=${runs} processDefault=${processDefault} />`;
					const isLast = index === lastTurnIndex;
					// A manual compaction runs after the last turn ended: that turn keeps its finished look.
					const live = isLast && active && !repairing && compaction?.reason !== "manual";
					const run = live ? undefined : runForTurn(turn, runs, isLast);
					return html`<${TurnView} key=${turn.key} turn=${turn} isLast=${isLast} live=${live} waiting=${live && waiting} run=${run} cwd=${cwd} processDefault=${processDefault} snapRun=${live ? snap?.run : undefined} compacting=${live && compacting} />`;
				})}
				${liveBash.map((entry) => html`<${BashCard} key=${entry.id} item=${entry} />`)}
				${gitTask && !repairing ? html`<${GitRecord} task=${gitTask} />` : null}
				<div class="transcript-end" />
			</div>
		</div>
		${jump.mounted ? html`<button class=${`jump-btn ${away ? "" : "leaving"}`} onClick=${() => { stick.current = true; toBottom(true); }} title=${active ? t("Follow live output") : t("Jump to latest")} aria-label=${active ? t("Follow live output") : t("Jump to latest")}><${Icon} name="arrowDown" size=${16} /></button>` : null}
	</div>`;
}
