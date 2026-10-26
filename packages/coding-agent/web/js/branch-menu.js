// The branch chip above the input and its popover: search the local branches, switch, create and delete them, and move
// this chat into an isolated copy of the repository (a Git worktree) or back to the main copy. Every action calls the
// server's Git routes (routes-git.ts), which use Git's own rules; nothing here decides what Git allows.
import { html, useEffect, useMemo, useRef, useState, Chevron, Collapse, COLLAPSE_MS, FoldIn, Icon, Popover, Spinner, Toggle, useHeightGlide } from "./ui.js";
import { api, attempt, loadGitStatus, post, REQUEST_TIMEOUT, set, state, toast, useStore } from "./store.js";
import { rankSearch } from "./search.js";
import { relTime } from "./util.js";
import { count, getLang, serverText, t } from "./i18n.js";
import { openWorktreeTab } from "./worktree-tabs.js";
import { explainDeleteFailure } from "./git-delete.js";
import { createReadCache } from "./scheduling.js";
import { carryDraftFrom, dropCarriedDraft } from "./restart-state.js";
import { actions } from "./actions.js";
const worktreeReads = createReadCache(12);

/** A name for the branch of a new isolated copy: task-MMDD-HHmm, with -2, -3… when that name is taken. */
function copyBranchName(taken = new Set()) {
	const d = new Date();
	const two = (n) => String(n).padStart(2, "0");
	const base = `task-${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
	let name = base;
	for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
	return name;
}

/** Display name of a copy: its alias, else its branch, else its folder. */
const copyLabel = (w) => (w.isMain ? t("Main copy") : w.displayName || w.branch || w.path.split(/[\\/]/).pop());
/** A long copy path shows its last two folders; the full path is in the tooltip and behind the copy button. */
function shortPath(path) {
	const sep = path.includes("\\") ? "\\" : "/";
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length > 3 ? `…${sep}${parts.slice(-2).join(sep)}` : path;
}
/** The copy holds work main does not have (or its state could not be read, which counts as work to be safe). */
const holdsWork = (w) => !w.isMain && !w.merged && (w.changes === undefined || w.ahead === undefined || w.changes > 0 || w.ahead > 0);
const workText = (w) => (w.changes === undefined || w.ahead === undefined
	? t("Its changes could not be read, so it is treated as holding work.")
	: t("Uncommitted files: {changes} · commits not in main: {ahead}", { changes: w.changes, ahead: w.ahead }));

const sameCopyPath = (a, b) => !!a && !!b && a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase();

/** Read-write sub-agent branches stay in their own worktree copies; hide them from the branch list to keep it quiet. */
const SUBAGENT_BRANCH_PREFIX = "myharness-subagent-";
const isSubagentBranch = (name) => typeof name === "string" && name.startsWith(SUBAGENT_BRANCH_PREFIX);

/**
 * Keeps an element in view every frame while the fold around it opens, so the list moves with the fold in one motion
 * instead of folding open first and scrolling afterwards. A scroll container stops at its end, so following the box
 * the element will have once open simply keeps the growing edge in view.
 */
function followIntoView(element, ms = COLLAPSE_MS + 120) {
	const until = performance.now() + ms;
	let frame = requestAnimationFrame(function step() {
		element()?.scrollIntoView({ block: "nearest" });
		frame = performance.now() < until ? requestAnimationFrame(step) : 0;
	});
	return () => cancelAnimationFrame(frame);
}

/** A clear failure Git reports for a copy with uncommitted changes or new files: only these can be forced. */
const heldByChanges = (failure) => /modified or untracked|use --force/i.test(failure?.error || "");

/**
 * Live counts of a running "Clear archived copies", fed by the server's `worktree_clear` events. Processed is not
 * deleted: a copy Git refused is processed but kept, so the bar shows the deleted and the kept part side by side.
 * It reads the store itself, so each event re-renders this bar instead of the whole menu with every copy row.
 */
function ArchiveClearProgress() {
	const progress = useStore((s) => s.worktreeClear);
	if (!progress?.total) return null;
	const { total, done, removed = 0, failed = 0 } = progress;
	const share = (n) => `${(Math.min(n, total) / total) * 100}%`;
	const label = progress.phase === "done"
		? failed ? t("{removed} deleted, {kept} kept", { removed, kept: failed }) : t("{removed} deleted", { removed })
		: t("{done} of {total} processed, {left} left", { done, total, left: Math.max(0, total - done) });
	return html`<div class="branch-progress" role="progressbar" aria-valuemin="0" aria-valuemax=${total} aria-valuenow=${done} aria-label=${t("Deleting archived copies")}>
		<div class="branch-progress-track"><i class="removed" style=${`width:${share(removed)}`}></i><i class="kept" style=${`width:${share(failed)}`}></i></div>
		<div class="branch-progress-label">${label}</div>
	</div>`;
}

export function BranchChip({ gitStatus }) {
	const anchor = useRef(null);
	const slot = useStore((s) => s.activeSlot);
	// Keep data outside the popover's lifetime, but never reuse it for a different Chat.
	const branchSource = useMemo(() => {
		const source = { data: null, pending: null, loadedAt: 0 };
		source.load = (force = false) => {
			if (!force && source.data && Date.now() - source.loadedAt < 1000) return Promise.resolve(source.data);
			if (!source.pending) {
				source.pending = api("/api/git/branches", { slot, timeoutMs: REQUEST_TIMEOUT.branches }).then((data) => {
					source.data = data;
					source.loadedAt = Date.now();
					return data;
				}).finally(() => { source.pending = null; });
			}
			return source.pending;
		};
		return source;
	}, [slot]);
	useEffect(() => {
		// Read once when the chip mounts; the list is re-read when the menu opens (see below), not on every status tick.
		branchSource.load().catch(() => {});
	}, [branchSource]);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		// A Git status tick while the menu is closed does not need a new branch list; opening it does.
		if (open) branchSource.load(true).catch(() => {});
	}, [branchSource, open]);
	// The shared Popover hands the keyboard back when its open prop flips, but the exit animation keeps this menu
	// mounted through the fade, so its search input is still the focus at that moment and the restore is skipped.
	// Watch for the popover actually leaving the page and hand the keyboard back then (and only if focus was lost to
	// the body, so a control the user clicked during the closing keeps it).
	useEffect(() => {
		const host = anchor.current;
		if (!host) return undefined;
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.removedNodes) {
					if (node instanceof HTMLElement && node.classList.contains("branch-pop")) {
						const active = document.activeElement;
						if (!active || active === document.body) host.querySelector("button")?.focus({ preventScroll: true });
					}
				}
			}
		});
		observer.observe(host, { childList: true });
		return () => observer.disconnect();
	}, []);
	const linked = !!gitStatus.linkedWorktree;
	// A general chat keeps the branch itself, but the uncommitted count is the folder's Git, not this conversation's.
	const general = useStore((s) => s.view.chatMode) === "general";
	const branch = gitStatus.branch || t("detached HEAD");
	return html`<span ref=${anchor} class="branch-anchor">
		<button class=${`env-chip branch-chip ${linked ? "wt" : ""}`} onClick=${() => setOpen(!open)} aria-haspopup="dialog" aria-expanded=${open}
			title=${linked ? t("Branch {branch} in an isolated copy (Git worktree). Click to manage branches", { branch }) : t("Branch {branch}. Click to manage branches", { branch })}>
			<${Icon} name=${linked ? "layers" : "gitBranch"} size=${12} /><span class="truncate">${branch}</span>
			${!general && gitStatus.preview?.total ? html`<span class="badge warn">${gitStatus.preview.total}</span>` : null}
			${linked ? html`<span class="wt-tag">${t("worktree")}</span>` : null}
			<${Chevron} />
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="start" width=${420} maxHeight=${560} class="branch-pop">
			<${BranchMenu} key=${slot} gitStatus=${gitStatus} branchSource=${branchSource} slot=${slot} close=${() => setOpen(false)} />
		<//>
	</span>`;
}

/** What a row is called: a copy by its name (alias or branch); the main copy and plain branches by their branch. */
const entryLabel = ({ branch, copy }) => (copy && !copy.isMain ? copyLabel(copy) : branch?.name || copyLabel(copy));
/** The second line of a row with a copy: where the copy is, after its branch when the row shows an alias instead. */
function entrySub({ copy: w }) {
	if (!w) return "";
	if (w.isMain) return w.branch ? `${t("Main copy")} · ${shortPath(w.path)}` : shortPath(w.path);
	const branch = w.branch || t("detached HEAD");
	return copyLabel(w) === branch ? shortPath(w.path) : `${branch} · ${shortPath(w.path)}`;
}

/** The one state a copy shows: archived, merged into main, or the work main does not have yet (counted when known). */
function CopyState({ w, archived = false }) {
	if (archived) {
		return html`<span class="copy-state" title=${w.archivedAt ? t("Archived {when}: kept on disk, nothing deleted", { when: relTime(w.archivedAt) }) : t("Kept on disk, nothing deleted")}>${t("Archived")}</span>`;
	}
	if (w.merged) return html`<span class="copy-state ok" title=${t("Merged into main; kept as a read-only record")}>${t("Merged")}</span>`;
	if (!holdsWork(w)) return null;
	const parts = w.changes === undefined || w.ahead === undefined
		? []
		: [w.changes ? t("{n} open changes", { n: w.changes }) : "", w.ahead ? t("{n} commits not in main", { n: w.ahead }) : ""].filter(Boolean);
	return html`<span class="copy-state warn" title=${workText(w)}>${parts.length ? parts.join(" · ") : t("Unmerged")}</span>`;
}

/** What deleting a copy that holds work throws away, one line each, in the words the confirmation shows. */
function lossLines(w) {
	if (w.changes === undefined || w.ahead === undefined) return [t("Its changes could not be read, so it is treated as holding work.")];
	return [
		w.changes > 0 ? t("{n} uncommitted changes will be lost for good", { n: w.changes }) : "",
		w.ahead > 0 ? t("{n} commits are not in main yet; they will be hard to get back", { n: w.ahead }) : "",
	].filter(Boolean);
}

/**
 * Puts the keyboard on a panel's safe option once it is on screen. A fold keeps its content hidden (and unfocusable)
 * until its first frame is painted, so this tries again for a few frames; the panel is followed into view meanwhile.
 */
function focusSafeOption(panel) {
	let tries = 0;
	let frame = 0;
	const step = () => {
		const cancel = panel()?.querySelector(".branch-delete-cancel");
		cancel?.focus({ preventScroll: true });
		frame = document.activeElement !== cancel && tries++ < 10 ? requestAnimationFrame(step) : 0;
	};
	step();
	const stopFollow = followIntoView(panel);
	return () => { cancelAnimationFrame(frame); stopFollow(); };
}

function BranchMenu({ gitStatus, branchSource, slot, close }) {
	const running = useStore((s) => !!s.snap?.active);
	const linked = !!gitStatus.linkedWorktree;
	const [data, setData] = useState(branchSource.data);
	const [error, setError] = useState("");
	const [worktrees, setWorktrees] = useState(() => {
		const cached = worktreeReads.peek(slot);
		return cached ? { list: cached.worktrees || [] } : null;
	});
	const [query, setQuery] = useState("");
	const [sel, setSel] = useState(0);
	const [ownBusy, setBusy] = useState("");
	// A clear started before the menu was reopened still counts as the menu's own work.
	const clearRunning = useStore((s) => s.archiveClear?.slot === slot && !!s.archiveClear.running);
	const busy = ownBusy || (clearRunning ? "archive-clear" : "");
	const deletePending = useRef(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	// The row whose "Delete?" pill waits for a second click: a branch without a copy, or an archived copy.
	const [confirm, setConfirm] = useState("");
	// The delete panel open under one row: `{ key, kind, branch, copy, failure, changed }`. `kind` is "copy" (a copy
	// and its branch, asked before anything happens), "branch" (a branch without a copy, shown once Git refused it) or
	// "archived" (an archived copy alone, shown once Git refused it). It stays until cancelled or deleted.
	const [ask, setAsk] = useState(null);
	const [removing, setRemoving] = useState("");
	const [agentsOpen, setAgentsOpen] = useState(false);
	const [archivedOpen, setArchivedOpen] = useState(false);
	// The clear-archived confirmation lives in the store, not in this menu: closing the popover while copies are being
	// deleted must neither lose the outcome (the toast points back to it) nor allow a second clear to start.
	// `{ slot, stage: "confirm" | "force", running, dirty, other, error }`; `dirty` are the copies Git refused because
	// of uncommitted changes (the only ones force may delete), `other` the ones refused for any other reason.
	const storedClear = useStore((s) => s.archiveClear);
	const archiveClear = storedClear?.slot === slot ? storedClear : null;
	const setArchiveClear = (next) => set({ archiveClear: next && { slot, stage: "confirm", running: false, dirty: [], other: [], error: "", ...next } });
	const [fresh, setFresh] = useState("");
	const [naming, setNaming] = useState(null);
	const [displayName, setDisplayName] = useState("");
	const askPanel = useRef(null);
	const archiveClearPanel = useRef(null);
	// The archived rows shrink with the shared motion when a clear removes some of them.
	const glide = useHeightGlide();
	const archivedEnd = useRef(null);
	const known = useRef(null);
	const list = useRef(null);

	const load = async (force = false) => {
		try {
			const next = await branchSource.load(force);
			// Branches that were not in the list before (a new one) fade in; the first list does not animate.
			known.current = data ? new Set(data.branches.map((b) => b.name)) : null;
			setData(next);
			setError("");
		} catch (e) {
			setError(serverText(e.message, t("Cannot list branches.")));
		}
	};
	// `fresh`: read again even if a read is in flight (it may have started before a copy was created or removed).
	const loadWorktrees = async (fresh = false) => {
		try {
			const data = fresh
				? await api("/api/git/worktrees", { slot, timeoutMs: REQUEST_TIMEOUT.worktrees })
				: await worktreeReads.load(slot, () => api("/api/git/worktrees", { slot, timeoutMs: REQUEST_TIMEOUT.worktrees }));
			setWorktrees({ list: data.worktrees || [] });
		} catch (e) {
			setWorktrees({ list: [], error: serverText(e.message, t("Cannot list worktrees.")) });
		}
	};
	// Reading the list already archived finished copies; this releases the branches of the clean ones. Once per open:
	// a running task or an untrusted project just leaves them attached for the next try.
	const archiveSynced = useRef(false);
	const archiveTimer = useRef(null);
	const archiveDisposed = useRef(false);
	useEffect(() => () => {
		archiveDisposed.current = true;
		clearTimeout(archiveTimer.current);
		// A confirmation nobody answered closes with the menu; a running clear or its outcome stays for the next opening.
		const open = state.archiveClear;
		if (open?.slot === slot && !open.running && !open.error && !open.dirty.length && !open.other.length) set({ archiveClear: null, worktreeClear: null });
	}, []);
	const syncArchive = async () => {
		if (archiveSynced.current) return;
		archiveSynced.current = true;
		try {
			const result = await post("/api/git/worktrees/archive-sync", { batchSize: 2 }, slot);
			if (archiveDisposed.current) return;
			if (result?.released) await loadWorktrees(true);
			if (result?.remaining > 0 && !archiveDisposed.current) {
				archiveTimer.current = setTimeout(() => {
					archiveSynced.current = false;
					syncArchive();
				}, 2000);
			}
		} catch {
			archiveSynced.current = false;
		}
	};
	const restoreCopy = async (w) => {
		if (!w || w.isMain || busy) return;
		setBusy(`archive:${w.path}`);
		try {
			const result = await post("/api/git/worktrees/archive", { path: w.path, archived: false }, slot);
			if (result?.warning) toast(result.warning, "warning", 7000);
			await loadWorktrees(true);
			toast(t("Copy restored to the list"), "info", 3500);
		} catch (e) {
			toast(serverText(e.message, t("Cannot restore this copy.")), "error", 8000);
		} finally {
			setBusy("");
		}
	};
	// The only step that deletes archived copies. A safe clear leaves copies with uncommitted changes in place and asks
	// again; the forced clear then names exactly those copies, so one archived meanwhile is never deleted unseen.
	const clearStartedHere = useRef(false);
	const clearArchived = async () => {
		const asked = state.archiveClear?.slot === slot ? state.archiveClear : null;
		if (!asked || busy) return;
		const force = asked.stage === "force";
		const paths = force ? asked.dirty.map((failure) => failure.path) : undefined;
		clearStartedHere.current = true;
		set({ worktreeClear: null });
		setArchiveClear({ ...asked, running: true, error: "" });
		let outcome;
		try {
			const result = await post("/api/git/worktrees/archive/clear", { force, ...(paths ? { paths } : {}) }, slot);
			const failed = result?.failed || [];
			const dirty = force ? [] : failed.filter(heldByChanges);
			// A forced clear only touched the copies with changes: the ones refused for another reason are still there.
			const other = [...(force ? asked.other : []), ...failed.filter((failure) => !dirty.includes(failure))];
			outcome = dirty.length || other.length ? { stage: dirty.length ? "force" : "confirm", dirty, other } : null;
		} catch (e) {
			outcome = { ...asked, running: false, error: serverText(e.message, t("Cannot clear archived copies.")) };
		}
		// Read the list first and fold the rows away in the same step the panel changes, so nothing jumps twice.
		const listing = await api("/api/git/worktrees", { slot, timeoutMs: REQUEST_TIMEOUT.worktrees }).catch(() => null);
		glide.run(() => {
			if (listing && !archiveDisposed.current) setWorktrees({ list: listing.worktrees || [] });
			setArchiveClear(outcome);
		});
		if (!archiveDisposed.current) load(true);
		if (!outcome) {
			set({ worktreeClear: null });
			toast(t("Archived copies cleared"), "info", 3500);
		} else {
			// The menu explains what was kept and why; the toast only says where to look (the menu may be closed by now).
			toast(t("Some archived copies were not deleted. The branch menu shows why."), "warning", 6000);
		}
	};
	const cancelArchiveClear = () => set({ archiveClear: null, worktreeClear: null });
	useEffect(() => {
		load();
		// Opening the branch popover expresses intent; avoid prefetching every Chat at startup. A cached list shows at
		// once while this read (always a real one) replaces it.
		loadWorktrees().then(() => {
			archiveTimer.current = setTimeout(() => syncArchive(), 2000);
		});
	}, []);
	useEffect(() => {
		if (!archivedOpen) return undefined;
		// The opened group is taller than what is left of the copies region: its end (the clear button) is kept in view
		// while it folds open, so the action is not left below the fold and nothing scrolls after the fold has ended.
		return followIntoView(() => archivedEnd.current);
	}, [archivedOpen]);
	// A clear started by an earlier opening of this menu ends while this one is open: read the list it changed.
	const clearSeenRunning = useRef(clearRunning);
	useEffect(() => {
		if (clearSeenRunning.current && !clearRunning && !clearStartedHere.current) loadWorktrees(true);
		clearSeenRunning.current = clearRunning;
	}, [clearRunning]);
	const clearSettled = !!archiveClear && !archiveClear.running;
	useEffect(() => {
		// The confirmation folds in below the capped copies region: followed into view, or the click looks dead. It also
		// takes the keyboard on its safe option, when it opens and again when a clear ends (the confirm button was
		// disabled meanwhile, so the focus had nowhere to stay).
		if (!clearSettled) return undefined;
		return focusSafeOption(() => archiveClearPanel.current);
	}, [clearSettled, archiveClear?.stage]);
	// A delete panel opens under its row (or changes after a refusal): show it whole and put the keyboard on Cancel.
	useEffect(() => {
		if (!ask) return undefined;
		return focusSafeOption(() => askPanel.current);
	}, [ask?.key, ask?.failure, ask?.changed]);

	const copiesList = worktrees?.list || [];
	const main = copiesList.find((w) => w.isMain);
	// One row per branch, and a branch checked out in a copy shows that copy in the same row: a copy and its branch are
	// one thing to the user. Copies on a detached HEAD get a row of their own; sub-agent and archived copies wait in
	// their folded groups below. Without a search: the current row, the main copy, copies with work, clean copies,
	// merged copies, then the other branches in the server's order.
	const entries = useMemo(() => {
		const byBranch = new Map(copiesList.filter((w) => w.branch).map((w) => [w.branch, w]));
		const out = [];
		const shown = new Set();
		for (const b of data?.branches || []) {
			const copy = byBranch.get(b.name);
			if (copy) shown.add(copy.path);
			if (!b.current && (isSubagentBranch(b.name) || copy?.archived || copy?.subagent)) continue;
			out.push({ key: `b:${b.name}`, branch: b, copy });
		}
		// A copy no listed branch points at (a detached HEAD, or a branch the list does not have) still gets its row.
		for (const w of copiesList) if (!shown.has(w.path) && !w.archived && !w.subagent) out.push({ key: `w:${w.path}`, copy: w });
		const rank = ({ branch: b, copy: w }) => (b ? b.current : w?.current) ? 0 : w?.isMain ? 1 : !w ? 5 : w.merged ? 4 : holdsWork(w) ? 2 : 3;
		const ordered = out.map((entry, index) => ({ entry, index }))
			.sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
			.map(({ entry }) => entry);
		return rankSearch(ordered, query, { names: (entry) => [entryLabel(entry), entry.branch?.name || "", entry.copy?.path || ""] });
	}, [data, worktrees, query]);
	const exact = entries.some((entry) => entry.branch?.name === query.trim());
	// Rows the keyboard moves over: the list, then "New branch".
	const rows = data ? [...entries, { kind: "new" }] : [];
	useEffect(() => setSel(0), [query]);
	useEffect(() => {
		list.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel]);

	const done = async (message) => {
		// In parallel: both read small payloads, and serially the toast could wait out a status timeout before appearing.
		await Promise.all([loadGitStatus(), loadWorktrees(true)]);
		// Switching branches or deleting a copy rewrites files on disk; tell the mounted panels to reload them.
		window.dispatchEvent(new CustomEvent("myharness:git-changed", { detail: { slot } }));
		if (message) toast(message, "info", 3500);
	};
	// `carryHistory`: the chat (history and unsent draft) moves along instead of a new empty chat opening there.
	const enterCopy = async (path, message, carryHistory = false) => {
		setBusy(`w:${path}`);
		if (carryHistory) carryDraftFrom(state.snap?.session?.id);
		const ok = await attempt(() =>
			post("/api/git/worktrees/enter", { path, ...(carryHistory ? { carryHistory: true } : {}) }, undefined, {
				timeoutMs: REQUEST_TIMEOUT.session,
			}),
		);
		setBusy("");
		if (!ok) {
			dropCarriedDraft();
			return false;
		}
		close();
		await done(message);
		return true;
	};
	const switchTo = async (branch) => {
		if (branch.current) return close();
		// A branch checked out in another copy cannot be checked out here too: go to that copy instead.
		if (branch.worktreePath) return enterCopy(branch.worktreePath, t("Opened the copy where {branch} is checked out", { branch: branch.name }));
		setBusy(`b:${branch.name}`);
		const ok = await attempt(() => post("/api/git/branches/switch", { name: branch.name }));
		setBusy("");
		if (!ok) return;
		close();
		await done(t("Switched to {branch}", { branch: branch.name }));
	};
	const startNew = () => {
		setCreating(true);
		setNewName(exact ? "" : query.trim());
	};
	const create = async () => {
		const name = newName.trim();
		if (!name) return;
		setBusy("create");
		const ok = await attempt(() => post("/api/git/branches/create", { name }));
		setBusy("");
		if (!ok) return;
		close();
		await done(t("Created branch {branch} and switched to it", { branch: name }));
	};
	// Do not translate away Git's cause before matching it; unknown failures still have readable guidance plus details.
	const tryPost = async (path, body) => {
		try {
			await post(path, body, slot);
			return null;
		} catch (e) {
			return { detail: e.rawMessage || e.message || String(e), status: e.status };
		}
	};

	// The copy gets its formal name from the main Agent once the chat is in it; until then the branch name stands in.
	// A name the user typed in the meantime is never replaced, and a busy or failed request keeps the temporary name.
	const nameInBackground = async (w) => {
		try {
			const result = await post("/api/git/worktrees/name-ai", { path: w.path, language: getLang() }, slot);
			if (!result?.name) return;
			const listing = await api("/api/git/worktrees", { slot, timeoutMs: REQUEST_TIMEOUT.worktrees });
			const now = listing.worktrees?.find((item) => sameCopyPath(item.path, w.path));
			if (!now || (now.displayName && now.displayName !== now.branch)) return;
			await post("/api/git/worktrees/rename", { path: w.path, name: result.name }, slot);
			await loadGitStatus();
			await loadWorktrees(true);
		} catch {
			// Naming is a convenience: the copy keeps its branch name.
		}
	};
	// One action: a new branch from the commit checked out right now, a copy on it, and this chat (history and draft)
	// moved into it. If the chat cannot move, it stays in the main copy and the empty copy is removed again.
	const createAndEnter = async () => {
		if (disabled || !worktrees || worktrees.error || linked) return;
		const taken = new Set([...(data?.branches || []).map((b) => b.name), ...copiesList.map((w) => w.branch).filter(Boolean)]);
		const branch = copyBranchName(taken);
		setBusy("copy");
		const created = await attempt(() =>
			post("/api/git/worktrees/create", { branch, newBranch: true, base: "head" }, undefined, {
				timeoutMs: REQUEST_TIMEOUT.session,
			}),
		);
		if (!created?.worktree?.path) {
			setBusy("");
			return;
		}
		const path = created.worktree.path;
		setFresh(path);
		await Promise.all([loadWorktrees(true), load(true)]);
		carryDraftFrom(state.snap?.session?.id);
		const entered = await attempt(() =>
			post("/api/git/worktrees/enter", { path, carryHistory: true }, undefined, { timeoutMs: REQUEST_TIMEOUT.session }),
		);
		setBusy("");
		if (!entered) {
			dropCarriedDraft();
			setFresh("");
			// Safe delete only: a copy that somehow holds files is kept and stays listed.
			await tryPost("/api/git/worktrees/delete", { path });
			await Promise.all([loadWorktrees(true), load(true)]);
			toast(t("Still in the main copy; nothing was moved."), "warning", 6000);
			return;
		}
		await done(t("Now working in an isolated copy on {branch}", { branch }));
		nameInBackground(created.worktree);
	};
	const backToMain = () => main && enterCopy(main.path, t("Back in the main copy"), true);

	// Deleting asks once, in a panel under the row that says what would be lost; nothing else in the menu moves.
	// A copy and its branch go together. A branch without a copy, or an archived copy, uses the "Delete?" pill and only
	// opens the panel when Git refuses, with the stronger option Git allows.
	const askDelete = (target) => {
		if (disabled) return;
		setNaming(null);
		if (target.kind !== "copy") {
			setAsk(null);
			return setConfirm(target.key);
		}
		setConfirm("");
		setAsk({ ...target, failure: null, changed: false });
	};
	const cancelAsk = () => { setAsk(null); setConfirm(""); };
	const runDelete = async (target, force = false) => {
		if (running || busy || deletePending.current) return;
		const { key, kind, branch, copy } = target;
		setConfirm("");
		deletePending.current = true;
		setBusy(key);
		let err = null;
		let now = copy;
		// The panel showed the copy as it was when the menu read it. Read it again: if its work changed since, show the
		// new state and let the user decide again instead of deleting something the panel did not mention.
		if (kind === "copy" && !force) {
			const listing = await api("/api/git/worktrees", { slot, timeoutMs: REQUEST_TIMEOUT.worktrees }).catch(() => null);
			if (!listing) err = { detail: "Cannot reach the MyHarness server" };
			else {
				setWorktrees({ list: listing.worktrees || [] });
				now = listing.worktrees?.find((w) => sameCopyPath(w.path, copy.path));
				if (now && (holdsWork(now) !== holdsWork(copy) || now.changes !== copy.changes || now.ahead !== copy.ahead)) {
					deletePending.current = false;
					setBusy("");
					setAsk({ ...target, copy: now, failure: null, changed: true });
					return;
				}
			}
		}
		// A copy that is no longer listed is already gone: nothing to delete, the lists are read again below.
		if (!err && (!copy || now)) {
			err = kind === "branch"
				? await tryPost("/api/git/branches/delete", { name: branch.name, ...(force ? { force: true } : {}) })
				: kind === "copy" && branch
					// The server removes the copy (with its files) and then the branch, after refusing the main and the
					// current copy and a locked one; the panel already named what that throws away.
					? await tryPost("/api/git/branches/delete", { name: branch.name, force: true, deleteWorktrees: true })
					: await tryPost("/api/git/worktrees/delete", { path: copy.path, ...(force || (kind === "copy" && holdsWork(now)) ? { force: true } : {}) });
		}
		deletePending.current = false;
		setBusy("");
		if (err) {
			const failure = { ...err, ...explainDeleteFailure(err, kind === "branch" ? "branch" : "copy", force) };
			setAsk({ ...target, copy: now || copy, failure, changed: false });
			toast(failure.message, "error", 9000);
			return;
		}
		setAsk(null);
		setFresh("");
		if (naming && copy && sameCopyPath(naming.path, copy.path)) setNaming(null);
		toast(kind === "branch" ? t("Deleted branch {branch}", { branch: branch.name })
			: kind === "copy" && branch ? t("Deleted the copy and branch {branch}", { branch: branch.name })
			: t("Copy deleted"), "info", 3500);
		window.dispatchEvent(new CustomEvent("myharness:git-changed", { detail: { slot } }));
		loadGitStatus();
		if (kind === "archived") {
			const listing = await api("/api/git/worktrees", { slot, timeoutMs: REQUEST_TIMEOUT.worktrees }).catch(() => null);
			if (listing) glide.run(() => setWorktrees({ list: listing.worktrees || [] }));
			return;
		}
		// The row folds away first, then both lists are read again.
		setRemoving(key);
		setTimeout(async () => {
			await Promise.all([load(true), loadWorktrees(true)]);
			setRemoving("");
		}, COLLAPSE_MS);
	};
	const openCopyFirst = async (w) => {
		cancelAsk();
		if (await enterCopy(w.path)) toast(t("Use “Merge into main” above the input when the copy is ready."), "info", 6000);
	};

	const startCopy = async (w) => {
		setBusy(`start:${w.path}`);
		await attempt(() => openWorktreeTab(w.path, () => post("/api/git/worktrees/start", { path: w.path }, slot)));
		setBusy("");
	};
	const copyPath = async (w) => {
		const ok = await attempt(() => navigator.clipboard.writeText(w.path));
		if (ok) toast(t("Path copied"), "info", 2500);
	};
	const suggestName = async (w) => {
		setBusy("name");
		const result = await attempt(() => post("/api/git/worktrees/name-ai", { path: w.path, language: getLang() }, slot));
		setBusy("");
		if (result) { setNaming(w); setDisplayName(result.name); }
	};
	const saveName = async () => {
		setBusy("name");
		const result = await attempt(() => post("/api/git/worktrees/rename", { path: naming.path, name: displayName }, slot));
		setBusy("");
		if (result) {
			setNaming(null);
			await loadWorktrees(true);
			await loadGitStatus();
		}
	};

	const activate = (row) => {
		if (row.kind === "new") return startNew();
		const { branch, copy } = row;
		if (copy?.isMain && linked) return backToMain();
		if (branch) return switchTo(branch);
		if (copy && !copy.current) return enterCopy(copy.path);
		close();
	};
	const onSearchKey = (event) => {
		if (event.isComposing || disabled || !rows.length) return;
		if (event.key === "ArrowDown") return event.preventDefault(), setSel((sel + 1) % rows.length);
		if (event.key === "ArrowUp") return event.preventDefault(), setSel((sel - 1 + rows.length) % rows.length);
		if (event.key === "Enter") return event.preventDefault(), rows[sel] && activate(rows[sel]);
	};
	const disabled = running || !!busy || !data;

	const askPanelFor = (a) => {
		const w = a.copy;
		const work = a.kind === "copy" && !!w && holdsWork(w);
		const failure = a.failure;
		const title = a.kind === "branch"
			? t("Delete branch “{branch}”?", { branch: a.branch.name })
			: a.kind === "copy" && a.branch ? t("Delete this copy and its branch?") : t("Delete this copy?");
		const deleting = busy === a.key;
		const red = (label, onClick) => html`<button class="btn sm danger solid" disabled=${disabled} onClick=${onClick}>${deleting ? html`<${Spinner} size=${12} />` : null}${label}</button>`;
		return html`<div ref=${askPanel} class="branch-ask" role="group" aria-label=${a.kind === "branch" ? t("Delete branch?") : t("Delete copy?")}>
			<strong>${title}</strong>
			${a.changed ? html`<div class="branch-ask-note">${t("It changed after the menu opened. Check it again.")}</div>` : null}
			${failure
				? html`<div role="alert">${failure.message}</div>
					${failure.detail ? html`<details class="branch-delete-details"><summary>${t("Error details")}</summary><div class="pre-wrap">${failure.detail}</div></details>` : null}`
				: a.kind !== "copy" ? null
				: work ? html`<ul class="branch-ask-loss">${lossLines(w).map((line) => html`<li>${line}</li>`)}</ul>`
				: html`<div class="dim">${w.merged ? t("Its work is already in main; nothing is lost.") : t("Nothing is lost: no uncommitted changes, and its commits are already in main.")}</div>`}
			<div class="branch-form">
				${work && !w.current ? html`<button class="btn sm branch-ask-open" disabled=${disabled} onClick=${() => openCopyFirst(w)}>${t("Open this copy")}</button>` : null}
				<button class="btn sm branch-delete-cancel" disabled=${!!busy} onClick=${cancelAsk}>${t("Cancel")}</button>
				${failure
					? failure.canForce
						? red(a.kind === "branch" ? t("Force delete branch") : t("Force delete copy"), () => runDelete(a, true))
						: red(t("Retry delete"), () => runDelete(a))
					: red(work ? t("Discard and delete") : t("Delete"), () => runDelete(a))}
			</div>
		</div>`;
	};
	const namingFormFor = (w) => (naming && sameCopyPath(naming.path, w.path)
		? html`<form class="branch-form branch-rename" onSubmit=${(e) => { e.preventDefault(); saveName(); }}><input class="field sm grow" maxlength="80" aria-label=${t("Copy display name")} value=${displayName} autofocus onInput=${(e) => setDisplayName(e.target.value)} /><button class="btn sm" type="submit" disabled=${!!busy || !displayName.trim()}>${t("Save")}</button><button class="btn sm" type="button" disabled=${disabled} onClick=${() => suggestName(naming)}>${busy === "name" ? html`<${Spinner} size=${12} />` : t("AI name")}</button><button class="icon-btn sm" type="button" aria-label=${t("Cancel")} onClick=${() => setNaming(null)}><${Icon} name="x" size=${13} /></button></form>`
		: null);
	// The buttons a row shows while it is pointed at (they take the place of its time): enter, start, rename, copy path,
	// delete, as far as they apply. Clicks here never reach the row, which would switch or enter.
	const rowActions = (target, { archived = false } = {}) => {
		const w = target.copy;
		const copy = !!w && !w.isMain;
		const deletable = !w?.isMain && !(target.branch?.worktreePath && !w) && !(target.branch?.current || w?.current);
		return html`<div class="branch-row-actions" onClick=${(e) => e.stopPropagation()}>
			${copy && !w.current ? html`<button class="icon-btn sm" disabled=${disabled} title=${t("Enter to edit")} aria-label=${t("Enter to edit")} onClick=${() => enterCopy(w.path)}><${Icon} name="arrowRight" size=${13} /></button>` : null}
			${archived
				? html`<button class="icon-btn sm" disabled=${!!busy} title=${t("Restore copy")} aria-label=${t("Restore copy")} onClick=${() => restoreCopy(w)}><${Icon} name="undo" size=${13} /></button>`
				: copy ? html`<button class="icon-btn sm" disabled=${!!busy} title=${t("Start copy")} aria-label=${t("Start copy")} onClick=${() => startCopy(w)}><${Icon} name="play" size=${13} /></button>
					<button class="icon-btn sm" disabled=${!!busy} title=${t("Rename copy")} aria-label=${t("Rename copy")} onClick=${() => { setAsk(null); setNaming(w); setDisplayName(w.displayName || w.branch || ""); }}><${Icon} name="edit" size=${13} /></button>` : null}
			${w ? html`<button class="icon-btn sm" title=${t("Copy path")} aria-label=${t("Copy path")} onClick=${() => copyPath(w)}><${Icon} name="copy" size=${13} /></button>` : null}
			${deletable && confirm !== target.key && ask?.key !== target.key ? html`<button class="icon-btn sm branch-del" disabled=${disabled} title=${copy ? t("Delete copy") : t("Delete branch")} aria-label=${copy ? t("Delete copy") : t("Delete branch {branch}", { branch: target.branch?.name || "" })} onClick=${() => askDelete(target)}><${Icon} name="trash" size=${13} /></button>` : null}
		</div>`;
	};
	const confirmPill = (target) => (confirm === target.key
		? html`<button class="branch-confirm" disabled=${disabled} onClick=${(e) => (e.stopPropagation(), runDelete(target))}>${t("Delete?")}</button>`
		: null);

	const entryRow = (entry, i) => {
		const { branch: b, copy: w } = entry;
		const isCopy = !!w && !w.isMain;
		const current = b ? b.current : !!w?.current;
		const target = { key: entry.key, kind: isCopy ? "copy" : "branch", branch: b, copy: w };
		const sub = entrySub(entry);
		const rowBusy = busy === entry.key || (b && busy === `b:${b.name}`) || (w && (busy === `w:${w.path}` || busy === `start:${w.path}`));
		const icon = !w ? (b?.worktreePath ? "layers" : "gitBranch") : w.isMain ? "folder" : "layers";
		return html`<${Collapse} key=${entry.key} open=${removing !== entry.key}>
			<div data-row=${i} role="option" aria-selected=${current} data-copy-path=${w?.path} data-copy-branch=${w?.branch}
				class=${`pop-item branch-row ${sel === i ? "hi" : ""} ${current ? "active" : ""} ${ask?.key === entry.key ? "asking" : ""} ${fresh && w && sameCopyPath(w.path, fresh) ? "branch-copy-target" : ""} ${known.current && b && !known.current.has(b.name) ? "fade-in" : ""}`}
				onMouseMove=${() => sel !== i && setSel(i)} onClick=${() => !disabled && activate(entry)} aria-disabled=${disabled && !current}
				title=${w ? w.path : b?.subject ? `${b.name} — ${b.subject}` : b?.name}>
				<${Icon} name=${icon} size=${13} class="branch-ico" />
				<span class="col branch-info">
					<span class="branch-name truncate">${entryLabel(entry)}</span>
					${sub ? html`<span class="dim truncate branch-sub">${sub}</span>` : null}
				</span>
				${isCopy ? html`<${CopyState} w=${w} />` : null}
				${confirmPill(target) || (b?.committedAt ? html`<span class="dim branch-time">${relTime(b.committedAt)}</span>` : null)}
				${rowBusy ? html`<${Spinner} size=${13} />` : current ? html`<${Icon} name="check" size=${14} class="branch-check" />` : null}
				${rowActions(target)}
			</div>
			<${FoldIn} content=${ask?.key === entry.key ? askPanelFor(ask) : null} />
			${w ? namingFormFor(w) : null}
		<//>`;
	};
	// Rows of the folded groups below the list: sub-agent copies (deleted like any copy) and archived copies.
	const groupRow = (w, archived = false) => {
		const target = { key: `w:${w.path}`, kind: archived ? "archived" : "copy", branch: w.branch ? { name: w.branch } : null, copy: w };
		const rowBusy = busy === target.key || busy === `w:${w.path}` || busy === `start:${w.path}` || busy === `archive:${w.path}`;
		return html`<div key=${w.path}>
			<div data-copy-path=${w.path} data-copy-branch=${w.branch} class=${`pop-item branch-row branch-copy ${ask?.key === target.key ? "asking" : ""}`} title=${w.path}>
				<${Icon} name="layers" size=${13} class="branch-ico" />
				<span class="col branch-info">
					<span class="branch-name truncate">${copyLabel(w)}</span>
					<span class="dim truncate branch-sub">${shortPath(w.path)}</span>
				</span>
				<${CopyState} w=${w} archived=${archived} />
				${confirmPill(target)}
				${rowBusy ? html`<${Spinner} size=${13} />` : null}
				${rowActions(target, { archived })}
			</div>
			<${FoldIn} content=${ask?.key === target.key ? askPanelFor(ask) : null} />
			${namingFormFor(w)}
		</div>`;
	};
	// A group with a long list grows far taller than the region can show, which would make the shared fold fill the
	// visible area in the first frame; capping the list lets the fold ease over the height you can actually see.
	const copiesClass = (rows) => `branch-copies${rows.length > 12 ? " branch-copies-long" : ""}`;
	const agentCopies = copiesList.filter((w) => !w.isMain && w.subagent && !w.archived);
	// Newest archived copy first: the copy finished most recently is the one worth checking first.
	const archivedCopies = copiesList
		.filter((w) => !w.isMain && w.archived)
		.sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")));
	// The archived group's clear button only opens the confirmation. While that confirmation is open the button folds
	// aside: two red buttons with the same words, one right under the other, read as "the click opened a second clear
	// button" instead of "confirm this clear".
	const archivedClearTrigger = html`<div class="branch-archive-end" ref=${archivedEnd}><${Collapse} open=${!archiveClear}>
		<div class="branch-form"><button class="btn sm danger" disabled=${disabled} onClick=${() => setArchiveClear({})}>${t("Clear archived copies")}</button></div>
	<//></div>`;
	const newRow = rows.length - 1;

	return html`<div class="branch-menu" role="dialog" aria-label=${t("Branches")}>
		<div class="pop-search"><${Icon} name="search" size=${13} /><input autofocus value=${query} placeholder=${t("Search branches and copies")} aria-label=${t("Search branches and copies")}
			onInput=${(e) => setQuery(e.target.value)} onKeyDown=${onSearchKey} /></div>
		${running ? html`<div class="branch-note dim">${t("Branches can be changed when the agent is idle")}</div>` : null}
		<div class="pop-scroll branch-list" ref=${list} role="listbox" aria-label=${t("Branches")}>
			${error ? html`<div class="branch-note c-danger">${error}</div>` : !data ? html`<div class="branch-note dim"><${Spinner} /> ${t("Loading…")}</div>` : !entries.length ? html`<div class="branch-note dim">${t("No branch matches")}</div>` : null}
			${worktrees?.error ? html`<div class="branch-note c-danger">${worktrees.error}</div>` : null}
			${entries.map(entryRow)}
		</div>
		${agentCopies.length || archivedCopies.length ? html`<div class="branch-copy-region">
			${agentCopies.length ? html`<button class="pop-group branch-wt-group" aria-expanded=${agentsOpen} onClick=${() => setAgentsOpen(!agentsOpen)}>
				<${Chevron} /><span>${t("Sub-agent copies")}</span><span class="badge">${agentCopies.length}</span></button>
				<${Collapse} open=${agentsOpen}><div class=${copiesClass(agentCopies)}>${agentCopies.map((w) => groupRow(w))}</div><//>` : null}
			<${FoldIn} content=${archivedCopies.length ? html`<button class="pop-group branch-wt-group" aria-expanded=${archivedOpen} onClick=${() => setArchivedOpen(!archivedOpen)}>
				<${Chevron} /><span>${t("Archived copies")}</span><span class="badge">${archivedCopies.length}</span></button>
				<${Collapse} open=${archivedOpen}>
					<div ref=${glide.ref} class=${copiesClass(archivedCopies)}>${archivedCopies.map((w) => groupRow(w, true))}</div>
					${archivedClearTrigger}
				<//>` : null} />
		</div>` : null}
		<${FoldIn} content=${archiveClear ? html`<div ref=${archiveClearPanel} class="branch-note branch-delete-panel" role="group" aria-label=${t("Clear archived copies?")}>
			${archiveClear.stage === "force"
				? html`<strong>${t("Uncommitted changes remain in {copies}", { copies: count(archiveClear.dirty.length, "copy") })}</strong>
					<div>${t("Force deleting removes them together with their uncommitted changes and new files. This cannot be undone.")}</div>`
				: html`<strong>${t("Delete all {copies}?", { copies: count(archivedCopies.length, "archived copy", "archived copies") })}</strong>
					<div>${t("Their folders are removed from disk. This is the only action that deletes archived work; archiving itself never does.")}</div>`}
			<${ArchiveClearProgress} />
			${archiveClear.error ? html`<div class="c-danger" role="alert">${archiveClear.error}</div>` : null}
			${archiveClear.other.length ? html`<div class="c-danger" role="alert">${t("{copies} could not be deleted for another reason, such as a file still in use. Close the programs using them, then try again.", { copies: count(archiveClear.other.length, "copy") })}</div>
				<details class="branch-delete-details"><summary>${t("Error details")}</summary><div class="pre-wrap">${archiveClear.other.map((failure) => `${failure.path}\n  ${failure.error}`).join("\n")}</div></details>` : null}
			<div class="branch-form">
				${archiveClear.stage === "force"
					? html`<button class="btn sm danger solid" disabled=${disabled} onClick=${clearArchived}>${clearRunning ? html`<${Spinner} size=${12} />${t("Deleting…")}` : t("Force delete {copies} and discard changes", { copies: count(archiveClear.dirty.length, "copy") })}</button>`
					: html`<button class="btn sm danger" disabled=${disabled || !archivedCopies.length} onClick=${clearArchived}>${clearRunning ? html`<${Spinner} size=${12} />${t("Deleting…")}` : t("Delete {copies}", { copies: count(archivedCopies.length, "copy") })}</button>`}
				<button class="btn sm branch-delete-cancel" disabled=${!!busy} onClick=${cancelArchiveClear}>${t("Cancel")}</button>
			</div>
		</div>` : null} />
		<div class="branch-foot">
			<div class="branch-foot-actions">
				<button data-row=${newRow} class=${`pop-item branch-new ${data && sel === newRow ? "hi" : ""}`} disabled=${disabled} onClick=${startNew} onMouseMove=${() => sel !== newRow && setSel(newRow)} aria-expanded=${creating}>
					<${Icon} name="plus" size=${13} /><span class="truncate">${query.trim() && !exact ? t("New branch “{name}”", { name: query.trim() }) : t("New branch")}</span>
				</button>
				${linked
					? html`<button class="pop-item branch-wt-action" disabled=${disabled || !main} onClick=${backToMain} title=${t("This chat and its draft move back to the main copy")}>
						<${Icon} name="arrowLeft" size=${13} /><span class="truncate">${t("Back to the main copy")}</span>${main && busy === `w:${main.path}` ? html`<${Spinner} size=${13} />` : null}</button>`
					: html`<button class="pop-item branch-wt-action" disabled=${disabled || !worktrees || !!worktrees.error} onClick=${createAndEnter}
						title=${t("A new branch from {branch} in its own folder; this chat and its draft move into it", { branch: gitStatus.branch || "HEAD" })}>
						<${Icon} name="layers" size=${13} /><span class="truncate">${t("Create and enter a copy")}</span>${busy === "copy" ? html`<${Spinner} size=${13} />` : null}</button>`}
			</div>
			<${Collapse} open=${creating}>
				<form class="branch-form" onSubmit=${(e) => (e.preventDefault(), create())}>
					<input class="field sm grow" value=${newName} placeholder=${t("branch name")} aria-label=${t("Branch name")} autofocus
						onInput=${(e) => setNewName(e.target.value)} />
					<button class="btn sm primary" type="submit" disabled=${disabled || !newName.trim()}>${busy === "create" ? html`<${Spinner} size=${12} />` : null}${t("Create")}</button>
				</form>
				<div class="branch-hint dim">${t("Starts from the commit checked out now and switches to it.")}</div>
			<//>
		</div>
	</div>`;
}

