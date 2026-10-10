import { describe, expect, it } from "vitest";
import {
	createDelegatedWriteGuardExtensionSource,
	evaluateDelegatedWriteToolCall,
} from "../src/tools/shell/delegated-write-guard.ts";
import { createReadOnlyGuardExtensionSource } from "../src/tools/shell/read-only-guard.ts";

// 由 data/overnight-2026-10-10/h-guards/gen-cases.mjs + sweep.mts 生成的对抗用例中，
// 挑出「守卫当前行为正确」的代表性样本做回归保护：如果这些命令的判定结果变了，
// 说明只读边界或 worktree 沙箱被改弱/改坏了。每条都带来源用例 id，可在 report.md 里回查。
// 注意：这里的命令字符串只作为参数传给守卫判断函数，测试不会执行任何一条。

const JAIL_ROOT = "C:/work/jail";

type FuzzCase = { id: string; category: string; shell: "bash" | "pwsh"; command: string };

/** 真实加载方式：执行生成的只读守卫扩展源码，取 tool_call handler（不配 AI 裁决，纯判定）。 */
function loadReadOnlyGuardHandler() {
	const source = createReadOnlyGuardExtensionSource("Sub Agent 已拦截命中的修改型 Bash 命令。", {
		mode: "delegated",
	}).replace("export default function (pi) {", "return function (pi) {");
	const create = new Function(source) as () => (pi: {
		on: (
			_event: string,
			handler: (event: { toolName: string; input: { command: string } }) => Promise<unknown>,
		) => void;
	}) => void;
	let handler: ((event: { toolName: string; input: { command: string } }) => Promise<unknown>) | undefined;
	create()({
		on: (_event, registered) => {
			handler = registered;
		},
	});
	if (!handler) throw new Error("read-only guard handler not registered");
	return handler;
}

