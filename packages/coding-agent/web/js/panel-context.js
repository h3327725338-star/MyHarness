// Session panel: context budget, session stats, active tools, loaded resources and the branch tree.
import { html, useEffect, useState, Collapse, Icon, Spinner, Toggle, CopyButton } from "./ui.js";
import { api, attempt, loadResources, post, setView, state, toast, useStore } from "./store.js";
import { actions, confirmDialog } from "./actions.js";
import { ContextDetails } from "./context-usage.js";
import { t } from "./i18n.js";
import { basename, clip, fmtCost, fmtDateTime, fmtTokens, plural } from "./util.js";

function Section({ title, count, children, defaultOpen = true, action }) {
	const [open, setOpen] = useState(defaultOpen);
	const toggle = () => setOpen(!open);
	return html`<section class="ctx-section">
		<div class="ctx-head" onClick=${toggle} role="button" tabindex="0" aria-expanded=${open} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<${Icon} name="chevronRight" size=${13} class="disclose" /><span class="grow">${title}${count != null ? html` <span class="dim">${count}</span>` : null}</span>${action ? html`<span onClick=${(e) => e.stopPropagation()}>${action}</span>` : null}
		</div>
		<${Collapse} open=${open}><div class="ctx-body">${children}</div><//>
	</section>`;
}

function AutoCompact({ snap }) {
	return html`<label class="row dim" style="gap:6px;font-size:12px;margin-top:8px"><${Toggle} checked=${snap.autoCompaction} label=${t("Auto-compact")} onChange=${(v) => attempt(async () => { await post("/api/settings", { id: "autoCompact", value: v }); })} />${t("Auto-compact")}</label>`;
}

function TreeView({ snap }) {
	const [tree, setTree] = useState(null);
	const load = async () => {
		try {
			setTree(await api("/api/sessions/tree"));
		} catch (e) {
			toast(e.message, "error");
		}
	};
	useEffect(() => {
		load();
	}, [snap?.session?.id, snap?.run?.runId, snap?.active]);
	if (!tree) return html`<${Spinner} />`;
	const rows = tree.rows.filter((r) => ["user", "assistant", "compaction", "branchSummary"].includes(r.kind));
	if (!rows.length) return html`<div class="dim">${t("Nothing to branch from yet.")}</div>`;
	const navigate = async (row) => {
		const ok = await confirmDialog({ title: t("Go back to this point?"), message: t("The conversation continues from here on a new branch; earlier messages stay in the session file. If this is a message of yours, its text goes back into the composer."), confirmLabel: t("Navigate") });
		if (!ok) return;
		const result = await attempt(() => post("/api/sessions/navigate", { targetId: row.id }));
		if (result?.editorText) actions.insertIntoComposer(result.editorText, { replace: true });
	};
	return html`<div class="tree">${rows.map((row) => html`<div class=${`tree-node ${row.onPath ? "on-path" : ""} ${row.isLeaf ? "leaf" : ""}`} key=${row.id} style=${{ paddingLeft: `${4 + Math.min(row.depth, 6) * 12}px` }}>
		<span class=${`kind kind-${row.kind}`}>${row.kind === "user" ? t("You") : row.kind === "assistant" ? "AI" : row.kind === "compaction" ? "⟲" : "⑂"}</span>
		<span class="truncate grow" title=${row.text}>${clip(row.text.replace(/\s+/g, " "), 70) || t("(no text)")}</span>
		${row.childCount > 1 ? html`<span class="badge" title=${t("Branch point")}>${row.childCount}⑂</span>` : null}
		<button class="link-btn" disabled=${snap.active} onClick=${() => navigate(row)}>${row.isLeaf ? "current" : "go here"}</button>
		${row.kind === "user" ? html`<button class="link-btn" disabled=${snap.active} onClick=${() => actions.editAndResend({ id: row.id, text: row.text })}>${t("fork")}</button>` : null}
	</div>`)}</div>`;
}

