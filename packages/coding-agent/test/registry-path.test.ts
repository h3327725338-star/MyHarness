import { describe, expect, it } from "vitest";
import {
	appendMissingPathEntries,
	parseRegQueryPath,
	pathEntriesFromRegistryValues,
	registryPathEntries,
} from "../src/utils/registry-path.ts";
import { getShellEnv } from "../src/utils/shell.ts";

describe("PATH entries from the Windows registry", () => {
	it("reads the value out of reg query output", () => {
		const output =
			"\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Tools;%USERPROFILE%\\bin;\r\n\r\n";
		expect(parseRegQueryPath(output)).toBe("C:\\Tools;%USERPROFILE%\\bin;");
		expect(parseRegQueryPath("\r\nHKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    C:\\Temp\r\n")).toBe(
			undefined,
		);
	});

	it("expands variables, and leaves out entries reg.exe could not print or that name an unknown variable", () => {
		const env = { UserProfile: "C:\\Users\\张三", SystemRoot: "C:\\WINDOWS" };
		expect(
			pathEntriesFromRegistryValues(
				[
					"%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd",
					"%USERPROFILE%\\mingw64\\bin;C:\\??\\bin;%NOPE%\\x;;",
				],
				env,
			),
		).toEqual(["C:\\WINDOWS\\system32", "C:\\Program Files\\Git\\cmd", "C:\\Users\\张三\\mingw64\\bin"]);
	});

	it("adds only the entries the PATH does not have, after the ones it has", () => {
		const current = "C:\\Node;C:\\WINDOWS\\system32";
		expect(appendMissingPathEntries(current, ["c:\\windows\\System32\\", "C:/Python310", "C:\\python310\\"])).toBe(
			"C:\\Node;C:\\WINDOWS\\system32;C:/Python310",
		);
		expect(appendMissingPathEntries(current, ["C:\\Node\\"])).toBe(current);
		expect(appendMissingPathEntries("", ["C:\\Tools"])).toBe("C:\\Tools");
	});

	it.runIf(process.platform === "win32")(
		"gives shells the machine PATH from the registry even when the server lacks it",
		() => {
			const machineEntry = registryPathEntries().find((entry) => /\\system32$/i.test(entry));
			expect(machineEntry).toBeDefined();
			const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
			const saved = process.env[pathKey];
			process.env[pathKey] = "C:\\only-this";
			try {
				const shellPath = getShellEnv()[pathKey] ?? "";
				expect(shellPath.split(";")).toContain("C:\\only-this");
				expect(shellPath.toLowerCase().split(";")).toContain(machineEntry!.toLowerCase());
			} finally {
				process.env[pathKey] = saved;
			}
		},
	);
});
