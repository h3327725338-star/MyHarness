// Inline command panel: slash commands with several levels of choices (/settings, /model, /effort, /git …) open here, above the
// input, instead of a separate page. Everything works from the keyboard: ↑/↓ move, Enter or → go in or apply, ← / Esc go back,
// Space toggles, and typing filters the searchable lists. The mouse works too, but is never required.
import { html, InlineFrame, useEffect, useMemo, useRef, useState, Icon, Spinner } from "./ui.js";
import { api, attempt, loadGitStatus, loadModels, loadProviders, loadSettings, loadSnapshot, post, setView, state, toast, useStore } from "./store.js";
import { actions, closeCommand } from "./actions.js";
import { GitInline } from "./overlays-git.js";
import { NAV as SETTINGS_NAV, SECTION_OF } from "./overlays-settings.js";
import { serverText, t } from "./i18n.js";
import { LANGUAGES } from "./lang.js";
import { clip, effortHint, effortName, fmtDateTime, fmtTokens } from "./util.js";

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
	if (!thinking?.supported) return { title: t("Reasoning effort"), empty: t("The current model does not support reasoning effort.") , rows: [] };
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
function modelScreen(ctx, arg) {
	const models = useStore((s) => s.models);
	const snap = useStore((s) => s.snap);
	const current = snap?.model;
	useEffect(() => {
		loadModels(false);
	}, []);
	const running = !!snap?.active;
	const rows = [];
	for (const provider of models?.providers || []) {
		rows.push({ key: `g-${provider.id}`, group: provider.name });
		for (const m of provider.models) {
			rows.push({
				key: `${m.provider}/${m.id}`,
				label: m.name || m.id,
				search: `${provider.name} ${m.id} ${m.name}`,
				badges: [m.reasoning ? t("reasoning") : "", m.input.includes("image") ? t("image") : ""].filter(Boolean),
				value: fmtTokens(m.contextWindow),
				check: !!current && current.provider === m.provider && current.id === m.id,
				disabled: running,
				onEnter: async (c) => {
					if (await attempt(() => post("/api/model", { provider: m.provider, id: m.id }))) {
						await attempt(loadSnapshot, { quiet: true });
						c.close();
					}
				},
			});
		}
	}
	rows.push({ key: "refresh", label: t("Refresh catalog"), icon: "refresh", onEnter: () => loadModels(true) });
	rows.push({ key: "providers", label: t("Manage providers…"), icon: "key", chevron: true, onEnter: (c) => c.push((cc) => providersScreen(cc)) });
	return {
		title: t("Choose a model"),
		subtitle: running ? t("Models can be switched when the agent is idle") : undefined,
		filterable: true,
		initialFilter: arg,
		placeholder: t("Search models…"),
		loading: !models,
		rows,
		empty: models && !models.providers.length ? t("No model is available. Add a provider in Settings.") : t("No models match."),
	};
}

// ---- /settings ----------------------------------------------------------------------------------------------

function settingsRoot() {
	return {
		title: t("Settings"),
		rows: SETTINGS_NAV.map((section) => ({
			key: section.id,
			label: t(section.label),
			icon: section.icon,
			chevron: true,
			onEnter: (ctx) => ctx.push((c) => settingsSection(c, section.id)),
		})),
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
			const model = v.model ? `${v.provider ? `${v.provider}/` : ""}${v.model}` : t("Use the main model");
			return item.note === "enabled" && !v.enabled ? t("Off") : model;
		}
		case "text":
			return item.value ? clip(String(item.value), 28) : "—";
		default:
			return item.value === undefined || item.value === null ? "—" : String(item.value);
	}
}