/**
 * Beside the branch chip while the chat runs in a copy: one click merges the copy back into main (the server commits
 * the copy's open files first when the user agreed, never leaves a conflict behind) and the chat continues in the main
 * copy with its history and draft. A conflict stops and asks: keep the copy's side, keep main's side, or let the agent
 * merge main into the copy and resolve it. A merged copy is a read-only record; the chip then leads back to main.
 */
export function MergeBackChip({ gitStatus }) {
	const anchor = useRef(null);
	const slot = useStore((s) => s.activeSlot);
	const running = useStore((s) => !!s.snap?.active);
	const [open, setOpen] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const merged = !!gitStatus.copyMerged;
	const label = gitStatus.copyName || gitStatus.branch || "";
	// Merged copies only lead back to main: the chat moves with its history, nothing is written in the copy.
	const goBack = async () => {
		if (running || leaving) return;
		setLeaving(true);
		const listing = await attempt(() => api("/api/git/worktrees", { slot }));
		const main = listing?.worktrees?.find((w) => w.isMain);
		if (main) {
			carryDraftFrom(state.snap?.session?.id);
			const ok = await attempt(() => post("/api/git/worktrees/enter", { path: main.path, carryHistory: true }, slot));
			if (!ok) dropCarriedDraft();
			else {
				await loadGitStatus();
				window.dispatchEvent(new CustomEvent("myharness:git-changed", { detail: { slot } }));
				toast(t("Back in the main copy"), "info", 3500);
			}
		}
		setLeaving(false);
	};
	if (merged) {
		return html`<button class="env-chip merge-chip merged" disabled=${running || leaving} onClick=${goBack}
			title=${t("“{name}” was merged into main and is read-only here. Click to continue this chat in the main copy.", { name: label })}>
			${leaving ? html`<${Spinner} size=${12} />` : html`<${Icon} name="checkCircle" size=${12} />`}<span class="truncate merge-chip-text">${t("Merged · back to main")}</span>
		</button>`;
	}
	return html`<span ref=${anchor} class="merge-anchor">
		<button class="env-chip merge-chip" onClick=${() => setOpen(!open)} aria-haspopup="dialog" aria-expanded=${open}
			title=${t("Merge “{name}” into main and continue this chat there", { name: label })}>
			<${Icon} name="gitMerge" size=${12} /><span class="truncate merge-chip-text">${t("Merge into main")}</span>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="start" width=${300} maxHeight=${420} class="branch-pop">
			<${MergeBackPanel} key=${slot} slot=${slot} label=${label} running=${running} close=${() => setOpen(false)} />
		<//>
	</span>`;
}

