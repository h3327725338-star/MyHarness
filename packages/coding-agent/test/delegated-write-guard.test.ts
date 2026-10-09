import { describe, expect, it } from "vitest";
import {
	createDelegatedWriteGuardExtensionSource,
	evaluateDelegatedWriteToolCall,
	isPathWithinJail,
	WRITE_GUARD_BLOCK_MARKER,
} from "../src/tools/shell/delegated-write-guard.ts";

const ROOT = "C:/work/jail";

function shell(command: string, toolName = "bash"): string | undefined {
	return evaluateDelegatedWriteToolCall(toolName, { command }, ROOT);
}

function file(toolName: string, input: Record<string, unknown>): string | undefined {
	return evaluateDelegatedWriteToolCall(toolName, input, ROOT);
}

describe("delegated write guard: nested dispatch", () => {
	it("rejects every dispatch tool name for both delegated modes", () => {
		for (const name of ["agent", "workflow", "ultracode", "Agent", "WORKFLOW"]) {
			expect(file(name, { tasks: [] })).toContain("不能派发子代理");
		}
	});
});

describe("delegated write guard: git rules", () => {
	it("blocks every state-changing or history-rewriting git command", () => {
		const blocked = [
			"git commit -m x",
			"git push",
			"git push --force",
			"git merge other",
			"git add .",
			"git add -- file.txt",
			"git reset --hard",
			"git clean -fd",
			"git branch -D feature",
			"git worktree remove x",
			"git checkout main",
			"git switch other",
			"git stash",
			"git rebase main",
			"git tag v1",
			"git config user.name x",
			"git -c alias.x=commit status",
		];
		for (const command of blocked) {
			expect(shell(command), command).toContain("不在允许范围");
		}
	});

	it("keeps read-only git inspection available", () => {
		const allowed = [
			"git status --porcelain --untracked-files=all",
			"git diff HEAD~2..HEAD",
			"git log origin/main..HEAD",
			"git show HEAD:README.md",
			"git branch --show-current",
			"git grep pattern",
			"git ls-files",
			"git rev-parse HEAD",
		];
		for (const command of allowed) {
			expect(shell(command), command).toBeUndefined();
		}
	});
});

describe("delegated write guard: shell location and paths", () => {
	it("keeps cd inside the worktree", () => {
		expect(shell("cd src && npm test")).toBeUndefined();
		expect(shell(`cd ${ROOT}/sub`)).toBeUndefined();
		expect(shell("cd C:/Windows && git status")).toContain("越出");
		expect(shell("cd ..")).toContain("cd");
		expect(shell("cd")).toContain("裸 cd");
	});

	it("blocks working-directory changes that bypass the cd check", () => {
		expect(shell("Set-Location C:\\Windows; git status", "pwsh")).toContain("set-location");
		expect(shell("Push-Location ../other")).toContain("push-location");
		expect(shell("pushd C:\\other")).toContain("pushd");
		expect(shell("popd")).toContain("popd");
	});

	it("blocks nested shells, inline code, and process launchers", () => {
		expect(shell(`bash -c 'cd / ; echo x'`)).toContain("内联代码");
		expect(shell('pwsh -Command "Remove-Item foo"')).toContain("内联代码");
		expect(shell('cmd /c "echo x > C:\\evil.txt"')).toContain("cmd");
		expect(shell("eval 'rm -rf /'")).toContain("eval");
		expect(shell("iex 'Get-Content secret'")).toContain("iex");
		expect(shell("xargs rm")).toContain("xargs");
		expect(shell("node -e 'process.exit()'")).toContain("内联代码");
		expect(shell("python -c 'import os'")).toContain("内联代码");
		expect(shell("find . -exec rm {} ;")).toBeDefined();
	});

	it("blocks absolute and home paths that escape the jail, in any token position", () => {
		expect(shell("echo hi | tee C:/evil.txt")).toContain("绝对路径越出");
		expect(shell("cp C:/outside/src.txt ./dst.txt")).toContain("绝对路径越出");
		expect(shell("touch ~/evil")).toContain("主目录");
		expect(shell("rm $HOME/evil")).toContain("配置目录");
		expect(shell("cat /etc/passwd")).toContain("绝对路径越出");
		expect(shell("git -C C:/other status")).toContain("绝对路径越出");
		expect(shell("Out-File -FilePath C:/evil.txt", "pwsh")).toContain("绝对路径越出");
		// Inside the jail stays allowed, including Git-Bash style /c/ paths and case variants.
		expect(shell("cat /c/work/jail/README.md")).toBeUndefined();
		expect(shell("cat C:/WORK/JAIL/README.md")).toBeUndefined();
		expect(shell("node scripts/test.js")).toBeUndefined();
	});

	it("checks redirection targets", () => {
		expect(shell("echo hi > C:/outside/out.txt")).toContain("越出");
		expect(shell("echo hi > ../out.txt")).toContain("越出");
		expect(shell("echo hi > out.txt")).toBeUndefined();
		expect(shell("git status > /dev/null")).toBeUndefined();
		expect(shell("npm test 2>&1")).toBeUndefined();
		expect(shell("make all > build.log 2>&1")).toBeUndefined();
		expect(shell("Set-Content -Value x -Path C:/evil", "pwsh")).toContain("绝对路径越出");
	});

	it("rejects command substitution and unparseable constructs", () => {
		expect(shell("echo $(cat C:/secret) > out.txt")).toContain("命令替换");
		expect(shell("echo `whoami`")).toContain("命令替换");
		expect(shell("cat < C:/secret")).toBeDefined();
		expect(shell("")).toContain("命令为空");
	});

	it("applies the same shell rules to pwsh", () => {
		expect(shell("git commit -m x", "pwsh")).toContain("不在允许范围");
	});
});

