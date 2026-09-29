// Transcript model: wire items -> turns, with tool calls translated into plain-language actions.
// Three information layers: turn summary -> readable steps -> raw tool details.
import { basename, clip, firstLine, plural, shellOutcome, shortPath } from "./util.js";

const TENSES = {
	read: ["Reading", "Read", "read"],
	list: ["Listing", "Listed", "list"],
	find: ["Finding files", "Found files", "find files"],
	search: ["Searching", "Searched", "search"],
	run: ["Running", "Ran", "run"],
	edit: ["Editing", "Edited", "edit"],
	write: ["Writing", "Wrote", "write"],
	web: ["Searching the web", "Searched the web", "search the web"],
	fetch: ["Reading page", "Read page", "read the page"],
	agent: ["Delegating", "Delegated", "delegate"],
	tool: ["Using", "Used", "use"],
};

function str(v) {
	return typeof v === "string" ? v : v == null ? "" : String(v);
}

function countPatch(patch) {
	let add = 0;
	let del = 0;
	let inHunk = false;
	for (const line of String(patch || "").split("\n")) {
		if (line.startsWith("@@")) inHunk = true;
		else if (inHunk && line.startsWith("+")) add++;
		else if (inHunk && line.startsWith("-")) del++;
	}
	return { add, del };
}

/** Classify one tool call and produce human wording. */
export function describeAction(call, result, run, cwd) {
	const args = (call.args && typeof call.args === "object" ? call.args : run?.args) || {};
	const name = call.name;
	let kind = "tool";
	let target = "";
	let detail = "";
	let path;
	let extra;
	switch (name) {
		case "read": {
			kind = "read";
			path = str(args.path || args.file_path);
			target = shortPath(path, cwd);
			if (args.offset || args.limit) detail = `lines ${args.offset || 1}–${(args.offset || 1) + (args.limit || 0) - 1}`;
			break;
		}
		case "ls":
			kind = "list";
			path = str(args.path || ".");
			target = shortPath(path, cwd) || ".";
			break;
		case "find":
			kind = "find";
			target = str(args.pattern || args.glob || args.name || "");
			detail = args.path ? `in ${shortPath(str(args.path), cwd)}` : "";
			break;
		case "grep":
			kind = "search";
			target = str(args.pattern || args.query || "");
			detail = args.path ? `in ${shortPath(str(args.path), cwd)}` : args.glob ? `in ${args.glob}` : "";
			break;
		case "symbols":
			kind = "search";
			target = str(args.query || args.symbol || args.name || args.path || args.action || "code symbols");
			detail = "symbols";
			break;
		case "bash":
		case "pwsh":
			kind = "run";
			target = clip(firstLine(str(args.command)), 120);
			detail = name === "pwsh" ? "PowerShell" : "";
			break;
		case "edit": {
			kind = "edit";
			path = str(args.path || args.file_path);
			target = shortPath(path, cwd);
			const patch = result?.details?.patch || result?.details?.diff;
			if (patch) {
				const c = countPatch(result.details.patch || "");
				extra = { additions: c.add, deletions: c.del };
			}
			break;
		}
		case "write": {
			kind = "write";
			path = str(args.path || args.file_path);
			target = shortPath(path, cwd);
			const lines = str(args.content).split("\n").length;
			detail = `${lines} line${lines === 1 ? "" : "s"}`;
			break;
		}
		case "web_search":
			kind = "web";
			target = Array.isArray(args.queries) ? args.queries.join(" · ") : str(args.query || args.q);
			break;
		case "web_fetch":
			kind = "fetch";
			target = Array.isArray(args.urls) ? args.urls.join(" · ") : str(args.url);
			break;
		case "agent":
			kind = "agent";
			target = clip(firstLine(str(args.task || args.prompt || args.description || (Array.isArray(args.tasks) ? args.tasks.map((t) => t.task || t.prompt || "").join(" · ") : ""))), 120);
			break;
		case "workflow":
		case "ultracode":
			kind = "agent";
			target = clip(firstLine(str(args.task || args.title || args.goal || name)), 120);
			detail = name;
			break;
		case "github":
			kind = "web";
			target = `${str(args.method || "GET")} ${str(args.path || args.url || args.query || "")}`.trim();
			detail = "GitHub";
			break;
		default: {
			kind = "tool";
			const first = Object.values(args).find((v) => typeof v === "string");
			target = first ? clip(firstLine(first), 100) : "";
			detail = name;
		}
	}
	const shell = kind === "run" && result ? shellOutcome(result) : null;
	const isError = shell === "cancelled" ? false : result ? result.isError : run?.status === "error";
	const status = shell === "cancelled" ? "cancelled" : result ? (result.isError ? "error" : "done") : run?.status === "running" ? "running" : run?.status || "pending";
	const [ing, past, base] = TENSES[kind] || TENSES.tool;
	const verb = status === "running" || status === "pending" ? ing : shell === "cancelled" ? "Stopped" : shell === "timeout" ? `Timed out: ${base}` : isError ? `Failed to ${base}` : past;
	return { kind, verb, target, detail, path, extra, status, isError: !!isError };
}

