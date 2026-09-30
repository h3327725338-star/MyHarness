/**
 * Web API for GitHub Connect: the same account connection the terminal's /settings → GitHub Connect manages
 * (`AccountConnections`, stored in account-connections.json). The browser only ever sees the login and whether
 * something is configured, never a token.
 *
 * Connecting uses GitHub's device flow: the server asks GitHub for a code, the page shows it with the verification
 * link, and the server waits for the authorization in the background. Progress arrives as `github_event` SSE events.
 */

import {
	AccountConnections,
	type ConnectedAccount,
	type GitHubDevicePrompt,
} from "../../providers/credentials/account-connections.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

export function registerAccountRoutes(server: WebHttpServer, connections = new AccountConnections()): void {
	let pending: { controller: AbortController; prompt?: GitHubDevicePrompt } | undefined;

	const status = () => {
		let account: ConnectedAccount | undefined;
		let scopes: string[] = [];
		let clientId = "";
		let error: string | null = null;
		try {
			account = connections.getAccount();
			scopes = connections.getGrantedScopes();
			clientId = connections.getClientId();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		return {
			account: account ?? null,
			/** Older connections were granted fewer scopes; reconnecting grants private repositories too. */
			needsReauthorization: !!account && !scopes.includes("repo"),
			clientIdConfigured: clientId.length > 0,
			clientIdFromEnvironment: !!process.env.MYHARNESS_GITHUB_CLIENT_ID?.trim(),
			pending: pending ? { prompt: pending.prompt ?? null } : null,
			error,
		};
	};

	server.route("GET", "/api/github", () => status());

	server.route("POST", "/api/github/client-id", ({ body }) => {
		const clientId = asObject(body).clientId;
		if (typeof clientId !== "string") throw new HttpError(400, "clientId must be a string");
		try {
			connections.setClientId(clientId);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		return status();
	});

	/** Starts the device flow (or, with `verify`, checks the saved login) and reports the outcome as `github_event`. */
	server.route("POST", "/api/github/connect", ({ body }) => {
		const verify = asObject(body ?? {}).verify === true;
		if (pending) throw new HttpError(409, "A GitHub connection is already waiting for authorization.");
		if (!verify && !connections.getClientId()) throw new HttpError(400, "Set the GitHub Client ID first.");
		const controller = new AbortController();
		const current: { controller: AbortController; prompt?: GitHubDevicePrompt } = { controller };
		pending = current;
		const run = verify
			? connections.verify(controller.signal)
			: connections.connect(controller.signal, (prompt) => {
					if (controller.signal.aborted) return;
					current.prompt = prompt;
					server.broadcast("github_event", { type: "prompt", prompt });
				});
		run.then(
			(account) => {
				if (controller.signal.aborted) return;
				server.broadcast("github_event", { type: "done", verified: verify, account });
			},
			(error: unknown) => {
				if (controller.signal.aborted) return;
				server.broadcast("github_event", {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			},
		).finally(() => {
			if (pending === current) pending = undefined;
		});
		return { ok: true };
	});

	server.route("POST", "/api/github/cancel", () => {
		pending?.controller.abort();
		pending = undefined;
		server.broadcast("github_event", { type: "cancelled" });
		return status();
	});

	server.route("POST", "/api/github/disconnect", async () => {
		try {
			await connections.disconnect();
		} catch (error) {
			throw new HttpError(500, error instanceof Error ? error.message : String(error));
		}
		return status();
	});
}
