import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSystemPrompt, systemPromptDirectory } from "../src/api/system-prompt-loader.ts";

const directories: string[] = [];
function fixture(content?: string | Uint8Array): string {
	const directory = fs.mkdtempSync(join(tmpdir(), "myharness-prompts-"));
	directories.push(directory);
	if (content !== undefined) fs.writeFileSync(join(directory, "test.md"), content);
	return directory;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) {
		for (const file of fs.readdirSync(directory)) fs.unlinkSync(join(directory, file));
		fs.rmdirSync(directory);
	}
});

describe("central system prompt loader", () => {
	it("loads the repository directory independently of the task cwd", () => {
		expect(systemPromptDirectory).toBe(fileURLToPath(new URL("../../../system-prompts", import.meta.url)));
		expect(loadSystemPrompt("global/core.md")).toContain("<global_core_policy>");
	});
	it("reads edited files, preserves whitespace, and substitutes data only once", () => {
		const directory = fixture("\nText {{value}}  \n");
		expect(loadSystemPrompt("test.md", { value: "{{other}} $& `code`" }, directory)).toBe(
			"\nText {{other}} $& `code`  ",
		);
		fs.writeFileSync(join(directory, "test.md"), "Edited\r\ntext\r\n");
		expect(loadSystemPrompt("test.md", {}, directory)).toBe("Edited\ntext");
	});
	it.each([
		["missing", undefined],
		["empty", ""],
		["whitespace", " \n\t"],
		["binary", "text\u0000"],
		["invalid UTF-8", new Uint8Array([0xc3, 0x28])],
		["missing variable", "{{unknown}}"],
	])("warns and skips %s, then continues with a valid file", (_name, content) => {
		const directory = fixture(content);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(loadSystemPrompt("test.md", {}, directory)).toBe("");
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("warning: skipping"));
		expect(warning.mock.calls[0][0]).toContain("test.md");
		fs.writeFileSync(join(directory, "test.md"), "valid\n");
		expect(loadSystemPrompt("test.md", {}, directory)).toBe("valid");
	});
	it("warns and skips a real read error", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const directory = fixture("valid");
		const nativeFs = process.getBuiltinModule("fs") as typeof fs;
		const original = nativeFs.readFileSync;
		vi.spyOn(nativeFs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
			if (String(file) === join(directory, "test.md"))
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			return Reflect.apply(original, nativeFs, [file, ...args]);
		}) as typeof original);
		expect(loadSystemPrompt("test.md", {}, directory)).toBe("");
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
	});
	it("rejects paths outside the managed directory", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(loadSystemPrompt("../outside.md")).toBe("");
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("invalid prompt path"));
	});
});
