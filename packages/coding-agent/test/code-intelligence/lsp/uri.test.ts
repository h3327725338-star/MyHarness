/**
 * LSP URI 工具测试（板块 3）。
 *
 * 重点：Windows 盘符路径必须得到合法 file:///C:/... URI（含空格、中文、
 * 特殊字符的 percent-encoding），并在 Windows 平台可 roundtrip。
 */

import { describe, expect, it } from "vitest";

import { fromFileUri, toFileUri } from "../../../src/symbols/lsp/uri.ts";

describe("toFileUri", () => {
	it("Windows 盘符路径（反斜杠）转换为 file:///C:/...", () => {
		expect(toFileUri("C:\\project\\src\\a.ts")).toBe("file:///C:/project/src/a.ts");
	});

	it("Windows 盘符路径（正斜杠）转换一致", () => {
		expect(toFileUri("C:/project/src/a.ts")).toBe("file:///C:/project/src/a.ts");
	});

	it("小写盘符同样支持", () => {
		expect(toFileUri("c:\\project\\a.ts")).toBe("file:///c:/project/a.ts");
	});

	it("路径中的空格被 percent-encode", () => {
		expect(toFileUri("C:\\my folder\\a.ts")).toBe("file:///C:/my%20folder/a.ts");
	});

	it("非 ASCII 路径被 percent-encode", () => {
		expect(toFileUri("C:\\项目\\文件.ts")).toBe("file:///C:/%E9%A1%B9%E7%9B%AE/%E6%96%87%E4%BB%B6.ts");
	});

	it("#、?、% 按路径字符 percent-encode", () => {
		expect(toFileUri("C:\\repo\\a#b?c%.ts")).toBe("file:///C:/repo/a%23b%3Fc%25.ts");
	});

	it("Windows UNC 路径在 Windows 上可 roundtrip", () => {
		if (process.platform !== "win32") return;
		const original = "\\\\server\\share\\file.ts";
		const uri = toFileUri(original);
		expect(uri).toBe("file://server/share/file.ts");
		expect(fromFileUri(uri)).toBe(original);
	});

	it("POSIX 绝对路径正常转换", () => {
		const uri = toFileUri("/home/user/a.ts");
		expect(uri).toMatch(/^file:\/\/\//);
		expect(uri).toContain("/home/user/a.ts");
	});
});

describe("fromFileUri", () => {
	it("Windows URI 转换回盘符路径", () => {
		expect(fromFileUri("file:///C:/project/src/a.ts")).toBe("C:\\project\\src\\a.ts");
	});

	it("roundtrip：toFileUri → fromFileUri 还原原始路径", () => {
		if (process.platform === "win32") {
			const original = "C:\\project\\src\\a.ts";
			expect(fromFileUri(toFileUri(original))).toBe(original);
			const withSpace = "C:\\my folder\\文件.ts";
			expect(fromFileUri(toFileUri(withSpace))).toBe(withSpace);
		}
	});
});
