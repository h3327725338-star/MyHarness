import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/tools/shell/bash.ts";
import {
	createDelegatedWriteGuardExtensionSource,
	evaluateDelegatedWriteToolCall,
	WRITE_GUARD_BLOCK_MARKER,
} from "../src/tools/shell/delegated-write-guard.ts";
import { createPwshToolDefinition } from "../src/tools/shell/pwsh.ts";
import {
	createReadOnlyGuardExtensionSource,
	READ_ONLY_GUARD_BLOCK_MARKER,
} from "../src/tools/shell/read-only-guard.ts";
import { resolveSessionScope } from "../src/tools/shell/session-scope.ts";
import {
	getShellSessionRecord,
	PROBE_BEGIN_MARKER,
	PROBE_END_MARKER,
	resetShellSessionRecords,
	stripProbeFromPartialOutput,
} from "../src/tools/shell/shell-session.ts";
import { terminateProcessTree, waitForChildProcess } from "../src/utils/child-process.ts";
import { pathIdentityKey } from "../src/utils/paths.ts";

function makeSessionCtx(sessionId: string) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
		},
	};
}

describe("shell session state and guard isolation", () => {
	let testDir: string;
	let subDir: string;

	beforeEach(() => {
		testDir = realpathSync.native(
			(() => {
				const p = join(tmpdir(), `myharness-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
				mkdirSync(p, { recursive: true });
				return p;
			})(),
		);
		subDir = join(testDir, "subdir");
		mkdirSync(subDir, { recursive: true });
	});

	afterEach(() => {
		delete process.env.ZZ_UNSET_ME;
		delete process.env.ZZ_SECRET_TOKEN;
		resetShellSessionRecords();
		if (testDir && existsSync(testDir)) {
			try {
				rmSync(testDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}
	});

	it("preserves cd and export across consecutive bash calls with preserve_state: true", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-bash-state-1");

		const res1 = await bashDef.execute(
			"call-1",
			{
				command: "cd subdir && export MY_HARNESS_BASH_VAR=preserved_val",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);
		expect(res1.details?.exitCode).toBe(0);
		expect((res1.content[0] as { text: string }).text).not.toContain(PROBE_BEGIN_MARKER);
		expect((res1.content[0] as { text: string }).text).not.toContain(PROBE_END_MARKER);
		expect((res1.content[0] as { text: string }).text).not.toContain("__myharness_ec");

		const res2 = await bashDef.execute(
			"call-2",
			{
				command: "pwd && echo VAR=$MY_HARNESS_BASH_VAR",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (res2.content[0] as { text: string }).text;
		expect(text.toLowerCase()).toContain("subdir");
		expect(text).toContain("VAR=preserved_val");
		expect(text).not.toContain(PROBE_BEGIN_MARKER);
		expect(text).not.toContain(PROBE_END_MARKER);
		expect(text).not.toContain("__myharness_ec");
	});

	it("preserves Set-Location and environment variables across consecutive pwsh calls with preserve_state: true", async () => {
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-pwsh-state-1");

		const res1 = await pwshDef.execute(
			"call-1",
			{
				command: 'Set-Location subdir; $env:MY_HARNESS_PWSH_VAR="preserved_pwsh"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);
		expect(res1.details?.exitCode).toBe(0);
		expect((res1.content[0] as { text: string }).text).not.toContain(PROBE_BEGIN_MARKER);
		expect((res1.content[0] as { text: string }).text).not.toContain(PROBE_END_MARKER);
		expect((res1.content[0] as { text: string }).text).not.toContain("__myharness_ec");

		const res2 = await pwshDef.execute(
			"call-2",
			{
				command: 'Write-Output "LOC=$((Get-Location).Path)"; Write-Output "VAR=$env:MY_HARNESS_PWSH_VAR"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text2 = (res2.content[0] as { text: string }).text;
		expect(text2.toLowerCase()).toContain("subdir");
		expect(text2).toContain("VAR=preserved_pwsh");
		expect(text2).not.toContain(PROBE_BEGIN_MARKER);
		expect(text2).not.toContain(PROBE_END_MARKER);
		expect(text2).not.toContain("__myharness_ec");
	});

	it("preserves prior state when a subsequent bash command fails and passes non-zero exit code", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-bash-err-state");

		await bashDef.execute(
			"init-state",
			{
				command: "cd subdir && export STABLE_VAR=initial_good",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		await expect(
			bashDef.execute(
				"failing-cmd",
				{
					command: "export STABLE_VAR=bad_update && exit 33",
					preserve_state: true,
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/exited with code 33/);

		const resAfter = await bashDef.execute(
			"verify-state",
			{
				command: "pwd && echo STABLE=$STABLE_VAR",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (resAfter.content[0] as { text: string }).text;
		expect(text.toLowerCase()).toContain("subdir");
		expect(text).toContain("STABLE=initial_good");
		expect(text).not.toContain("bad_update");
	});

	it("preserves prior state when a subsequent pwsh command fails and passes non-zero exit code", async () => {
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-pwsh-err-state");

		await pwshDef.execute(
			"init-state",
			{
				command: 'Set-Location subdir; $env:PWSH_STABLE="good_val"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		await expect(
			pwshDef.execute(
				"failing-cmd",
				{
					command: '$env:PWSH_STABLE="corrupted"; exit 21',
					preserve_state: true,
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/exited with code 21/);

		const resAfter = await pwshDef.execute(
			"verify-state",
			{
				command: 'Write-Output "LOC=$((Get-Location).Path)"; Write-Output "PWSH_STABLE=$env:PWSH_STABLE"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (resAfter.content[0] as { text: string }).text;
		expect(text.toLowerCase()).toContain("subdir");
		expect(text).toContain("PWSH_STABLE=good_val");
		expect(text).not.toContain("corrupted");
	});

	it("strips probe markers from bash error output on failure and prevents probe leakage", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-bash-probe-strip");

		let caughtError: Error | undefined;
		try {
			await bashDef.execute(
				"fail",
				{
					command: 'echo "legitimate_error_message" && (exit 15)',
					preserve_state: true,
				},
				undefined,
				undefined,
				ctx,
			);
		} catch (error) {
			caughtError = error as Error;
		}

		expect(caughtError).toBeDefined();
		expect(caughtError?.message).toContain("legitimate_error_message");
		expect(caughtError?.message).toContain("exited with code 15");
		expect(caughtError?.message).not.toContain(PROBE_BEGIN_MARKER);
		expect(caughtError?.message).not.toContain(PROBE_END_MARKER);
		expect(caughtError?.message).not.toContain("__myharness_ec");
	});

	it("strips probe markers from pwsh error output on failure and prevents probe leakage", async () => {
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-pwsh-probe-strip");

		let caughtError: Error | undefined;
		try {
			await pwshDef.execute(
				"fail",
				{
					command: 'Write-Output "legitimate_pwsh_error"; cmd /c exit 17',
					preserve_state: true,
				},
				undefined,
				undefined,
				ctx,
			);
		} catch (error) {
			caughtError = error as Error;
		}

		expect(caughtError).toBeDefined();
		expect(caughtError?.message).toContain("legitimate_pwsh_error");
		expect(caughtError?.message).toContain("exited with code 17");
		expect(caughtError?.message).not.toContain(PROBE_BEGIN_MARKER);
		expect(caughtError?.message).not.toContain(PROBE_END_MARKER);
		expect(caughtError?.message).not.toContain("__myharness_ec");
	});

	it("does not false-positive strip command output containing probe-like strings", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-probe-collision");

		const res = await bashDef.execute(
			"collision-test",
			{
				command: 'echo "fake __MYHARNESS_STATE_PROBE_START__ probe line"; echo "after fake line"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain("fake __MYHARNESS_STATE_PROBE_START__ probe line");
		expect(text).toContain("after fake line");
	});

	it("default behavior without preserve_state is stateless across calls (bash)", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-stateless-bash");

		await bashDef.execute(
			"step-1",
			{
				command: "cd subdir && export STATELSS_VAR=one",
			},
			undefined,
			undefined,
			ctx,
		);

		const res2 = await bashDef.execute(
			"step-2",
			{
				command: "pwd && echo VAL=$STATELSS_VAR",
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (res2.content[0] as { text: string }).text;
		expect(text).not.toContain("VAL=one");
	});

	it("default behavior without preserve_state is stateless across calls (pwsh)", async () => {
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-stateless-pwsh");

		await pwshDef.execute(
			"step-1",
			{
				command: 'Set-Location subdir; $env:PWSH_STATELESS="one"',
			},
			undefined,
			undefined,
			ctx,
		);

		const res2 = await pwshDef.execute(
			"step-2",
			{
				command: 'Write-Output "VAL=$env:PWSH_STATELESS"',
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (res2.content[0] as { text: string }).text;
		expect(text).not.toContain("VAL=one");
	});

	it("read-only guard rejects bash run_in_background and preserve_state", async () => {
		const source = createReadOnlyGuardExtensionSource("blocked");
		const createExtension = new Function(
			source.replace("export default function (pi) {", "return function (pi) {"),
		) as () => (pi: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) => void;

		let handler:
			| ((event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>)
			| undefined;

		createExtension()({
			on: (_event, registered) => {
				handler = registered as typeof handler;
			},
		});

		const bgBlock = (await handler?.(
			{ toolName: "bash", input: { command: "ls", run_in_background: true } },
			{},
		)) as { block: boolean; reason: string };
		expect(bgBlock?.block).toBe(true);
		expect(bgBlock?.reason).toContain(READ_ONLY_GUARD_BLOCK_MARKER);
		expect(bgBlock?.reason).toContain("run_in_background");

		const stateBlock = (await handler?.(
			{ toolName: "bash", input: { command: "ls", preserve_state: true } },
			{},
		)) as { block: boolean; reason: string };
		expect(stateBlock?.block).toBe(true);
		expect(stateBlock?.reason).toContain(READ_ONLY_GUARD_BLOCK_MARKER);
		expect(stateBlock?.reason).toContain("preserve_state");
	});

	it("delegated write guard rejects bash and pwsh run_in_background and preserve_state", async () => {
		const root = testDir;

		expect(evaluateDelegatedWriteToolCall("bash", { command: "ls", run_in_background: true }, root)).toContain(
			"run_in_background 或 preserve_state",
		);

		expect(evaluateDelegatedWriteToolCall("bash", { command: "ls", preserve_state: true }, root)).toContain(
			"run_in_background 或 preserve_state",
		);

		expect(
			evaluateDelegatedWriteToolCall("pwsh", { command: "Get-ChildItem", run_in_background: true }, root),
		).toContain("run_in_background 或 preserve_state");

		expect(
			evaluateDelegatedWriteToolCall("pwsh", { command: "Get-ChildItem", preserve_state: true }, root),
		).toContain("run_in_background 或 preserve_state");

		const source = createDelegatedWriteGuardExtensionSource();
		const createExtension = new Function(
			source.replace("export default function (pi) {", "return function (pi) {"),
		) as () => (pi: { on: (event: string, handler: (event: unknown) => unknown) => void }) => void;

		let handler: ((event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) | undefined;
		createExtension()({
			on: (_event, registered) => {
				handler = registered as typeof handler;
			},
		});

		const intercepted = (await handler?.({
			toolName: "pwsh",
			input: { command: "Get-ChildItem", run_in_background: true },
		})) as { block: boolean; reason: string };

		expect(intercepted?.block).toBe(true);
		expect(intercepted?.reason).toContain(WRITE_GUARD_BLOCK_MARKER);
		expect(intercepted?.reason).toContain("run_in_background");
	});

	it("waitForChildProcess maxPostExitDrainMs prevents hanging when child exits but descendant keeps stdout open", async () => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				"const cp = require('child_process'); cp.spawn(process.execPath, ['-e', 'setInterval(()=>{console.log(\"drain_tick\")}, 100)'], { detached: true, stdio: ['ignore', 1, 2] }); process.exit(0);",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		const start = Date.now();
		const exitCode = await waitForChildProcess(child, { maxPostExitDrainMs: 500 });
		const elapsed = Date.now() - start;

		await terminateProcessTree(child);

		expect(exitCode).toBe(0);
		expect(elapsed).toBeLessThan(3500);
	});

	it("B3-bash: command failing at final statement runs probe but preserves prior state", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-bash-probe-fail-state");

		await bashDef.execute(
			"init-state",
			{
				command: "cd subdir && export STABLE_VAR=initial_good",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		let caughtError: Error | undefined;
		try {
			await bashDef.execute(
				"failing-cmd",
				{
					command: "export STABLE_VAR=bad_update; false",
					preserve_state: true,
				},
				undefined,
				undefined,
				ctx,
			);
		} catch (error) {
			caughtError = error as Error;
		}

		expect(caughtError).toBeDefined();
		expect(caughtError?.message).toContain("exited with code 1");
		expect(caughtError?.message).not.toContain(PROBE_BEGIN_MARKER);
		expect(caughtError?.message).not.toContain(PROBE_END_MARKER);
		expect(caughtError?.message).not.toContain("__myharness_ec");

		const resAfter = await bashDef.execute(
			"verify-state",
			{
				command: "pwd && echo STABLE=$STABLE_VAR",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (resAfter.content[0] as { text: string }).text;
		expect(text.toLowerCase()).toContain("subdir");
		expect(text).toContain("STABLE=initial_good");
		expect(text).not.toContain("bad_update");
	});

	it("B3-pwsh: command failing at final statement runs probe but preserves prior state", async () => {
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-pwsh-probe-fail-state");

		await pwshDef.execute(
			"init-state",
			{
				command: 'Set-Location subdir; $env:PWSH_STABLE="good_val"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		let caughtError: Error | undefined;
		try {
			await pwshDef.execute(
				"failing-cmd",
				{
					command: '$env:PWSH_STABLE="corrupted"; cmd /c exit 21',
					preserve_state: true,
				},
				undefined,
				undefined,
				ctx,
			);
		} catch (error) {
			caughtError = error as Error;
		}

		expect(caughtError).toBeDefined();
		expect(caughtError?.message).toContain("exited with code 21");
		expect(caughtError?.message).not.toContain(PROBE_BEGIN_MARKER);
		expect(caughtError?.message).not.toContain(PROBE_END_MARKER);
		expect(caughtError?.message).not.toContain("__myharness_ec");

		const resAfter = await pwshDef.execute(
			"verify-state",
			{
				command: 'Write-Output "LOC=$((Get-Location).Path)"; Write-Output "PWSH_STABLE=$env:PWSH_STABLE"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (resAfter.content[0] as { text: string }).text;
		expect(text.toLowerCase()).toContain("subdir");
		expect(text).toContain("PWSH_STABLE=good_val");
		expect(text).not.toContain("corrupted");
	});

	it("B5: preserves user output colliding with true PROBE_BEGIN_MARKER and still captures state", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-probe-collision-true");

		const res1 = await bashDef.execute(
			"collide",
			{
				command: `echo '${PROBE_BEGIN_MARKER}' && export COLLIDE_VAR=1`,
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text1 = (res1.content[0] as { text: string }).text;
		expect(text1).toContain(PROBE_BEGIN_MARKER);

		const res2 = await bashDef.execute(
			"verify",
			{
				command: "echo COLLIDE=$COLLIDE_VAR",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text2 = (res2.content[0] as { text: string }).text;
		expect(text2).toContain("COLLIDE=1");
	});

	it("B6-bash: unset environment variable is recorded and omitted from later bash calls", async () => {
		process.env.ZZ_UNSET_ME = "1";
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-unset-bash");

		await bashDef.execute(
			"unset-step",
			{
				command: "unset ZZ_UNSET_ME",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const res = await bashDef.execute(
			"check-step",
			{
				command: `echo "VAL=\${ZZ_UNSET_ME:-empty}"`,
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain("VAL=empty");
	});

	it("B6-pwsh: Remove-Item Env: variable is recorded and omitted from later pwsh calls", async () => {
		process.env.ZZ_UNSET_ME = "1";
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-unset-pwsh");

		await pwshDef.execute(
			"unset-step",
			{
				command: "Remove-Item Env:ZZ_UNSET_ME",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const res = await pwshDef.execute(
			"check-step",
			{
				command: 'Write-Output "VAL=$($env:ZZ_UNSET_ME)"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain("VAL=");
		expect(text).not.toContain("VAL=1");
	});

	it("B7: bash and pwsh session states are scoped separately and do not bleed into each other", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-shared-id-different-tools");

		await bashDef.execute(
			"bash-cd",
			{
				command: "cd subdir",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		// Each shell keeps its state record under its own key prefix.
		expect(getShellSessionRecord(resolveSessionScope(ctx, testDir, "bash:"))?.cwd.toLowerCase()).toContain("subdir");
		expect(getShellSessionRecord(resolveSessionScope(ctx, testDir, "pwsh:"))).toBeUndefined();

		const res = await pwshDef.execute(
			"pwsh-pwd",
			{
				command: 'Write-Output "LOC=$((Get-Location).Path)"',
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const text = (res.content[0] as { text: string }).text;
		expect(text.toLowerCase()).not.toContain("subdir");
		// Windows runners can spell the same directory with an 8.3 short name (RUNNER~1)
		// in tmpdir() while pwsh reports the long name (runneradmin): compare canonical identities.
		const locValue = (text.split(/\r?\n/).find((line) => line.includes("LOC=")) ?? "").split("LOC=")[1]?.trim() ?? "";
		expect(locValue).not.toBe("");
		expect(pathIdentityKey(locValue)).toBe(pathIdentityKey(testDir));
	});

	it("B8: filters bash internal noise environment variables from session overrides", async () => {
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-bash-noise");

		await bashDef.execute(
			"run-bash",
			{
				command: "echo noise_check",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const stateKey = resolveSessionScope(ctx, testDir, "bash:");
		const record = getShellSessionRecord(stateKey);
		expect(record).toBeDefined();
		expect(record?.envOverrides).not.toHaveProperty("SHLVL");
		expect(record?.envOverrides).not.toHaveProperty("OLDPWD");
		expect(record?.envOverrides).not.toHaveProperty("_");
	});

	it("B9: falls back to default cwd when preserved cwd directory was deleted", async () => {
		const tempSub = join(testDir, "temp-sub");
		mkdirSync(tempSub, { recursive: true });

		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-deleted-cwd-fallback");

		await bashDef.execute(
			"cd-step",
			{
				command: "cd temp-sub",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		rmSync(tempSub, { recursive: true, force: true });

		const res = await bashDef.execute(
			"next-step",
			{
				command: "pwd",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		expect(res.details?.exitCode).toBe(0);
		const text = (res.content[0] as { text: string }).text;
		expect(text).not.toContain("temp-sub");
	});

	it("B12-unit: stripProbeFromPartialOutput cuts probe blocks and in-flight marker prefixes", () => {
		expect(stripProbeFromPartialOutput("abc\n#MYHARNESS_STATE_P")).toBe("abc");
		expect(stripProbeFromPartialOutput("hello world\nline 2")).toBe("hello world\nline 2");
		expect(stripProbeFromPartialOutput(`visible_output\n${PROBE_BEGIN_MARKER}\nexport foo=bar`)).toBe(
			"visible_output",
		);
	});

	it("B12-bash: streaming onUpdate snapshots do not leak probe markers or secret env vars", async () => {
		process.env.ZZ_SECRET_TOKEN = "sk-live-SECRET-123";
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-streaming-leak-bash");

		const updates: string[] = [];
		const res = await bashDef.execute(
			"stream-bash",
			{
				command: 'echo "stream_bash_hello"',
				preserve_state: true,
			},
			undefined,
			(update) => {
				const first = update.content[0];
				const text = first?.type === "text" ? first.text : "";
				if (text) updates.push(text);
			},
			ctx,
		);

		const finalVisible = (res.content[0] as { text: string }).text;
		expect(finalVisible).toContain("stream_bash_hello");
		expect(finalVisible).not.toContain("sk-live-SECRET-123");
		expect(finalVisible).not.toContain(PROBE_BEGIN_MARKER);

		expect(updates.length).toBeGreaterThan(0);
		for (const u of updates) {
			expect(u).not.toContain("sk-live-SECRET-123");
			expect(u).not.toContain(PROBE_BEGIN_MARKER);
		}
	});

	it("B12-pwsh: streaming onUpdate snapshots do not leak probe markers or secret env vars", async () => {
		process.env.ZZ_SECRET_TOKEN = "sk-live-SECRET-123";
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-streaming-leak-pwsh");

		const updates: string[] = [];
		const res = await pwshDef.execute(
			"stream-pwsh",
			{
				command: 'Write-Output "stream_pwsh_hello"',
				preserve_state: true,
			},
			undefined,
			(update) => {
				const first = update.content[0];
				const text = first?.type === "text" ? first.text : "";
				if (text) updates.push(text);
			},
			ctx,
		);

		const finalVisible = (res.content[0] as { text: string }).text;
		expect(finalVisible).toContain("stream_pwsh_hello");
		expect(finalVisible).not.toContain("sk-live-SECRET-123");
		expect(finalVisible).not.toContain(PROBE_BEGIN_MARKER);

		expect(updates.length).toBeGreaterThan(0);
		for (const u of updates) {
			expect(u).not.toContain("sk-live-SECRET-123");
			expect(u).not.toContain(PROBE_BEGIN_MARKER);
		}
	});

	it("B13-bash: fullOutputPath temp file does not contain probe markers or secret env vars", async () => {
		process.env.ZZ_SECRET_TOKEN = "sk-live-SECRET-123";
		const bashDef = createBashToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-tempfile-leak-bash");

		const res = await bashDef.execute(
			"long-bash",
			{
				command: "seq 1 5000",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		expect(res.details?.fullOutputPath).toBeDefined();
		const fullOutputPath = res.details!.fullOutputPath!;
		expect(existsSync(fullOutputPath)).toBe(true);

		const content = readFileSync(fullOutputPath, "utf8");
		expect(content).not.toContain(PROBE_BEGIN_MARKER);
		expect(content).not.toContain("sk-live-SECRET-123");
		expect(content).toContain("5000");
	});

	it("B13-pwsh: fullOutputPath temp file does not contain probe markers or secret env vars", async () => {
		process.env.ZZ_SECRET_TOKEN = "sk-live-SECRET-123";
		const pwshDef = createPwshToolDefinition(testDir);
		const ctx = makeSessionCtx("sess-tempfile-leak-pwsh");

		const res = await pwshDef.execute(
			"long-pwsh",
			{
				command: "1..5000",
				preserve_state: true,
			},
			undefined,
			undefined,
			ctx,
		);

		expect(res.details?.fullOutputPath).toBeDefined();
		const fullOutputPath = res.details!.fullOutputPath!;
		expect(existsSync(fullOutputPath)).toBe(true);

		const content = readFileSync(fullOutputPath, "utf8");
		expect(content).not.toContain(PROBE_BEGIN_MARKER);
		expect(content).not.toContain("sk-live-SECRET-123");
		expect(content).toContain("5000");
	});
});
