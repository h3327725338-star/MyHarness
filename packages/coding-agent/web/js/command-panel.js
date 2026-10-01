// Inline command panel: slash commands with several levels of choices (/settings, /model, /effort, /git …) open here, above the
// input, instead of a separate page. Everything works from the keyboard: ↑/↓ move, Enter or → go in or apply, ← / Esc go back,
// Space toggles, and typing filters the searchable lists. The mouse works too, but is never required.
import { html, InlineFrame, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Spinner } from "./ui.js";
import { GENERAL_KEY, api, attempt, loadGitStatus, loadModels, loadProviders, loadSessions, loadSettings, loadSnapshot, loadUnbound, loadWorkspaces, post, readWidthValue, setView, state, toast, useStore } from "./store.js";
import { actions, closeCommand } from "./actions.js";
import { GitInline } from "./overlays-git.js";
import { deleteCustomProvider } from "./overlays-settings.js";
import { modelRefLabel } from "./model-menu.js";
import { serverText, t } from "./i18n.js";
import { LANGUAGES } from "./lang.js";
import { chatTitle, clip, effortHint, effortName, fmtDateTime, fmtTokens, modelEfforts, pointerMoved, relTime } from "./util.js";

// ---- Reusable screens ------------------------------------------------------------------------------------
const tr = (text) => (text ? serverText(text) : text);

function optionsScreen({ title, options, value, onPick, filterable, placeholder, subtitle }) {
	return {
		title,
		subtitle,
		filterable,
		placeholder,
		rows: options.map((option) => ({
			key: String(option.value),
			label: option.label,
			desc: option.desc,
			check: String(option.value) === String(value),
			onEnter: (ctx) => onPick(option.value, ctx),
		})),
	};
}

function confirmScreen({ title, message, confirmLabel, danger, onConfirm }) {
	return {
		title,
		subtitle: message,
		filterable: false,
		rows: [
			{ key: "cancel", label: t("Cancel"), onEnter: (ctx) => ctx.pop() },
			{ key: "ok", label: confirmLabel, danger, onEnter: onConfirm },
		],
		initial: 0,
	};
}

function inputScreen({ title, label, value = "", type = "text", placeholder, submitLabel, onSubmit, min, max }) {
	return { title, input: { label, value, type, placeholder, submitLabel: submitLabel || t("Save"), onSubmit, min, max } };
}

// ---- /effort ------------------------------------------------------------------------------------------------

function effortScreen() {
	const thinking = state.snap?.thinking;
	if (!thinking?.supported) return { title: t("Reasoning effort"), empty: t("The current model does not support reasoning effort."), rows: [] };
	if (thinking.levels.length < 2) return { title: t("Reasoning effort"), empty: t("The current model has no reasoning effort options to choose from."), rows: [] };
	return optionsScreen({
		title: t("Reasoning effort"),
		options: thinking.levels.map((level) => ({ value: level, label: effortName(level), desc: effortHint(level) })),
		value: thinking.level,
		onPick: async (level, ctx) => {
			if (await attempt(() => post("/api/thinking", { level }))) ctx.close();
		},
	});
}

// ---- /model -------------------------------------------------------------------------------------------------
/** The efforts of one model, opened from its row (Model → its efforts). `withDefault` adds "Default" (no effort sent). */
function effortsScreen({ title, levels, value, withDefault, onPick }) {
	return optionsScreen({
		title,
		subtitle: t("Thinking effort"),
		options: [...(withDefault ? [{ value: "", label: t("Default"), desc: t("No effort sent") }] : []), ...levels.map((level) => ({ value: level, label: effortName(level), desc: effortHint(level) }))],
		value: value ?? "",
		onPick: (level, c) => onPick(level || undefined, c),
	});
}

function modelScreen(ctx, arg) {
	const models = useStore((s) => s.models);
	const snap = useStore((s) => s.snap);
	const current = snap?.model;
	useEffect(() => {
		loadModels();
	}, []);
	const running = !!snap?.active;
	const choose = async (m, thinkingLevel, c) => {
		if (await attempt(() => post("/api/model", { provider: m.provider, id: m.id, ...(thinkingLevel ? { thinkingLevel } : {}) }))) {
			await attempt(loadSnapshot, { quiet: true });
			c.close();
		}
	};
	const rows = [];
	for (const provider of models?.providers || []) {
		rows.push({ key: `g-${provider.id}`, group: provider.name });
		for (const m of provider.models) {
			const isCurrent = !!current && current.provider === m.provider && current.id === m.id;
			const levels = modelEfforts(m);
			rows.push({
				key: `${m.provider}/${m.id}`,
				label: m.name || m.id,
				search: `${provider.id} ${provider.name} ${m.id} ${m.name} ${provider.id}/${m.id}`,
				badges: [m.input.includes("image") ? t("image") : ""].filter(Boolean),
				value: isCurrent && levels.length ? effortName(snap.thinking.level) : fmtTokens(m.contextWindow),
				check: isCurrent,
				chevron: levels.length > 0,
				disabled: running,
				// A model with efforts opens them first; the others are chosen at once.
				onEnter: (c) =>
					levels.length
						? c.push(() => effortsScreen({ title: m.name || m.id, levels, value: isCurrent ? snap.thinking.level : undefined, onPick: (level, cc) => choose(m, level, cc) }))
						: choose(m, undefined, c),
			});
		}
	}
	rows.push({ key: "providers", label: t("Manage providers…"), icon: "key", chevron: true, onEnter: (c) => c.push((cc) => providersScreen(cc)) });
	return {
		title: t("Choose a model"),
		subtitle: running ? t("Models can be switched when the agent is idle") : undefined,
		filterable: true,
		initialFilter: arg,
		placeholder: t("Search by provider or model ID…"),
		loading: !models,
		rows,
		empty: models && !models.providers.length ? t("No model is available. Add a provider in Settings.") : t("No models match."),
	};
}

// ---- /settings ----------------------------------------------------------------------------------------------

/** A settings item by id, as the server lists it (GET /api/settings). */
const settingItem = (id) => state.settings?.items.find((item) => item.id === id);

/** A root row for one setting: the terminal's English name, and a description in the interface language. */
function settingRow(id, label, desc) {
	const item = settingItem(id);
	if (!item) return null;
	return { ...itemRow(item), key: id, label, desc: t(desc), search: `${id} ${item.label} ${item.description || ""}` };
}

/** A screen with a few related settings (Web Search, Context Window, Warnings …). */
function groupScreen(title, ids, subtitle) {
	return () => {
		const rows = ids.map((id) => settingItem(id)).filter(Boolean).map((item) => itemRow(item));
		return { title, subtitle, rows, loading: !state.settings };
	};
}

const onOff = (value) => (value ? t("On") : t("Off"));

/**
 * The same list, order and names as the terminal's /settings; every row edits the same settings.json / models.json /
 * credentials through the same server calls. A few Web-only settings follow under "More".
 */
