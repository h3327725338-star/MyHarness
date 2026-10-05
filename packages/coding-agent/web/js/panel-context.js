// Session panel: context budget, session stats, active tools, loaded resources and the branch tree.
import { html, useEffect, useState, Collapse, Icon, Spinner, Toggle, CopyButton } from "./ui.js";
import { api, attempt, loadResources, loadStats, post, setView, state, toast, useStore } from "./store.js";
import { actions, confirmDialog } from "./actions.js";
import { restartService } from "./service-restart.js";
import { CacheValue, ContextDetails, fmtSpeed, sessionCache } from "./context-usage.js";
import { N_, t } from "./i18n.js";
import { basename, clip, fmtCost, fmtDateTime, fmtTokens, plural } from "./util.js";

const TOOL_DESCRIPTIONS = {
	agent: N_("Delegate tasks to sub-agents."),
	read: N_("Read text, images and documents."),
	bash: N_("Run Bash commands."),
	pwsh: N_("Run PowerShell commands."),
	edit: N_("Replace exact text in a file."),
	write: N_("Create or rewrite a file."),
	grep: N_("Search file contents."),
	find: N_("Find files by name."),
	ls: N_("List files and folders."),
	symbols: N_("Find code symbols and references."),
	github: N_("Access connected GitHub resources."),
	web_search: N_("Search the web and read results."),
	web_fetch: N_("Read web pages and documents."),
};
export const toolDescription = (tool) => TOOL_DESCRIPTIONS[tool.name] && !tool.extension ? t(TOOL_DESCRIPTIONS[tool.name]) : tool.description;

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
	return html`<label class="check-label sm dim"><${Toggle} checked=${snap.autoCompaction} label=${t("Auto-compact")} onChange=${(v) => attempt(async () => { await post("/api/settings", { id: "autoCompact", value: v }); })} />${t("Auto-compact")}</label>`;
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
		<button class="btn sm tree-action" disabled=${snap.active} onClick=${() => navigate(row)}>${row.isLeaf ? t("current") : t("Go back")}</button>
		${row.kind === "user" ? html`<button class="btn sm tree-action" disabled=${snap.active} onClick=${() => actions.editAndResend({ id: row.id, text: row.text })}>${t("fork")}</button>` : null}
	</div>`)}</div>`;
}

