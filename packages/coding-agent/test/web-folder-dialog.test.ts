import { describe, expect, it } from "vitest";
import { buildFolderDialogScript, parseFolderDialogOutput } from "../src/modes/web/folder-dialog.ts";

const picked = (path: string) => `MYHARNESS_FOLDER:${Buffer.from(path, "utf8").toString("base64")}`;

describe("Web UI: system folder window", () => {
	it("reads the chosen folder, including non-ASCII names, from the script output", () => {
		expect(parseFolderDialogOutput(`${picked("C:\\work\\项目 one")}\r\n`)).toEqual({ path: "C:\\work\\项目 one" });
		expect(parseFolderDialogOutput(`noise\n${picked("D:\\")}\n`)).toEqual({ path: "D:\\" });
	});

	it("tells a cancel apart from a window that never answered", () => {
		expect(parseFolderDialogOutput("MYHARNESS_CANCELLED\r\n")).toEqual({ cancelled: true });
		expect(parseFolderDialogOutput("")).toBeUndefined();
		expect(parseFolderDialogOutput("Add-Type : compile error")).toBeUndefined();
		expect(parseFolderDialogOutput("MYHARNESS_FOLDER:")).toBeUndefined();
	});

	it("passes the title as data, never as script text", () => {
		const title = "Add 'workspace'; Remove-Item C:\\ $(evil)";
		const script = buildFolderDialogScript(title);
		expect(script).not.toContain("Remove-Item");
		expect(script).toContain(Buffer.from(title, "utf8").toString("base64"));
		expect(script).toContain("[MyHarnessFolderDialog]::Pick($title)");
	});
});
