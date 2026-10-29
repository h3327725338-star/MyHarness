// Transcript: quiet reading surface. Each turn = user message, a collapsed run summary, the final answer,
// and (only when relevant) an outcome banner. Details open in layers: summary -> steps -> raw tool data.
import { html, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, Collapse, Counts, Fold, Icon, Spinner, CopyButton, usePresence, useHeightGlide, useSwapGlide } from "./ui.js";
import { createReadCache } from "./scheduling.js";
import { retrySwitch, activeSlotId, api, fetchMoreTranscript, toast, getTurnsCache, notePaintedTurns, setTurnsCache, setView, settleLanding, slotUrl, useStore } from "./store.js";
import { shortcutFor } from "./shortcuts.js";
import { GitRecord } from "./git-record.js";
import { Markdown } from "./markdown.js";
import { DiffView, languageFor, parsePatch } from "./diff.js";
import { buildTurns, buildTurnsAsync, buildTurnsWork, cachedTurns, tailPreviewSlice, changeTotals, groupSteps, groupLabel, runForTurn, interruptedByNext, turnDuration, turnOutcome, turnSegments, historySourcesOf } from "./turns.js";
import { actions, openCommand } from "./actions.js";
import { KIND_ICON, StatusGlyph, WebSteps } from "./tool-rows.js";
import { StepCounts } from "./step-counts.js";
import { basename, clip, splitFirstSentence, dirname, fmtBytes, fmtDuration, fmtShortDuration, fmtTokens, plural, formatData, ansiSegments } from "./util.js";
import { count, t, N_, serverText, tNodes, getLang } from "./i18n.js";
import { openImageLightbox } from "./lightbox.js";
import { MessageRail } from "./message-rail.js";
import { jumpToQuote, keepScrollPlace, offsetInScroller, registerScroller, REVEAL_ENTRY_EVENT, revealEntryIn, scrollToNode, turnKeyForEntry } from "./message-nav.js";
import { exportReadOnly } from "./export-mode.js";
import { afterModeReveal, beforePageCapture, modeRevealActive } from "./mode-transition.js";

import { OUTCOME_ICON, processSummaryState } from "./process-summary.js";
import { AttachmentList, splitAttachments } from "./attachments.js";
import { SubAgentProcess, dispatchFor, runningSince, runningTasks, useSubAgents } from "./sub-agents.js";

/**
 * Where a transcript image is drawn from: large ones come by address from the server (`src`, same origin, which the
 * page CSP allows like data: and blob:), small ones inline. The address names this chat in its query.
 */
const imageSrc = (img) => (img.src ? slotUrl(img.src) : `data:${img.mimeType};base64,${img.data}`);

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
// the long-task budget. Each block is also its own block box (`.raw-chunk`): as plain text nodes they
// shared one run of lines, so every append still laid out all the text shown so far (50 ms growing to
// 165 ms per frame on a 1 MB output, 2026-10-27). A block ends at a line end, so no line is split.
const SHOW_ALL_CHUNK = 100 * 1024;

/**
 * Where the block that starts at `start` ends: SHOW_ALL_CHUNK characters on, pulled back to the end of the last line in
 * it. Only a line longer than a block is cut, and never between the two halves of a surrogate pair.
 */
function chunkEnd(text, start) {
	const end = Math.min(start + SHOW_ALL_CHUNK, text.length);
	if (end === text.length) return end;
	const newline = text.lastIndexOf("\n", end - 1);
	if (newline >= start) return newline + 1;
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** The first `pos` characters of `text` as stable blocks (see chunkEnd) — one `Ansi` block per chunk. */
function ChunkedAnsi({ text, pos }) {
	const blocks = [];
	for (let start = 0, end; start < pos; start = end) {
		end = Math.min(chunkEnd(text, start), pos);
		blocks.push(html`<span class="raw-chunk" key=${start}><${Ansi} text=${text.slice(start, end)} /></span>`);
	}
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
		posRef.current = chunkEnd(textRef.current, posRef.current);
		setPos(posRef.current);
		if (posRef.current < full) scheduleNext();
	};
	const expand = () => {
		clearPending();
		const full = textRef.current.length;
		posRef.current = chunkEnd(textRef.current, 0);
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

// A tool output with more than this many characters (or lines) is a "big card": it opens as plain chunked
// text and a markdown file offers one explicit render pass instead of parsing up front (that parse is itself
// the long task). Thresholds only; the Output/MarkdownOutput limits above are unchanged.
const BIG_CARD_CHARS = 50 * 1024;
const BIG_CARD_LINES = 500;

/** Whether a tool output body is a big card (either limit is enough). Growing stream output qualifies the same way. */
function isBigCardOutput(text) {
	if (!text) return false;
	if (text.length > BIG_CARD_CHARS) return true;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 && ++lines > BIG_CARD_LINES) return true;
	}
	return false;
}

/**
 * A big markdown-file output: plain chunked text first, with one explicit "render as Markdown" pass.
 * Only finished reads mount this (running output stays plain `Output`); once rendered it stays rendered.
 * The swap glides with the shared height motion, like the other show-all buttons.
 */
function BigReadOutput({ text }) {
	const [rich, setRich] = useState(false);
	const glide = useHeightGlide();
	if (rich) return html`<${MarkdownOutput} text=${text} />`;
	// Above MARKDOWN_PLAIN_LIMIT the render pass stays plain by design; offering the button would just
	// look broken, so the plain output stands on its own.
	if (text.length > MARKDOWN_PLAIN_LIMIT) return html`<div ref=${glide.ref}><${Output} text=${text} /></div>`;
	return html`<div ref=${glide.ref}><${Output} text=${text} />
		<button class="btn sm ghost" onClick=${() => glide.run(() => setRich(true))}>${t("Render as Markdown")}</button></div>`;
}

