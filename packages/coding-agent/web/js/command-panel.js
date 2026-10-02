// Inline command panel: slash commands with several levels of choices (/settings, /model, /effort, /git …) open here, above the
// input, instead of a separate page. Everything works from the keyboard: ↑/↓ move, Enter or → go in or apply, ← / Esc go back,
// Space toggles, and typing filters the searchable lists. The mouse works too, but is never required.
import { html, InlineFrame, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, Spinner, UnitField, useDelayedBusy, usePresence } from "./ui.js";
import { GENERAL_KEY, api, attempt, chooseThinkingLevel, loadGitStatus, loadModels, loadProviders, loadSessions, loadSettings, loadSnapshot, loadUnbound, loadWorkspaces, post, readWidthValue, setView, state, toast, useStore } from "./store.js";
import { actions, closeCommand } from "./actions.js";
import { GitInline } from "./overlays-git.js";
import { commitChanges, keepTaskChanges, pushChanges, restorePreview, restoreToLatestCommit, undoTaskChanges } from "./git-flow.js";
import { deleteCustomProvider } from "./overlays-settings.js";
import { EffortSlider, findModel, modelRefLabel, modelRefName } from "./model-menu.js";
import { serverText, t } from "./i18n.js";
import { LANGUAGES } from "./lang.js";
import { requestNotificationPermission } from "./notifications.js";
import { rankSearch } from "./search.js";
import { settingsMenuIcon } from "./settings-menu.js";
import { RUN_MODES } from "./run-modes.js";
import { saveSetting } from "./settings-apply.js";
import { chatTitle, clip, effortName, fmtDateTime, modelEfforts, plural, pointerMoved, relTime, tokensToUnit, unitToTokens } from "./util.js";

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

/**
 * A one-field screen. With `unit` the field is a number with a fixed, non-editable unit after it; `valid(text)` then says
 * whether what is typed can be saved.
 */
function inputScreen({ title, label, value = "", type = "text", placeholder, submitLabel, onSubmit, min, max, unit, valid }) {
	return { title, input: { label, value, type, placeholder, submitLabel: submitLabel || t("Save"), onSubmit, min, max, unit, valid } };
}

// ---- /effort ------------------------------------------------------------------------------------------------
/** The effort slider as a panel level: one stop per level; `withDefault` adds "Default" (no effort sent). */
function effortSliderScreen({ title, levels, value, withDefault, onChange }) {
	return { title, subtitle: t("Higher effort thinks longer before it answers: slower, but better on hard problems."), slider: { levels, value, withDefault, onChange } };
}

function effortScreen() {
	const thinking = state.snap?.thinking;
	if (!thinking?.supported) return { title: t("Thinking effort"), size: "md", empty: t("The current model does not support reasoning effort."), rows: [] };
	if (thinking.levels.length < 2) return { title: t("Thinking effort"), size: "md", empty: t("The current model has no reasoning effort options to choose from."), rows: [] };
	return effortSliderScreen({
		title: t("Thinking effort"),
		levels: thinking.levels,
		value: thinking.level,
		onChange: chooseThinkingLevel,
	});
}

// ---- /model -------------------------------------------------------------------------------------------------
/** One flat, searchable row per model; the provider is the weaker text beside the name. */
function modelRows(models, { isCurrent, onPick, disabled }) {
	return (models?.providers || []).flatMap((provider) =>
		provider.models.map((m) => ({
			key: `${provider.id}/${m.id}`,
			label: m.name || m.id,
			names: [m.id, `${provider.id}/${m.id}`],
			desc: provider.name || provider.id,
			search: provider.id,
			check: isCurrent(provider, m),
			disabled,
			onEnter: (c) => onPick(provider, m, c),
		})),
	);
}

function modelScreen(ctx, arg) {
	const models = useStore((s) => s.models);
	const snap = useStore((s) => s.snap);
	const current = snap?.model;
	useEffect(() => {
		loadModels();
	}, []);
	const running = !!snap?.active;
	return {
		title: t("Choose a model"),
		subtitle: running ? t("Models can be switched when the agent is idle") : undefined,
		filterable: true,
		initialFilter: arg,
		placeholder: t("Search models…"),
		loading: !models,
		rows: [
			...modelRows(models, {
				disabled: running,
				isCurrent: (provider, m) => !!current && current.provider === provider.id && current.id === m.id,
				// The model is chosen at once; its effort has its own control (/effort, the effort chip).
				onPick: async (provider, m, c) => {
					if (await attempt(() => post("/api/model", { provider: provider.id, id: m.id }))) {
						await attempt(loadSnapshot, { quiet: true });
						c.close();
					}
				},
			}),
			{ key: "providers", label: t("Manage providers"), icon: "key", chevron: true, onEnter: (c) => c.push((cc) => providersScreen(cc)) },
		],
		empty: models && !models.providers.length ? t("No model is available. Add a provider in Settings.") : t("No models match."),
	};
}

