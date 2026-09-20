import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountConnections, GITHUB_SCOPES } from "../src/providers/credentials/account-connections.ts";
import { FileAuthStorageBackend, InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";

// Node's timers/promises uses native timers; route only this delay through the fake clock.
vi.mock("node:timers/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:timers/promises")>()),
	setTimeout: (ms: number, _value: unknown, options: { signal: AbortSignal }) =>
		new Promise<void>((resolve, reject) => {
			const signal = options.signal;
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal.addEventListener("abort", onAbort, { once: true });
		}),
}));

const device = {
	device_code: "private-device-code",
	user_code: "ABCD-1234",
	verification_uri: "https://github.com/login/device",
	expires_in: 900,
	interval: 5,
};
const identity = { login: "octocat", id: 1 };
const token = { access_token: "test-token-never-render", token_type: "bearer", scope: GITHUB_SCOPES.join(",") };
function setup(responses: Array<Record<string, unknown> | Response>) {
	const request = vi.fn<typeof fetch>();
	for (const body of responses) request.mockResolvedValueOnce(body instanceof Response ? body : Response.json(body));
	const storage = new InMemoryAuthStorageBackend();
	const connections = new AccountConnections(storage, request);
	connections.setClientId("test-client-id");
	return { request, storage, connections };
}

