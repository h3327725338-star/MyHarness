/**
 * Which way the user's email goes, as context of every chat that has both the `mail` tool and the built-in browser
 * (`workspace`): the mailboxes connected to the mail tool through their API, or, with none connected, the web mail the
 * user is signed in to in the built-in browser. Without it the Agent called the mail tool first and failed on the
 * missing connection before it turned to the browser. The note is sent again only when the route changed since the copy
 * already in the conversation, and it is added after the user's message, so the cached prefix stays as it was.
 */
import { createHash } from "node:crypto";
import type { MailAccount } from "../../providers/credentials/mail-connections.ts";
import type { DesktopWorkspaceChannel } from "../workspace.ts";

export const MAIL_ROUTE_CONTEXT_TYPE = "mail-route";
/** The host answers from what it saw; the Gmail check may ask Google, which must not hold up the user's message. */
const HOST_TIMEOUT_MS = 1500;
/** How long an answer of the host about its web mail sign-ins is reused. */
const WEB_MAIL_REUSE_MS = 10 * 60_000;

export interface MailRouteContext {
	customType: typeof MAIL_ROUTE_CONTEXT_TYPE;
	content: string;
	details: { v: 1; hash: string; accounts: number };
}

/** The built-in browser's web mail sign-ins (the host's `webMail` command, packages/desktop/browser-web-mail.cjs). */
interface WebMailEntry {
	signedIn: boolean;
	account?: string;
}
type WebMailState = Partial<Record<"google" | "microsoft", WebMailEntry>>;

let webMailAnswer: { at: number; value: WebMailState } | undefined;

async function webMailState(
	channel: DesktopWorkspaceChannel | undefined,
	now: number,
): Promise<WebMailState | undefined> {
	if (!channel) return undefined;
	if (webMailAnswer && now - webMailAnswer.at < WEB_MAIL_REUSE_MS) return webMailAnswer.value;
	try {
		const value = (await channel.request({ action: "webMail" }, HOST_TIMEOUT_MS)) as WebMailState | null;
		if (!value || typeof value !== "object") return undefined;
		webMailAnswer = { at: now, value };
		return value;
	} catch {
		return undefined;
	}
}

const WEB_MAIL_SITES = [
	{ provider: "google", name: "Gmail", url: "https://mail.google.com/" },
	{ provider: "microsoft", name: "Outlook", url: "https://outlook.office.com/mail/" },
] as const;

/** The note for this route. */
export function renderMailRoute(accounts: readonly MailAccount[], webMail: WebMailState | undefined): string {
	if (accounts.length) {
		const list = accounts.map(
			(account) => `${account.email} (${account.provider === "google" ? "Gmail" : "Outlook"})`,
		);
		return `[system-reminder] Mailboxes connected to the mail tool through their API: ${list.join(", ")}. Use the mail tool for the user's email.`;
	}
	const signedIn = WEB_MAIL_SITES.filter((site) => webMail?.[site.provider]?.signedIn).map((site) => {
		const account = webMail?.[site.provider]?.account;
		return `${site.name}${account ? ` as ${account}` : ""} (${site.url})`;
	});
	return [
		"[system-reminder] No mailbox is connected to the mail tool through its API. To send an email, still call the mail tool, with only message (to, subject, text) and no path: MyHarness sends it by itself through the Gmail or Outlook website the user is signed in to in the built-in browser, within seconds; never fill the website's compose form yourself. Everything else (reading, searching, replying in a thread, attachments) works only in the website: with the workspace tool, open the web mail the user is signed in to there (or their bookmark of it), act in that page, and use `handoff` when only the user can sign in.",
		signedIn.length
			? `Signed in to in the built-in browser now: ${signedIn.join(", ")}.`
			: `Web mail sites: ${WEB_MAIL_SITES.map((site) => `${site.name} ${site.url}`).join(", ")}.`,
	].join(" ");
}

/**
 * The route for this turn, or undefined when the conversation already has this exact route (or there is no desktop host
 * to fall back to). `earlier` are the details of the route notes already in context.
 */
export async function mailRouteContext(
	earlier: readonly unknown[],
	accounts: () => readonly MailAccount[],
	channel: DesktopWorkspaceChannel | undefined,
	now = Date.now(),
): Promise<MailRouteContext | undefined> {
	if (!channel) return undefined;
	let connected: readonly MailAccount[];
	try {
		connected = accounts();
	} catch {
		connected = [];
	}
	const content = renderMailRoute(connected, connected.length ? undefined : await webMailState(channel, now));
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const last = earlier.at(-1) as { hash?: unknown } | undefined;
	if (last?.hash === hash) return undefined;
	return { customType: MAIL_ROUTE_CONTEXT_TYPE, content, details: { v: 1, hash, accounts: connected.length } };
}

/** Forget the host's last answer (tests). */
export function resetMailRouteCache(): void {
	webMailAnswer = undefined;
}
