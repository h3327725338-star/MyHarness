import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerAccountRoutes } from "../src/modes/web/routes-accounts.ts";
import { AccountConnections } from "../src/providers/credentials/account-connections.ts";
import { InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";

// Settings → Connections → GitHub → Sign in: without an OAuth app of the user's own, the server takes the sign-in this
// computer already has and reports where it came from; the page never sees the token.
describe("GitHub sign-in routes", () => {
	let server: WebHttpServer;
	let port: number;
	let events: Array<{ event: string; data: Record<string, unknown> }>;
	let found: { source: "gh" | "git"; token: string } | undefined;
	let asked: boolean[];

	const call = async (route: string, body?: unknown) => {
		const response = await fetch(`http://127.0.0.1:${port}${route}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { "Content-Type": "application/json", "x-myharness-web": "1" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, body: (await response.json()) as Record<string, any> };
	};
	const settled = async () => {
		await vi.waitFor(() =>
			expect(events.some((entry) => entry.data.type === "done" || entry.data.type === "error")).toBe(true),
		);
		return events.find((entry) => entry.data.type === "done" || entry.data.type === "error")!.data;
	};

	beforeEach(async () => {
		vi.stubEnv("MYHARNESS_GITHUB_CLIENT_ID", "");
		events = [];
		asked = [];
		found = { source: "gh", token: "gho_testtokenneverreturnedbyapi" };
		const request = vi.fn<typeof fetch>(async () =>
			Response.json(
				{ login: "octocat", id: 1 },
				{ headers: { "x-oauth-scopes": "gist, read:org, repo, workflow" } },
			),
		);
		const connections = new AccountConnections(
			new InMemoryAuthStorageBackend(),
			request,
			async (_signal, interactive) => {
				asked.push(interactive);
				return found;
			},
		);
		server = new WebHttpServer();
		server.broadcast = (event: string, data: unknown) => {
			events.push({ event, data: data as Record<string, unknown> });
		};
		registerAccountRoutes(server, connections);
		port = (await server.listen(0)).port;
	});

	afterEach(async () => {
		await server.close();
		vi.unstubAllEnvs();
	});

	it("signs in with the existing sign-in when no OAuth app is set up", async () => {
		const before = await call("/api/github");
		expect(before.body).toMatchObject({ account: null, source: null, clientIdConfigured: false });
		expect((await call("/api/github/connect", {})).status).toBe(200);
		expect(await settled()).toMatchObject({
			type: "done",
			verified: false,
			account: { login: "octocat" },
			source: "gh",
		});
		// The user asked to sign in, so Git may show its own sign-in when nothing was saved.
		expect(asked).toEqual([true]);
		const after = await call("/api/github");
		expect(after.body).toMatchObject({ account: { login: "octocat" }, source: "gh", needsReauthorization: false });
		expect(JSON.stringify(after.body)).not.toContain("gho_");
	});

	it("explains what to do when this computer has no GitHub sign-in", async () => {
		found = undefined;
		expect((await call("/api/github/connect", {})).status).toBe(200);
		const outcome = await settled();
		expect(outcome.type).toBe("error");
		expect(String(outcome.message)).toContain("gh auth login");
		expect((await call("/api/github")).body.account).toBeNull();
	});

	it("rejects an unknown method and the app method without a Client ID", async () => {
		expect((await call("/api/github/connect", { method: "token" })).status).toBe(400);
		expect((await call("/api/github/connect", { method: "app" })).status).toBe(400);
		expect(asked).toEqual([]);
	});
});
