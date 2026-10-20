// The branch chip above the input and its popover: search the local branches, switch, create and delete them, and move
// this chat into an isolated copy of the repository (a Git worktree) or back to the main copy. Every action calls the
// server's Git routes (routes-git.ts), which use Git's own rules; nothing here decides what Git allows.
import { html, useEffect, useMemo, useRef, useState, afterPaint, Chevron, Collapse, COLLAPSE_MS, Icon, Popover, Spinner, Toggle } from "./ui.js";
import { api, attempt, loadGitStatus, post, state, toast, useStore } from "./store.js";
import { rankSearch } from "./search.js";
import { relTime } from "./util.js";
import { getLang, serverText, t } from "./i18n.js";
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

export function BranchChip({ gitStatus }) {
	const anchor = useRef(null);
	const slot = useStore((s) => s.activeSlot);
	// Keep data outside the popover's lifetime, but never reuse it for a different Chat.
	const branchSource = useMemo(() => {
		const source = { data: null, pending: null, loadedAt: 0 };
		source.load = (force = false) => {
			if (!force && source.data && Date.now() - source.loadedAt < 1000) return Promise.resolve(source.data);
			if (!source.pending) {
				source.pending = api("/api/git/branches", { slot }).then((data) => {
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
		// Start before the first click; status updates also refresh changes made outside this menu.
		branchSource.load().catch(() => {});
	}, [branchSource, gitStatus]);
	const [open, setOpen] = useState(false);
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
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="start" width=${330} maxHeight=${480} class="branch-pop">
			<${BranchMenu} key=${slot} gitStatus=${gitStatus} branchSource=${branchSource} slot=${slot} close=${() => setOpen(false)} />
		<//>
	</span>`;
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
	const [busy, setBusy] = useState("");
	const deletePending = useRef(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [confirm, setConfirm] = useState("");
	// Refusals and force confirmation stay visible until cancelled or successfully deleted; pointer movement never clears them.
	const [branchDeletion, setBranchDeletion] = useState(null);
	const [removing, setRemoving] = useState("");
	const [worktreesOpen, setWorktreesOpen] = useState(linked);
	const [agentsOpen, setAgentsOpen] = useState(false);
	// The active copies fold like the sub-agent group does; archived ones start folded so a long list stays readable.
	const [mineOpen, setMineOpen] = useState(true);
	const [archivedOpen, setArchivedOpen] = useState(false);
	// `{ force, failed, error }` while the clear-archived confirmation is on screen, `null` when it is closed.
	const [archiveClear, setArchiveClear] = useState(null);
	const [fresh, setFresh] = useState("");
	const [naming, setNaming] = useState(null);
	const [displayName, setDisplayName] = useState("");
	const [confirmCopy, setConfirmCopy] = useState("");
	const [discarding, setDiscarding] = useState(false);
	const [deletingCopy, setDeletingCopy] = useState(null);
	const [copyFailure, setCopyFailure] = useState(null);
	const [targetCopy, setTargetCopy] = useState(null);
	const deletionPanel = useRef(null);
	const copyDeletionPanel = useRef(null);
	const copies = useRef(null);
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
			const data = fresh ? await api("/api/git/worktrees", { slot }) : await worktreeReads.load(slot, () => api("/api/git/worktrees", { slot }));
			setWorktrees({ list: data.worktrees || [] });
		} catch (e) {
			setWorktrees({ list: [], error: serverText(e.message, t("Cannot list worktrees.")) });
		}
	};
	// Reading the list already archived finished copies; this releases the branches of the clean ones. Once per open:
	// a running task or an untrusted project just leaves them attached for the next try.
	const archiveSynced = useRef(false);
	const syncArchive = async () => {
		if (archiveSynced.current) return;
		archiveSynced.current = true;
		try {
			const result = await post("/api/git/worktrees/archive-sync", {}, slot);
			if (result?.released) await loadWorktrees(true);
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
	// The only step that deletes archived copies; a copy that still holds work is reported first and needs force.
	const clearArchived = async (force = false) => {
		if (busy) return;
		setBusy("archive-clear");
		try {
			const result = await post("/api/git/worktrees/archive/clear", { force }, slot);
			const failed = result?.failed || [];
			await Promise.all([loadWorktrees(true), load(true)]);
			if (failed.length) {
				setArchiveClear({ force, failed, error: "" });
				toast(
					t("{count} archived copies still hold uncommitted changes and were kept.", { count: failed.length }),
					"warning",
					8000,
				);
			} else {
				setArchiveClear(null);
				toast(t("Archived copies cleared"), "info", 3500);
			}
		} catch (e) {
			setArchiveClear({ force, failed: [], error: serverText(e.message, t("Cannot clear archived copies.")) });
		} finally {
			setBusy("");
		}
	};
	useEffect(() => {
		load();
		// Opening the branch popover expresses intent; avoid prefetching every Chat at startup.
		loadWorktrees().then(() => syncArchive());
	}, []);
	useEffect(() => {
		if (worktreesOpen) loadWorktrees().then(() => syncArchive());
	}, [worktreesOpen]);
	useEffect(() => {
		if (!branchDeletion) return;
		// A refusal adds the panel after the request; reveal it and put the keyboard on the safe option.
		deletionPanel.current?.scrollIntoView({ block: "nearest" });
		deletionPanel.current?.querySelector(".branch-delete-cancel")?.focus({ preventScroll: true });
	}, [branchDeletion]);
	useEffect(() => {
		if (!targetCopy || !worktreesOpen || !worktrees) return;
		// Collapse mounts its children after the parent effect can run; wait for its mount/paint and observe late lists.
		const reveal = () => {
			const row = [...(copies.current?.querySelectorAll("[data-copy-path]") || [])].find((el) => sameCopyPath(el.dataset.copyPath, targetCopy.path) || el.dataset.copyBranch === targetCopy.branch);
			if (!row) return;
			row.scrollIntoView({ block: "nearest", behavior: "smooth" });
			row.focus({ preventScroll: true });
			observer.disconnect();
		};
		const observer = new MutationObserver(reveal);
		observer.observe(list.current.closest(".branch-menu"), { childList: true, subtree: true });
		const cancelPaint = afterPaint(reveal);
		return () => { observer.disconnect(); cancelPaint(); };
	}, [targetCopy, worktreesOpen, worktrees]);
	useEffect(() => {
		if (!deletingCopy) return;
		copyDeletionPanel.current?.scrollIntoView({ block: "nearest" });
		copyDeletionPanel.current?.querySelector(".branch-delete-cancel")?.focus({ preventScroll: true });
	}, [deletingCopy, copyFailure]);

	const branches = useMemo(() => rankSearch((data?.branches || []).filter((b) => b.current || !isSubagentBranch(b.name)), query, { names: (b) => [b.name] }), [data, query]);
	const exact = branches.some((b) => b.name === query.trim());
	// Rows the keyboard moves over: the branches, then "New branch".
	const rows = data ? [...branches.map((b) => ({ kind: "branch", branch: b })), { kind: "new" }] : [];
	useEffect(() => setSel(0), [query]);
	useEffect(() => {
		list.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel]);

	const done = async (message) => {
		await loadGitStatus();
		// Switching branches or deleting a copy rewrites files on disk; tell the mounted panels to reload them.
		window.dispatchEvent(new CustomEvent("myharness:git-changed", { detail: { slot } }));
		if (message) toast(message, "info", 3500);
	};
	// `carryHistory`: the chat (history and unsent draft) moves along instead of a new empty chat opening there.
	const enterCopy = async (path, message, carryHistory = false) => {
		setBusy(`w:${path}`);
		if (carryHistory) carryDraftFrom(state.snap?.session?.id);
		const ok = await attempt(() => post("/api/git/worktrees/enter", { path, ...(carryHistory ? { carryHistory: true } : {}) }));
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
	const cancelBranchDeletion = () => { setBranchDeletion(null); setConfirm(""); };
	const prepareForceBranch = (branch) => {
		if (running || busy || deletePending.current || branch.current) return;
		setConfirm("");
		setBranchDeletion((previous) => ({ branch, failure: previous?.branch.name === branch.name ? previous.failure : null, forceConfirm: true }));
	};
	const remove = async (branch, force = false, retry = false) => {
		if (running || busy || deletePending.current || branch.current) return;
		if (force && (!branchDeletion?.forceConfirm || branchDeletion.branch.name !== branch.name)) return prepareForceBranch(branch);
		if (!force && !retry && branch.worktreePath) {
			setBusy(`d:${branch.name}`);
			const listing = await api("/api/git/worktrees", { slot }).catch(() => null);
			setBusy("");
			if (listing) setWorktrees({ list: listing.worktrees || [] });
			const copy = listing?.worktrees?.find((w) => sameCopyPath(w.path, branch.worktreePath));
			const protectedCopy = !listing || copy?.isMain || copy?.current || copy?.locked;
			const failure = protectedCopy
				? { ...explainDeleteFailure({ detail: !listing ? "Cannot reach the MyHarness server" : copy?.locked ? "The worktree is locked." : "The main worktree cannot be deleted." }, "copy"), occupied: true, worktreePath: branch.worktreePath }
				: explainDeleteFailure({ detail: `used by worktree at '${branch.worktreePath}'` }, "branch");
			setConfirm("");
			setBranchDeletion({ branch, failure, forceConfirm: !protectedCopy });
			return;
		}
		if (!force && !retry && confirm !== branch.name) {
			cancelBranchDeletion();
			return setConfirm(branch.name);
		}
		setConfirm("");
		deletePending.current = true;
		setBusy(`d:${branch.name}`);
		const cascade = force && branchDeletion?.failure?.occupied && branchDeletion.failure.canForce;
		const err = await tryPost("/api/git/branches/delete", { name: branch.name, ...(force ? { force: true } : {}), ...(cascade ? { deleteWorktrees: true } : {}) });
		deletePending.current = false;
		setBusy("");
		if (err) {
			const failure = { ...err, ...explainDeleteFailure(err, "branch", force) };
			setBranchDeletion({ branch, failure, forceConfirm: force && !!failure.canForce });
			toast(failure.message, "error", 9000);
			return;
		}
		cancelBranchDeletion();
		setTargetCopy(null);
		if (cascade) {
			setDeletingCopy(null);
			setCopyFailure(null);
			setNaming(null);
			await Promise.all([load(true), loadWorktrees()]);
			await done(t("Deleted branch {branch}", { branch: branch.name }));
			return;
		}
		// The row folds away first, then the list is read again.
		setRemoving(branch.name);
		setTimeout(async () => {
			await load(true);
			setRemoving("");
		}, COLLAPSE_MS);
		toast(t("Deleted branch {branch}", { branch: branch.name }), "info", 3500);
		if (worktrees) loadWorktrees();
		await done();
	};
	const goToCopy = async () => {
		if (!branchDeletion || busy) return;
		const { branch, failure } = branchDeletion;
		// Navigation is read-only: clear the branch search, reveal copies and focus the matching row, never delete anything.
		setQuery("");
		setWorktreesOpen(true);
		setTargetCopy({ branch: branch.name, path: failure?.worktreePath || branch.worktreePath });
		await loadWorktrees();
	};
	const copiesList = worktrees?.list || [];
	const main = copiesList.find((w) => w.isMain);
	// The main copy is always first; copies the user made follow (current, with work, clean, merged last); sub-agent
	// copies sit in their own group at the bottom, folded by default.
	const rank = (w) => (w.current ? 0 : w.merged ? 3 : holdsWork(w) ? 1 : 2);
	const mine = copiesList.filter((w) => !w.isMain && !w.subagent && !w.archived).sort((a, b) => rank(a) - rank(b));
	const agentCopies = copiesList.filter((w) => !w.isMain && w.subagent && !w.archived);
	// Newest archived copy first: the copy finished most recently is the one worth checking first.
	const archivedCopies = copiesList
		.filter((w) => !w.isMain && w.archived)
		.sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")));
	const isTarget = (w) => !!targetCopy && (sameCopyPath(w.path, targetCopy.path) || w.branch === targetCopy.branch);
	const targetWorktree = targetCopy && copiesList.find(isTarget);
	const targetProtection = targetWorktree?.isMain || targetWorktree?.current
		? explainDeleteFailure({ detail: "The main worktree cannot be deleted." }, "copy").message
		: "";
	useEffect(() => {
		if (targetWorktree?.subagent) setAgentsOpen(true);
	}, [targetWorktree]);

	// The copy gets its formal name from the main Agent once the chat is in it; until then the branch name stands in.
	// A name the user typed in the meantime is never replaced, and a busy or failed request keeps the temporary name.
	const nameInBackground = async (w) => {
		try {
			const result = await post("/api/git/worktrees/name-ai", { path: w.path, language: getLang() }, slot);
			if (!result?.name) return;
			const listing = await api("/api/git/worktrees", { slot });
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
		const created = await attempt(() => post("/api/git/worktrees/create", { branch, newBranch: true, base: "head" }));
		if (!created?.worktree?.path) {
			setBusy("");
			return;
		}
		const path = created.worktree.path;
		setFresh(path);
		setWorktreesOpen(true);
		await loadWorktrees(true);
		carryDraftFrom(state.snap?.session?.id);
		const entered = await attempt(() => post("/api/git/worktrees/enter", { path, carryHistory: true }));
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
		await loadWorktrees(true);
		nameInBackground(created.worktree);
	};
	const backToMain = () => main && enterCopy(main.path, t("Back in the main copy"), true);

	const deleteCopy = async (w, force = false) => {
		if (!w || w.isMain || w.current || running || busy || deletePending.current) return;
		deletePending.current = true;
		setBusy(`delete:${w.path}`);
		const err = await tryPost("/api/git/worktrees/delete", { path: w.path, ...(force ? { force: true } : {}) });
		deletePending.current = false;
		setBusy("");
		if (err) {
			const failure = { ...err, ...explainDeleteFailure(err, "copy", force) };
			setConfirmCopy("");
			setDiscarding(false);
			setDeletingCopy(w);
			setCopyFailure(failure);
			// Unknown, permission, locked and busy errors do NOT mean dirty; force cannot be offered for them.
			toast(failure.message, "error", 9000);
			return;
		}
		setCopyFailure(null);
		setDeletingCopy(null);
		setConfirmCopy("");
		setDiscarding(false);
		setTargetCopy(null);
		if (naming?.path === w.path) setNaming(null);
		await Promise.all([loadWorktrees(true), load(true)]);
		await done(t("Copy deleted"));
	};
	const cancelCopyDeletion = () => {
		setDeletingCopy(null);
		setCopyFailure(null);
		setDiscarding(false);
		setConfirmCopy("");
	};
	// A merged or clean copy is deleted after one confirming click; a copy that holds work opens the choices panel.
	const askDeleteCopy = (w) => {
		if (holdsWork(w)) {
			setConfirmCopy("");
			setCopyFailure(null);
			setDiscarding(false);
			setDeletingCopy(w);
			return;
		}
		if (confirmCopy === w.path) return deleteCopy(w);
		cancelCopyDeletion();
		setConfirmCopy(w.path);
	};
	const mergeFirst = async (w) => {
		cancelCopyDeletion();
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

	const activate = (row) => (row.kind === "new" ? startNew() : switchTo(row.branch));
	const onSearchKey = (event) => {
		if (event.isComposing || disabled || !rows.length) return;
		if (event.key === "ArrowDown") return event.preventDefault(), setSel((sel + 1) % rows.length);
		if (event.key === "ArrowUp") return event.preventDefault(), setSel((sel - 1 + rows.length) % rows.length);
		if (event.key === "Enter") return event.preventDefault(), rows[sel] && activate(rows[sel]);
	};
	const disabled = running || !!busy || !data;

	const copyRow = (w, archived = false) => {
		const work = holdsWork(w);
		const highlighted = isTarget(w) || (!!fresh && sameCopyPath(w.path, fresh));
		const rowBusy = busy === `w:${w.path}` || busy === `delete:${w.path}` || busy === `start:${w.path}`;
		return html`<div key=${w.path} data-copy-path=${w.path} data-copy-branch=${w.branch} tabindex=${isTarget(w) ? "-1" : undefined}
			class=${`pop-item branch-copy ${w.current ? "active" : ""} ${highlighted ? "branch-copy-target" : ""}`} title=${w.path}>
			<${Icon} name=${w.isMain ? "folder" : "layers"} size=${13} />
			<span class="col branch-copy-info">
				<span class="branch-copy-title"><span class="truncate">${copyLabel(w)}</span>${archived
					? html`<span class="copy-state" title=${w.archivedAt ? t("Archived {when}: kept on disk, nothing deleted", { when: relTime(w.archivedAt) }) : t("Kept on disk, nothing deleted")}>${t("Archived")}</span>`
					: w.merged
						? html`<span class="copy-state ok" title=${t("Merged into main; kept as a read-only record")}>${t("Merged")}</span>`
						: work ? html`<span class="copy-state warn" title=${workText(w)}>${t("Unmerged")}</span>` : null}</span>
				<span class="dim truncate branch-copy-path">${shortPath(w.path)}</span>
			</span>
			${confirmCopy === w.path ? html`<button class="branch-confirm" disabled=${disabled} onClick=${() => deleteCopy(w)}>${t("Delete?")}</button>` : null}
			${rowBusy ? html`<${Spinner} size=${13} />` : w.current ? html`<${Icon} name="check" size=${14} class="branch-check" />` : null}
			<div class="branch-copy-actions">
				${w.current ? null : html`<button class="icon-btn sm" disabled=${disabled} title=${w.isMain && linked ? t("Back to the main copy") : t("Enter to edit")} aria-label=${w.isMain && linked ? t("Back to the main copy") : t("Enter to edit")} onClick=${() => (w.isMain && linked ? backToMain() : enterCopy(w.path))}><${Icon} name="arrowRight" size=${13} /></button>`}
				${archived
					? html`<button class="icon-btn sm" disabled=${!!busy} title=${t("Restore copy")} aria-label=${t("Restore copy")} onClick=${() => restoreCopy(w)}><${Icon} name="undo" size=${13} /></button>`
					: !w.isMain ? html`<button class="icon-btn sm" disabled=${!!busy} title=${t("Start copy")} aria-label=${t("Start copy")} onClick=${() => startCopy(w)}><${Icon} name="play" size=${13} /></button>
				<button class="icon-btn sm" disabled=${!!busy} title=${t("Rename copy")} aria-label=${t("Rename copy")} onClick=${() => { setNaming(w); setDisplayName(w.displayName || w.branch || ""); }}><${Icon} name="edit" size=${13} /></button>` : null}
				<button class="icon-btn sm" title=${t("Copy path")} aria-label=${t("Copy path")} onClick=${() => copyPath(w)}><${Icon} name="copy" size=${13} /></button>
				${!w.isMain && confirmCopy !== w.path ? html`<button class="icon-btn sm" disabled=${disabled || w.current} title=${w.current ? t("Return to the main copy before deleting this one") : t("Delete copy")} aria-label=${t("Delete copy")} onClick=${() => askDeleteCopy(w)}><${Icon} name="trash" size=${13} /></button>` : null}
			</div>
		</div>`;
	};

	return html`<div class="branch-menu" role="dialog" aria-label=${t("Branches")}>
		<div class="pop-search"><${Icon} name="search" size=${13} /><input autofocus value=${query} placeholder=${t("Search branches")} aria-label=${t("Search branches")}
			onInput=${(e) => setQuery(e.target.value)} onKeyDown=${onSearchKey} /></div>
		${running ? html`<div class="branch-note dim">${t("Branches can be changed when the agent is idle")}</div>` : null}
		<div class="pop-group">${t("Local branches")}</div>
		<div class="pop-scroll branch-list" ref=${list} role="listbox" aria-label=${t("Local branches")}>
			${error ? html`<div class="branch-note c-danger">${error}</div>` : !data ? html`<div class="branch-note dim"><${Spinner} /> ${t("Loading…")}</div>` : !branches.length ? html`<div class="branch-note dim">${t("No branch matches")}</div>` : null}
			${branches.map((b, i) => {
				const rowBusy = busy === `b:${b.name}` || busy === `d:${b.name}` || busy === `w:${b.worktreePath}`;
				const elsewhere = b.worktreePath && !b.current;
				return html`<${Collapse} key=${b.name} open=${removing !== b.name}>
					<div data-row=${i} role="option" aria-selected=${b.current} class=${`pop-item branch-row ${sel === i ? "hi" : ""} ${b.current ? "active" : ""} ${known.current && !known.current.has(b.name) ? "fade-in" : ""}`}
						onMouseMove=${() => sel !== i && setSel(i)} onClick=${() => !disabled && switchTo(b)} aria-disabled=${disabled && !b.current}>
						<${Icon} name=${elsewhere ? "layers" : "gitBranch"} size=${13} class="branch-ico" />
						<span class="branch-name truncate" title=${b.subject ? `${b.name} — ${b.subject}` : b.name}>${b.name}</span>
						${elsewhere ? html`<span class="badge" title=${b.worktreePath}>${t("worktree")}</span>` : null}
						<span class="grow" />
						${confirm === b.name
							? html`<button class="branch-confirm" disabled=${disabled} onClick=${(e) => (e.stopPropagation(), remove(b))}>${t("Delete?")}</button>`
							: branchDeletion?.branch.name === b.name && branchDeletion.failure?.canForce
								? html`<button class="branch-confirm" disabled=${disabled} onClick=${(e) => (e.stopPropagation(), branchDeletion.forceConfirm ? remove(b, true) : prepareForceBranch(b))}>${t(branchDeletion.failure?.occupied ? "Force delete branch and copies" : "Force delete branch")}</button>`
								: html`<span class="dim branch-time">${relTime(b.committedAt)}</span>`}
						${rowBusy ? html`<${Spinner} size=${13} />` : b.current ? html`<${Icon} name="check" size=${14} class="branch-check" />` : confirm !== b.name && branchDeletion?.branch.name !== b.name ? html`<button class="icon-btn sm branch-del" title=${t("Delete branch")} aria-label=${t("Delete branch {branch}", { branch: b.name })} disabled=${disabled} onClick=${(e) => (e.stopPropagation(), remove(b))}><${Icon} name="trash" size=${13} /></button>` : null}
					</div>
				<//>`;
			})}
		</div>
		${branchDeletion ? html`<div ref=${deletionPanel} class="branch-note branch-delete-panel" role="group" aria-label=${t("Delete branch?")}>
			<strong>${t("Delete branch “{branch}”?", { branch: branchDeletion.branch.name })}</strong>
			${branchDeletion.failure ? html`<div class="c-danger" role="alert">${branchDeletion.failure.message}</div>` : null}
			${!branchDeletion.failure?.occupied && (branchDeletion.failure?.canForce || branchDeletion.forceConfirm) ? html`<div>${t("Force deletion only removes this branch, never a copy. Work that has not been merged elsewhere may no longer be reachable from a branch. Cancel if you want to keep it.")}</div>` : null}
			${!branchDeletion.failure?.occupied && branchDeletion.forceConfirm ? html`<div>${t("Confirm force deletion of this branch?")}</div>` : null}
			${branchDeletion.failure?.detail ? html`<details class="branch-delete-details"><summary>${t("Error details")}</summary><div class="pre-wrap">${branchDeletion.failure.detail}</div></details>` : null}
			<div class="branch-form">
				${branchDeletion.failure?.canForce || branchDeletion.forceConfirm ? html`<button class="btn sm danger solid" disabled=${disabled} onClick=${() => branchDeletion.forceConfirm ? remove(branchDeletion.branch, true) : prepareForceBranch(branchDeletion.branch)}>${t(branchDeletion.failure?.occupied ? "Force delete branch and copies" : "Force delete branch")}</button>` : !branchDeletion.failure?.occupied ? html`<button class="btn sm" disabled=${disabled} onClick=${() => remove(branchDeletion.branch, false, true)}>${t("Retry delete")}</button>` : null}
				${branchDeletion.failure?.occupied ? html`<button class="btn sm" disabled=${!!busy} onClick=${goToCopy}>${t("Go to the copy")}</button>` : null}
				<button class="btn sm branch-delete-cancel" disabled=${!!busy} onClick=${cancelBranchDeletion}>${t("Cancel")}</button>
			</div>
		</div>` : null}
		<div class="branch-foot">
			<button data-row=${rows.length - 1} class=${`pop-item branch-new ${data && sel === rows.length - 1 ? "hi" : ""}`} disabled=${disabled} onClick=${startNew} onMouseMove=${() => sel !== rows.length - 1 && setSel(rows.length - 1)} aria-expanded=${creating}>
				<${Icon} name="plus" size=${13} /><span class="truncate">${query.trim() && !exact ? t("New branch “{name}”", { name: query.trim() }) : t("New branch")}</span>
			</button>
			<${Collapse} open=${creating}>
				<form class="branch-form" onSubmit=${(e) => (e.preventDefault(), create())}>
					<input class="field sm grow" value=${newName} placeholder=${t("branch name")} aria-label=${t("Branch name")} autofocus
						onInput=${(e) => setNewName(e.target.value)} />
					<button class="btn sm primary" type="submit" disabled=${disabled || !newName.trim()}>${busy === "create" ? html`<${Spinner} size=${12} />` : null}${t("Create")}</button>
				</form>
				<div class="branch-hint dim">${t("Starts from the commit checked out now and switches to it.")}</div>
			<//>
		</div>
		<div class="branch-wt">
			<button class="pop-item branch-wt-heading" aria-expanded=${worktreesOpen} onClick=${() => setWorktreesOpen(!worktreesOpen)}>
				<${Chevron} /><span>${t("Worktree")}</span>
			</button>
			<${Collapse} open=${worktreesOpen}>
			${linked
				? html`<button class="pop-item branch-wt-action" disabled=${disabled || !main} onClick=${backToMain} title=${t("This chat and its draft move back to the main copy")}>
					<${Icon} name="arrowLeft" size=${13} /><span class="truncate">${t("Back to the main copy")}</span><span class="grow" />${main && busy === `w:${main.path}` ? html`<${Spinner} size=${13} />` : null}</button>`
				: html`<button class="pop-item branch-wt-action" disabled=${disabled || !worktrees || !!worktrees.error} onClick=${createAndEnter}
					title=${t("A new branch from {branch} in its own folder; this chat and its draft move into it", { branch: gitStatus.branch || "HEAD" })}>
					<${Icon} name="layers" size=${13} /><span class="truncate">${t("Create and enter a copy")}</span><span class="grow" />${busy === "copy" ? html`<${Spinner} size=${13} />` : null}</button>`}
			${worktrees?.error ? html`<div class="branch-note c-danger">${worktrees.error}</div>` : null}
			${targetCopy ? html`<div class="branch-hint">${targetProtection || t("Review the copy for “{branch}” below. Nothing is deleted by going here.", { branch: targetCopy.branch })}</div>` : null}
			<div class="branch-copy-region" ref=${copies}>
				${!worktrees ? html`<div class="branch-note dim"><${Spinner} />${t("Loading…")}</div>` : null}
				${main ? html`<div class="branch-copies">${copyRow(main)}</div>` : null}
				${mine.length ? html`<button class="pop-group branch-wt-group" aria-expanded=${mineOpen} onClick=${() => setMineOpen(!mineOpen)}>
					<${Chevron} /><span>${t("My copies")}</span><span class="badge">${mine.length}</span></button>
					<${Collapse} open=${mineOpen}><div class="branch-copies">${mine.map((w) => copyRow(w))}</div><//>` : null}
				${agentCopies.length ? html`<button class="pop-group branch-wt-group" aria-expanded=${agentsOpen} onClick=${() => setAgentsOpen(!agentsOpen)}>
					<${Chevron} /><span>${t("Sub-agent copies")}</span><span class="badge">${agentCopies.length}</span></button>
					<${Collapse} open=${agentsOpen}><div class="branch-copies">${agentCopies.map((w) => copyRow(w))}</div><//>` : null}
				${archivedCopies.length ? html`<button class="pop-group branch-wt-group" aria-expanded=${archivedOpen} onClick=${() => setArchivedOpen(!archivedOpen)}>
					<${Chevron} /><span>${t("Archived copies")}</span><span class="badge">${archivedCopies.length}</span></button>
					<${Collapse} open=${archivedOpen}>
						<div class="branch-copies">${archivedCopies.map((w) => copyRow(w, true))}</div>
						<div class="branch-form"><button class="btn sm danger" disabled=${disabled} onClick=${() => setArchiveClear({ force: false, failed: [], error: "" })}>${t("Clear archived copies")}</button></div>
					<//>` : null}
			</div>
			${archiveClear ? html`<div class="branch-note branch-delete-panel" role="group" aria-label=${t("Clear archived copies?")}>
				<strong>${t("Delete every archived copy?")}</strong>
				<div>${t("Their folders are removed from disk. This is the only action that deletes archived work; archiving itself never does.")}</div>
				${archiveClear.error ? html`<div class="c-danger" role="alert">${archiveClear.error}</div>` : null}
				${archiveClear.failed.length ? html`<div class="c-danger" role="alert">${t("{count} copies still hold uncommitted changes and were kept. Force clearing discards them permanently.", { count: archiveClear.failed.length })}</div>` : null}
				<div class="branch-form">
					${archiveClear.failed.length
						? html`<button class="btn sm danger solid" disabled=${disabled} onClick=${() => clearArchived(true)}>${t("Force clear archived copies")}</button>`
						: html`<button class="btn sm danger" disabled=${disabled} onClick=${() => clearArchived(false)}>${t("Clear archived copies")}</button>`}
					<button class="btn sm" disabled=${!!busy} onClick=${() => setArchiveClear(null)}>${t("Cancel")}</button>
				</div>
			</div>` : null}
			${deletingCopy ? html`<div ref=${copyDeletionPanel} class="branch-note branch-delete-panel" role="group" aria-label=${t("Delete copy?")}>
				<strong>${t("Delete copy “{name}”?", { name: copyLabel(deletingCopy) })}</strong>
				${copyFailure
					? html`<div class="c-danger" role="alert">${copyFailure.message}</div><details class="branch-delete-details"><summary>${t("Error details")}</summary><div class="pre-wrap">${copyFailure.detail}</div></details>
						${copyFailure.canForce ? html`<div>${t("Force delete permanently discards this copy's folder, including uncommitted changes and new files. Its branch is kept. Cancel if you want to keep the files.")}</div>` : null}
						${copyFailure.canForce && discarding ? html`<div class="c-danger">${t("Confirm force deletion of this copy and all uncommitted changes inside it?")}</div>` : null}
						<div class="branch-form">${copyFailure.canForce
							? html`<button class=${`btn sm danger ${discarding ? "solid" : ""}`} disabled=${disabled || deletingCopy.current} onClick=${() => (discarding ? deleteCopy(deletingCopy, true) : setDiscarding(true))}>${busy === `delete:${deletingCopy.path}` ? html`<${Spinner} size=${13} />` : t("Force delete copy")}</button>`
							: html`<button class="btn sm danger" disabled=${disabled || deletingCopy.current} onClick=${() => deleteCopy(deletingCopy)}>${t("Retry delete")}</button>`}<button class="btn sm branch-delete-cancel" disabled=${!!busy} onClick=${cancelCopyDeletion}>${t("Cancel")}</button></div>`
					: html`<div>${workText(deletingCopy)}</div>
						${discarding ? html`<div class="c-danger" role="alert">${t("Discarding permanently deletes the copy's folder and its uncommitted changes. Its branch and commits are kept. Discard?")}</div>` : null}
						<div class="branch-form">
							<button class="btn sm primary" disabled=${disabled} onClick=${() => mergeFirst(deletingCopy)}>${t("Merge it now")}</button>
							<button class=${`btn sm danger ${discarding ? "solid" : ""}`} disabled=${disabled || deletingCopy.current} onClick=${() => (discarding ? deleteCopy(deletingCopy, deletingCopy.changes !== 0) : setDiscarding(true))}>${busy === `delete:${deletingCopy.path}` ? html`<${Spinner} size=${13} />` : discarding ? t("Confirm discard") : t("Discard and delete")}</button>
							<button class="btn sm branch-delete-cancel" disabled=${!!busy} onClick=${cancelCopyDeletion}>${t("Cancel")}</button>
						</div>`}
			</div>` : null}
			${naming ? html`<form class="branch-form" onSubmit=${(e) => { e.preventDefault(); saveName(); }}><input class="field sm grow" maxlength="80" aria-label=${t("Copy display name")} value=${displayName} onInput=${(e) => setDisplayName(e.target.value)} /><button class="btn sm" type="submit" disabled=${!!busy || !displayName.trim()}>${t("Save")}</button><button class="btn sm" type="button" disabled=${disabled} onClick=${() => suggestName(naming)}>${busy === "name" ? html`<${Spinner} size=${12} />` : t("AI name")}</button><button class="icon-btn sm" type="button" aria-label=${t("Cancel")} onClick=${() => setNaming(null)}><${Icon} name="x" size=${13} /></button></form>` : null}
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