beforeEach(() => {
	vi.stubEnv("MYHARNESS_GITHUB_CLIENT_ID", "");
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("GitHub device authorization", () => {
	it("persists expiry metadata and rotates tokens on verification after restart", async () => {
		const expiring = { ...token, expires_in: 120, refresh_token: "refresh-old", refresh_token_expires_in: 3600 };
		const rotated = {
			access_token: "access-new",
			expires_in: 28800,
			refresh_token: "refresh-new",
			refresh_token_expires_in: 7200,
		};
		const { connections, request, storage } = setup([device, expiring, identity, rotated, identity]);
		const login = connections.connect(new AbortController().signal, () => {});
		await vi.advanceTimersByTimeAsync(5000);
		await login;
		const data = () => JSON.parse(storage.withLock((text) => ({ result: text! })));
		expect(data().github.refreshToken).toBe("refresh-old");
		expect(data().github.expiresAt).toBe(Date.now() + 120000);
		await vi.advanceTimersByTimeAsync(61000);
		vi.stubEnv("MYHARNESS_GITHUB_CLIENT_ID", "another-app");
		const restored = new AccountConnections(storage, request);
		expect(await restored.verify(new AbortController().signal)).toEqual(identity);
		const body = request.mock.calls[3][1]?.body as URLSearchParams;
		expect(Object.fromEntries(body)).toEqual({
			client_id: "test-client-id",
			grant_type: "refresh_token",
			refresh_token: "refresh-old",
		});
		expect(data().github.refreshToken).toBe("refresh-new");
		expect(data().github.token).toBe("access-new");
		expect(data().github.refreshExpiresAt).toBe(Date.now() + 7200000);
		expect(request.mock.calls[4][1]?.headers).toHaveProperty("Authorization", "Bearer access-new");
	});

	it.each(["expired", "rejected", "missing"])("prompts for authorization when refresh is %s", async (kind) => {
		const { connections, storage, request } = setup([
			{ error: "bad_refresh_token", error_description: "secret text" },
		]);
		storage.withLock(() => ({
			result: undefined,
			next: JSON.stringify({
				github: {
					account: identity,
					token: "old",
					clientId: "own",
					expiresAt: Date.now() - 1,
					refreshToken: kind === "missing" ? undefined : "old-refresh",
					refreshExpiresAt: kind === "expired" ? Date.now() - 1 : Date.now() + 10000,
				},
			}),
		}));
		await expect(connections.verify(new AbortController().signal)).rejects.toThrow("重新授权");
		expect(request).toHaveBeenCalledTimes(kind === "rejected" ? 1 : 0);
		expect(connections.getAccount()).toEqual(identity);
	});

	it("keeps rotated credentials when identity lookup fails and does not refresh again", async () => {
		const { connections, storage, request } = setup([
			{ access_token: "new", expires_in: 1000, refresh_token: "new-refresh", refresh_token_expires_in: 2000 },
			new Response("failure", { status: 503 }),
			identity,
		]);
		storage.withLock(() => ({
			result: undefined,
			next: JSON.stringify({
				github: {
					account: identity,
					token: "old",
					clientId: "own",
					expiresAt: Date.now() - 1,
					refreshToken: "old-refresh",
				},
			}),
		}));
		await expect(connections.verify(new AbortController().signal)).rejects.toThrow("503");
		expect(await connections.verify(new AbortController().signal)).toEqual(identity);
		expect(request).toHaveBeenCalledTimes(3);
		expect(request.mock.calls[2][0]).toBe("https://api.github.com/user");
		expect(request.mock.calls[2][1]?.headers).toHaveProperty("Authorization", "Bearer new");
	});

	it("does not contact GitHub when verification is already cancelled", async () => {
		const { connections, request } = setup([]);
		const controller = new AbortController();
		controller.abort();
		await expect(connections.verify(controller.signal)).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});
	it("polls pending and slow_down, saves identity separately, restores and removes credentials", async () => {
		const { connections, request, storage } = setup([
			device,
			{ error: "authorization_pending" },
			{ error: "slow_down", interval: 20 },
			token,
			identity,
			identity,
		]);
		const prompt = vi.fn();
		const result = connections.connect(new AbortController().signal, prompt);
		await vi.advanceTimersByTimeAsync(0);
		expect(prompt).toHaveBeenCalledWith({ code: "ABCD-1234", url: device.verification_uri, expiresIn: 900 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(5000);
		expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(19999);
		expect(request).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toEqual(identity);
		const body = request.mock.calls[0][1]?.body as URLSearchParams;
		expect(body.get("scope")?.split(" ")).toEqual([...GITHUB_SCOPES]);
		expect(connections.getGrantedScopes()).toEqual([...GITHUB_SCOPES]);
		expect(body.get("client_id")).toBe("test-client-id");
		expect(request.mock.calls[4][0]).toBe("https://api.github.com/user");
		expect(request.mock.calls[4][1]?.headers).toHaveProperty("Authorization", `Bearer ${token.access_token}`);
		const restored = new AccountConnections(storage, request);
		expect(restored.getAccount()).toEqual(identity);
		expect(await restored.verify(new AbortController().signal)).toEqual(identity);
		await restored.disconnect();
		expect(connections.getAccount()).toBeUndefined();
		expect(connections.getClientId()).toBe("test-client-id");
		expect(storage.withLock((text) => ({ result: text }))).not.toContain(token.access_token);
	});

	it.each([
		["access_denied", "拒绝"],
		["expired_token", "过期"],
		["incorrect_client_credentials", "授权失败"],
	])("handles %s without persisting credentials", async (error, message) => {
		const { connections } = setup([device, { error }]);
		const result = expect(connections.connect(new AbortController().signal, () => {})).rejects.toThrow(message);
		await vi.advanceTimersByTimeAsync(5000);
		await result;
		expect(connections.getAccount()).toBeUndefined();
	});

	it("stops at local expiry without another token request", async () => {
		const { connections, request } = setup([{ ...device, expires_in: 5 }]);
		const result = expect(connections.connect(new AbortController().signal, () => {})).rejects.toThrow("过期");
		await vi.advanceTimersByTimeAsync(5000);
		await result;
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("cancels polling without saving or fetching again", async () => {
		const { connections, request } = setup([device]);
		const controller = new AbortController();
		const result = expect(connections.connect(controller.signal, () => {})).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await result;
		await vi.advanceTimersByTimeAsync(30000);
		expect(request).toHaveBeenCalledTimes(1);
		expect(connections.getAccount()).toBeUndefined();
	});

	it("requires configuration and rejects untrusted verification URLs", async () => {
		const request = vi.fn<typeof fetch>();
		const empty = new AccountConnections(new InMemoryAuthStorageBackend(), request);
		await expect(empty.connect(new AbortController().signal, () => {})).rejects.toThrow("Client ID");
		expect(request).not.toHaveBeenCalled();
		const { connections } = setup([{ ...device, verification_uri: "https://example.com" }]);
		await expect(connections.connect(new AbortController().signal, () => {})).rejects.toThrow("响应无效");
	});

	it("sanitizes server errors and does not save a token if identity lookup fails", async () => {
		const { connections } = setup([device, token, new Response("secret-server-body", { status: 401 })]);
		const result = expect(connections.connect(new AbortController().signal, () => {})).rejects.toThrow("登录已失效");
		await vi.advanceTimersByTimeAsync(5000);
		await result;
		expect(connections.getAccount()).toBeUndefined();
	});

	it("does not expose transport error details and recognizes revoked saved credentials", async () => {
		const { connections, request, storage } = setup([]);
		request.mockRejectedValueOnce(new Error("sensitive transport details"));
		await expect(connections.connect(new AbortController().signal, () => {})).rejects.toThrow("无法连接 GitHub");
		storage.withLock(() => ({
			result: undefined,
			next: JSON.stringify({ github: { account: identity, token: token.access_token, clientId: "own-app" } }),
		}));
		request.mockResolvedValueOnce(new Response("sensitive response body", { status: 401 }));
		await expect(connections.verify(new AbortController().signal)).rejects.toThrow("登录已失效");
		expect(connections.getAccount()).toEqual(identity);
	});

	it("does not save when cancelled during identity lookup", async () => {
		const { connections, request } = setup([device, token]);
		let finish!: (response: Response) => void;
		request.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new AbortController();
		const result = expect(connections.connect(controller.signal, () => {})).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(5000);
		controller.abort();
		finish(Response.json(identity));
		await result;
		expect(connections.getAccount()).toBeUndefined();
	});

	it("reports a local save failure separately from GitHub authorization", async () => {
		const { connections, storage } = setup([device, token, identity]);
		vi.spyOn(storage, "withLockAsync").mockRejectedValue(new Error("storage failure"));
		const result = expect(connections.connect(new AbortController().signal, () => {})).rejects.toThrow(
			"GitHub 已授权，但无法保存",
		);
		await vi.advanceTimersByTimeAsync(5000);
		await result;
		expect(connections.getAccount()).toBeUndefined();
	});

	it("serializes refresh across two file-backed clients", async () => {
		vi.useRealTimers();
		const directory = mkdtempSync(join(tmpdir(), "myharness-refresh-test-"));
		try {
			const path = join(directory, "account-connections.json");
			new FileAuthStorageBackend(path).withLock(() => ({
				result: undefined,
				next: JSON.stringify({
					github: {
						account: identity,
						token: "old",
						clientId: "own",
						expiresAt: Date.now() - 1,
						refreshToken: "refresh-old",
					},
				}),
			}));
			const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
				Response.json(
					String(url).endsWith("/user")
						? identity
						: {
								access_token: "new",
								expires_in: 3600,
								refresh_token: "refresh-new",
								refresh_token_expires_in: 7200,
							},
				),
			);
			const clients = [
				new AccountConnections(new FileAuthStorageBackend(path), request),
				new AccountConnections(new FileAuthStorageBackend(path), request),
			];
			expect(await Promise.all(clients.map((client) => client.verify(new AbortController().signal)))).toEqual([
				identity,
				identity,
			]);
			expect(request.mock.calls.filter(([url]) => String(url).endsWith("/access_token"))).toHaveLength(1);
			expect(JSON.parse(readFileSync(path, "utf8")).github.refreshToken).toBe("refresh-new");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("persists to a separate credential file and preserves malformed data", async () => {
		vi.useRealTimers();
		const directory = mkdtempSync(join(tmpdir(), "myharness-account-test-"));
		try {
			const path = join(directory, "account-connections.json");
			const backend = new FileAuthStorageBackend(path);
			const connections = new AccountConnections(backend);
			connections.setClientId("own-app");
			backend.withLock(() => ({
				result: undefined,
				next: JSON.stringify({
					githubClientId: "own-app",
					github: { account: identity, token: token.access_token, clientId: "own-app" },
				}),
			}));
			expect(new AccountConnections(new FileAuthStorageBackend(path)).getAccount()).toEqual(identity);
			await connections.disconnect();
			expect(readFileSync(path, "utf8")).not.toContain(token.access_token);
			backend.withLock(() => ({ result: undefined, next: "invalid json" }));
			expect(() => connections.setClientId("replacement")).toThrow("格式无效");
			expect(readFileSync(path, "utf8")).toBe("invalid json");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