function settingsRoot() {
	const settings = useStore((s) => s.settings);
	const snap = useStore((s) => s.snap);
	useEffect(() => {
		if (!state.settings) loadSettings();
	}, []);
	const model = snap?.model;
	const value = (id) => settingItem(id)?.value;
	const nav = (key, label, desc, icon, build, extra = {}) => ({ key, label, desc: t(desc), icon, chevron: true, onEnter: (ctx) => ctx.push(build), ...extra });
	const web = value("webSearch.enabled");
	const contextSummary = [value("contextWindowMain") || t("model"), value("contextWindowSubAgent") || t("model")].join(" · ");
	const rows = [
		nav("providers", "Providers", "Manage model services and keys", "key", (c) => providersScreen(c)),
		nav("github", "GitHub Connect", "Connect GitHub", "gitBranch", (c) => githubScreen(c)),
		nav("default-model", "Default Model", "Choose the main model", "cpu", (c) => modelScreen(c, ""), { value: model ? `${model.provider}/${model.id} · ${snap?.thinking?.level ?? "off"}` : t("Not selected") }),
		settingRow("autoMemory", "Auto Memory", "Remember preferences and project facts"),
		settingRow("subAgent", "Sub Agent", "Investigate complex tasks in parallel"),
		nav("web-search", "Web Search", "Search the web", "globe", groupScreen("Web Search", ["webSearch.enabled", "webSearch.engines", "webSearch.pagesPerSearch", "webSearch.maxUrlsPerFetch", "webSearch.fetchConcurrency", "webSearch.browserFallback"]), { value: web === undefined ? "" : onOff(web) }),
		settingRow("codeIntelligence.enabled", "Code Intelligence", "Optional semantic code modules"),
		nav("context-window", "Context Window", "Context limits", "layers", groupScreen("Context Window", ["contextWindowMain", "contextWindowSubAgent"], t("Empty uses the model's own window.")), { value: contextSummary }),
		settingRow("visionAssistant", "Vision Assistant", "Use a dedicated model to look at images"),
		nav("git", "Git", "Keep local versions of the code", "gitBranch", () => gitRoot(), { value: snap?.git ? onOff(snap.git.enabled) : "" }),
		settingRow("compactionModel", "Compact Model", "Model and thinking effort used for compaction"),
		settingRow("autoCompact", "Auto-compact", "Compact long conversations automatically"),
		settingRow("steeringMode", "Steering mode", "How messages sent during a reply are delivered"),
		settingRow("followUpMode", "Follow-up mode", "How messages for after the task are delivered"),
		settingRow("transport", "Transport", "How to connect to the model"),
		settingRow("httpIdleTimeoutMs", "HTTP idle timeout", "How long an idle connection may stay open"),
		settingRow("hideThinkingBlock", "Collapse transcript", "Terminal UI: collapse thinking and tool output"),
		settingRow("showCacheMissNotices", "Cache miss notices", "Notice when prompt-cache reuse fails"),
		settingRow("collapseChangelog", "Collapse changelog", "Terminal UI: condensed changelog after updates"),
		settingRow("quietStartup", "Quiet startup", "Terminal UI: hide startup details"),
		settingRow("enableInstallTelemetry", "Install telemetry", "Send anonymous version statistics"),
		settingRow("defaultProjectTrust", "Default project trust", "Default trust for new projects"),
		nav("project-trust", "Project trust", "Trust decision for this project", "shield", (c) => projectTrustScreen(c), { value: snap?.trust?.requiresTrust ? (snap.trust.trusted ? t("Trusted") : t("Not trusted")) : "" }),
		settingRow("doubleEscapeAction", "Double-escape action", "Compatibility setting, currently has no effect"),
		nav("warnings", "Warnings", "Manage billing-related warnings", "alertTriangle", groupScreen("Warnings", ["warnings.anthropicExtraUsage"])),
		nav("thinking", "Thinking level", "Model thinking effort", "brain", () => effortScreen(), { value: snap?.thinking?.supported ? effortName(snap.thinking.level) : "" }),
		nav("appearance", "Appearance", "Theme, language and layout of the Web UI (the terminal keeps its own theme)", "eye", () => appearanceScreen()),
		settingRow("showImages", "Show images", "Terminal UI: show images inline"),
		settingRow("imageWidthCells", "Image width", "Terminal UI: width of inline images"),
		settingRow("autoResizeImages", "Auto-resize images", "Shrink oversized images automatically"),
		settingRow("blockImages", "Block images", "Never send images to the model"),
		settingRow("enableSkillCommands", "Skill commands", "Add skills as slash commands"),
		settingRow("showHardwareCursor", "Show hardware cursor", "Terminal UI: show the terminal's input cursor"),
		settingRow("editorPaddingX", "Editor padding", "Terminal UI: padding of the input box"),
		settingRow("outputPad", "Output padding", "Terminal UI: padding of messages"),
		settingRow("autocompleteMaxVisible", "Autocomplete max items", "Terminal UI: number of completion candidates"),
		settingRow("clearOnShrink", "Clear on shrink", "Terminal UI: clear leftover text"),
		settingRow("showTerminalProgress", "Terminal progress", "Terminal UI: show the running state"),
		settingRow("popupNotifications", "Popup notifications", "Desktop popup when a task ends"),
		{ key: "more", group: t("More") },
		settingRow("autoRetry", "Auto-retry", "Retry transient provider errors"),
		settingRow("enabledModels", "Model cycling scope", "Models used when cycling models"),
		settingRow("webShutdownGraceSeconds", "Web UI exit delay", "Seconds the server waits after the last page closes"),
		settingRow("shellPath", "Shell path", "Shell used by the bash tool"),
		settingRow("shellCommandPrefix", "Command prefix", "Prepended to every bash command"),
		settingRow("enableAnalytics", "Analytics", "Analytics data sharing"),
		nav("about", "About", "Version, shortcuts and quitting", "info", () => aboutScreen()),
	].filter(Boolean);
	return { title: t("Settings"), placeholder: t("Search settings…"), loading: !settings, rows };
}

/** Project Trust of the current project (the terminal asks for it when a project is opened). */
function projectTrustScreen() {
	const { data: trust, reload } = useLoaded(() => api("/api/trust"));
	if (!trust) return { title: t("Project trust"), loading: true, rows: [] };
	return {
		title: t("Project trust"),
		subtitle: `${trust.cwd}\n${trust.requiresTrust ? (trust.trusted ? t("Trusted — project settings, skills, prompts and extensions are loaded.") : t("Not trusted — project resources are ignored and project extensions do not run.")) : t("This project has no resources that need trust.")}`,
		rows: trust.requiresTrust
			? trust.options.map((o) => ({
					key: o.id,
					label: tr(o.label),
					onEnter: async (c) => {
						if (await attempt(() => post("/api/trust", { option: o.id }))) {
							toast(t("Trust decision saved. Reloading resources…"), "info", 3000);
							await attempt(() => post("/api/resources/reload"));
							await loadSnapshot();
							reload();
							c.pop();
						}
					},
				}))
			: [],
		empty: t("This project has no resources that need trust."),
	};
}

