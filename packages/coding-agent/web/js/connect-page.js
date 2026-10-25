// Connections: the accounts MyHarness signs in to on the user's behalf — GitHub (github tool) and Gmail / Outlook
// mailboxes (mail tool). One page in Settings manages them; the right panel lists them compactly. Both read the same
// server state (GET /api/github, GET /api/mail) and follow its progress events (`github_event`, `mail_event`).
// The /settings command panel keeps its own keyboard pages for the same calls (command-panel.js).
import { html, useEffect, useRef, useState, Collapse, Icon, Spinner } from "./ui.js";
import { api, attempt, post, setView, toast, useStore } from "./store.js";
import { confirmDialog } from "./actions.js";
import { openSystemLink } from "./link-target.js";
import { N_, serverText, t } from "./i18n.js";

/** Per mail provider: what the page says about it, where its app is registered and where the grant is revoked. */
export const MAIL_PROVIDERS = {
	google: {
		connect: N_("Gmail"),
		desc: N_("Gmail and Google Workspace mailboxes"),
		setup: N_("In Google Cloud Console: enable the Gmail API, set up the OAuth consent screen (Internal is possible for your own Google Workspace), add yourself as a test user or publish the app — apps left in Testing must sign in again every 7 days — then create an OAuth client of type “Desktop app” and paste its Client ID and Client Secret here."),
		register: "https://console.cloud.google.com/apis/credentials",
		registerLabel: N_("Open Google Cloud credentials"),
		idPlaceholder: "1234567890-….apps.googleusercontent.com",
		secret: true,
	},
	microsoft: {
		connect: N_("Outlook"),
		desc: N_("Outlook.com, Hotmail, Live and Microsoft 365 work or school mailboxes"),
		setup: N_("In Microsoft Entra → App registrations → New registration: choose “Accounts in any organizational directory and personal Microsoft accounts”, and add the platform “Mobile and desktop applications” with the redirect URI http://localhost. Paste the Application (client) ID here; no secret is needed. A work or school account may need its administrator to approve the app."),
		register: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
		registerLabel: N_("Open Microsoft app registrations"),
		idPlaceholder: "00000000-0000-0000-0000-000000000000",
	},
};

const providerLabel = (provider) => t(MAIL_PROVIDERS[provider]?.connect ?? provider);
const accountRef = (account) => `${account.provider}:${account.email}`;

/**
 * GitHub and mail connection state, reloaded whenever the server reports progress. `notify` shows the outcome of a
 * sign-in as a toast (the Settings page does; the right panel only refreshes) and opens a mail sign-in page this page
 * asked for.
 */
export function useConnections({ notify = false } = {}) {
	const githubEvent = useStore((s) => s.githubEvent);
	const mailEvent = useStore((s) => s.mailEvent);
	const [github, setGithub] = useState(null);
	const [mail, setMail] = useState(null);
	const [error, setError] = useState("");
	const [prompt, setPrompt] = useState({ github: null, mail: null });
	const opening = useRef(false);
	// Which service the waiting sign-in is for: known at once from the click, then from the server state.
	const [asked, setAsked] = useState(null);
	const reload = () =>
		Promise.all([api("/api/github").then(setGithub), api("/api/mail").then(setMail)]).then(
			() => setError(""),
			(cause) => setError(cause?.message || String(cause)),
		);
	useEffect(() => {
		reload();
	}, []);
	useEffect(() => {
		if (!githubEvent) return;
		if (githubEvent.type === "prompt") return setPrompt((p) => ({ ...p, github: githubEvent.prompt }));
		setPrompt((p) => ({ ...p, github: null }));
		if (notify && githubEvent.type === "done") toast(githubEvent.verified ? t("The connection is valid; GitHub confirmed the account.") : t("GitHub connected; the credentials are saved."), "info", 5000);
		if (notify && githubEvent.type === "error") toast(serverText(githubEvent.message), "error", 9000);
		reload();
	}, [githubEvent?.nonce]);
	useEffect(() => {
		if (!mailEvent) return;
		if (mailEvent.type === "prompt") {
			setPrompt((p) => ({ ...p, mail: mailEvent.url }));
			if (opening.current) openSystemLink(mailEvent.url);
			opening.current = false;
			return;
		}
		opening.current = false;
		setPrompt((p) => ({ ...p, mail: null }));
		if (notify && mailEvent.type === "done") toast(t("Mailbox {email} connected; the credentials are saved.", { email: mailEvent.account?.email ?? "" }), "info", 5000);
		if (notify && mailEvent.type === "error") toast(serverText(mailEvent.message), "error", 9000);
		reload();
	}, [mailEvent?.nonce]);
	const githubPrompt = prompt.github ?? github?.pending?.prompt ?? null;
	const mailUrl = prompt.mail ?? mail?.pending?.url ?? null;
	return {
		github,
		mail,
		error,
		reload,
		githubPrompt,
		mailUrl,
		githubPending: !!github?.pending || !!prompt.github,
		mailPending: !!mail?.pending || !!prompt.mail,
		mailProvider: mail?.pending?.provider ?? asked,
		connectGithub: async (verify = false) => {
			if (await attempt(() => post("/api/github/connect", { verify }))) reload();
		},
		connectMail: async (provider) => {
			opening.current = true;
			setAsked(provider);
			if (await attempt(() => post("/api/mail/connect", { provider }))) reload();
			else opening.current = false;
		},
	};
}

