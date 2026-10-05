import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/git/repository/integration.ts", () => ({ runGitAsync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), readFile: vi.fn() }));

import { lstat, readFile } from "node:fs/promises";
import { generateAICommitMessage, readCommitMessageContext } from "../src/git/commits/ai-message.ts";
import { runGitAsync } from "../src/git/repository/integration.ts";

const ok = (stdout: string) => ({ ok: true, args: [], stdout, stderr: "", exitCode: 0 });
beforeEach(() => vi.resetAllMocks());
it("includes tracked delta, new files, and recent history with literal path filters", async () => {
	vi.mocked(runGitAsync)
		.mockResolvedValueOnce(ok("tracked diff"))
		.mockResolvedValueOnce(ok("new [file].ts\0"))
		.mockResolvedValueOnce(ok("feat: previous feature\0"));
	vi.mocked(lstat).mockResolvedValue({ isFile: () => true, size: 20 } as Awaited<ReturnType<typeof lstat>>);
	vi.mocked(readFile).mockResolvedValue(Buffer.from("export const added = 1;"));
	const context = await readCommitMessageContext("repo", ["old.ts", "new [file].ts"]);
	expect(context.paths).toEqual(["old.ts", "new [file].ts"]);
	expect(context.diff).toContain("tracked diff");
	expect(context.diff).toContain("export const added = 1;");
	expect(context.history).toContain("previous feature");
	expect(vi.mocked(runGitAsync).mock.calls[0]![1]).toContain(":(literal)new [file].ts");
});
it("reads a diff beyond the former 300 KiB cap without dropping content", async () => {
	const diff = "x".repeat(301 * 1024);
	vi.mocked(runGitAsync)
		.mockResolvedValueOnce(ok(diff))
		.mockResolvedValueOnce(ok(""))
		.mockResolvedValueOnce(ok("history"));
	expect((await readCommitMessageContext("repo", ["large.ts"])).diff).toBe(diff);
});
it("includes a new file beyond the former cap in full", async () => {
	const content = "new feature\n".repeat(30_000);
	vi.mocked(runGitAsync)
		.mockResolvedValueOnce(ok(""))
		.mockResolvedValueOnce(ok("large.ts\0"))
		.mockResolvedValueOnce(ok("history"));
	vi.mocked(lstat).mockResolvedValue({ isFile: () => true, size: Buffer.byteLength(content) } as Awaited<
		ReturnType<typeof lstat>
	>);
	vi.mocked(readFile).mockResolvedValue(Buffer.from(content));
	expect((await readCommitMessageContext("repo", ["large.ts"])).diff).toContain(content);
});
it("does not generate from an unreadable diff", async () => {
	vi.mocked(runGitAsync).mockResolvedValue({ ...ok(""), ok: false, stderr: "read failed" });
	await expect(readCommitMessageContext("repo", ["file"])).rejects.toThrow("read failed");
});
it("accepts a detailed description and passes only diff/history data to the model", async () => {
	const context = { paths: ["a", "b"], diff: "feature A and B", history: "style reference" };
	const complete = vi
		.fn()
		.mockResolvedValue(
			JSON.stringify({ title: "feat: improve A and B", body: ["- Explain feature A", "- Explain feature B"] }),
		);
	const result = await generateAICommitMessage(context, complete);
	expect(result.full).toBe("feat: improve A and B\n\n- Explain feature A\n- Explain feature B");
	expect(JSON.parse(complete.mock.calls[0]![1])).toEqual(context);
});
it.each([
	{ title: "feat: change", body: ["Co-Authored-By: AI <ai@example.com>"] },
	{ title: "feat: change", body: ["Generated with Claude"] },
	{ title: "feat: change", body: [] },
	{ title: "feat: change\nInjected title", body: ["description"] },
])("rejects attribution and invalid descriptions: %j", async (value) => {
	await expect(
		generateAICommitMessage({ paths: [], diff: "", history: "" }, async () => JSON.stringify(value)),
	).rejects.toThrow();
});
