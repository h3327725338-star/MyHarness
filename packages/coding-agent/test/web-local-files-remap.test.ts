import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalFile } from "../src/modes/web/local-files.ts";

function makeRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// best effort
	}
}

describe("cross-computer local file remap", () => {
	it("keeps the direct path as the first attempt", async () => {
		const root = makeRoot("local-remap-direct-");
		try {
			const file = join(root, "direct-hit.txt");
			writeFileSync(file, "hello");
			mkdirSync(join(root, "subdir"), { recursive: true });
			expect(await resolveLocalFile(root, "direct-hit.txt")).toEqual({ path: file, directory: false });
			expect(await resolveLocalFile(root, file)).toEqual({ path: file, directory: false });
			expect(await resolveLocalFile(root, ".")).toEqual({ path: root, directory: true });
		} finally {
			cleanup(root);
		}
	});

	it("remaps another computer's absolute path by suffix against the workspace root", async () => {
		const root = makeRoot("local-remap-suffix-");
		try {
			const nested = join(root, "Study", "Subject", "OS", "other");
			mkdirSync(nested, { recursive: true });
			const file = join(nested, "target-suffix.txt");
			writeFileSync(file, "x");
			const requested = "C:\\Users\\user\\Study\\Subject\\OS\\other\\target-suffix.txt";
			const hit = await resolveLocalFile(root, requested);
			expect(hit).toEqual({ path: file, directory: false });
		} finally {
			cleanup(root);
		}
	});

	it("strips a My Drive segment before the suffix match", async () => {
		const root = makeRoot("local-remap-drive-");
		try {
			const nested = join(root, "Study", "Subject");
			mkdirSync(nested, { recursive: true });
			const file = join(nested, "drive-target.txt");
			writeFileSync(file, "x");
			const requested = "C:\\Users\\user\\My Drive\\Study\\Subject\\drive-target.txt";
			expect(await resolveLocalFile(root, requested)).toEqual({ path: file, directory: false });
			const google = "C:/Users/user/Google Drive/Study/Subject/drive-target.txt";
			expect(await resolveLocalFile(root, google)).toEqual({ path: file, directory: false });
		} finally {
			cleanup(root);
		}
	});

	it("falls back to a unique basename match under the workspace root", async () => {
		const root = makeRoot("local-remap-base-");
		try {
			const deep = join(root, "nested", "deep");
			mkdirSync(deep, { recursive: true });
			const file = join(deep, "unique-basename-xyz-123.txt");
			writeFileSync(file, "x");
			const hit = await resolveLocalFile(root, "C:\\Totally\\Unrelated\\place\\unique-basename-xyz-123.txt");
			expect(hit).toEqual({ path: file, directory: false });
		} finally {
			cleanup(root);
		}
	});

	it("refuses an ambiguous basename instead of opening the wrong file", async () => {
		const root = makeRoot("local-remap-ambig-");
		try {
			mkdirSync(join(root, "a"), { recursive: true });
			mkdirSync(join(root, "b"), { recursive: true });
			writeFileSync(join(root, "a", "dup-name-xyz.txt"), "1");
			writeFileSync(join(root, "b", "dup-name-xyz.txt"), "2");
			await expect(resolveLocalFile(root, "C:\\Nope\\nothing\\dup-name-xyz.txt")).rejects.toThrow(
				/Multiple files named|ambiguous/i,
			);
		} finally {
			cleanup(root);
		}
	});

	it("maps a link that points into this device's Data root (artifacts and notes)", async () => {
		const root = makeRoot("local-remap-ws-");
		const data = makeRoot("local-remap-data-");
		try {
			const nested = join(data, "workspaces", "ws1", "sessions", "s1", "artifacts");
			mkdirSync(nested, { recursive: true });
			const file = join(nested, "explainer.html");
			writeFileSync(file, "<html></html>");
			const requested =
				"C:\\Users\\user\\AppData\\MyHarness\\data\\workspaces\\ws1\\sessions\\s1\\artifacts\\explainer.html";
			expect(await resolveLocalFile(root, requested, [data])).toEqual({ path: file, directory: false });
		} finally {
			cleanup(root);
			cleanup(data);
		}
	});

	it("never escapes the workspace root through '..' suffixes", async () => {
		const root = makeRoot("local-remap-trav-");
		const outside = join(tmpdir(), `traversal-sentinel-${process.pid}-${Date.now()}.txt`);
		try {
			writeFileSync(outside, "outside");
			// Direct Windows-style input misses locally; the naive `..` suffix
			// `join(root, "..", basename)` would point at the outside file and must be skipped.
			const requested = `C:\\fake\\..\\${basename(outside)}`;
			const outcome = await resolveLocalFile(root, requested).then(
				(hit) => ({ ok: true as const, hit }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) expect(outcome.hit.path).not.toBe(outside);
		} finally {
			cleanup(root);
			try {
				rmSync(outside, { force: true });
			} catch {
				// best effort
			}
		}
	});

	it("rejects UNC and scheme inputs before any remap", async () => {
		const root = makeRoot("local-remap-guard-");
		try {
			await expect(resolveLocalFile(root, "\\\\server\\share\\file.txt")).rejects.toThrow();
			await expect(resolveLocalFile(root, "shell:AppsFolder")).rejects.toThrow();
		} finally {
			cleanup(root);
		}
	});

	it("explains a plain missing relative path", async () => {
		const root = makeRoot("local-remap-miss-");
		try {
			await expect(resolveLocalFile(root, "missing-local-file-12345.txt")).rejects.toThrow(/does not exist/);
		} finally {
			cleanup(root);
		}
	});

	it("says a file from another computer was never synced here", async () => {
		const root = makeRoot("local-remap-sync-");
		try {
			await expect(
				resolveLocalFile(root, "C:\\Users\\SomeoneElse\\Documents\\no-such-file-xyz-123.txt"),
			).rejects.toThrow(/has not been synced/i);
		} finally {
			cleanup(root);
		}
	});

	it("says Google Drive has not delivered a Drive file yet", async () => {
		const root = makeRoot("local-remap-deliver-");
		try {
			await expect(
				resolveLocalFile(root, "C:\\Users\\SomeoneElse\\My Drive\\no-such-file-xyz-123.txt"),
			).rejects.toThrow(/Google Drive.*deliver|has not delivered/i);
		} finally {
			cleanup(root);
		}
	});
});
