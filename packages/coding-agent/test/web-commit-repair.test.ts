import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), repairResult: true }));
vi.mock("../src/application/use-cases/git-commit.ts", () => ({
	GitCommitUseCase: class {
		private host: { repairCode: (failure: unknown) => Promise<boolean> };
		constructor(host: { repairCode: (failure: unknown) => Promise<boolean> }) {
			this.host = host;
		}
		async execute() {
			mocks.repairResult = await this.host.repairCode({ stdout: "hook diagnostic", stderr: "check failed" });
			return mocks.execute();
		}
	},
}));
vi.mock("../src/git/repository/integration.ts", async (original) => ({
	...(await original<typeof import("../src/git/repository/integration.ts")>()),
	inspectGitRepository: () => ({ gitAvailable: true, isRepository: true, hasBaseline: true, root: "repo" }),
	getGitStatusPreview: () => ({ total: 1 }),
}));

import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";

afterEach(() => vi.clearAllMocks());
it.each(["completed", "failed", "cancelled"])(
	"delivers repair as a hidden custom turn and waits for completion (%s)",
	async (state) => {
		const order: string[] = [];
		const sendCustomMessage = vi.fn(async () => {
			order.push("repair");
		});
		const host = {
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionManager: { getCwd: () => "repo" },
				settingsManager: { isProjectTrusted: () => true },
				sendCustomMessage,
				waitForIdle: async () => {
					order.push("idle");
				},
				getRunStateSnapshot: () => ({ state }),
			},
			completionActive: false,
			openCheckpoint: () => undefined,
			broadcast: vi.fn(),
			runtimeHost: { services: { agentDir: "agent" } },
			waitForCompletion: async () => {
				order.push("completion");
			},
		} as unknown as WebHost;
		mocks.execute.mockReturnValue({
			status: "failed",
			message: { full: "commit message" },
			paths: ["file"],
			failure: { stdout: "hook diagnostic", stderr: "check failed", exitCode: 1 },
		});
		const server = new WebHttpServer();
		registerGitRoutes(server, host);
		try {
			const { port } = await server.listen(0);
			const response = await fetch(`http://127.0.0.1:${port}/api/git/commit`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-myharness-web": "1" },
				body: "{}",
			});
			expect(response.ok).toBe(true);
			expect(((await response.json()) as { failure: string }).failure).toContain("hook diagnostic\ncheck failed");
			expect(sendCustomMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "git-commit-repair",
					display: false,
					content: expect.stringContaining("hook diagnostic"),
				}),
				{ triggerTurn: true },
			);
			expect(order).toEqual(["repair", "idle", "completion"]);
			expect(mocks.repairResult).toBe(state === "completed");
		} finally {
			await server.close();
		}
	},
);
