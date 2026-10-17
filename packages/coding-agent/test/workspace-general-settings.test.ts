import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getSessionUploadDir,
	getWorkspaceMetadataPath,
	getWorkspaceRegistryPath,
	getWorkspaceUploadsDir,
} from "../src/config/paths/index.ts";
import { deleteWorkspaceSource, listWorkspaceSources, uploadWorkspaceSource } from "../src/data/workspace-sources.ts";
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
});