/** Group phrase for several actions of the same kind. */
export function groupLabel(kind, actions) {
	const running = actions.some((a) => a.status === "running" || a.status === "pending");
	const n = actions.length;
	const distinct = (arr) => new Set(arr.filter(Boolean)).size || n;
	switch (kind) {
		case "read":
			return `${running ? "Reading" : "Read"} ${plural(distinct(actions.map((a) => a.path)), "file")}`;
		case "list":
			return `${running ? "Listing" : "Listed"} ${plural(n, "folder")}`;
		case "find":
			return `${running ? "Finding" : "Found"} files (${plural(n, "search", "searches")})`;
		case "search":
			return `${running ? "Searching" : "Searched"} ${plural(n, "time")}`;
		case "run":
			return `${running ? "Running" : "Ran"} ${plural(n, "command")}`;
		case "edit":
			return `${running ? "Editing" : "Edited"} ${plural(distinct(actions.map((a) => a.path)), "file")}`;
		case "write":
			return `${running ? "Writing" : "Wrote"} ${plural(distinct(actions.map((a) => a.path)), "file")}`;
		case "web":
			return `${running ? "Searching" : "Searched"} the web ${plural(n, "time")}`;
		case "fetch":
			return `${running ? "Reading" : "Read"} ${plural(n, "web page")}`;
		case "agent":
			return `${running ? "Delegating" : "Delegated"} ${plural(n, "task")}`;
		default:
			return `${running ? "Using" : "Used"} ${plural(n, "tool")}`;
	}
}

function textFromBlocks(blocks) {
	return blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
}

/**
 * Build turns from wire items.
 * ctx: { cwd, toolRuns, running, lastKey }
 */
export function buildTurns(items, ctx, previous) {
	const results = new Map();
	for (const item of items) if (item.kind === "toolResult") results.set(item.toolCallId, item);

	const turns = [];
	let turn = null;
	const standalone = (item, index) => {
		turns.push({ key: `s-${item.id || index}-${item.kind}`, standalone: item, entries: [], steps: [] });
	};
	const startTurn = (user, index) => {
		turn = {
			key: `t-${user?.id || user?.ts || index}-${index}`,
			user,
			steps: [],
			final: null,
			assistants: [],
			startedAt: user?.ts,
			endedAt: user?.ts,
			items: [],
			index,
		};
		turns.push(turn);
	};

	items.forEach((item, index) => {
		if (item.kind === "user") {
			startTurn(item, index);
			turn.items.push(item);
			return;
		}
		if (item.kind === "bash" || item.kind === "compaction" || item.kind === "branchSummary" || item.kind === "reload") {
			turn = null;
			standalone(item, index);
			return;
		}
		if (item.kind === "custom") {
			if (!item.display) return;
			if (turn) {
				turn.steps.push({ type: "custom", item, key: `c-${index}` });
				turn.items.push(item);
			} else {
				standalone(item, index);
			}
			return;
		}
		if (!turn) startTurn(null, index);
		turn.items.push(item);
		turn.endedAt = Math.max(turn.endedAt || 0, item.ts || 0);
		if (item.kind === "assistant") turn.assistants.push(item);
	});

	for (const t of turns) {
		if (t.standalone) continue;
		const list = t.assistants;
		const lastAssistant = list[list.length - 1];
		for (let ai = 0; ai < list.length; ai++) {
			const message = list[ai];
			const isLast = ai === list.length - 1;
			const hasCalls = message.blocks.some((b) => b.type === "toolCall");
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			const finalText = isLast && !hasCalls ? textFromBlocks(message.blocks) : "";
			message.blocks.forEach((block, bi) => {
				const key = `${message.liveId || message.id || message.ts}-${bi}`;
				if (block.type === "thinking") {
					t.steps.push({ type: "thinking", text: block.text, redacted: block.redacted, key, live: !message.final && !!message.liveId && isLast && bi === message.blocks.length - 1 });
				} else if (block.type === "text") {
					if (finalText && block.text.trim()) return; // shown as the final answer
					if (block.text.trim()) t.steps.push({ type: "note", text: block.text, key, streaming: !message.final && !!message.liveId });
				} else if (block.type === "toolCall") {
					const result = results.get(block.id);
					const run = ctx.toolRuns[block.id];
					const call = { id: block.id, name: block.name, args: block.args };
					const described = describeAction(call, result, run, ctx.cwd);
					const failedByAbort = !result && failed && !(run?.status === "running");
					t.steps.push({
						type: "action",
						key: `a-${block.id}`,
						call,
						result,
						run,
						...described,
						status: failedByAbort ? "cancelled" : described.status,
						startedAt: run?.startedAt || message.ts,
						endedAt: result?.ts || run?.endedAt,
					});
				}
			});
			if (finalText.trim() && !failed) {
				t.final = { text: finalText, message, streaming: !message.final && !!message.liveId };
			} else if (isLast && failed) {
				const partial = textFromBlocks(message.blocks);
				if (partial.trim() && !hasCalls) t.final = { text: partial, message, partial: true };
				t.error = { message: message.error || (message.stopReason === "aborted" ? "Stopped before finishing." : "The model request failed."), stopReason: message.stopReason };
			}
		}
		t.lastAssistant = lastAssistant;
		const actions = t.steps.filter((s) => s.type === "action");
		t.stats = {
			actions: actions.length,
			failedActions: actions.filter((a) => a.isError).length,
			files: new Set(actions.filter((a) => (a.kind === "edit" || a.kind === "write") && !a.isError && a.status === "done" && a.path).map((a) => a.path)).size,
			commands: actions.filter((a) => a.kind === "run").length,
			reads: actions.filter((a) => a.kind === "read").length,
		};
	}

	// Reuse previous objects where nothing changed so memoized components can skip rendering.
	if (previous) {
		const prevByKey = new Map(previous.map((t) => [t.key, t]));
		return turns.map((t) => {
			const old = prevByKey.get(t.key);
			return old && sameTurn(old, t) ? old : t;
		});
	}
	return turns;
}

