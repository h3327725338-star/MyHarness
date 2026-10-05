import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../system-prompts", import.meta.url));
function resources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const location = join(directory, entry.name);
		if (entry.isDirectory()) return resources(location);
		return directory !== root && entry.name.endsWith(".md") ? [location] : [];
	});
}

describe("built-in prompt resource format", () => {
	const files = resources(root);
	it("covers all 56 runtime resources, excluding repository maintenance documents", () => {
		expect(files).toHaveLength(56);
	});
	for (const file of files) {
		it(`uses English heading-and-bullet blocks: ${file.slice(root.length + 1)}`, () => {
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(/[\u3400-\u9fff\uff00-\uffef]/u);
			expect(text).toMatch(/^# /u);
			expect(text).toMatch(/\n$/u);
			const lines = text.trimEnd().split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line.startsWith("# ")) {
					expect(lines[i + 1]).toMatch(/^- /u);
					if (i > 0) expect(lines[i - 1]).toBe("");
				} else if (line === "") {
					expect(lines[i + 1]).toMatch(/^# /u);
				} else expect(line).toMatch(/^- /u);
			}
		});
	}
});