function RawDetails({ step }) {
	const { call, result, run } = step;
	const details = result?.details;
	const [showDetails, setShowDetails] = useState(false);
	const output = result?.text ?? run?.partial ?? "";
	const exitCode = details?.exitCode;
	// The server replaces oversized details with { truncatedDetails, originalChars }; show a quiet note instead of the raw fields.
	const originalChars = typeof details?.originalChars === "number" && Number.isFinite(details.originalChars) ? details.originalChars : undefined;
	// Finished markdown-file reads parse as markdown; big ones stay plain text first with one explicit render
	// pass, and running output is always plain text, never parsed.
	const isMdRead = step.kind === "read" && result && !result.isError && MARKDOWN_PATH.test(step.path || "");
	const bigRead = isMdRead && isBigCardOutput(output);
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
				${bigRead ? html`<${BigReadOutput} text=${output} />` : isMdRead ? html`<${MarkdownOutput} text=${output} />` : html`<${Output} text=${output} tail=${step.kind === "run"} />`}
			</div>` : null}
			${result?.images?.length ? html`<div class="raw-images">${result.images.map((img, i) => {
				const src = imageSrc(img);
				const name = t("tool image");
				const zoomable = !!src;
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
	const cwd = useStore((st) => st.snap?.cwd || "");
	const toggle = () => setOpen(!open);
	return html`<div class="sub-task">
		<div class="action-row" onClick=${toggle} role="button" tabindex="0" aria-expanded=${open} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<span class="action-ico">${task.status === "running" ? html`<${Spinner} />` : html`<span class=${`dot ${TASK_DOT[task.status] ?? ""}`} />`}</span>
			<span class="action-text truncate" title=${task.description || clip(task.prompt || "", 300)}>${task.description || clip(task.prompt || "", 80)}</span>
			<span class="action-tail dim">${task.toolUseCount ? plural(task.toolUseCount, "tool call") : ""}${task.durationMs ? ` · ${fmtDuration(task.durationMs)}` : ""}<${Fold} /></span>
		</div>
		${task.status === "running" && task.lastToolInfo ? html`<div class="dim sub-last truncate">${task.lastToolInfo}</div>` : null}
		<${Collapse} open=${open}>
			<div class="sub-detail"><${SubAgentProcess} result=${task} running=${task.status === "running"} cwd=${cwd} /></div>
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
	const nothingRunning = useStore((st) => !st.snap?.active && !st.snap?.flags?.background);
	const subAgentState = useSubAgents();
	const resultDetails = step.result?.details;
	const batchId = resultDetails?.batchId || step.run?.partialDetails?.batchId;
	const dispatch = step.kind === "agent" ? dispatchFor(subAgentState, step.call?.id, batchId) : undefined;
	const rawDetails = step.kind === "agent" ? (batchId && subAgents[batchId]) || resultDetails || step.run?.partialDetails || dispatch?.details : undefined;
	// Sub-agents run as long as the session says so (its sub-agent state), not as long as the call that started them:
	// tasks still marked running without a live dispatch were stopped (the main task stopped, the server restarted).
	const stale = rawDetails && step.status !== "running" && dispatch?.status !== "running";
	const liveDetails = stale ? settleDetails(rawDetails) : rawDetails;
	const took = step.startedAt && step.endedAt && step.endedAt - step.startedAt >= 1000 ? fmtDuration(step.endedAt - step.startedAt) : "";
	const exit = step.result?.details?.exitCode;
	const toggle = () => setOpen(!open);
	return html`<div class=${`action ${step.isError ? "err" : ""} ${step.status}`} data-tool-call=${step.call?.id}>
		<div class="action-row" onClick=${toggle} role="button" tabindex="0" aria-expanded=${open} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<span class="action-ico"><${StatusGlyph} step=${step} /></span>
			<span class="action-text truncate" title=${[step.verb, step.target, step.detail].filter(Boolean).join(" ")}>
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

/** Stable part, rendered as Markdown. Props are only text, so Preact skips re-parsing while it is unchanged. The same
 *  component stays mounted when streaming ends (only its text grows to the whole body), so the blocks already on screen
 *  are never thrown away for a placeholder frame. */
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
	const text = step.live ? stable : body;
	const has = !!(title || body);
	const label = step.live ? (title ? clip(title, 90) : t("Thinking…")) : has ? (title ? clip(title, 90) : t("Reasoning")) : t("Reasoning (not exposed by the model)");
	return html`<div class="thinking">
		<button class="group-head" onClick=${() => body && setOpen(!open)} disabled=${!body} aria-expanded=${open}>
			<span class="action-ico"><${Icon} name="brain" size=${14} class="c-dim" /></span>
			<span class=${`group-label truncate ${step.live ? "shimmer-text" : ""}`}>${label}</span>
			<span class="grow" />
			${body ? html`<${Fold} />` : null}
		</button>
		<${Collapse} open=${open && !!body}><div class="thinking-text"><div class="thinking-stream">${text ? html`<${ThinkingStable} text=${text} />` : null}${step.live && tail ? html`<${ThinkingTail} text=${tail} />` : null}</div></div><//>
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
	// Texts the model wrote along the way are here only when a finished turn folds them in (turnSegments `fold`).
	const groups = useMemo(() => groupSteps(steps), [steps]);
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
// The server's run activity while a finished answer waits for its sub-agents (agent-session.ts, written in Chinese).
const WAITING_FOR_SUB_AGENTS = "\u7b49\u5f85\u5b50\u667a\u80fd\u4f53";
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
	const subAgentState = useSubAgents();
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
	// Waiting for sub-agents: say how many and for how long, not the turn's own action count.
	// That is the hold after the final answer, or a tool call that only waits for its own dispatch (nothing else runs).
	const runningSteps = turn.steps.filter((step) => step.type === "action" && (step.status === "running" || step.status === "pending"));
	const onlyDispatching = runningSteps.length > 0 && runningSteps.every((step) => step.kind === "agent");
	const waitingSubAgents = live && (snapRun?.activity === WAITING_FOR_SUB_AGENTS || (snapRun?.state === "waiting" && onlyDispatching)) ? runningTasks(subAgentState) : 0;
	const waitingSince = waitingSubAgents ? runningSince(subAgentState) : undefined;
	const elapsed = live ? now - (waitingSince || snapRun?.turnStartedAt || snapRun?.startedAt || turn.startedAt || now) : duration;
	const icon = live ? html`<${Spinner} />` : html`<${Icon} name=${summary.icon} size=${14} class=${`c-${summary.outcome}`} />`;
	const label = waitingSubAgents ? t("Waiting for {agents}", { agents: count(waitingSubAgents, "sub-agent") }) : live ? currentActivity(turn, snapRun) : summary.label;
	const meta = waitingSubAgents ? t("{duration} elapsed", { duration: fmtDuration(Math.max(0, elapsed)) }) : `${fmtDuration(elapsed)}${stats.actions ? ` · ${plural(stats.actions, "action")}` : ""}`;
	const head = html`<span class="summary-ico">${icon}</span>
		<span class=${`summary-text truncate ${live ? "shimmer-text" : ""}`}>${label}</span>
		${live ? html`<span class="summary-meta dim">${meta}</span>` : null}
		${stats.failedActions && !live ? html`<span class="badge danger">${plural(stats.failedActions, "failed action")}</span>` : null}`;
	// Waiting for the model's first step: there is nothing to unfold yet, so the row is only the working glyph, what is
	// happening and the timer (no arrow, and no empty area under it).
	if (!steps.length) return html`<div class=${`summary live o-${outcome}`}><div class="summary-head" role="status">${head}</div></div>`;
	return html`<div class=${`summary ${live ? "live" : ""} o-${summary.outcome}`}>
		<button class="summary-head" onClick=${() => { interacted.current = true; setOpen(!open); }} aria-expanded=${open} title=${`${label} · ${open ? t("Hide steps") : t("Show what the agent did")}`}>
			${head}
			<span class="grow" />
			<${Fold} />
		</button>
		<${Collapse} open=${open} keepMounted=${true}><div class="summary-body"><${StepList} steps=${steps} /></div><//>
	</div>`;
}

// ---- Outcome banner: never folded away ---------------------------------------------------------
/**
 * After an interrupted or failed turn: the sub-agents it dispatched did not stop with it. The last turn also counts the
 * ones earlier turns left running; an older turn counts only its own, so the notice stays after a new message.
 */
function BackgroundStillRunning({ turn, isLast }) {
	const state = useSubAgents();
	if (state.unknown) return null;
	let running = 0;
	for (const step of turn.steps) {
		if (step.type !== "action" || step.kind !== "agent") continue;
		const item = dispatchFor(state, step.call?.id, step.result?.details?.batchId || step.run?.partialDetails?.batchId);
		if (item) running += item.tasks.filter((task) => task.status === "running").length;
	}
	if (isLast) running = Math.max(running, runningTasks(state));
	if (!running) return null;
	return html`<button class="link-btn sa-still" onClick=${() => setView({ subAgentPanel: Date.now() })}>${t("{agents} still running in the background", { agents: count(running, "sub-agent") })}</button>`;
}

/** The text of a failed turn: one sentence by default, the rest behind "Details" (the toggle sits in the banner's head). */
function BannerText({ lead, rest, open }) {
	return html`<div class="banner-error">${lead}</div>${rest ? html`<${Collapse} open=${open}><div class="banner-error banner-detail">${rest}</div><//>` : null}`;
}

function OutcomeBanner({ turn, outcome, run, changeCount, isLast }) {
	const [detailOpen, setDetailOpen] = useState(false);
	if (outcome === "completed" || outcome === "running" || outcome === "redirected") return null;
	if (outcome === "waiting") {
		return html`<div class="banner o-waiting" role="status"><div class="banner-head"><${Icon} name="clock" size=${15} /><strong>${t("Waiting for you")}</strong><span class="dim">${t("The agent is paused until you answer the question above the input box.")}</span></div></div>`;
	}
	const error = run?.error || turn.error?.message;
	const commands = run?.bashRuns ?? turn.stats.commands;
	const facts = [];
	if (run) facts.push(changeCount ? t("{files} changed", { files: plural(changeCount, "file") }) : t("No files were changed"));
	else facts.push(changeCount ? t("{files} edited", { files: plural(changeCount, "file") }) : t("No file edits were recorded"));
	if (run?.externalCommitCount) facts.push(t("{files} committed outside this run (not counted)", { files: plural(run.externalCommitCount, "file") }));
	if (commands) facts.push(run ? t("{commands} ran (side effects outside the workspace cannot be ruled out)", { commands: plural(commands, "command") }) : t("{commands} ran and may have changed files — check the Changes panel", { commands: plural(commands, "command") }));
	if (turn.stats.failedActions) facts.push(t("{actions} failed", { actions: plural(turn.stats.failedActions, "action") }));
	const titles = { partial: N_("Partially completed"), failed: N_("Failed"), cancelled: N_("Cancelled"), waiting: N_("Waiting for you"), unanswered: N_("No response") };
	const blurbs = { cancelled: N_("You stopped this run before it finished."), unanswered: N_("The message was sent but the agent did not respond.") };
	// A network failure after output started: what was shown stays, nothing is resent on its own, "Retry" continues it.
	const interrupted = run?.terminalReason === "output-interrupted";
	const blurb = interrupted ? t("The connection dropped while the answer was being written. What was shown is kept; nothing is resent automatically.") : blurbs[outcome] ? t(blurbs[outcome]) : "";
	// One sentence says what happened; the advice and the raw error stay one click away ("Details"), never dropped.
	let [lead, rest] = [blurb, ""];
	if (interrupted) rest = error ? clip(serverText(error, ""), 300) : "";
	else if (error) [lead, rest] = splitFirstSentence(clip(serverText(error, t("The task did not finish.")), 800));
	return html`<div class=${`banner o-${outcome}`} role="status">
		<div class="banner-head"><${Icon} name=${OUTCOME_ICON[outcome]} size=${15} /><strong>${interrupted ? t("Interrupted") : titles[outcome] ? t(titles[outcome]) : outcome}</strong>${rest ? html`<span class="grow" /><button class="link-btn banner-more" aria-expanded=${detailOpen} onClick=${() => setDetailOpen(!detailOpen)}>${detailOpen ? t("Hide details") : t("Details")}</button>` : null}</div>
		${lead ? html`<${BannerText} lead=${lead} rest=${rest} open=${detailOpen} />` : null}
		<div class="banner-facts dim">${facts.join(" · ")}${run?.reliability === "indeterminate" ? ` · ${t("change detection may be incomplete")}` : ""}</div>
		${outcome === "cancelled" || outcome === "failed" || outcome === "partial" ? html`<${BackgroundStillRunning} turn=${turn} isLast=${isLast} />` : null}
		${!exportReadOnly() ? html`<div class="banner-actions">
			${turn.user && outcome !== "cancelled" ? html`<button class="btn sm" onClick=${() => actions.retry()}>${t("Retry")}</button>` : null}
			${run?.uncommitted ? html`<button class="btn sm" onClick=${() => openCommand("git")}>${t("Undo or commit")}</button>` : null}
		</div>` : null}
	</div>`;
}

// ---- Messages ----------------------------------------------------------------------------------
/** A message of the user's own longer than this many rendered lines folds to FOLDED_LINES with a fade. */
const FOLD_AFTER_LINES = 8;
const FOLDED_LINES = 6;
/** The line height of user messages (the same for all of them), read from the first one. */
let userLineHeight = 0;

/**
 * The text of one user message. Whether it folds is decided on the rendered Markdown's real height (re-measured
 * whenever it changes size), never on a character count; a folded message opens fully and folds again on demand.
 * Only user messages use this: replies are never folded.
 */
function UserText({ text }) {
	const box = useRef(null);
	const [fold, setFold] = useState({ foldable: false, line: 0, full: 0 });
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		const el = box.current;
		const inner = el?.firstElementChild;
		if (!el || !inner) return undefined;
		const measure = (full) => {
			if (!userLineHeight) userLineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 24;
			const line = userLineHeight;
			const foldable = full > line * FOLD_AFTER_LINES + 1;
			setFold((prev) => (prev.foldable === foldable && prev.line === line && prev.full === full ? prev : { foldable, line, full }));
		};
		if (typeof ResizeObserver === "undefined") {
			measure(inner.offsetHeight);
			return undefined;
		}
		// The height comes from the observer, which reports after layout and before paint (so a long message is folded
		// on its first frame). Reading it here at mount forced a style and layout pass for every message while a long chat
		// mounted, 11-36 ms each (2026-10-27).
		const observer = new ResizeObserver((entries) => {
			const size = entries[entries.length - 1]?.borderBoxSize?.[0];
			measure(size ? size.blockSize : inner.offsetHeight);
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, []);
	const folded = fold.foldable && !open;
	// Folding gave the message another height: whatever the reader has at the top stays there in this same frame
	// (keepScrollPlace). Not when it mounts: the transcript itself places what a mount moves.
	const height = fold.foldable ? (open ? fold.full : fold.line * FOLDED_LINES) : null;
	const sized = useRef(false);
	useLayoutEffect(() => {
		if (sized.current) keepScrollPlace();
		sized.current = true;
	}, [height]);
	// A quote in a sent message leads back to the passage it was taken from.
	const onQuote = (event) => {
		const quote = event.target.closest?.("blockquote");
		if (!quote || event.target.closest("a") || window.getSelection?.()?.toString()) return;
		void jumpToQuote(quote, text);
	};
	const onQuoteHover = (event) => {
		const quote = event.target.closest?.("blockquote");
		if (quote && !quote.title) quote.title = t("Jump to the quoted passage");
	};
	return html`<div class=${`user-fold ${fold.foldable ? "is-foldable" : ""} ${folded ? "folded" : ""}`} ref=${box} onClick=${onQuote} onMouseOver=${onQuoteHover} style=${fold.foldable ? { maxHeight: `${open ? fold.full : fold.line * FOLDED_LINES}px` } : undefined}>
		<${Markdown} text=${text} class="user-text" breaks=${true} />
	</div>
	${fold.foldable ? html`<button class="link-btn user-fold-toggle" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? t("Show less") : t("Show more")}</button>` : null}`;
}

function UserMessage({ item, turn }) {
	// Upload references (`Attached files` header + JSON path lines) render as cards, not bare paths.
	// The wire carries `attachments`; older items fall back to parsing the text. Either way the header
	// itself is never shown as message text, and a deleted file renders as deleted, never as an error.
	const parsed = useMemo(() => splitAttachments(item.text), [item.text]);
	const attachments = item.attachments?.length ? item.attachments : parsed.attachments;
	const body = attachments.length ? parsed.body : item.text;
	// What goes back into the input box on Rewind or Fork: the typed text (a command with its name), not the file list.
	const again = item.command ? `/${item.command.name}${body ? ` ${body}` : ""}` : body || "";
	return html`<div class="user-row">
		<div class="user-bubble" title=${new Date(item.ts).toLocaleString(getLang())}>
			${item.command ? html`<div class="chip-line"><span class="badge accent">/${item.command.name}</span></div>` : null}
			${item.skill ? html`<div class="chip-line"><span class="badge accent">${t("skill: {name}", { name: item.skill.name })}</span></div>` : null}
			${item.images?.length ? html`<div class="user-images">${item.images.map((img, i) => {
				const src = imageSrc(img);
				const name = t("attached image");
				const zoomable = !!src;
				return html`<img key=${i} src=${src} alt=${name} role=${zoomable ? "button" : undefined} tabindex=${zoomable ? 0 : undefined} aria-label=${zoomable ? t("Preview image {name}", { name }) : undefined} onClick=${zoomable ? () => openImageLightbox(src, name) : undefined} onKeyDown=${zoomable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openImageLightbox(src, name); } } : undefined} />`;
			})}</div>` : null}
			${attachments.length ? html`<${AttachmentList} attachments=${attachments} />` : null}
			${body ? html`<${UserText} text=${body} />` : null}
		</div>
		<div class="msg-actions">
			<${CopyAction} text=${body || item.text} />
			${item.id && !exportReadOnly()
				? html`<${MsgAction} icon="rewind" label=${t("Rewind to here")} note=${t("Removes this message and everything after it.")} onClick=${() => actions.rewindTo(item, again)} />
					<${MsgAction} icon="fork" label=${t("Fork from here")} note=${t("Starts a new chat from this point. This one stays as it is.")} onClick=${() => actions.forkFrom(item, again)} />`
				: null}
		</div>
	</div>`;
}

/** One action under a message: an icon, and on hover or keyboard focus a tip with its name and what it does. */
function MsgAction({ icon, label, note, onClick }) {
	return html`<span class="msg-act">
		<button type="button" class="icon-btn sm" aria-label=${label} aria-description=${note || undefined} onClick=${onClick}><${Icon} name=${icon} size=${14} /></button>
		<span class="msg-tip" aria-hidden="true"><strong>${label}</strong>${note ? html`<span>${note}</span>` : null}</span>
	</span>`;
}

function CopyAction({ text }) {
	const [done, setDone] = useState(false);
	const copy = async (event) => {
		event.stopPropagation();
		try {
			await navigator.clipboard.writeText(text);
			setDone(true);
			setTimeout(() => setDone(false), 1200);
		} catch {
			// Clipboard unavailable (insecure context / permissions): nothing else to do.
		}
	};
	return html`<${MsgAction} icon=${done ? "check" : "copy"} label=${done ? t("Copied") : t("Copy")} onClick=${copy} />`;
}

/** Tokens of one reply: always with a unit and one decimal (0.2K, 12.7K, 1.3M). */
const fmtCount = (n) => (n < 1000 ? `${(n / 1000).toFixed(1)}K` : fmtTokens(n));

/** Stable part of the final answer, rendered as Markdown. memo on text only, so Preact skips re-parsing while stable is unchanged. The same component stays mounted when streaming ends (its text grows to the whole answer), so finished blocks are never replaced by a placeholder. */
const FinalStable = memo(function FinalStable({ text }) {
	return html`<${Markdown} text=${text} />`;
});

const TAIL_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const TAIL_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** The streaming tail split once more around a code fence that opened in it: `code` is that fenced block (closed for
 *  display when its closing fence has not arrived yet), `before` and `after` the plain text around it. A tail without a
 *  fence is all `before`. Pure function for unit tests. */
export function splitTailCode(tail) {
	const lines = (tail || "").split("\n");
	const open = lines.findIndex((line) => TAIL_FENCE_OPEN.test(line));
	if (open === -1) return { before: tail || "", code: "", after: "" };
	const fence = TAIL_FENCE_OPEN.exec(lines[open])[1];
	let close = -1;
	for (let i = open + 1; i < lines.length && close === -1; i++) {
		const match = TAIL_FENCE_CLOSE.exec(lines[i]);
		if (match && match[1][0] === fence[0] && match[1].length >= fence.length) close = i;
	}
	return {
		before: lines.slice(0, open).join("\n"),
		code: close === -1 ? [...lines.slice(open), fence].join("\n") : lines.slice(open, close + 1).join("\n"),
		after: close === -1 ? "" : lines.slice(close + 1).join("\n"),
	};
}

/** Streaming tail of the final answer, plain text only (no markdown parsing), so unclosed markers never flicker. Inline
 *  wrap style only, no height/max-height transition. A code block that is still streaming is the exception: it shows as
 *  the code block it will be (its text is literal, so there is no marker to flicker) instead of as plain text until its
 *  closing fence arrives. */
function FinalTail({ text }) {
	const { before, code, after } = useMemo(() => splitTailCode(text), [text]);
	const plain = (part) => html`<div class="final-tail" style=${{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>${part}</div>`;
	return html`${before ? plain(before) : null}${code ? html`<${Markdown} text=${code} class="final-code" />` : null}${after ? plain(after) : null}`;
}

function FinalMessage({ final }) {
	const message = final.message;
	const usage = message.usage;
	// Streaming: buffer high-frequency full-text updates to at most one commit per frame (lossless: keeps newest full text), then split stable/tail at last blank line. Stable reuses memo Markdown, tail is plain text appended only. Ended: the same stable Markdown takes the whole answer (its already-parsed blocks are kept), so the last paragraph is calibrated at full fidelity without a placeholder frame.
	const buffered = useRafBufferedText(final.text, final.streaming);
	const { stable, tail } = useMemo(() => splitStableTail(buffered), [buffered]);
	const text = final.streaming ? stable : final.text;
	const counts = usage ? [usage.input + usage.cacheRead > 0 ? t("{n} tokens in", { n: fmtCount(usage.input + usage.cacheRead) }) : "", usage.output ? t("{n} tokens out", { n: fmtCount(usage.output) }) : ""].filter(Boolean) : [];
	return html`<div class=${`final ${final.streaming ? "streaming" : ""}`}>
		<div class="final-stream" style=${{ display: "flex", flexDirection: "column", minWidth: 0 }}>${text ? html`<${FinalStable} text=${text} />` : null}${final.streaming && tail ? html`<${FinalTail} text=${tail} />` : null}</div>
		${final.partial ? html`<div class="dim partial-note">${t("The response was cut off.")}</div>` : null}
		${!final.streaming ? html`<div class="msg-actions final-actions">
			<${CopyButton} text=${final.text} label=${t("Copy answer")} />
			<span class="dim msg-meta">${message.model}${counts.length ? " · " : ""}${counts.map((count, index) => html`${index ? " / " : ""}<span class="msg-meta-count">${count}</span>`)}</span>
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

const cardDiffReads = createReadCache(24);
const cardDiffKey = (slot, card, file) => JSON.stringify([slot, card.id, card.runId, file.path]);
const readCardDiff = (slot, card, file) => cardDiffReads.load(cardDiffKey(slot, card, file), () => api(`/api/changes/card-diff?id=${encodeURIComponent(card.id)}&runId=${card.runId}&path=${encodeURIComponent(file.path)}`, { slot }));

/** The diff of one file of a change card, prefetched on pointer/focus intent and scoped to its Chat. */
function ChangeDiff({ card, file }) {
	const slot = activeSlotId();
	const cached = cardDiffReads.peek(cardDiffKey(slot, card, file));
	const [entry, setEntry] = useState(cached ? { data: cached } : null);
	const markdown = MARKDOWN_PATH.test(file.path);
	useEffect(() => {
		let cancelled = false;
		readCardDiff(slot, card, file)
			.then((data) => !cancelled && setEntry({ data }))
			.catch((e) => !cancelled && setEntry({ error: e.message }));
		return () => {
			cancelled = true;
		};
	}, [slot, card.id, card.runId, file.path]);
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
	const slot = activeSlotId();
	const prefetch = () => { void readCardDiff(slot, card, file).catch(() => {}); };
	const toggle = () => (setOpened(true), setOpen(!open));
	return html`<div class="change-item">
		<button onPointerEnter=${prefetch} onFocus=${prefetch} class="change-file" aria-expanded=${open} title=${file.path} onClick=${toggle}>
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

/**
 * The earlier chats an answer was built on (what session_get really read), as a quiet line under the answer. Each name
 * opens that chat at the message that was read, so the source can be checked rather than taken on trust.
 */
function HistorySources({ sources }) {
	if (!sources.length) return null;
	return html`<div class="history-sources dim">
		<${Icon} name="clock" size=${12} />
		<span>${t("From earlier chats:")}</span>
		${sources.map((source) => html`<button key=${source.sessionId} class="history-source truncate" title=${t("Open this chat at the message that was read")} onClick=${() => actions.openSessionAt(source.path, source.entryId)}>${clip(source.title || t("Untitled chat"), 48)}</button>`)}
	</div>`;
}

/** The background block a "continue in a new chat" brought in, without its machine-readable frame. */
function continuationBody(text) {
	return String(text || "").replace(/^<continued-from[^>]*>\s*/, "").replace(/\s*<\/continued-from>\s*$/, "");
}

/**
 * "Continued from …": a marker line like the compaction one. It names the source chat, opens it at the point the
 * background was taken from, shows the background on demand, and — only before the first message — takes it back out.
 */
/**
 * The message a scheduled Agent task sends when it runs (turns.js marks its turn): a line naming the task, like the
 * other markers of the chat, with its instructions behind "Show instructions" instead of a bubble the user never typed.
 */
function ScheduledRunMarker({ item, details }) {
	const [open, setOpen] = useState(false);
	const time = new Date(item.ts).toLocaleString(getLang(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
	return html`<div class="marker scheduled-run-marker">
		<div class="marker-head">
			<span class="marker-line" />
			<span class="marker-text continuation-text">
				<${Icon} name="clock" size=${13} />
				<span>${t("Scheduled task")}</span>
				${details.title ? html`<span class="truncate">${clip(details.title, 60)}</span>` : null}
				<span class="dim">· ${time}</span>
				<button class="link-btn" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? t("Hide instructions") : t("Show instructions")}</button>
			</span>
			<span class="marker-line" />
		</div>
		<${Collapse} open=${open}><div class="marker-body"><${Markdown} text=${item.text || ""} /></div><//>
	</div>`;
}

function ContinuationMarker({ item }) {
	const [open, setOpen] = useState(false);
	const started = useStore((s) => s.items.some((other) => other.kind === "user"));
	const details = item.details || {};
	const title = details.sourceTitle || t("Untitled chat");
	const note = details.summaryState === "current" || details.summaryState === "behind" ? t("with its hand-off note") : t("from its newest messages");
	return html`<div class="marker continuation-marker">
		<div class="marker-head">
			<span class="marker-line" />
			<span class="marker-text continuation-text">
				<${Icon} name="chat" size=${13} />
				<span class="truncate">${t("Continued from “{title}”", { title: clip(title, 60) })}</span>
				<span class="dim">· ${note}</span>
				${details.sourcePath ? html`<button class="link-btn" onClick=${() => actions.openSessionAt(details.sourcePath, details.sourceEntryId)}>${t("View source")}</button>` : null}
				<button class="link-btn" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? t("Hide background") : t("Show background")}</button>
				${!started && item.id ? html`<button class="link-btn" title=${t("Start this chat without the earlier background")} onClick=${() => actions.unlinkContinuation(item.id)}>${t("Unlink")}</button>` : null}
			</span>
			<span class="marker-line" />
		</div>
		<${Collapse} open=${open}><div class="marker-body"><${Markdown} text=${continuationBody(item.text)} /></div><//>
	</div>`;
}

const TurnView = memo(function TurnView({ turn, isLast, live, waiting, run, cwd, processDefault, snapRun, compacting, interrupted }) {
	const ended = turnOutcome(turn, { run, live, waiting });
	// Stopped by a message sent with "interrupt": no "cancelled" banner, the answer to that message follows.
	const outcome = ended === "cancelled" && interrupted ? "redirected" : ended;
	const changeCount = run ? run.changeCount : turn.stats.files;
	const duration = turnDuration(turn, run);
	const working = live || waiting;
	const expanded = processDefault === "expanded";
	// Reasoning and tool calls fold into blocks between the texts the model wrote, in the order they happened. Once the
	// turn is done and steps start folded, those texts go into the one block too, leaving only the answer in view.
	const fold = !working && !expanded;
	const segments = useMemo(() => turnSegments(turn, { fold }), [turn, fold]);
	const tail = segments[segments.length - 1];
	// Nothing is being written into a block (no block yet, or the model last wrote text): the working state is a row of
	// its own at the end, the way the turn starts.
	const pending = working && !turn.final && (!tail || tail.type === "text");
	const lastBlock = pending ? undefined : segments.filter((segment) => segment.type === "process").pop();
	// Folding rebuilds the blocks (texts and later blocks go into the first one): glide to the new height instead of jumping.
	const processRef = useSwapGlide(fold);
	return html`<section class=${`turn ${live ? "live" : ""}`} data-turn-key=${turn.user ? turn.key : undefined} data-last-turn=${isLast ? "" : undefined}>
		${turn.user ? (turn.scheduled ? html`<${ScheduledRunMarker} item=${turn.user} details=${turn.scheduled} />` : html`<${UserMessage} item=${turn.user} turn=${turn} />`) : null}
		<div class="turn-process" ref=${processRef}>
		${segments.map((segment) =>
			segment.type === "text"
				? html`<div class="final" key=${segment.key}><${Markdown} text=${segment.step.text} /></div>`
				: html`<${ProcessSummary} key=${`sum-${turn.key}-${segment.key}`} turn=${turn} steps=${segment.steps} stats=${segment === lastBlock ? turn.stats : segment.stats} last=${segment === lastBlock} outcome=${outcome} live=${working} compacting=${compacting} run=${run} changeCount=${segment === lastBlock ? changeCount : segment.stats.files} duration=${duration} snapRun=${snapRun} defaultOpen=${expanded || (working && segment === tail && !turn.final)} />`,
		)}
		${pending ? html`<${ProcessSummary} key=${`sum-${turn.key}-pending`} turn=${turn} steps=${[]} outcome=${outcome} live=${working} compacting=${compacting} snapRun=${snapRun} defaultOpen=${false} />` : null}
		</div>
		${turn.final ? html`<${FinalMessage} final=${turn.final} />` : null}
		${turn.final && !working ? html`<${HistorySources} sources=${historySourcesOf(turn)} />` : null}
		${turn.changes ? html`<${ChangeCard} card=${turn.changes} />` : null}
		<${OutcomeBanner} turn=${turn} outcome=${outcome} run=${run} changeCount=${changeCount} isLast=${isLast} />
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
			: html`<${TurnView} key=${turn.key} turn=${turn} live=${!!snap?.active && !!liveTask} waiting=${false} run=${runForTurn(turn, runs || {})} processDefault=${processDefault} snapRun=${snap?.run} />`)}` : null}<//>`;
	}
	if (item.kind === "runChanges") return html`<${ChangeCard} card=${item} />`;
	if (item.kind === "bash") return html`<${BashCard} item=${item} />`;
	if (item.kind === "compaction" || item.kind === "branchSummary") {
		const title = item.kind === "compaction" ? (item.tokensBefore ? t("Context compacted (was ~{tokens} tokens)", { tokens: fmtTokens(item.tokensBefore) }) : t("Context compacted")) : t("Returned from another branch");
		return html`<div class="marker"><button class="marker-head" onClick=${() => setOpen(!open)} aria-expanded=${open}><span class="marker-line" /><span class="marker-text"><${Icon} name=${item.kind === "compaction" ? "layers" : "gitBranch"} size=${13} /> ${title}<${Fold} /></span><span class="marker-line" /></button>
			<${Collapse} open=${open}><div class="marker-body">${item.summary?.trim() ? html`<${Markdown} text=${item.summary} />` : html`<div class="dim">${t("This compaction saved no readable summary.")}</div>`}</div><//></div>`;
	}
	if (item.kind === "reload") return html`<div class="marker"><span class="marker-text">${item.ok ? t("Configuration reloaded") : t("Reload failed: {error}", { error: item.error })}</span></div>`;
	if (item.kind === "custom" && item.customType === "session-continuation") return html`<${ContinuationMarker} item=${item} />`;
	if (item.kind === "custom") {
		return html`<div class="custom-card"><div class="dim custom-type">${item.customType.replace(/[-_]/g, " ")}</div><${Markdown} text=${item.text} /></div>`;
	}
	return null;
}

function Welcome({ snap, models, opening = false }) {
	const ws = snap?.workspace?.name;
	const model = snap?.model;
	// The palette's own shortcut, which the user can change in Settings.
	const paletteKey = useStore((s) => shortcutFor("palette", s.view.shortcuts));
	return html`<div class="welcome">
		<h1>${ws ? tNodes("What should we work on in {workspace}?", { workspace: html`<span class="ws">${ws}</span>` }) : t("What should we work on?")}</h1>
		<div class="welcome-meta dim mono truncate" title=${snap?.cwd || ""}>${snap?.cwd || ""}</div>
		<div class="welcome-tips dim">
			<span><span class="kbd">/</span> ${t("commands & skills")}</span>
			<span><span class="kbd">@</span> ${t("mention a file")}</span>
			${paletteKey ? html`<span><span class="kbd">${paletteKey}</span> ${t("command palette")}</span>` : null}
		</div>
		${!model && !opening ? html`<div class="welcome-warn"><${Icon} name="alertTriangle" size=${15} /> ${tNodes("No model is available yet. {add} to start.", { add: html`<button class="link-btn" onClick=${() => setView({ settingsOpen: true, settingsSection: "providers", providerSel: "nebius" })}>${t("Connect NVIDIA Nemotron on Nebius")}</button>` })}</div>` : null}
	</div>`;
}

// ---- Transcript container ------------------------------------------------------------------------
// Turn mounting arrives in chunks: the first frame paints only the newest turns, then one batch per
// animation frame is appended above until every turn is mounted. The reader sees content sooner and no single
// frame carries the full mount.
const CHUNK_FIRST = 20;
/** The most turns one later batch mounts. */
const CHUNK_NEXT = 20;
// Later batches are sized by what they cost: a fixed batch of rich turns (code, tables, lists) held a frame for 30-60 ms,
// so typing, clicks and scrolling right after a long chat opened lagged. Each batch is steered to take about
// CHUNK_BUDGET_MS of render and layout. Part of that cost does not shrink with the batch (older turns go in above, so
// every turn below moves and is laid out and painted again: about 3 ms at 200 turns), so the size follows the measured
// cost of the last batches rather than a cost per turn. One size for every chat: the next chat's turns cost about the same.
const CHUNK_BUDGET_MS = 8;
let chunkSize = 8;
function nextChunk() {
	return Math.max(1, Math.min(CHUNK_NEXT, Math.round(chunkSize)));
}
// A key press or click gets its frame to itself: batches wait while the reader types or clicks (the turns still to mount
// are out of view above, nothing on screen waits for them) and go on in the pauses.
const INPUT_QUIET_MS = 100;
let lastInput = 0;
if (typeof document !== "undefined") {
	for (const type of ["keydown", "pointerdown"]) document.addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
}
/** A batch of `turns` turns (`wanted` were asked for) took `ms` from being asked for to being laid out. */
function noteChunkCost(ms, turns, wanted) {
	if (turns < 1 || turns > CHUNK_NEXT * 2 || !(ms > 0)) return;
	// The last turns of a chat come in a smaller batch: cheap because it was small, which says nothing about the size.
	if (turns < wanted && ms <= CHUNK_BUDGET_MS) return;
	const aim = Math.max(turns / 2, Math.min(turns * 2, (turns * CHUNK_BUDGET_MS) / ms));
	chunkSize = Math.max(1, Math.min(CHUNK_NEXT, (chunkSize + aim) / 2));
}
/** How long the transcript waits before asking the server for one more older page (see the fill effect below). */
const FILL_DELAY = 200;
/** Whether a build published for `owner` describes the session on screen right now (same slot, same session id). */
function describesSession(owner, slot, session) {
	return !!owner && owner.slot === slot && (owner.session == null || owner.session === session);
}
// Where the reader was in each chat they left, by session id (a slot can be released and the chat reopened in another):
// `{ stick: true }` when it followed the bottom, otherwise the first turn still visible at the top (its key) and how many
// pixels of it were above the view. Coming back to the chat puts that turn at the same place (see the return below).
const readerPlaces = new Map();
const READER_PLACES_MAX = 64;
/** How long a return keeps waiting for the turn it left at (a full build or an older page still on its way). */
const RESTORE_WAIT_MS = 1500;
function rememberPlace(session, place) {
	if (!session || !place) return;
	readerPlaces.delete(session);
	readerPlaces.set(session, place);
	while (readerPlaces.size > READER_PLACES_MAX) readerPlaces.delete(readerPlaces.keys().next().value);
}
/** The reader's place in the transcript `el` shows, or null when it shows no turn (a loading page, an empty chat). */
function readPlace(el, stuck) {
	const sections = el?.querySelectorAll(":scope > .transcript-inner > section.turn[data-turn-key]");
	if (!sections?.length) return null;
	if (stuck) return { stick: true };
	const top = el.getBoundingClientRect().top;
	// The first turn whose bottom is below the top of the view: a binary search, a handful of layout reads.
	let lo = 0;
	let hi = sections.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (sections[mid].getBoundingClientRect().bottom > top + 1) {
			found = mid;
			hi = mid - 1;
		} else lo = mid + 1;
	}
	if (found < 0) return { stick: true };
	const node = sections[found];
	const place = { stick: false, key: node.dataset.turnKey, offset: Math.round(top - node.getBoundingClientRect().top) };
	// The block at the top inside that turn too: every box on the way down to it (its position among its siblings, where
	// its top was and the start of its text). Coming back at another column width (a panel still sliding open) puts the
	// same paragraph at the top, not the same pixel of the turn; when the innermost boxes are not there again (a link that
	// local-file detection added, not added yet), the deepest one that is still there is used.
	const block = readingAnchor(el, el.querySelector(":scope > .transcript-inner"));
	if (block && block.node !== node && node.contains(block.node)) {
		place.path = [];
		for (let at = block.node; at !== node; at = at.parentElement)
			place.path.unshift({ index: Array.prototype.indexOf.call(at.parentElement.children, at), top: Math.round(at.getBoundingClientRect().top - top), text: at.textContent.slice(0, 40) });
	}
	return place;
}
/**
 * The deepest box of a remembered place that its turn `node` still has (`{ el, top }`, `whole` when that is the block
 * itself), or null when not even the first one is there.
 */
function placeBlock(node, want) {
	let found = null;
	let at = node;
	for (const [depth, step] of (want.path || []).entries()) {
		at = at.children[step.index];
		if (!at || at.textContent.slice(0, 40) !== step.text) break;
		found = { el: at, top: step.top, whole: depth === want.path.length - 1 };
	}
	return found;
}
/**
 * The block at the top of the view in `el` (a paragraph, a code block, a card: the deepest box that is still partly
 * above the top line, or the first one below it) and how far its top is from the top of the view. Children are searched
 * in their vertical order, a handful of layout reads per level.
 */
function readingAnchor(el, inner) {
	if (!el || !inner) return null;
	const top = el.getBoundingClientRect().top;
	let parent = inner;
	let node = null;
	for (let depth = 0; depth < 8; depth++) {
		const kids = parent.children;
		let lo = 0;
		let hi = kids.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (kids[mid].getBoundingClientRect().bottom > top + 1) {
				found = mid;
				hi = mid - 1;
			} else lo = mid + 1;
		}
		if (found < 0) break;
		node = kids[found];
		if (node.getBoundingClientRect().top >= top - 1 || !node.firstElementChild) break;
		parent = node;
	}
	return node ? { node, top: node.getBoundingClientRect().top - top } : null;
}
/**
 * Right before a mode reveal or a layout morph captures the page (beforePageCapture): the turns of `el` out of view skip
 * their contents (content-visibility: hidden at their own height, so nothing moves). The capture restyles the whole
 * document, and a long chat is most of it. 200px around the view stay drawn, or `reach` heights of the view when the
 * conversation is about to get wider (more of it comes into view). Returns how to undo it for the turns still on the page.
 */
function skipTurnsOutOfView(el, reach = 0) {
	const inner = el?.querySelector(":scope > .transcript-inner");
	if (!inner) return null;
	const view = el.getBoundingClientRect();
	const margin = Math.max(200, view.height * reach);
	const skipped = [];
	// All reads first, then all writes: one layout, which is up to date at a click anyway.
	for (const node of inner.children) {
		if (node.tagName !== "SECTION") continue;
		const box = node.getBoundingClientRect();
		if (box.bottom > view.top - margin && box.top < view.bottom + margin) continue;
		const style = getComputedStyle(node);
		const edges = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce((sum, key) => sum + (Number.parseFloat(style[key]) || 0), 0);
		skipped.push([node, `${Math.max(0, box.height - edges)}px`]);
	}
	for (const [node, height] of skipped) {
		node.style.containIntrinsicBlockSize = height;
		node.style.contentVisibility = "hidden";
	}
	return () => {
		for (const [node] of skipped) {
			if (!node.isConnected) continue;
			node.style.contentVisibility = "";
			node.style.containIntrinsicBlockSize = "";
		}
	};
}
/** The mount window of a first open: the newest CHUNK_FIRST turns, none held back. */
const OPEN_WINDOW = { count: CHUNK_FIRST, held: 0 };
/** Turns mounted above the turn a return goes back to, in its first commit (the rest of CHUNK_FIRST is below it). */
const RETURN_ABOVE = 5;
/**
 * The first mount window of a return to the turn `key`: CHUNK_FIRST turns around it, with the `held` newest turns not
 * mounted yet. They mount below it one batch per frame, then older ones above as usual, so a return costs one first
 * batch like any open, wherever the turn is. The open window when the turn is not among `shown`.
 */
function windowFor(shown, key) {
	const at = key ? shown.findIndex((turn) => turn.key === key) : -1;
	if (at < 0) return OPEN_WINDOW;
	const end = Math.min(shown.length, Math.max(at + 1, Math.max(0, at - RETURN_ABOVE) + CHUNK_FIRST));
	return { count: CHUNK_FIRST, held: shown.length - end };
}
export function Transcript() {
	const switching = useStore((s) => s.switching);
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
	// Which session those turns belong to (slot plus session id): a reload of another session must never show them.
	const prevOwner = useRef({ slot: null, session: null });
	const turnsSlot = activeSlotId();
	const session = snap?.session?.id;
	const [asyncTurns, setAsyncTurns] = useState(null);
	// True while the newest render is the cold-load tail preview instead of a full build. The first full build replaces
	// it once, and that swap gets the same scroll compensation as "show earlier": the transcript only grows above.
	const previewing = useRef(false);
	const swapHeight = useRef(0);
	// The paged first screen (TRANSCRIPT_FIRST_PAGE): a full 400-item page with older items still
	// server-side opens as the 60-turn tail preview, exactly like an over-long transcript.
	const transcriptHasMore = useStore((s) => s.transcriptHasMore);
	// A task-end notification asked for this chat's last turn (store.openChatAtLastTurn): it wins over a remembered place.
	const landing = useStore((s) => s.landing);
	// The built turns carry translated text (action verbs, summaries): after a language switch the turns on screen stay
	// until the build in the new language lands, but none of their objects is reused for it.
	const lang = useStore((s) => s.view.lang);
	const turns = useMemo(() => {
		const reusable = prevOwner.current.lang === lang ? prevTurns.current : null;
		// A loading shell has no transcript to project; avoid empty intermediate builds and cache pollution.
		if (switching || items.length === 0) {
			previewing.current = false;
			return [];
		}
		// Cross-session cache: when this bag's last build still describes exactly these references, reuse the very
		// same turn objects (skipping buildTurns and the sameTurn pass). Mount chunking stays as it is: reusing the
		// objects does not spare the DOM insert, and a full-window first commit measured 3x slower to first paint.
		const cached = cachedTurns(getTurnsCache(turnsSlot), items, toolRuns, cwd);
		if (cached) {
			prevTurns.current = cached;
			prevOwner.current = { slot: turnsSlot, session, lang };
			previewing.current = false;
			return cached;
		}
		const previewSlice = tailPreviewSlice(items, transcriptHasMore);
		if (previewSlice) {
			// One visible source only: once a full build of this session exists, keep showing it — at most one build
			// behind the newest stream update — instead of falling back to the tail preview. Swapping between the two on
			// every update remounted the whole transcript (new keys each time), replayed its entry animation and threw
			// the reader's scroll position away; the build driver below publishes each full build as it lands.
			if (asyncTurns && describesSession(asyncTurns, turnsSlot, session)) {
				prevTurns.current = asyncTurns.turns;
				prevOwner.current = { slot: turnsSlot, session: asyncTurns.session, lang: asyncTurns.lang };
				previewing.current = false;
				return asyncTurns.turns;
			}
			if (prevTurns.current && describesSession(prevOwner.current, turnsSlot, session)) {
				previewing.current = false;
				return prevTurns.current;
			}
			// Cold load: keep a complete tail turn when possible, rather than cutting in the middle of a tool exchange.
			// Only until the first full build of this session lands: from then on the preview is never shown again.
			previewing.current = true;
			return buildTurns(previewSlice, { cwd, toolRuns }, reusable);
		}
		// Small sessions still build synchronously, but under an 8ms frame budget: drive the shared generator
		// directly and publish only a finished build. When the budget runs out, show the same tail-window preview
		// the cold-load path above shows and let the single-flight startBuild below publish the full build (it is
		// gated to run while previewing/fullNeeded); no intermediate state is published and thumbnails never roll back.
		const work = buildTurnsWork(items, { cwd, toolRuns }, reusable);
		const deadline = performance.now() + 8;
		let step = work.next();
		while (!step.done && performance.now() < deadline) step = work.next();
		if (step.done) {
			const built = step.value;
			setTurnsCache({ items, toolRuns, cwd, lang, turns: built }, turnsSlot);
			prevTurns.current = built;
			prevOwner.current = { slot: turnsSlot, session, lang };
			previewing.current = false;
			return built;
		}
		let start = Math.max(0, items.length - 60);
		while (start > Math.max(0, items.length - 120) && items[start]?.kind !== "user") start--;
		previewing.current = true;
		return buildTurns(items.slice(start), { cwd, toolRuns }, reusable);
	}, [items, toolRuns, cwd, turnsSlot, session, asyncTurns, switching, transcriptHasMore, lang]);
	// Full builds for huge sessions run one at a time: while one runs, newer stream updates only mark it dirty, the
	// finished build is published as soon as it lands, and the newest state is built right after. Cancelling the build
	// on every update (the previous shape) meant no build ever finished while output streamed, so the view kept falling
	// back to the tail preview it had just replaced.
	const build = useRef({ running: false, dirty: false, token: null, slot: null, items: null, toolRuns: null });
	const buildRequest = useRef(null);
	buildRequest.current = { items, toolRuns, cwd, slot: turnsSlot, session, switching, lang };
	const startBuild = () => {
		const request = buildRequest.current;
		const state = build.current;
		if (state.running) {
			if (state.slot !== request.slot) {
				// The bag moved on: the running build describes another session and must not be published.
				if (state.token) state.token.cancelled = true;
				state.running = false;
			} else if (state.items !== request.items || state.toolRuns !== request.toolRuns || state.lang !== request.lang) {
				// Newer data arrived while a build runs: remember that one more build is owed and leave the single-flight
				// gate alone. Falling through started a second full projection next to the running one (and reset the dirty
				// flag), which is what let an older build land last and stay on screen.
				state.dirty = true;
				return;
			} else return;
		}
		if (request.switching) return;
		// A loading shell has nothing to project (the memo returns an empty list): building it would only add work to
		// a switch that already invalidates the next build.
		if (request.items.length === 0) return;
		// One rule for every session, never a size guess: rebuild exactly while the turns on screen were not built from
		// these references. A paged first page can come back shorter than its limit (the server aligns the window to a
		// user message), so "more items than one page" skipped the rebuild for exactly those chats and their new messages
		// never reached the screen. The cache hit below is what keeps small sessions (built synchronously under the frame
		// budget) from ever reaching the async path.
		if (cachedTurns(getTurnsCache(request.slot), request.items, request.toolRuns, request.cwd)) {
			state.dirty = false;
			return;
		}
		state.running = true;
		state.dirty = false;
		state.slot = request.slot;
		state.items = request.items;
		state.toolRuns = request.toolRuns;
		state.lang = request.lang;
		const token = state.token = { cancelled: false };
		void buildTurnsAsync(request.items, { cwd: request.cwd, toolRuns: request.toolRuns }, request.slot === prevOwner.current.slot && prevOwner.current.lang === request.lang ? prevTurns.current : null, () => token.cancelled).then((built) => {
			if (token.cancelled || !built) {
				// A cancelled build must not leave the gate closed for the build that replaced it.
				if (state.token === token) state.running = false;
				return;
			}
			state.running = false;
			// The cold-load preview is about to be replaced: take the height before the swap so the reader's place can be
			// kept (pinned to the bottom, the follow below holds its place anyway).
			if (previewing.current) swapHeight.current = scroller.current?.scrollHeight || 0;
			// An older page that arrived while the full view was showing (full→full prepend) grows the list above
			// the reader once this build publishes; the fetch commit itself showed the stale build and changed no
			// height. Pure appends and branch replacements keep the tail object and are excluded: appended content
			// grows below the reader and must not be compensated.
			else if (
				asyncTurns &&
				describesSession(asyncTurns, request.slot, request.session) &&
				request.items.length > asyncTurns.items.length &&
				request.items[0] !== asyncTurns.items[0] &&
				request.items[request.items.length - 1] === asyncTurns.items[asyncTurns.items.length - 1]
			)
				swapHeight.current = scroller.current?.scrollHeight || 0;
			// A build started before a language switch describes the old language: the next render builds again.
			if (request.lang !== getLang()) {
				if (state.dirty) scheduleBuild();
				return;
			}
			setTurnsCache({ items: request.items, toolRuns: request.toolRuns, cwd: request.cwd, lang: request.lang, turns: built }, request.slot);
			setAsyncTurns({ slot: request.slot, session: request.session, items: request.items, toolRuns: request.toolRuns, cwd: request.cwd, lang: request.lang, turns: built });
			if (state.dirty) scheduleBuild();
		}).catch(() => {
			// A failed background build must not wedge the single-flight gate: clear it so the next render can
			// start a fresh build. The tail preview or the previous turns stay on screen until then.
			state.running = false;
			state.dirty = false;
		});
	};
	// Runs after every render. A build is scheduled for the next task, so the several store writes one switch makes
	// (snapshot, transcript, mode) land in one build instead of one each; while a build runs, newer data is merged
	// into a single follow-up build by the dirty flag above.
	const buildTimer = useRef(0);
	const scheduleBuild = () => {
		if (buildTimer.current) return;
		buildTimer.current = setTimeout(() => {
			buildTimer.current = 0;
			startBuild();
		}, 0);
	};
	useEffect(() => {
		scheduleBuild();
	});
	// What the send check reads: the turns the screen was last given, so a message that sits in the data without ever
	// being drawn is not mistaken for one that is already visible.
	useEffect(() => {
		notePaintedTurns(turns);
	}, [items, turns]);
	useEffect(() => () => {
		if (buildTimer.current) clearTimeout(buildTimer.current);
		if (build.current.token) build.current.token.cancelled = true;
	}, []);

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
	// After a landing (a notification click, see below) the last turn is held where it was put while the chat settles:
	// older turns mounting, older pages and late layout above it would otherwise push it down (overflow-anchor is off).
	const anchor = useRef(null);
	const holdAnchor = () => {
		const a = anchor.current;
		const el = scroller.current;
		if (!a || !el) return;
		const node = content.current?.querySelector(":scope > section.turn[data-last-turn]");
		if (!node || Date.now() > a.until) { anchor.current = null; return; }
		// A landing on the loaded part of a long turn: once the turn's own message is there, the landing effect places it.
		if (a.userless && node.querySelector(":scope > .user-row")) { anchor.current = null; return; }
		const drift = node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
		if (Math.abs(drift) >= 1) { el.scrollTop += drift; lastTop.current = el.scrollTop; }
	};
	// Away from the bottom, the block the reader has at the top of the view (readingAnchor). Overflow anchoring is off (the
	// follow does its own scrolling), so without this a change of the column's width — the panel sliding open beside it
	// when a chat with an open panel comes back, the window resized — rewraps every turn above and moves the text away.
	// It keeps the size of the view it was taken in: a scroll event that comes with another size (a zoom snaps the scroll
	// position to the new pixel grid) is the browser's, and may run before the resize callback has put the block back.
	const reading = useRef(null);
	const noteReading = () => {
		const el = scroller.current;
		const found = stick.current ? null : readingAnchor(el, content.current);
		reading.current = found && { ...found, width: el.clientWidth, height: el.clientHeight };
	};
	const holdReading = () => {
		const r = reading.current;
		const el = scroller.current;
		if (!r || !el || stick.current || anchor.current || restore.current) return;
		if (!r.node.isConnected) { reading.current = null; return; }
		r.width = el.clientWidth;
		r.height = el.clientHeight;
		const drift = r.node.getBoundingClientRect().top - el.getBoundingClientRect().top - r.top;
		if (Math.abs(drift) >= 1) { el.scrollTop += drift; lastTop.current = el.scrollTop; }
	};
	const holdPlace = useRef(false);
	// A jump to one message of another chat, waiting for that chat to be on screen (see the reveal effect below).
	const revealWant = useRef(null);
	// A pending return to where the reader left this chat (readerPlaces), applied once that turn is on the page.
	const restore = useRef(null);
	const restoreTimer = useRef(0);
	// applyRestore of the newest render, for the resize callback (it reads the turns of the render it was made in).
	const restoreNow = useRef(() => {});
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
	const measureScroll = () => {
		measureFrame.current = 0;
		const el = scroller.current;
		if (!el) return;
		// The view changed size since the block at the top was taken: the text moved under it, the reader did not move.
		const r = reading.current;
		if (r && !stick.current && (r.width !== el.clientWidth || r.height !== el.clientHeight)) holdReading();
		const top = el.scrollTop;
		const distance = Math.max(0, el.scrollHeight - el.clientHeight - top);
		const near = distance <= 10;
		// Size changes and scroll anchoring are not reader intent.
		if (!programmatic.current && Date.now() - lastInteract.current < 500 && top < lastTop.current - 2 && distance > 72) stick.current = false;
		if (near && !holdPlace.current) { stick.current = true; programmatic.current = false; }
		// The block at the top is taken again only when the view itself moved: a measure after a layout change (the column
		// rewrapping) would take the moved text as the new place before holdReading puts it back.
		if (stick.current) reading.current = null;
		else if (top !== lastTop.current || !reading.current) noteReading();
		lastTop.current = top;
		const show = !stick.current && distance > 72;
		setAway((prev) => (prev === show ? prev : show));
	};
	const scheduleMeasure = () => {
		if (!measureFrame.current) measureFrame.current = requestAnimationFrame(measureScroll);
	};
	const onScroll = () => scheduleMeasure();
	const noteInteraction = (event) => {
		// Ctrl + wheel (and a touchpad pinch) zooms the window and never scrolls: the reader has not moved.
		if (event.type === "wheel" && event.ctrlKey) return;
		anchor.current = null;
		if (event.type === "wheel" || event.type === "keydown" || event.type === "mousedown") landingWait.current = null;
		if (event.type === "wheel" || event.type === "keydown" || event.target === scroller.current) {
			holdPlace.current = false;
			// The reader moved by themselves: a return still waiting for its turn must not pull them away afterwards.
			restore.current = null;
		}
		const scrollInput = event.type === "wheel" ? event.deltaY < 0
			: event.type === "keydown" ? ["ArrowUp", "PageUp", "Home"].includes(event.key)
			: event.target === scroller.current;
		if (scrollInput) {
			lastInteract.current = Date.now();
			programmatic.current = false;
		}
	};
	// Opening a file's diff, or an attachment card's preview, makes the page taller below the row that was clicked.
	// Following the bottom would scroll that row up (and the first pixels of the growth would count as "still at the
	// bottom"), so while one of them is open the page holds its place: the row stays where it is and the content grows
	// downwards. Scrolling by hand, or closing it, ends that.
	const holdOnOpen = (event) => {
		const row = event.target.closest?.(".change-file, .attach-card [aria-expanded]");
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
	const sentSeen = useRef({ session: null, id: null });
	useLayoutEffect(() => {
		const last = items[items.length - 1];
		const sent = last?.kind === "user" && last.pending ? last.clientMessageId : null;
		const seen = sentSeen.current;
		sentSeen.current = { session, id: sent };
		// The reader's own message was just sent in this chat. At the bottom the view follows it like any new output; a reader
		// further up (reading earlier turns while the Agent works on the question) stays where they are, and the jump
		// button leads down when they want it.
		if (sent && seen.session === session && seen.id !== sent) {
			if (stick.current) toBottom();
			return;
		}
		// Without a ResizeObserver (or before its first callback) the item signal still has to drive the follow.
		if (!roActive.current && stick.current && Date.now() - lastInteract.current > 500) toBottom();
	}, [items, order, userBash, toolRuns]);
	// Away from the bottom, the page changed height: what the reader has in view stays where it is.
	const holdView = () => {
		// A return waiting for a long answer to be parsed: the parsed answer has just come in.
		if (restore.current) restoreNow.current();
		holdAnchor();
		holdReading();
	};
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
			else {
				holdView();
				scheduleMeasure();
			}
		});
		ro.observe(content.current);
		ro.observe(scroller.current);
		return () => {
			roActive.current = false;
			ro.disconnect();
		};
	}, []);
	// The message index and the quote jumps scroll through this controller, so "follow the bottom" lets go when they move.
	// A quote jump also asks it to mount every turn and says whether older history is still on its way (set below).
	const nav = useRef({ revealAll: () => {}, pending: () => null });
	useLayoutEffect(() => registerScroller({
		el: scroller.current,
		release: () => { stick.current = false; holdPlace.current = false; anchor.current = null; restore.current = null; },
		revealAll: () => nav.current.revealAll(),
		pending: () => nav.current.pending(),
		// At the bottom a message that folds only shortens the page, and the browser keeps the view at its end.
		keep: () => { if (!stick.current) holdView(); },
	}), []);
	useLayoutEffect(() => {
		anchor.current = null;
		reading.current = null;
		// The cached height belongs to the previous session; the first follow after a switch reads once.
		contentHeight.current = 0;
		// So do heights a chunk or a preview swap of the previous session took: they must not shift this one.
		chunkHeightBefore.current = 0;
		swapHeight.current = 0;
		clearTimeout(restoreTimer.current);
		const place = readerPlaces.get(session);
		// Back to a chat the reader left away from the bottom: the turn they were reading goes back where it was. A jump to
		// one message (View source, an answer's sources) or a notification's landing decides where it opens instead.
		if (place && !place.stick && !revealWant.current && landing?.slot !== turnsSlot) {
			stick.current = false;
			holdPlace.current = false;
			programmatic.current = false;
			restore.current = { session, key: place.key, offset: place.offset, path: place.path, until: Date.now() + RESTORE_WAIT_MS };
			restoreTimer.current = setTimeout(() => giveUpRestore(), RESTORE_WAIT_MS + 50);
			applyRestore();
			return;
		}
		restore.current = null;
		stick.current = true;
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

	// A commit repairs its own pre-commit failures in rounds, one card each. Only the newest card of the task that is
	// repairing right now borrows the task's progress; every other card is a finished round with nothing running.
	const repairTask = gitTask && gitTask.phase === "repairing" ? gitTask : null;
	const repairing = !!repairTask;
	const liveRepairKey = (() => {
		if (!repairing) return null;
		for (let i = turns.length - 1; i >= 0; i--) if (turns[i].standalone?.kind === "gitRepair") return turns[i].key;
		return null;
	})();
	const lastTurnIndex = (() => {
		for (let i = turns.length - 1; i >= 0; i--) if (!turns[i].standalone) return i;
		return -1;
	})();
	// No display window: every turn is part of the page, so the message index covers the whole conversation and no
	// turn sits behind a "show more" button. Mounting is still chunked below and every TurnView is memoized, so a long
	// session pays for its turns once instead of in a single frame.
	// (transcriptHasMore is subscribed above: the tail-preview useMemo depends on it.)
	const transcriptFetching = useStore((s) => s.transcriptFetching);
	const shown = turns;
	// The index is built from the whole conversation, not from the turns mounted so far: its ticks and its jumps must
	// cover messages the reader has not scrolled to yet.
	const railTurns = useMemo(() => turns.filter((turn) => !turn.standalone && turn.user), [turns]);
	// How many of `shown` are mounted so far: mounting starts with the newest CHUNK_FIRST turns and grows
	// by one batch (nextChunk) per animation frame. When another session is shown (the new bag arrives with a new session
	// id in the same commit) chunking restarts from the first batch; while one session keeps streaming the
	// batch count only grows, so the transcript never collapses back. Derived during render on purpose: the
	// first commit after a switch already shows 20, never a stale full mount.
	const [win, setWin] = useState(OPEN_WINDOW);
	const batchSession = useRef(session);
	// A switch that shows a loading page first (a mode switch, a chat that is not loaded yet) empties this page while the
	// session is still the one being left, and the next session comes later: its reader's place is read in the render
	// that starts the switch, while the page still shows its turns. Read later, the page is empty and the place is lost.
	const wasSwitching = useRef(!!switching);
	if (switching && !wasSwitching.current && session && restore.current?.session !== session) rememberPlace(session, readPlace(scroller.current, stick.current));
	wasSwitching.current = !!switching;
	const switched = batchSession.current !== session;
	const firstWin = useRef(OPEN_WINDOW);
	if (switched) {
		// This render replaces the chat on the page, and the page still shows the one being left: the last moment its
		// reader's place can be read (a return still waiting keeps the place it waits for).
		if (restore.current?.session !== batchSession.current) rememberPlace(batchSession.current, readPlace(scroller.current, stick.current));
		batchSession.current = session;
		const place = readerPlaces.get(session);
		firstWin.current = place && !place.stick && !revealWant.current && landing?.slot !== turnsSlot ? windowFor(shown, place.key) : OPEN_WINDOW;
	}
	// Unmounted (a language switch rebuilds the interface, main.js keys <App> by it): the page still shows this chat, so
	// its place is read now and the new Transcript opens where the reader is, not at a place from an earlier switch.
	// Hook cleanups run before the old DOM goes and before the new Transcript's layout effects.
	useLayoutEffect(() => () => {
		if (restore.current?.session !== batchSession.current) rememberPlace(batchSession.current, readPlace(scroller.current, stick.current));
	}, []);
	const liveWin = switched ? firstWin.current : win;
	// The window of the newest render: a chunk frame queued for an older window does nothing.
	const winNow = useRef(liveWin);
	winNow.current = liveWin;
	const end = shown.length - Math.min(liveWin.held, shown.length);
	const mounted = Math.min(end, liveWin.count);
	const rendered = mounted >= shown.length ? shown : shown.slice(end - mounted, end);
	const renderedStart = end - rendered.length;
	const chunkFrame = useRef(0);
	const chunkHeightBefore = useRef(0);
	// When the batch in flight was asked for and how many turns were mounted then (see noteChunkCost).
	const chunkCost = useRef(null);
	const cancelChunks = () => {
		cancelAnimationFrame(chunkFrame.current);
		chunkFrame.current = 0;
	};
	// A jump from the message index to a message that is still mounting asks for the whole mount at once: the reader
	// named a message, so waiting out the chunked mount would only look like a dead click.
	const revealAll = () => setWin({ count: Number.MAX_SAFE_INTEGER, held: 0 });
	nav.current.revealAll = revealAll;
	nav.current.pending = () => {
		// The cold-load tail preview stands in for a full build that is still on its way: that counts as mounting too.
		const mounting = previewing.current || rendered.length < shown.length;
		return mounting || transcriptHasMore ? { mounting, older: transcriptHasMore } : null;
	};
	// The return to a remembered place: the turn goes back to the same distance from the top of the view. It runs before
	// paint (from the switch's layout effect, then after every commit while it waits), so the bottom is never shown first.
	// A turn that is loaded but not mounted is mounted around at once; one that is not loaded yet (the full build or an
	// older page on its way) is waited for at the bottom, like a first open, for at most RESTORE_WAIT_MS.
	// An entry is used once: after the return (placed or given up) only a later leave or unmount writes a place again, so
	// a stale one can never pull the reader back.
	const giveUpRestore = () => {
		clearTimeout(restoreTimer.current);
		const want = restore.current;
		if (!want) return;
		readerPlaces.delete(want.session);
		restore.current = null;
		// Already at its turn, waiting for a long answer to be parsed: the reader stays there.
		if (want.placed) {
			noteReading();
			scheduleMeasure();
			return;
		}
		stick.current = true;
		toBottom();
	};
	const applyRestore = () => {
		const want = restore.current;
		const el = scroller.current;
		if (!want || !el) return;
		if (want.session !== session || landing?.slot === turnsSlot) {
			restore.current = null;
			clearTimeout(restoreTimer.current);
			return;
		}
		const node = !switching && want.key ? content.current?.querySelector(`:scope > section.turn[data-turn-key="${CSS.escape(want.key)}"]`) : null;
		if (node) {
			// Waiting at the bottom may have counted as following it: the restored place is not.
			stick.current = false;
			const block = placeBlock(node, want);
			el.scrollTop = block
				? block.el.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - block.top
				: node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop + want.offset;
			lastTop.current = el.scrollTop;
			// A long answer of the turn is still plain text while its Markdown is parsed (markdown.js), with another
			// height: the turn is where it was for now, and the block goes back to its place once the parsed answer is in.
			if (!block?.whole && want.path && Date.now() < want.until && node.querySelector(".md-pending")) {
				want.placed = true;
				return;
			}
			readerPlaces.delete(want.session);
			restore.current = null;
			clearTimeout(restoreTimer.current);
			noteReading();
			scheduleMeasure();
			return;
		}
		// Loaded but outside the mounted window (it arrived after the switch: the full build, an older page): mount around it.
		const at = want.key ? shown.findIndex((turn) => turn.key === want.key) : -1;
		if (at >= 0 && (at < renderedStart || at >= renderedStart + rendered.length)) {
			// A chunk queued for the window on the page must not land on top of this one (its height would be compensated).
			cancelChunks();
			setWin(windowFor(shown, want.key));
			return;
		}
		if (Date.now() < want.until && (switching || previewing.current || transcriptHasMore || transcriptFetching)) {
			el.scrollTop = el.scrollHeight;
			lastTop.current = el.scrollTop;
			return;
		}
		// Not in this chat any more (another branch, a rewritten history) or waited long enough: open like a first open.
		giveUpRestore();
	};
	restoreNow.current = applyRestore;
	useLayoutEffect(() => {
		// A switch renders its first window from derived state; sync the state before paint so later frames grow from it.
		if (switched && win !== firstWin.current) setWin(firstWin.current);
	});
	useEffect(() => {
		if (rendered.length >= shown.length) return undefined;
		let unwait = null;
		const grow = () => requestAnimationFrame(() => {
			chunkFrame.current = 0;
			if (winNow.current !== liveWin) return;
			// While a mode reveal draws this chat, a side that already has a whole view's height mounted beyond the view waits
			// for the reveal to end: mounting more there changes nothing on screen and only takes frames from the reveal.
			const el = scroller.current;
			if (el && modeRevealActive()) {
				const beyond = liveWin.held > 0 ? el.scrollHeight - el.scrollTop - el.clientHeight : el.scrollTop;
				if (beyond >= el.clientHeight) {
					unwait = afterModeReveal(() => {
						unwait = null;
						chunkFrame.current = grow();
					});
					if (unwait) return;
				}
			}
			if (performance.now() - lastInput < INPUT_QUIET_MS) {
				chunkFrame.current = grow();
				return;
			}
			const n = Math.min(nextChunk(), liveWin.held > 0 ? liveWin.held : Number.MAX_SAFE_INTEGER);
			if (liveWin.held > 0) {
				// A return mounted around the turn being read: the newer turns go in below it first, which moves nothing.
				chunkCost.current = { at: performance.now(), from: rendered.length, wanted: n };
				setWin({ count: liveWin.count + n, held: liveWin.held - n });
				return;
			}
			// Older turns mount above what is already on screen; the height taken before the commit lets the
			// layout effect below shift the scroll by exactly the growth, so the newest message does not move.
			chunkHeightBefore.current = el?.scrollHeight || 0;
			chunkCost.current = { at: performance.now(), from: rendered.length, wanted: n };
			setWin({ count: liveWin.count + n, held: 0 });
		});
		chunkFrame.current = grow();
		return () => {
			cancelChunks();
			unwait?.();
		};
	}, [rendered.length, shown.length, liveWin]);
	useLayoutEffect(() => {
		if (chunkHeightBefore.current && scroller.current) {
			scroller.current.scrollTop += scroller.current.scrollHeight - chunkHeightBefore.current;
			// Not the reader's move: the block they read is still the one at the top (see measureScroll).
			lastTop.current = scroller.current.scrollTop;
			chunkHeightBefore.current = 0;
		}
		// The batch is in and laid out (the reads above and the messages' own measuring forced it): what it cost sizes the next.
		const cost = chunkCost.current;
		chunkCost.current = null;
		if (cost) noteChunkCost(performance.now() - cost.at, rendered.length - cost.from, cost.wanted);
	}, [rendered.length]);
	useEffect(() => beforePageCapture(({ reach }) => skipTurnsOutOfView(scroller.current, reach)), []);
	// Older history that is still server-side fills in by itself: the reader never asks for it. One page per idle
	// beat, so first paint, typing and streaming keep priority; a page lands above the reader and the build that
	// publishes it already compensates that growth (the full→full prepend anchor in startBuild). Two failures in a
	// row stop the fill instead of retrying a page that cannot arrive.
	const fill = useRef({ slot: null, failures: 0, tries: 0, done: false });
	useEffect(() => {
		if (fill.current.slot !== turnsSlot) fill.current = { slot: turnsSlot, failures: 0, tries: 0, done: false };
		if (switching || fill.current.done || fill.current.failures >= 2 || fill.current.tries >= 40) return undefined;
		if (!transcriptHasMore || transcriptFetching) return undefined;
		const slot = turnsSlot;
		const timer = setTimeout(() => {
			fill.current.tries += 1;
			void fetchMoreTranscript(slot).then((result) => {
				if (fill.current.slot !== slot) return;
				if (result === "done") fill.current.done = true;
				else if (result === "error" || result === "refreshed") fill.current.failures += 1;
			});
		}, FILL_DELAY);
		return () => clearTimeout(timer);
	}, [switching, transcriptHasMore, transcriptFetching, turnsSlot]);
	// A jump to a message of another chat ("View source", an answer's sources): the chat is opened first, then the
	// message is looked for in the loaded items. Older pages keep filling in by themselves, so a message that is not
	// loaded yet is waited for (bounded); a message that is not on the chat's current branch is reported, not guessed.
	const [revealTick, setRevealTick] = useState(0);
	useEffect(() => {
		const onReveal = (event) => {
			const detail = event.detail || {};
			restore.current = null;
			revealWant.current = { path: detail.path, entryId: detail.entryId, until: Date.now() + 15_000 };
			setRevealTick((tick) => tick + 1);
		};
		window.addEventListener(REVEAL_ENTRY_EVENT, onReveal);
		return () => window.removeEventListener(REVEAL_ENTRY_EVENT, onReveal);
	}, []);
	const shownFile = snap?.session?.file || "";
	useEffect(() => {
		const want = revealWant.current;
		if (!want || switching || items.length === 0) return undefined;
		const norm = (path) => String(path || "").replace(/\\/g, "/").toLowerCase();
		if (norm(shownFile) !== norm(want.path)) return undefined;
		if (!want.entryId) {
			revealWant.current = null;
			return undefined;
		}
		const target = turnKeyForEntry(items, want.entryId);
		if (!target) {
			if (transcriptHasMore && Date.now() < want.until) {
				const timer = setTimeout(() => setRevealTick((tick) => tick + 1), 600);
				return () => clearTimeout(timer);
			}
			revealWant.current = null;
			toast(t("That message is not on this chat's current branch any more."), "info", 4000);
			return undefined;
		}
		revealWant.current = null;
		revealAll();
		let frames = 0;
		let frame = 0;
		const attempt = () => {
			frame = 0;
			void revealEntryIn(content.current, target).then((done) => {
				if (!done && ++frames < 30) frame = requestAnimationFrame(attempt);
			});
		};
		frame = requestAnimationFrame(attempt);
		return () => frame && cancelAnimationFrame(frame);
	}, [revealTick, items, switching, shownFile, transcriptHasMore]);
	// The cold-load preview is replaced by the first full build here: the height taken before the swap shifts the scroll
	// by exactly the growth above the reader, so what they were reading stays where it is.
	useLayoutEffect(() => {
		if (!swapHeight.current || !scroller.current) return;
		const delta = scroller.current.scrollHeight - swapHeight.current;
		swapHeight.current = 0;
		if (!stick.current && delta) {
			scroller.current.scrollTop += delta;
			lastTop.current = scroller.current.scrollTop;
		}
	}, [turns]);
	useLayoutEffect(() => {
		if (restore.current) applyRestore();
	});
	useEffect(() => () => clearTimeout(restoreTimer.current), []);
	// A task-end notification was clicked (store.openChatAtLastTurn): once that chat's turns are on screen, the start of
	// its last turn (the message that began the final reply) goes to the top with the message index's air above it. It
	// runs after the bottom pin of the same commit and lets go of the bottom, so neither the follow nor a later stream
	// update pulls the view back down; a commit record after the last turn keeps the end of the chat in view instead.
	// A landing that could only reach the loaded part of a last turn longer than one transcript page: when older pages
	// bring that turn's own message, the view glides up to it.
	const landingWait = useRef(null);
	const LAND_AIR = 14;
	useLayoutEffect(() => {
		const el = scroller.current;
		const wait = landingWait.current;
		if (wait && el) {
			const target = turns[lastTurnIndex];
			if (wait.slot !== turnsSlot || Date.now() > wait.until) landingWait.current = null;
			else if (target?.user) {
				landingWait.current = null;
				const node = content.current?.querySelector(":scope > section.turn[data-last-turn]");
				if (node) {
					// Placed in the same commit that brings the message: the only movement is the turn's newly loaded start.
					el.scrollTop = Math.max(0, offsetInScroller(el, node) - LAND_AIR);
					lastTop.current = el.scrollTop;
					anchor.current = { offset: Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top), until: Date.now() + 10_000 };
				}
			}
		}
		const want = landing;
		if (!want || !el || want.slot !== turnsSlot || switching) return;
		// A chat that waits for a confirmation or an answer (store.openChatAtBottom) opens at its end, where the live turn
		// shows what it waits for: the place the reader left it at is not restored, and is not wanted afterwards either.
		if (want.bottom) {
			settleLanding(want.nonce);
			clearTimeout(restoreTimer.current);
			restore.current = null;
			anchor.current = null;
			landingWait.current = null;
			holdPlace.current = false;
			stick.current = true;
			rememberPlace(session, { stick: true });
			toBottom(want.smooth);
			return;
		}
		if (turns.length === 0) return;
		const commitAfter = turns.slice(lastTurnIndex + 1).some((turn) => turn.standalone?.kind === "gitRepair" || turn.standalone?.kind === "gitStatus");
		if (Date.now() > want.until || lastTurnIndex < 0 || commitAfter) { settleLanding(want.nonce); return; }
		const node = content.current?.querySelector(":scope > section.turn[data-last-turn]");
		if (!node) { revealAll(); return; }
		settleLanding(want.nonce);
		restore.current = null;
		cancelAnimationFrame(bottomFrame.current);
		bottomFrame.current = 0;
		stick.current = false;
		holdPlace.current = false;
		programmatic.current = false;
		const partial = !turns[lastTurnIndex].user && transcriptHasMore;
		if (partial) landingWait.current = { slot: turnsSlot, until: want.until };
		if (want.smooth) {
			void scrollToNode(node);
			return;
		}
		el.scrollTop = Math.max(0, offsetInScroller(el, node) - LAND_AIR);
		lastTop.current = el.scrollTop;
		anchor.current = { offset: Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top), until: Date.now() + 10_000, userless: partial };
		scheduleMeasure();
	}, [landing, turnsSlot, switching, turns, lastTurnIndex, transcriptHasMore]);
	const waiting = dialogs.length > 0 && active;
	const compacting = !!compaction || !!snap?.flags?.compacting;
	const liveBash = order.map((id) => userBash[id]).filter((entry) => entry && entry.status === "running");
	const empty = turns.length === 0 && liveBash.length === 0;

	return html`<div class="transcript-wrap">
		<div class="transcript" ref=${scroller} onScroll=${onScroll} onWheel=${noteInteraction} onClickCapture=${holdOnOpen} onMouseDown=${noteInteraction} onKeyDown=${noteInteraction}>
			<div class="transcript-inner" ref=${content}>
				${switching?.fresh && !switching.error ? html`<${Welcome} snap=${snap} models=${models} opening=${true} />` : switching ? html`<div class="switch-placeholder" role="status" aria-live="polite" aria-busy=${!switching.error}>
					${switching.name ? html`<h2>${switching.name}</h2>` : null}
					${switching.error ? html`<p>${switching.error}</p><button class="btn sm" onClick=${retrySwitch}>${t("Retry")}</button>` : html`<span class="dim">${t("Loading…")}</span><div class="switch-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>`}
				</div>` : empty ? html`<${Welcome} snap=${snap} models=${models} />` : null}
				${(switching ? [] : rendered).map((turn, i) => {
					const index = renderedStart + i;
					if (turn.standalone) return html`<${Standalone} key=${turn.key} item=${turn.standalone} task=${turn.key === liveRepairKey ? repairTask : undefined} snap=${snap} runs=${runs} processDefault=${processDefault} />`;
					const isLast = index === lastTurnIndex;
					// A manual compaction runs after the last turn ended: that turn keeps its finished look.
					const live = isLast && active && !repairing && compaction?.reason !== "manual";
					// A message the server has not confirmed yet has no run state to wait for: its turn already shows the
					// same working row a live run does, so the reply side is never blank while the request is on its way.
					// Nothing else is faked: the row ends when the real run takes over (or the message is rejected).
					const awaiting = !live && isLast && !turn.final && !turn.steps?.length && !!turn.user?.pending;
					const working = live || awaiting;
					const run = working ? undefined : runForTurn(turn, runs, turns[index + 1]);
					return html`<${TurnView} key=${turn.key} turn=${turn} isLast=${isLast} live=${working} waiting=${live && waiting} run=${run} cwd=${cwd} processDefault=${processDefault} snapRun=${live ? snap?.run : undefined} compacting=${live && compacting} interrupted=${interruptedByNext(turn, turns[index + 1])} />`;
				})}
				${(switching ? [] : liveBash).map((entry) => html`<${BashCard} key=${entry.id} item=${entry} />`)}
				${!switching && gitTask && !repairing ? html`<${GitRecord} task=${gitTask} />` : null}
				<div class="transcript-end" />
			</div>
		</div>
		${!switching && !empty ? html`<${MessageRail} turns=${railTurns} contentRef=${content} onReveal=${revealAll} />` : null}
		${jump.mounted ? html`<button class=${`jump-btn ${away ? "" : "leaving"}`} onClick=${() => { stick.current = true; toBottom(true); }} title=${active ? t("Follow live output") : t("Jump to latest")} aria-label=${active ? t("Follow live output") : t("Jump to latest")}><${Icon} name="arrowDown" size=${16} /></button>` : null}
	</div>`;
}
