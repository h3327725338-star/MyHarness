// Session panel: context budget, session stats, active tools and loaded resources.
import { html, useEffect, useState, autofocusOnMount, Collapse, Icon, Spinner, Toggle, CopyButton } from "./ui.js";
import { attempt, loadResources, loadSettings, loadStats, post, setView, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { exportReadOnly } from "./export-mode.js";
import { restartService } from "./service-restart.js";
import { CacheValue, ContextDetails, fmtSpeed, sessionCache } from "./context-usage.js";
import { N_, isZh, t } from "./i18n.js";
import { zhToolDescription } from "./locales/zh-CN-tools.js";
import { basename, fmtCost, fmtTokens } from "./util.js";
import { promptTitleFrom } from "./saved-prompts.js";
import { ConnectList, connectedCount, useConnections } from "./connect-page.js";

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
	workflow: N_("Read-only parallel checks across modules."),
	ultracode: N_("Deep check of high-risk problems."),
	job_list: N_("List background jobs and their status."),
	job_output: N_("Read the output of a background job."),
	job_kill: N_("Stop a background job."),
	apply_patch: N_("Change several files with one patch."),
	apply_rename: N_("Apply a rename plan to every affected file."),
	workspace: N_("Control the built-in browser and workspace tabs."),
	agent_tasks: N_("See or stop this chat's sub-agents."),
	mail: N_("Read and send connected Gmail and Outlook mail."),
	memory_search: N_("Search saved long-term memories."),
	memory_get: N_("Read a whole memory by its ID."),
	memory_delete: N_("Delete a long-term memory for good."),
	memory_claim: N_("Move a pending memory into this workspace."),
	memory_write: N_("Create or update a long-term memory."),
	session_search: N_("Find earlier chats."),
	session_get: N_("Read an earlier chat's hand-off summary and text."),
	ask_user_question: N_("Ask the user and wait for an answer."),
	todo_write: N_("Create and update a task list."),
	schedule: N_("Create and manage reminders and scheduled tasks."),
};
/** Full stops that do not end a sentence. */
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|incl|approx)\.$/i;
const SENTENCE_CAP = 140;
/**
 * The first sentence of a tool's own description: what an extension or MCP tool (no short sentence above) shows in
 * the sidebar, with the whole text in the row's tooltip.
 */
export function firstSentence(text) {
	const line = String(text ?? "").trim().split(/\r?\n/, 1)[0].trim();
	let sentence = line;
	for (const end of line.matchAll(/[.!?](?=\s|$)|[\u3002\uff01\uff1f]/g)) {
		const head = line.slice(0, end.index + 1);
		if (!ABBREVIATION.test(head)) {
			sentence = head;
			break;
		}
	}
	return sentence.length > SENTENCE_CAP ? `${sentence.slice(0, SENTENCE_CAP - 1).trimEnd()}\u2026` : sentence;
}
/** The tooltip of a tool row: the whole description when the row shows only its first sentence. */
const descriptionTip = (tool, shown) => {
	const full = String(tool.description ?? "").trim();
	return full && shown !== full && shown === firstSentence(full) ? full : undefined;
};
export const toolDescription = (tool) => {
	// Chinese mode prefers the display-only table keyed by tool name (locales/zh-CN-tools.js); a miss keeps the
	// original behaviour below byte for byte, and English mode never looks at that table at all.
	if (isZh()) {
		const chinese = zhToolDescription(tool);
		if (chinese) return chinese;
	}
	return Object.hasOwn(TOOL_DESCRIPTIONS, tool.name) && !tool.extension ? t(TOOL_DESCRIPTIONS[tool.name]) : firstSentence(tool.description);
};

function Section({ title, count, children, defaultOpen = true }) {
	const [open, setOpen] = useState(defaultOpen);
	const toggle = () => setOpen(!open);
	return html`<section class="ctx-section">
		<div class="ctx-head" onClick=${toggle} role="button" tabindex="0" aria-expanded=${open} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
			<${Icon} name="chevronRight" size=${13} class="disclose" /><span class="grow">${title}${count != null ? html` <span class="dim">${count}</span>` : null}</span>
		</div>
		<${Collapse} open=${open}><div class="ctx-body">${children}</div><//>
	</section>`;
}

function AutoCompact({ snap }) {
	return html`<label class="check-label sm dim"><${Toggle} checked=${snap.autoCompaction} label=${t("Auto-compact")} onChange=${(v) => attempt(async () => { await post("/api/settings", { id: "autoCompact", value: v }); })} />${t("Auto-compact")}</label>`;
}

/**
 * Format session token counts. Absent / undetected buckets (e.g. providers that do not
 * report cache writes) display "—" instead of claiming a measured zero.
 */
