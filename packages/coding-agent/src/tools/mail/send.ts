/**
 * One email sent, for the `mail` tool (a message without an API path) and for scheduled emails (schedules/): through the
 * mailbox connected to the mail tool by its API when there is one (Gmail API messages/send, Microsoft Graph sendMail),
 * else through the Gmail or Outlook website the user is signed in to in the built-in browser (the desktop host's
 * `webMailSend`, packages/desktop/browser-web-mail-send.cjs: the website's compose page opens already filled in and its
 * Send button is pressed). Either way no model works a compose form, so the email leaves within seconds. An Agent that
 * filled Gmail's form itself took minutes for one email.
 */
import type { MailAccount, MailConnections } from "../../providers/credentials/mail-connections.ts";
import type { DesktopWorkspaceChannel } from "../workspace.ts";
import { applyMessage, type MailMessageInput } from "./message.ts";

export interface OutgoingMail extends MailMessageInput {
	to: string[];
	/** The mailbox to send from: its address, or provider:address for an API mailbox connected twice. */
	account?: string;
}

export interface MailSent {
	via: "api" | "web";
	provider: "google" | "microsoft";
	/** The address it was sent from, when known. */
	account?: string;
	ms: number;
}

export interface SendMailOptions {
	connections: Pick<MailConnections, "listAccounts" | "api">;
	/** The desktop host; without one there is no built-in browser to send through. */
	channel?: Pick<DesktopWorkspaceChannel, "request">;
	cwd: string;
	signal?: AbortSignal;
	now?: () => number;
}

const SEND_PATH = { google: "/gmail/v1/users/me/messages/send", microsoft: "/v1.0/me/sendMail" } as const;
const WEB_SEND_TIMEOUT_MS = 60_000;

const label = (provider: MailAccount["provider"]) => (provider === "google" ? "Gmail" : "Outlook");

/** The API mailbox to send from, undefined when none fits (then the website is used), or an error when it is unclear. */
function apiAccount(accounts: readonly MailAccount[], wanted: string | undefined): MailAccount | undefined {
	if (!accounts.length) return undefined;
	const key = wanted?.trim().toLowerCase();
	if (key) {
		const bare = /<([^>]+)>/u.exec(key)?.[1]?.trim() ?? key;
		return accounts.find(
			(account) =>
				account.email.toLowerCase() === bare || `${account.provider}:${account.email.toLowerCase()}` === bare,
		);
	}
	if (accounts.length === 1) return accounts[0];
	throw new Error(
		`有 ${accounts.length} 个已连接的邮箱（${accounts.map((account) => account.email).join("、")}），请用 account 指定从哪个发出。`,
	);
}

/** Send `mail` and say which way it went. Throws with the reason when it was not sent. */
export async function sendMail(mail: OutgoingMail, options: SendMailOptions): Promise<MailSent> {
	const now = options.now ?? Date.now;
	const started = now();
	const to = (mail.to ?? []).map((address) => address.trim()).filter(Boolean);
	if (!to.length) throw new Error("邮件没有收件人（message.to）。");
	let accounts: MailAccount[] = [];
	try {
		accounts = options.connections.listAccounts();
	} catch {
		accounts = [];
	}
	const account = apiAccount(accounts, mail.account);
	if (account) {
		const path = SEND_PATH[account.provider];
		const body = await applyMessage(account.provider, path, undefined, { ...mail, to }, options.cwd);
		await options.connections.api(
			`${account.provider}:${account.email}`,
			path,
			"POST",
			body,
			options.signal ?? new AbortController().signal,
		);
		return { via: "api", provider: account.provider, account: account.email, ms: now() - started };
	}
	if (!options.channel)
		throw new Error(
			"没有可以发信的邮箱：设置 → 连接 里没有连接邮箱 API，这里也没有内置浏览器可用（需要 MyHarness 桌面版）。",
		);
	if (mail.attachments?.length || mail.html)
		throw new Error(
			"通过 Gmail/Outlook 网页发信只支持纯文本，不能带附件或 HTML；请在 设置 → 连接 里连接邮箱 API 后再发。",
		);
	if (!mail.subject?.trim()) throw new Error("通过 Gmail/Outlook 网页发信需要主题（message.subject）。");
	const value = (await options.channel.request(
		{
			action: "webMailSend",
			to,
			cc: mail.cc ?? [],
			bcc: mail.bcc ?? [],
			subject: mail.subject,
			text: mail.text ?? "",
			...(mail.account ? { account: mail.account } : {}),
			timeoutMs: WEB_SEND_TIMEOUT_MS,
		},
		WEB_SEND_TIMEOUT_MS + 15_000,
	)) as { ok?: boolean; provider?: string; account?: string } | null;
	const provider = value?.provider === "microsoft" ? "microsoft" : "google";
	if (!value?.ok) throw new Error(`${label(provider)} 网页没有确认发出这封邮件。`);
	return {
		via: "web",
		provider,
		...(value.account ? { account: value.account } : {}),
		ms: now() - started,
	};
}

/** One line on how an email went, for the tool's result and a scheduled task's card. */
export function describeMailSent(sent: MailSent, to: readonly string[]): string {
	const how =
		sent.via === "api"
			? `${label(sent.provider)} API${sent.account ? ` (${sent.account})` : ""}`
			: `${label(sent.provider)} website in the built-in browser${sent.account ? ` (${sent.account})` : ""}`;
	return `sent to ${to.join(", ")} through the ${how} in ${(sent.ms / 1000).toFixed(1)} s`;
}
