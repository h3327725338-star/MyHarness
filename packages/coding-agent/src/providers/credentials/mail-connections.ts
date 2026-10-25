import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

/**
 * Mailbox connections (Gmail and Outlook). Like GitHub Connect these are website credentials, kept apart from model
 * provider authentication, in their own file (mail-connections.json).
 *
 * Both providers use the OAuth authorization code flow with PKCE and a loopback redirect: Google does not allow Gmail
 * scopes in its device flow, and many Microsoft 365 tenants block the device code flow by Conditional Access.
 * - google: every Gmail mailbox, @gmail.com/@googlemail.com and Google Workspace domains.
 * - microsoft: the /common endpoint, so personal Microsoft accounts (outlook.com, hotmail.com, live.com, msn.com …)
 *   and work or school Microsoft 365 / Exchange Online mailboxes of any tenant.
 */
export type MailProvider = "google" | "microsoft";
export const MAIL_PROVIDERS: readonly MailProvider[] = ["google", "microsoft"];

interface ProviderSpec {
	label: string;
	authorizeUrl: string;
	tokenUrl: string;
	apiOrigin: string;
	scopes: readonly string[];
	/** Host of the redirect URI the app registration must allow (port is chosen per sign-in). */
	redirectHost: "127.0.0.1" | "localhost";
	clientIdEnv: string;
	clientSecretEnv?: string;
	extraAuthorizeParams: Record<string, string>;
}

const MICROSOFT_GRAPH_SCOPES = ["User.Read", "Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"];
const OIDC_SCOPES = ["offline_access", "openid", "profile", "email"];

export const MAIL_PROVIDER_SPECS: Record<MailProvider, ProviderSpec> = {
	google: {
		label: "Gmail",
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		apiOrigin: "https://gmail.googleapis.com",
		// Full mailbox access (read, label, send, delete), the scope IMAP clients use; Google shows it on its consent page.
		scopes: ["https://mail.google.com/"],
		redirectHost: "127.0.0.1",
		clientIdEnv: "MYHARNESS_GOOGLE_CLIENT_ID",
		clientSecretEnv: "MYHARNESS_GOOGLE_CLIENT_SECRET",
		extraAuthorizeParams: { access_type: "offline", prompt: "consent select_account" },
	},
	microsoft: {
		label: "Outlook",
		authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		apiOrigin: "https://graph.microsoft.com",
		scopes: [...OIDC_SCOPES, ...MICROSOFT_GRAPH_SCOPES],
		redirectHost: "localhost",
		clientIdEnv: "MYHARNESS_MICROSOFT_CLIENT_ID",
		extraAuthorizeParams: { prompt: "select_account" },
	},
};

export interface MailAccount {
	provider: MailProvider;
	email: string;
	name?: string;
}
interface MailAppConfig {
	clientId: string;
	clientSecret?: string;
}
interface MailConnection extends MailAccount {
	clientId: string;
	clientSecret?: string;
	token: string;
	expiresAt?: number;
	refreshToken?: string;
	scopes?: string[];
}
interface MailData {
	apps?: Partial<Record<MailProvider, MailAppConfig>>;
	accounts?: MailConnection[];
}
export interface MailAppStatus {
	configured: boolean;
	clientSecretSet: boolean;
	fromEnvironment: boolean;
}
export interface MailApiResult {
	account: MailAccount;
	data: unknown;
	next?: string;
}

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const isProvider = (value: unknown): value is MailProvider => MAIL_PROVIDERS.includes(value as MailProvider);
const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";
const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text);
const accountKey = (account: MailAccount) => `${account.provider}:${account.email.toLowerCase()}`;
const publicAccount = ({ provider, email, name }: MailAccount): MailAccount => ({
	provider,
	email,
	...(name ? { name } : {}),
});

/** An OAuth error reply as one readable line; Microsoft's AADSTS descriptions name the real cause (consent, redirect …). */
function oauthError(response: Record<string, unknown>): string {
	const description =
		typeof response.error_description === "string" ? response.error_description.split(/\r?\n/)[0] : "";
	return clip([response.error, description].filter(Boolean).join(": "), 400);
}

const resultPage = (title: string, text: string) =>
	`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6"><h2>${title}</h2><p>${text}</p></body></html>`;