export function formatSessionTokenCount(stats, key) {
	const value = stats?.tokens?.[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "—";
	const cacheKey = { input: "input", cacheRead: "read", cacheWrite: "write" }[key];
	const undetected =
		stats?.tokenAvailability?.[key] === false ||
		(cacheKey && stats?.cache && stats.cache[cacheKey]?.value == null);
	if (value === 0 && undetected) return "—";
	return fmtTokens(value);
}

/**
 * The user's own prompts: written once, kept with the page preferences (shared by every window), and put into the input
 * with one click, where Enter sends them like typed text. Text already in the input stays; the prompt goes under it.
 * The list shows each prompt's title only; the pencil opens the title and the text for editing.
 */
function SavedPrompts({ prompts, editing, setEditing }) {
	const save = () => {
		const text = editing.text.trim();
		if (!text) return;
		const next = [...prompts];
		const prompt = { title: editing.title.trim() || promptTitleFrom(text), text };
		if (editing.index >= 0) next[editing.index] = prompt;
		else next.push(prompt);
		setView({ savedPrompts: next });
		setEditing(null);
	};
	const remove = (index) => {
		setView({ savedPrompts: prompts.filter((_, position) => position !== index) });
		setEditing(null);
	};
	const keys = (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
		else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
	};
	const editor = html`<div class="prompt-edit" onKeyDown=${keys}>
		<input class="field prompt-title-field" autofocus ref=${autofocusOnMount} maxlength="60" placeholder=${t("Title")} aria-label=${t("Title")} value=${editing?.title ?? ""}
			onInput=${(e) => setEditing({ ...editing, title: e.target.value })} />
		<textarea class="field" rows="5" placeholder=${t("Write a prompt you use often")} aria-label=${t("Prompt")} value=${editing?.text ?? ""}
			onInput=${(e) => setEditing({ ...editing, text: e.target.value })} />
		<div class="prompt-edit-actions">
			${editing?.index >= 0 ? html`<button class="btn sm ghost prompt-delete" onClick=${() => remove(editing.index)}><${Icon} name="trash" size=${13} />${t("Delete")}</button>` : null}
			<span class="dim prompt-hint">${t("Ctrl+Enter saves")}</span>
			<button class="btn sm" onClick=${() => setEditing(null)}>${t("Cancel")}</button>
			<button class="btn sm primary" disabled=${!editing?.text.trim()} onClick=${save}>${t("Save")}</button>
		</div>
	</div>`;
	return html`
		${prompts.map((prompt, index) => editing?.index === index ? html`<div key=${`e${index}`}>${editor}</div>` : html`<div class="prompt-row" key=${`p${index}`}>
			<button class="prompt-use" title=${prompt.text} onClick=${() => actions.insertIntoComposer(prompt.text)}><${Icon} name="quote" size=${13} class="prompt-mark" /><span class="prompt-title">${prompt.title}</span></button>
			<button class="icon-btn sm" title=${t("Edit")} aria-label=${t("Edit")} onClick=${() => setEditing({ index, title: prompt.title, text: prompt.text })}><${Icon} name="edit" size=${13} /></button>
		</div>`)}
		${editing?.index === -1 ? editor : null}
		${!prompts.length && !editing ? html`<div class="dim prompt-empty">${t("No saved prompts yet. Add the ones you use often; a click puts one into the input.")}</div>` : null}
		${editing ? null : html`<button class="prompt-add" onClick=${() => setEditing({ index: -1, title: "", text: "" })}><${Icon} name="plus" size=${13} />${t("New prompt")}</button>`}`;
}

/** Connected GitHub account and mailboxes; the same accounts Settings → Connections manages. */
function ConnectSection() {
	const c = useConnections();
	return html`<${Section} title=${t("Connections")} count=${c.github && c.mail ? connectedCount(c) : null} defaultOpen=${false}><${ConnectList} c=${c} /><//>`;
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
	const savedPrompts = useStore((s) => s.view.savedPrompts);
	const [editingPrompt, setEditingPrompt] = useState(null);
	useEffect(() => {
		if (!resources) loadResources();
	}, []);
	useEffect(() => {
		loadStats();
	}, [snap?.session?.id, snap?.lastRun?.runId]);
	if (!snap) return null;
	const tokenCount = (key) => formatSessionTokenCount(stats, key);
	// The provider billing a request without reporting its usage leaves these sums behind; say so instead of
	// letting a frozen number look current. The averages are marked separately: only they depend on the newest request.
	const unreportedRequests = stats?.usageUnreportedRequests ?? 0;
	const unreportedBadge = (title) => html`<span class="badge" title=${title}>${t("usage not reported")}</span>`;
	const tokensUnreported =
		unreportedRequests > 0
			? unreportedBadge(
					t("{count} requests of this session answered without the provider reporting token usage; the totals and averages cover only what was reported.", { count: unreportedRequests }),
				)
			: null;
	const averagesUnreported = stats?.latestUsageUnreported
		? unreportedBadge(t("The newest request reported no token usage, so these averages still describe the earlier requests."))
		: null;
	const cost = stats?.costByCurrency ? Object.entries(stats.costByCurrency).map(([currency, value]) => fmtCost(value, currency)).join(" · ") || "—" : fmtCost(stats?.cost);
	const agentActive = resources ? resources.tools.some((tool) => tool.name === "agent" && tool.active) : false;
	const isDelegatedChild = (name) => name === "workflow" || name === "ultracode" || name === "agent_tasks";
	const toggleTool = async (name, on) => {
		// workflow/ultracode/agent_tasks share the sub-agent runtime with agent: they stay disabled while agent is off.
		// The UI disables them (see below); this is the second guard for keyboard/scripts, and the server
		// strips them again so the model can never receive them while agent is off.
		if (isDelegatedChild(name) && !resources.tools.some((tool) => tool.name === "agent" && tool.active) && on) return;
		const current = resources.tools.filter((t) => t.active).map((t) => t.name);
		let names;
		if (name === "agent" && !on) {
			// Turning agent off cascades: workflow + ultracode go off together (and stay disabled until
			// agent is back on). Turning agent on only adds agent; the two children stay as they were.
			names = current.filter((entry) => entry !== "agent" && !isDelegatedChild(entry));
		} else {
			const active = new Set(current);
			if (on) active.add(name);
			else active.delete(name);
			names = [...active];
		}
		await attempt(() => post("/api/tools/active", { names }));
		await loadResources();
		// The agent switch mirrors subAgent.enabled 1:1, so refresh the settings list in this tab at once
		// (other tabs follow via the settings_changed event).
		if (name === "agent") loadSettings().catch(() => {});
	};
	return html`<div class="context-panel">
		<div class="panel-scroll">
			<div class="panel-toolbar">
				<span class="panel-title">${t("Context window")}</span>
			</div>
			<div class="ctx-body ctx-body-top">
				<${ContextDetails} capacityOnly=${true} controls=${html`<${AutoCompact} snap=${snap} /><button class="btn sm" disabled=${snap.active} onClick=${actions.compact}>${t("Compact now")}</button>`} />
			</div>
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
						<span>${t("Input")} ${tokenCount("input")} · ${t("Cache write")} ${tokenCount("cacheWrite")} · ${t("Cache read")} ${tokenCount("cacheRead")} · ${t("Output")} ${tokenCount("output")}</span>${tokensUnreported}
					</span>
					<span aria-hidden="true"></span><span class="session-cumulative">${t("Average speed")} ${fmtSpeed(stats.speed)} · ${t("Average cache hit rate")} <${CacheValue} session=${sessionCache(stats)} />${averagesUnreported}</span>
					<span>${t("Cost")}</span><span>${cost !== "—" && (stats.usageEstimated || stats.costIncomplete) ? "≈ " : ""}${cost}</span>` : null}
			</div>
			<div class="ctx-actions"><button class="btn sm" disabled=${exportReadOnly()} title=${exportReadOnly() ? t("This page is already the export") : undefined} onClick=${actions.exportSession}><${Icon} name="download" size=${13} />${t("Export HTML")}</button></div>
		<//>
		<${Section} title=${t("My prompts")} count=${savedPrompts.length}>
			<${SavedPrompts} prompts=${savedPrompts} editing=${editingPrompt} setEditing=${setEditingPrompt} />
		<//>
		${exportReadOnly() ? null : html`<${ConnectSection} />`}
		<${Section} title=${t("Tools")} count=${resources ? `${resources.tools.filter((t) => t.active).length}/${resources.tools.length}` : ""} defaultOpen=${false}>
			${!resources ? html`<${Spinner} />` : resources.tools.map((tool) => {
				const needsAgent = isDelegatedChild(tool.name) && !agentActive;
				const disabled = snap.active || needsAgent;
				const shown = toolDescription(tool);
				return html`<div class="res-row" key=${tool.name} title=${needsAgent ? t("Enable the agent tool first") : undefined}><div class="col grow"><span class="mono">${tool.name}${tool.extension ? html` <span class="badge">${t("extension")}</span>` : null}</span><span class="dim res-desc" title=${descriptionTip(tool, shown)}>${shown}</span></div><span title=${needsAgent ? t("Enable the agent tool first") : undefined}><${Toggle} checked=${tool.active} label=${tool.name} disabled=${disabled} onChange=${(v) => toggleTool(tool.name, v)} /></span></div>`;
			})}
		<//>
		<${Section} title=${t("Project context files")} count=${resources?.contextFiles.length} defaultOpen=${false}>
			${resources?.contextFiles.map((f) => html`<div class="res-row" key=${f.path}><span class="truncate grow mono" title=${f.path}>${f.path}</span><span class="dim">${t("{fmtTokens} chars", { fmtTokens: fmtTokens(f.chars) })}</span></div>`)}
			${resources && !resources.contextFiles.length ? html`<div class="dim">${t("No AGENTS.md / CLAUDE.md files found.")}</div>` : null}
		<//>
		<div class="ctx-foot service-restart" aria-busy=${restarting}>
			<button class="btn sm" onClick=${restartService} disabled=${snap.active || restarting}>${restarting ? html`<${Spinner} />` : html`<${Icon} name="refresh" size=${13} />`}${restarting ? t("Restarting service…") : restartError ? t("Retry") : t("Restart service")}</button>
			<div class=${`service-restart-detail ${restartError ? "c-danger" : "dim"}`} role=${restartError ? "alert" : "status"} aria-live="polite">${restartError || (restarting ? restartDetail : "")}</div>
		</div>
	</div></div>`;
}
