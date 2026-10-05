import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), repair: false }));
vi.mock("../src/application/use-cases/git-commit.ts", () => ({
	GitCommitUseCase: class {
		private host: {
			generateMessage: (context: unknown) => Promise<unknown>;
			repairCode: (failure: unknown) => Promise<boolean>;
		};
		constructor(host: {
			generateMessage: (context: unknown) => Promise<unknown>;
			repairCode: (failure: unknown) => Promise<boolean>;
		}) {
			this.host = host;
		}
		async execute() {
			await this.host.generateMessage({
				paths: ["file.ts", "other.ts"],
				diff: "real delta",
				history: "recent history",
			});
			if (mocks.repair) await this.host.repairCode({ stdout: "type error", stderr: "pre-commit hook failed" });
			return mocks.execute();
		}
	},
}));
vi.mock("../src/git/repository/integration.ts", async (original) => ({
	...(await original<typeof import("../src/git/repository/integration.ts")>()),
	inspectGitRepository: () => ({ gitAvailable: true, isRepository: true, hasBaseline: true, root: "repo" }),
	getGitStatusPreview: () => ({ total: 2 }),
}));

import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";

afterEach(() => {
	vi.clearAllMocks();
	mocks.repair = false;
});
it.each([false, true])("generates an isolated description and only runs the requested repair (%s)", async (repair) => {
	mocks.repair = repair;
	const completeSimple = vi.fn().mockResolvedValue({
		stopReason: "stop",
		content: [
			{
				type: "text",
				text: JSON.stringify({
					title: "feat: two features",
					body: ["- Explain first feature", "- Explain second feature"],
				}),
			},
		],
	});
	const sendCustomMessage = vi.fn();
	const host = {
		session: {
			isStreaming: false,
			isCompacting: false,
			sessionManager: { getCwd: () => "repo" },
			settingsManager: { isProjectTrusted: () => true },
			model: { id: "selected-model" },
			modelRuntime: { completeSimple },
			sendCustomMessage,
			abort: vi.fn(),
			waitForIdle: vi.fn(),
			getRunStateSnapshot: () => ({ state: "completed" }),
		},
		completionActive: false,
		waitForCompletion: vi.fn(),
		openCheckpoint: () => undefined,
		broadcast: vi.fn(),
		runtimeHost: { services: { agentDir: "agent" } },
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
		if (repair) {
			expect(sendCustomMessage).toHaveBeenCalledTimes(1);
			const [entry, options] = sendCustomMessage.mock.calls[0]!;
			expect(entry.customType).toBe("git-commit-repair");
			expect(entry.content).toContain("Do not bypass");
			expect(entry.content).toContain("type error");
			expect(options).toEqual({ triggerTurn: true });
		} else expect(sendCustomMessage).not.toHaveBeenCalled();
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const [, request] = completeSimple.mock.calls[0]!;
		expect(request.tools).toBeUndefined();
		expect(request.messages).toHaveLength(1);
		expect(JSON.parse(request.messages[0].content)).toEqual({
			paths: ["file.ts", "other.ts"],
			diff: "real delta",
			history: "recent history",
		});
		expect(request.systemPrompt).toContain("Do not add AI attribution");
	} finally {
		await server.close();
	}
});