// ---- /settings ----------------------------------------------------------------------------------------------

/** A settings item by id, as the server lists it (GET /api/settings). */
const settingItem = (id) => state.settings?.items.find((item) => item.id === id);

/** A screen with a few related settings (Web Search, Context Window, Warnings …). */
function groupScreen(title, ids, subtitle) {
	return () => {
		const rows = ids.map((id) => settingItem(id)).filter(Boolean).map((item) => itemRow(item));
		return { title, subtitle, rows, loading: !state.settings };
	};
}

const onOff = (value) => (value ? t("On") : t("Off"));

const WEB_SEARCH_SETTINGS = ["webSearch.enabled", "webSearch.engines", "webSearch.pagesPerSearch", "webSearch.maxUrlsPerFetch", "webSearch.fetchConcurrency", "webSearch.browserFallback", "webSearch.browser", "webSearch.useBrowserCookies"];
const CONTEXT_WINDOW_SETTINGS = ["contextWindowMain", "contextWindowSubAgent"];
const WARNING_SETTINGS = ["warnings.anthropicExtraUsage"];

/**
 * The pages behind the rows of the /settings menu that are not a single setting (SETTINGS_MENU_PAGES names them):
 * `open` builds the page, `value` is what the row shows, `settings` are the settings found by a search on the row.
 */
const MENU_PAGES = {
	providers: { open: (c) => providersScreen(c) },
	"github-connect": { open: (c) => githubScreen(c) },
	"default-model": {
		open: (c) => modelScreen(c, ""),
		value: (snap) => (snap?.model ? `${snap.model.provider}/${snap.model.id}${snap.thinking?.supported ? ` · ${effortName(snap.thinking.level)}` : ""}` : t("Not selected")),
	},
	"web-search": { open: groupScreen("Web Search", WEB_SEARCH_SETTINGS), settings: WEB_SEARCH_SETTINGS, value: () => (settingItem("webSearch.enabled") ? onOff(settingItem("webSearch.enabled").value) : "") },
	"context-window": {
		open: () => groupScreen("Context Window", CONTEXT_WINDOW_SETTINGS, t("Empty uses the model's own window."))(),
		settings: CONTEXT_WINDOW_SETTINGS,
		value: () => CONTEXT_WINDOW_SETTINGS.map((id) => capValue(settingItem(id))).join(" · "),
	},
	"git-integration": { open: () => gitRoot(), value: (snap) => (snap?.git ? onOff(snap.git.enabled) : "") },
	warnings: { open: groupScreen("Warnings", WARNING_SETTINGS), settings: WARNING_SETTINGS },
	thinking: { open: () => effortScreen(), value: (snap) => (snap?.thinking?.supported ? effortName(snap.thinking.level) : "") },
	appearance: { open: () => appearanceScreen() },
	"project-trust": { open: (c) => projectTrustScreen(c), value: (snap) => (snap?.trust?.requiresTrust ? (snap.trust.trusted ? t("Trusted") : t("Not trusted")) : "") },
	about: { open: () => aboutScreen() },
};

/**
 * /settings: the terminal's menu. Rows, order (most used first), names, descriptions and choices come from the one
 * definition shared with the terminal (GET /api/settings `menu`); every row edits the same settings.json / models.json
 * / credentials through the same server calls. Nothing about the menu is listed here.
 */