/**
 * Waits on a loopback HTTP listener for the browser to come back from the sign-in page with `?code=…&state=…`.
 * Listens on 127.0.0.1 and, for a `localhost` redirect, also on [::1] with the same port, because a browser may resolve
 * localhost to either. A request whose state does not match is answered and otherwise ignored.
 */
async function loopbackAuthorization(
	host: "127.0.0.1" | "localhost",
	state: string,
	signal: AbortSignal,
	onReady: (redirectUri: string) => void,
): Promise<{ code: string; redirectUri: string }> {
	const servers: Server[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
			let redirectUri = "";
			const handler = (
				request: import("node:http").IncomingMessage,
				response: import("node:http").ServerResponse,
			) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				const send = (status: number, title: string, text: string) => {
					response.writeHead(status, {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-store",
						Connection: "close",
					});
					response.end(resultPage(title, text));
				};
				if (request.method !== "GET" || url.pathname !== "/" || url.searchParams.get("state") !== state) {
					send(404, "MyHarness", "这不是当前的邮箱授权请求。");
					return;
				}
				const error = url.searchParams.get("error");
				if (error) {
					send(400, "授权未完成", "邮箱授权被拒绝或失败，可以关闭此页面，回到 MyHarness 重试。");
					reject(
						new Error(
							error === "access_denied"
								? "你已取消或拒绝邮箱授权，可以重新连接。"
								: `邮箱授权失败：${oauthError({ error, error_description: url.searchParams.get("error_description") ?? "" })}`,
						),
					);
					return;
				}
				const code = url.searchParams.get("code");
				if (!code) {
					send(400, "授权未完成", "授权回调缺少授权码，请回到 MyHarness 重试。");
					return;
				}
				send(200, "授权已收到", "可以关闭此页面，回到 MyHarness。");
				resolve({ code, redirectUri });
			};
			const listen = (server: Server, address: string, port: number) =>
				new Promise<number>((done, fail) => {
					server.once("error", fail);
					server.listen(port, address, () => {
						server.off("error", fail);
						const info = server.address();
						done(typeof info === "object" && info ? info.port : port);
					});
				});
			timer = setTimeout(() => reject(new Error("等待邮箱授权超时（10 分钟），请重新连接。")), SIGN_IN_TIMEOUT_MS);
			timer.unref?.();
			onAbort = () => reject(signal.reason ?? new Error("已取消邮箱授权。"));
			if (signal.aborted) onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			(async () => {
				const primary = createServer(handler);
				servers.push(primary);
				const port = await listen(primary, "127.0.0.1", 0);
				if (host === "localhost") {
					const secondary = createServer(handler);
					servers.push(secondary);
					// IPv6 may be switched off on this machine; 127.0.0.1 still serves the redirect then.
					await listen(secondary, "::1", port).catch(() => secondary.close());
				}
				redirectUri = `http://${host}:${port}/`;
				if (!signal.aborted) onReady(redirectUri);
			})().catch(() => reject(new Error("无法在本机启动邮箱授权回调监听，请重试。")));
		});
	} finally {
		clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
		for (const server of servers) server.close();
	}
}

/** Gmail and Outlook mailbox connections used by the `mail` tool and the Web UI's Mail Connect page. */
export class MailConnections {
	private readonly storage: AuthStorageBackend;
	private readonly request: typeof fetch;

	constructor(
		storage: AuthStorageBackend = new FileAuthStorageBackend(join(getAgentDir(), "mail-connections.json")),
		request: typeof fetch = fetch,
	) {
		this.storage = storage;
		this.request = request;
	}

