import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(process.cwd(), "src");
function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
	);
}
describe("Web-only product boundary", () => {
	it("has no terminal package or removed frontend imports anywhere in product source", () => {
		for (const file of files(src)) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(
				/(?:from|import\()\s*["'][^"']*(?:@myharness\/tui|modes\/interactive|print-mode|startup-ui|session-picker|config-selector)[^"']*["']/,
			);
		}
	});
	it("never reads terminal input in the Web composition root or migrations", () => {
		for (const file of ["main.ts", "migrations.ts"]) {
			const source = readFileSync(join(src, file), "utf8");
			expect(source).not.toContain("node:readline");
			expect(source).not.toContain("process.stdin");
		}
	});
	it("keeps browser Terminal dependencies intact", () => {
		const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
		expect(manifest.optionalDependencies["@lydell/node-pty"]).toBe("1.1.0");
		expect(manifest.dependencies).not.toHaveProperty("@myharness/tui");
		expect(readFileSync(join(src, "modes/web/terminal.ts"), "utf8")).toContain("WebTerminals");
	});
});