/** 会写入，且写到 worktree 之外：两个守卫都必须拦 */
const writesOutsideJail: FuzzCase[] = [
	{ id: "c0002", category: "redirect-output", shell: "bash", command: "echo injected > ../outside.txt" },
	{ id: "c0007", category: "redirect-output", shell: "bash", command: "cat package.json > ../outside.txt" },
	{ id: "c0199", category: "tee", shell: "bash", command: "cat package.json | tee ../outside.txt" },
	{ id: "c0204", category: "tee", shell: "bash", command: "echo x | tee -a ../outside.txt" },
	{ id: "c0229", category: "sed-inplace", shell: "bash", command: "sed -i 's/foo/bar/' ../outside.txt" },
	{ id: "c0234", category: "sed-inplace", shell: "bash", command: "sed -i.bak 's/foo/bar/' ../outside.txt" },
	{ id: "c0284", category: "perl-inplace", shell: "bash", command: "perl -i 's/foo/bar/;' ../outside.txt" },
	{ id: "c0289", category: "perl-inplace", shell: "bash", command: "perl -pi 's/foo/bar/;' ../outside.txt" },
	{ id: "c0324", category: "awk-write", shell: "bash", command: "awk '{print}' ../outside.txt > ../outside.txt" },
	{ id: "c0329", category: "awk-write", shell: "bash", command: "awk -i inplace '{print}' ../outside.txt" },
	{
		id: "c0339",
		category: "python-write",
		shell: "bash",
		command: "python -c \"open('../outside.txt','w').write('x')\"",
	},
	{
		id: "c0344",
		category: "python-write",
		shell: "bash",
		command: "python3 -c \"import pathlib;pathlib.Path('../outside.txt').write_text('x')\"",
	},
	{
		id: "c0359",
		category: "node-write",
		shell: "bash",
		command: "node -e \"require('fs').writeFileSync('../outside.txt','x')\"",
	},
	{
		id: "c0364",
		category: "node-write",
		shell: "bash",
		command: "node -e \"require('fs').appendFileSync('../outside.txt','x')\"",
	},
	{ id: "c0384", category: "ruby-write", shell: "bash", command: "ruby -e \"File.write('../outside.txt','x')\"" },
	{ id: "c0389", category: "ruby-write", shell: "bash", command: "ruby -e \"File.unlink('../outside.txt')\"" },
	{
		id: "c0394",
		category: "misc-interpreter-write",
		shell: "bash",
		command: "jq '.a=1' package.json > ../outside.txt",
	},
	{
		id: "c0399",
		category: "misc-interpreter-write",
		shell: "bash",
		command: "jq '.a=1' --output-document ../outside.txt package.json",
	},
	{ id: "c0444", category: "truncate", shell: "bash", command: "truncate -s 0 ../outside.txt" },
	{ id: "c0449", category: "truncate", shell: "bash", command: "truncate -s +1M ../outside.txt" },
	{ id: "c0459", category: "shred", shell: "bash", command: "shred -u ../outside.txt" },
	{ id: "c0464", category: "shred", shell: "bash", command: "shred -z ../outside.txt" },
	{ id: "c0469", category: "ps-setcontent", shell: "pwsh", command: "Set-Content -Path ../outside.txt -Value x" },
	{ id: "c0474", category: "ps-setcontent", shell: "pwsh", command: "Set-Content ../outside.txt x" },
	{ id: "c0489", category: "ps-addcontent", shell: "pwsh", command: "Add-Content -Path ../outside.txt -Value x" },
	{ id: "c0494", category: "ps-addcontent", shell: "pwsh", command: "ac ../outside.txt x" },
	{ id: "c0499", category: "ps-outfile", shell: "pwsh", command: "Get-Process | Out-File ../outside.txt" },
	{
		id: "c0504",
		category: "ps-outfile",
		shell: "pwsh",
		command: "Out-File -FilePath ../outside.txt -InputObject 'x'",
	},
	{ id: "c0514", category: "ps-newitem", shell: "pwsh", command: "New-Item -Path ../outside.txt -ItemType File" },
	{
		id: "c0519",
		category: "ps-newitem",
		shell: "pwsh",
		command: "New-Item -Path ../outside.txt -ItemType Directory -Force",
	},
	{ id: "c0534", category: "ps-removeitem", shell: "pwsh", command: "Remove-Item -Path ../outside.txt -Force" },
	{ id: "c0539", category: "ps-removeitem", shell: "pwsh", command: "Remove-Item -Recurse -Force ../outside.txt" },
	{
		id: "c0564",
		category: "ps-moveitem",
		shell: "pwsh",
		command: "Move-Item -Path package.json -Destination ../outside.txt",
	},
	{ id: "c0569", category: "ps-moveitem", shell: "pwsh", command: "mi a.txt ../outside.txt" },
	{
		id: "c0579",
		category: "ps-copyitem",
		shell: "pwsh",
		command: "Copy-Item -Path package.json -Destination ../outside.txt",
	},
	{ id: "c0584", category: "ps-copyitem", shell: "pwsh", command: "cpi package.json ../outside.txt" },
	{
		id: "c0594",
		category: "ps-renameitem",
		shell: "pwsh",
		command: "Rename-Item -Path ../outside.txt -NewName other",
	},
	{ id: "c0599", category: "ps-renameitem", shell: "pwsh", command: "rni ../outside.txt other" },
	{ id: "c0604", category: "ps-clearcontent", shell: "pwsh", command: "Clear-Content -Path ../outside.txt" },
	{ id: "c0609", category: "ps-clearcontent", shell: "pwsh", command: "clc ../outside.txt" },
	{
		id: "c0619",
		category: "ps-invokeexpression",
		shell: "pwsh",
		command: 'Invoke-Expression "Set-Content ../outside.txt x"',
	},
	{ id: "c0624", category: "ps-invokeexpression", shell: "pwsh", command: 'iex "rm -rf ../outside.txt"' },
	{
		id: "c0629",
		category: "ps-startprocess",
		shell: "pwsh",
		command: "Start-Process cmd -ArgumentList '/c','del ../outside.txt'",
	},
	{
		id: "c0633",
		category: "ps-newpsdrive",
		shell: "pwsh",
		command: "New-PSDrive -Name Z -PSProvider FileSystem -Root C:/outside -Mount Z:",
	},
	{ id: "c0634", category: "ps-newpsdrive", shell: "pwsh", command: "Set-Item -Path Env:PATH -Value C:/outside/bin" },
	{ id: "c0636", category: "posix-writer", shell: "bash", command: "rm -rf ../outside.txt" },
	{ id: "c0641", category: "posix-writer", shell: "bash", command: "rm ../outside.txt" },
	{ id: "c0741", category: "nested-shell", shell: "bash", command: 'bash -c "echo x > ../outside.txt"' },
	{ id: "c0746", category: "nested-shell", shell: "bash", command: 'bash -c "rm -rf ../outside.txt"' },
	{ id: "c0838", category: "command-substitution", shell: "bash", command: "echo $(rm -rf ../outside.txt)" },
	{
		id: "c0843",
		category: "command-substitution",
		shell: "bash",
		command: "echo $(cat ../outside.txt > ../outside.txt)",
	},
	{ id: "c0912", category: "obfuscated-name", shell: "bash", command: `x='r'; y='m'; \${x}\${y} src/a.ts` },
	{ id: "c0918", category: "obfuscated-name", shell: "bash", command: "x='rm'; $x ../outside.txt" },
	{ id: "c1003", category: "line-continuation", shell: "bash", command: "echo x > ../outside.txt \\\n&& echo done" },
	{ id: "c1008", category: "line-continuation", shell: "bash", command: "echo a\necho b > ../outside.txt" },
];

