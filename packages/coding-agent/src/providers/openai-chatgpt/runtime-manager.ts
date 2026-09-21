import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomically } from "../../utils/atomic-write.ts";

const execFileAsync = promisify(execFile);

/** Pin the managed App Server runtime independently from MyHarness releases. */
export const OPENAI_CHATGPT_CODEX_VERSION = "0.155.1";
export const OPENAI_CHATGPT_NPM_REGISTRY = "https://registry.npmjs.org";
export const OPENAI_CHATGPT_PACKAGE = "@openai/codex";
/** Official named permission profile written into the provider-owned CODEX_HOME. */
export const OPENAI_CHATGPT_PERMISSION_PROFILE = "myharness_openai_chatgpt";

/** Integrity values published for the generic and Windows x64 packages. */
export const OPENAI_CHATGPT_PACKAGE_INTEGRITY = {
	generic: "sha512-02fAAGyBtlA1zPjEo3kTj/bOSYbPz5DvjLwRZJdV7weFFEDzNFOMjQGmZ/+5CuirYV0hE+AZTrnjzwXYU4AdAQ==",
	win32X64: "sha512-MO+cCZrgU0Ec7lJP/5NsTe5obJ9/qtRMkQUK0jYWTY1omxLA3lp5IOD2IAmsejlEJB931XRo51LZ7hl178CDjA==",
} as const;

