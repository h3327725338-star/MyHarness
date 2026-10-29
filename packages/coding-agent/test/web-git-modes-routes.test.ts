import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../src/git/repository/integration.ts";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";

const gitAvailable = runGit(process.cwd(), ["--version"]).ok;

function git(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (!result.ok) throw new Error(`${args.join(" ")}: ${result.stderr || result.error}`);
	return result.stdout.trim();
}

interface Prefs {
	commit: { mode?: "direct" | "instructions"; skipHooks?: boolean; instructions?: string };
	push: { mode?: "direct" | "instructions"; instructions?: string };
}

describe.skipIf(!gitAvailable)("Git commit and push modes (routes)", () => {
	let root: string;
	let repo: string;
	let server: WebHttpServer;
	let port: number;
	let prefs: Prefs;
	let records: Array<{ customType: string; data: Record<string, unknown> }>;
	let completeSimple: ReturnType<typeof vi.fn>;

	const call = async (route: string, body: unknown = {}, method = "POST") => {
		const response = await fetch(`http://127.0.0.1:${port}${route}`, {
			method,
			headers: { "Content-Type": "application/json", "x-myharness-web": "1" },
			...(method === "POST" ? { body: JSON.stringify(body) } : {}),
		});
		return { status: response.status, body: (await response.json()) as Record<string, any> };
	};

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "myharness-git-modes-"));
		const remote = join(root, "remote.git");
		repo = join(root, "work");
		mkdirSync(repo);
		git(root, ["init", "--bare", "-b", "main", remote]);
		git(repo, ["init", "-b", "main"]);
		git(repo, ["config", "user.name", "Test"]);
		git(repo, ["config", "user.email", "test@example.com"]);
		// The test's own hooks folder: the machine's global core.hooksPath would run its hooks on every commit.
		mkdirSync(join(root, "hooks"));
		git(repo, ["config", "core.hooksPath", join(root, "hooks")]);
		writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
		git(repo, ["add", "a.ts"]);
		git(repo, ["commit", "-m", "chore: start"]);
		git(repo, ["remote", "add", "origin", remote]);
		git(repo, ["push", "-u", "origin", "main"]);
		prefs = { commit: { mode: "direct" }, push: { mode: "instructions", instructions: "" } };
		records = [];
		completeSimple = vi.fn();
		const backgroundGit = new Set<AbortController>();
		const settingsManager = {
			isProjectTrusted: () => true,
			getCommitDescriptionSettings: () => ({}),
			getGitCommitSettings: () => ({
				mode: prefs.commit.mode ?? "instructions",
				skipHooks: prefs.commit.skipHooks === true,
				...(prefs.commit.instructions !== undefined ? { instructions: prefs.commit.instructions } : {}),
			}),
			getGitPushSettings: () => ({
				mode: prefs.push.mode ?? "instructions",
				...(prefs.push.instructions !== undefined ? { instructions: prefs.push.instructions } : {}),
			}),
			setGitCommitSettings: (change: Prefs["commit"]) => Object.assign(prefs.commit, change),
			setGitPushSettings: (change: Prefs["push"]) => Object.assign(prefs.push, change),
			flush: async () => {},
			getNetworkTimeouts: () => ({
				connectTimeoutMs: 10_000,
				firstByteTimeoutMs: 60_000,
				streamIdleTimeoutMs: 60_000,
			}),
			getNetworkMaxAttempts: () => 1,
			getFallbackModelSettings: () => ({ enabled: false }),
			getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 2_000 }),
			getProviderRetrySettings: () => ({ maxRetries: undefined, maxRetryDelayMs: 60_000 }),
		};
		const session = {
			isStreaming: false,
			isCompacting: false,
			isIdle: true,
			sessionId: "session-1",
			sessionManager: {
				getCwd: () => repo,
				appendCustomEntry: (customType: string, data: Record<string, unknown>) => {
					records.push({ customType, data });
					return `entry-${records.length}`;
				},
			},
			settingsManager,
			model: { id: "model", provider: "p" },
			modelRuntime: { completeSimple },
			getGitCheckpoint: () => undefined,
		};
		const host = {
			slotId: "s1",
			session,
			completionActive: false,
			backgroundGit,
			openCheckpoint: () => undefined,
			broadcast: vi.fn(),
			refreshConversationNaming: vi.fn(),
			runtimeHost: { services: { agentDir: join(root, "agent") } },
		} as unknown as WebHost;
		server = new WebHttpServer();
		registerGitRoutes(server, host);
		port = (await server.listen(0)).port;
		// Nine git processes build the repository; with the whole suite running on Windows they outlast the 10 s hook default.
	}, 60_000);

	afterEach(async () => {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("commits directly with a message from the file list and no model request", async () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\nexport function grow() {}\n");
		writeFileSync(join(repo, "b.md"), "# B\n");
		const result = await call("/api/git/commit");
		expect(result.body).toMatchObject({ status: "committed", mode: "direct" });
		expect(completeSimple).not.toHaveBeenCalled();
		const message = git(repo, ["log", "-1", "--format=%B"]);
		expect(message).toContain("- M a.ts (+2/-1)");
		expect(message).toContain("- A b.md (+1/-0)");
		expect(git(repo, ["status", "--porcelain"])).toBe("");
	});

	it("skips Git hooks in direct mode only when the user turned it on", async () => {
		writeFileSync(join(root, "hooks", "pre-commit"), "#!/bin/sh\necho blocked by hook >&2\nexit 1\n", {
			mode: 0o755,
		});
		writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
		const blocked = await call("/api/git/commit");
		expect(blocked.body).toMatchObject({ status: "failed" });
		expect(blocked.body.failure).toContain("blocked by hook");
		prefs.commit.skipHooks = true;
		const skipped = await call("/api/git/commit");
		expect(skipped.body).toMatchObject({ status: "committed" });
	});

	it("answers a push at once and adds the CI result as a card afterwards", async () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 4;\n");
		git(repo, ["commit", "-am", "feat: four"]);
		const head = git(repo, ["rev-parse", "HEAD"]);
		const pushed = await call("/api/git/push");
		expect(pushed.body).toMatchObject({ status: "pushed", mode: "instructions", ciFollowUp: true });
		expect(git(repo, ["rev-parse", "origin/main"])).toBe(head);
		// The local bare remote has no GitHub Actions: the follow-up says so instead of claiming CI passed.
		await vi.waitFor(() => expect(records).toHaveLength(1), { timeout: 10_000 });
		expect(records[0]).toMatchObject({
			customType: "web-git-status",
			data: { tone: "warn", title: "CI could not be checked", operation: "ci", hash: head.slice(0, 7) },
		});
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("pushes directly with no CI follow-up when asked for this push", async () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 5;\n");
		git(repo, ["commit", "-am", "feat: five"]);
		const pushed = await call("/api/git/push", { mode: "direct" });
		expect(pushed.body).toMatchObject({ status: "pushed", mode: "direct", ciFollowUp: false });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(records).toEqual([]);
	});

	it("stops a push the push instructions object to, before anything is pushed", async () => {
		prefs.push.instructions = "Never push a file that contains PASSWORD=.";
		completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"stop":"a.ts sets PASSWORD=","fixCi":false}' }],
		});
		writeFileSync(join(repo, "a.ts"), "PASSWORD=hunter2\n");
		git(repo, ["commit", "-am", "feat: secret"]);
		const before = git(repo, ["rev-parse", "origin/main"]);
		const pushed = await call("/api/git/push");
		expect(pushed.body.status).toBe("blocked");
		expect(pushed.body.reason).toContain("a.ts sets PASSWORD=");
		expect(git(repo, ["rev-parse", "origin/main"])).toBe(before);
		const [, request] = completeSimple.mock.calls[0]!;
		expect(JSON.parse(request.messages[0].content)).toMatchObject({ operation: "push", paths: ["a.ts"] });
		expect(request.messages[0].content).toContain("PASSWORD=hunter2");
	});

	it("saves modes and instructions, and null goes back to the built-in instructions", async () => {
		const initial = await call("/api/git/preferences", undefined, "GET");
		expect(initial.body.commit).toMatchObject({ mode: "direct", isDefault: true });
		expect(initial.body.commit.instructions).toBe("");
		expect(initial.body.commit.defaultInstructions).not.toBe("");
		expect(initial.body.push.instructions).toBe("");
		expect(
			(await call("/api/git/preferences", { commit: { mode: "instructions", instructions: "Mine" } })).status,
		).toBe(200);
		expect(prefs.commit).toMatchObject({ mode: "instructions", instructions: "Mine" });
		await call("/api/git/preferences", { commit: { instructions: null } });
		expect(prefs.commit.instructions).toBeUndefined();
		expect((await call("/api/git/preferences", { push: { mode: "fast" } })).status).toBe(400);
		expect((await call("/api/git/preferences", { other: {} })).status).toBe(400);
	});
});
