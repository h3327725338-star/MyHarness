// The Agent's request for the user's help on a website tab (packages/desktop/browser-help.cjs): sign in, pass a human
// check, or another step only a person may take. The tab shows it above the page with Done / Not now; the Agent's call
// waits for that answer, or for the page to finish the step by itself (a human check that goes away).
import { html, Icon } from "./ui.js";
import { N_, t } from "./i18n.js";

const COPY = {
	login: {
		icon: "lock",
		title: N_("MyHarness needs you to sign in on this page"),
		hint: N_("Sign in here, then press Done and it carries on."),
		decline: N_("Not now"),
	},
	verify: {
		icon: "shield",
		title: N_("MyHarness needs you to complete this check"),
		hint: N_("Complete the check here. It carries on by itself once the check is gone."),
		decline: N_("Skip"),
	},
	other: {
		icon: "info",
		title: N_("MyHarness needs your help on this page"),
		hint: N_("Do the step here, then press Done."),
		decline: N_("Not now"),
	},
};

/** The words for one kind of request (`login`, `verify`, anything else). */
export function helpCopy(reason) {
	return COPY[reason] || COPY.other;
}

/** The request above the page: what is asked, the Agent's own sentence when it gave one, and the two answers. */
export function HelpRequest({ help, onAnswer }) {
	const copy = helpCopy(help.reason);
	return html`<div class="notice ws-help" role="alertdialog" aria-label=${t(copy.title)}>
		<${Icon} name=${copy.icon} size=${16} />
		<div class="grow ws-help-text"><strong>${t(copy.title)}</strong><span>${help.message || t(copy.hint)}</span></div>
		<button class="btn sm primary" onClick=${() => onAnswer("done")}>${t("I’m done")}</button>
		<button class="btn sm" onClick=${() => onAnswer("declined")}>${t(copy.decline)}</button>
	</div>`;
}
