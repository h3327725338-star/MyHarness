// Getting an API key for a service MyHarness offers ready-made (Tavily for web search, Nebius Token Factory for the
// NVIDIA Nemotron models): the service's key page opens in a website tab of the built-in browser, and a strip above that
// page takes the key, so it never has to be carried back to Settings. Without the built-in browser (the plain web page,
// or links set to open in the system browser) the page opens in the system browser and the key goes into Settings.
import { html, Icon, Spinner, useEffect, useState } from "./ui.js";
import { api, loadModels, loadProviders, loadSettings, post, setView, state, toast } from "./store.js";
import { actions } from "./actions.js";
import { builtinBrowserAvailable, linkTargetOf, openSystemLink } from "./link-target.js";
import { serverText, t } from "./i18n.js";

const NEBIUS_SLOT_NAMES = { ultra: "Nemotron 3 Ultra", lightning: "Nemotron 3.5 Lightning", nano: "Nemotron 3 Nano", vision: "Nemotron 3.5 Super VL" };

/** What each service needs: where its keys are made, how a pasted key is saved, and what to say once it is. */
export const KEY_SERVICES = {
	tavily: {
		name: "Tavily",
		url: "https://app.tavily.com/",
		hint: "Create a free API key there (1,000 searches a month, no card), then paste it here.",
		section: "search",
		async save(key) {
			await post("/api/settings/tavily-key/add", { label: "", key }, "");
			await loadSettings();
			return t("Web search now uses your Tavily key.");
		},
	},
	nebius: {
		name: "Nebius Token Factory",
		url: "https://tokenfactory.nebius.com/project/api-keys",
		hint: "Sign in, create an API key, then paste it here. The NVIDIA Nemotron models are set up for you.",
		section: "providers",
		provider: "nebius",
		async save(key) {
			const result = await post("/api/providers/nebius/setup", { apiKey: key });
			if (!result?.ok) throw new Error(serverText(result?.message, t("The key could not be saved.")));
			await Promise.all([loadProviders(), loadSettings()]);
			loadModels();
			return nebiusSummary(result);
		},
	},
};

/** One line about a Nebius setup: the models found, and how many jobs got one. */
export function nebiusSummary(result) {
	const models = (result.models || []).map((model) => NEBIUS_SLOT_NAMES[model.slot] || model.name).join(", ");
	const jobs = (result.assigned || []).length;
	return jobs
		? t("Ready: {models}. {count} jobs now use them.", { models, count: jobs })
		: t("Ready: {models}. Every job keeps the model you set.", { models });
}

// Website tabs that were opened to get a key, and for which service. Only these show the strip.
const keyTabs = new Map();
const listeners = new Set();
const publish = () => {
	for (const listener of listeners) listener(new Map(keyTabs));
};

/** Open a page of a service (its key page by default) where the link preference says; Settings makes room for it. */
export function openServicePage(service, url = KEY_SERVICES[service]?.url, { keyStrip = true } = {}) {
	if (!url) return;
	if (builtinBrowserAvailable() && linkTargetOf(state.view.linkTarget) === "builtin") {
		// Settings covers the panel, and a covered website is hidden: close it so the page is seen at once.
		setView({ settingsOpen: false });
		const id = actions.openWorkspace({ type: "browser", url });
		if (id && keyStrip) {
			keyTabs.set(id, service);
			publish();
		}
		return;
	}
	openSystemLink(url);
}

/** The strip above a website tab that was opened to get a key: paste, save, and go back to Settings. */
export function KeyPasteStrip({ tabId }) {
	const [tabs, setTabs] = useState(() => new Map(keyTabs));
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [done, setDone] = useState("");
	useEffect(() => {
		listeners.add(setTabs);
		return () => listeners.delete(setTabs);
	}, []);
	const service = tabs.get(tabId);
	const info = service && KEY_SERVICES[service];
	if (!info) return null;
	const close = () => {
		keyTabs.delete(tabId);
		publish();
	};
	const save = async () => {
		const key = value.trim();
		if (!key || busy) return;
		setBusy(true);
		setError("");
		try {
			const message = await info.save(key);
			setValue("");
			setDone(message);
			toast(message, "info", 5000);
		} catch (failure) {
			setError(serverText(failure?.message, t("The key could not be saved.")));
		} finally {
			setBusy(false);
		}
	};
	const back = () => setView({ settingsOpen: true, settingsSection: info.section, ...(info.provider ? { providerSel: info.provider } : {}) });
	return html`<div class=${`notice ws-key-strip ${done ? "ok" : ""}`} role="region" aria-label=${t("{name} API key", { name: info.name })}>
		<${Icon} name=${done ? "check" : "key"} size=${14} />
		${done
			? html`<span class="grow ws-key-text">${done}</span>
				<button class="btn sm" onClick=${back}>${t("Back to Settings")}</button>`
			: html`<span class="ws-key-text"><strong>${info.name}</strong> <span class="dim">${t(info.hint)}</span></span>
				<form class="row grow ws-key-form" onSubmit=${(event) => { event.preventDefault(); void save(); }}>
					<input class="field mono grow" type="password" autocomplete="off" spellcheck=${false} placeholder=${t("Paste the API key")} aria-label=${t("{name} API key", { name: info.name })} value=${value} onInput=${(e) => setValue(e.target.value)} />
					<button class="btn sm primary" type="submit" disabled=${busy || !value.trim()}>${busy ? html`<${Spinner} size=${12} />` : null}${t("Save key")}</button>
				</form>`}
		<button class="icon-btn sm" title=${t("Close")} aria-label=${t("Close")} onClick=${close}><${Icon} name="x" size=${13} /></button>
		${error ? html`<div class="ws-key-error danger" role="alert">${error}</div>` : null}
	</div>`;
}

/** The Nebius card's live facts: set up or not, the console links and this computer's spending estimate. */
export function useNebiusInfo(nonce) {
	const [info, setInfo] = useState(null);
	useEffect(() => {
		let live = true;
		api("/api/providers/nebius")
			.then((value) => live && setInfo(value))
			.catch(() => live && setInfo(null));
		return () => {
			live = false;
		};
	}, [nonce]);
	return info;
}