/** 只写 worktree 内部：只读守卫必须拦，读写守卫放行 */
const writesInsideJail: FuzzCase[] = [
	{ id: "c0001", category: "redirect-output", shell: "bash", command: "echo injected > src/a.ts" },
	{ id: "c0198", category: "tee", shell: "bash", command: "cat package.json | tee src/a.ts" },
	{ id: "c0228", category: "sed-inplace", shell: "bash", command: "sed -i 's/foo/bar/' src/a.ts" },
	{ id: "c0288", category: "perl-inplace", shell: "bash", command: "perl -pi 's/foo/bar/;' src/a.ts" },
	{ id: "c0308", category: "awk-write", shell: "bash", command: "awk '{print > \"src/a.ts\"}' package.json" },
	{ id: "c0393", category: "misc-interpreter-write", shell: "bash", command: "jq '.a=1' package.json > src/a.ts" },
	{ id: "c0423", category: "dd", shell: "bash", command: "dd of=src/a.ts" },
	{ id: "c0443", category: "truncate", shell: "bash", command: "truncate -s 0 src/a.ts" },
	{ id: "c0458", category: "shred", shell: "bash", command: "shred -u src/a.ts" },
	{ id: "c0468", category: "ps-setcontent", shell: "pwsh", command: "Set-Content -Path src/a.ts -Value x" },
	{ id: "c0488", category: "ps-addcontent", shell: "pwsh", command: "Add-Content -Path src/a.ts -Value x" },
	{ id: "c0498", category: "ps-outfile", shell: "pwsh", command: "Get-Process | Out-File src/a.ts" },
	{ id: "c0513", category: "ps-newitem", shell: "pwsh", command: "New-Item -Path src/a.ts -ItemType File" },
	{ id: "c0533", category: "ps-removeitem", shell: "pwsh", command: "Remove-Item -Path src/a.ts -Force" },
	{
		id: "c0563",
		category: "ps-moveitem",
		shell: "pwsh",
		command: "Move-Item -Path package.json -Destination src/a.ts",
	},
	{
		id: "c0578",
		category: "ps-copyitem",
		shell: "pwsh",
		command: "Copy-Item -Path package.json -Destination src/a.ts",
	},
	{ id: "c0593", category: "ps-renameitem", shell: "pwsh", command: "Rename-Item -Path src/a.ts -NewName other" },
	{ id: "c0603", category: "ps-clearcontent", shell: "pwsh", command: "Clear-Content -Path src/a.ts" },
	{ id: "c0635", category: "posix-writer", shell: "bash", command: "rm -rf src/a.ts" },
	{ id: "c0832", category: "nested-shell", shell: "bash", command: '. "src/a.ts"' },
	{ id: "c0887", category: "command-substitution", shell: "bash", command: "{ echo x > src/a.ts; }" },
	{ id: "c0917", category: "obfuscated-name", shell: "bash", command: "x='rm'; $x src/a.ts" },
	{ id: "c1007", category: "line-continuation", shell: "bash", command: "echo a\necho b > src/a.ts" },
	{ id: "c1017", category: "find-xargs", shell: "bash", command: "find . -name '*.ts' -delete" },
	{ id: "c1168", category: "curl-wget", shell: "bash", command: "curl https://example.invalid/x -o src/a.ts" },
	{ id: "c1203", category: "pipe-to-writer", shell: "bash", command: "ls -la | grep ts | tee src/a.ts" },
	{ id: "c1259", category: "env-path", shell: "bash", command: "export PATH=/tmp/evil:$PATH; rm src/a.ts" },
	{ id: "c1329", category: "unicode-homoglyph", shell: "pwsh", command: "ｒｍ src/a.ts" },
	{ id: "c1523", category: "in-jail-write", shell: "bash", command: "echo x > src/a.ts" },
];

