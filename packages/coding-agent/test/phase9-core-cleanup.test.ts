import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceRoot = join(repositoryRoot, "packages/coding-agent/src");

function sourceFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...sourceFiles(fullPath));
		else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) result.push(fullPath);
	}
	return result;
}

describe("Phase 9 core cleanup", () => {
	it("removes the obsolete core directory", () => {
		expect(existsSync(join(sourceRoot, "core"))).toBe(false);
	});

	it("keeps formal source modules off legacy core imports", () => {
		const legacyImport = /(?:from|import\s*\()\s*["'][^"']*\bcore\//;
		for (const file of sourceFiles(sourceRoot)) {
			expect(readFileSync(file, "utf8"), file).not.toMatch(legacyImport);
		}
	});
});
