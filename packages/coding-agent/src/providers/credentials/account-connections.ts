import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

// Broad OAuth access requested by GitHub Connect; GitHub/organization policy remains authoritative.
export const GITHUB_SCOPES = [
	"repo",
	"workflow",
	"user",
	"admin:org",
	"admin:repo_hook",
	"admin:org_hook",
	"admin:public_key",
	"admin:gpg_key",
	"admin:ssh_signing_key",
	"gist",
	"notifications",
	"delete_repo",
	"write:packages",
	"delete:packages",
	"codespace",
	"project",
] as const;

export interface ConnectedAccount {
	login: string;
	id: number;
}
interface GitHubConnection {
	account: ConnectedAccount;
	token: string;
	clientId: string;
	expiresAt?: number;
	refreshToken?: string;
	refreshExpiresAt?: number;
	scopes?: string[];
}
interface ConnectionData {
	githubClientId?: string;
	github?: GitHubConnection;
}
export interface GitHubDevicePrompt {
	code: string;
	url: string;
	expiresIn: number;
}

/** Website credentials are deliberately separate from model provider authentication. */
export class AccountConnections {
	private readonly storage: AuthStorageBackend;
	private readonly request: typeof fetch;

	constructor(
		storage: AuthStorageBackend = new FileAuthStorageBackend(join(getAgentDir(), "account-connections.json")),
		request: typeof fetch = fetch,
	) {
		this.storage = storage;
		this.request = request;
	}

	private read(): ConnectionData {
		return this.storage.withLock((text) => ({ result: this.parse(text) }));
	}

