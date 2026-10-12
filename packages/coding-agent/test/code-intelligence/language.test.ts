import { describe, expect, it } from "vitest";
import { getCodeLanguage } from "../../src/symbols/language.ts";

describe("code language detection", () => {
	it("recognizes supported source extensions", () => {
		expect(getCodeLanguage("src/index.ts")).toBe("typescript");
		expect(getCodeLanguage("src/main.py")).toBe("python");
		expect(getCodeLanguage("README.md")).toBeUndefined();
	});

	it("handles case-insensitive extensions and Windows backslashes", () => {
		expect(getCodeLanguage("src\\components\\App.TSX")).toBe("typescript");
		expect(getCodeLanguage("server\\main.GO")).toBe("go");
		expect(getCodeLanguage("native\\core.CPP")).toBe("cpp");
		expect(getCodeLanguage("native\\core.H")).toBe("c");
		expect(getCodeLanguage("script.SH")).toBe("shell");
		expect(getCodeLanguage("unknown.xyz")).toBeUndefined();
	});
});
