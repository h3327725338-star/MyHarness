/**
 * Web API for Mail Connect: the Gmail and Outlook mailboxes the `mail` tool uses (`MailConnections`, stored in
 * mail-connections.json). The browser only ever sees addresses and whether an OAuth app is configured, never a token
 * or client secret.
 *
 * Connecting uses the OAuth authorization code flow with a loopback redirect: the server listens on 127.0.0.1, sends the
 * sign-in URL to the page as a `mail_event` (`prompt`), the page opens it in the system browser, and the server
 * finishes the sign-in in the background. Progress arrives as `mail_event` SSE events.
 */

import {
	MAIL_PROVIDER_SPECS,
	MAIL_PROVIDERS,
	type MailAccount,
	MailConnections,
	type MailProvider,
} from "../../providers/credentials/mail-connections.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

function providerOf(value: unknown): MailProvider {
	if (typeof value === "string" && MAIL_PROVIDERS.includes(value as MailProvider)) return value as MailProvider;
	throw new HttpError(400, `provider must be one of ${MAIL_PROVIDERS.join(", ")}`);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerMailRoutes(server: WebHttpServer, connections = new MailConnections()): void {
	let pending: { controller: AbortController; provider: MailProvider; url?: string } | undefined;

	const status = () => {
		let accounts: MailAccount[] = [];
		let error: string | null = null;
		const providers = {} as Record<MailProvider, unknown>;
		try {
			accounts = connections.listAccounts();
			for (const provider of MAIL_PROVIDERS)
				providers[provider] = {
					label: MAIL_PROVIDER_SPECS[provider].label,
					redirectHost: MAIL_PROVIDER_SPECS[provider].redirectHost,
					...connections.getAppStatus(provider),
				};
		} catch (cause) {
			error = message(cause);
		}
		return {
			accounts,
			providers,
			pending: pending ? { provider: pending.provider, url: pending.url ?? null } : null,
			error,
		};
	};

	server.route("GET", "/api/mail", () => status());

	server.route("POST", "/api/mail/app", ({ body }) => {
		const input = asObject(body);
		const provider = providerOf(input.provider);
		if (typeof input.clientId !== "string") throw new HttpError(400, "clientId must be a string");
		if (input.clientSecret !== undefined && typeof input.clientSecret !== "string")
			throw new HttpError(400, "clientSecret must be a string");
		try {
			connections.setApp(provider, input.clientId, input.clientSecret as string | undefined);
		} catch (error) {
			throw new HttpError(400, message(error));
		}
		return status();
	});

	/** Starts a sign-in for one provider and reports the outcome as `mail_event`. */
	server.route("POST", "/api/mail/connect", ({ body }) => {
		const provider = providerOf(asObject(body).provider);
		if (pending) throw new HttpError(409, "A mailbox sign-in is already waiting for authorization.");
		if (!connections.getAppStatus(provider).configured)
			throw new HttpError(400, `Set the ${MAIL_PROVIDER_SPECS[provider].label} OAuth client first.`);
		const controller = new AbortController();
		const current: { controller: AbortController; provider: MailProvider; url?: string } = { controller, provider };
		pending = current;
		connections
			.connect(provider, controller.signal, (url) => {
				if (controller.signal.aborted) return;
				current.url = url;
				server.broadcast("mail_event", { type: "prompt", provider, url });
			})
			.then(
				(account) => {
					if (controller.signal.aborted) return;
					server.broadcast("mail_event", { type: "done", verified: false, account });
				},
				(error: unknown) => {
					if (controller.signal.aborted) return;
					server.broadcast("mail_event", { type: "error", message: message(error) });
				},
			)
			.finally(() => {
				if (pending === current) pending = undefined;
			});
		return { ok: true };
	});

	/** Checks one saved mailbox (refreshing its login when needed); the answer is the response itself. */
	server.route("POST", "/api/mail/verify", async ({ body }) => {
		const account = asObject(body).account;
		if (typeof account !== "string") throw new HttpError(400, "account must be a string");
		try {
			return { account: await connections.verify(account, AbortSignal.timeout(60000)) };
		} catch (error) {
			throw new HttpError(400, message(error));
		}
	});

	server.route("POST", "/api/mail/cancel", () => {
		pending?.controller.abort();
		pending = undefined;
		server.broadcast("mail_event", { type: "cancelled" });
		return status();
	});

	server.route("POST", "/api/mail/disconnect", async ({ body }) => {
		const account = asObject(body).account;
		if (typeof account !== "string") throw new HttpError(400, "account must be a string");
		try {
			await connections.disconnect(account);
		} catch (error) {
			throw new HttpError(400, message(error));
		}
		return status();
	});
}
