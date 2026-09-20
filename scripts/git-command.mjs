import { spawnSync } from "node:child_process";

const DEFAULT_GIT_TIMEOUT_MS = 5 * 60 * 1000;

function formatGitCommand(args) {
	return ["git", ...args.map((value) => (value.includes(" ") ? JSON.stringify(value) : value))].join(" ");
}

function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

export function runGitSync(args, options = {}) {
	const capture = options.stdio !== "inherit";
	const result = spawnSync("git", args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: false,
		windowsHide: true,
		timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		env: {
			...process.env,
			...options.env,
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			GIT_PAGER: "cat",
		},
	});
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	const timedOut = result.error?.code === "ETIMEDOUT";
	const ok = result.status === 0 && !result.error;
	const failureKind = ok ? undefined : timedOut ? "timeout" : result.error ? "spawn" : "exit";
	return {
		ok,
		stdout,
		stderr,
		exitCode: result.status,
		signal: result.signal,
		...(failureKind
			? {
				failureKind,
				error: timedOut
					? `${formatGitCommand(args)} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`
					: `${formatGitCommand(args)} failed${result.error ? `: ${getErrorMessage(result.error)}` : ""}`,
			}
			: {}),
	};
}

export function runGitSyncChecked(args, options = {}) {
	const result = runGitSync(args, options);
	if (!result.ok) {
		throw new Error(result.error ?? `${formatGitCommand(args)} failed`);
	}
	return result;
}