const WINDOWS_NATIVE_EXECUTABLE = join("vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const MANAGED_CODEX_CONFIG = `approval_policy = "never"
sandbox_mode = "read-only"
default_permissions = "${OPENAI_CHATGPT_PERMISSION_PROFILE}"
web_search = "disabled"
allow_login_shell = false
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[agents]
enabled = false

[features]
apps = false
hooks = false
multi_agent = false
remote_plugin = false
shell_tool = false
unified_exec = false

[permissions.${OPENAI_CHATGPT_PERMISSION_PROFILE}.filesystem]
":root" = "deny"
":minimal" = "read"

[permissions.${OPENAI_CHATGPT_PERMISSION_PROFILE}.filesystem.":workspace_roots"]
"." = "read"

[permissions.${OPENAI_CHATGPT_PERMISSION_PROFILE}.network]
enabled = false
`;

export interface OpenAIChatGPTRuntimeManagerOptions {
	agentDir: string;
	runtimeRoot?: string;
	/** Explicit executable injection is intended for tests and local diagnostics. */
	executablePath?: string;
	npmCommand?: string;
	/** Disable package installation in tests that provide an executable path. */
	install?: boolean;
}

export interface OpenAIChatGPTSessionDirectories {
	providerDataRoot: string;
	codexHome: string;
	sandbox: string;
	runtimeState: string;
}

export class OpenAIChatGPTRuntimeError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OpenAIChatGPTRuntimeError";
	}
}

/**
 * Owns the downloaded Codex App Server runtime and all provider-only paths.
 * The provider never resolves a Codex executable from PATH and never uses the
 * user's normal CODEX_HOME or workspace as the App Server working directory.
 */
export class OpenAIChatGPTRuntimeManager {
	private readonly options: OpenAIChatGPTRuntimeManagerOptions;
	private readonly agentDir: string;
	private readonly providerDataRoot: string;
	private readonly runtimeRoot: string;
	private installPromise: Promise<string> | undefined;

	constructor(options: OpenAIChatGPTRuntimeManagerOptions) {
		this.options = options;
		this.agentDir = resolve(options.agentDir);
		this.providerDataRoot = join(this.agentDir, "providers", "openai-chatgpt");
		this.runtimeRoot = resolve(
			options.runtimeRoot ??
				join(this.agentDir, "runtimes", "openai-chatgpt", `codex-${OPENAI_CHATGPT_CODEX_VERSION}`),
		);
	}

	getVersion(): string {
		return OPENAI_CHATGPT_CODEX_VERSION;
	}

	getRuntimeRoot(): string {
		return this.runtimeRoot;
	}

	getProviderDataRoot(): string {
		return this.providerDataRoot;
	}

	getCodexHome(): string {
		return join(this.providerDataRoot, "codex-home");
	}

	getRuntimeStateRoot(): string {
		return join(this.providerDataRoot, "runtime-state");
	}

	getSandboxRoot(): string {
		return join(this.providerDataRoot, "sandboxes");
	}

	getSessionDirectories(sessionId: string | undefined): OpenAIChatGPTSessionDirectories {
		const safeSessionId = makeSafeSessionId(sessionId ?? "anonymous");
		return {
			providerDataRoot: this.providerDataRoot,
			codexHome: this.getCodexHome(),
			sandbox: join(this.getSandboxRoot(), safeSessionId),
			runtimeState: join(this.getRuntimeStateRoot(), `${safeSessionId}.json`),
		};
	}

	async ensureSessionDirectories(sessionId: string | undefined): Promise<OpenAIChatGPTSessionDirectories> {
		const directories = this.getSessionDirectories(sessionId);
		await Promise.all([
			mkdir(directories.codexHome, { recursive: true }),
			mkdir(directories.sandbox, { recursive: true }),
			mkdir(this.getRuntimeStateRoot(), { recursive: true }),
		]);
		await writeFileAtomically(join(directories.codexHome, "config.toml"), MANAGED_CODEX_CONFIG);
		return directories;
	}

	async resolveExecutablePath(): Promise<string> {
		if (this.options.executablePath !== undefined) {
			const executablePath = resolve(this.options.executablePath);
			await assertFile(executablePath, "Configured OpenAI ChatGPT App Server executable was not found");
			return executablePath;
		}
		if (process.platform !== "win32" || process.arch !== "x64") {
			throw new OpenAIChatGPTRuntimeError(
				"The managed OpenAI ChatGPT provider currently supports Windows x64 only.",
			);
		}

		const existing = await this.findInstalledExecutable();
		if (existing) return existing;
		if (this.options.install === false) {
			throw new OpenAIChatGPTRuntimeError(
				`Managed OpenAI ChatGPT runtime ${OPENAI_CHATGPT_CODEX_VERSION} is not installed at ${this.runtimeRoot}`,
			);
		}
		this.installPromise ??= this.installManagedRuntime();
		try {
			return await this.installPromise;
		} finally {
			this.installPromise = undefined;
		}
	}

	private async findInstalledExecutable(): Promise<string | undefined> {
		const executable = await findExecutable(this.runtimeRoot);
		if (!executable) return undefined;
		await verifyPackageLock(this.runtimeRoot);
		return executable;
	}

	private async installManagedRuntime(): Promise<string> {
		await mkdir(join(this.runtimeRoot, ".."), { recursive: true });
		const staging = await mkdtemp(join(tmpdir(), "myharness-openai-chatgpt-"));
		try {
			await writeFile(
				join(staging, "package.json"),
				JSON.stringify(
					{
						name: "myharness-openai-chatgpt-runtime",
						private: true,
						dependencies: { [OPENAI_CHATGPT_PACKAGE]: OPENAI_CHATGPT_CODEX_VERSION },
					},
					null,
					2,
				),
				"utf8",
			);
			const npmCommand = this.options.npmCommand ?? (process.platform === "win32" ? "npm.cmd" : "npm");
			try {
				await execFileAsync(
					npmCommand,
					[
						"install",
						"--ignore-scripts",
						"--no-audit",
						"--no-fund",
						"--registry",
						OPENAI_CHATGPT_NPM_REGISTRY,
						"--prefix",
						staging,
					],
					{ cwd: staging, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
				);
			} catch (error) {
				throw new OpenAIChatGPTRuntimeError("Unable to install the pinned OpenAI Codex App Server runtime.", {
					cause: error,
				});
			}

			await verifyPackageLock(staging);
			const executable = await findExecutable(staging);
			if (!executable) {
				throw new OpenAIChatGPTRuntimeError(
					"The pinned OpenAI Codex package did not contain a Windows x64 App Server executable.",
				);
			}

			const existing = await findExecutable(this.runtimeRoot);
			if (existing) {
				await verifyPackageLock(this.runtimeRoot);
				return existing;
			}
			try {
				await rename(staging, this.runtimeRoot);
			} catch (error) {
				const existing = await findExecutable(this.runtimeRoot);
				if (existing) {
					await verifyPackageLock(this.runtimeRoot);
					return existing;
				}
				throw new OpenAIChatGPTRuntimeError("Unable to activate the managed OpenAI ChatGPT runtime.", {
					cause: error,
				});
			}
			return join(this.runtimeRoot, executable.slice(staging.length + 1));
		} finally {
			await rm(staging, { recursive: true, force: true }).catch(() => {});
		}
	}
}

async function findExecutable(root: string): Promise<string | undefined> {
	const candidates = [
		join(root, "node_modules", "@openai", "codex-win32-x64", WINDOWS_NATIVE_EXECUTABLE),
		join(root, "node_modules", "@openai", "codex", WINDOWS_NATIVE_EXECUTABLE),
	];
	for (const candidate of candidates) {
		try {
			await assertFile(candidate, "");
			return candidate;
		} catch {
			// Continue to the next supported npm layout.
		}
	}
	return undefined;
}

async function assertFile(path: string, message: string): Promise<void> {
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error("not a file");
	} catch (error) {
		if (!message) throw error;
		throw new OpenAIChatGPTRuntimeError(`${message}: ${path}`, { cause: error });
	}
}

async function verifyPackageLock(root: string): Promise<void> {
	const lockPath = join(root, "package-lock.json");
	let lock: { packages?: Record<string, { integrity?: string; version?: string; resolved?: string }> };
	try {
		lock = JSON.parse(await readFile(lockPath, "utf8")) as typeof lock;
	} catch (error) {
		throw new OpenAIChatGPTRuntimeError("Managed OpenAI ChatGPT runtime is missing package-lock.json.", {
			cause: error,
		});
	}
	const packages = lock.packages ?? {};
	const generic = packages["node_modules/@openai/codex"];
	const platform = packages["node_modules/@openai/codex-win32-x64"];
	if (generic?.integrity !== OPENAI_CHATGPT_PACKAGE_INTEGRITY.generic) {
		throw new OpenAIChatGPTRuntimeError(
			"Managed OpenAI Codex generic package integrity does not match the pinned release.",
		);
	}
	if (platform?.integrity !== OPENAI_CHATGPT_PACKAGE_INTEGRITY.win32X64) {
		throw new OpenAIChatGPTRuntimeError(
			"Managed OpenAI Codex Windows x64 package integrity does not match the pinned release.",
		);
	}
	if (
		generic.version !== OPENAI_CHATGPT_CODEX_VERSION ||
		platform.version !== `${OPENAI_CHATGPT_CODEX_VERSION}-win32-x64`
	) {
		throw new OpenAIChatGPTRuntimeError(
			"Managed OpenAI Codex package-lock versions do not match the pinned release.",
		);
	}
}

function makeSafeSessionId(sessionId: string): string {
	const value = sessionId.trim() || "anonymous";
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "anonymous";
	const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
	return `${safe}-${digest}`;
}