/** Numbered one-time setup steps of each service's OAuth app; a step may carry the link that does it. */
/** The header button of a service whose OAuth app is not set up yet: opens and closes its steps. */
const setupButton = (open, setOpen) => html`<button class=${`btn ${open ? "" : "primary"}`} aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name=${open ? "chevronUp" : "wrench"} size=${13} />${open ? t("Hide steps") : t("Set up")}</button>`;

const SETUP_STEPS = {
	github: [
		{ text: N_("Create a GitHub OAuth app. Homepage URL and Authorization callback URL: http://localhost."), link: "https://github.com/settings/applications/new", linkLabel: N_("Create a GitHub app") },
		{ text: N_("Tick “Enable Device Flow” and register the app. No Client Secret is needed.") },
		{ text: N_("Copy its Client ID and paste it below.") },
	],
	google: [
		{ text: N_("Open Google Cloud credentials and enable the Gmail API for your project."), link: MAIL_PROVIDERS.google.register, linkLabel: MAIL_PROVIDERS.google.registerLabel },
		{ text: N_("Set up the OAuth consent screen and add yourself as a test user. Apps left in Testing must sign in again every 7 days; publish the app to avoid it.") },
		{ text: N_("Create an OAuth client of type “Desktop app”, then paste its Client ID and Client Secret below.") },
	],
	microsoft: [
		{ text: N_("Open Microsoft app registrations and add a new registration for “Accounts in any organizational directory and personal Microsoft accounts”."), link: MAIL_PROVIDERS.microsoft.register, linkLabel: MAIL_PROVIDERS.microsoft.registerLabel },
		{ text: N_("Under Authentication, add the platform “Mobile and desktop applications” with the redirect URI http://localhost.") },
		{ text: N_("Paste the Application (client) ID below. No secret is needed; a work or school account may need its administrator to approve the app.") },
	],
};

/** One service: logo tile, name and state, a one-line purpose, the main action, then its accounts and setup. */
function ServiceCard({ icon, tone, name, desc, badge, action, children }) {
	return html`<section class="svc-card">
		<header class="svc-head">
			<span class=${`svc-logo ${tone}`} aria-hidden="true"><${Icon} name=${icon} size=${18} /></span>
			<div class="svc-title"><div class="svc-name"><strong>${name}</strong>${badge ? html`<span class=${`badge ${badge.cls}`}>${badge.text}</span>` : null}</div><span class="svc-desc">${desc}</span></div>
			${action ? html`<div class="svc-action">${action}</div>` : null}
		</header>
		${children}
	</section>`;
}

/** A connected account: its initial, the address, what it is, and its own buttons. */
function AccountRow({ title, subtitle, warn, children }) {
	return html`<div class="svc-account">
		<span class="svc-avatar" aria-hidden="true">${(title.replace(/^@/, "")[0] || "?").toUpperCase()}</span>
		<div class="svc-account-text"><span class="truncate" title=${title}>${title}</span>${subtitle ? html`<span class=${`truncate svc-account-sub ${warn ? "warn" : ""}`} title=${subtitle}>${subtitle}</span>` : null}</div>
		<div class="svc-account-actions">${children}</div>
	</div>`;
}

