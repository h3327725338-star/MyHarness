import { describe, expect, it } from "vitest";
import {
	describeGitPathFailure,
	extractGitProblemPaths,
	isWindowsReservedPathSegment,
} from "../src/git/repository/failure-diagnosis.ts";

describe("Git path failure diagnosis", () => {
	it("recognizes Windows reserved device names in any case and with extensions", () => {
		for (const name of ["nul", "NUL", "con", "aux.txt", "COM1", "lpt9.log", "nul.", "prn "]) {
			expect(isWindowsReservedPathSegment(name)).toBe(true);
		}
		for (const name of ["null", "nul_file", "console", "com10", "a.nul", "readme.md"]) {
			expect(isWindowsReservedPathSegment(name)).toBe(false);
		}
	});

	it("explains the Windows nul failure reported by git add", () => {
		const output = [
			"error: invalid path 'nul'",
			"error: unable to add 'nul' to index",
			"fatal: adding files failed",
		].join("\n");

		expect(extractGitProblemPaths(output)).toEqual([{ path: "nul", reason: "windows-reserved-name" }]);
		const description = describeGitPathFailure(output);
		expect(description).toContain("nul");
		expect(description).toContain("Windows 保留设备名");
		expect(description).toContain("不会自动删除");
	});

	it("detects reserved names in nested paths", () => {
		expect(extractGitProblemPaths("error: invalid path 'logs/CON.txt'")).toEqual([
			{ path: "logs/CON.txt", reason: "windows-reserved-name" },
		]);
	});

	it("explains nested repositories and permission failures without a reserved-name hint", () => {
		const output = [
			"error: 'sub/' does not have a commit checked out",
			"error: unable to index file 'sub/'",
			'error: open("secret.bin"): Permission denied',
			"fatal: adding files failed",
		].join("\n");

		expect(extractGitProblemPaths(output)).toEqual([
			{ path: "sub/", reason: "nested-repository" },
			{ path: "secret.bin", reason: "permission-denied" },
		]);
		const description = describeGitPathFailure(output);
		expect(description).toContain("嵌套 Git 仓库");
		expect(description).toContain("没有读取权限");
		expect(description).not.toContain("\\\\?\\");
	});

	it("returns undefined when Git did not name a path", () => {
		expect(describeGitPathFailure("fatal: not a git repository (or any of the parent directories): .git")).toBe(
			undefined,
		);
	});
});