/** 明显只读（含复杂只读管道）：两个守卫都不应拦 */
const readOnlyCommands: FuzzCase[] = [
	{ id: "c0186", category: "redirect-diagnostic-allowed", shell: "bash", command: "cat missing.txt 2>/dev/null" },
	{
		id: "c0187",
		category: "redirect-diagnostic-allowed",
		shell: "bash",
		command: "grep -r todo src 2>/dev/null | head",
	},
	{ id: "c0188", category: "redirect-diagnostic-allowed", shell: "bash", command: "ls -la > /tmp/n07-probe.txt" },
	{ id: "c0189", category: "redirect-diagnostic-allowed", shell: "bash", command: "echo x > $TMPDIR/probe.txt" },
	{ id: "c0197", category: "redirect-diagnostic-allowed", shell: "pwsh", command: "Get-ChildItem 2> $null" },
	{ id: "c1409", category: "readonly-check", shell: "bash", command: "ls" },
	{ id: "c1410", category: "readonly-check", shell: "bash", command: "ls -la" },
	{ id: "c1411", category: "readonly-check", shell: "bash", command: "ls -R packages | head -50" },
	{ id: "c1412", category: "readonly-check", shell: "bash", command: "cat package.json" },
	{ id: "c1413", category: "readonly-check", shell: "bash", command: "cat src/a.ts | head -20" },
	{ id: "c1414", category: "readonly-check", shell: "bash", command: "cat -n README.md" },
	{ id: "c1415", category: "readonly-check", shell: "bash", command: "head -n 5 package.json" },
	{ id: "c1416", category: "readonly-check", shell: "bash", command: "tail -n 20 package.json" },
	{ id: "c1417", category: "readonly-check", shell: "bash", command: "tail -c 100 package.json" },
	{ id: "c1418", category: "readonly-check", shell: "bash", command: "echo hello" },
	{ id: "c1419", category: "readonly-check", shell: "bash", command: "printf '%s\\n' note" },
	{ id: "c1420", category: "readonly-check", shell: "bash", command: "pwd" },
	{ id: "c1421", category: "readonly-check", shell: "bash", command: "which node" },
	{ id: "c1422", category: "readonly-check", shell: "bash", command: "where node" },
	{ id: "c1423", category: "readonly-check", shell: "bash", command: "file package.json" },
	{ id: "c1424", category: "readonly-check", shell: "bash", command: "stat package.json" },
	{ id: "c1425", category: "readonly-check", shell: "bash", command: "stat -c '%s %n' package.json" },
	{ id: "c1426", category: "readonly-check", shell: "bash", command: "od -c package.json | head" },
	{ id: "c1428", category: "readonly-check", shell: "bash", command: "sort package.json | uniq -c" },
	{ id: "c1429", category: "readonly-check", shell: "bash", command: "uniq package.json" },
	{ id: "c1430", category: "readonly-check", shell: "bash", command: "wc -l package.json" },
	{ id: "c1433", category: "readonly-check", shell: "bash", command: "diff -u src/a.ts src/b.ts" },
	{ id: "c1434", category: "readonly-check", shell: "bash", command: "diff -rq packages agent" },
	{ id: "c1435", category: "readonly-check", shell: "bash", command: "grep -n agent package.json" },
	{
		id: "c1436",
		category: "readonly-check",
		shell: "bash",
		command: "grep -rn 'sub-agent' packages/coding-agent/src",
	},
	{ id: "c1437", category: "readonly-check", shell: "bash", command: "grep -R --include='*.ts' -l guard src" },
	{ id: "c1438", category: "readonly-check", shell: "bash", command: "grep -c foo README.md" },
	{ id: "c1439", category: "readonly-check", shell: "bash", command: "rg --files packages" },
	{
		id: "c1440",
		category: "readonly-check",
		shell: "bash",
		command: "rg -n 'guard' packages/coding-agent/src | head -20",
	},
	{ id: "c1441", category: "readonly-check", shell: "bash", command: "rg --stats todo src" },
];

