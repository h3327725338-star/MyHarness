import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restrictToolNamesForRole } from "../src/agent/runtime/role.ts";
import { InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";
import { MailConnections, type MailProvider } from "../src/providers/credentials/mail-connections.ts";
import { encodeHeaderWord } from "../src/tools/mail/message.ts";
import { createMailToolDefinition } from "../src/tools/mail/tool.ts";
import { allToolNames, createToolDefinition } from "../src/tools/registry.ts";

const tempRoot = process.env.MYHARNESS_TEMP_DIR ?? tmpdir();
let dir: string;

beforeEach(() => {
	for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CHINA_CLIENT_ID"])
		vi.stubEnv(`MYHARNESS_${name}`, "");
	dir = mkdtempSync(join(tempRoot, "mail-test-"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function service(responses: Response[] = [], saved?: Record<string, unknown>) {
	const storage = new InMemoryAuthStorageBackend();
	if (saved) storage.withLock(() => ({ result: undefined, next: JSON.stringify(saved) }));
	const request = vi.fn<typeof fetch>();
	for (const response of responses) request.mockResolvedValueOnce(response);
	const connections = new MailConnections(storage, request);
	const data = () => JSON.parse(storage.withLock((text) => ({ result: text ?? "{}" })));
	return { storage, request, connections, data };
}

const account = (provider: MailProvider, email: string, extra: Record<string, unknown> = {}) => ({
	provider,
	email,
	clientId: `${provider}-app`,
	token: `${provider}-secret-access`,
	refreshToken: `${provider}-secret-refresh`,
	...extra,
});

/** Plays the browser: waits for the sign-in URL, then follows the redirect back to the loopback listener. */
async function signIn(
	connections: MailConnections,
	provider: MailProvider,
	reply: (authorize: URL) => Record<string, string>,
) {
	let resolveUrl: (url: URL) => void = () => {};
	const prompted = new Promise<URL>((resolve) => {
		resolveUrl = resolve;
	});
	const result = connections.connect(provider, new AbortController().signal, (url) => resolveUrl(new URL(url)));
	const authorize = await prompted;
	const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
	// Node's fetch resolves localhost itself; the listener answers on 127.0.0.1 either way.
	redirect.hostname = "127.0.0.1";
	redirect.search = new URLSearchParams(reply(authorize)).toString();
	const page = await fetch(redirect);
	return { authorize, result, page };
}

describe("mail sign-in", () => {
	it("connects a Gmail or Google Workspace mailbox with PKCE, a 127.0.0.1 redirect and the client secret", async () => {
		const { connections, request, data } = service([
			Response.json({
				access_token: "g-access",
				refresh_token: "g-refresh",
				expires_in: 3599,
				scope: "https://mail.google.com/",
			}),
			Response.json({ emailAddress: "someone@example.com", messagesTotal: 3 }),
		]);
		connections.setApp("google", "google-app.apps.googleusercontent.com", "GOCSPX-test-secret");
		const { authorize, result, page } = await signIn(connections, "google", (url) => ({
			code: "auth-code",
			state: url.searchParams.get("state")!,
		}));
		expect(page.status).toBe(200);
		expect(await result).toEqual({ provider: "google", email: "someone@example.com" });
		expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(authorize.searchParams.get("scope")).toBe("https://mail.google.com/");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		const exchange = Object.fromEntries(request.mock.calls[0][1]?.body as URLSearchParams);
		expect(request.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
		expect(exchange).toMatchObject({
			client_id: "google-app.apps.googleusercontent.com",
			client_secret: "GOCSPX-test-secret",
			grant_type: "authorization_code",
			code: "auth-code",
			redirect_uri: authorize.searchParams.get("redirect_uri"),
		});
		expect(createHash("sha256").update(exchange.code_verifier).digest("base64url")).toBe(
			authorize.searchParams.get("code_challenge"),
		);
		expect(request.mock.calls[1][0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
		expect(data().accounts).toEqual([
			expect.objectContaining({ provider: "google", email: "someone@example.com", refreshToken: "g-refresh" }),
		]);
		expect(connections.listAccounts()).toEqual([{ provider: "google", email: "someone@example.com" }]);
	});

	it("connects personal and work Outlook mailboxes through /common with a localhost redirect", async () => {
		const { connections, request } = service([
			Response.json({ access_token: "m-access", refresh_token: "m-refresh", expires_in: 3600 }),
			// Personal Microsoft accounts often have no `mail`; the sign-in name is the address.
			Response.json({ displayName: "Someone", mail: null, userPrincipalName: "someone@example.com" }),
		]);
		connections.setApp("microsoft", "00000000-0000-0000-0000-000000000001");
		const { authorize, result } = await signIn(connections, "microsoft", (url) => ({
			code: "auth-code",
			state: url.searchParams.get("state")!,
		}));
		expect(await result).toEqual({ provider: "microsoft", email: "someone@example.com", name: "Someone" });
		expect(authorize.origin + authorize.pathname).toBe(
			"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		);
		expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/$/);
		expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(
			expect.arrayContaining(["offline_access", "Mail.ReadWrite", "Mail.Send"]),
		);
		const exchange = Object.fromEntries(request.mock.calls[0][1]?.body as URLSearchParams);
		expect(exchange.client_secret).toBeUndefined();
		expect(exchange.scope).toContain("Mail.ReadWrite");
		expect(String(request.mock.calls[1][0])).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\?/);
	});

	it("uses the 21Vianet endpoints with Graph scopes qualified by the China resource", async () => {
		const { connections, request } = service([
			Response.json({ access_token: "c-access", refresh_token: "c-refresh", expires_in: 3600 }),
			Response.json({ mail: "someone@contoso.partner.onmschina.cn" }),
		]);
		connections.setApp("microsoft-china", "00000000-0000-0000-0000-000000000002");
		const { authorize, result } = await signIn(connections, "microsoft-china", (url) => ({
			code: "c",
			state: url.searchParams.get("state")!,
		}));
		await result;
		expect(authorize.host).toBe("login.chinacloudapi.cn");
		expect(authorize.searchParams.get("scope")).toContain("https://microsoftgraph.chinacloudapi.cn/Mail.ReadWrite");
		expect(String(request.mock.calls[1][0])).toMatch(/^https:\/\/microsoftgraph\.chinacloudapi\.cn\/v1\.0\/me/);
	});

	it("ignores callbacks with another state and reports a refusal", async () => {
		const { connections, request } = service();
		connections.setApp("microsoft", "app");
		let resolveUrl: (url: URL) => void = () => {};
		const prompted = new Promise<URL>((resolve) => {
			resolveUrl = resolve;
		});
		const result = connections.connect("microsoft", new AbortController().signal, (url) => resolveUrl(new URL(url)));
		const rejected = expect(result).rejects.toThrow("拒绝");
		const authorize = await prompted;
		const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
		redirect.hostname = "127.0.0.1";
		expect((await fetch(`${redirect.origin}/?code=forged&state=wrong`)).status).toBe(404);
		await fetch(`${redirect.origin}/?error=access_denied&state=${authorize.searchParams.get("state")}`);
		await rejected;
		expect(request).not.toHaveBeenCalled();
	});

	it("stops listening when cancelled and requires the provider's app first", async () => {
		const { connections } = service();
		await expect(connections.connect("google", new AbortController().signal, () => {})).rejects.toThrow("Client ID");
		expect(() => connections.setApp("google", "id-only")).toThrow("Client Secret");
		connections.setApp("microsoft", "app");
		const controller = new AbortController();
		let redirect = "";
		const result = connections.connect("microsoft", controller.signal, (url) => {
			redirect = new URL(url).searchParams.get("redirect_uri")!;
			controller.abort();
		});
		await expect(result).rejects.toThrow();
		const port = new URL(redirect).port;
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	});
});

describe("mail API access", () => {
	it("refreshes an expiring Google login, keeps its refresh token and decodes text parts", async () => {
		const encoded = Buffer.from("你好，世界", "utf8").toString("base64url");
		const { connections, request, data } = service(
			[
				Response.json({ access_token: "g-new", expires_in: 3599 }),
				Response.json({
					id: "m1",
					payload: {
						mimeType: "multipart/alternative",
						parts: [{ mimeType: "text/plain", body: { size: 15, data: encoded } }],
					},
				}),
			],
			{ accounts: [account("google", "a@gmail.com", { clientSecret: "secret-x", expiresAt: Date.now() - 1 })] },
		);
		const result = await connections.api(
			undefined,
			"/gmail/v1/users/me/messages/m1?format=full",
			"GET",
			undefined,
			new AbortController().signal,
		);
		expect(JSON.stringify(result.data)).toContain("你好，世界");
		expect(JSON.stringify(result.data)).not.toContain(encoded);
		expect(Object.fromEntries(request.mock.calls[0][1]?.body as URLSearchParams)).toMatchObject({
			grant_type: "refresh_token",
			refresh_token: "google-secret-refresh",
			client_secret: "secret-x",
		});
		expect(request.mock.calls[1][1]?.headers).toHaveProperty("Authorization", "Bearer g-new");
		expect(data().accounts[0]).toMatchObject({ token: "g-new", refreshToken: "google-secret-refresh" });
	});

	it("stores Microsoft's rotated refresh token, asks Graph for text bodies and returns next as a path", async () => {
		const { connections, request, data } = service(
			[
				Response.json({ access_token: "m-new", refresh_token: "m-rotated", expires_in: 3600 }),
				Response.json({
					value: [{ subject: "Hi" }],
					"@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc",
				}),
			],
			{ accounts: [account("microsoft", "w@contoso.com", { expiresAt: Date.now() + 1000 })] },
		);
		const result = await connections.api(
			"W@contoso.com",
			"/v1.0/me/messages?$top=1",
			"GET",
			undefined,
			new AbortController().signal,
		);
		expect(result.next).toBe("/v1.0/me/messages?$skiptoken=abc");
		expect(request.mock.calls[1][1]?.headers).toHaveProperty("Prefer", 'outlook.body-content-type="text"');
		expect(data().accounts[0]).toMatchObject({ token: "m-new", refreshToken: "m-rotated" });
	});

	it("asks to reauthorize on invalid_grant and never retries or leaks credentials", async () => {
		const { connections, request } = service(
			[
				Response.json(
					{ error: "invalid_grant", error_description: "Token has been expired or revoked." },
					{ status: 400 },
				),
			],
			{ accounts: [account("google", "a@gmail.com", { expiresAt: Date.now() - 1 })] },
		);
		await expect(
			connections.api(undefined, "/gmail/v1/users/me/labels", "GET", undefined, new AbortController().signal),
		).rejects.toThrow("重新授权");
		expect(request).toHaveBeenCalledTimes(1);

		const second = service(
			[
				new Response(JSON.stringify({ error: { code: 403, message: "echo microsoft-secret-access" } }), {
					status: 403,
				}),
			],
			{
				accounts: [account("microsoft", "w@contoso.com")],
			},
		);
		const failure = second.connections.api(
			undefined,
			"/v1.0/me/sendMail",
			"POST",
			{ message: {} },
			new AbortController().signal,
		);
		await expect(failure).rejects.toThrow("HTTP 403");
		await expect(failure).rejects.not.toThrow("microsoft-secret-access");
		expect(second.request).toHaveBeenCalledTimes(1);
	});

	it.each(["https://example.com/x", "//example.com/x", "/\\example.com", "/v1.0/me#frag"])(
		"rejects external or ambiguous paths: %s",
		async (path) => {
			const { connections, request } = service([], { accounts: [account("microsoft", "w@contoso.com")] });
			await expect(
				connections.api(undefined, path, "GET", undefined, new AbortController().signal),
			).rejects.toThrow();
			expect(request).not.toHaveBeenCalled();
		},
	);

	it("needs an account when several mailboxes are connected and disconnects only the chosen one", async () => {
		const { connections, data } = service([], {
			accounts: [account("google", "a@gmail.com"), account("microsoft", "b@outlook.com")],
		});
		await expect(connections.api(undefined, "/x", "GET", undefined, new AbortController().signal)).rejects.toThrow(
			"多个邮箱",
		);
		await expect(
			connections.api("c@example.com", "/x", "GET", undefined, new AbortController().signal),
		).rejects.toThrow("没有连接邮箱");
		await connections.disconnect("microsoft:b@outlook.com");
		expect(data().accounts.map((saved: { email: string }) => saved.email)).toEqual(["a@gmail.com"]);
	});

	it("refuses to overwrite a damaged connection file", () => {
		const { connections, storage } = service();
		storage.withLock(() => ({ result: undefined, next: "{not json" }));
		expect(() => connections.listAccounts()).toThrow("mail-connections.json");
		expect(() => connections.setApp("microsoft", "app")).toThrow("mail-connections.json");
	});
});

describe("mail tool", () => {
	const run = (connections: MailConnections, args: Record<string, unknown>) =>
		createMailToolDefinition(dir, { connections }).execute(
			"call",
			args as never,
			new AbortController().signal,
			undefined,
			{} as never,
		);

	it("composes a Gmail message with a Chinese subject and an attachment into raw", async () => {
		writeFileSync(join(dir, "报告.txt"), "attachment body");
		const { connections, request } = service([Response.json({ id: "sent", threadId: "t" })], {
			accounts: [account("google", "a@gmail.com")],
		});
		await run(connections, {
			path: "/gmail/v1/users/me/messages/send",
			method: "POST",
			body: { threadId: "t" },
			message: { to: ["张三 <z@example.com>"], subject: "周报：第 42 周", text: "正文", attachments: ["报告.txt"] },
		});
		const sent = JSON.parse(String(request.mock.calls[0][1]?.body));
		expect(sent.threadId).toBe("t");
		const mime = Buffer.from(sent.raw, "base64url").toString("utf8");
		expect(mime).toContain(`To: ${encodeHeaderWord("张三")} <z@example.com>`);
		expect(mime).toContain(`Subject: ${encodeHeaderWord("周报：第 42 周")}`);
		expect(mime).toContain(Buffer.from("正文").toString("base64"));
		expect(mime).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt");
		expect(mime).toContain(Buffer.from("attachment body").toString("base64"));
		expect(mime).toMatch(/^MIME-Version: 1\.0\r\n/);
	});

	it("puts a Gmail draft's raw under message and rejects header injection", async () => {
		const { connections, request } = service([Response.json({ id: "d" })], {
			accounts: [account("google", "a@gmail.com")],
		});
		await run(connections, {
			path: "/gmail/v1/users/me/drafts",
			method: "POST",
			message: { to: ["a@b.co"], subject: "x" },
		});
		expect(JSON.parse(String(request.mock.calls[0][1]?.body)).message.raw).toBeTypeOf("string");
		await expect(
			run(connections, {
				path: "/gmail/v1/users/me/messages/send",
				method: "POST",
				message: { subject: "a\r\nBcc: x@y.z" },
			}),
		).rejects.toThrow("换行");
	});

	it("turns the message into a Graph message for sendMail with inline attachments", async () => {
		mkdirSync(join(dir, "docs"));
		writeFileSync(join(dir, "docs", "a.pdf"), Buffer.from([1, 2, 3]));
		const { connections, request } = service([new Response(null, { status: 202 })], {
			accounts: [account("microsoft", "w@contoso.com")],
		});
		const result = await run(connections, {
			account: "w@contoso.com",
			path: "/v1.0/me/sendMail",
			method: "POST",
			body: { saveToSentItems: true },
			message: {
				to: ["Ann <ann@example.com>"],
				cc: ["bob@example.com"],
				subject: "S",
				html: "<p>Hi</p>",
				attachments: ["docs/a.pdf"],
			},
		});
		expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
			saveToSentItems: true,
			message: {
				subject: "S",
				body: { contentType: "HTML", content: "<p>Hi</p>" },
				toRecipients: [{ emailAddress: { address: "ann@example.com", name: "Ann" } }],
				ccRecipients: [{ emailAddress: { address: "bob@example.com" } }],
				attachments: [
					{
						"@odata.type": "#microsoft.graph.fileAttachment",
						name: "a.pdf",
						contentType: "application/pdf",
						contentBytes: "AQID",
					},
				],
			},
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"data": null') });
	});

	it("saves an attachment response to a file instead of returning base64", async () => {
		const { connections } = service([Response.json({ size: 5, data: Buffer.from("hello").toString("base64url") })], {
			accounts: [account("google", "a@gmail.com")],
		});
		const result = await run(connections, {
			path: "/gmail/v1/users/me/messages/m/attachments/x",
			saveAttachmentTo: "out/hello.txt",
		});
		expect(readFileSync(join(dir, "out", "hello.txt"), "utf8")).toBe("hello");
		expect(JSON.stringify(result)).toContain("savedBytes");
		expect(JSON.stringify(result)).not.toContain(Buffer.from("hello").toString("base64url"));
	});

	it("is registered as a built-in and stays outside delegated read-only sessions", () => {
		const { connections } = service();
		expect(allToolNames.has("mail")).toBe(true);
		expect(createToolDefinition("mail", ".", { mail: { connections } }).name).toBe("mail");
		expect(restrictToolNamesForRole("delegated", ["read", "mail"])).toEqual(["read"]);
	});
});