describe("delegated write guard: file tools", () => {
	it("jailed paths pass, outside paths fail", () => {
		expect(file("edit", { path: "src/a.ts", edits: [] })).toBeUndefined();
		expect(file("write", { path: `${ROOT}/docs/b.md`, content: "x" })).toBeUndefined();
		expect(file("write", { path: "C:/Windows/evil.txt", content: "x" })).toContain("越出本任务 worktree");
		expect(file("read", { path: "../../../etc/passwd" })).toContain("越出本任务 worktree");
		expect(file("read", { path: "~/secrets" })).toContain("越出本任务 worktree");
		expect(file("read", { path: "C:/work/jail-evil/x" })).toContain("越出本任务 worktree");
	});

	it("scans nested and alternate path keys", () => {
		expect(file("read", { files: [{ path: "C:/outside/x" }] })).toContain("越出");
		expect(file("ls", { directory: "C:/outside" })).toContain("越出");
		expect(file("read", { file_path: "/etc/hosts" })).toContain("越出");
	});

	it("keeps search globs relative to the jail", () => {
		expect(file("grep", { query: "x", glob: "../../etc/*.conf" })).toContain("越出");
		expect(file("find", { pattern: "/etc/*" })).toContain("越出");
		expect(file("grep", { query: "x", glob: "src/**/*.ts" })).toBeUndefined();
	});

	it("treats the empty path as the jail root", () => {
		expect(file("read", { path: "" })).toBeUndefined();
		expect(file("ls", {})).toBeUndefined();
	});
});

describe("delegated write guard: jail containment", () => {
	it("compares case-insensitively and never matches sibling directories", () => {
		expect(isPathWithinJail("C:/work/jail", ROOT)).toBe(true);
		expect(isPathWithinJail("C:/WORK/Jail/src/a.ts", ROOT)).toBe(true);
		expect(isPathWithinJail("C:/work/jail-evil/a.ts", ROOT)).toBe(false);
		expect(isPathWithinJail("C:/work/jail/../outside/a.ts", ROOT)).toBe(false);
		expect(isPathWithinJail("~/a.ts", ROOT)).toBe(false);
	});
});

describe("delegated write guard: generated extension source", () => {
	it("embeds the marker and the worktree env override and stays valid JavaScript", async () => {
		const source = createDelegatedWriteGuardExtensionSource();
		expect(source).toContain(WRITE_GUARD_BLOCK_MARKER);
		expect(source).toContain("MYHARNESS_INTERNAL_DELEGATED_WORKTREE");
		expect(source).toContain("export default function (pi)");

		// Execute the generated extension the same way the worker loader would.
		const handlers: Array<(event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>> = [];
		const stubPi = {
			on: (_event: string, handler: (typeof handlers)[number]) => {
				handlers.push(handler);
			},
		};
		const evaluated = source.replace("export default function (pi) {", "function guard(pi) {");
		new Function("pi", `${evaluated}\nguard(pi);`)(stubPi);
		expect(handlers.length).toBe(1);

		const previous = process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE;
		process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE = ROOT;
		try {
			const outsideWrite = await handlers[0]({ toolName: "write", input: { path: "C:/outside/evil.txt" } });
			expect(outsideWrite).toMatchObject({ block: true });
			expect((outsideWrite as { reason: string }).reason).toContain(WRITE_GUARD_BLOCK_MARKER);
			const dispatch = await handlers[0]({ toolName: "agent", input: {} });
			expect((dispatch as { reason: string }).reason).toContain(WRITE_GUARD_BLOCK_MARKER);
			// A renamed or namespaced dispatch tool is rejected by the same generated guard.
			const renamedDispatch = await handlers[0]({ toolName: "mcp_tools_run-agent", input: {} });
			expect((renamedDispatch as { reason: string }).reason).toContain("不能派发子代理");
			const inside = await handlers[0]({ toolName: "edit", input: { path: "src/a.ts", edits: [] } });
			expect(inside).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE;
			else process.env.MYHARNESS_INTERNAL_DELEGATED_WORKTREE = previous;
		}
	});
});
