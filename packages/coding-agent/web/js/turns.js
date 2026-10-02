// Transcript model: wire items -> turns, with tool calls translated into plain-language actions.
// Three information layers: turn summary -> readable steps -> raw tool details.
import { N_, count, t } from "./i18n.js";
import { basename, clip, firstLine, shellOutcome, shortPath } from "./util.js";

const TENSES = {
	read: [N_("Reading"), N_("Read"), N_("read")],
	list: [N_("Listing"), N_("Listed"), N_("list")],
	find: [N_("Finding files"), N_("Found files"), N_("find files")],
	search: [N_("Searching"), N_("Searched"), N_("search")],
	run: [N_("Running"), N_("Ran"), N_("run")],
	edit: [N_("Editing"), N_("Edited"), N_("edit")],
	write: [N_("Writing"), N_("Wrote"), N_("write")],
	web: [N_("Searching the web"), N_("Searched the web"), N_("search the web")],
	fetch: [N_("Reading page"), N_("Read page"), N_("read the page")],
	github: [N_("Querying GitHub"), N_("Queried GitHub"), N_("query GitHub")],
	agent: [N_("Delegating"), N_("Delegated"), N_("delegate")],
	tool: [N_("Using"), N_("Used"), N_("use")],
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
	let web;
	switch (name) {
		case "read": {
			kind = "read";
			path = str(args.path || args.file_path);
			target = shortPath(path, cwd);
			if (args.offset || args.limit) detail = t("lines {from}–{to}", { from: args.offset || 1, to: (args.offset || 1) + (args.limit || 0) - 1 });
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
			detail = args.path ? t("in {path}", { path: shortPath(str(args.path), cwd) }) : "";
			break;
		case "grep":
			kind = "search";
			target = str(args.pattern || args.query || "");
			detail = args.path ? t("in {path}", { path: shortPath(str(args.path), cwd) }) : args.glob ? t("in {path}", { path: args.glob }) : "";
			break;
		case "symbols":
			kind = "search";
			target = str(args.query || args.symbol || args.name || args.path || args.action || t("code symbols"));
			detail = t("symbols");
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
			const details = result ? result.details : run?.partialDetails;
			const patch = details?.patch || details?.diff;
			if (patch) {
				const c = countPatch(patch);
				extra = { additions: c.add, deletions: c.del };
			}
			break;
		}
		case "write": {
			kind = "write";
			path = str(args.path || args.file_path);
			target = shortPath(path, cwd);
			// The lines this write really added and removed (the tool counts them against the file as it was just before).
			// Running counts describe the validated change set; a failed result must not retain that preview.
			const d = result ? result.details : run?.partialDetails;
			if (Number.isFinite(d?.additions) && Number.isFinite(d?.deletions)) extra = { additions: d.additions, deletions: d.deletions };
			break;
		}
		case "web_search":
			kind = "web";
			target = Array.isArray(args.queries) ? args.queries.join(" · ") : str(args.query || args.q);
			web = webCounts(name, result?.details);
			break;
		case "web_fetch":
			kind = "fetch";
			target = Array.isArray(args.urls) ? args.urls.join(" · ") : str(args.url);
			web = webCounts(name, result?.details);
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
			kind = "github";
			target = `${str(args.method || "GET")} ${str(args.path || args.url || args.query || "")}`.trim();
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
	const [ing, past, base] = (TENSES[kind] || TENSES.tool).map((word) => t(word));
	const verb = status === "running" || status === "pending" ? ing : shell === "cancelled" ? t("Stopped") : shell === "timeout" ? t("Timed out: {action}", { action: base }) : isError ? t("Failed to {action}", { action: base }) : past;
	return { kind, verb, target, detail, path, extra, web, status, isError: !!isError };
}

/**
 * What one finished web_search / web_fetch call really did, read from its result: whether it was a round of searching, how
 * many results the search returned (after merging the engines) and how many pages it opened. Nothing while it still runs.
 */
function webCounts(name, details) {
	if (!details) return undefined;
	return {
		search: name === "web_search",
		returned: name === "web_search" ? (details.results?.length ?? 0) : 0,
		opened: details.pages?.length ?? 0,
	};
}

/** The three numbers behind a group of web steps: rounds of searching, results returned, pages opened (finished calls only). */
export function webStats(actions) {
	let rounds = 0;
	let returned = 0;
	let opened = 0;
	for (const action of actions) {
		if (action.call.name === "web_search") rounds++;
		if (!action.web) continue;
		returned += action.web.returned;
		opened += action.web.opened;
	}
	return { rounds, returned, opened };
}

/** Sum only reported counts; pending calls must not hide counts already received. */
export function changeTotals(actions) {
	let sum;
	for (const action of actions) {
		if (!action.extra) continue;
		sum ??= { additions: 0, deletions: 0 };
		sum.additions += action.extra.additions;
		sum.deletions += action.extra.deletions;
	}
	return sum;
}

/** Group phrase for several actions of the same kind. */
export function groupLabel(kind, actions) {
	const running = actions.some((a) => a.status === "running" || a.status === "pending");
	const n = actions.length;
	const distinct = (arr) => new Set(arr.filter(Boolean)).size || n;
	const pick = (doing, done, params) => t(running ? doing : done, params);
	switch (kind) {
		case "read":
			return pick(N_("Reading {files}"), N_("Read {files}"), { files: count(distinct(actions.map((a) => a.path)), "file") });
		case "list":
			return pick(N_("Listing {folders}"), N_("Listed {folders}"), { folders: count(n, "folder") });
		case "find":
			return pick(N_("Finding files ({searches})"), N_("Found files ({searches})"), { searches: count(n, "search", "searches") });
		case "search":
			return pick(N_("Searching {times}"), N_("Searched {times}"), { times: count(n, "time") });
		case "run":
			return pick(N_("Running {commands}"), N_("Ran {commands}"), { commands: count(n, "command") });
		case "edit":
			return pick(N_("Editing {files}"), N_("Edited {files}"), { files: count(distinct(actions.map((a) => a.path)), "file") });
		case "write":
			return pick(N_("Writing {files}"), N_("Wrote {files}"), { files: count(distinct(actions.map((a) => a.path)), "file") });
		case "web": {
			// One line for everything the agent did on the web: rounds of searching, results returned, pages opened.
			if (running) return t("Searching the web");
			const { rounds, returned, opened } = webStats(actions);
			if (!rounds) return t("Opened {pages}", { pages: count(opened, "web page") });
			return [count(rounds, "search round"), t("{count} returned", { count: count(returned, "result") }), t("{count} opened", { count: count(opened, "page") })].join(" · ");
		}
		case "github":
			return pick(N_("Querying GitHub {times}"), N_("Queried GitHub {times}"), { times: count(n, "time") });
		case "agent":
			return pick(N_("Delegating {tasks}"), N_("Delegated {tasks}"), { tasks: count(n, "task") });
		default:
			return pick(N_("Using {tools}"), N_("Used {tools}"), { tools: count(n, "tool") });
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
export function buildTurns(items, ctx = { toolRuns: {} }, previous) {
	const results = new Map();
	for (const item of items) if (item.kind === "toolResult") results.set(item.toolCallId, item);

	const turns = [];
	let turn = null;
	let repair;
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
		if (item.kind === "custom" && item.customType === "git-commit-repair" && !item.display) {
			turn = null;
			repair = { kind: "gitRepair", id: item.id || item.ts || index, ts: item.ts, items: [] };
			standalone(repair, index);
			return;
		}
		if (repair) {
			if (item.kind === "gitStatus" || item.kind === "user") {
				const record = turns[turns.length - 1];
				if (item.kind === "gitStatus") {
					record.standalone = { ...item, repairTurns: buildTurns(repair.items, ctx) };
					repair = undefined;
					return;
				}
				repair.turns = buildTurns(repair.items, ctx);
				repair = undefined;
			} else {
				repair.items.push(item);
				return;
			}
		}
		if (item.kind === "user") {
			startTurn(item, index);
			turn.items.push(item);
			return;
		}
		if (item.kind === "gitStatus" || item.kind === "bash" || item.kind === "compaction" || item.kind === "branchSummary" || item.kind === "reload") {
			turn = null;
			standalone(item, index);
			return;
		}
		if (item.kind === "runChanges") {
			// What a finished task changed belongs to the turn it ends: its card stays under that turn's reply.
			if (turn) {
				turn.changes = item;
				turn.items.push(item);
			} else standalone(item, index);
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

	if (repair) repair.turns = buildTurns(repair.items, ctx);

	for (const turn of turns) {
		if (turn.standalone) continue;
		const list = turn.assistants;
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
					const live = !message.final && !!message.liveId && isLast && bi === message.blocks.length - 1;
					const text = block.text?.trim() ? block.text : "";
					// A thinking block without text carries nothing to read (the model kept its reasoning private).
					if (!text && !block.redacted && !live) return;
					const before = turn.steps[turn.steps.length - 1];
					if (before?.type === "thinking") {
						// Several thinking blocks in a row are one stretch of reasoning: show them as one row.
						before.text = [before.text, text].filter(Boolean).join("\n\n");
						before.live = live;
						before.redacted = before.redacted && !before.text;
						return;
					}
					turn.steps.push({ type: "thinking", text, redacted: block.redacted, key, live });
				} else if (block.type === "text") {
					if (finalText && block.text.trim()) return; // shown as the final answer
					if (block.text.trim()) turn.steps.push({ type: "note", text: block.text, key, streaming: !message.final && !!message.liveId });
				} else if (block.type === "toolCall") {
					const result = results.get(block.id);
					const run = ctx.toolRuns[block.id];
					const call = { id: block.id, name: block.name, args: block.args };
					const described = describeAction(call, result, run, ctx.cwd);
					const failedByAbort = !result && failed && !(run?.status === "running");
					turn.steps.push({
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
				turn.final = { text: finalText, message, streaming: !message.final && !!message.liveId };
			} else if (isLast && failed) {
				const partial = textFromBlocks(message.blocks);
				if (partial.trim() && !hasCalls) turn.final = { text: partial, message, partial: true };
				turn.error = { message: message.error || (message.stopReason === "aborted" ? t("Stopped before finishing.") : t("The model request failed.")), stopReason: message.stopReason };
			}
		}
		turn.lastAssistant = lastAssistant;
		const stats = { actions: 0, failedActions: 0, files: 0, commands: 0, reads: 0 };
		const files = new Set();
		for (const action of turn.steps) {
			if (action.type !== "action") continue;
			stats.actions++;
			if (action.isError) stats.failedActions++;
			if ((action.kind === "edit" || action.kind === "write") && !action.isError && action.status === "done" && action.path) files.add(action.path);
			if (action.kind === "run") stats.commands++;
			if (action.kind === "read") stats.reads++;
		}
		stats.files = files.size;
		turn.stats = stats;
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

/** Kinds that are shown as one: reading a page is part of searching the web. */
const GROUP_KIND = { fetch: "web" };

/** Aggregate consecutive actions of one kind into groups (thinking/notes stay separate). */
export function groupSteps(steps) {
	const out = [];
	for (const step of steps) {
		if (step.type === "action") {
			const kind = GROUP_KIND[step.kind] || step.kind;
			const last = out[out.length - 1];
			if (last && last.type === "group" && last.kind === kind) {
				last.actions.push(step);
				continue;
			}
			out.push({ type: "group", kind, actions: [step], key: `g-${step.key}` });
		} else {
			out.push(step);
		}
	}
	return out;
}

export const OUTCOME_LABEL = {
	running: N_("Working"),
	waiting: N_("Waiting for you"),
	completed: N_("Completed"),
	partial: N_("Partially completed"),
	failed: N_("Failed"),
	cancelled: N_("Cancelled"),
	unanswered: N_("No response"),
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