	private parse(text: string | undefined): MailData {
		try {
			const data = JSON.parse(text ?? "{}");
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
			if (data.apps !== undefined) {
				if (!data.apps || typeof data.apps !== "object" || Array.isArray(data.apps)) throw new Error();
				for (const [provider, app] of Object.entries(data.apps as Record<string, MailAppConfig>)) {
					if (!isProvider(provider) || typeof app?.clientId !== "string" || !isOptionalString(app.clientSecret))
						throw new Error();
				}
			}
			if (data.accounts !== undefined) {
				if (!Array.isArray(data.accounts)) throw new Error();
				for (const account of data.accounts as MailConnection[]) {
					if (
						!account ||
						!isProvider(account.provider) ||
						typeof account.email !== "string" ||
						typeof account.token !== "string" ||
						typeof account.clientId !== "string" ||
						![account.name, account.clientSecret, account.refreshToken].every(isOptionalString) ||
						(account.expiresAt !== undefined &&
							(typeof account.expiresAt !== "number" || !Number.isFinite(account.expiresAt))) ||
						(account.scopes !== undefined &&
							(!Array.isArray(account.scopes) || account.scopes.some((scope) => typeof scope !== "string")))
					)
						throw new Error();
				}
			}
			return data;
		} catch {
			throw new Error("邮箱连接文件格式无效，请检查本机 mail-connections.json；未覆盖现有数据。");
		}
	}

	private read(): MailData {
		return this.storage.withLock((text) => ({ result: this.parse(text) }));
	}

	private app(provider: MailProvider): MailAppConfig | undefined {
		const spec = MAIL_PROVIDER_SPECS[provider];
		const envId = process.env[spec.clientIdEnv]?.trim();
		if (envId) {
			const envSecret = spec.clientSecretEnv ? process.env[spec.clientSecretEnv]?.trim() : undefined;
			return { clientId: envId, ...(envSecret ? { clientSecret: envSecret } : {}) };
		}
		const saved = this.read().apps?.[provider];
		return saved?.clientId ? saved : undefined;
	}

	getAppStatus(provider: MailProvider): MailAppStatus {
		const app = this.app(provider);
		return {
			configured: !!app,
			clientSecretSet: !!app?.clientSecret,
			fromEnvironment: !!process.env[MAIL_PROVIDER_SPECS[provider].clientIdEnv]?.trim(),
		};
	}

	/** Saves the user's own OAuth app. Google desktop clients also need their (non-confidential) client secret. */
	setApp(provider: MailProvider, clientIdValue: string, clientSecretValue?: string): void {
		if (!isProvider(provider)) throw new Error("未知的邮箱类型。");
		const clientId = clientIdValue.trim();
		const clientSecret = clientSecretValue?.trim() || undefined;
		if (!/^[a-zA-Z0-9._-]{1,200}$/.test(clientId))
			throw new Error(`请输入有效的 ${MAIL_PROVIDER_SPECS[provider].label} OAuth Client ID。`);
		if (clientSecret !== undefined && !/^[\x21-\x7e]{1,200}$/.test(clientSecret))
			throw new Error("Client Secret 含有无效字符。");
		if (provider === "google" && !clientSecret)
			throw new Error("Google 桌面应用客户端在换取令牌时需要 Client Secret，请一并填写。");
		this.storage.withLock((text) => {
			const data = this.parse(text);
			return {
				result: undefined,
				next: JSON.stringify({
					...data,
					apps: { ...data.apps, [provider]: { clientId, ...(clientSecret ? { clientSecret } : {}) } },
				}),
			};
		});
	}

	listAccounts(): MailAccount[] {
		return (this.read().accounts ?? []).map(publicAccount);
	}

