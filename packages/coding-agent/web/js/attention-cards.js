// Cards at the top right of the conversation, above the toasts: the Agent's requests for the user's help that cannot be
// seen where the user is (another chat, a closed panel, another tab), and scheduled tasks when their time comes
// (schedules.js). A card stays until it is answered or closed; one with `ttl` folds away by itself unless the pointer
// rests on it. Every card carries the class `toast`, so a website view it covers steps aside (browser-view-sync.js).
import { Collapse, html, Icon, useEffect, useRetainedRows, useState } from "./ui.js";
import { panelSessionId, set, state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { t } from "./i18n.js";
import { helpCopy } from "./browser-help.js";
import { showNotification } from "./notifications.js";
import { appFocused } from "./page-presence.js";

/** What each kind of card does with a button press: `(card, actionId) => void`. */
const handlers = new Map();

export function registerCardKind(kind, handler) {
	handlers.set(kind, handler);
}

/**
 * Show a card, or replace the one with the same id: `{ id, kind, icon, title, body?, meta?, tone?, actions?: [{ id,
 * label, primary? }], ttl? }`. Newest first.
 */
export function showCard(card) {
	set({ cards: [card, ...state.cards.filter((item) => item.id !== card.id)].slice(0, 8) });
}

export function dismissCard(id) {
	if (!state.cards.some((item) => item.id === id)) return;
	set({ cards: state.cards.filter((item) => item.id !== id) });
}

const siteOf = (url) => {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
};

/** The chat a help request belongs to, by name as the sidebar shows it. */
const chatNameOf = (sessionId) => {
	const slot = sessionId ? state.slots.find((item) => item.sessionId === sessionId) : undefined;
	return slot?.name || "";
};

/** Whether the user can see the request where it is: its chat on screen, its tab the panel's active tab. */
function helpVisible(request) {
	const sessionId = request.help.sessionId;
	return (!sessionId || sessionId === panelSessionId()) && state.view.panelOpen && state.view.wsActive === request.tabId;
}

/** Bring the user to the tab that waits: its chat, the panel open on that tab. */
export async function goToHelp(tabId) {
	const request = state.helpRequests[tabId];
	if (!request) return;
	const sessionId = request.help.sessionId;
	if (sessionId && sessionId !== panelSessionId()) {
		const slot = state.slots.find((item) => item.sessionId === sessionId);
		if (slot) await actions.openTask(slot.slot);
	}
	actions.activateWorkspaceTab(tabId);
}

function answerHelp(tabId, outcome) {
	const request = state.helpRequests[tabId];
	if (!request) return;
	window.myHarnessDesktop?.browser?.({ action: "handoff-answer", tabId, helpId: request.help.id, outcome }).catch(() => undefined);
}

/**
 * A website tab's state from the desktop host: remember its open help request, or forget one that ended. A new request
 * while the user is not looking at the app also shows a system notification; a click on it leads to the tab.
 */
export function noteBrowserHelp(tabId, browserState) {
	const help = browserState?.help || null;
	const known = state.helpRequests[tabId];
	if (!help) {
		if (!known) return;
		const { [tabId]: _ended, ...rest } = state.helpRequests;
		set({ helpRequests: rest });
		return;
	}
	if (known?.help.id === help.id) return;
	set({ helpRequests: { ...state.helpRequests, [tabId]: { tabId, help, url: browserState.url || "" } } });
	if (appFocused() && document.visibilityState === "visible") return;
	const copy = helpCopy(help.reason);
	void showNotification({
		title: t(copy.title),
		body: help.message || siteOf(browserState.url) || t(copy.hint),
		tag: `myharness-help-${tabId}`,
		onClick: () => void goToHelp(tabId),
	});
}

/** A closed tab ends its request too (the host answers the Agent with `closed`). */
export function forgetBrowserHelp(tabId) {
	noteBrowserHelp(tabId, null);
}

function helpCard(request) {
	const copy = helpCopy(request.help.reason);
	const chat = chatNameOf(request.help.sessionId);
	return {
		id: `help:${request.tabId}`,
		kind: "help",
		tabId: request.tabId,
		icon: copy.icon,
		tone: "accent",
		title: t(copy.title),
		body: request.help.message || t(copy.hint),
		meta: [siteOf(request.url), chat].filter(Boolean).join(" · "),
		actions: [
			{ id: "show", label: t("Go to the page"), primary: true },
			{ id: "decline", label: t(copy.decline) },
		],
	};
}

registerCardKind("help", (card, actionId) => {
	if (actionId === "show") void goToHelp(card.tabId);
	else if (actionId === "decline") answerHelp(card.tabId, "declined");
});

function press(card, actionId) {
	handlers.get(card.kind)?.(card, actionId);
}

function close(card) {
	if (card.kind === "help") {
		// Closing the card only hides it until the next request; the tab keeps its own bar.
		const request = state.helpRequests[card.tabId];
		if (request) set({ helpRequests: { ...state.helpRequests, [card.tabId]: { ...request, hidden: true } } });
		return;
	}
	press(card, "dismiss");
	dismissCard(card.id);
}

function Card({ card }) {
	const [held, setHeld] = useState(false);
	useEffect(() => {
		if (!card.ttl || held) return undefined;
		const timer = setTimeout(() => close(card), card.ttl);
		return () => clearTimeout(timer);
	}, [card.id, card.ttl, held]);
	// Drawn like a toast (Toasts in app.js): a plain glyph, coloured only for a failure or a warning, and text buttons.
	return html`<div class=${`toast attention-card ${card.tone || ""}`} role="alertdialog" aria-label=${card.title} onMouseEnter=${() => setHeld(true)} onMouseLeave=${() => setHeld(false)}>
		<${Icon} name=${card.icon || "info"} size=${15} class=${`attention-glyph ${card.tone === "danger" ? "c-danger" : card.tone === "warn" ? "c-warn" : "c-dim"}`} />
		<div class="attention-body">
			<div class="attention-head"><span class="attention-title truncate">${card.title}</span>${card.meta ? html`<span class="dim truncate attention-meta">${card.meta}</span>` : null}</div>
			${card.body ? html`<div class="attention-text">${card.body}</div>` : null}
			${card.actions?.length
				? html`<div class="row attention-actions">${card.actions.map((item) => html`<button key=${item.id} class=${`link-btn ${item.primary ? "primary" : ""}`} onClick=${() => press(card, item.id)}>${item.label}</button>`)}</div>`
				: null}
		</div>
		<button class="icon-btn sm" title=${t("Dismiss")} aria-label=${t("Dismiss")} onClick=${() => close(card)}><${Icon} name="x" size=${13} /></button>
	</div>`;
}

/** The stack: help requests the user cannot see where they are, then the other cards, newest first. */
export function AttentionCards() {
	const cards = useStore((s) => s.cards);
	const help = useStore((s) => s.helpRequests);
	// The chat on screen, its panel and its active tab decide which help requests need a card.
	useStore((s) => `${panelSessionId()}|${s.view.panelOpen}|${s.view.wsActive}`);
	useStore((s) => s.slots);
	const helpCards = Object.values(help)
		.filter((request) => !request.hidden && !helpVisible(request))
		.map(helpCard);
	const { rows, present } = useRetainedRows([...helpCards, ...cards], "id");
	return rows.map(
		(card) => html`<${Collapse} key=${card.id} open=${present.has(card.id)} class="toast-slot"><${Card} card=${card} /><//>`,
	);
}