/**
 * The OAuth app of a service: numbered steps and the fields. Not set up yet, they open from the card's "Set up" button;
 * set up, they fold under one line, where a new Client ID replaces the saved one. The fields never show a saved secret.
 */
function AppSetup({ steps, configured, fromEnvironment, idPlaceholder, secret, secretSet, onSave, open, setOpen }) {
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [busy, setBusy] = useState(false);
	const ready = !!clientId.trim() && (!secret || !!clientSecret.trim());
	const save = async () => {
		setBusy(true);
		try {
			if (await onSave(clientId.trim(), clientSecret.trim())) {
				setClientId("");
				setClientSecret("");
				setOpen(false);
			}
		} finally {
			setBusy(false);
		}
	};
	const body = html`<div class="svc-setup">
		${fromEnvironment
			? html`<div class="set-desc">${t("Set by an environment variable, which takes precedence.")}</div>`
			: html`${configured ? null : html`<div class="svc-setup-title">${t("One-time setup before the first sign-in")}</div>`}
				<ol class="svc-steps">
					${steps.map((step, index) => html`<li key=${index}><span class="svc-step-n">${index + 1}</span><div class="svc-step-text"><span>${t(step.text)}</span>${step.link ? html`<button class="btn sm" onClick=${() => openSystemLink(step.link)}><${Icon} name="externalLink" size=${12} />${t(step.linkLabel)}</button>` : null}</div></li>`)}
				</ol>
				<div class="svc-fields">
					<label class="svc-field"><span>Client ID</span><input class="field" value=${clientId} placeholder=${configured ? t("Set — paste a new one to replace it") : idPlaceholder} spellcheck="false" autocomplete="off" onInput=${(e) => setClientId(e.target.value)} /></label>
					${secret ? html`<label class="svc-field"><span>Client Secret</span><input class="field" type="password" value=${clientSecret} placeholder=${secretSet ? "••••••••" : "GOCSPX-…"} spellcheck="false" autocomplete="off" onInput=${(e) => setClientSecret(e.target.value)} /></label>` : null}
					<button class="btn primary" disabled=${busy || !ready} onClick=${save}>${busy ? html`<${Spinner} />` : null}${t("Save")}</button>
				</div>`}
	</div>`;
	if (!configured) return html`<${Collapse} open=${open}>${body}<//>`;
	return html`<div class="svc-app">
		<button class="svc-app-toggle" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name="chevronRight" size=${13} class="disclose" />${fromEnvironment ? t("OAuth app set by an environment variable") : t("Uses your own OAuth app · change")}</button>
		<${Collapse} open=${open}>${body}<//>
	</div>`;
}

