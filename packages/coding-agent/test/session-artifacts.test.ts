import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionConversationPath, getSessionDir, parseSessionDataPath } from "../src/config/paths/index.ts";
import {
	deleteWorkspaceArtifacts,
	ensureSessionArtifacts,
	listArtifacts,
	refreshArtifactIndexes,
	refreshArtifactIndexesIfChanged,
	resolveArtifact,
} from "../src/session/artifacts/store.ts";
import { deleteSessionFile } from "../src/session/storage/jsonl/file-operations.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(workspaceId = "workspace-a", sessionId = "session-a", dataRoot?: string) {
	const data = dataRoot ?? mkdtempSync(join(tmpdir(), "myharness-artifacts-"));
	if (!dataRoot) roots.push(data);
	const file = getSessionConversationPath(data, workspaceId, sessionId, "chat.jsonl");
	const scope = parseSessionDataPath(file)!;
	const artifacts = ensureSessionArtifacts(scope);
	mkdirSync(scope.conversationDir, { recursive: true });
	writeFileSync(file, "private chat");
	writeFileSync(join(artifacts, "reports", "report.md"), "report");
	return { data, file, scope, artifacts, session: getSessionDir(data, workspaceId, sessionId) };
}

describe("conversation artifacts", () => {
	it("creates one stored copy with workspace/global references and safe resolution", () => {
		const a = fixture();
		fixture("workspace-b", "session-b", a.data);
		const entries = refreshArtifactIndexes(a.data);
		expect(entries).toHaveLength(2);
		expect(listArtifacts(a.data, { workspaceId: "workspace-a", sessionId: "session-a" })).toHaveLength(1);
		const global = JSON.parse(readFileSync(join(a.data, "artifacts", "index.json"), "utf8"));
		expect(global.entries).toHaveLength(2);
		expect(existsSync(join(a.data, "artifacts", "report.md"))).toBe(false);
		expect(resolveArtifact(a.data, entries[0]!.path)).toContain("report.md");
		expect(() => resolveArtifact(a.data, "../private.txt")).toThrow();
	});
	it("keeps artifacts and provenance by default, removes chat and uploads", async () => {
		const a = fixture();
		mkdirSync(join(a.session, "tool-results"));
		writeFileSync(join(a.session, "tool-results", "result.txt"), "private output");
		mkdirSync(join(a.scope.conversationDir, "uploads"));
		writeFileSync(join(a.scope.conversationDir, "uploads", "input.txt"), "attachment");
		expect((await deleteSessionFile(a.file, { permanent: true })).ok).toBe(true);
		expect(existsSync(a.file)).toBe(false);
		expect(existsSync(join(a.session, "tool-results"))).toBe(false);
		expect(existsSync(join(a.session, "metadata", "artifacts-origin.json"))).toBe(true);
		expect(listArtifacts(a.data)[0]!.conversationDeleted).toBe(true);
		expect(readFileSync(join(a.artifacts, "reports", "report.md"), "utf8")).toBe("report");
	});
	it("explicit deletion removes only the target artifacts and parent references", async () => {
		const a = fixture();
		const b = fixture("workspace-a", "session-b", a.data);
		expect((await deleteSessionFile(a.file, { permanent: true, deleteArtifacts: true })).ok).toBe(true);
		expect(existsSync(a.session)).toBe(false);
		expect(listArtifacts(a.data).map((entry) => entry.sessionId)).toEqual(["session-b"]);
		expect(existsSync(b.file)).toBe(true);
	});
	it("workspace artifact deletion preserves chats and other workspaces", () => {
		const a = fixture();
		const b = fixture("workspace-b", "session-b", a.data);
		deleteWorkspaceArtifacts(a.data, "workspace-a");
		expect(existsSync(a.file)).toBe(true);
		expect(existsSync(a.artifacts)).toBe(false);
		expect(existsSync(b.artifacts)).toBe(true);
		expect(listArtifacts(a.data)).toHaveLength(1);
	});
	describe("derived index refresh", () => {
		const indexFiles = (data: string, workspaceId: string) => [
			join(data, "artifacts", "index.json"),
			join(data, "artifacts", "README.md"),
			join(data, "workspaces", workspaceId, "artifacts", "index.json"),
			join(data, "workspaces", workspaceId, "artifacts", "README.md"),
		];
		const contents = (files: string[]) => files.map((file) => readFileSync(file, "utf8"));
		const age = (files: string[]) => {
			const past = new Date(Date.now() - 60_000);
			for (const file of files) utimesSync(file, past, past);
			return files.map((file) => statSync(file).mtimeMs);
		};

		it("does not rewrite derived files whose content is unchanged", () => {
			const a = fixture();
			fixture("workspace-b", "session-b", a.data);
			refreshArtifactIndexes(a.data);
			const files = indexFiles(a.data, "workspace-a");
			const before = age(files);
			refreshArtifactIndexes(a.data);
			expect(files.map((file) => statSync(file).mtimeMs)).toEqual(before);
		});

		it("leaves everything alone after a tool run that touched no artifact", () => {
			const a = fixture();
			refreshArtifactIndexesIfChanged(a.scope);
			const files = indexFiles(a.data, "workspace-a");
			const before = age(files);
			refreshArtifactIndexesIfChanged(a.scope);
			refreshArtifactIndexesIfChanged(a.scope);
			expect(files.map((file) => statSync(file).mtimeMs)).toEqual(before);
		});

		it("does nothing for a session that never had an artifact", () => {
			const a = fixture();
			const empty = fixture("workspace-b", "session-b", a.data);
			rmSync(join(empty.artifacts, "reports", "report.md"));
			refreshArtifactIndexesIfChanged(empty.scope);
			expect(existsSync(join(a.data, "artifacts", "index.json"))).toBe(false);
		});

		it("replaces only the session's own entries and ends up as a full refresh would", () => {
			const a = fixture();
			const b = fixture("workspace-b", "session-b", a.data);
			refreshArtifactIndexesIfChanged(a.scope);
			refreshArtifactIndexesIfChanged(b.scope);
			// The tool of session A writes a new artifact and removes the old one.
			writeFileSync(join(a.artifacts, "tests", "result.txt"), "result");
			rmSync(join(a.artifacts, "reports", "report.md"));
			refreshArtifactIndexesIfChanged(a.scope);
			const global = JSON.parse(readFileSync(join(a.data, "artifacts", "index.json"), "utf8"));
			expect(global.entries.map((entry: { name: string }) => entry.name).sort()).toEqual([
				"reports/report.md",
				"tests/result.txt",
			]);
			const incremental = contents([...indexFiles(a.data, "workspace-a"), ...indexFiles(a.data, "workspace-b")]);
			refreshArtifactIndexes(a.data);
			expect(contents([...indexFiles(a.data, "workspace-a"), ...indexFiles(a.data, "workspace-b")])).toEqual(
				incremental,
			);
		});

		it("updates only the deleted chat's entries in the indexes and leaves other workspaces alone", async () => {
			const a = fixture();
			const b = fixture("workspace-b", "session-b", a.data);
			refreshArtifactIndexes(a.data);
			const owners = (file: string) =>
				JSON.parse(readFileSync(file, "utf8")).entries.map(
					(entry: { sessionId: string; conversationDeleted: boolean }) =>
						`${entry.sessionId}${entry.conversationDeleted ? " (deleted)" : ""}`,
				);
			const globalIndex = join(a.data, "artifacts", "index.json");
			const untouched = indexFiles(a.data, "workspace-b").slice(2);
			const before = age(untouched);
			// Default deletion keeps the artifacts and marks them as belonging to a deleted chat.
			expect((await deleteSessionFile(a.file, { permanent: true })).ok).toBe(true);
			expect(owners(globalIndex).sort()).toEqual(["session-a (deleted)", "session-b"]);
			expect(owners(indexFiles(a.data, "workspace-a")[2]!)).toEqual(["session-a (deleted)"]);
			expect(untouched.map((file) => statSync(file).mtimeMs)).toEqual(before);
			// Explicit deletion removes the entries with the files.
			expect((await deleteSessionFile(b.file, { permanent: true, deleteArtifacts: true })).ok).toBe(true);
			expect(owners(globalIndex)).toEqual(["session-a (deleted)"]);
			expect(owners(indexFiles(a.data, "workspace-b")[2]!)).toEqual([]);
		});

		it("falls back to a full refresh when the global index cannot be used", () => {
			const a = fixture();
			const b = fixture("workspace-b", "session-b", a.data);
			refreshArtifactIndexes(a.data);
			writeFileSync(join(a.data, "artifacts", "index.json"), "{ not json");
			writeFileSync(join(b.artifacts, "tests", "result.txt"), "result");
			refreshArtifactIndexesIfChanged(b.scope);
			const global = JSON.parse(readFileSync(join(a.data, "artifacts", "index.json"), "utf8"));
			expect(global.entries).toHaveLength(3);
		});
	});

	it("resolves an artifact through its own session and refuses a path that names another one", () => {
		const a = fixture();
		const b = fixture("workspace-b", "session-b", a.data);
		const [theirs] = listArtifacts(a.data, { workspaceId: "workspace-b", sessionId: "session-b" });
		expect(resolveArtifact(a.data, theirs!.path)).toBe(resolve(b.artifacts, "reports", "report.md"));
		expect(() => resolveArtifact(a.data, theirs!.path.replace("session-b", "session-a"))).toThrow("Unknown artifact");
		expect(() => resolveArtifact(a.data, "workspaces/workspace-b")).toThrow("Unknown artifact");
		expect(() => resolveArtifact(a.data, "")).toThrow("Unknown artifact");
	});

	it("refuses destructive traversal through junctions", async () => {
		const a = fixture();
		const external = mkdtempSync(join(tmpdir(), "myharness-artifact-external-"));
		roots.push(external);
		writeFileSync(join(external, "keep.txt"), "keep");
		symlinkSync(external, join(a.artifacts, "linked"), process.platform === "win32" ? "junction" : "dir");
		expect((await deleteSessionFile(a.file, { permanent: true, deleteArtifacts: true })).ok).toBe(false);
		expect(existsSync(a.file)).toBe(true);
		expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("keep");
		expect(listArtifacts(a.data)).toHaveLength(1);
	});

	it("still refuses a junction when one walk lists many sessions (each folder is checked once per walk)", () => {
		const a = fixture();
		const b = fixture("workspace-b", "session-b", a.data);
		const external = mkdtempSync(join(tmpdir(), "myharness-artifact-external-"));
		roots.push(external);
		writeFileSync(join(external, "outside.md"), "outside");
		rmSync(b.artifacts, { recursive: true });
		symlinkSync(external, b.artifacts, process.platform === "win32" ? "junction" : "dir");
		expect(() => listArtifacts(a.data)).toThrow("symbolic link or junction");
		expect(() => refreshArtifactIndexes(a.data)).toThrow("symbolic link or junction");
		expect(listArtifacts(a.data, { workspaceId: "workspace-a", sessionId: "session-a" })).toHaveLength(1);
	});
});