function settingsRoot() {
	const settings = useStore((s) => s.settings);
	const snap = useStore((s) => s.snap);
	useEffect(() => {
		loadSettings();
	}, []);
	// The order is taken when the panel opens: using a row must not make the list jump while it is open.
	const order = useRef(null);
	if (!order.current && settings?.menu) order.current = settings.menu.map((entry) => entry.id);
	const entries = (order.current || []).map((id) => settings?.menu?.find((entry) => entry.id === id)).filter(Boolean);
	const rows = entries
		.map((entry) => {
			const item = entry.setting ? settingItem(entry.setting) : null;
			const page = MENU_PAGES[entry.id];
			const words = [entry.id, item?.label, item?.description, ...(page?.settings || []).flatMap((id) => [settingItem(id)?.label, settingItem(id)?.description])];
			const base = {
				key: entry.id,
				// Setting names stay as the terminal shows them; descriptions follow the interface language.
				label: entry.label,
				desc: serverText(entry.description),
				search: words.filter(Boolean).map((word) => serverText(word, word)).join(" "),
				uses: entry.uses,
				onUse: () => post("/api/settings/usage", { id: entry.id }).catch(() => {}),
			};
			if (page) return { ...base, icon: settingsMenuIcon(entry.id), chevron: true, value: page.value?.(snap), onEnter: (ctx) => ctx.push(page.open) };
			return item ? { ...itemRow(item), ...base, icon: settingsMenuIcon(entry.id) } : null;
		})
		.filter(Boolean);
	return { title: t("Settings"), placeholder: t("Search settings…"), filterable: true, loading: !settings, rows };
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
						// The server saves the decision and applies it to the open chats of the folder.
						if (await attempt(() => post("/api/trust", { option: o.id }))) {
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
			label: t("Disconnect"),
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

const applySetting = saveSetting;

/** A token cap as "256 K" (the exact count is kept underneath); empty means the model's own limit. */
const capValue = (item) => (item?.value ? `${tokensToUnit(item.value, item.unitSize || 1024)} ${item.unit}` : t("Model limit"));

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
		case "tokens":
			return capValue(item);
		case "number":
			return item.value === undefined || item.value === null ? "—" : item.unit ? `${item.value} ${t(item.unit)}` : String(item.value);
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
			return { ...row, onEnter: (ctx) => ctx.push(() => numberScreen(item)) };
		case "tokens":
			return { ...row, onEnter: (ctx) => ctx.push(() => tokensScreen(item)) };
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

/** A whole-number setting; with a unit ("10 seconds") only the number is typed and the unit stays after the field. */
function numberScreen(item) {
	const inRange = (text) => {
		const value = Number(text);
		return text.trim() !== "" && Number.isFinite(value) && value >= (item.min ?? -Infinity) && value <= (item.max ?? Infinity);
	};
	return inputScreen({
		title: tr(item.label),
		label: tr(item.description),
		value: String(item.value ?? ""),
		type: "number",
		min: item.min,
		max: item.max,
		unit: item.unit ? t(item.unit) : undefined,
		valid: inRange,
		onSubmit: async (value, c) => {
			if (!inRange(value)) return;
			await applySetting(item.id, Number(value));
			c.pop();
		},
	});
}

/** A token cap typed in a unit ("256 | K tokens"): the exact token count is what is saved; an empty field clears the cap. */
function tokensScreen(item) {
	const unitSize = item.unitSize || 1024;
	const acceptable = (text) => text.trim() === "" || unitToTokens(text, unitSize) !== undefined;
	return inputScreen({
		title: tr(item.label),
		label: tr(item.description),
		value: tokensToUnit(item.value, unitSize),
		placeholder: t("Model limit"),
		unit: t("{unit} tokens", { unit: item.unit }),
		valid: acceptable,
		onSubmit: async (text, c) => {
			if (!acceptable(text)) return;
			await applySetting(item.id, text.trim() === "" ? null : unitToTokens(text, unitSize));
			c.pop();
		},
	});
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
	const live = () => state.settings?.items.find((i) => i.id === id);
	const item = live();
	if (!item) return { title: t("Settings"), loading: true, rows: [] };
	const v = item.value || {};
	const commit = (next) => applySetting(id, { ...(live()?.value || {}), ...next });
	const levels = modelEfforts(findModel(models, v.provider, v.model));
	const rows = [];
	if (item.note === "enabled") rows.push({ key: "enabled", label: t("Enabled"), toggle: !!v.enabled, onEnter: () => commit({ enabled: !v.enabled }) });
	rows.push({
		key: "model",
		label: t("Model"),
		value: modelRefName(models, v),
		chevron: true,
		onEnter: (c) =>
			c.push(() => {
				const now = live()?.value || {};
				return {
					title: tr(item.label),
					filterable: true,
					placeholder: t("Search models…"),
					loading: !state.models,
					rows: [
						// The main model comes with its effort: nothing of its own is kept.
						{ key: "main", label: t("Use the main model"), desc: t("Same model and thinking effort as the main chat"), check: !now.model, onEnter: async (cc) => (await commit({ provider: undefined, model: undefined, thinkingLevel: undefined }), cc.pop()) },
						...modelRows(state.models, {
							isCurrent: (provider, m) => now.provider === provider.id && now.model === m.id,
							onPick: async (provider, m, cc) => (await commit({ provider: provider.id, model: m.id, thinkingLevel: undefined }), cc.pop()),
						}),
					],
				};
			}),
	});
	// The effort of the chosen model: its own row, opening the slider (with "Default": no effort is sent).
	if (levels.length) {
		rows.push({
			key: "effort",
			label: t("Thinking effort"),
			value: v.thinkingLevel ? effortName(v.thinkingLevel) : t("Default"),
			chevron: true,
			onEnter: (c) =>
				c.push(() => {
					const now = live()?.value || {};
					return effortSliderScreen({ title: t("Thinking effort"), levels: modelEfforts(findModel(state.models, now.provider, now.model)), value: now.thinkingLevel, withDefault: true, onChange: (level) => commit({ thinkingLevel: level }) });
				}),
		});
	}
	return { title: tr(item.label), subtitle: tr(item.description), rows };
}

function appearanceScreen() {
	const view = state.view;
	const choice = (id, label, desc, key, options) => ({
		key: id,
		label: t(label),
		desc: t(desc),
		value: t((options.find((o) => o.value === view[key]) ?? (key === "runMode" ? options[0] : undefined))?.label ?? String(view[key])),
		chevron: true,
		onEnter: (ctx) =>
			ctx.push(() =>
				optionsScreen({
					title: t(label),
					subtitle: t(desc),
					options: options.map((o) => ({ value: o.value, label: key === "lang" ? o.label : t(o.label), desc: o.desc ? t(o.desc) : undefined })),
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
			choice("motion", "Animations", "Loading shimmer, expand/collapse and fades. Status is always shown in text too.", "motion", [{ value: "system", label: "System" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]),
			choice("runMode", "While a task is running", "What Enter does with a message sent while the agent is working.", "runMode", Object.entries(RUN_MODES).map(([value, mode]) => ({ value, label: mode.label, desc: mode.hint }))),
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
					const permission = await requestNotificationPermission();
					if (permission === "granted") setView({ notify: true });
					else toast(permission === "unsupported" ? t("This browser does not support notifications.") : t("Notification permission was not granted."), "warning");
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
				badges: p.missingBaseUrl ? [t("No Base URL")] : p.enabled ? [] : [t("disabled")],
				chevron: true,
				onEnter: (c) => c.push((cc) => providerScreen(cc, p.id)),
			})),
			{ key: "add", label: t("Add Provider"), desc: t("Connect a compatible API service"), icon: "plus", onEnter: (c) => (c.close(), setView({ providerEditor: { id: null } })) },
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
		provider.missingBaseUrl
			? { key: "enabled", label: t("Enabled"), desc: t("Fill in the Base URL and save to turn this provider on."), toggle: false, onEnter: (c) => (c.close(), setView({ providerEditor: { id } })) }
			: { key: "enabled", label: t("Enabled"), toggle: provider.enabled, onEnter: () => act(() => post("/api/providers/enabled", { id, enabled: !provider.enabled })) },
	];
	for (const k of c?.apiKeys || []) {
		rows.push({ key: `k-${k.id}`, label: `${serverText(k.label)} ${k.suffix ? `••••${k.suffix}` : ""}`.trim(), value: k.active ? t("active") : "", chevron: true, onEnter: (cc) => cc.push((c2) => keyScreen(c2, id, k.id)) });
	}
	if (c?.hasOAuth) rows.push({ key: "oauth-use", label: t("OAuth login"), value: c.active?.type === "oauth" ? t("active") : "", onEnter: () => c.active?.type !== "oauth" && act(() => post("/api/providers/oauth/activate", { id })) });
	if (provider.supportsApiKeyLogin) {
		rows.push({
			key: "add-key",
			label: t("Add API key"),
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
	if (provider.custom) rows.push({ key: "config", label: t("Provider settings & models"), desc: t("{n} models · detect models by ID · advanced JSON", { n: provider.modelCount }), icon: "edit", onEnter: (cc) => (cc.close(), setView({ providerEditor: { id } })) });
	if (provider.custom) rows.push({ key: "delete", label: t("Delete provider"), danger: true, onEnter: async (cc) => { if (await deleteCustomProvider(id, provider.name)) cc.pop(); } });
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
	const enable = (ctx) => ctx.push(() => ({ title: t("Set up Git for this project"), custom: (c) => html`<${GitInline} onClose=${c.pop} />` }));
	return {
		title: t("Git"),
		subtitle: gitStatus?.isRepository ? `${gitStatus.branch || t("detached HEAD")} · ${dirty ? t("{n} uncommitted", { n: dirty }) : t("clean")}` : gitStatus ? t("This workspace is not a Git repository.") : undefined,
		rows: [
			{ key: "commit", label: t("Commit"), desc: t("Creates one local commit for the task's changes. Nothing is pushed."), onEnter: (c) => (c.close(), commitChanges()) },
			{ key: "push", label: t("Push"), desc: t("Publishes commits that already exist on this branch, then waits for the CI result."), onEnter: (c) => (c.close(), pushChanges()) },
			...(checkpoint?.status === "created" ? [{ key: "undo", label: t("Undo task"), desc: t("Keep or undo this task's changes"), chevron: true, onEnter: (c) => c.push(() => undoScreen()) }] : []),
			{ key: "restore", label: t("Restore to last commit"), desc: t("Permanently discards every uncommitted change."), chevron: true, danger: true, onEnter: (c) => c.push(() => restoreScreen()) },
			{ key: "worktrees", label: t("Worktrees"), chevron: true, onEnter: (c) => c.push((cc) => worktreesScreen(cc)) },
			{ key: "history", label: t("History"), chevron: true, onEnter: (c) => c.push(() => historyScreen()) },
			{ key: "repos", label: t("Repositories"), chevron: true, onEnter: (c) => c.push((cc) => repositoriesScreen(cc)) },
			gitStatus?.integrationEnabled
				? { key: "integration", label: t("Turn off Git integration"), onEnter: async () => (await attempt(() => post("/api/git/enable", { enabled: false })), loadGitStatus(), toast(t("Git integration turned off (history is kept)."), "info", 3000)) }
				: { key: "integration", label: t("Turn on Git integration"), chevron: true, onEnter: enable },
		],
	};
}

/** Changed paths as a block of lines (the working tree right now). */
function pathLines(total, lines) {
	return html`<div class="cp-body"><div class="dim">${t("{plural} in the working tree right now", { plural: plural(total, "changed path") })}</div><pre class="git-lines">${lines.slice(0, 40).join("\n")}</pre></div>`;
}

/** /undo: keep or undo what the latest task changed. Keeping, the safe choice, is the first row; undoing asks once more. */
function undoScreen() {
	const checkpoint = useStore((s) => s.snap?.checkpoint);
	const gitStatus = useStore((s) => s.gitStatus);
	useEffect(() => {
		loadGitStatus();
	}, []);
	const title = t("Undo task changes");
	if (checkpoint?.status !== "created") return { title, size: "md", empty: t("There is no open task checkpoint. Use “Restore to last commit” (in Git tools) to discard everything since the latest commit."), rows: [] };
	const preview = gitStatus?.preview;
	return {
		title,
		size: preview?.total > 8 ? "lg" : "md",
		subtitle: t("The agent's latest task left changes that are not committed yet. Keep them as they are, or roll the workspace back to how it was when the task started."),
		body: preview?.total ? pathLines(preview.total, preview.lines) : undefined,
		rows: [
			{ key: "keep", label: t("Keep changes"), desc: t("The files stay as they are; the checkpoint is closed."), onEnter: (c) => (c.close(), keepTaskChanges()) },
			{
				key: "undo",
				label: t("Undo task changes"),
				desc: t("Roll the workspace back to how it was when the task started."),
				danger: true,
				chevron: true,
				onEnter: (c) =>
					c.push(() =>
						confirmScreen({
							title: t("Undo this task's changes?"),
							message: checkpoint.hadBash
								? t("Undo restores the workspace to the checkpoint state — that can include changes from later messages in the same session. It does not touch remote repositories or anything a shell command did outside the workspace (shell commands ran during this task).")
								: t("Undo restores the workspace to the checkpoint state — that can include changes from later messages in the same session. It does not touch remote repositories or anything a shell command did outside the workspace."),
							confirmLabel: t("Undo task changes"),
							danger: true,
							onConfirm: (cc) => (cc.close(), undoTaskChanges()),
						}),
					),
			},
		],
	};
}

/** /restore: back to the latest commit. It shows exactly what is lost; Cancel, the safe choice, is the first row. */
function restoreScreen() {
	const { data, error } = useLoaded(restorePreview);
	const title = t("Restore to the latest commit");
	if (!data) return { title, size: "md", loading: !error, error, rows: [] };
	if (!data.hasChanges) return { title, size: "md", empty: t("The working tree already matches the latest commit."), rows: [] };
	const p = data.preview;
	return {
		title,
		size: p.trackedChanges.length + p.untrackedPaths.length > 8 ? "lg" : "md",
		subtitle: t("The repository goes back to {label}. This cannot be undone.", { label: p.headLabel }),
		body: html`<div class="cp-body">
			${p.trackedChanges.length ? html`<div class="dim">${t("Modified tracked files ({length})", { length: p.trackedChanges.length })}</div><pre class="git-lines">${p.trackedChanges.slice(0, 40).join("\n")}</pre>` : null}
			${p.untrackedPaths.length ? html`<div class="dim">${t("Untracked files/folders that will be deleted ({length})", { length: p.untrackedPaths.length })}</div><pre class="git-lines">${p.untrackedPaths.slice(0, 40).join("\n")}</pre>` : null}
			${p.keptNestedRepositories.length ? html`<div class="dim">${t("Nested repositories kept: {join}", { join: p.keptNestedRepositories.join(", ") })}</div>` : null}
			<div class="dim">${t("Files ignored by .gitignore are not affected.")}</div>
		</div>`,
		rows: [
			{ key: "cancel", label: t("Cancel"), onEnter: (c) => c.close() },
			{ key: "restore", label: t("Discard and restore"), desc: t("Permanently discards every uncommitted change."), danger: true, onEnter: (c) => (c.close(), restoreToLatestCommit()) },
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
				label: t("Create worktree"),
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
				label: t("Register repository"),
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
		value: relTime(info.modified),
		search: info.firstMessage || "",
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
				search: w.rootPath,
				badges: currentRoot && w.rootPath === currentRoot ? [t("current")] : [],
				chevron: true,
				onEnter: (c) => c.push(() => workspaceScreen(w)),
			})),
			{ key: "general", label: t("No Folder"), desc: t("Chats that belong to no workspace"), badges: !currentRoot ? [t("current")] : [], chevron: true, onEnter: (c) => c.push(() => generalScreen()) },
			{
				key: "add",
				label: t("Add workspace"),
				icon: "plus",
				// The folder is chosen in the system's folder window; typing a path is only the fallback without one.
				onEnter: async (c) => {
					const result = await actions.addWorkspaceFromDialog();
					if (result.added) c.close();
					else if (result.unsupported) c.push(() => inputScreen({ title: t("Add workspace"), label: t("Project folder"), placeholder: "C:\path\to\project", submitLabel: t("Add workspace"), onSubmit: async (path, cc) => { if (path.trim() && (await actions.addWorkspace(path.trim()))) cc.close(); } }));
				},
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
	restore: () => restoreScreen(),
	undo: () => undoScreen(),
};

// ---- Rendering --------------------------------------------------------------------------------------------------
function Row({ row, selected, busy, onClick, onHover }) {
	if (row.group) return html`<div class="cp-group">${row.group}</div>`;
	// One line per choice: the name, its description in a weaker colour beside it, the value or switch at the end.
	return html`<div class=${`cp-row ${selected ? "sel" : ""} ${row.disabled ? "disabled" : ""} ${row.danger ? "danger" : ""}`} role="option" aria-selected=${selected} aria-disabled=${row.disabled ? "true" : undefined} title=${row.desc || undefined} onMouseMove=${(e) => pointerMoved(e) && onHover()} onClick=${onClick}>
		<span class="cp-ico">${row.icon ? html`<${Icon} name=${row.icon} size=${14} />` : row.check ? html`<${Icon} name="check" size=${14} />` : null}</span>
		<span class="cp-main"><span class="cp-label truncate">${row.label}</span>${row.desc ? html`<span class="cp-desc truncate">${row.desc}</span>` : null}</span>
		${(row.badges || []).map((b) => html`<span class="badge" key=${b}>${b}</span>`)}
		${row.toggle === undefined && row.value !== undefined && row.value !== "" ? html`<span class="cp-value truncate">${row.value}</span>` : null}
		${row.toggle !== undefined ? html`<span class=${`toggle ${row.toggle ? "on" : ""}`} aria-hidden="true" />` : null}
		<span class="cp-tail">${busy ? html`<${Spinner} />` : row.chevron ? html`<${Icon} name="chevronRight" size=${13} class="c-dim" />` : null}</span>
	</div>`;
}

/** A panel level that is the effort slider: ←/→ move it, Enter / Esc / Backspace go back. */
function SliderView({ spec, ctx }) {
	const { levels, value, withDefault, onChange } = spec.slider;
	// The slider keeps the chosen level on screen while it is stored, so it is never dimmed or locked in between.
	return html`<div class="cp-effort" onKeyDown=${(e) => e.key === "Backspace" && (e.preventDefault(), e.stopPropagation(), ctx.pop())}>
		<${EffortSlider} levels=${levels} value=${value} onChange=${onChange} onDone=${ctx.pop} titled=${false} withDefault=${!!withDefault} />
		${spec.subtitle ? html`<div class="cp-note dim">${spec.subtitle}</div>` : null}
	</div>`;
}

function InputView({ spec, ctx }) {
	const input = spec.input;
	const [value, setValue] = useState(input.value ?? "");
	const [busy, setBusy] = useState(false);
	const ref = useRef(null);
	useEffect(() => {
		const field = ref.current?.querySelector("input");
		field?.focus();
		field?.select?.();
	}, []);
	const invalid = input.unit !== undefined && !!input.valid && !input.valid(value);
	const keys = (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			ctx.pop();
		} else e.stopPropagation();
	};
	const submit = async () => {
		if (busy || invalid) return;
		setBusy(true);
		try {
			await input.onSubmit(value, ctx);
		} finally {
			setBusy(false);
		}
	};
	return html`<form class="cp-input" ref=${ref} onSubmit=${(e) => (e.preventDefault(), submit())}>
		<label class="col field-label">${input.label}
			${input.unit !== undefined
				? html`<${UnitField} value=${value} onInput=${setValue} unit=${input.unit} label=${input.label} placeholder=${input.placeholder} invalid=${invalid} width=${230} onKeyDown=${keys} />`
				: html`<input class="field" type=${input.type || "text"} min=${input.min} max=${input.max} autocomplete="off" value=${value} placeholder=${input.placeholder || ""} onInput=${(e) => setValue(e.target.value)} onKeyDown=${keys} />`}
		</label>
		<div class="row"><button class="btn sm ghost" type="button" onClick=${ctx.pop}>${t("Cancel")}</button><button class="btn sm primary" type="submit" disabled=${busy || invalid}>${input.submitLabel}</button></div>
	</form>`;
}

// A list with this many choices or more is searchable: typing goes straight into the filter, nothing needs a click first.
const FILTER_MIN_ROWS = 5;

/** The size of a panel level: a slider or a short pick is a small card in the middle, a long list or a lot of detail uses the whole width. */
function sizeOf(spec, kind, rowCount) {
	if (spec.size) return spec.size;
	if (kind === "slider") return "sm";
	if (kind === "input") return "md";
	if (kind === "custom") return "lg";
	return rowCount > 6 ? "lg" : "md";
}

/** The keys of a panel level, as a line of hints. */
function keysOf(kind) {
	if (kind === "slider") return `←/→ ${t("change")} · ↵ ${t("done")} · Esc ${t("close")}`;
	if (kind === "input") return `↵ ${t("save")} · Esc ${t("back")}`;
	if (kind === "custom") return `Esc ${t("back")}`;
	return `↑↓ ${t("select")} · ↵ ${t("open")} · ← ${t("back")} · Esc ${t("close")}`;
}

function Screen({ build, ctx, entry, onMeta, arg }) {
	// Screens read live state (settings, models, providers …); any change re-runs the builder so the rows stay current.
	useStore((s) => s.settings);
	useStore((s) => s.snap);
	useStore((s) => s.providers);
	useStore((s) => s.models);
	useStore((s) => s.gitStatus);
	useStore((s) => s.view);
	const spec = build(ctx, arg);
	const allRows = spec.rows || [];
	const plain = !spec.input && !spec.custom && !spec.slider;
	const filterable = plain && (spec.filterable ?? allRows.filter((row) => !row.group).length >= FILTER_MIN_ROWS);
	// Filter text and selected row are remembered per level, so coming back from a deeper level lands where the user was.
	const [filter, setFilter] = useState(entry.filter ?? spec.initialFilter ?? "");
	const [selKey, setSelKey] = useState(entry.selKey ?? allRows.find((row) => row.check && !row.group)?.key);
	const [busyKey, setBusyKey] = useState(null);
	// A row shows "working" only when what it does really takes a while: an instant change shows nothing but its result.
	const slow = useDelayedBusy(busyKey !== null);
	const lastBusyKey = useRef(null);
	if (busyKey !== null) lastBusyKey.current = busyKey;
	const root = useRef(null);
	const filterRef = useRef(null);
	const list = useRef(null);
	const alive = useRef(true);
	const rows = useMemo(() => {
		if (!filter.trim() || !filterable) return allRows.filter((row) => !row.onlyFiltered);
		// Relevance first (exact name > prefix > part of the name > description / keywords), usage second, then the
		// order of the list: the same rule in every panel.
		return rankSearch(allRows.filter((row) => !row.group), filter, {
			names: (row) => [row.label, ...(row.names || [])],
			keywords: (row) => `${row.desc || ""} ${row.search || ""}`,
			usage: (row) => row.uses,
		});
	}, [spec.rows, filter, filterable]);
	const selectable = rows.map((row, i) => (row.group || row.disabled ? -1 : i)).filter((i) => i >= 0);
	const found = rows.findIndex((row) => row.key === selKey);
	const current = selectable.includes(found) ? found : (selectable[0] ?? -1);
	const focusInput = () => (filterable ? filterRef.current : root.current?.querySelector(".effort-track") || root.current)?.focus();
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
	const kind = spec.input ? "input" : spec.slider ? "slider" : spec.custom ? "custom" : "list";
	const size = sizeOf(spec, kind, allRows.filter((row) => !row.group).length);
	const keys = keysOf(kind);
	useLayoutEffect(() => onMeta?.({ title: spec.title, size, keys }), [spec.title, size, keys]);

	const selectRow = (index) => setSelKey(rows[index]?.key);
	const stepTo = (delta) => {
		if (!selectable.length) return;
		const at = selectable.indexOf(current);
		selectRow(selectable[(at + delta + selectable.length) % selectable.length]);
	};
	const activate = async (row) => {
		if (!row || row.disabled || !row.onEnter) return;
		setBusyKey(row.key);
		row.onUse?.();
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
		if (!plain) return;
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
			: spec.slider
				? html`<${SliderView} spec=${spec} ctx=${ctx} />`
				: spec.custom
				? html`<${InlineFrame.Provider} value=${{ onClose: ctx.pop }}>${spec.custom(ctx)}<//>`
				: html`
			${spec.subtitle ? html`<div class="cp-sub dim">${spec.subtitle}</div>` : null}
			${spec.body || null}
			${filterable ? html`<div class="cp-filter"><${Icon} name="search" size=${13} /><input ref=${filterRef} value=${filter} placeholder=${spec.placeholder || t("Search…")} onInput=${(e) => { setFilter(e.target.value); setSelKey(undefined); }} aria-label=${spec.placeholder || t("Search…")} autocomplete="off" spellcheck="false" /></div>` : null}
			${spec.error ? html`<div class="notice danger">${spec.error}</div>` : null}
			<div class="cp-list" role="listbox" ref=${list} onMouseDown=${(e) => filterable && e.preventDefault()}>
				${spec.loading ? html`<div class="empty"><${Spinner} /></div>` : null}
				${rows.map((row, i) => html`<${Row} key=${row.key} row=${row} selected=${i === current} busy=${slow && (busyKey ?? lastBusyKey.current) === row.key} onHover=${() => !row.group && !row.disabled && i !== current && selectRow(i)} onClick=${() => (selectRow(i), activate(row))} />`)}
				${!spec.loading && !rows.filter((r) => !r.group).length ? html`<div class="empty">${spec.empty || t("Nothing to show.")}</div>` : null}
			</div>`}
	</div>`;
}

export function CommandPanel() {
	const cmd = useStore((s) => s.view.cmd);
	// A closed panel stays on screen (inert) for the length of its fade, so it leaves the way it came.
	const last = useRef(cmd);
	if (cmd) last.current = cmd;
	const { mounted } = usePresence(!!cmd, 160);
	const shown = cmd || (mounted ? last.current : null);
	return shown ? html`<${PanelBody} key=${shown.nonce} cmd=${shown} leaving=${!cmd} />` : null;
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

export function PanelBody({ cmd, leaving, onClose = closeCommand }) {
	const [stack, setStack] = useState(() => initialStack(cmd));
	const [metas, setMetas] = useState({});
	// The card changes its width with the level (a slider is narrow, a list is wide): that is animated, but not when it first appears.
	const [ready, setReady] = useState(false);
	useEffect(() => {
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setReady(true));
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
		};
	}, []);
	const panel = useRef(null);
	// A click anywhere outside the panel closes it (every level at once); the draft in the input box is left alone.
	useEffect(() => {
		const onDown = (event) => {
			const target = event.target;
			if (!(target instanceof Element) || panel.current?.contains(target) || target.closest(OVERLAYS) || (onClose !== closeCommand && target.closest("[data-git-menu-trigger]"))) return;
			onClose();
		};
		document.addEventListener("mousedown", onDown, true);
		return () => document.removeEventListener("mousedown", onDown, true);
	}, [onClose]);
	const ctx = useMemo(
		() => ({
			push: (build) => setStack((s) => [...s, entry(build)]),
			pop: () =>
				setStack((s) => {
					if (s.length > 1) return s.slice(0, -1);
					queueMicrotask(onClose);
					return s;
				}),
			close: onClose,
		}),
		[onClose],
	);
	const top = stack[stack.length - 1];
	const heading = stack.map((e) => metas[e.id]?.title).filter(Boolean);
	const meta = metas[top.id] || {};
	return html`<div class=${`cp fade-in ${ready ? "ready" : ""} ${leaving ? "leaving" : ""}`} data-size=${meta.size || "lg"} ref=${panel} role="dialog" aria-label=${heading.join(" › ") || t("Command")} inert=${!!leaving}>
		<div class="cp-head">
			${stack.length > 1 ? html`<button class="icon-btn sm" onClick=${ctx.pop} title=${`${t("Back")} (←)`} aria-label=${t("Back")}><${Icon} name="arrowLeft" size=${14} /></button>` : html`<${Icon} name="bolt" size=${13} class="c-dim" />`}
			<span class="cp-title truncate">${heading.map((part, i) => html`${i ? html`<span class="cp-sep">›</span>` : null}<span class=${i === heading.length - 1 ? "cur" : "dim"}>${part}</span>`)}</span>
			<span class="grow" />
			${meta.size === "lg" && meta.keys ? html`<span class="cp-keys dim">${meta.keys}</span>` : null}
			<button class="icon-btn sm" onClick=${onClose} title=${`${t("Close")} (Esc)`} aria-label=${t("Close")}><${Icon} name="x" size=${14} /></button>
		</div>
		<${Screen} key=${top.id} build=${top.build} ctx=${ctx} arg=${cmd.arg} entry=${top} onMeta=${(next) => setMetas((previous) => (previous[top.id]?.title === next.title && previous[top.id]?.size === next.size && previous[top.id]?.keys === next.keys ? previous : { ...previous, [top.id]: next }))} />
		${meta.size !== "lg" && meta.keys ? html`<div class="cp-foot dim">${meta.keys}</div>` : null}
	</div>`;
}
