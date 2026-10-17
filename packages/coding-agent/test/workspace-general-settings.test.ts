import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getSessionUploadDir,
	getWorkspaceMetadataPath,
	getWorkspaceRegistryPath,
	getWorkspaceUploadsDir,
} from "../src/config/paths/index.ts";
import {
	deleteWorkspaceSource,
	finishWorkspaceSourceUpload,
	listWorkspaceSources,
	readWorkspaceSourceTree,
	type StagedWorkspaceSourceUpload,
	stageWorkspaceSourceUploads,
	uploadWorkspaceSource,
	type WorkspaceSourceUploadItem,
	writeWorkspaceSourceChunk,
} from "../src/data/workspace-sources.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";

describe("General workspace settings and sources", () => {
	it("dual-writes settings, survives reopen and registry-authoritative reconcile, isolates chat uploads", () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "general-settings-"));
		try {
			const data = join(root, "data"),
				project = join(root, "project"),
				agent = join(root, "agent");
			mkdirSync(project);
			const store = WorkspaceStore.create(agent, data);
			const workspace = store.add(project, root, true, "general").workspace!;
			const settings = {
				name: "Named workspace",
				instructions: "First line\nSecond line",
				memoryEnabled: false,
				libraryEnabled: false,
			};
			expect(store.updateGeneralSettings(workspace.workspaceId, settings)).toBe(true);
			const registry = JSON.parse(readFileSync(getWorkspaceRegistryPath(data), "utf8"));
			expect(registry.version).toBe(3);
			expect(registry.workspaces[0]).toMatchObject(settings);
			const metadata = getWorkspaceMetadataPath(data, workspace.workspaceId);
			writeFileSync(metadata, JSON.stringify({ version: 1, workspace }));
			const reopened = WorkspaceStore.create(agent, data);
			reopened.reconcileMetadataNow();
			expect(reopened.getById(workspace.workspaceId)).toMatchObject(settings);
			expect(JSON.parse(readFileSync(metadata, "utf8"))).toMatchObject({ version: 2, workspace: settings });
			const chatRoot = getSessionUploadDir(data, workspace.workspaceId, "chat");
			mkdirSync(chatRoot, { recursive: true });
			writeFileSync(join(chatRoot, "keep.txt"), "chat attachment");
			const source = uploadWorkspaceSource(
				data,
				workspace.workspaceId,
				"source.md",
				Buffer.from("shared source").toString("base64"),
			);
			expect(listWorkspaceSources(data, workspace.workspaceId)).toEqual([source]);
			expect(readFileSync(source.path, "utf8")).toBe("shared source");
			expect(readFileSync(join(chatRoot, "keep.txt"), "utf8")).toBe("chat attachment");
			expect(listWorkspaceSources(data, "other")).toEqual([]);
			expect(() => uploadWorkspaceSource(data, workspace.workspaceId, "bad.txt", "?bad")).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deletes only one source's own directory and refuses malformed, missing or linked sources", () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "general-sources-delete-"));
		try {
			const data = join(root, "data");
			const workspaceId = "ws-delete";
			const chatRoot = getSessionUploadDir(data, workspaceId, "chat");
			mkdirSync(chatRoot, { recursive: true });
			writeFileSync(join(chatRoot, "keep.txt"), "chat attachment");
			const upload = (name: string) =>
				uploadWorkspaceSource(data, workspaceId, name, Buffer.from(name).toString("base64"));
			const first = upload("first.md");
			const second = upload("second.md");
			expect(first.modified).toBeGreaterThan(0);
			deleteWorkspaceSource(data, workspaceId, first.id);
			expect(existsSync(join(getWorkspaceUploadsDir(data, workspaceId), first.id))).toBe(false);
			expect(listWorkspaceSources(data, workspaceId)).toEqual([second]);
			expect(readFileSync(join(chatRoot, "keep.txt"), "utf8")).toBe("chat attachment");
			expect(() => deleteWorkspaceSource(data, workspaceId, first.id)).toThrow(
				expect.objectContaining({ code: "not_found" }),
			);
			for (const bad of ["..", "", "x".repeat(36), `${second.id}/..`])
				expect(() => deleteWorkspaceSource(data, workspaceId, bad)).toThrow(
					expect.objectContaining({ code: "invalid" }),
				);
			// A source directory that is a link is never followed or removed.
			const outside = join(root, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "precious.txt"), "keep");
			const linkedId = "00000000-0000-4000-8000-000000000000";
			symlinkSync(outside, join(getWorkspaceUploadsDir(data, workspaceId), linkedId), "junction");
			expect(() => deleteWorkspaceSource(data, workspaceId, linkedId)).toThrow(
				expect.objectContaining({ code: "refused" }),
			);
			expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep");
			expect(existsSync(join(getWorkspaceUploadsDir(data, workspaceId), linkedId))).toBe(true);
			expect(listWorkspaceSources(data, workspaceId)).toEqual([second]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	const sendAll = (upload: StagedWorkspaceSourceUpload, contents: string[], only?: number[]) => {
		for (const [index, text] of contents.entries()) {
			if (only && !only.includes(index)) continue;
			const bytes = Buffer.from(text);
			// Two chunks per file (one empty file stays one empty chunk): exercises in-order appends.
			const half = Math.floor(bytes.length / 2);
			if (half > 0) writeWorkspaceSourceChunk(upload, index, 0, bytes.subarray(0, half).toString("base64"));
			writeWorkspaceSourceChunk(upload, index, half, bytes.subarray(half).toString("base64"));
		}
	};

	it("stores a folder source in chunks, lists it as one entry, and deletes entries or the whole folder", () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "general-sources-folder-"));
		try {
			const data = join(root, "data");
			const workspaceId = "ws-folder";
			const kept = uploadWorkspaceSource(data, workspaceId, "kept.md", Buffer.from("kept").toString("base64"));
			const files = [
				{ path: "a.txt", text: "alpha" },
				{ path: "deep/b.zip", text: "PK\u0003\u0004 binary" },
				{ path: "deep/deeper/c.md", text: "" },
				{ path: ".git/HEAD", text: "ref: refs/heads/main" },
				{ path: "node_modules/x/index.js", text: "module.exports = 1;" },
			];
			const item: WorkspaceSourceUploadItem = {
				kind: "folder",
				name: "Project",
				files: files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.text) })),
			};
			const { problems, staged } = stageWorkspaceSourceUploads(data, workspaceId, [item]);
			expect(problems).toEqual([]);
			const upload = staged[0]!;
			// Staged folders are listed at once (with what has arrived so far): an interrupted batch keeps its files.
			sendAll(upload, files.map((file) => file.text), [0]);
			const partial = listWorkspaceSources(data, workspaceId).find((source) => source.id === upload.id);
			expect(partial).toMatchObject({ kind: "folder", name: "Project", fileCount: 1 });
			expect(() => finishWorkspaceSourceUpload(upload)).toThrow("Some files have not been uploaded yet.");
			// Continuing sends only the rest.
			sendAll(upload, files.map((file) => file.text), [1, 2, 3, 4]);
			const folder = finishWorkspaceSourceUpload(upload);
			expect(folder).toMatchObject({ kind: "folder", fileCount: 5, size: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0) });
			expect(readFileSync(join(folder.path, "deep", "b.zip"), "utf8")).toBe("PK\u0003\u0004 binary");
			expect(readFileSync(join(folder.path, "deep", "deeper", "c.md"), "utf8")).toBe("");
			expect(existsSync(join(upload.directory, "staging"))).toBe(false);
			const sources = listWorkspaceSources(data, workspaceId);
			expect(sources.map((source) => source.id).sort()).toEqual([kept.id, folder.id].sort());
			const tree = readWorkspaceSourceTree(data, workspaceId, folder.id);
			const deep = tree.find((node) => node.name === "deep")!;
			expect(deep).toMatchObject({ kind: "folder", path: "deep", fileCount: 2 });
			expect(deep.children!.find((node) => node.name === "deeper")!.children![0]).toMatchObject({
				kind: "file",
				path: "deep/deeper/c.md",
			});
			expect(readWorkspaceSourceTree(data, workspaceId, kept.id)).toEqual([]);

			deleteWorkspaceSource(data, workspaceId, folder.id, "deep/b.zip");
			expect(existsSync(join(folder.path, "deep", "b.zip"))).toBe(false);
			deleteWorkspaceSource(data, workspaceId, folder.id, "node_modules");
			expect(existsSync(join(folder.path, "node_modules"))).toBe(false);
			expect(listWorkspaceSources(data, workspaceId).find((source) => source.id === folder.id)?.fileCount).toBe(3);
			for (const bad of ["../x", "deep/../../x", "", "a\\b", "C:"])
				expect(() => deleteWorkspaceSource(data, workspaceId, folder.id, bad)).toThrow(
					expect.objectContaining({ code: "invalid" }),
				);
			expect(() => deleteWorkspaceSource(data, workspaceId, folder.id, "missing.txt")).toThrow(
				expect.objectContaining({ code: "not_found" }),
			);
			expect(() => deleteWorkspaceSource(data, workspaceId, kept.id, "kept.md")).toThrow(
				expect.objectContaining({ code: "invalid" }),
			);
			// A link inside a folder source refuses the whole delete and leaves both sides as they are.
			const outside = join(root, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "precious.txt"), "keep");
			symlinkSync(outside, join(folder.path, "linked"), "junction");
			expect(listWorkspaceSources(data, workspaceId).find((source) => source.id === folder.id)?.fileCount).toBe(3);
			expect(() => deleteWorkspaceSource(data, workspaceId, folder.id)).toThrow(
				expect.objectContaining({ code: "refused" }),
			);
			expect(() => deleteWorkspaceSource(data, workspaceId, folder.id, "linked")).toThrow(
				expect.objectContaining({ code: "refused" }),
			);
			expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep");
			expect(existsSync(join(folder.path, "a.txt"))).toBe(true);
			rmSync(join(folder.path, "linked"));
			deleteWorkspaceSource(data, workspaceId, folder.id);
			expect(existsSync(upload.directory)).toBe(false);
			expect(listWorkspaceSources(data, workspaceId)).toEqual([kept]);
			expect(readFileSync(kept.path, "utf8")).toBe("kept");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("checks a whole batch first and writes nothing when any file is too large or its path is invalid", () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "general-sources-check-"));
		try {
			const data = join(root, "data");
			const workspaceId = "ws-check";
			const uploads = getWorkspaceUploadsDir(data, workspaceId);
			const { problems, staged } = stageWorkspaceSourceUploads(data, workspaceId, [
				{ kind: "file", name: "ok.txt", files: [{ path: "ok.txt", size: 3 }] },
				{
					kind: "folder",
					name: "Folder",
					files: [
						{ path: "fine.txt", size: 1 },
						{ path: "sub/huge.iso", size: 500 * 1024 * 1024 + 1 },
						{ path: "../escape.txt", size: 1 },
					],
				},
			]);
			expect(staged).toEqual([]);
			expect(problems).toEqual([
				{ item: 1, path: "sub/huge.iso", reason: "too_large" },
				{ item: 1, path: "../escape.txt", reason: "invalid_path" },
			]);
			expect(existsSync(uploads) ? readdirSync(uploads) : []).toEqual([]);
			// Exactly 500 MiB is allowed.
			const exact = stageWorkspaceSourceUploads(data, workspaceId, [
				{ kind: "file", name: "max.bin", files: [{ path: "max.bin", size: 500 * 1024 * 1024 }] },
			]);
			expect(exact.problems).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cleans and shortens stored names so deep folders fit the Windows path limit and stay unique", () => {
		// The OS temp folder, not MYHARNESS_TEMP_DIR: the expected shortening depends on a short root.
		const root = mkdtempSync(join(tmpdir(), "sl-"));
		try {
			const data = join(root, "data");
			const workspaceId = "ws-long";
			const long = "n".repeat(70);
			const deep = Array.from({ length: 3 }, (_, i) => `${long}${i}`).join("/");
			const paths = [`${deep}/${"f".repeat(90)}-one.txt`, `${deep}/${"f".repeat(90)}-two.txt`, "CON.txt", "a:b?.md", "a_b_.md"];
			const { problems, staged } = stageWorkspaceSourceUploads(data, workspaceId, [
				{ kind: "folder", name: "Long", files: paths.map((path) => ({ path, size: 1 })) },
			]);
			expect(problems).toEqual([]);
			const upload = staged[0]!;
			const targets = upload.entries.map((entry) => entry.target);
			for (const target of targets) expect(target.length).toBeLessThanOrEqual(250);
			expect(new Set(targets.map((target) => target.toLowerCase())).size).toBe(targets.length);
			expect(upload.entries.map((entry) => entry.path)).toEqual(paths);
			expect(targets[2]).toMatch(/_CON\.txt$/);
			sendAll(upload, paths.map(() => "x"));
			expect(finishWorkspaceSourceUpload(upload).fileCount).toBe(5);
			// Too deep for any shortening: the batch is refused with the file named, and nothing is left behind.
			const tooDeep = Array.from({ length: 90 }, (_, i) => `d${i}`).join("/");
			const refused = stageWorkspaceSourceUploads(data, workspaceId, [
				{ kind: "folder", name: "Deep", files: [{ path: `${tooDeep}/x.txt`, size: 1 }] },
			]);
			expect(refused.problems).toEqual([{ item: 0, path: `${tooDeep}/x.txt`, reason: "path_too_long" }]);
			expect(readdirSync(getWorkspaceUploadsDir(data, workspaceId))).toEqual([upload.id]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps reading version 1 single-file sources and writes new single files in the same layout", () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "general-sources-v1-"));
		try {
			const data = join(root, "data");
			const workspaceId = "ws-v1";
			const legacyId = "11111111-2222-4333-8444-555555555555";
			const legacy = join(getWorkspaceUploadsDir(data, workspaceId), legacyId);
			mkdirSync(legacy, { recursive: true });
			writeFileSync(join(legacy, "source-old.txt"), "old bytes");
			const manifest = JSON.stringify({ version: 1, name: "old.txt", size: 9, storedName: "source-old.txt" });
			writeFileSync(join(legacy, "source.json"), manifest);
			const { staged } = stageWorkspaceSourceUploads(data, workspaceId, [
				{ kind: "file", name: "new.pdf", files: [{ path: "new.pdf", size: 4 }] },
			]);
			const upload = staged[0]!;
			// A single file is not listed before its bytes are complete.
			expect(listWorkspaceSources(data, workspaceId).map((source) => source.id)).toEqual([legacyId]);
			sendAll(upload, ["%PDF"]);
			const added = finishWorkspaceSourceUpload(upload);
			expect(added).toMatchObject({ kind: "file", name: "new.pdf", size: 4 });
			expect(JSON.parse(readFileSync(join(upload.directory, "source.json"), "utf8"))).toEqual({
				version: 1,
				name: "new.pdf",
				size: 4,
				storedName: "source-new.pdf",
			});
			expect(readdirSync(upload.directory).sort()).toEqual(["source-new.pdf", "source.json"]);
			const listed = listWorkspaceSources(data, workspaceId);
			expect(listed.find((source) => source.id === legacyId)).toMatchObject({ kind: "file", name: "old.txt", size: 9 });
			expect(readFileSync(join(legacy, "source.json"), "utf8")).toBe(manifest);
			deleteWorkspaceSource(data, workspaceId, legacyId);
			expect(existsSync(legacy)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
