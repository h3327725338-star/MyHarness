import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findRecentlyModifiedSourceFiles } from "../src/utils/source-changes.ts";

const temporaryDirectories: string[] = [];

function makeTempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "myharness-source-changes-"));
	temporaryDirectories.push(dir);
	return dir;
}

function writeFileAt(root: string, relativePath: string, content = "export const x = 1;\n"): string {
	const fullPath = join(root, relativePath);
	mkdirSync(join(fullPath, ".."), { recursive: true });
	writeFileSync(fullPath, content);
	return fullPath;
}

function setMtime(filePath: string, mtimeMs: number): void {
	utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
}

afterEach(() => {
	for (const dir of temporaryDirectories.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("findRecentlyModifiedSourceFiles", () => {
	it("returns only .ts files modified after the baseline, with src-relative paths", () => {
		const root = makeTempRoot();
		const baseline = Date.now() - 60_000;
		const oldFile = writeFileAt(root, "modes/interactive/old.ts");
		setMtime(oldFile, baseline - 10_000);
		const newFile = writeFileAt(root, "modes/interactive/new.ts");
		setMtime(newFile, baseline + 10_000);
		// 非 .ts 文件不参与检测。
		writeFileAt(root, "modes/interactive/notes.txt", "ignored");

		const result = findRecentlyModifiedSourceFiles(baseline, { root });

		expect(result).toEqual(["modes/interactive/new.ts"]);
	});

	it("skips node_modules and dot-directories", () => {
		const root = makeTempRoot();
		const baseline = Date.now() - 60_000;
		writeFileAt(root, "node_modules/dep/index.ts");
		writeFileAt(root, ".hidden/file.ts");
		writeFileAt(root, "core/real.ts");

		const result = findRecentlyModifiedSourceFiles(baseline, { root });

		expect(result).toEqual(["core/real.ts"]);
	});

	it("respects the limit and stops early", () => {
		const root = makeTempRoot();
		const baseline = Date.now() - 60_000;
		for (let i = 0; i < 6; i += 1) {
			writeFileAt(root, `core/file-${i}.ts`);
		}

		const result = findRecentlyModifiedSourceFiles(baseline, { root, limit: 3 });

		expect(result).toHaveLength(3);
	});

	it("returns an empty list when nothing changed after the baseline", () => {
		const root = makeTempRoot();
		const baseline = Date.now() - 60_000;
		const file = writeFileAt(root, "core/stable.ts");
		setMtime(file, baseline - 1_000);

		expect(findRecentlyModifiedSourceFiles(baseline, { root })).toEqual([]);
	});
});