export function ContextPanel() {
	const snap = useStore((s) => s.snap);
	const resources = useStore((s) => s.resources);
	const [stats, setStats] = useState(null);
	useEffect(() => {
		if (!resources) loadResources();
	}, []);
	useEffect(() => {
		api("/api/sessions/stats").then(setStats).catch(() => {});
	}, [snap?.session?.id, snap?.lastRun?.runId, snap?.active]);
	if (!snap) return null;
	const toggleTool = async (name, on) => {
		const active = new Set(resources.tools.filter((t) => t.active).map((t) => t.name));
		if (on) active.add(name);
		else active.delete(name);
		await attempt(() => post("/api/tools/active", { names: [...active] }));
		await loadResources();
	};
	return html`<div class="context-panel panel-scroll">
		<${Section} title=${t("Context window")}>
			<${ContextDetails} /><${AutoCompact} snap=${snap} />
		<//>
		<${Section} title=${t("Session")}>
			<div class="kv">
				<span>${t("Name")}</span><span class="truncate">${snap.session.name || "—"}</span>
				<span>${t("Model")}</span><span class="truncate">${snap.model ? `${snap.model.provider}/${snap.model.id}` : "—"}</span>
				<span>${t("Reasoning")}</span><span>${snap.thinking.supported ? snap.thinking.level : t("not supported")}</span>
				<span>${t("Workspace")}</span><span class="truncate mono" title=${snap.cwd}>${snap.cwd}</span>
				<span>${t("Session file")}</span><span class="row" style="gap:4px"><span class="truncate mono" title=${snap.session.file || ""}>${snap.session.file ? basename(snap.session.file) : t("in-memory (not saved)")}</span>${snap.session.file ? html`<${CopyButton} text=${snap.session.file} label=${t("Copy path")} />` : null}</span>
				${stats ? html`
					<span>${t("Messages")}</span><span>${t("{userMessages} you · {assistantMessages} assistant · {toolCalls} tool calls", { userMessages: stats.userMessages, assistantMessages: stats.assistantMessages, toolCalls: stats.toolCalls })}</span>
					<span>${t("Tokens")}</span><span>${t("{fmtTokens} in · {fmtTokens2} out · {fmtTokens3} cached", { fmtTokens: fmtTokens(stats.tokens.input), fmtTokens2: fmtTokens(stats.tokens.output), fmtTokens3: fmtTokens(stats.tokens.cacheRead) })}</span>
					<span>${t("Cost")}</span><span>${fmtCost(stats.cost)}</span>` : null}
			</div>
			<div class="row" style="gap:8px;margin-top:8px"><button class="btn sm" onClick=${actions.exportSession}><${Icon} name="download" size=${13} />${t("Export HTML")}</button></div>
		<//>
		${snap.checkpoint ? html`<${Section} title=${t("Git checkpoint")}><div class="kv"><span>${t("Status")}</span><span>${t(snap.checkpoint.status)}</span><span>${t("Created")}</span><span>${fmtDateTime(Date.parse(snap.checkpoint.createdAt))}</span><span>${t("Shell used")}</span><span>${snap.checkpoint.hadBash ? t("yes — external effects cannot be undone") : t("no")}</span></div><//>` : null}
		<${Section} title=${t("Branches")} defaultOpen=${false}><${TreeView} snap=${snap} /><//>
		<${Section} title=${t("Tools")} count=${resources ? `${resources.tools.filter((t) => t.active).length}/${resources.tools.length}` : ""} defaultOpen=${false}>
			${!resources ? html`<${Spinner} />` : resources.tools.map((tool) => html`<div class="res-row" key=${tool.name}><div class="col grow"><span class="mono">${tool.name}${tool.extension ? html` <span class="badge">${t("extension")}</span>` : null}</span><span class="dim res-desc">${clip(tool.description, 110)}</span></div><${Toggle} checked=${tool.active} label=${tool.name} disabled=${snap.active} onChange=${(v) => toggleTool(tool.name, v)} /></div>`)}
		<//>
		<${Section} title=${t("Skills")} count=${resources?.skills.length} defaultOpen=${false}>
			${!resources ? html`<${Spinner} />` : resources.skills.length ? resources.skills.map((skill) => html`<div class="res-row" key=${skill.name}><div class="col grow"><span class="mono">${skill.name}</span><span class="dim res-desc">${clip(skill.description, 120)}</span></div><button class="link-btn" onClick=${() => actions.insertIntoComposer(`/skill:${skill.name} `)}>${t("Use")}</button></div>`) : html`<div class="dim">${t("No skills loaded.")}</div>`}
		<//>
		<${Section} title=${t("Prompt templates")} count=${resources?.prompts.length} defaultOpen=${false}>
			${!resources ? html`<${Spinner} />` : resources.prompts.length ? resources.prompts.map((p) => html`<div class="res-row" key=${p.name}><div class="col grow"><span class="mono">/${p.name} ${p.argumentHint ? html`<span class="dim">${p.argumentHint}</span>` : null}</span><span class="dim res-desc">${clip(p.description, 120)}</span></div><button class="link-btn" onClick=${() => actions.insertIntoComposer(`/${p.name} `)}>${t("Use")}</button></div>`) : html`<div class="dim">${t("No prompt templates.")}</div>`}
		<//>
		<${Section} title=${t("Extensions")} count=${resources?.extensions.length} defaultOpen=${false}>
			${!resources ? html`<${Spinner} />` : resources.extensions.length ? resources.extensions.map((e) => html`<div class="res-row" key=${e.path}><div class="col grow"><span class="truncate" title=${e.path}>${basename(e.path)} <span class="badge">${e.scope}</span></span><span class="dim res-desc">${[e.tools.length ? plural(e.tools.length, "tool") : "", e.commands.length ? plural(e.commands.length, "command") : ""].filter(Boolean).join(" · ") || "no tools or commands"}</span></div></div>`) : html`<div class="dim">${t("No extensions loaded.")}</div>`}
			${resources?.extensionErrors?.map((e) => html`<div class="notice danger" key=${e.path}>${basename(e.path)}: ${e.error}</div>`)}
		<//>
		<${Section} title=${t("Project context files")} count=${resources?.contextFiles.length} defaultOpen=${false}>
			${resources?.contextFiles.map((f) => html`<div class="res-row" key=${f.path}><span class="truncate grow mono" title=${f.path}>${f.path}</span><span class="dim">${t("{fmtTokens} chars", { fmtTokens: fmtTokens(f.chars) })}</span></div>`)}
			${resources && !resources.contextFiles.length ? html`<div class="dim">${t("No AGENTS.md / CLAUDE.md files found.")}</div>` : null}
		<//>
		<div class="row" style="gap:8px;padding:10px 12px"><button class="btn sm" onClick=${async () => (await attempt(() => post("/api/resources/reload")), loadResources(), toast(t("Resources reloaded"), "info", 2500))} disabled=${snap.active}><${Icon} name="refresh" size=${13} />${t("Reload resources")}</button></div>
	</div>`;
}