// ---- GitHub Connect (same account connection as the terminal) ----------------------------------------------------
function githubScreen() {
	const { data, error, reload } = useLoaded(() => api("/api/github"));
	const event = useStore((s) => s.githubEvent);
	const [prompt, setPrompt] = useState(null);
	const [waiting, setWaiting] = useState(false);
	useEffect(() => {
		if (!event) return;
		if (event.type === "prompt") return setPrompt(event.prompt);
		setWaiting(false);
		setPrompt(null);
		if (event.type === "done") toast(event.verified ? t("The connection is valid; GitHub confirmed the account.") : t("GitHub connected; the credentials are saved."), "info", 5000);
		if (event.type === "error") toast(serverText(event.message), "error", 9000);
		reload();
	}, [event?.nonce]);
	if (!data) return { title: "GitHub Connect", loading: !error, error, rows: [] };
	const account = data.account;
	const pendingPrompt = prompt ?? data.pending?.prompt ?? null;
	const busy = waiting || !!data.pending;
	const start = async (verify) => {
		setWaiting(true);
		if (!(await attempt(() => post("/api/github/connect", { verify })))) setWaiting(false);
	};
	const clientIdScreen = () =>
		inputScreen({
			title: "GitHub Client ID",
			label: t("Paste the Client ID of your GitHub OAuth app (no Client Secret needed). Create one with Homepage and callback URL http://localhost and “Enable Device Flow” ticked."),
			placeholder: "Client ID",
			onSubmit: async (value, c) => {
				if (!value.trim()) return;
				if (await attempt(() => post("/api/github/client-id", { clientId: value }), { success: t("Saved.") })) {
					reload();
					c.pop();
				}
			},
		});
	const rows = [];
	if (busy) {
		if (pendingPrompt) rows.push({ key: "code", label: t("Enter the code {code} on GitHub", { code: pendingPrompt.code }), desc: pendingPrompt.url, icon: "externalLink", onEnter: () => window.open(pendingPrompt.url, "_blank", "noopener") });
		else rows.push({ key: "wait", label: t("Waiting for GitHub…"), disabled: true });
		rows.push({ key: "cancel", label: t("Cancel"), icon: "x", onEnter: async () => (await attempt(() => post("/api/github/cancel")), setWaiting(false), setPrompt(null), reload()) });
	} else if (account) {
		rows.push({
			key: "disconnect",
			label: t("Disconnect…"),
			desc: t("Removes the saved credentials from this computer"),
			danger: true,
			chevron: true,
			onEnter: (c) =>
				c.push(() => ({
					title: t("Disconnect GitHub?"),
					subtitle: t("The saved credentials of @{login} are removed from this computer. The account and repositories are not deleted, and GitHub's own authorization stays until you revoke it there.", { login: account.login }),
					rows: [
						{ key: "keep", label: t("Keep the connection"), onEnter: (cc) => cc.pop() },
						{ key: "remove", label: t("Disconnect"), danger: true, onEnter: async (cc) => { if (await attempt(() => post("/api/github/disconnect"))) { reload(); cc.pop(); } } },
						{ key: "revoke", label: t("Open GitHub authorization settings"), icon: "externalLink", onEnter: () => window.open("https://github.com/settings/applications", "_blank", "noopener") },
					],
				})),
		});
		rows.push({ key: "verify", label: t("Verify connection"), desc: t("Check the login, refreshing it when needed"), onEnter: () => start(true) });
		rows.push({ key: "reconnect", label: t("Reauthorize"), desc: t("For an expired login or missing permissions"), onEnter: () => start(false) });
	} else {
		rows.push({ key: "connect", label: t("Connect GitHub"), desc: t("Authorize this device in the browser"), icon: "gitBranch", ...(data.clientIdConfigured ? { onEnter: () => start(false) } : { chevron: true, onEnter: (c) => c.push(clientIdScreen) }) });
	}
	rows.push({ key: "client", label: "Client ID", desc: data.clientIdFromEnvironment ? t("Set by MYHARNESS_GITHUB_CLIENT_ID, which takes precedence.") : t("First setup or a different app"), value: data.clientIdConfigured ? t("set") : t("not set"), chevron: true, onEnter: (c) => c.push(clientIdScreen) });
	rows.push({ key: "new-app", label: t("Create a GitHub app"), icon: "externalLink", onEnter: () => window.open("https://github.com/settings/applications/new", "_blank", "noopener") });
	return {
		title: "GitHub Connect",
		subtitle: [
			data.error ? serverText(data.error) : "",
			account ? t("Saved account: @{login}", { login: account.login }) : t("Connect GitHub so MyHarness can work with your GitHub data: private repositories, email addresses, organizations and workflows."),
			data.needsReauthorization ? t("This older connection lacks permissions; reauthorize to reach private repositories.") : "",
		].filter(Boolean).join("\n"),
		rows,
	};
}

async function applySetting(id, value) {
	const result = await attempt(() => post("/api/settings", { id, value }));
	await loadSettings();
	await loadSnapshot();
	if (id === "webSearch.enabled" || id.startsWith("subAgent")) loadModels();
	if (result?.errors?.length) toast(result.errors.map((e) => e.message).join("\n"), "error");
	return result;
}

function shownValue(item) {
	switch (item.type) {
		case "boolean":
			return item.value ? t("On") : t("Off");
		case "enum":
			return tr(item.options.find((o) => String(o.value) === String(item.value))?.label ?? String(item.value));
		case "multi":
			return (item.value || []).map((v) => tr(item.options.find((o) => o.value === v)?.label ?? v)).join(", ");
		case "modelRef": {
			const v = item.value || {};
			return item.note === "enabled" && !v.enabled ? t("Off") : modelRefLabel(state.models, v);
		}
		case "text":
			return item.value ? clip(String(item.value), 28) : "—";
		default:
			return item.value === undefined || item.value === null ? "—" : String(item.value);
	}
}

function itemRow(item) {
	// Setting names stay in English (as in the terminal); descriptions follow the interface language.
	const row = { key: item.id, label: item.label, desc: tr(item.description), value: shownValue(item), chevron: true };
	switch (item.type) {
		case "boolean":
			return { ...row, chevron: false, toggle: !!item.value, onEnter: () => applySetting(item.id, !item.value) };
		case "enum":
			return {
				...row,
				onEnter: (ctx) =>
					ctx.push(() => {
						const live = state.settings?.items.find((i) => i.id === item.id) || item;
						return optionsScreen({
							title: tr(item.label),
							subtitle: tr(item.description),
							options: item.options.map((o) => ({ value: o.value, label: tr(o.label) })),
							value: live.value,
							onPick: async (value, c) => {
								await applySetting(item.id, value);
								c.pop();
							},
						});
					}),
			};
		case "number":
			return { ...row, onEnter: (ctx) => ctx.push(() => inputScreen({ title: tr(item.label), label: tr(item.description), value: String(item.value ?? ""), type: "number", min: item.min, max: item.max, onSubmit: async (value, c) => { if (value === "") return; await applySetting(item.id, Number(value)); c.pop(); } })) };
		case "text":
			return { ...row, onEnter: (ctx) => ctx.push(() => inputScreen({ title: tr(item.label), label: tr(item.description), value: String(item.value ?? ""), onSubmit: async (value, c) => { await applySetting(item.id, value); c.pop(); } })) };
		case "multi":
			return { ...row, onEnter: (ctx) => ctx.push(() => multiScreen(item)) };
		case "modelRef":
			return { ...row, onEnter: (ctx) => ctx.push((c) => modelRefScreen(c, item.id)) };
		default:
			return { ...row, chevron: false };
	}
}