function GithubCard({ c }) {
	const data = c.github;
	const account = data.account;
	const [setupOpen, setSetupOpen] = useState(false);
	const badge = c.githubPending ? { cls: "warn", text: t("Waiting for GitHub…") } : account ? (data.needsReauthorization ? { cls: "warn", text: t("Reauthorize") } : { cls: "ok", text: t("Connected") }) : !data.clientIdConfigured ? { cls: "", text: t("Needs setup") } : { cls: "", text: t("Not connected") };
	const disconnect = async () => {
		const ok = await confirmDialog({
			title: t("Disconnect GitHub?"),
			message: t("The saved credentials of @{login} are removed from this computer. The account and repositories are not deleted, and GitHub's own authorization stays until you revoke it there.", { login: account.login }),
			confirmLabel: t("Disconnect"),
			danger: true,
		});
		if (ok && (await attempt(() => post("/api/github/disconnect")))) c.reload();
	};
	const action = c.githubPending
		? html`${c.githubPrompt ? html`<button class="btn primary" onClick=${() => openSystemLink(c.githubPrompt.url)}><${Icon} name="externalLink" size=${13} />${t("Enter the code {code} on GitHub", { code: c.githubPrompt.code })}</button>` : html`<${Spinner} />`}<button class="btn" onClick=${async () => (await attempt(() => post("/api/github/cancel")), c.reload())}>${t("Cancel")}</button>`
		: !account && data.clientIdConfigured
			? html`<button class="btn primary" onClick=${() => c.connectGithub(false)}><${Icon} name="plug" size=${13} />${t("Connect GitHub")}</button>`
			: !data.clientIdConfigured && !data.clientIdFromEnvironment ? setupButton(setupOpen, setSetupOpen) : null;
	return html`<${ServiceCard} icon="gitBranch" tone="github" name="GitHub" desc=${t("Private repositories, issues, pull requests and workflows for the github tool.")} badge=${badge} action=${action}>
		${account
			? html`<${AccountRow} title=${`@${account.login}`} subtitle=${data.needsReauthorization ? t("This older connection lacks permissions; reauthorize to reach private repositories.") : t("GitHub account")} warn=${data.needsReauthorization}>
					<button class="btn sm ghost" onClick=${() => c.connectGithub(true)}>${t("Verify")}</button>
					<button class="btn sm ghost" disabled=${c.githubPending} onClick=${() => c.connectGithub(false)}>${t("Reauthorize")}</button>
					<button class="btn sm ghost danger" onClick=${disconnect}>${t("Disconnect")}</button>
				<//>`
			: null}
		<${AppSetup} steps=${SETUP_STEPS.github} configured=${!!data.clientIdConfigured} fromEnvironment=${!!data.clientIdFromEnvironment} idPlaceholder="Ov23li…" open=${setupOpen} setOpen=${setSetupOpen}
			onSave=${async (clientId) => { const ok = await attempt(() => post("/api/github/client-id", { clientId }), { success: t("Saved.") }); if (ok) c.reload(); return ok; }} />
	<//>`;
}

function MailProviderCard({ c, provider }) {
	const info = MAIL_PROVIDERS[provider];
	const app = c.mail.providers?.[provider];
	const accounts = (c.mail.accounts || []).filter((account) => account.provider === provider);
	const waiting = c.mailPending && c.mailProvider === provider;
	const [setupOpen, setSetupOpen] = useState(false);
	const verify = async (account) => {
		const result = await attempt(() => post("/api/mail/verify", { account: accountRef(account) }));
		if (result) toast(t("The connection is valid; the mailbox {email} answered.", { email: result.account?.email ?? account.email }), "info", 5000);
	};
	const disconnect = async (account) => {
		const ok = await confirmDialog({
			title: t("Disconnect {email}?", { email: account.email }),
			message: t("The saved credentials of this mailbox are removed from this computer. No mail is deleted, and the provider's own authorization stays until you revoke it there."),
			confirmLabel: t("Disconnect"),
			danger: true,
		});
		if (ok && (await attempt(() => post("/api/mail/disconnect", { account: accountRef(account) })))) c.reload();
	};
	const badge = waiting ? { cls: "warn", text: t("Waiting for sign-in") } : accounts.length ? { cls: "ok", text: t("{count} connected", { count: accounts.length }) } : !app?.configured ? { cls: "", text: t("Needs setup") } : { cls: "", text: t("Not connected") };
	const action = waiting
		? html`${c.mailUrl ? html`<button class="btn primary" onClick=${() => openSystemLink(c.mailUrl)}><${Icon} name="externalLink" size=${13} />${t("Open the sign-in page")}</button>` : html`<${Spinner} />`}<button class="btn" onClick=${async () => (await attempt(() => post("/api/mail/cancel")), c.reload())}>${t("Cancel")}</button>`
		: app?.configured
			? html`<button class=${`btn ${accounts.length ? "" : "primary"}`} disabled=${c.mailPending} title=${c.mailPending ? t("Another sign-in is waiting.") : undefined} onClick=${() => c.connectMail(provider)}><${Icon} name="plus" size=${13} />${accounts.length ? t("Add account") : t("Connect")}</button>`
			: setupButton(setupOpen, setSetupOpen);
	const save = async (clientId, clientSecret) => {
		const ok = await attempt(() => post("/api/mail/app", { provider, clientId, clientSecret: info.secret ? clientSecret : undefined }), { success: t("Saved.") });
		if (ok) c.reload();
		return ok;
	};
	return html`<${ServiceCard} icon="mail" tone=${provider} name=${providerLabel(provider)} desc=${t(info.desc)} badge=${badge} action=${action}>
		${accounts.map((account) => html`<${AccountRow} key=${accountRef(account)} title=${account.email} subtitle=${account.name || providerLabel(provider)}>
			<button class="btn sm ghost" onClick=${() => verify(account)}>${t("Verify")}</button>
			<button class="btn sm ghost" disabled=${c.mailPending} onClick=${() => c.connectMail(provider)}>${t("Reauthorize")}</button>
			<button class="btn sm ghost danger" onClick=${() => disconnect(account)}>${t("Disconnect")}</button>
		<//>`)}
		${waiting ? html`<div class="svc-note">${t("Finish signing in in the browser; this page updates by itself.")}</div>` : null}
		<${AppSetup} steps=${SETUP_STEPS[provider]} configured=${!!app?.configured} fromEnvironment=${!!app?.fromEnvironment} idPlaceholder=${info.idPlaceholder} secret=${!!info.secret} secretSet=${!!app?.clientSecretSet} open=${setupOpen} setOpen=${setSetupOpen} onSave=${save} />
	<//>`;
}

