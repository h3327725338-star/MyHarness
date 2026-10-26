// Transcript model: wire items -> turns, with tool calls translated into plain-language actions.
// Three information layers: turn summary -> readable steps -> raw tool details.
import { yieldToMain } from "./scheduling.js";
import { N_, count, getLang, t } from "./i18n.js";
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
	mail: [N_("Using mail"), N_("Used mail"), N_("use mail")],
	agent: [N_("Delegating"), N_("Delegated"), N_("delegate")],
	history: [N_("Looking through earlier chats"), N_("Looked through earlier chats"), N_("look through earlier chats")],
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

/** The files one patch names (added, deleted, updated or moved to), in patch order, without repeats. */
function patchPaths(patch) {
	const paths = [];
	for (const line of String(patch || "").split(/\r?\n/)) {
		const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
		const file = match?.[1].trim();
		if (file && !paths.includes(file)) paths.push(file);
	}
	return paths;
}

/** Classify one tool call and produce human wording. */
export function describeAction(call, result, run, cwd) {
	const args = (call.args && typeof call.args === "object" ? call.args : run?.args) || {};
	const name = call.name;
	let kind = "tool";
	let target = "";
	let detail = "";
	let path;
	let paths;
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
			target = str(
				args.query ||
					args.intent ||
					args.symbol ||
					args.name ||
					args.target?.name ||
					args.target?.path ||
					args.path ||
					args.action ||
					t("code symbols"),
			);
			detail = t("symbols");
			break;
		case "apply_rename": {
			// The plan names its files only in the result: the step lists them once the rename is written.
			kind = "edit";
			const details = result ? result.details : run?.partialDetails;
			const files = Array.isArray(details?.files) ? details.files : [];
			paths = files.map((file) => str(file.path)).filter(Boolean);
			path = paths.length === 1 ? paths[0] : undefined;
			target = paths.length > 0 ? paths.map((file) => shortPath(file, cwd)).join(" · ") : str(args.planId);
			if (files.length > 0) {
				extra = {
					additions: files.reduce((sum, file) => sum + (file.linesAdded || 0), 0),
					deletions: files.reduce((sum, file) => sum + (file.linesRemoved || 0), 0),
				};
			}
			break;
		}
		case "bash":
		case "pwsh":
			kind = "run";
			target = clip(firstLine(str(args.command)), 120);
			detail = name === "pwsh" ? "PowerShell" : "";
			break;
		case "job_list":
			kind = "list";
			target = t("background jobs");
			detail = "job_list";
			break;
		case "job_output":
			kind = "run";
			target = str(args.taskId || "");
			detail = "job_output";
			break;
		case "job_kill":
			kind = "run";
			target = str(args.taskId || "");
			detail = "job_kill";
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
		case "apply_patch": {
			// One patch can touch several files: the step names all of them and counts the lines of every file.
			kind = "edit";
			paths = patchPaths(args.patch);
			path = paths.length === 1 ? paths[0] : undefined;
			target = paths.map((file) => shortPath(file, cwd)).join(" · ");
			const details = result ? result.details : run?.partialDetails;
			if (Array.isArray(details?.files)) {
				extra = {
					additions: details.files.reduce((sum, file) => sum + (file.linesAdded || 0), 0),
					deletions: details.files.reduce((sum, file) => sum + (file.linesRemoved || 0), 0),
				};
			}
			break;
		}
		case "write": {
			kind = "write";
			path = str(args.path || args.file_path);
			target = shortPath(path, cwd);
			// The lines this write really added and removed, counted by the tool against the file as it was. Only real
			// diff data reaches the status bar; a failed result must not retain any count.
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
		case "ask_user_question": {
			const first = Array.isArray(args.questions) ? args.questions[0] : undefined;
			target = clip(firstLine(str(first?.question)), 120);
			detail = name;
			break;
		}
		case "todo_write": {
			const todos = Array.isArray(args.todos) ? args.todos : [];
			target = `${todos.filter((item) => item?.status === "completed").length}/${todos.length}`;
			detail = name;
			break;
		}
		case "session_search":
			kind = "history";
			target = str(args.query) || t("recent chats");
			break;
		case "session_get": {
			kind = "history";
			const source = result?.details?.sources?.[0];
			target = source?.title || str(args.session);
			detail = t("read");
			break;
		}
		case "github":
			kind = "github";
			target = `${str(args.method || "GET")} ${str(args.path || args.url || args.query || "")}`.trim();
			break;
		case "mail":
			kind = "mail";
			target = [str(args.account), `${str(args.method || "GET")} ${str(args.path || "")}`.trim()].filter(Boolean).join(" · ");
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
	if (isError || status === "cancelled") extra = undefined;
	const [ing, past, base] = (TENSES[kind] || TENSES.tool).map((word) => t(word));
	const phase = !result && (kind === "edit" || kind === "write") ? (run?.status === "running" ? "applying" : "generating") : undefined;
	const verb = phase === "generating" ? t("Preparing changes") : phase === "applying" ? t("Applying changes") : status === "running" || status === "pending" ? ing : shell === "cancelled" ? t("Stopped") : shell === "timeout" ? t("Timed out: {action}", { action: base }) : isError ? t("Failed to {action}", { action: base }) : past;
	return { kind, verb, target, detail, path, paths, extra, phase, web, status, isError: !!isError };
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
			if (running) return t(actions.some((a) => a.phase === "applying") ? "Applying changes to {files}" : "Preparing changes for {files}", { files: count(distinct(actions.flatMap((a) => a.paths ?? [a.path])), "file") });
			return pick(N_("Editing {files}"), N_("Edited {files}"), { files: count(distinct(actions.flatMap((a) => a.paths ?? [a.path])), "file") });
		case "write":
			if (running) return t(actions.some((a) => a.phase === "applying") ? "Applying changes to {files}" : "Preparing changes for {files}", { files: count(distinct(actions.map((a) => a.path)), "file") });
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
		case "mail":
			return pick(N_("Using mail {times}"), N_("Used mail {times}"), { times: count(n, "time") });
		case "history":
			return pick(N_("Looking through earlier chats ({times})"), N_("Looked through earlier chats ({times})"), { times: count(n, "time") });
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

/** Probe for tests and lab scripts: every real build counts here, so a cache hit that skips the build is visible. */
export const turnsProbe = { builds: 0 };

/**
 * Turns cache hit check (the cache entry itself lives in the session bag, see store.js). A cached build still
 * describes exactly these items only while every source reference is unchanged: the same items array, the same
 * toolRuns object, the same cwd, and the same UI language (the built rows carry translated verbs). Returns the cached
 * turns on a hit, null when the caller must build.
 */
export function cachedTurns(cache, items, toolRuns, cwd) {
	return cache && cache.items === items && cache.toolRuns === toolRuns && cache.cwd === cwd && cache.lang === getLang() ? cache.turns : null;
}

/**
 * Cold-load tail preview window (P0-1): transcripts longer than a full page — or a full 400-item first page
 * with older items still server-side (`hasMore`) — paint the newest tail first and build the full projection
 * behind it. Returns the slice the synchronous preview build receives, or null when the whole list builds
 * synchronously. The window is the newest 60 items, walked back (at most 120) to a user boundary so a turn
 * is never cut mid-way. Pure function for unit tests.
 */
export function tailPreviewSlice(items, hasMore) {
	if (!(items.length > 400 || (hasMore && items.length > 60))) return null;
	let start = Math.max(0, items.length - 60);
	while (start > Math.max(0, items.length - 120) && items[start]?.kind !== "user") start--;
	return items.slice(start);
}

/**
 * Build turns from wire items.
 * ctx: { cwd, toolRuns, running, lastKey }
 */
export function buildTurns(items, ctx = { toolRuns: {} }, previous) {
	const work = buildTurnsWork(items, ctx, previous);
	let next;
	do { next = work.next(); } while (!next.done);
	return next.value;
}

export async function buildTurnsAsync(items, ctx, previous, cancelled = () => false) {
	const work = buildTurnsWork(items, ctx, previous);
	await yieldToMain();
	while (!cancelled()) {
		const next = work.next();
		if (next.done) return next.value;
		await yieldToMain();
	}
	return null;
}

/**
 * Chunked full-build driver off the shared buildTurnsWork generator: every generator step already spans 60
 * entries/turns/assistant messages (see the yield cadence in buildTurnsWork), so yielding back to the main thread
 * after every step keeps each slice to about 60 items of work. Items and the ctx references (toolRuns/cwd) pass
 * through untouched and `previous` carries the same sameTurn-reuse semantics as buildTurnsAsync, so the
 * cachedTurns triple-reference check keeps working. Resolves null when cancelled() trips.
 */
export async function buildTurnsChunked(items, ctx, previous, cancelled = () => false) {
	const work = buildTurnsWork(items, ctx, previous);
	await yieldToMain();
	while (!cancelled()) {
		const next = work.next();
		if (next.done) return next.value;
		await yieldToMain();
	}
	return null;
}

export function* buildTurnsWork(items, ctx = { toolRuns: {} }, previous) {
	turnsProbe.builds += 1;
	const results = new Map();
	for (let index = 0; index < items.length; index++) {
		if (index && index % 60 === 0) yield;
		const item = items[index];
		if (item.kind === "toolResult") results.set(item.toolCallId, item);
	}

	const turns = [];
	let turn = null;
	let repair;
	// A key identifies its entry, never its position: an older page prepended above or the preview-to-full swap must keep
	// the same key, or Preact remounts the node (the entry animation replays, open folds and the reader's scroll reset).
	// The entry id wins because it is what a reload projects back; ts is the fallback for items the server has not named
	// yet, and the array index only covers items with neither. A live user message takes its id from entry_appended a
	// few milliseconds after it appears (before anything is rendered into the turn), so that one key move stays invisible.
	const standalone = (item, index) => {
		turns.push({ key: `s-${item.id || item.ts || index}-${item.kind}`, standalone: item, entries: [], steps: [] });
	};
	const startTurn = (user, index, first) => {
		turn = {
			key: `t-${user?.id || user?.ts || first?.id || first?.ts || index}`,
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

	const addItem = (item, index) => {
		// Bookmark labels are projected for the HTML export only; the transcript has nothing to draw for them.
		if (item.kind === "label") return;
		// A repair round (a pre-commit check, or CI after a push) is one card holding the turn it started.
		if (item.kind === "custom" && (item.customType === "git-commit-repair" || item.customType === "git-ci-repair") && !item.display) {
			// A new repair round replaces the open one, so close it first: its card keeps the steps that round ran
			// instead of losing them to the accumulator that is about to be dropped.
			if (repair) repair.turns = buildTurns(repair.items, ctx);
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
		if (item.kind === "custom" && item.customType === INTERRUPT_ENTRY) {
			// Written between a run stopped by a message sent with "interrupt" and that message (see interruptedByNext).
			if (turn) turn.interrupted = true;
			return;
		}
		if (item.kind === "custom") {
			if (!item.display) return;
			if (turn) {
				turn.steps.push({ type: "custom", item, key: `c-${item.id || item.ts || index}` });
				turn.items.push(item);
			} else {
				standalone(item, index);
			}
			return;
		}
		if (!turn) startTurn(null, index, item);
		turn.items.push(item);
		turn.endedAt = Math.max(turn.endedAt || 0, item.ts || 0);
		if (item.kind === "assistant") turn.assistants.push(item);
	};

	for (let index = 0; index < items.length; index++) {
		if (index && index % 60 === 0) yield;
		addItem(items[index], index);
	}

	if (repair) repair.turns = buildTurns(repair.items, ctx);

	let processed = 0;
	for (const turn of turns) {
		if (++processed % 60 === 0) yield;
		if (turn.standalone) continue;
		const list = turn.assistants;
		const lastAssistant = list[list.length - 1];
		for (let ai = 0; ai < list.length; ai++) {
			if (ai && ai % 60 === 0) yield;
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
						...(failedByAbort ? { extra: undefined, phase: undefined } : {}),
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
		turn.stats = stepStats(turn.steps);
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

/** What some steps did: actions, failed actions, files changed, commands run and files read. */
export function stepStats(steps) {
	const stats = { actions: 0, failedActions: 0, files: 0, commands: 0, reads: 0 };
	const files = new Set();
	for (const action of steps) {
		if (action.type !== "action") continue;
		stats.actions++;
		if (action.isError) stats.failedActions++;
		if ((action.kind === "edit" || action.kind === "write") && !action.isError && action.status === "done") {
			for (const file of action.paths ?? [action.path]) if (file) files.add(file);
		}
		if (action.kind === "run") stats.commands++;
		if (action.kind === "read") stats.reads++;
	}
	stats.files = files.size;
	return stats;
}

/**
 * A turn in the order it happened: each stretch of reasoning and tool calls is one foldable block, and each text the
 * model wrote between them stays in place as reading text. When the model writes, then reasons or calls tools again, a
 * new block starts below that text. Only the presentation is split: the steps, the run and the session are one piece.
 * The final answer (`turn.final`) is not a segment; it follows the last one.
 * With `fold` (a finished turn whose steps start folded) the texts written along the way go into one block with the
 * work around them, so only the final answer stays as reading text; texts after the last step stay outside when the
 * turn has no final answer, since they are then the last thing it said.
 */
export function turnSegments(turn, { fold = false } = {}) {
	const segments = [];
	let block = null;
	let lastWork = -1;
	if (fold) for (let i = 0; i < turn.steps.length; i++) if (turn.steps[i].type !== "note") lastWork = i;
	for (let i = 0; i < turn.steps.length; i++) {
		const step = turn.steps[i];
		if (step.type === "note" && (!fold || i > lastWork)) {
			segments.push({ type: "text", key: `x-${step.key}`, step });
			block = null;
			continue;
		}
		if (!block) {
			block = { type: "process", key: `p-${step.key}`, steps: [] };
			segments.push(block);
		}
		block.steps.push(step);
	}
	for (const segment of segments) if (segment.type === "process") segment.stats = stepStats(segment.steps);
	return segments;
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
	redirected: N_("Switched to your new message"),
	waiting: N_("Waiting for you"),
	completed: N_("Completed"),
	partial: N_("Partially completed"),
	failed: N_("Failed"),
	cancelled: N_("Cancelled"),
	unanswered: N_("No response"),
};

/**
 * Match a run_finished record to a turn: the newest turn that started at or before the run. A run that started with
 * the next turn's message belongs to that turn: a message sent with "interrupt" starts its run within moments of the
 * one it stopped, well inside the 5 s slack below.
 */
export function runForTurn(turn, runs, nextTurn) {
	if (!turn.startedAt) return undefined;
	const nextStart = nextTurn?.user?.ts;
	let best;
	for (const run of Object.values(runs)) {
		if (!run.startedAt) continue;
		if (run.startedAt + 3000 < turn.startedAt) continue;
		if (turn.endedAt && run.startedAt > turn.endedAt + 5000) continue;
		if (nextStart && run.startedAt >= nextStart - 250) continue;
		if (!best || run.startedAt > best.startedAt) best = run;
	}
	return best;
}

export function turnOutcome(turn, { run, live, waiting }) {
	if (waiting) return "waiting";
	if (live) return "running";
	if (run) return run.outcome;
	// A message the server has not confirmed yet (the optimistic local copy) is still on its way: it is never "no response".
	if (!turn.lastAssistant && turn.user?.pending) return "running";
	if (!turn.lastAssistant) return turn.user ? "unanswered" : "completed";
	const stop = turn.lastAssistant.stopReason;
	if (stop === "aborted") return "cancelled";
	if (stop === "error") return turn.stats.files > 0 ? "partial" : "failed";
	return "completed";
}

/** The server's marker between a run stopped by a message sent with "interrupt" and that message. */
export const INTERRUPT_ENTRY = "web-interrupt";

/**
 * A message sent with "interrupt" ends the run it lands in and is answered at once: that run was not given up, the
 * agent turned to the new message. The server says so: it writes INTERRUPT_ENTRY after the stopped reply (kept in the
 * saved transcript, so a reopened chat shows the same thing) and reports the run as "redirected". Chats saved before
 * that marker existed fall back to timing: the next message starting right where this turn's last entry was saved (a
 * person pressing Stop and then typing takes far longer). Only saved entries count there: a reply still on the page
 * carries the time it started, which for a long answer is long before the stop.
 */
const INTERRUPT_GAP_MS = 3_000;
export function interruptedByNext(turn, next) {
	if (turn?.interrupted) return true;
	const sentAt = next?.user?.ts;
	const last = turn?.items?.[turn.items.length - 1];
	if (!sentAt || !last?.id || last.liveId) return false;
	const stoppedAt = turn.endedAt || turn.startedAt;
	return !!(stoppedAt && sentAt - stoppedAt <= INTERRUPT_GAP_MS);
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

/**
 * The earlier chats a turn really read (session_get calls that returned a source), newest call last, one per chat:
 * what the answer's "sources" line offers to open.
 */
export function historySourcesOf(turn) {
	const seen = new Map();
	for (const step of turn?.steps || []) {
		if (step.type !== "action" || step.call?.name !== "session_get" || step.result?.isError) continue;
		for (const source of step.result?.details?.sources || []) {
			if (source?.path && source?.sessionId) seen.set(source.sessionId, source);
		}
	}
	return [...seen.values()];
}