function multiScreen(item) {
	const live = state.settings?.items.find((i) => i.id === item.id) || item;
	const chosen = new Set(live.value || []);
	return {
		title: tr(item.label),
		subtitle: tr(item.description),
		rows: item.options.map((o) => ({
			key: o.value,
			label: tr(o.label),
			toggle: chosen.has(o.value),
			onEnter: async () => {
				const next = new Set(chosen);
				if (next.has(o.value)) next.delete(o.value);
				else next.add(o.value);
				if (!next.size) return toast(t("Select at least one."), "warning", 2500);
				await applySetting(item.id, [...next]);
			},
		})),
	};
}

function modelRefScreen(ctx, id) {
	const models = useStore((s) => s.models);
	useEffect(() => {
		if (!state.models) loadModels();
	}, []);
	const item = state.settings?.items.find((i) => i.id === id);
	if (!item) return { title: t("Settings"), loading: true, rows: [] };
	const v = item.value || {};
	const commit = (next) => applySetting(id, { ...v, ...next });
	const rows = [];
	if (item.note === "enabled") rows.push({ key: "enabled", label: t("Enabled"), toggle: !!v.enabled, onEnter: () => commit({ enabled: !v.enabled }) });
	rows.push({
		key: "model",
		label: t("Model"),
		value: modelRefLabel(models, v),
		chevron: true,
		onEnter: (c) =>
			c.push(() => ({
				title: tr(item.label),
				filterable: true,
				placeholder: t("Search by provider or model ID…"),
				loading: !models,
				rows: [
					// The main model comes with its effort: nothing of its own is kept.
					{ key: "main", label: t("Use the main model"), desc: t("Same model and thinking effort as the main chat"), check: !v.model, onEnter: async (cc) => (await commit({ provider: undefined, model: undefined, thinkingLevel: undefined }), cc.pop()) },
					...(models?.providers || []).flatMap((g) =>
						g.models.map((m) => {
							const levels = modelEfforts(m);
							const isCurrent = v.provider === g.id && v.model === m.id;
							return {
								key: `${g.id}/${m.id}`,
								label: m.name || m.id,
								search: `${g.id} ${g.name} ${m.id} ${m.name} ${g.id}/${m.id}`,
								desc: g.name,
								value: isCurrent && levels.length ? (v.thinkingLevel ? effortName(v.thinkingLevel) : t("Default")) : undefined,
								check: isCurrent,
								chevron: levels.length > 0,
								onEnter: (cc) =>
									levels.length
										? cc.push(() => effortsScreen({ title: m.name || m.id, levels, withDefault: true, value: isCurrent ? v.thinkingLevel : undefined, onPick: async (level, c3) => (await commit({ provider: g.id, model: m.id, thinkingLevel: level }), c3.pop(), c3.pop()) }))
										: commit({ provider: g.id, model: m.id, thinkingLevel: undefined }).then(() => cc.pop()),
							};
						}),
					),
				],
			})),
	});
	return { title: tr(item.label), subtitle: tr(item.description), rows };
}