/** Settings → Connections: GitHub, then one card per mail service. */
export function ConnectPage() {
	const c = useConnections({ notify: true });
	if (!c.github || !c.mail) return c.error ? html`<div class="notice danger">${serverText(c.error)}</div>` : html`<${Spinner} />`;
	return html`<div class="svc-page">
		${c.mail.error ? html`<div class="notice danger">${serverText(c.mail.error)}</div>` : null}
		${c.github.error ? html`<div class="notice danger">${serverText(c.github.error)}</div>` : null}
		<div class="svc-group-title">${t("Code hosting")}</div>
		<${GithubCard} c=${c} />
		<div class="svc-group-title">${t("Mailboxes")}<span>${t("Gmail and Outlook mailboxes the mail tool can read, search, send and organize.")}</span></div>
		${Object.keys(MAIL_PROVIDERS).map((provider) => html`<${MailProviderCard} key=${provider} c=${c} provider=${provider} />`)}
		<div class="svc-foot"><${Icon} name="lock" size=${12} />${t("Sign-in happens on each provider's own page. The tokens stay on this computer; disconnecting removes them here.")}</div>
	</div>`;
}

/** The right panel's compact list of connected accounts (state from useConnections), with a way into Settings → Connections. */
export function ConnectList({ c }) {
	if (!c.github || !c.mail) return c.error ? html`<div class="dim">${serverText(c.error)}</div>` : html`<${Spinner} />`;
	const account = c.github.account;
	const accounts = c.mail.accounts || [];
	const manage = () => setView({ settingsOpen: true, settingsSection: "connect" });
	return html`
		<div class="res-row connect-row" title=${account ? `GitHub @${account.login}` : undefined}>
			<${Icon} name="gitBranch" size=${14} class="connect-icon" />
			<span class="grow truncate">GitHub</span>
			${c.githubPending ? html`<span class="badge warn">${t("Waiting")}</span>` : account ? html`<span class="dim truncate connect-who">@${account.login}</span>` : html`<span class="badge">${t("Not connected")}</span>`}
		</div>
		${accounts.map((mailbox) => html`<div class="res-row connect-row" key=${accountRef(mailbox)} title=${mailbox.email}>
			<${Icon} name="mail" size=${14} class="connect-icon" />
			<span class="grow truncate">${mailbox.email}</span>
			<span class="dim connect-who">${providerLabel(mailbox.provider)}</span>
		</div>`)}
		${c.mailPending ? html`<div class="res-row connect-row"><${Icon} name="mail" size=${14} class="connect-icon" /><span class="grow dim">${t("Waiting for sign-in")}</span>${c.mailUrl ? html`<button class="btn sm" onClick=${() => openSystemLink(c.mailUrl)}>${t("Open")}</button>` : null}</div>` : null}
		${!accounts.length && !c.mailPending ? html`<div class="dim connect-empty">${t("No mailbox connected yet. Connect Gmail or Outlook so the agent can work with your mail.")}</div>` : null}
		<button class="prompt-add" onClick=${manage}><${Icon} name="plug" size=${13} />${t("Manage connections")}</button>`;
}

/** How many accounts are connected, for the right panel's section count. */
export function connectedCount(c) {
	return (c.github?.account ? 1 : 0) + (c.mail?.accounts?.length ?? 0);
}
