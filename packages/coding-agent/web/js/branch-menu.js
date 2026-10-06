// The branch chip above the input and its popover: search the local branches, switch, create and delete them, and move
// this chat into an isolated copy of the repository (a Git worktree) or back to the main copy. Every action calls the
// server's Git routes (routes-git.ts), which use Git's own rules; nothing here decides what Git allows.
import { html, useEffect, useMemo, useRef, useState, Chevron, Collapse, COLLAPSE_MS, Icon, Popover, Spinner, Toggle, usePresence } from "./ui.js";
import { api, attempt, loadGitStatus, post, toast, useStore } from "./store.js";
import { rankSearch } from "./search.js";
import { relTime } from "./util.js";
import { getLang, serverText, t } from "./i18n.js";
import { openWorktreeTab } from "./worktree-tabs.js";

/** A name for the branch of a new isolated copy: task-MMDD-HHmm. */
function copyBranchName() {
	const d = new Date();
	const two = (n) => String(n).padStart(2, "0");
	return `task-${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

const POP_EXIT_MS = 160;

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
	const { mounted } = usePresence(open, POP_EXIT_MS);
	const linked = !!gitStatus.linkedWorktree;
	const branch = gitStatus.branch || t("detached HEAD");
	return html`<span ref=${anchor} class="branch-anchor">
		<button class=${`env-chip branch-chip ${linked ? "wt" : ""}`} onClick=${() => setOpen(!open)} aria-haspopup="dialog" aria-expanded=${open}
			title=${linked ? t("Branch {branch} in an isolated copy (Git worktree). Click to manage branches", { branch }) : t("Branch {branch}. Click to manage branches", { branch })}>
			<${Icon} name=${linked ? "layers" : "gitBranch"} size=${12} /><span class="truncate">${branch}</span>
			${gitStatus.preview?.total ? html`<span class="badge warn">${gitStatus.preview.total}</span>` : null}
			${linked ? html`<span class="wt-tag">${t("worktree")}</span>` : null}
			<${Chevron} />
		</button>
		<${Popover} anchor=${anchor} open=${mounted} exitMs=${0} onClose=${() => setOpen(false)} placement="top" align="start" width=${330} maxHeight=${480} class=${`branch-pop ${open ? "" : "leaving"}`}>
			<${BranchMenu} key=${slot} gitStatus=${gitStatus} branchSource=${branchSource} slot=${slot} close=${() => setOpen(false)} />
		<//>
	</span>`;
}

function BranchMenu({ gitStatus, branchSource, slot, close }) {
	const running = useStore((s) => !!s.snap?.active);
	const [data, setData] = useState(branchSource.data);
	const [error, setError] = useState("");
	const [worktrees, setWorktrees] = useState(null);
	const [query, setQuery] = useState("");
	const [sel, setSel] = useState(0);
	const [busy, setBusy] = useState("");
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [confirm, setConfirm] = useState("");
	const [removing, setRemoving] = useState("");
	const [worktreesOpen, setWorktreesOpen] = useState(false);
	const [isolating, setIsolating] = useState(false);
	const [copyName, setCopyName] = useState("");
	const [naming, setNaming] = useState(null);
	const [displayName, setDisplayName] = useState("");
	const [createDisplayName, setCreateDisplayName] = useState("");
	const [autoName, setAutoName] = useState(false);
	const [deletingCopy, setDeletingCopy] = useState(null);
	const known = useRef(null);
	const list = useRef(null);
	const linked = !!gitStatus.linkedWorktree;

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
	const loadWorktrees = async () => {
		try {
			setWorktrees({ list: (await api("/api/git/worktrees", { slot })).worktrees || [] });
		} catch (e) {
			setWorktrees({ list: [], error: serverText(e.message, t("Cannot list worktrees.")) });
		}
	};
	useEffect(() => {
		load();
	}, []);
	useEffect(() => {
		if (worktreesOpen && !worktrees) loadWorktrees();
	}, [worktreesOpen]);

	const branches = useMemo(() => rankSearch(data?.branches || [], query, { names: (b) => [b.name] }), [data, query]);
	const exact = branches.some((b) => b.name === query.trim());
	// Rows the keyboard moves over: the branches, then "New branch".
	const rows = data ? [...branches.map((b) => ({ kind: "branch", branch: b })), { kind: "new" }] : [];
	useEffect(() => setSel(0), [query]);
	useEffect(() => {
		list.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel]);

	const done = async (message) => {
		await loadGitStatus();
		if (message) toast(message, "info", 3500);
	};
	const enterCopy = async (path, message) => {
		setBusy(`w:${path}`);
		const ok = await attempt(() => post("/api/git/worktrees/enter", { path }));
		setBusy("");
		if (!ok) return;
		close();
		await done(message);
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
	const remove = async (branch) => {
		if (confirm !== branch.name) return setConfirm(branch.name);
		setConfirm("");
		setBusy(`d:${branch.name}`);
		const ok = await attempt(() => post("/api/git/branches/delete", { name: branch.name }));
		setBusy("");
		if (!ok) return;
		// The row folds away first, then the list is read again.
		setRemoving(branch.name);
		setTimeout(async () => {
			await load(true);
			setRemoving("");
		}, COLLAPSE_MS);
		toast(t("Deleted branch {branch}", { branch: branch.name }), "info", 3500);
	};
	const main = worktrees?.list.find((w) => w.isMain);
	const others = (worktrees?.list || []).filter((w) => !w.current || !w.isMain);
	const setIsolation = (on) => {
		if (linked) {
			if (!on && main) enterCopy(main.path, t("Back in the main copy"));
			return;
		}
		setIsolating(on);
		if (on) setCopyName(copyBranchName());
	};
	const createCopy = async () => {
		const branch = copyName.trim();
		if (!branch) return;
		setBusy("copy");
		const created = await attempt(() => post("/api/git/worktrees/create", { branch, newBranch: true }));
		if (!created?.worktree?.path) {
			setBusy("");
			return;
		}
		if (autoName) {
			setBusy("");
			await loadWorktrees();
			await suggestName(created.worktree);
			setIsolating(false);
			return;
		}
		if (createDisplayName.trim()) await attempt(() => post("/api/git/worktrees/rename", { path: created.worktree.path, name: createDisplayName }, slot));
		const entered = await attempt(() => post("/api/git/worktrees/enter", { path: created.worktree.path }));
		setBusy("");
		if (!entered) return loadWorktrees();
		close();
		await done(t("Now working in an isolated copy on {branch}", { branch }));
	};

	const deleteCopy = async () => {
		if (!deletingCopy || deletingCopy.isMain || deletingCopy.current || running || busy) return;
		setBusy(`delete:${deletingCopy.path}`);
		const result = await attempt(() => post("/api/git/worktrees/delete", { path: deletingCopy.path }, slot));
		setBusy("");
		if (!result) return;
		setDeletingCopy(null);
		if (naming?.path === deletingCopy.path) setNaming(null);
		await Promise.all([loadWorktrees(), load(true)]);
		await done(t("Copy deleted"));
	};

	const startCopy = async (w) => {
		setBusy(`start:${w.path}`);
		await attempt(() => openWorktreeTab(w.path, () => post("/api/git/worktrees/start", { path: w.path }, slot)));
		setBusy("");
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
		if (result) { setNaming(null); await loadWorktrees(); }
	};

	const activate = (row) => (row.kind === "new" ? startNew() : switchTo(row.branch));
	const onSearchKey = (event) => {
		if (event.isComposing || disabled || !rows.length) return;
		if (event.key === "ArrowDown") return event.preventDefault(), setSel((sel + 1) % rows.length);
		if (event.key === "ArrowUp") return event.preventDefault(), setSel((sel - 1 + rows.length) % rows.length);
		if (event.key === "Enter") return event.preventDefault(), rows[sel] && activate(rows[sel]);
	};
	const disabled = running || !!busy || !data;

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
							? html`<button class="branch-confirm" onClick=${(e) => (e.stopPropagation(), remove(b))} onMouseLeave=${() => setConfirm("")}>${t("Delete?")}</button>`
							: html`<span class="dim branch-time">${relTime(b.committedAt)}</span>`}
						${rowBusy ? html`<${Spinner} size=${13} />` : b.current ? html`<${Icon} name="check" size=${14} class="branch-check" />` : !elsewhere && confirm !== b.name ? html`<button class="icon-btn sm branch-del" title=${t("Delete branch")} aria-label=${t("Delete branch {branch}", { branch: b.name })} disabled=${disabled} onClick=${(e) => (e.stopPropagation(), remove(b))}><${Icon} name="trash" size=${13} /></button>` : null}
					</div>
				<//>`;
			})}
		</div>
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
				<${Chevron} /><span>${t("Worktree")}</span><span class="dim">${t("Isolated working copies")}</span>
			</button>
			<${Collapse} open=${worktreesOpen}>
			<div class="branch-wt-row">
				<div class="col grow branch-wt-text">
					<span>${t("Work in an isolated copy")}</span>
					<span class="dim">${linked ? t("This chat runs in a separate worktree; the main copy and its branch are untouched.") : t("A new chat runs in a separate worktree on its own branch; this folder and branch stay as they are.")}</span>
				</div>
				${busy === "copy" || (main && busy === `w:${main.path}`) ? html`<${Spinner} />` : html`<${Toggle} checked=${linked || isolating} disabled=${disabled || !worktrees || !!worktrees.error || (linked && !main)} label=${t("Work in an isolated copy")} onChange=${setIsolation} />`}
			</div>
			${worktrees?.error ? html`<div class="branch-note dim">${worktrees.error}</div>` : null}
			<${Collapse} open=${isolating && !linked}>
				<form class="branch-form" onSubmit=${(e) => (e.preventDefault(), createCopy())}>
					<input class="field sm grow" value=${copyName} aria-label=${t("Branch for the copy")} placeholder=${t("Branch for the copy")} onInput=${(e) => setCopyName(e.target.value)} />
					<button class="btn sm primary" type="submit" disabled=${disabled || !copyName.trim()}>${t("Create and open")}</button>
				</form>
				<div class="branch-form"><input class="field sm grow" value=${createDisplayName} maxlength="80" aria-label=${t("Copy display name")} placeholder=${t("Copy display name (optional)")} onInput=${(e) => setCreateDisplayName(e.target.value)} /></div>
				<label class="branch-hint"><input type="checkbox" checked=${autoName} onChange=${(e) => setAutoName(e.target.checked)} /> ${t("Let the main Agent name it")}</label>
				<div class="branch-hint dim">${t("The new branch starts from main.")}</div>
			<//>
			${others.length ? html`<div class="pop-group">${t("Existing copies")}</div>` : null}
			<div class="branch-copy-region">
			${others.length ? html`<div class="branch-copies">${others.map((w) => html`<div key=${w.path} class="pop-item branch-copy" title=${w.path}>
				<${Icon} name=${w.isMain ? "folder" : "layers"} size=${13} />
				<span class="col branch-copy-info">
					<span class="truncate">${w.isMain ? t("Main copy") : w.displayName || w.branch || w.path.split(/[\\/]/).pop()}</span>
					<span class="dim truncate branch-copy-path">${w.path}</span>
				</span>
				<div class="branch-copy-actions">
				<button class="icon-btn sm" disabled=${disabled} title=${t("Enter to edit")} aria-label=${t("Enter to edit")} onClick=${() => enterCopy(w.path)}><${Icon} name="arrowRight" size=${13} /></button>
				${!w.isMain ? html`<button class="icon-btn sm" disabled=${!!busy} title=${t("Start copy")} aria-label=${t("Start copy")} onClick=${() => startCopy(w)}>${busy === `start:${w.path}` ? html`<${Spinner} size=${13} />` : html`<${Icon} name="play" size=${13} />`}</button>
				<button class="icon-btn sm" disabled=${!!busy} title=${t("Rename copy")} aria-label=${t("Rename copy")} onClick=${() => { setNaming(w); setDisplayName(w.displayName || w.branch || ""); }}><${Icon} name="edit" size=${13} /></button>
				<button class="icon-btn sm" disabled=${disabled || w.current} title=${t("Delete copy")} aria-label=${t("Delete copy")} onClick=${() => setDeletingCopy(w)}><${Icon} name="trash" size=${13} /></button>` : null}
				</div>
			</div>`)}</div>` : !worktrees ? html`<div class="branch-note dim"><${Spinner} />${t("Loading…")}</div>` : null}
			</div>
			${deletingCopy ? html`<div class="branch-note" role="group" aria-label=${t("Delete copy?")}>
				<div>${t("Delete copy “{name}”? Its folder will be deleted, not its branch. This does not merge changes into main.", { name: deletingCopy.displayName || deletingCopy.branch || deletingCopy.path.split(/[\\/]/).pop() })}</div>
				<div class="branch-form"><button class="btn sm danger" disabled=${disabled || deletingCopy.current || deletingCopy.isMain} onClick=${deleteCopy}>${busy === `delete:${deletingCopy.path}` ? html`<${Spinner} size=${13} />` : t("Delete")}</button><button class="btn sm" disabled=${!!busy} onClick=${() => setDeletingCopy(null)}>${t("Cancel")}</button></div>
			</div>` : null}
			${naming ? html`<form class="branch-form" onSubmit=${(e) => { e.preventDefault(); saveName(); }}><input class="field sm grow" maxlength="80" aria-label=${t("Copy display name")} value=${displayName} onInput=${(e) => setDisplayName(e.target.value)} /><button class="btn sm" type="submit" disabled=${!!busy || !displayName.trim()}>${t("Save")}</button><button class="btn sm" type="button" disabled=${disabled} onClick=${() => suggestName(naming)}>${t("AI name")}</button><button class="icon-btn sm" type="button" aria-label=${t("Cancel")} onClick=${() => setNaming(null)}><${Icon} name="x" size=${13} /></button></form>` : null}
			<//>
		</div>
	</div>`;
}
