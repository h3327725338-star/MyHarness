import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(process.cwd(), "src");
function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
	);
}
describe("Web-only product boundary", () => {
	it("has only Web process and source launchers", () => {
		const root = join(process.cwd(), "../..");
		for (const removed of [
			"dev.cmd",
			"dev.ps1",
			"myharness-test.ps1",
			"myharness-test.sh",
			"packages/ai/src/cli.ts",
			"packages/coding-agent/src/cli.ts",
			"packages/coding-agent/src/cli",
		]) {
			expect(existsSync(join(root, removed)), removed).toBe(false);
		}
		for (const kept of ["dev-web.cmd", "web-runtime.ps1", "web-source.ps1", "packages/coding-agent/src/web.ts"]) {
			expect(existsSync(join(root, kept)), kept).toBe(true);
		}
		const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
		expect(manifest.bin.myharness).toBe("dist/web.js");
		expect(JSON.parse(readFileSync(join(root, "packages/ai/package.json"), "utf8")).bin).toBeUndefined();
	});
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
