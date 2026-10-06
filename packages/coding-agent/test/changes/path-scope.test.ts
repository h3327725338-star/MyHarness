import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ChangeControlError } from "../../src/changes/errors.ts";
import { resolveScopedFile } from "../../src/changes/path-scope.ts";
import { toFileUri } from "../../src/symbols/path-semantics.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "./helpers.ts";

afterEach(disposeTestWorkspaces);

const DIRECTORY_ALIAS = process.platform === "win32" ? "junction" : "dir";

function probe(create: (dir: string) => void): boolean {
	const dir = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-scope-probe-"));
	try {
		create(dir);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const canLinkDirectories = probe((dir) => {
	mkdirSync(join(dir, "real"));
	symlinkSync(join(dir, "real"), join(dir, "alias"), DIRECTORY_ALIAS);
});
const canLinkFiles = probe((dir) => {
	writeFileSync(join(dir, "target.txt"), "x");
	symlinkSync(join(dir, "target.txt"), join(dir, "alias.txt"));
});
const canHardLink = probe((dir) => {
	writeFileSync(join(dir, "a.txt"), "x");
	linkSync(join(dir, "a.txt"), join(dir, "b.txt"));
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof ChangeControlError ? error.code : `other:${String(error)}`;
	}
	return undefined;
}

describe("resolveScopedFile", () => {
	it("gives every spelling of one file the same path and identity", async () => {
		const workspace = createTestWorkspace({ "src/Widget.ts": "export {};\n" });

		const spellings = [
			"src/Widget.ts",
			"SRC/widget.TS",
			workspace.abs("src/Widget.ts"),
			workspace.abs("src/widget.ts").toUpperCase(),
			toFileUri(workspace.abs("src/Widget.ts")),
		];
		const resolved = await Promise.all(spellings.map((spelling) => resolveScopedFile(workspace.root, spelling)));

		for (const entry of resolved) {
			expect(entry.path).toBe("src/Widget.ts");
			expect(entry.key).toBe(resolved[0].key);
			expect(entry.exists).toBe(true);
		}
	});

	it("refuses paths outside the workspace and Windows spellings that name something else", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x" });

		for (const input of [
			"../outside.ts",
			"src/../../outside.ts",
			join(tmpdir(), "elsewhere.ts"),
			"src/nul.txt",
			"src/CON.ts",
			"src/a.ts:hidden",
			"src/trailing.",
			"\\\\?\\C:\\Windows\\win.ini",
			".",
		]) {
			expect(await codeOf(resolveScopedFile(workspace.root, input)), input).toBe("PATH_OUT_OF_SCOPE");
		}
	});

	it("refuses directories and reports files that do not exist yet", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x" });

		expect(await codeOf(resolveScopedFile(workspace.root, "src"))).toBe("UNSUPPORTED_FILE");
		const missing = await resolveScopedFile(workspace.root, "src/new/file.ts");
		expect(missing).toMatchObject({ path: "src/new/file.ts", exists: false });
	});

	it.skipIf(!canHardLink)("refuses a hard-linked file because replacing it would detach the other names", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x" });
		linkSync(workspace.abs("src/a.ts"), workspace.abs("src/b.ts"));

		expect(await codeOf(resolveScopedFile(workspace.root, "src/a.ts"))).toBe("UNSUPPORTED_FILE");
		expect(await codeOf(resolveScopedFile(workspace.root, "src/b.ts"))).toBe("UNSUPPORTED_FILE");
	});

	it.skipIf(!canLinkDirectories)("follows a directory link inside the workspace to the real file", async () => {
		const workspace = createTestWorkspace({ "real/mod.ts": "x" });
		symlinkSync(workspace.abs("real"), workspace.abs("alias"), DIRECTORY_ALIAS);

		const viaAlias = await resolveScopedFile(workspace.root, "alias/mod.ts");
		const direct = await resolveScopedFile(workspace.root, "real/mod.ts");
		const newViaAlias = await resolveScopedFile(workspace.root, "alias/fresh.ts");

		expect(viaAlias.path).toBe("real/mod.ts");
		expect(viaAlias.key).toBe(direct.key);
		expect(viaAlias.absolutePath).toBe(direct.absolutePath);
		expect(newViaAlias.path).toBe("real/fresh.ts");
	});

	it.skipIf(!canLinkDirectories)("refuses a directory link that leaves the workspace", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x" });
		const outside = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-scope-outside-"));
		try {
			writeFileSync(join(outside, "secret.ts"), "x");
			symlinkSync(outside, workspace.abs("escape"), DIRECTORY_ALIAS);

			expect(await codeOf(resolveScopedFile(workspace.root, "escape/secret.ts"))).toBe("PATH_OUT_OF_SCOPE");
			expect(await codeOf(resolveScopedFile(workspace.root, "escape/new.ts"))).toBe("PATH_OUT_OF_SCOPE");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it.skipIf(!canLinkFiles)("replaces the target of a file link, not the link", async () => {
		const workspace = createTestWorkspace({ "src/target.ts": "x" });
		symlinkSync(workspace.abs("src/target.ts"), workspace.abs("src/link.ts"));

		const resolved = await resolveScopedFile(workspace.root, "src/link.ts");

		expect(resolved.path).toBe("src/target.ts");
	});
});