function MergeBackPanel({ slot, label, running, close }) {
	const [copy, setCopy] = useState(null);
	const [readError, setReadError] = useState("");
	const [busy, setBusy] = useState("");
	// null: confirm; { conflict: files } or { error } after a refused merge.
	const [outcome, setOutcome] = useState(null);
	useEffect(() => {
		api("/api/git/worktrees", { slot })
			.then((data) => setCopy(data.worktrees?.find((w) => w.current) || null))
			.catch((e) => setReadError(serverText(e.message, t("Cannot list worktrees."))));
	}, []);
	const merge = async (strategy) => {
		if (running || busy) return;
		setBusy(strategy || "merge");
		carryDraftFrom(state.snap?.session?.id);
		let result;
		try {
			result = await post("/api/git/worktrees/merge-back", { commitChanges: true, ...(strategy ? { strategy } : {}) }, slot);
		} catch (e) {
			result = { status: "failed", error: e.rawMessage || e.message };
		}
		setBusy("");
		if (result?.status !== "merged") {
			dropCarriedDraft();
			setOutcome(result?.status === "conflict" ? { conflict: result.files || [], error: result.error } : { error: serverText(result?.error || "", t("The operation failed.")) });
			return;
		}
		if (!result.returned) dropCarriedDraft();
		close();
		await loadGitStatus();
		window.dispatchEvent(new CustomEvent("myharness:git-changed", { detail: { slot } }));
		if (result.returned) toast(t("Merged into main; the chat continues in the main copy"), "info", 5000);
		else toast(t("Merged into main, but the chat could not move back: {error}", { error: serverText(result.returnError || "") }), "warning", 9000);
	};
	const askAgent = async (files) => {
		close();
		await actions.send(t("Merge main into this branch (git merge main) and resolve the conflicts in: {files}. Keep what both sides need, check the result, and commit it. Then tell me so I can merge back.", { files: files.join(", ") || "-" }));
	};
	const nothing = copy && copy.ahead === 0 && copy.changes === 0;
	return html`<div class="branch-menu merge-panel" role="dialog" aria-label=${t("Merge into main")}>
		<div class="merge-title"><${Icon} name="gitMerge" size=${13} /><span class="truncate">${t("Merge “{name}” into main", { name: label })}</span></div>
		${running ? html`<div class="branch-note dim">${t("Available when the agent is idle")}</div>` : null}
		${outcome?.conflict
			? html`<div class="branch-note branch-delete-panel" role="alert">
				<strong>${t("Conflicting files: {n}. Main is unchanged.", { n: outcome.conflict.length })}</strong>
				${outcome.conflict.length ? html`<ul class="merge-files">${outcome.conflict.slice(0, 8).map((file) => html`<li class="truncate" title=${file}>${file}</li>`)}${outcome.conflict.length > 8 ? html`<li class="dim">${t("…and {n} more", { n: outcome.conflict.length - 8 })}</li>` : null}</ul>` : null}
				<div class="branch-form">
					<button class="btn sm" disabled=${running || !!busy} onClick=${() => merge("theirs")}>${busy === "theirs" ? html`<${Spinner} size=${12} />` : null}${t("Keep the copy's version")}</button>
					<button class="btn sm" disabled=${running || !!busy} onClick=${() => merge("ours")}>${busy === "ours" ? html`<${Spinner} size=${12} />` : null}${t("Keep main's version")}</button>
					<button class="btn sm primary" disabled=${running || !!busy} onClick=${() => askAgent(outcome.conflict)}>${t("Let the agent resolve it")}</button>
					<button class="btn sm branch-delete-cancel" disabled=${!!busy} onClick=${close}>${t("Cancel")}</button>
				</div>
			</div>`
			: html`<div class="branch-note merge-facts">
				${readError ? html`<span class="c-danger">${readError}</span>`
					: !copy ? html`<${Spinner} size=${12} />${t("Loading…")}`
					: html`<span>${workText(copy)}</span>`}
			</div>
			${copy?.changes > 0 ? html`<div class="branch-note">${t("Uncommitted files are committed in the copy first.")}</div>` : null}
			${nothing ? html`<div class="branch-note">${t("Nothing to merge; the copy will be marked merged.")}</div>` : null}
			${outcome?.error ? html`<div class="branch-note c-danger" role="alert">${outcome.error}</div>` : null}
			<div class="branch-form merge-actions">
				<button class="btn sm primary" disabled=${running || !!busy || !copy} onClick=${() => merge()}>${busy ? html`<${Spinner} size=${12} />` : null}${outcome?.error ? t("Retry") : t("Merge into main")}</button>
				<button class="btn sm" disabled=${!!busy} onClick=${close}>${t("Cancel")}</button>
			</div>`}
	</div>`;
}