function sameTurn(a, b) {
	if (a.standalone || b.standalone) return a.standalone === b.standalone;
	if (a.items.length !== b.items.length) return false;
	for (let i = 0; i < a.items.length; i++) if (a.items[i] !== b.items[i]) return false;
	// Running tool state lives outside items.
	for (let i = 0; i < a.steps.length; i++) {
		const sa = a.steps[i];
		const sb = b.steps[i];
		if (sa.type === "action" && (sa.status !== sb.status || sa.run !== sb.run)) return false;
	}
	return true;
}

/** Aggregate consecutive actions of one kind into groups (thinking/notes stay separate). */
export function groupSteps(steps) {
	const out = [];
	for (const step of steps) {
		if (step.type === "action") {
			const last = out[out.length - 1];
			if (last && last.type === "group" && last.kind === step.kind) {
				last.actions.push(step);
				continue;
			}
			out.push({ type: "group", kind: step.kind, actions: [step], key: `g-${step.key}` });
		} else {
			out.push(step);
		}
	}
	return out;
}

export const OUTCOME_LABEL = {
	running: "Working",
	waiting: "Waiting for you",
	completed: "Completed",
	partial: "Partially completed",
	failed: "Failed",
	cancelled: "Cancelled",
	unanswered: "No response",
};

/** Match a run_finished record to a turn: the newest turn that started at or before the run. */
export function runForTurn(turn, runs, isLast, latestRun) {
	if (!turn.startedAt) return undefined;
	let best;
	for (const run of Object.values(runs)) {
		if (!run.startedAt) continue;
		if (run.startedAt + 3000 < turn.startedAt) continue;
		if (turn.endedAt && run.startedAt > turn.endedAt + 5000) continue;
		if (!best || run.startedAt > best.startedAt) best = run;
	}
	void isLast;
	void latestRun;
	return best;
}

export function turnOutcome(turn, { run, live, waiting }) {
	if (waiting) return "waiting";
	if (live) return "running";
	if (run) return run.outcome;
	if (!turn.lastAssistant) return turn.user ? "unanswered" : "completed";
	const stop = turn.lastAssistant.stopReason;
	if (stop === "aborted") return "cancelled";
	if (stop === "error") return turn.stats.files > 0 ? "partial" : "failed";
	return "completed";
}

export function turnDuration(turn, run) {
	if (run?.startedAt && run?.endedAt) return run.endedAt - run.startedAt;
	if (turn.startedAt && turn.endedAt && turn.endedAt > turn.startedAt) return turn.endedAt - turn.startedAt;
	return 0;
}

export function actionTitle(step) {
	const parts = [step.verb];
	if (step.target) parts.push(step.kind === "run" ? "`" + step.target + "`" : step.target);
	return parts.join(" ");
}

export { basename };
