import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionConversationPath, getSessionDir, parseSessionDataPath } from "../src/config/paths/index.ts";
import {
	deleteWorkspaceArtifacts,
	ensureSessionArtifacts,
	listArtifacts,
	refreshArtifactIndexes,
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
});
