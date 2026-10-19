import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCommitUseCase } from "../src/application/use-cases/git-commit.ts";
import { ChangeClaimRegistry } from "../src/modes/web/change-claims.ts";
import { ChangeTracker } from "../src/modes/web/changes.ts";
import { registerGitRoutes } from "../src/modes/web/routes-git.ts";
import { attributeConversationFiles } from "../src/modes/web/session-ownership.ts";
import { runGitSync } from "../src/utils/git-command.ts";
import { pathIdentityKey } from "../src/utils/paths.ts";

const temporaryDirectories: string[] = [];

/** The write time every test works from: old enough to place records before and after it. */
const WRITTEN_AT = Date.now() - 60_000;

function createRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "myharness-session-ownership-"));
	temporaryDirectories.push(dir);
	runGitSync(["init", "-q"], { cwd: dir });
	runGitSync(["config", "core.autocrlf", "false"], { cwd: dir });
	runGitSync(["config", "core.hooksPath", ""], { cwd: dir });
	runGitSync(["config", "user.name", "Test User"], { cwd: dir });
	runGitSync(["config", "user.email", "test@example.com"], { cwd: dir });
	writeFileSync(path.join(dir, "a.ts"), "v1\n", "utf8");
	writeFileSync(path.join(dir, "b.ts"), "v1\n", "utf8");
	runGitSync(["add", "."], { cwd: dir });
	runGitSync(["commit", "-q", "-m", "init"], { cwd: dir });
	// Both files are now uncommitted work with a known last write time.
	for (const file of ["a.ts", "b.ts"]) {
		writeFileSync(path.join(dir, file), "v2\n", "utf8");
		utimesSync(path.join(dir, file), new Date(WRITTEN_AT), new Date(WRITTEN_AT));
	}
	return dir;
}

const claim = (sessionKey: string, repo: string, file: string, at: number) => ({
	sessionKey,
	runId: 1,
	path: path.join(repo, file),
	at,
	tool: "edit",
});

afterEach(() => {
	for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which conversation owns an uncommitted file", () => {
	it("keeps files no other conversation touched, and skips the ones that are not uncommitted", async () => {
		const repo = createRepo();
		const attribution = await attributeConversationFiles({
			sessionKey: "chat-a",
			conversationPaths: ["a.ts", "gone.ts"],
			cwd: repo,
			dirtyPaths: ["a.ts", "b.ts"],
		});
		expect(attribution.own).toEqual(["a.ts"]);
		expect([...attribution.elsewhere]).toEqual([]);
	});

	it("leaves a file to the conversation that changed it last", async () => {
		const repo = createRepo();
		const registry = new ChangeClaimRegistry();
		registry.record(claim("chat-b", repo, "a.ts", WRITTEN_AT + 1_000));
		const attribution = await attributeConversationFiles({
			sessionKey: "chat-a",
			conversationPaths: ["a.ts", "b.ts"],
			cwd: repo,
			dirtyPaths: ["a.ts", "b.ts"],
			registry,
		});
		expect(attribution.own).toEqual(["b.ts"]);
		expect([...attribution.elsewhere]).toEqual([pathIdentityKey(path.join(repo, "a.ts"))]);
	});

	it("takes the file back when this conversation changed it after the other one", async () => {
		const repo = createRepo();
		const registry = new ChangeClaimRegistry();
		registry.record(claim("chat-b", repo, "a.ts", WRITTEN_AT - 5_000));
		registry.record(claim("chat-a", repo, "a.ts", WRITTEN_AT - 1_000));
		const attribution = await attributeConversationFiles({
			sessionKey: "chat-a",
			conversationPaths: ["a.ts"],
			cwd: repo,
			dirtyPaths: ["a.ts"],
			registry,
		});
		expect(attribution.own).toEqual(["a.ts"]);
		expect(attribution.elsewhere.size).toBe(0);
	});

	it("counts a file whose last write was not recorded as this conversation's", async () => {
		const repo = createRepo();
		const registry = new ChangeClaimRegistry();
		// Older than the write on disk: something else wrote the file afterwards, so no conversation explains it.
		registry.record(claim("chat-b", repo, "a.ts", WRITTEN_AT - 5_000));
		const attribution = await attributeConversationFiles({
			sessionKey: "chat-a",
			conversationPaths: ["a.ts"],
			cwd: repo,
			dirtyPaths: ["a.ts"],
			registry,
		});
		expect(attribution.own).toEqual(["a.ts"]);
	});

	it("counts a shell change by the conversation whose command window covers the write", async () => {
		const repo = createRepo();
		const registry = new ChangeClaimRegistry();
		registry.recordShell({
			sessionKey: "chat-b",
			runId: 1,
			startedAt: WRITTEN_AT - 1_000,
			endedAt: WRITTEN_AT + 1_000,
		});
		const forChatA = await attributeConversationFiles({
			sessionKey: "chat-a",
			conversationPaths: ["a.ts"],
			cwd: repo,
			dirtyPaths: ["a.ts"],
			registry,
		});
		expect(forChatA.own).toEqual([]);
		expect(forChatA.elsewhere.size).toBe(1);
		// The same window seen from the conversation that ran the command.
		const forChatB = await attributeConversationFiles({
			sessionKey: "chat-b",
			conversationPaths: ["a.ts"],
			cwd: repo,
			dirtyPaths: ["a.ts"],
			registry,
		});
		expect(forChatB.own).toEqual(["a.ts"]);
	});
});