function appearanceScreen() {
	const view = state.view;
	const choice = (id, label, desc, key, options) => ({
		key: id,
		label: t(label),
		desc: t(desc),
		value: t(options.find((o) => o.value === view[key])?.label ?? String(view[key])),
		chevron: true,
		onEnter: (ctx) =>
			ctx.push(() =>
				optionsScreen({
					title: t(label),
					subtitle: t(desc),
					options: options.map((o) => ({ value: o.value, label: key === "lang" ? o.label : t(o.label) })),
					value: state.view[key],
					onPick: (value, c) => {
						// The whole interface is rebuilt in the new language; reopen this panel where the user was.
						if (key === "lang") return setView({ lang: value, cmd: { name: "settings", arg: "", nonce: Date.now(), path: ["appearance"] } });
						setView({ [key]: value });
						c.pop();
					},
				}),
			),
	});
	return {
		title: t("Appearance"),
		rows: [
			choice("lang", "UI language", "Language of the MyHarness interface. Chat content is never translated.", "lang", LANGUAGES),
			choice("theme", "Theme", "Dark and light are separate designs; “System” follows Windows.", "theme", [{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]),
			choice("density", "Density", "Control height and text size.", "density", [{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }]),
			choice("motion", "Animations", "Loading shimmer, expand/collapse and fades. Status is always shown in text too.", "motion", [{ value: "system", label: "System" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]),
			{
				key: "readWidth",
				label: t("Reading width"),
				desc: t("Width of the conversation column."),
				value: view.readWidth === "auto" ? t("Auto") : `${view.readWidth}px`,
				chevron: true,
				onEnter: (ctx) => ctx.push(() => inputScreen({ title: t("Reading width"), label: t("Width of the conversation column in px (620–1100). Empty: grows with the window."), value: state.view.readWidth === "auto" ? "" : String(state.view.readWidth), type: "number", min: 620, max: 1100, placeholder: t("Auto"), onSubmit: (value, c) => (setView({ readWidth: readWidthValue(value) }), c.pop()) })),
			},
			choice("processDefault", "Run steps", "Whether the steps behind a finished answer start expanded.", "processDefault", [{ value: "collapsed", label: "Collapsed" }, { value: "expanded", label: "Expanded" }]),
			{
				key: "notify",
				label: t("Browser notification when a task ends"),
				desc: t("Only while this tab is in the background."),
				toggle: !!view.notify,
				onEnter: async () => {
					if (state.view.notify) return setView({ notify: false });
					if (typeof Notification === "undefined") return toast(t("This browser does not support notifications."), "warning");
					const permission = await Notification.requestPermission();
					if (permission === "granted") setView({ notify: true });
					else toast(t("Notification permission was not granted."), "warning");
				},
			},
		],
	};
}

function aboutScreen() {
	const snap = state.snap;
	return {
		title: t("About"),
		rows: [
			{ key: "version", label: t("Version"), value: snap?.app.version },
			{ key: "platform", label: t("Platform"), value: snap?.app.platform },
			{ key: "started", label: t("Server started"), value: snap ? fmtDateTime(snap.app.startedAt) : "" },
			{ key: "workspace", label: t("Workspace"), value: clip(snap?.cwd || "", 46) },
			{ key: "quit", label: t("Quit MyHarness"), icon: "quit", danger: true, onEnter: (c) => (c.close(), actions.shutdown()) },
		],
	};
}

// ---- Providers ----------------------------------------------------------------------------------------------
function providersScreen(ctx) {
	const providers = useStore((s) => s.providers);
	useEffect(() => {
		loadProviders();
	}, []);
	return {
		title: t("Providers"),
		loading: !providers,
		placeholder: t("Search providers…"),
		rows: [
			...(providers?.providers || []).map((p) => ({
				key: p.id,
				label: p.name,
				desc: p.id,
				value: p.configured ? t("signed in") : t("no credentials"),
				badges: p.enabled ? [] : [t("disabled")],
				chevron: true,
				onEnter: (c) => c.push((cc) => providerScreen(cc, p.id)),
			})),
			{ key: "add", label: t("Add Provider…"), desc: t("Connect a compatible API service"), icon: "plus", onEnter: (c) => (c.close(), setView({ providerEditor: { id: null } })) },
		],
		empty: t("No providers configured yet. Add a custom provider below, or sign in to one."),
	};
}

function providerScreen(ctx, id) {
	const providers = useStore((s) => s.providers);
	const login = useStore((s) => s.loginEvent);
	const provider = providers?.providers.find((p) => p.id === id);
	if (!provider) return { title: t("Providers"), loading: true, rows: [] };
	const act = async (fn, ok) => {
		const result = await attempt(fn, { success: ok });
		await loadProviders();
		return result;
	};
	const c = provider.credentials;
	const rows = [
		{ key: "enabled", label: t("Enabled"), toggle: provider.enabled, onEnter: () => act(() => post("/api/providers/enabled", { id, enabled: !provider.enabled })) },
	];
	for (const k of c?.apiKeys || []) {
		rows.push({ key: `k-${k.id}`, label: `${serverText(k.label)} ${k.suffix ? `••••${k.suffix}` : ""}`.trim(), value: k.active ? t("active") : "", chevron: true, onEnter: (cc) => cc.push((c2) => keyScreen(c2, id, k.id)) });
	}
	if (c?.hasOAuth) rows.push({ key: "oauth-use", label: t("OAuth login"), value: c.active?.type === "oauth" ? t("active") : "", onEnter: () => c.active?.type !== "oauth" && act(() => post("/api/providers/oauth/activate", { id })) });
	if (provider.supportsApiKeyLogin) {
		rows.push({
			key: "add-key",
			label: t("Add API key…"),
			icon: "plus",
			chevron: true,
			onEnter: (cc) =>
				cc.push(() =>
					inputScreen({
						title: t("API key label"),
						label: t("Optional name for this key"),
						placeholder: t("Label"),
						submitLabel: t("Next"),
						onSubmit: (label, c2) =>
							c2.push(() =>
								inputScreen({
									title: t("API key"),
									label: t("Paste the key. It is stored on this computer only."),
									type: "password",
									placeholder: t("API key"),
									onSubmit: async (key, c3) => {
										if (!key.trim()) return;
										if (await act(() => post("/api/providers/api-key/add", { id, label, key }), t("API key saved"))) {
											c3.pop();
											c3.pop();
										}
									},
								}),
							),
					}),
				),
		});
	}
	if (provider.supportsOAuth) rows.push({ key: "oauth", label: t("Sign in with OAuth"), icon: "key", desc: login?.type === "auth_url" ? t("Waiting for the browser sign-in…") : login?.type === "device_code" ? `${login.verificationUri} · ${login.userCode}` : undefined, onEnter: () => act(() => post("/api/providers/oauth/login", { id }), t("Signed in")) });
	if (provider.custom) rows.push({ key: "config", label: t("Provider settings & models…"), desc: t("{n} models · detect models by ID · advanced JSON", { n: provider.modelCount }), icon: "edit", onEnter: (cc) => (cc.close(), setView({ providerEditor: { id } })) });
	if (provider.custom) rows.push({ key: "delete", label: t("Delete provider…"), danger: true, onEnter: async (cc) => { if (await deleteCustomProvider(id, provider.name)) cc.pop(); } });
	return { title: provider.name, subtitle: `${provider.id}${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}`, rows };
}

function keyScreen(ctx, providerId, keyId) {
	const providers = useStore((s) => s.providers);
	const provider = providers?.providers.find((p) => p.id === providerId);
	const key = provider?.credentials?.apiKeys.find((k) => k.id === keyId);
	if (!provider || !key) return { title: t("API key"), loading: false, rows: [], empty: t("This key no longer exists.") };
	const act = async (fn) => {
		const result = await attempt(fn);
		if (result) await loadProviders();
		return result;
	};
	const rows = [];
	if (!key.active) rows.push({ key: "use", label: t("Use this key"), onEnter: async (c) => (await act(() => post("/api/providers/api-key/activate", { id: providerId, keyId })), c.pop()) });
	rows.push({
		key: "rename",
		label: t("Rename"),
		chevron: true,
		onEnter: (c) => c.push(() => inputScreen({ title: t("Rename API key"), label: t("Name"), value: key.label, onSubmit: async (label, c2) => { if (label.trim() && (await act(() => post("/api/providers/api-key/rename", { id: providerId, keyId, label })))) c2.pop(); } })),
	});
	const alternatives = provider.credentials.apiKeys.filter((o) => o.id !== keyId);
	rows.push({
		key: "delete",
		label: t("Delete this API key"),
		danger: true,
		chevron: true,
		onEnter: (c) => {
			const remove = async (replacementKeyId, c2) => {
				if (await act(() => post("/api/providers/api-key/delete", { id: providerId, keyId, replacementKeyId }))) c2.pop();
			};
			if (key.active && alternatives.length) {
				return c.push(() =>
					optionsScreen({
						title: t("Choose the replacement key"),
						subtitle: t("This key is active. Choose the key to use instead."),
						options: alternatives.map((o) => ({ value: o.id, label: serverText(o.label) })),
						onPick: (replacement, c2) => remove(replacement, c2),
					}),
				);
			}
			return c.push(() => confirmScreen({ title: t("Delete API key?"), message: t("“{name}” is removed from this computer's credentials.", { name: serverText(key.label) }), confirmLabel: t("Delete"), danger: true, onConfirm: (c2) => remove(undefined, c2) }));
		},
	});
	return { title: serverText(key.label), rows };
}

// ---- /git ---------------------------------------------------------------------------------------------------
function gitRoot() {
	const gitStatus = useStore((s) => s.gitStatus);
	const checkpoint = useStore((s) => s.snap?.checkpoint);
	useEffect(() => {
		loadGitStatus();
	}, []);
	const dirty = gitStatus?.preview?.total || 0;
	const inline = (kind, title) => (ctx) => ctx.push(() => ({ title, custom: (c) => html`<${GitInline} kind=${kind} onClose=${c.pop} />` }));
	return {
		title: t("Git"),
		subtitle: gitStatus?.isRepository ? `${gitStatus.branch || t("detached HEAD")} · ${dirty ? t("{n} uncommitted", { n: dirty }) : t("clean")}` : gitStatus ? t("This workspace is not a Git repository.") : undefined,
		rows: [
			{ key: "changes", label: t("Review changes"), icon: "fileDiff", onEnter: (c) => (c.close(), actions.openChanges({ git: true })) },
			{ key: "commit", label: t("Commit…"), desc: t("Creates one local commit for the task's changes. Nothing is pushed."), chevron: true, onEnter: inline("commit", t("Commit changes")) },
			{ key: "push", label: t("Push…"), desc: t("Publishes commits that already exist on this branch, then waits for the CI result."), chevron: true, onEnter: inline("push", t("Push to upstream")) },
			...(checkpoint?.status === "created" ? [{ key: "undo", label: t("Undo task…"), desc: t("Keep or undo this task's changes"), chevron: true, onEnter: inline("undo", t("This task's uncommitted changes")) }] : []),
			{ key: "restore", label: t("Restore to last commit…"), desc: t("Permanently discards every uncommitted change."), chevron: true, danger: true, onEnter: inline("restore", t("Restore to the latest commit")) },
			{ key: "worktrees", label: t("Worktrees"), chevron: true, onEnter: (c) => c.push((cc) => worktreesScreen(cc)) },
			{ key: "history", label: t("History"), chevron: true, onEnter: (c) => c.push(() => historyScreen()) },
			{ key: "repos", label: t("Repositories"), chevron: true, onEnter: (c) => c.push((cc) => repositoriesScreen(cc)) },
			gitStatus?.integrationEnabled
				? { key: "integration", label: t("Turn off Git integration"), onEnter: async () => (await attempt(() => post("/api/git/enable", { enabled: false })), loadGitStatus(), toast(t("Git integration turned off (history is kept)."), "info", 3000)) }
				: { key: "integration", label: t("Turn on Git integration…"), chevron: true, onEnter: inline("enable", t("Set up Git for this project")) },
		],
	};
}

function useLoaded(loader, deps = []) {
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	const reload = () => loader().then((d) => (setData(d), setError(""))).catch((e) => setError(e.message));
	useEffect(() => {
		reload();
	}, deps);
	return { data, error, reload };
}

function worktreesScreen(ctx) {
	const { data, error, reload } = useLoaded(() => api("/api/git/worktrees"));
	const busy = !!state.snap?.active;
	return {
		title: t("Worktrees"),
		loading: !data && !error,
		error,
		rows: [
			...(data?.worktrees || []).map((w) => ({
				key: w.path,
				label: w.branch || t("(detached)"),
				desc: w.path,
				badges: [w.isMain ? t("main worktree") : "", w.current ? t("current") : ""].filter(Boolean),
				chevron: true,
				onEnter: (c) =>
					c.push(() => ({
						title: w.branch || w.path,
						subtitle: w.path,
						rows: [
							{ key: "enter", label: t("Enter"), disabled: w.current || busy, onEnter: async (cc) => { if (await attempt(() => post("/api/git/worktrees/enter", { path: w.path }))) cc.close(); } },
							...(!w.isMain
								? [
										{ key: "combine", label: t("Combine into main"), disabled: busy, onEnter: async (cc) => { const r = await attempt(() => post("/api/git/worktrees/combine", { branch: w.branch })); if (r) { toast(r.message || (r.status === "merged" ? t("Merged into main and removed.") : r.error || r.status), r.ok ? "info" : "error", 8000); reload(); cc.pop(); } } },
										{ key: "delete", label: t("Delete"), danger: true, disabled: w.current || busy, onEnter: async (cc) => { if (await attempt(() => post("/api/git/worktrees/delete", { path: w.path }))) { reload(); cc.pop(); } } },
									]
								: []),
						],
					})),
			})),
			{
				key: "create",
				label: t("Create worktree…"),
				icon: "plus",
				chevron: true,
				onEnter: (c) => c.push(() => inputScreen({ title: t("Create worktree"), label: t("Branch name"), placeholder: t("branch name"), submitLabel: t("Create"), onSubmit: async (branch, cc) => { if (branch.trim() && (await attempt(() => post("/api/git/worktrees/create", { branch, newBranch: true }), { success: t("Worktree created") }))) { reload(); cc.pop(); } } })),
			},
		],
	};
}

function historyScreen() {
	const { data, error } = useLoaded(() => api("/api/git/log"));
	return {
		title: t("History"),
		loading: !data && !error,
		error,
		filterable: true,
		placeholder: t("Search commits…"),
		empty: t("No commits"),
		rows: (data?.commits || []).map((c) => ({ key: c.sha, label: c.subject, search: `${c.short} ${c.subject} ${c.author}`, value: c.short, desc: `${c.author} · ${fmtDateTime(c.at)}` })),
	};
}

function repositoriesScreen(ctx) {
	const { data, error, reload } = useLoaded(() => api("/api/git/repositories"));
	return {
		title: t("Repositories"),
		loading: !data && !error,
		error,
		rows: [
			...(data?.repositories || []).map((r) => ({
				key: r.id,
				label: r.name,
				desc: r.rootPath,
				chevron: true,
				onEnter: (c) =>
					c.push(() => ({
						title: r.name,
						subtitle: r.rootPath,
						rows: [
							{ key: "add", label: t("Add as workspace"), onEnter: async (cc) => { if (await attempt(() => post("/api/workspaces/add", { path: r.rootPath }))) { actions.refresh(); cc.pop(); } } },
							{ key: "forget", label: t("Forget"), danger: true, onEnter: async (cc) => { if (await attempt(() => post("/api/git/repositories/remove", { id: r.id }))) { reload(); cc.pop(); } } },
						],
					})),
			})),
			{
				key: "register",
				label: t("Register repository…"),
				icon: "plus",
				chevron: true,
				onEnter: (c) => c.push(() => inputScreen({ title: t("Register repository"), label: t("Folder of the repository"), placeholder: "C:\\path\\to\\repository", submitLabel: t("Register"), onSubmit: async (path, cc) => { if (path.trim() && (await attempt(() => post("/api/git/repositories/add", { path }), { success: t("Repository registered") }))) { reload(); cc.pop(); } } })),
			},
		],
	};
}

// ---- /workspace ---------------------------------------------------------------------------------------------
const CHAT_ROWS = 30;

/** The chats of a workspace (or of the General group) as rows that open the chat. */
function chatRows(sessions, filterCurrent) {
	return (sessions || []).slice(0, CHAT_ROWS).map((info) => ({
		key: info.path,
		label: chatTitle(info),
		desc: relTime(info.modified),
		search: `${chatTitle(info)} ${info.firstMessage || ""}`,
		check: !!filterCurrent && info.path === filterCurrent,
		onEnter: async (c) => {
			await actions.openSession(info.path);
			c.close();
		},
	}));
}

function workspaceScreen(w) {
	const sessions = useStore((s) => s.workspaces.sessions[w.rootPath]);
	const error = useStore((s) => s.workspaces.errors[w.rootPath]);
	const currentFile = useStore((s) => s.snap?.session?.file);
	useEffect(() => {
		if (sessions === undefined) loadSessions(w.rootPath);
	}, []);
	return {
		title: w.name,
		subtitle: w.rootPath,
		loading: sessions === undefined && !error,
		error,
		filterable: true,
		placeholder: t("Filter chats…"),
		empty: t("No chats yet"),
		rows: [
			{ key: "new", label: t("New chat in this workspace"), icon: "plus", onEnter: async (c) => (await actions.newSession(w.rootPath), c.close()) },
			{ key: "chats", group: t("Chats") },
			...chatRows(sessions, currentFile),
			{
				key: "remove",
				label: t("Remove from list"),
				icon: "x",
				danger: true,
				desc: t("Its folder and chats are kept; the chats stay available without a workspace."),
				onEnter: async (c) => (c.close(), await actions.removeWorkspace(w.id, w.name)),
			},
		],
	};
}

function generalScreen() {
	const sessions = useStore((s) => s.workspaces.unbound);
	const error = useStore((s) => s.workspaces.errors[GENERAL_KEY]);
	const currentFile = useStore((s) => s.snap?.session?.file);
	useEffect(() => {
		if (sessions === undefined) loadUnbound();
	}, []);
	return {
		title: t("No Folder"),
		subtitle: t("Chats that belong to no workspace"),
		loading: sessions === undefined && !error,
		error,
		filterable: true,
		placeholder: t("Filter chats…"),
		empty: t("No chats without a workspace"),
		rows: [
			{ key: "new", label: t("New chat without a workspace"), icon: "plus", onEnter: async (c) => (await actions.newSession(undefined, { unbound: true }), c.close()) },
			{ key: "chats", group: t("Chats") },
			...chatRows(sessions, currentFile),
		],
	};
}

function workspaceRoot() {
	const list = useStore((s) => s.workspaces.list);
	const currentRoot = useStore((s) => s.snap?.workspace?.rootPath);
	useEffect(() => {
		loadWorkspaces().catch(() => {});
	}, []);
	return {
		title: t("Workspaces"),
		empty: t("No workspaces"),
		rows: [
			...list.map((w) => ({
				key: w.id,
				label: w.name,
				desc: w.rootPath,
				badges: currentRoot && w.rootPath === currentRoot ? [t("current")] : [],
				chevron: true,
				onEnter: (c) => c.push(() => workspaceScreen(w)),
			})),
			{ key: "general", label: t("No Folder"), desc: t("Chats that belong to no workspace"), badges: !currentRoot ? [t("current")] : [], chevron: true, onEnter: (c) => c.push(() => generalScreen()) },
			{
				key: "add",
				label: t("Add workspace…"),
				icon: "plus",
				chevron: true,
				onEnter: (c) => c.push(() => inputScreen({ title: t("Add workspace"), label: t("Project folder"), placeholder: "C:\path\to\project", submitLabel: t("Add workspace"), onSubmit: async (path, cc) => { if (path.trim() && (await actions.addWorkspace(path.trim()))) cc.close(); } })),
			},
		],
	};
}

// ---- Command registry -----------------------------------------------------------------------------------------
const ROOT = {
	settings: () => settingsRoot(),
	model: (ctx, arg) => modelScreen(ctx, arg),
	effort: () => effortScreen(),
	workspace: () => workspaceRoot(),
	git: () => gitRoot(),
	commit: () => ({ title: t("Commit changes"), custom: (c) => html`<${GitInline} kind="commit" onClose=${c.close} />` }),
	push: () => ({ title: t("Push to upstream"), custom: (c) => html`<${GitInline} kind="push" onClose=${c.close} />` }),
	restore: () => ({ title: t("Restore to the latest commit"), custom: (c) => html`<${GitInline} kind="restore" onClose=${c.close} />` }),
	undo: () => ({ title: t("This task's uncommitted changes"), custom: (c) => html`<${GitInline} kind="undo" onClose=${c.close} />` }),
};

// ---- Rendering --------------------------------------------------------------------------------------------------
function Row({ row, selected, busy, onClick, onHover }) {
	if (row.group) return html`<div class="cp-group">${row.group}</div>`;
	return html`<div class=${`cp-row ${selected ? "sel" : ""} ${row.disabled ? "disabled" : ""} ${row.danger ? "danger" : ""}`} role="option" aria-selected=${selected} aria-disabled=${row.disabled ? "true" : undefined} onMouseMove=${(e) => pointerMoved(e) && onHover()} onClick=${onClick}>
		<span class="cp-ico">${row.icon ? html`<${Icon} name=${row.icon} size=${15} />` : row.check ? html`<${Icon} name="check" size=${15} />` : null}</span>
		<span class="cp-main"><span class="cp-label truncate">${row.label}</span>${row.desc ? html`<span class="cp-desc dim truncate">${row.desc}</span>` : null}</span>
		${(row.badges || []).map((b) => html`<span class="badge" key=${b}>${b}</span>`)}
		${row.value !== undefined && row.value !== "" ? html`<span class="cp-value truncate">${row.value}</span>` : null}
		${row.toggle !== undefined ? html`<span class=${`cp-switch ${row.toggle ? "on" : ""}`} aria-hidden="true"><i /></span>` : null}
		<span class="cp-tail">${busy ? html`<${Spinner} />` : row.chevron ? html`<${Icon} name="chevronRight" size=${14} class="c-dim" />` : null}</span>
	</div>`;
}

function InputView({ spec, ctx }) {
	const input = spec.input;
	const [value, setValue] = useState(input.value ?? "");
	const [busy, setBusy] = useState(false);
	const ref = useRef(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select?.();
	}, []);
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await input.onSubmit(value, ctx);
		} finally {
			setBusy(false);
		}
	};
	return html`<form class="cp-input" onSubmit=${(e) => (e.preventDefault(), submit())}>
		<label class="col field-label">${input.label}
			<input ref=${ref} class="field" type=${input.type || "text"} min=${input.min} max=${input.max} autocomplete="off" value=${value} placeholder=${input.placeholder || ""} onInput=${(e) => setValue(e.target.value)}
				onKeyDown=${(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ctx.pop(); } else e.stopPropagation(); }} />
		</label>
		<div class="row" style="gap:8px"><button class="btn sm ghost" type="button" onClick=${ctx.pop}>${t("Cancel")}</button><button class="btn sm primary" type="submit" disabled=${busy}>${input.submitLabel}</button></div>
	</form>`;
}

