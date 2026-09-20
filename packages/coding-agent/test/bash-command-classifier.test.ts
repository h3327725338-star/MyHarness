import { describe, expect, it } from "vitest";
import { classifyBashCommand, isBashCommandReadOnly } from "../src/git/repository/bash-command-classifier.ts";

describe("main Agent Bash read-only classifier", () => {
	const readOnlyMatrix: ReadonlyArray<{ category: string; commands: readonly string[] }> = [
		{
			category: "file and text inspection",
			commands: [
				"cat package.json",
				"cmp package.json package.json",
				"cut package.json",
				"diff package.json package.json",
				"dirname package.json",
				"file package.json",
				"fold package.json",
				"head -n 5 package.json",
				"more package.json",
				"od package.json",
				"paste package.json package.json",
				"rev package.json",
				"sort -r package.json",
				"strings package.json",
				"tail -n 5 package.json",
				"tr a-z A-Z",
				"uniq package.json",
				"wc -l package.json",
			],
		},
		{
			category: "filesystem and search inspection",
			commands: [
				"find . -maxdepth 1 -print",
				'find . -name "*.ts" -type f',
				"ls -la",
				"pwd",
				"readlink package.json",
				"realpath package.json",
				'rg -n "escape interrupt" --glob "*.ts"',
				'grep -rn "escape interrupt" --include="*.py"',
				"stat package.json",
				"test -f package.json",
				"tree",
				"type node",
				"which node",
				"where node",
			],
		},
		{
			category: "fixed-value and version inspection",
			commands: [
				"echo hello",
				"printf 'hello'",
				"false",
				"node --version",
				"python --version",
				"python3 --version",
				"seq 1 3",
				"true",
				"uname -a",
				"uptime",
			],
		},
		{
			category: "safe command composition and Git inspection",
			commands: [
				'cd /c/myharness && grep -rn "escape interrupt" --include="*.py" --include="*.rs"',
				"cat package.json | rg scripts",
				`grep "user's message" package.json`,
				'ls -la "C:/claude" 2>&1 | head -50',
				'ls -la "C:/claude" 2>&1 | head -50; echo "---"; ls -la "C:/myharness" 2>&1 | head -50',
				'echo "$?"',
				"echo '$?'",
				'printf "%s\\n" "$?"',
			],
		},
	];

	for (const { category, commands } of readOnlyMatrix) {
		describe(category, () => {
			it.each(commands)("accepts a statically read-only command: %s", (command) => {
				expect(isBashCommandReadOnly(command), `${command}: ${classifyBashCommand(command).reason}`).toBe(true);
				expect(classifyBashCommand(command).risk).toBe("read-only");
			});
		});
	}

	it.each([
		"rm package.json",
		"mv package.json package.backup",
		"cp package.json package.backup",
		"touch package.json",
		"mkdir new-directory",
		"npm test",
		"bash -c 'cat package.json'",
		"python -c \"open('changed.txt', 'w').write('x')\"",
		"find . -exec cat {} +",
		"find . -delete",
		"find . -fprintf /tmp/files '%p\\n'",
		"sed -i 's/old/new/' package.json",
		"grep --replace=old package.json",
		"rg --pre='cat' package.json",
		"sort -o output.txt package.json",
		"sort --compress-program=malicious package.json",
		"node -e \"require('fs').writeFileSync('changed.txt', 'x')\"",
		"git add package.json",
		"git commit -m change",
		"git reset --hard HEAD",
		"git push",
		"git fetch",
		"git checkout -- package.json",
		"git config user.name Agent",
		"git reflog expire --expire=now --all",
		"printf 'changed' > package.json",
		"printf 'changed' 2> error.log",
		"cat package.json 2>&1file",
		"tr a-z A-Z < package.json",
		"cat package.json; rm package.json",
		"cat package.json || touch package.json",
		"cat package.json & echo done",
		"rg $PATTERN package.json",
		"rg *.ts",
		"cat $(printf package.json)",
		"cat `printf package.json`",
		"cd /c/myharness && git status",
		`grep "user's $(touch package.json)" package.json`,
		'echo "$PATH"',
		'echo "$FILES"',
		'echo "$' + '{FILES}"',
		'echo "$' + '(command)"',
		'printf "%s\\n" "$FILES"',
		"git log -1 --grep='x' && touch changed.txt",
		"git diff -1",
		"git status -1",
		"ls && git status",
		"ls || git status",
		"git status && cat package.json",
		"git --no-pager status --short",
		"git diff --check",
		"git log --oneline --max-count=5",
		"git log -1",
		"git log -2 --oneline",
		"git log -10 --stat",
		"git show -1",
		"git remote -v",
		"git branch",
		"git tag",
		"git reflog show",
	])("does not bypass the checkpoint for a non-provable command: %s", (command) => {
		expect(isBashCommandReadOnly(command), classifyBashCommand(command).reason).toBe(false);
		expect(classifyBashCommand(command).risk).not.toBe("read-only");
	});

	it("does not allow an unsupported command chain or malformed shell syntax", () => {
		for (const command of ["npm test", "bash -c 'cat package.json'", 'cat "package.json']) {
			const classification = classifyBashCommand(command);
			expect(classification.risk).toBe("unknown");
			expect(isBashCommandReadOnly(command)).toBe(false);
		}
	});

	it("keeps read-only and dynamic-expansion policy after shared lexical reconstruction", () => {
		for (const command of ['g"it" log -1', 'git lo"g" -1', "g\\it status", "git add '>literal'"]) {
			const classification = classifyBashCommand(command);
			// Git 命令不再参与只读分类：即使语法上可解析，也按潜在修改处理。
			expect(classification.risk, `${command}: ${classification.reason}`).not.toBe("read-only");
		}
		for (const command of ["cat file>output.log", 'cat "$FILE"', "cat *.ts"]) {
			expect(isBashCommandReadOnly(command), command).toBe(false);
		}
		expect(isBashCommandReadOnly("git log -1")).toBe(false);
		expect(isBashCommandReadOnly('echo "$?"')).toBe(true);
	});

	it.each(["! git status", "time git status", "time -p git status"])(
		"keeps Git status behind a static Bash execution prefix out of the read-only set: %s",
		(command) => {
			expect(isBashCommandReadOnly(command), classifyBashCommand(command).reason).toBe(false);
		},
	);

	it.each([
		"! git reset --hard HEAD",
		"time git reset --hard HEAD",
		"time -p git reset --hard HEAD",
		"! time git reset --hard HEAD",
		"time --unknown git status",
	])("does not let a static Bash prefix bypass the checkpoint for Git: %s", (command) => {
		expect(isBashCommandReadOnly(command), command).toBe(false);
	});
});