describe("shell guard fuzz regression (N07)", () => {
	const readOnlyGuard = loadReadOnlyGuardHandler();

	it("keeps every write-outside-the-jail command blocked by both guards", async () => {
		expect(writesOutsideJail.length).toBeGreaterThanOrEqual(40);
		for (const item of writesOutsideJail) {
			const readOnly = await readOnlyGuard({ toolName: "bash", input: { command: item.command } });
			expect(readOnly, `${item.id} read-only guard must block: ${item.command}`).toMatchObject({ block: true });
			const write = evaluateDelegatedWriteToolCall(item.shell, { command: item.command }, JAIL_ROOT);
			expect(write, `${item.id} write guard must block: ${item.command}`).not.toBeUndefined();
		}
	});

	it("blocks in-jail writes for the read-only guard but keeps them for the worktree guard", async () => {
		expect(writesInsideJail.length).toBeGreaterThanOrEqual(20);
		for (const item of writesInsideJail) {
			const readOnly = await readOnlyGuard({ toolName: "bash", input: { command: item.command } });
			expect(readOnly, `${item.id} read-only guard must block: ${item.command}`).toMatchObject({ block: true });
			expect(
				String((readOnly as { reason: string }).reason),
				`${item.id} block reason must carry the marker`,
			).toContain("[read-only-guard]");
			const write = evaluateDelegatedWriteToolCall(item.shell, { command: item.command }, JAIL_ROOT);
			expect(write, `${item.id} write guard must allow in-jail write: ${item.command}`).toBeUndefined();
		}
	});

	it("never blocks plainly read-only commands in either guard", async () => {
		expect(readOnlyCommands.length).toBeGreaterThanOrEqual(30);
		for (const item of readOnlyCommands) {
			const readOnly = await readOnlyGuard({ toolName: "bash", input: { command: item.command } });
			expect(readOnly, `${item.id} read-only guard must allow: ${item.command}`).toBeUndefined();
			const write = evaluateDelegatedWriteToolCall(item.shell, { command: item.command }, JAIL_ROOT);
			expect(write, `${item.id} write guard must allow: ${item.command}`).toBeUndefined();
		}
	});

	it("generates both guard extensions as loadable source for the worker", async () => {
		const writeSource = createDelegatedWriteGuardExtensionSource();
		expect(writeSource).toContain("export default function (pi)");
		expect(writeSource).toContain("MYHARNESS_INTERNAL_DELEGATED_WORKTREE");
		const source = createReadOnlyGuardExtensionSource("blocked", { mode: "delegated" });
		expect(source).not.toContain("__name");
		expect(source).toContain("[read-only-guard]");
	});
});
