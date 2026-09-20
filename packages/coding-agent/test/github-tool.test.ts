import { describe, expect, it, vi } from "vitest";
import { restrictToolNamesForRole } from "../src/agent/runtime/role.ts";
import { AccountConnections } from "../src/providers/credentials/account-connections.ts";
import { InMemoryAuthStorageBackend } from "../src/providers/credentials/auth-storage.ts";
import { createGitHubToolDefinition } from "../src/tools/github/tool.ts";
import { allToolNames, createToolDefinition } from "../src/tools/registry.ts";

function setup(responses: Response[] = []) {
	const storage = new InMemoryAuthStorageBackend();
	storage.withLock(() => ({
		result: undefined,
		next: JSON.stringify({
			github: {
				account: { login: "octocat", id: 1 },
				token: "test-secret-access",
				refreshToken: "test-secret-refresh",
				clientId: "own-app",
				scopes: ["repo", "user"],
			},
		}),
	}));
	const request = vi.fn<typeof fetch>();
	for (const response of responses) request.mockResolvedValueOnce(response);
	const service = new AccountConnections(storage, request);
	const tool = createGitHubToolDefinition(".", { connections: service });
	const run = (path: string, method?: "GET" | "POST" | "DELETE", body?: Record<string, unknown>) =>
		tool.execute("call", { path, method, body }, new AbortController().signal, undefined, {} as never);
	return { storage, request, service, tool, run };
}

describe("authenticated github tool", () => {
	it("accesses private repositories and email addresses with saved credentials and follows pagination", async () => {
		const { request, run } = setup([
			Response.json([{ name: "private-project", private: true }], {
				headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
			}),
			Response.json([{ email: "private@example.com", primary: true }]),
		]);
		const repos = await run("/user/repos?visibility=private&per_page=100");
		expect(repos.content).toEqual([{ type: "text", text: expect.stringContaining('"next": "/user/repos?page=2"') }]);
		expect(JSON.stringify(repos)).toContain("private-project");
		expect(JSON.stringify(await run("/user/emails"))).toContain("private@example.com");
		expect(request.mock.calls[0][1]?.headers).toHaveProperty("Authorization", "Bearer test-secret-access");
		expect(request.mock.calls[0][1]?.redirect).toBe("error");
		expect(JSON.stringify(repos)).not.toContain("test-secret");
	});

	it("sends REST writes and GraphQL to the same authenticated origin without retrying", async () => {
		const { request, run } = setup([
			Response.json({ number: 7 }),
			Response.json({ data: { viewer: { login: "octocat" } } }),
			new Response(null, { status: 204 }),
		]);
		await run("/repos/octocat/project/issues", "POST", { title: "Example" });
		await run("/graphql", "POST", { query: "query { viewer { login } }" });
		await run("/repos/octocat/project/issues/7/labels/example", "DELETE");
		expect(request.mock.calls[0][1]?.body).toBe('{"title":"Example"}');
		expect(request.mock.calls[1][0]).toBe("https://api.github.com/graphql");
		expect(request.mock.calls[2][1]?.method).toBe("DELETE");
		expect(request).toHaveBeenCalledTimes(3);
	});

	it.each(["https://example.com/user", "//example.com/user", "/\\example.com/user", "/user#fragment"])(
		"rejects external or ambiguous paths: %s",
		async (path) => {
			const { run, request } = setup();
			await expect(run(path)).rejects.toThrow();
			expect(request).not.toHaveBeenCalled();
		},
	);

	it("redacts credentials even when a response echoes them and excludes external pagination", async () => {
		const { run } = setup([
			Response.json(
				{ echoed: "test-secret-access test-secret-refresh" },
				{ headers: { link: '<https://example.com/next>; rel="next"' } },
			),
		]);
		const result = JSON.stringify(await run("/user"));
		expect(result).not.toContain("test-secret");
		expect(result).not.toContain("example.com");
		expect(result).toContain("REDACTED");
	});

	it("refreshes before API access and stops using credentials after disconnect", async () => {
		const { service, storage, run, request } = setup([
			Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 3600 }),
			Response.json([{ name: "private" }]),
		]);
		storage.withLock((text) => {
			const data = JSON.parse(text!);
			data.github.expiresAt = Date.now() - 1;
			return { result: undefined, next: JSON.stringify(data) };
		});
		await run("/user/repos");
		expect(request.mock.calls[1][1]?.headers).toHaveProperty("Authorization", "Bearer rotated");
		await service.disconnect();
		await expect(run("/user/emails")).rejects.toThrow("尚未连接");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each([401, 403, 404, 429])(
		"reports HTTP %s without echoing response secrets or retrying writes",
		async (status) => {
			const { run, request } = setup([new Response("test-secret-access", { status })]);
			const result = run("/repos/octocat/project/issues", "POST", { title: "Example" });
			await expect(result).rejects.toThrow();
			await expect(result).rejects.not.toThrow("test-secret-access");
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it("is registered as a built-in and stays outside delegated read-only sessions", () => {
		const { service } = setup();
		expect(allToolNames.has("github")).toBe(true);
		expect(createToolDefinition("github", ".", { github: { connections: service } }).name).toBe("github");
		expect(restrictToolNamesForRole("delegated", ["read", "github"])).toEqual(["read"]);
	});
});