export function ContextPanel() {
	const snap = useStore((s) => s.snap);
	const resources = useStore((s) => s.resources);
	const restarting = useStore((s) => s.restarting);
	const restartPhase = useStore((s) => s.restartPhase);
	const restartError = useStore((s) => s.restartError);
	const restartDetail = { requesting: t("Requesting service restart"), waiting: t("Waiting for the service to reconnect"), starting: t("Starting the service"), restoring: t("Restoring the conversation") }[restartPhase];
	// The totals come from the store: loaded once per session here, then kept current by the server's `usage` events.
	const stats = useStore((s) => s.stats);
	useEffect(() => {
		if (!resources) loadResources();
	}, []);
	useEffect(() => {
		loadStats();
	}, [snap?.session?.id, snap?.lastRun?.runId]);
	if (!snap) return null;
	// DeepSeek's session projection displays numeric buckets, with absent cache counts accumulated as zero.
	// Availability flags remain available for diagnostics and costs, not as a gate on this compatibility display.
	const tokenCount = (key) => {
		const value = stats?.tokens?.[key];
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? fmtTokens(value) : "—";
	};
	const cost = stats?.costByCurrency ? Object.entries(stats.costByCurrency).map(([currency, value]) => fmtCost(value, currency)).join(" · ") || "—" : fmtCost(stats?.cost);
	const toggleTool = async (name, on) => {
		const active = new Set(resources.tools.filter((t) => t.active).map((t) => t.name));
		if (on) active.add(name);
		else active.delete(name);
		await attempt(() => post("/api/tools/active", { names: [...active] }));
		await loadResources();
	};
	return html`<div class="context-panel panel-scroll">
		<${Section} title=${t("Context window")}>
			<${ContextDetails} capacityOnly=${true} controls=${html`<${AutoCompact} snap=${snap} /><button class="btn sm" disabled=${snap.active} onClick=${actions.compact}>${t("Compact now")}</button>`} />
		<//>
		<${Section} title=${t("Session")}>
			<div class="kv">
				<span>${t("Name")}</span><span class="truncate">${snap.session.name || "—"}</span>
				<span>${t("Model")}</span><span class="truncate">${snap.model ? `${snap.model.provider}/${snap.model.id}` : "—"}</span>
				<span>${t("Model pricing")}</span><span title=${JSON.stringify(snap.model?.cost ?? {})}>${snap.model?.cost ? `${snap.model.cost.currency === "CNY" ? "¥" : "$"}/1M · ${t("Input")} ${snap.model.cost.input} · ${t("Cache write")} ${snap.model.cost.cacheWrite} · ${t("Cache read")} ${snap.model.cost.cacheRead} · ${t("Output")} ${snap.model.cost.output}` : "—"}</span>
				<span>${t("Reasoning")}</span><span>${snap.thinking.supported ? snap.thinking.level : t("not supported")}</span>
				<span>${t("Workspace")}</span><span class="truncate mono" title=${snap.cwd}>${snap.cwd}</span>
				<span>${t("Session file")}</span><span class="kv-value"><span class="truncate mono" title=${snap.session.file || ""}>${snap.session.file ? basename(snap.session.file) : t("in-memory (not saved)")}</span>${snap.session.file ? html`<${CopyButton} text=${snap.session.file} label=${t("Copy path")} />` : null}</span>
				${stats ? html`
					<span>${t("Messages")}</span><span>${t("{userMessages} user · {assistantMessages} Agent · {toolCalls} tool calls", { userMessages: fmtTokens(stats.userMessages), assistantMessages: fmtTokens(stats.assistantMessages), toolCalls: fmtTokens(stats.toolCalls) })}</span>
					<span>${t("Tokens")}</span><span class="session-tokens">
						<span>${t("Input")} ${tokenCount("input")} · ${t("Cache write")} ${tokenCount("cacheWrite")} · ${t("Cache read")} ${tokenCount("cacheRead")} · ${t("Output")} ${tokenCount("output")}</span>
					</span>
					<span aria-hidden="true"></span><span class="session-cumulative">${t("Cumulative speed")} ${fmtSpeed(stats.speed)} · ${t("Cumulative cache hit")} <${CacheValue} session=${sessionCache(stats)} /></span>
					<span>${t("Cost")}</span><span>${cost !== "—" && (stats.usageEstimated || stats.costIncomplete) ? "≈ " : ""}${cost}</span>` : null}
			</div>
			<div class="ctx-actions"><button class="btn sm" onClick=${actions.exportSession}><${Icon} name="download" size=${13} />${t("Export HTML")}</button></div>
		<//>
		${snap.checkpoint ? html`<${Section} title=${t("Git checkpoint")}><div class="kv"><span>${t("Status")}</span><span>${t(snap.checkpoint.status)}</span><span>${t("Created")}</span><span>${fmtDateTime(Date.parse(snap.checkpoint.createdAt))}</span><span>${t("Shell used")}</span><span>${snap.checkpoint.hadBash ? t("yes — external effects cannot be undone") : t("no")}</span></div><//>` : null}
		<${Section} title=${t("Branches")} defaultOpen=${false}><${TreeView} snap=${snap} /><//>
		<${Section} title=${t("Tools")} count=${resources ? `${resources.tools.filter((t) => t.active).length}/${resources.tools.length}` : ""} defaultOpen=${false}>
			${!resources ? html`<${Spinner} />` : resources.tools.map((tool) => html`<div class="res-row" key=${tool.name}><div class="col grow"><span class="mono">${tool.name}${tool.extension ? html` <span class="badge">${t("extension")}</span>` : null}</span><span class="dim res-desc">${toolDescription(tool)}</span></div><${Toggle} checked=${tool.active} label=${tool.name} disabled=${snap.active} onChange=${(v) => toggleTool(tool.name, v)} /></div>`)}
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
		<div class="ctx-foot service-restart" aria-busy=${restarting}>
			<button class="btn sm" onClick=${restartService} disabled=${snap.active || restarting}>${restarting ? html`<${Spinner} />` : html`<${Icon} name="refresh" size=${13} />`}${restarting ? t("Restarting service…") : restartError ? t("Retry") : t("Restart service")}</button>
			<div class=${`service-restart-detail ${restartError ? "c-danger" : "dim"}`} role=${restartError ? "alert" : "status"} aria-live="polite">${restartError || (restarting ? restartDetail : "")}</div>
		</div>
	</div>`;
}