	private parse(text: string | undefined): ConnectionData {
		try {
			const data = JSON.parse(text ?? "{}");
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
			if (data.githubClientId !== undefined && typeof data.githubClientId !== "string") throw new Error();
			if (
				data.github &&
				(typeof data.github.token !== "string" ||
					typeof data.github.clientId !== "string" ||
					typeof data.github.account?.login !== "string" ||
					!Number.isSafeInteger(data.github.account?.id) ||
					(data.github.refreshToken !== undefined && typeof data.github.refreshToken !== "string") ||
					(data.github.scopes !== undefined &&
						(!Array.isArray(data.github.scopes) ||
							data.github.scopes.some((scope: unknown) => typeof scope !== "string"))) ||
					[data.github.expiresAt, data.github.refreshExpiresAt].some(
						(value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value)),
					))
			)
				throw new Error();
			return data;
		} catch {
			throw new Error("账户连接文件格式无效，请检查本机 account-connections.json；未覆盖现有数据。");
		}
	}

	getClientId(): string {
		return process.env.MYHARNESS_GITHUB_CLIENT_ID?.trim() || this.read().githubClientId || "";
	}

	setClientId(value: string): void {
		const clientId = value.trim();
		if (!/^[a-zA-Z0-9._-]{1,200}$/.test(clientId)) throw new Error("请输入有效的 GitHub OAuth App Client ID。");
		this.storage.withLock((text) => ({
			result: undefined,
			next: JSON.stringify({ ...this.parse(text), githubClientId: clientId }),
		}));
	}

	getAccount(): ConnectedAccount | undefined {
		const account = this.read().github?.account;
		return account ? { ...account } : undefined;
	}

	getGrantedScopes(): string[] {
		return this.read().github?.scopes ?? [];
	}

	async disconnect(): Promise<void> {
		await this.storage.withLockAsync(async (text) => {
			const data = this.parse(text);
			delete data.github;
			return { result: undefined, next: JSON.stringify(data) };
		});
	}

	private async json(url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await this.request(url, {
				...init,
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
			});
		} catch {
			signal.throwIfAborted();
			throw new Error("无法连接 GitHub 或请求超时，请检查网络后重试。");
		}
		if (response.status === 401) throw new Error("GitHub 登录已失效，请选择重新授权。");
		if (!response.ok) throw new Error(`GitHub 请求失败（HTTP ${response.status}），请稍后重试。`);
		try {
			const data = await response.json();
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
			return data as Record<string, unknown>;
		} catch {
			throw new Error("GitHub 返回的数据格式无效，请稍后重试。");
		}
	}

	private async identity(token: string, signal: AbortSignal): Promise<ConnectedAccount> {
		const data = await this.json(
			"https://api.github.com/user",
			{
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "myharness",
				},
			},
			signal,
		);
		if (typeof data.login !== "string" || !/^[a-zA-Z0-9-]+$/.test(data.login) || !Number.isSafeInteger(data.id)) {
			throw new Error("GitHub 账号信息无效，请重新授权。");
		}
		return { login: data.login, id: data.id as number };
	}

	private tokenFields(
		response: Record<string, unknown>,
	): Pick<GitHubConnection, "token" | "expiresAt" | "refreshToken" | "refreshExpiresAt"> {
		if (typeof response.access_token !== "string" || !response.access_token)
			throw new Error("GitHub 返回的令牌无效，请重新连接。");
		const expires = (value: unknown): number | undefined => {
			if (value === undefined) return undefined;
			if (
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				value <= 0 ||
				!Number.isFinite(Date.now() + value * 1000)
			)
				throw new Error("GitHub 返回的有效期无效，请重新连接。");
			return Date.now() + value * 1000;
		};
		if (
			response.refresh_token !== undefined &&
			(typeof response.refresh_token !== "string" || !response.refresh_token)
		)
			throw new Error("GitHub 返回的刷新令牌无效，请重新连接。");
		return {
			token: response.access_token,
			expiresAt: expires(response.expires_in),
			refreshToken: response.refresh_token as string | undefined,
			refreshExpiresAt: expires(response.refresh_token_expires_in),
		};
	}

	private async credential(signal: AbortSignal): Promise<GitHubConnection> {
		// Serialize refreshes across processes: GitHub rotates both tokens on refresh.
		const saved = await this.storage.withLockAsync(async (text) => {
			signal.throwIfAborted();
			const data = this.parse(text);
			const connection = data.github;
			if (!connection) throw new Error("尚未连接 GitHub。");
			if (connection.expiresAt === undefined || connection.expiresAt > Date.now() + 60000)
				return { result: connection };
			if (
				!connection.refreshToken ||
				(connection.refreshExpiresAt !== undefined && connection.refreshExpiresAt <= Date.now())
			) {
				throw new Error("GitHub 登录已过期，请选择重新授权。");
			}
			const response = await this.json(
				"https://github.com/login/oauth/access_token",
				{
					method: "POST",
					headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: connection.clientId,
						grant_type: "refresh_token",
						refresh_token: connection.refreshToken,
					}),
				},
				signal,
			);
			if (response.error) throw new Error("GitHub 登录刷新失败，请选择重新授权。");
			const fields = this.tokenFields(response);
			if (!fields.refreshToken || fields.expiresAt === undefined)
				throw new Error("GitHub 刷新响应不完整，请选择重新授权。");
			const updated = {
				account: connection.account,
				clientId: connection.clientId,
				scopes:
					typeof response.scope === "string" ? response.scope.split(/[ ,]+/).filter(Boolean) : connection.scopes,
				...fields,
			};
			// Save rotated tokens before fetching identity, even if that later request fails.
			return { result: updated, next: JSON.stringify({ ...data, github: updated }) };
		});
		signal.throwIfAborted();
		return saved;
	}

	async verify(signal: AbortSignal): Promise<ConnectedAccount> {
		return this.identity((await this.credential(signal)).token, signal);
	}

	/** Authenticated API access for the agent. Credentials never enter tool arguments or shell environments. */
	async api(
		path: string,
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		body: unknown,
		signal: AbortSignal,
	): Promise<{ data: unknown; next?: string }> {
		if (!path.startsWith("/") || path.startsWith("//") || /[\\\\\r\n]/.test(path))
			throw new Error("GitHub API path 必须是以 / 开头的相对路径。");
		const url = new URL(path, "https://api.github.com");
		if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash)
			throw new Error("只允许访问 api.github.com。");
		if (method === "GET" && body !== undefined) throw new Error("GET 请求请将参数放在 path 查询字符串中。");
		const credential = await this.credential(signal);
		const redact = (text: string) =>
			[credential.token, credential.refreshToken]
				.filter((value): value is string => Boolean(value))
				.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
		let response: Response;
		try {
			response = await this.request(url.href, {
				method,
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${credential.token}`,
					"Content-Type": "application/json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "myharness",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			signal.throwIfAborted();
			throw new Error("GitHub 请求失败或超时，请检查网络；未自动重试写操作。");
		}
		if (response.status === 401) throw new Error("GitHub 登录已失效，请在 /settings → GitHub Connect 中重新授权。");
		if (response.status === 403 || response.status === 404)
			throw new Error(
				`GitHub HTTP ${response.status}：资源不存在、授权不足、组织 SSO 未批准或受到限速；旧连接请先重新授权。`,
			);
		if (!response.ok) throw new Error(`GitHub HTTP ${response.status}：请求未成功，未自动重试。`);
		if (response.status === 204) return { data: null };
		let data: unknown;
		try {
			data = JSON.parse(redact(await response.text()));
		} catch {
			throw new Error("此 GitHub 接口未返回 JSON，请使用 JSON API 端点。");
		}
		const next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
		const nextUrl = next ? new URL(next, url) : undefined;
		return {
			data,
			...(nextUrl?.origin === url.origin ? { next: redact(`${nextUrl.pathname}${nextUrl.search}`) } : {}),
		};
	}

	/**
	 * Read a text endpoint such as a GitHub Actions job log. GitHub may return
	 * a short-lived signed redirect for logs; follow that redirect without
	 * forwarding the GitHub OAuth token to the storage host.
	 */
	async apiText(path: string, signal: AbortSignal): Promise<string> {
		if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
			throw new Error("GitHub API path 必须是以 / 开头的相对路径。");
		const url = new URL(path, "https://api.github.com");
		if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash)
			throw new Error("只允许访问 api.github.com。");
		const credential = await this.credential(signal);
		const redact = (text: string) =>
			[credential.token, credential.refreshToken]
				.filter((value): value is string => Boolean(value))
				.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
		let response: Response;
		try {
			response = await this.request(url.href, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
				headers: {
					Accept: "text/plain",
					Authorization: `Bearer ${credential.token}`,
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "myharness",
				},
			});
		} catch {
			signal.throwIfAborted();
			throw new Error("GitHub 日志请求失败或超时，请检查网络。");
		}
		if (response.status === 401) throw new Error("GitHub 登录已失效，请在 /settings → GitHub Connect 中重新授权。");
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error("GitHub 日志下载地址无效。");
			const signedUrl = new URL(location, url);
			if (signedUrl.protocol !== "https:" || signedUrl.username || signedUrl.password || signedUrl.hash)
				throw new Error("GitHub 日志下载地址不安全。");
			try {
				response = await this.request(signedUrl.href, {
					method: "GET",
					redirect: "error",
					signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
					headers: { Accept: "text/plain", "User-Agent": "myharness" },
				});
			} catch {
				signal.throwIfAborted();
				throw new Error("GitHub 日志下载失败或超时，请检查网络。");
			}
		}
		if (!response.ok) throw new Error(`GitHub 日志请求失败（HTTP ${response.status}）。`);
		return redact(await response.text());
	}

	async connect(signal: AbortSignal, onDevice: (prompt: GitHubDevicePrompt) => void): Promise<ConnectedAccount> {
		const clientId = this.getClientId();
		if (!clientId) throw new Error("请先配置 GitHub OAuth App Client ID，并在应用中启用 Device Flow。");
		const post = (body: Record<string, string>): RequestInit => ({
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body),
		});
		// The user explicitly approves these permissions on GitHub's device authorization page.
		const device = await this.json(
			"https://github.com/login/device/code",
			post({ client_id: clientId, scope: GITHUB_SCOPES.join(" ") }),
			signal,
		);
		if (device.error) throw new Error("无法启动 GitHub 授权，请检查 Client ID 和 Enable Device Flow 配置。");
		if (
			typeof device.device_code !== "string" ||
			typeof device.user_code !== "string" ||
			!/^[A-Z0-9-]+$/.test(device.user_code) ||
			device.verification_uri !== "https://github.com/login/device" ||
			typeof device.expires_in !== "number" ||
			!Number.isFinite(device.expires_in) ||
			device.expires_in <= 0
		) {
			throw new Error("GitHub 设备授权响应无效。");
		}
		let interval =
			typeof device.interval === "number" && Number.isFinite(device.interval) ? Math.max(device.interval, 5) : 5;
		const deadline = Date.now() + device.expires_in * 1000;
		onDevice({ code: device.user_code, url: device.verification_uri, expiresIn: device.expires_in });
		while (Date.now() < deadline) {
			await delay(Math.min(interval * 1000, deadline - Date.now()), undefined, { signal });
			if (Date.now() >= deadline) break;
			const token = await this.json(
				"https://github.com/login/oauth/access_token",
				post({
					client_id: clientId,
					device_code: device.device_code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal,
			);
			if (token.error === "authorization_pending") continue;
			if (token.error === "slow_down") {
				interval = Math.max(
					interval + 5,
					typeof token.interval === "number" && Number.isFinite(token.interval) ? token.interval : 0,
				);
				continue;
			}
			if (token.error === "access_denied") throw new Error("你已拒绝 GitHub 授权，可以重新连接。");
			if (token.error === "expired_token") break;
			if (token.error || typeof token.access_token !== "string" || !token.access_token)
				throw new Error("GitHub 授权失败，请检查应用配置后重试。");
			const fields = this.tokenFields(token);
			const account = await this.identity(fields.token, signal);
			signal.throwIfAborted();
			const connection: GitHubConnection = {
				account,
				clientId,
				scopes: typeof token.scope === "string" ? token.scope.split(/[ ,]+/).filter(Boolean) : [],
				...fields,
			};
			try {
				await this.storage.withLockAsync(async (text) => {
					signal.throwIfAborted();
					return { result: undefined, next: JSON.stringify({ ...this.parse(text), github: connection }) };
				});
			} catch {
				signal.throwIfAborted();
				throw new Error(
					"GitHub 已授权，但无法保存本机凭据。请检查账户连接文件权限与格式后重试；远端授权可在 GitHub 应用设置中撤销。",
				);
			}
			return account;
		}
		throw new Error("GitHub 验证码已过期，请重新连接获取新验证码。");
	}
}