// A list with this many choices or more is searchable: typing goes straight into the filter, nothing needs a click first.
const FILTER_MIN_ROWS = 5;

function Screen({ build, ctx, entry, onTitle, arg }) {
	// Screens read live state (settings, models, providers …); any change re-runs the builder so the rows stay current.
	useStore((s) => s.settings);
	useStore((s) => s.snap);
	useStore((s) => s.providers);
	useStore((s) => s.models);
	useStore((s) => s.gitStatus);
	useStore((s) => s.view);
	const spec = build(ctx, arg);
	const allRows = spec.rows || [];
	const filterable = !spec.input && !spec.custom && (spec.filterable ?? allRows.filter((row) => !row.group).length >= FILTER_MIN_ROWS);
	// Filter text and selected row are remembered per level, so coming back from a deeper level lands where the user was.
	const [filter, setFilter] = useState(entry.filter ?? spec.initialFilter ?? "");
	const [selKey, setSelKey] = useState(entry.selKey ?? allRows.find((row) => row.check && !row.group)?.key);
	const [busyKey, setBusyKey] = useState(null);
	const root = useRef(null);
	const filterRef = useRef(null);
	const list = useRef(null);
	const alive = useRef(true);
	const rows = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q || !filterable) return allRows.filter((row) => !row.onlyFiltered);
		return allRows.filter((row) => !row.group && `${row.search || ""} ${row.label || ""} ${row.desc || ""}`.toLowerCase().includes(q));
	}, [spec.rows, filter, filterable]);
	const selectable = rows.map((row, i) => (row.group || row.disabled ? -1 : i)).filter((i) => i >= 0);
	const found = rows.findIndex((row) => row.key === selKey);
	const current = selectable.includes(found) ? found : (selectable[0] ?? -1);
	const focusInput = () => (filterable ? filterRef.current : root.current)?.focus();
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	// Focus lands in the search box (or on the panel when there is none) as soon as the panel is drawn — before the next
	// keystroke, so typing right after Enter already searches — and stays there while the list changes.
	useLayoutEffect(() => focusInput(), [filterable]);
	// Keep the highlighted row in view, including when ↑/↓ wrap around from one end of the list to the other.
	useLayoutEffect(() => {
		list.current?.querySelector(".cp-row.sel")?.scrollIntoView({ block: "nearest" });
	}, [current, rows.length]);
	useEffect(() => {
		entry.selKey = rows[current]?.key;
	}, [current, rows]);
	useEffect(() => {
		entry.filter = filter;
	}, [filter]);
	useEffect(() => onTitle?.(spec.title), [spec.title]);

	const selectRow = (index) => setSelKey(rows[index]?.key);
	const stepTo = (delta) => {
		if (!selectable.length) return;
		const at = selectable.indexOf(current);
		selectRow(selectable[(at + delta + selectable.length) % selectable.length]);
	};
	const activate = async (row) => {
		if (!row || row.disabled || !row.onEnter) return;
		setBusyKey(row.key);
		try {
			await row.onEnter(ctx);
		} finally {
			if (alive.current) {
				setBusyKey(null);
				// A row that changed something in place (a toggle) leaves the screen where it was: keep the keyboard in it.
				if (!root.current?.contains(document.activeElement)) focusInput();
			}
		}
	};
	const onKeyDown = (e) => {
		if (e.isComposing) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			if (filterable && filter) return setFilter("");
			return ctx.pop();
		}
		if (spec.input || spec.custom) return;
		const row = rows[current];
		switch (e.key) {
			case "ArrowDown":
				return e.preventDefault(), stepTo(1);
			case "ArrowUp":
				return e.preventDefault(), stepTo(-1);
			case "Tab":
				return e.preventDefault(), stepTo(e.shiftKey ? -1 : 1);
			case "PageDown":
				return e.preventDefault(), stepTo(6);
			case "PageUp":
				return e.preventDefault(), stepTo(-6);
			case "Home":
				if (!filterable) return e.preventDefault(), selectRow(selectable[0] ?? 0);
				return;
			case "End":
				if (!filterable) return e.preventDefault(), selectRow(selectable[selectable.length - 1] ?? 0);
				return;
			case "Enter":
				return e.preventDefault(), activate(row);
			case "ArrowRight":
				if (row?.chevron && !(filterable && filterRef.current?.value)) return e.preventDefault(), activate(row);
				return;
			case " ":
				// Space flips a switch, unless it is part of what is being searched for.
				if (row && row.toggle !== undefined && !(filterable && filter)) return e.preventDefault(), activate(row);
				return;
			case "ArrowLeft":
				if (filterable && filterRef.current?.value) return;
				return e.preventDefault(), ctx.pop();
			case "Backspace":
				if (filterable && filter) return;
				return e.preventDefault(), ctx.pop();
			default:
		}
	};

	return html`<div class="cp-screen" ref=${root} tabindex="-1" onKeyDown=${onKeyDown}>
		${spec.input
			? html`<${InputView} spec=${spec} ctx=${ctx} />`
			: spec.custom
				? html`<${InlineFrame.Provider} value=${{ onClose: ctx.pop }}>${spec.custom(ctx)}<//>`
				: html`
			${spec.subtitle ? html`<div class="cp-sub dim">${spec.subtitle}</div>` : null}
			${filterable ? html`<div class="cp-filter"><${Icon} name="search" size=${14} /><input ref=${filterRef} value=${filter} placeholder=${spec.placeholder || t("Search…")} onInput=${(e) => { setFilter(e.target.value); setSelKey(undefined); }} aria-label=${spec.placeholder || t("Search…")} autocomplete="off" spellcheck="false" /></div>` : null}
			${spec.error ? html`<div class="notice danger">${spec.error}</div>` : null}
			<div class="cp-list" role="listbox" ref=${list} onMouseDown=${(e) => filterable && e.preventDefault()}>
				${spec.loading ? html`<div class="empty"><${Spinner} /></div>` : null}
				${rows.map((row, i) => html`<${Row} key=${row.key} row=${row} selected=${i === current} busy=${busyKey === row.key} onHover=${() => !row.group && !row.disabled && i !== current && selectRow(i)} onClick=${() => (selectRow(i), activate(row))} />`)}
				${!spec.loading && !rows.filter((r) => !r.group).length ? html`<div class="empty">${spec.empty || t("Nothing to show.")}</div>` : null}
			</div>`}
	</div>`;
}

export function CommandPanel() {
	const cmd = useStore((s) => s.view.cmd);
	return cmd ? html`<${PanelBody} key=${cmd.nonce} cmd=${cmd} />` : null;
}

let entryId = 0;
const entry = (build) => ({ id: ++entryId, build, selKey: undefined, filter: undefined });

function initialStack(cmd) {
	const stack = [entry(ROOT[cmd.name] || (() => ({ title: cmd.name, rows: [] })))];
	// After a language change the app is rebuilt; `path` brings the panel back to the level the user was on.
	if (cmd.name === "settings") for (const id of cmd.path || []) if (id === "appearance") stack.push(entry(() => appearanceScreen()));
	return stack;
}

/** Things drawn over the page that belong to what the panel is doing (a confirmation, a form, a menu, a toast). */
const OVERLAYS = ".scrim, .modal, .popover, .toasts";

function PanelBody({ cmd }) {
	const [stack, setStack] = useState(() => initialStack(cmd));
	const [titles, setTitles] = useState({});
	const panel = useRef(null);
	// A click anywhere outside the panel closes it (every level at once); the draft in the input box is left alone.
	useEffect(() => {
		const onDown = (event) => {
			const target = event.target;
			if (!(target instanceof Element) || panel.current?.contains(target) || target.closest(OVERLAYS)) return;
			closeCommand();
		};
		document.addEventListener("mousedown", onDown, true);
		return () => document.removeEventListener("mousedown", onDown, true);
	}, []);
	const ctx = useMemo(
		() => ({
			push: (build) => setStack((s) => [...s, entry(build)]),
			pop: () =>
				setStack((s) => {
					if (s.length > 1) return s.slice(0, -1);
					queueMicrotask(closeCommand);
					return s;
				}),
			close: closeCommand,
		}),
		[],
	);
	const top = stack[stack.length - 1];
	const heading = stack.map((e) => titles[e.id]).filter(Boolean);
	return html`<div class="cp fade-in" ref=${panel} role="dialog" aria-label=${heading.join(" › ") || t("Command")}>
		<div class="cp-head">
			${stack.length > 1 ? html`<button class="icon-btn sm" onClick=${ctx.pop} title=${`${t("Back")} (←)`} aria-label=${t("Back")}><${Icon} name="arrowLeft" size=${15} /></button>` : html`<${Icon} name="bolt" size=${15} class="c-dim" />`}
			<span class="cp-title truncate">${heading.map((part, i) => html`${i ? html`<span class="cp-sep">›</span>` : null}<span class=${i === heading.length - 1 ? "cur" : "dim"}>${part}</span>`)}</span>
			<span class="grow" />
			<span class="cp-keys dim">↑↓ ${t("select")} · ↵ ${t("open")} · ← ${t("back")} · Esc ${t("close")}</span>
			<button class="icon-btn sm" onClick=${closeCommand} title=${`${t("Close")} (Esc)`} aria-label=${t("Close")}><${Icon} name="x" size=${15} /></button>
		</div>
		<${Screen} key=${top.id} build=${top.build} ctx=${ctx} arg=${cmd.arg} entry=${top} onTitle=${(title) => setTitles((previous) => (previous[top.id] === title ? previous : { ...previous, [top.id]: title }))} />
	</div>`;
}
