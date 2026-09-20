import { describe, expect, it } from "vitest";
import {
	fromFileUri,
	getDocumentIdentity,
	getWorkspaceIdentity,
	isInsideWorkspace,
	normalizeDocumentPath,
	normalizeWorkspaceRoot,
	relativeToWorkspace,
	samePath,
	toFileUri,
} from "../../src/symbols/path-semantics.ts";

describe("Windows Code Intelligence path contract", () => {
	const workspace = String.raw`C:\Project`;

	it("normalizes equivalent workspace roots to one identity", () => {
		expect(getWorkspaceIdentity(workspace)).toBe(getWorkspaceIdentity("c:/PROJECT"));
		expect(getWorkspaceIdentity(String.raw`C:\PROJECT\.`)).toBe(getWorkspaceIdentity(workspace));
		expect(normalizeWorkspaceRoot("c:/PROJECT")).toBe("c:\\PROJECT");
	});

	it("normalizes equivalent documents and file URIs to one identity", () => {
		const first = normalizeDocumentPath(String.raw`C:\Project\src\a.ts`, workspace);
		const second = normalizeDocumentPath(String.raw`c:\project\SRC\a.ts`, workspace);
		const third = normalizeDocumentPath("C:/PROJECT/src/a.ts", workspace);
		const uriPath = normalizeDocumentPath("file:///C:/Project/src/a.ts", workspace);

		expect(first).toBe(String.raw`C:\Project\src\a.ts`);
		expect(getDocumentIdentity(first, workspace)).toBe(getDocumentIdentity(second, workspace));
		expect(getDocumentIdentity(second, workspace)).toBe(getDocumentIdentity(third, workspace));
		expect(getDocumentIdentity(third, workspace)).toBe(getDocumentIdentity(uriPath, workspace));
		expect(samePath(first, "file:///C:/Project/src/a.ts", workspace)).toBe(true);
	});

	it("returns forward-slash workspace-relative paths", () => {
		expect(relativeToWorkspace(workspace, String.raw`c:\project\src\a.ts`)).toBe("src/a.ts");
		expect(relativeToWorkspace(workspace, "file:///C:/Project/src/a.ts")).toBe("src/a.ts");
	});

	it("enforces workspace boundaries after normalization", () => {
		for (const inside of [String.raw`C:\Project\src\a.ts`, String.raw`c:\project\src\a.ts`, "C:/PROJECT/src/a.ts"]) {
			expect(isInsideWorkspace(workspace, inside)).toBe(true);
		}
		for (const outside of [
			String.raw`C:\Project2\a.ts`,
			String.raw`C:\Other\a.ts`,
			String.raw`D:\Project\a.ts`,
			String.raw`C:\Project\..\Other\a.ts`,
		]) {
			expect(isInsideWorkspace(workspace, outside)).toBe(false);
		}
		expect(isInsideWorkspace(workspace, workspace)).toBe(true);
	});

	it("round-trips Windows URI paths without duplicate drive segments", () => {
		const path = String.raw`C:\project\src\a.ts`;
		const uri = toFileUri(path);
		expect(uri).toBe("file:///C:/project/src/a.ts");
		expect(fromFileUri(uri)).toBe(path);
		expect(toFileUri("/C:/project/src/a.ts")).toBe(uri);
	});

	it("preserves special characters through standard URL encoding", () => {
		const path = String.raw`C:\my project\测试#1\100%\a.ts`;
		const uri = toFileUri(path);
		expect(uri).toContain("my%20project");
		expect(uri).toContain("%E6%B5%8B%E8%AF%95%231");
		expect(uri).toContain("100%25");
		expect(fromFileUri(uri)).toBe(path);
	});

	it("supports UNC paths with a URI authority", () => {
		const path = String.raw`\\server\share\src\a.ts`;
		const uri = toFileUri(path);
		expect(uri).toBe("file://server/share/src/a.ts");
		expect(fromFileUri(uri)).toBe(path);
		expect(getDocumentIdentity(path)).toBe(getDocumentIdentity(uri));
	});
});