	/** Finds one connected mailbox by address (optionally `provider:address`); with no reference, the only one. */
	private pick(accounts: MailConnection[], reference: string | undefined): MailConnection {
		if (!accounts.length) throw new Error("尚未连接邮箱，请在 /settings → Mail Connect 中连接 Gmail 或 Outlook。");
		const wanted = reference?.trim().toLowerCase();
		if (!wanted) {
			if (accounts.length === 1) return accounts[0];
			throw new Error(
				`已连接多个邮箱，请用 account 指明其中一个：${accounts.map((account) => account.email).join("、")}`,
			);
		}
		const matches = accounts.filter(
			(account) => account.email.toLowerCase() === wanted || accountKey(account) === wanted,
		);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1)
			throw new Error(`${reference} 同时连接在多个服务上，请写成 provider:地址，例如 ${accountKey(matches[0])}。`);
		throw new Error(
			`没有连接邮箱 ${reference}。已连接：${accounts.map((account) => account.email).join("、") || "无"}。`,
		);
	}

	async disconnect(reference: string): Promise<void> {
		await this.storage.withLockAsync(async (text) => {
			const data = this.parse(text);
			const target = this.pick(data.accounts ?? [], reference);
			return {
				result: undefined,
				next: JSON.stringify({
					...data,
					accounts: (data.accounts ?? []).filter((account) => accountKey(account) !== accountKey(target)),
				}),
			};
		});
	}

	private async send(url: string, init: RequestInit, signal: AbortSignal, what: string): Promise<Response> {
		try {
			return await this.request(url, {
				...init,
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
			});
		} catch {
			signal.throwIfAborted();
			throw new Error(`无法连接${what}或请求超时，请检查网络后重试。`);
		}
	}

	/** Token endpoint call; OAuth errors come back as JSON with HTTP 400/401, so the body is read whatever the status. */
	private async tokenRequest(
		provider: MailProvider,
		params: Record<string, string>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const spec = MAIL_PROVIDER_SPECS[provider];
		const response = await this.send(
			spec.tokenUrl,
			{
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(params),
			},
			signal,
			` ${spec.label} 登录服务`,
		);
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			data = undefined;
		}
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new Error(`${spec.label} 登录服务返回了无效数据（HTTP ${response.status}）。`);
		return data as Record<string, unknown>;
	}

	private tokenFields(
		provider: MailProvider,
		response: Record<string, unknown>,
	): Pick<MailConnection, "token" | "expiresAt" | "refreshToken" | "scopes"> {
		const label = MAIL_PROVIDER_SPECS[provider].label;
		if (typeof response.access_token !== "string" || !response.access_token)
			throw new Error(`${label} 返回的令牌无效，请重新连接。`);
		const expiresIn = typeof response.expires_in === "string" ? Number(response.expires_in) : response.expires_in;
		if (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0))
			throw new Error(`${label} 返回的有效期无效，请重新连接。`);
		if (
			response.refresh_token !== undefined &&
			(typeof response.refresh_token !== "string" || !response.refresh_token)
		)
			throw new Error(`${label} 返回的刷新令牌无效，请重新连接。`);
		return {
			token: response.access_token,
			expiresAt: expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000,
			refreshToken: response.refresh_token as string | undefined,
			scopes: typeof response.scope === "string" ? response.scope.split(/\s+/).filter(Boolean) : undefined,
		};
	}

	/** Who the token belongs to: Gmail's own profile for Google, /me for Microsoft Graph. */
	private async identity(provider: MailProvider, token: string, signal: AbortSignal): Promise<MailAccount> {
		const spec = MAIL_PROVIDER_SPECS[provider];
		const path =
			provider === "google" ? "/gmail/v1/users/me/profile" : "/v1.0/me?$select=displayName,mail,userPrincipalName";
		const response = await this.send(
			`${spec.apiOrigin}${path}`,
			{ headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
			signal,
			` ${spec.label}`,
		);
		if (!response.ok) {
			const detail = await this.errorDetail(response, [token]);
			throw new Error(
				`无法读取 ${spec.label} 邮箱信息（HTTP ${response.status}${detail ? `：${detail}` : ""}）。${provider === "google" ? "" : "该账号可能没有 Exchange Online/Outlook 邮箱。"}`,
			);
		}
		const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		const email =
			provider === "google"
				? data.emailAddress
				: (typeof data.mail === "string" && data.mail) || data.userPrincipalName;
		if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email))
			throw new Error(`${spec.label} 返回的邮箱地址无效，请重新授权。`);
		const name =
			typeof data.displayName === "string" && data.displayName.trim() ? data.displayName.trim() : undefined;
		return { provider, email, ...(name ? { name } : {}) };
	}

	private async errorDetail(response: Response, secrets: string[]): Promise<string> {
		let text = "";
		try {
			text = await response.text();
		} catch {
			return "";
		}
		let message = text;
		try {
			const data = JSON.parse(text);
			const error = data?.error;
			message =
				typeof error === "object" && error
					? [error.code ?? error.status, error.message].filter(Boolean).join(": ")
					: typeof error === "string"
						? oauthError(data)
						: text;
		} catch {
			// Not JSON: keep the text itself.
		}
		return clip(
			secrets.filter(Boolean).reduce((result, secret) => result.split(secret).join("[REDACTED]"), message.trim()),
			500,
		);
	}

	/**
	 * Signs in one mailbox: opens a loopback listener, hands the sign-in URL to `onPrompt` (the Web UI opens it in the
	 * system browser), exchanges the code with PKCE and saves the mailbox. Signing in an already connected address
	 * replaces its credentials.
	 */
	async connect(provider: MailProvider, signal: AbortSignal, onPrompt: (url: string) => void): Promise<MailAccount> {
		if (!isProvider(provider)) throw new Error("未知的邮箱类型。");
		const spec = MAIL_PROVIDER_SPECS[provider];
		const app = this.app(provider);
		if (!app) throw new Error(`请先配置 ${spec.label} 的 OAuth Client ID。`);
		const verifier = randomBytes(48).toString("base64url");
		const state = randomBytes(24).toString("base64url");
		const { code, redirectUri } = await loopbackAuthorization(spec.redirectHost, state, signal, (redirect) => {
			const url = new URL(spec.authorizeUrl);
			url.search = new URLSearchParams({
				client_id: app.clientId,
				response_type: "code",
				redirect_uri: redirect,
				scope: spec.scopes.join(" "),
				state,
				code_challenge: createHash("sha256").update(verifier).digest("base64url"),
				code_challenge_method: "S256",
				...spec.extraAuthorizeParams,
			}).toString();
			onPrompt(url.href);
		});
		const response = await this.tokenRequest(
			provider,
			{
				client_id: app.clientId,
				...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
				...(provider === "google" ? {} : { scope: spec.scopes.join(" ") }),
			},
			signal,
		);
		if (response.error) throw new Error(`${spec.label} 授权失败：${oauthError(response)}`);
		const fields = this.tokenFields(provider, response);
		if (!fields.refreshToken)
			throw new Error(`${spec.label} 没有返回刷新令牌，登录会在一小时内失效；请撤销此应用的授权后重新连接。`);
		const account = await this.identity(provider, fields.token, signal);
		signal.throwIfAborted();
		const connection: MailConnection = {
			...account,
			clientId: app.clientId,
			...(app.clientSecret ? { clientSecret: app.clientSecret } : {}),
			...fields,
			scopes: fields.scopes ?? [...spec.scopes],
		};
		try {
			await this.storage.withLockAsync(async (text) => {
				signal.throwIfAborted();
				const data = this.parse(text);
				const others = (data.accounts ?? []).filter((saved) => accountKey(saved) !== accountKey(connection));
				return { result: undefined, next: JSON.stringify({ ...data, accounts: [...others, connection] }) };
			});
		} catch {
			signal.throwIfAborted();
			throw new Error(
				`${spec.label} 已授权，但无法保存本机凭据。请检查 mail-connections.json 的权限与格式后重试；远端授权可在账号的应用权限设置中撤销。`,
			);
		}
		return publicAccount(account);
	}

	/** The saved credential of one mailbox, refreshed first when it expires within a minute (serialized across processes). */
	private async credential(reference: string | undefined, signal: AbortSignal): Promise<MailConnection> {
		const saved = await this.storage.withLockAsync(async (text) => {
			signal.throwIfAborted();
			const data = this.parse(text);
			const connection = this.pick(data.accounts ?? [], reference);
			if (connection.expiresAt === undefined || connection.expiresAt > Date.now() + 60000)
				return { result: connection };
			const label = MAIL_PROVIDER_SPECS[connection.provider].label;
			if (!connection.refreshToken) throw new Error(`${connection.email} 的登录已过期，请重新授权。`);
			const response = await this.tokenRequest(
				connection.provider,
				{
					client_id: connection.clientId,
					...(connection.clientSecret ? { client_secret: connection.clientSecret } : {}),
					grant_type: "refresh_token",
					refresh_token: connection.refreshToken,
					...(connection.provider === "google"
						? {}
						: { scope: MAIL_PROVIDER_SPECS[connection.provider].scopes.join(" ") }),
				},
				signal,
			);
			if (response.error) {
				throw new Error(
					response.error === "invalid_grant"
						? `${connection.email} 的 ${label} 登录已失效（密码更改、授权被撤销，或 Google“测试中”应用的 7 天期限），请在 Mail Connect 中重新授权。`
						: `${label} 登录刷新失败：${oauthError(response)}`,
				);
			}
			const fields = this.tokenFields(connection.provider, response);
			const updated: MailConnection = {
				...connection,
				...fields,
				// Google keeps the refresh token; Microsoft rotates it.
				refreshToken: fields.refreshToken ?? connection.refreshToken,
				scopes: fields.scopes ?? connection.scopes,
			};
			return {
				result: updated,
				next: JSON.stringify({
					...data,
					accounts: (data.accounts ?? []).map((account) =>
						accountKey(account) === accountKey(updated) ? updated : account,
					),
				}),
			};
		});
		signal.throwIfAborted();
		return saved;
	}

	async verify(reference: string, signal: AbortSignal): Promise<MailAccount> {
		const credential = await this.credential(reference, signal);
		return publicAccount(await this.identity(credential.provider, credential.token, signal));
	}

	/**
	 * Authenticated JSON API access for the agent: Gmail API (gmail.googleapis.com) or Microsoft Graph. Credentials
	 * never enter tool arguments or output. Gmail text parts come back decoded (`body.text`) instead of base64url.
	 */
	async api(
		reference: string | undefined,
		path: string,
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		body: unknown,
		signal: AbortSignal,
	): Promise<MailApiResult> {
		const credential = await this.credential(reference, signal);
		const spec = MAIL_PROVIDER_SPECS[credential.provider];
		if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
			throw new Error(`邮箱 API path 必须是以 / 开头的相对路径（相对 ${spec.apiOrigin}）。`);
		const url = new URL(path, spec.apiOrigin);
		if (url.origin !== spec.apiOrigin || url.username || url.password || url.hash)
			throw new Error(`只允许访问 ${spec.apiOrigin}。`);
		if (method === "GET" && body !== undefined) throw new Error("GET 请求请将参数放在 path 查询字符串中。");
		const secrets = [credential.token, credential.refreshToken, credential.clientSecret].filter(
			(value): value is string => Boolean(value),
		);
		const redact = (text: string) =>
			secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${credential.token}`,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		// Graph returns message bodies as HTML by default; plain text is what an agent reads.
		if (credential.provider !== "google") headers.Prefer = 'outlook.body-content-type="text"';
		const response = await this.send(
			url.href,
			{ method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
			signal,
			` ${spec.label}`,
		);
		if (!response.ok) {
			const detail = await this.errorDetail(response, secrets);
			const hint =
				response.status === 401
					? "登录已失效，请在 /settings → Mail Connect 中重新授权。"
					: response.status === 403
						? "权限不足：可能未授予所需权限、组织管理员禁止了第三方应用，或此账号没有可用的邮箱。"
						: response.status === 429
							? "请求过于频繁，请稍后再试。"
							: "请求未成功，未自动重试。";
			throw new Error(`${spec.label} HTTP ${response.status}：${hint}${detail ? `（${detail}）` : ""}`);
		}
		const text = response.status === 204 ? "" : redact(await response.text());
		let data: unknown = null;
		if (text.trim()) {
			try {
				data = JSON.parse(text);
			} catch {
				throw new Error("此邮箱接口未返回 JSON，请使用 JSON API 端点。");
			}
		}
		if (credential.provider === "google") decodeGmailTextParts(data);
		const nextLink =
			data && typeof data === "object" && typeof (data as Record<string, unknown>)["@odata.nextLink"] === "string"
				? new URL((data as Record<string, string>)["@odata.nextLink"], url)
				: undefined;
		return {
			account: publicAccount(credential),
			data,
			...(nextLink?.origin === url.origin ? { next: `${nextLink.pathname}${nextLink.search}` } : {}),
		};
	}
}

/** Replaces the base64url `body.data` of Gmail text/* parts with the decoded `body.text`, in place. */
export function decodeGmailTextParts(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) decodeGmailTextParts(item);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	const body = record.body as Record<string, unknown> | undefined;
	if (
		typeof record.mimeType === "string" &&
		record.mimeType.toLowerCase().startsWith("text/") &&
		body &&
		typeof body === "object" &&
		typeof body.data === "string"
	) {
		body.text = Buffer.from(body.data, "base64url").toString("utf8");
		delete body.data;
	}
	for (const child of Object.values(record)) decodeGmailTextParts(child);
}
