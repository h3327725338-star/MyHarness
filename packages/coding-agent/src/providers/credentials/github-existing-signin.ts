import { spawn } from "node:child_process";

/** Where a GitHub sign-in already present on this computer was found. */
export type ExistingGitHubSource = "gh" | "git";

export interface ExistingGitHubSignIn {
	source: ExistingGitHubSource;
	token: string;
}

/** Finds a GitHub sign-in this computer already holds; `interactive` may let Git show its own sign-in window. */
export type ExistingGitHubFinder = (
	signal: AbortSignal,
	interactive: boolean,
) => Promise<ExistingGitHubSignIn | undefined>;

// Only API tokens are taken: a plain account password stored for Git cannot call the GitHub API.
const TOKEN = /^(?:gh[opsu]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;
const GITHUB_HOST = "protocol=https\nhost=github.com\n";
const QUIET_MS = 15000;
// Git's own sign-in window waits for the user to finish in the browser.
const INTERACTIVE_MS = 5 * 60 * 1000;

interface RunResult {
	code: number | null;
	stdout: string;
}

/** Runs a command without a console window or shell; output is kept in memory only (it may hold a token). */
function run(
	command: string,
	args: string[],
	options: { input?: string; env?: Record<string, string | undefined>; timeoutMs: number; signal: AbortSignal },
): Promise<RunResult> {
	return new Promise((resolve) => {
		if (options.signal.aborted) return resolve({ code: null, stdout: "" });
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				windowsHide: true,
				env: { ...process.env, ...options.env },
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			return resolve({ code: null, stdout: "" });
		}
		let stdout = "";
		let settled = false;
		const stop = () => child.kill();
		const timer = setTimeout(stop, options.timeoutMs);
		options.signal.addEventListener("abort", stop, { once: true });
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal.removeEventListener("abort", stop);
			resolve({ code, stdout });
		};
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > 64 * 1024) stop();
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code));
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(options.input ?? "");
	});
}

/** `key=value` lines of Git's credential protocol. */
function credentialFields(text: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const at = line.indexOf("=");
		if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
	}
	return fields;
}

/** GitHub CLI's saved sign-in (`gh auth login`). */
async function fromGitHubCli(signal: AbortSignal): Promise<ExistingGitHubSignIn | undefined> {
	const result = await run("gh", ["auth", "token", "--hostname", "github.com"], {
		env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
		timeoutMs: QUIET_MS,
		signal,
	});
	const token = result.stdout.trim();
	return result.code === 0 && TOKEN.test(token) ? { source: "gh", token } : undefined;
}

/**
 * Git's credential helper for github.com (Git Credential Manager on Windows). Quietly it only answers with a saved
 * sign-in; `interactive` lets Git Credential Manager open its own GitHub sign-in, and the result is saved for Git too.
 */
async function fromGit(signal: AbortSignal, interactive: boolean): Promise<ExistingGitHubSignIn | undefined> {
	const result = await run("git", ["credential", "fill"], {
		input: `${GITHUB_HOST}\n`,
		env: {
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: interactive ? "auto" : "never",
			GIT_ASKPASS: "",
			SSH_ASKPASS: "",
		},
		timeoutMs: interactive ? INTERACTIVE_MS : QUIET_MS,
		signal,
	});
	if (result.code !== 0) return undefined;
	const fields = credentialFields(result.stdout);
	const token = fields.password?.trim() ?? "";
	if (!TOKEN.test(token)) return undefined;
	if (interactive) {
		// A sign-in Git asked for is kept by Git only once it is approved, as after a successful push.
		await run("git", ["credential", "approve"], {
			input: `${GITHUB_HOST}username=${fields.username ?? ""}\npassword=${token}\n\n`,
			env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
			timeoutMs: QUIET_MS,
			signal,
		});
	}
	return { source: "git", token };
}

/**
 * The default finder: GitHub CLI first (its token can read organizations), then Git's saved sign-in, and only when the
 * user asked to sign in and neither had one, Git Credential Manager's own GitHub sign-in in the browser.
 */
export const findExistingGitHubSignIn: ExistingGitHubFinder = async (signal, interactive) =>
	(await fromGitHubCli(signal)) ??
	(await fromGit(signal, false)) ??
	(interactive && !signal.aborted ? await fromGit(signal, true) : undefined);
