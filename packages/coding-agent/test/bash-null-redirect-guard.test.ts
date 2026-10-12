import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/tools/shell/bash.ts";
import { findBashNullDeviceRedirect } from "../src/tools/shell/null-redirect-guard.ts";

describe("findBashNullDeviceRedirect", () => {
	it.each([
		["where node 2>nul | head -1", "2>nul"],
		["echo hi > nul", "> nul"],
		["echo hi >nul 2>&1", ">nul"],
		["dir >NUL", ">NUL"],
		["ls >>./nul", ">>./nul"],
		["make &>nul", "&>nul"],
	])("flags cmd-style redirect in %j", (command, snippet) => {
		expect(findBashNullDeviceRedirect(command)).toBe(snippet);
	});

	it.each([
		"echo ok 2>/dev/null",
		"ls >/dev/null 2>&1",
		'echo "save >nul later"',
		"echo 'x>nul'",
		'node -e "f=>f"',
		"make 2>&1 | head -5",
		"cat < input.txt",
		"echo hi > output.txt",
		"echo done",
	])("leaves clean command alone: %j", (command) => {
		expect(findBashNullDeviceRedirect(command)).toBeUndefined();
	});
});

describe("bash tool nul redirect block", () => {
	it("rejects before spawning and suggests /dev/null", async () => {
		const definition = createBashToolDefinition("C:\\does-not-matter", {
			operations: {
				exec: () => {
					throw new Error("must not spawn");
				},
			},
		});
		await expect(
			definition.execute("call-1", { command: "where node 2>nul" }, undefined, undefined, undefined),
		).rejects.toThrow(/cmd 风格的重定向 `2>nul`[\s\S]*2>\/dev\/null/);
	});
});