describe("a commit limited to a conversation's own files", () => {
	it("only reports the allowed paths of the working tree", async () => {
		const repo = createRepo();
		const useCase = new GitCommitUseCase({
			updatePhase: () => {},
			generateMessage: async () => ({ title: "", body: [], full: "" }) as never,
		});
		expect((await useCase.readPendingPaths({ repositoryRoot: repo, only: ["a.ts"] })).paths).toEqual(["a.ts"]);
		// A path that is not uncommitted, and one outside the allowed list, never reach the commit.
		expect((await useCase.readPendingPaths({ repositoryRoot: repo, only: ["b.ts"] })).paths).toEqual(["b.ts"]);
		expect((await useCase.readPendingPaths({ repositoryRoot: repo, only: [] })).paths).toEqual([]);
		expect((await useCase.readPendingPaths({ repositoryRoot: repo })).paths?.sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("commits nothing when this chat has no uncommitted file of its own", async () => {
		const repo = createRepo();
		const routes = new Map<string, (context: { url: URL; body: unknown }) => unknown>();
		const host = {
			cwd: repo,
			slotId: "slot",
			completionActive: false,
			tracker: new ChangeTracker(repo),
			changeClaims: new ChangeClaimRegistry(),
			openCheckpoint: () => undefined,
			broadcast: vi.fn(),
			runtimeHost: { services: { agentDir: path.join(repo, ".agent") } },
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionId: "chat-a",
				// A chat that recorded no change: both working-tree files belong to someone else.
				sessionManager: { getCwd: () => repo, getBranch: () => [] },
				settingsManager: { isProjectTrusted: () => true },
			},
		};
		registerGitRoutes(
			{
				route: (method: string, pattern: string, handler: (context: { url: URL; body: unknown }) => unknown) =>
					routes.set(`${method} ${pattern}`, handler),
			} as never,
			host as never,
		);
		const result = await routes.get("POST /api/git/commit")!({
			url: new URL("http://localhost/api/git/commit"),
			body: { scope: "session" },
		});
		expect(result).toMatchObject({ status: "no-changes", scope: "session" });
		// Nothing was staged or committed: the working tree is exactly as it was.
		expect(runGitSync(["status", "--porcelain"], { cwd: repo }).stdout).toContain("a.ts");
		expect(runGitSync(["status", "--porcelain"], { cwd: repo }).stdout).toContain("b.ts");
	});
});