function itemRow(item) {
	const row = { key: item.id, label: tr(item.label), desc: tr(item.description), value: shownValue(item), chevron: true };
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
		value: v.model ? `${v.provider ? `${v.provider}/` : ""}${v.model}` : t("Use the main model"),
		chevron: true,
		onEnter: (c) =>
			c.push(() => ({
				title: tr(item.label),
				filterable: true,
				placeholder: t("Search models…"),
				loading: !models,
				rows: [
					{ key: "main", label: t("Use the main model"), check: !v.model, onEnter: async (cc) => (await commit({ provider: undefined, model: undefined }), cc.pop()) },
					...(models?.providers || []).flatMap((g) =>
						g.models.map((m) => ({ key: `${g.id}/${m.id}`, label: m.name || m.id, search: `${g.name} ${m.id} ${m.name}`, desc: g.name, check: v.provider === g.id && v.model === m.id, onEnter: async (cc) => (await commit({ provider: g.id, model: m.id }), cc.pop()) })),
					),
				],
			})),
	});
	rows.push({
		key: "thinking",
		label: t("Reasoning"),
		value: v.thinkingLevel || t("Default reasoning"),
		chevron: true,
		onEnter: (c) =>
			c.push(() =>
				optionsScreen({
					title: t("Reasoning effort"),
					options: [{ value: "", label: t("Default reasoning") }, ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => ({ value: l, label: effortName(l) }))],
					value: v.thinkingLevel || "",
					onPick: async (level, cc) => (await commit({ thinkingLevel: level || undefined }), cc.pop()),
				}),
			),
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
				value: `${view.readWidth}px`,
				chevron: true,
				onEnter: (ctx) => ctx.push(() => inputScreen({ title: t("Reading width"), label: t("Width of the conversation column."), value: String(state.view.readWidth), type: "number", min: 620, max: 1100, onSubmit: (value, c) => (setView({ readWidth: Math.max(620, Math.min(1100, Number(value) || 780)) }), c.pop()) })),
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

function settingsSection(ctx, id) {
	const settings = useStore((s) => s.settings);
	const [trust, setTrust] = useState(null);
	useEffect(() => {
		loadSettings();
		if (!state.models) loadModels();
		if (id === "safety") api("/api/trust").then(setTrust).catch(() => {});
	}, []);
	const nav = SETTINGS_NAV.find((n) => n.id === id);
	if (id === "appearance") return appearanceScreen();
	if (id === "providers") return providersScreen(ctx);
	if (id === "about") return aboutScreen();
	if (!settings) return { title: t(nav.label), loading: true, rows: [] };
	const rows = [];
	let lastSection = "";
	if (id === "safety" && trust) {
		rows.push({ key: "trust-h", group: t("Project trust") });
		rows.push({
			key: "trust",
			label: trust.cwd,
			desc: trust.requiresTrust ? (trust.trusted ? t("Trusted — project settings, skills, prompts and extensions are loaded.") : t("Not trusted — project resources are ignored and project extensions do not run.")) : t("This project has no resources that need trust."),
			chevron: !!trust.requiresTrust,
			onEnter: trust.requiresTrust
				? (c) =>
						c.push(() =>
							optionsScreen({
								title: t("Project trust"),
								options: trust.options.map((o) => ({ value: o.id, label: tr(o.label) })),
								onPick: async (option, cc) => {
									if (await attempt(() => post("/api/trust", { option }))) {
										toast(t("Trust decision saved. Reloading resources…"), "info", 3000);
										await attempt(() => post("/api/resources/reload"));
										await loadSnapshot();
										api("/api/trust").then(setTrust).catch(() => {});
										cc.pop();
									}
								},
							}),
						)
				: undefined,
		});
	}
	for (const item of settings.items.filter((i) => SECTION_OF[i.section] === id)) {
		if (item.section !== lastSection) {
			rows.push({ key: `g-${item.section}`, group: tr(item.section) });
			lastSection = item.section;
		}
		rows.push(itemRow(item));
	}
	return { title: t(nav.label), rows, filterable: rows.length > 12, placeholder: t("Search settings…") };
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
		filterable: (providers?.providers.length || 0) > 8,
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
			{ key: "custom", label: t("Edit custom providers (models.json)…"), icon: "externalLink", onEnter: (c) => (c.close(), setView({ settingsOpen: true, settingsSection: "providers" })) },
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
		if (result) await loadProviders();
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
	if (provider.configured && provider.authSource !== "environment") {
		rows.push({
			key: "logout",
			label: t("Remove credentials"),
			danger: true,
			chevron: true,
			onEnter: (cc) =>
				cc.push(() =>
					confirmScreen({
						title: t("Remove {name} credentials?", { name: provider.name }),
						message: t("All stored API keys and OAuth logins for this provider are deleted from this computer."),
						confirmLabel: t("Remove"),
						danger: true,
						onConfirm: async (c2) => {
							if (await act(() => post("/api/providers/logout", { id }))) c2.pop();
						},
					}),
				),
		});
	}
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
		label: t("Delete"),
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

// ---- Command registry -----------------------------------------------------------------------------------------
const ROOT = {
	settings: () => settingsRoot(),
	model: (ctx, arg) => modelScreen(ctx, arg),
	effort: () => effortScreen(),
	git: () => gitRoot(),
	commit: () => ({ title: t("Commit changes"), custom: (c) => html`<${GitInline} kind="commit" onClose=${c.close} />` }),
	push: () => ({ title: t("Push to upstream"), custom: (c) => html`<${GitInline} kind="push" onClose=${c.close} />` }),
	restore: () => ({ title: t("Restore to the latest commit"), custom: (c) => html`<${GitInline} kind="restore" onClose=${c.close} />` }),
	undo: () => ({ title: t("This task's uncommitted changes"), custom: (c) => html`<${GitInline} kind="undo" onClose=${c.close} />` }),
};

// ---- Rendering --------------------------------------------------------------------------------------------------
function Row({ row, selected, busy, onClick, onHover }) {
	if (row.group) return html`<div class="cp-group">${row.group}</div>`;
	return html`<div class=${`cp-row ${selected ? "sel" : ""} ${row.disabled ? "disabled" : ""} ${row.danger ? "danger" : ""}`} role="option" aria-selected=${selected} aria-disabled=${row.disabled ? "true" : undefined} onMouseMove=${onHover} onClick=${onClick}>
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

function Screen({ build, ctx, initialSel, onSel, onTitle, arg }) {
	// Screens read live state (settings, models, providers …); any change re-runs the builder so the rows stay current.
	useStore((s) => s.settings);
	useStore((s) => s.snap);
	useStore((s) => s.providers);
	useStore((s) => s.models);
	useStore((s) => s.gitStatus);
	useStore((s) => s.view);
	const spec = build(ctx, arg);
	const [filter, setFilter] = useState(spec.initialFilter || "");
	const [sel, setSel] = useState(initialSel || Math.max(0, (spec.rows || []).findIndex((row) => row.check)));
	const [busyKey, setBusyKey] = useState(null);
	const root = useRef(null);
	const filterRef = useRef(null);
	const list = useRef(null);
	const rows = useMemo(() => {
		const all = spec.rows || [];
		const q = filter.trim().toLowerCase();
		if (!q || !spec.filterable) return all;
		return all.filter((row) => !row.group && `${row.search || ""} ${row.label || ""} ${row.desc || ""}`.toLowerCase().includes(q));
	}, [spec.rows, filter, spec.filterable]);
	const selectable = rows.map((row, i) => (row.group || row.disabled ? -1 : i)).filter((i) => i >= 0);
	const current = selectable.includes(sel) ? sel : (selectable[0] ?? -1);
	useEffect(() => {
		(spec.filterable ? filterRef.current : root.current)?.focus();
	}, []);
	useEffect(() => {
		list.current?.querySelector(".cp-row.sel")?.scrollIntoView({ block: "nearest" });
	}, [current, rows.length]);
	useEffect(() => onSel?.(current), [current]);
	useEffect(() => onTitle?.(spec.title), [spec.title]);

	const stepTo = (delta) => {
		if (!selectable.length) return;
		const at = selectable.indexOf(current);
		setSel(selectable[(at + delta + selectable.length) % selectable.length]);
	};
	const activate = async (row) => {
		if (!row || row.disabled || !row.onEnter) return;
		setBusyKey(row.key);
		try {
			await row.onEnter(ctx);
		} finally {
			setBusyKey(null);
		}
	};
	const onKeyDown = (e) => {
		if (e.isComposing) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			if (spec.filterable && filter) return setFilter("");
			return ctx.pop();
		}
		if (spec.input || spec.custom) return;
		const row = rows[current];
		switch (e.key) {
			case "ArrowDown":
				return e.preventDefault(), stepTo(1);
			case "ArrowUp":
				return e.preventDefault(), stepTo(-1);
			case "PageDown":
				return e.preventDefault(), stepTo(6);
			case "PageUp":
				return e.preventDefault(), stepTo(-6);
			case "Home":
				if (!spec.filterable) return e.preventDefault(), setSel(selectable[0] ?? 0);
				return;
			case "End":
				if (!spec.filterable) return e.preventDefault(), setSel(selectable[selectable.length - 1] ?? 0);
				return;
			case "Enter":
				return e.preventDefault(), activate(row);
			case "ArrowRight":
				if (row?.chevron && !(spec.filterable && filterRef.current?.value)) return e.preventDefault(), activate(row);
				return;
			case " ":
				if (row && row.toggle !== undefined && !spec.filterable) return e.preventDefault(), activate(row);
				return;
			case "ArrowLeft":
				if (spec.filterable && filterRef.current?.value) return;
				return e.preventDefault(), ctx.pop();
			case "Backspace":
				if (spec.filterable && filter) return;
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
			${spec.filterable ? html`<div class="cp-filter"><${Icon} name="search" size=${14} /><input ref=${filterRef} value=${filter} placeholder=${spec.placeholder || t("Search…")} onInput=${(e) => { setFilter(e.target.value); setSel(0); }} aria-label=${spec.placeholder || t("Search…")} /></div>` : null}
			${spec.error ? html`<div class="notice danger">${spec.error}</div>` : null}
			<div class="cp-list" role="listbox" ref=${list}>
				${spec.loading ? html`<div class="empty"><${Spinner} /></div>` : null}
				${rows.map((row, i) => html`<${Row} key=${row.key} row=${row} selected=${i === current} busy=${busyKey === row.key} onHover=${() => !row.group && !row.disabled && i !== current && setSel(i)} onClick=${() => (setSel(i), activate(row))} />`)}
				${!spec.loading && !rows.filter((r) => !r.group).length ? html`<div class="empty">${spec.empty || t("Nothing to show.")}</div>` : null}
			</div>`}
	</div>`;
}

export function CommandPanel() {
	const cmd = useStore((s) => s.view.cmd);
	return cmd ? html`<${PanelBody} key=${cmd.nonce} cmd=${cmd} />` : null;
}

let entryId = 0;
const entry = (build) => ({ id: ++entryId, build, sel: 0 });

function initialStack(cmd) {
	const stack = [entry(ROOT[cmd.name] || (() => ({ title: cmd.name, rows: [] })))];
	// After a language change the app is rebuilt; `path` brings the panel back to the level the user was on.
	if (cmd.name === "settings") for (const id of cmd.path || []) stack.push(entry((c) => settingsSection(c, id)));
	return stack;
}

function PanelBody({ cmd }) {
	const [stack, setStack] = useState(() => initialStack(cmd));
	const [titles, setTitles] = useState({});
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
	return html`<div class="cp fade-in" role="dialog" aria-label=${heading.join(" › ") || t("Command")}>
		<div class="cp-head">
			${stack.length > 1 ? html`<button class="icon-btn sm" onClick=${ctx.pop} title=${`${t("Back")} (←)`} aria-label=${t("Back")}><${Icon} name="arrowLeft" size=${15} /></button>` : html`<${Icon} name="bolt" size=${15} class="c-dim" />`}
			<span class="cp-title truncate">${heading.map((part, i) => html`${i ? html`<span class="cp-sep">›</span>` : null}<span class=${i === heading.length - 1 ? "cur" : "dim"}>${part}</span>`)}</span>
			<span class="grow" />
			<span class="cp-keys dim">↑↓ ${t("select")} · ↵ ${t("open")} · ← ${t("back")} · Esc ${t("close")}</span>
			<button class="icon-btn sm" onClick=${closeCommand} title=${`${t("Close")} (Esc)`} aria-label=${t("Close")}><${Icon} name="x" size=${15} /></button>
		</div>
		<${Screen} key=${top.id} build=${top.build} ctx=${ctx} arg=${cmd.arg} initialSel=${top.sel} onSel=${(index) => { top.sel = index; }} onTitle=${(title) => setTitles((previous) => (previous[top.id] === title ? previous : { ...previous, [top.id]: title }))} />
	</div>`;
}
