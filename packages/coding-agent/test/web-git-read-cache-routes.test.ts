import * as path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import type { RequestContext, RouteHandler, WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	preview: vi.fn(),
	identity: vi.fn(),
	head: vi.fn(),
	linked: vi.fn(),
}));
vi.mock("../src/git/repository/read-cache.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getCachedGitInspect: mocks.inspect,
	getCachedGitStatusPreview: mocks.preview,
	getCachedGitIdentity: mocks.identity,
	getCachedGitHead: mocks.head,
	getCachedGitLinkedWorktree: mocks.linked,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.inspect.mockResolvedValue({
		gitAvailable: true,
		isRepository: true,
		root: path.resolve("fixture"),
		branch: "main",
		hasBaseline: true,
	});
	mocks.preview.mockResolvedValue({ lines: [], total: 0, truncated: false });
	mocks.identity.mockResolvedValue({ name: "Test" });
	mocks.head.mockResolvedValue({ sha: "abc", subject: "test" });
	mocks.linked.mockResolvedValue(false);
});

it("uses shared checkout reads but keeps checkpoint, trust, task and integration state live for each Chat", async () => {
	let checkpoint: unknown = { id: "checkpoint-a", status: "created" };
	let trusted = true;
	let integration = true;
	const handlers = new Map<string, RouteHandler>();
	const host = {
		openCheckpoint: () => checkpoint,
		gitTask: { kind: "commit" },
		session: {
			sessionManager: { getCwd: () => path.resolve("fixture") },
			settingsManager: {
				getGitIntegrationSettings: () => ({ enabled: integration }),
				isProjectTrusted: () => trusted,
			},
		},
	} as unknown as WebHost;
	registerGitRoutes(
		{
			route: (method, pattern, handler) => {
				handlers.set(`${method} ${pattern}`, handler);
			},
		} as Pick<WebHttpServer, "route"> as WebHttpServer,
		host,
	);
	const read = (query = "") =>
		handlers.get("GET /api/git/status")!({
			url: new URL(`http://127.0.0.1/api/git/status${query}`),
		} as RequestContext) as Promise<Record<string, any>>;
	const first = await read();
	expect(first.checkpoint.id).toBe("checkpoint-a");
	expect(first.trusted).toBe(true);
	checkpoint = { id: "checkpoint-b", status: "created" };
	trusted = false;
	integration = false;
	host.gitTask = null;
	const second = await read("?fresh=1");
	expect(second.checkpoint.id).toBe("checkpoint-b");
	expect(second.trusted).toBe(false);
	expect(second.integrationEnabled).toBe(false);
	expect(second.task).toBeNull();
	for (const mock of [mocks.inspect, mocks.preview, mocks.identity, mocks.head, mocks.linked]) {
		expect(mock.mock.calls[0]?.at(-1)).toEqual({ fresh: false });
		expect(mock.mock.calls[1]?.at(-1)).toEqual({ fresh: true });
	}
});
