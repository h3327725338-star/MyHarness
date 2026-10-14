import { randomBytes } from "node:crypto";
import { constants, type Stats, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DELEGATED_SANDBOX_ORIGIN_ENV = "MYHARNESS_INTERNAL_SANDBOX_ORIGIN";
const ROOT_NAME = "myharness-delegated-sandboxes";
const OWNER_FILE = "owner.json";
const MAX_NOTES = 20;
export const NON_GIT_MIRROR_LIMITS = {
	fileBytes: 256 * 1024 * 1024,
	totalBytes: 1024 * 1024 * 1024,
	entries: 50_000,
	depth: 128,
	concurrency: 4,
} as const;

const EXCLUDED_DIRECTORIES = new Set([
	"node_modules",
	"bower_components",
	".venv",
	"venv",
	"build",
	"dist",
	"target",
	"out",
	"coverage",
	".cache",
	".next",
	".nuxt",
	".turbo",
	".parcel-cache",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	"__pycache__",
	".gradle",
	".git",
	".hg",
	".svn",
	"$recycle.bin",
	"system volume information",
	".ssh",
	".aws",
	".azure",
	".gnupg",
]);
const EXCLUDED_FILES = new Set([
	"thumbs.db",
	"desktop.ini",
	".ds_store",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
	"credentials",
	"credentials.json",
	"auth.json",
	".npmrc",
	".netrc",
	".pypirc",
]);
const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);
const MYHARNESS_PRIVATE = new Set(["auth.json", "credentials.json", "sessions", "cache", "trace", "data"]);

/** Exact path-segment rules; never inspect contents of an excluded directory. */
export function nonGitMirrorExclusion(rel: string, directory: boolean): string | undefined {
	const segments = rel.replace(/\\/g, "/").toLowerCase().split("/");
	const name = segments.at(-1) ?? "";
	if (directory && EXCLUDED_DIRECTORIES.has(name)) return "内置目录黑名单";
	if (
		!directory &&
		(EXCLUDED_FILES.has(name) || name.endsWith(".key") || name.endsWith(".pfx") || name.endsWith(".p12"))
	) {
		return "系统杂项或凭据文件";
	}
	if (!directory && (name === ".env" || name.startsWith(".env.")) && !ENV_EXAMPLES.has(name)) return "环境凭据文件";
	if (segments.includes(".myharness") && MYHARNESS_PRIVATE.has(name)) return "MyHarness 私密运行数据";
	return undefined;
}

interface SandboxOwner {
	version: 1;
	token: string;
	containerPath: string;
	originCwd: string;
	parentPid: number;
	workerPid?: number;
	createdAt: number;
}

export interface DelegatedSandboxHandle {
	sandboxPath: string;
	originCwd: string;
	containerPath: string;
	token: string;
	importedFiles: number;
	importedBytes: number;
	skippedEntries: number;
	importNotes: string[];
	complete: boolean;
	preparationMs: number;
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Unknown errors must not be interpreted as proof that an owner exited.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function checkedRoot(create = false): Promise<string> {
	const temp = await fs.realpath(tmpdir());
	const root = join(temp, ROOT_NAME);
	if (create)
		await fs.mkdir(root, { recursive: false, mode: 0o700 }).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		});
	const stat = await fs.lstat(root);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(root)) !== root) {
		throw new Error("子代理临时根目录不是独立的普通目录");
	}
	return root;
}

async function ownerFor(
	handle: Pick<DelegatedSandboxHandle, "containerPath" | "token" | "originCwd">,
): Promise<SandboxOwner> {
	const root = await checkedRoot();
	const container = resolve(handle.containerPath);
	if (dirname(container) !== root || !basename(container).startsWith("myharness-sandbox-"))
		throw new Error("沙箱不在专有临时根内");
	const stat = await fs.lstat(container);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(container)) !== container)
		throw new Error("沙箱根目录被替换或链接到外部");
	const marker = join(container, OWNER_FILE);
	const markerStat = await fs.lstat(marker);
	if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 8192)
		throw new Error("沙箱所有权记录无效");
	const owner = JSON.parse(await fs.readFile(marker, "utf8")) as SandboxOwner;
	if (
		owner.version !== 1 ||
		owner.token !== handle.token ||
		owner.containerPath !== container ||
		owner.originCwd !== handle.originCwd ||
		!Number.isSafeInteger(owner.parentPid) ||
		owner.parentPid <= 0 ||
		(owner.workerPid !== undefined && (!Number.isSafeInteger(owner.workerPid) || owner.workerPid <= 0)) ||
		!Number.isFinite(owner.createdAt) ||
		within(container, resolve(owner.originCwd)) ||
		within(resolve(owner.originCwd), container)
	) {
		throw new Error("沙箱所有权或宿主边界校验失败");
	}
	return owner;
}

/** The ownership marker lives beside, never inside, the worker's cwd. */
export function registerDelegatedSandboxWorker(handle: DelegatedSandboxHandle, pid: number): void {
	writeFileSync(
		join(handle.containerPath, OWNER_FILE),
		JSON.stringify({
			version: 1,
			token: handle.token,
			containerPath: handle.containerPath,
			originCwd: handle.originCwd,
			parentPid: process.pid,
			workerPid: pid,
			createdAt: Date.now(),
		}),
		{ encoding: "utf8", mode: 0o600 },
	);
}

/** Delete links themselves, not their targets. Directory traversal is iterative. */
async function removeOwnedTree(container: string): Promise<void> {
	const stack: Array<{ path: string; visited: boolean }> = [{ path: container, visited: false }];
	while (stack.length > 0) {
		const item = stack.pop()!;
		let stat: Stats;
		try {
			stat = await fs.lstat(item.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			await fs.unlink(item.path);
			continue;
		}
		if (!within(container, await fs.realpath(item.path))) throw new Error("清理目录越出沙箱");
		if (item.visited) {
			await fs.rmdir(item.path);
			continue;
		}
		stack.push({ path: item.path, visited: true });
		const directory = await fs.opendir(item.path);
		for await (const entry of directory) stack.push({ path: join(item.path, entry.name), visited: false });
	}
}

export async function finalizeDelegatedSandbox(
	handle: DelegatedSandboxHandle,
): Promise<{ removed: boolean; error?: string }> {
	try {
		try {
			await fs.lstat(handle.containerPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: true };
			throw error;
		}
		const owner = await ownerFor(handle);
		if (owner.workerPid !== undefined && isAlive(owner.workerPid))
			throw new Error("子代理进程尚未确认退出，暂不删除");
		// Keep the marker until the worker directory is gone, so failed cleanup is recoverable.
		const workspace = join(handle.containerPath, "workspace");
		for (let attempt = 0; ; attempt++) {
			try {
				await removeOwnedTree(workspace);
				break;
			} catch (error) {
				if (attempt >= 3) throw error;
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
			}
		}
		await fs.unlink(join(handle.containerPath, OWNER_FILE));
		try {
			await fs.rmdir(handle.containerPath);
		} catch (error) {
			// Restore ownership if the last directory removal fails (for example an external handle).
			await fs.writeFile(join(handle.containerPath, OWNER_FILE), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
			throw error;
		}
		return { removed: true };
	} catch (error) {
		return { removed: false, error: `清理临时沙箱失败（已保留 ${handle.containerPath}）：${errorText(error)}` };
	}
}

export async function prepareDelegatedSandbox(options: {
	originCwd: string;
	signal?: AbortSignal;
	onCreated?: (handle: DelegatedSandboxHandle) => void;
	/** Testable internal budgets, not user settings. */
	limits?: Partial<Record<keyof typeof NON_GIT_MIRROR_LIMITS, number>>;
}): Promise<{ ok: true; handle: DelegatedSandboxHandle } | { ok: false; error: string }> {
	const startedAt = Date.now();
	let handle: DelegatedSandboxHandle | undefined;
	let markerWritten = false;
	try {
		options.signal?.throwIfAborted();
		const originCwd = await fs.realpath(resolve(options.originCwd));
		if (!(await fs.stat(originCwd)).isDirectory()) throw new Error("原工作区不是目录");
		const root = await checkedRoot(true);
		if (within(originCwd, root) || within(root, originCwd)) throw new Error("原工作区与沙箱临时根重叠");
		const containerPath = await fs.mkdtemp(join(root, "myharness-sandbox-"));
		handle = {
			containerPath,
			sandboxPath: join(containerPath, "workspace"),
			originCwd,
			token: randomBytes(16).toString("hex"),
			importedFiles: 0,
			importedBytes: 0,
			skippedEntries: 0,
			importNotes: [],
			complete: true,
			preparationMs: 0,
		};
		await fs.writeFile(
			join(containerPath, OWNER_FILE),
			JSON.stringify({
				version: 1,
				token: handle.token,
				containerPath,
				originCwd,
				parentPid: process.pid,
				createdAt: Date.now(),
			}),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
		markerWritten = true;
		options.onCreated?.(handle);
		await fs.mkdir(handle.sandboxPath, { mode: 0o700 });
		const mirror = handle;
		const limits = { ...NON_GIT_MIRROR_LIMITS, ...options.limits };
		for (const value of Object.values(limits))
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error("镜像预算必须为正整数");
		let examined = 0;
		let reservedBytes = 0;
		const note = (rel: string, reason: string, incomplete = false) => {
			mirror.skippedEntries++;
			if (incomplete) mirror.complete = false;
			if (mirror.importNotes.length < MAX_NOTES) mirror.importNotes.push(`${rel}：${reason}`);
		};
		const copy = async (rel: string, expected: Stats) => {
			let source: Awaited<ReturnType<typeof fs.open>> | undefined;
			let target: Awaited<ReturnType<typeof fs.open>> | undefined;
			const destination = join(mirror.sandboxPath, rel);
			try {
				options.signal?.throwIfAborted();
				const sourcePath = join(originCwd, rel);
				if (!within(originCwd, await fs.realpath(sourcePath)) || (await fs.lstat(sourcePath)).isSymbolicLink())
					throw new Error("文件链接越界或类型变化");
				source = await fs.open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				const before = await source.stat();
				if (
					!before.isFile() ||
					before.size !== expected.size ||
					before.mtimeMs !== expected.mtimeMs ||
					before.ino !== expected.ino
				)
					throw new Error("文件在复制前发生变化");
				await fs.mkdir(dirname(destination), { recursive: true });
				target = await fs.open(destination, "wx", 0o600);
				const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
				let position = 0;
				while (position < before.size) {
					options.signal?.throwIfAborted();
					const { bytesRead } = await source.read(
						buffer,
						0,
						Math.min(buffer.length, before.size - position),
						position,
					);
					if (bytesRead === 0) throw new Error("复制期间文件被截短");
					let written = 0;
					while (written < bytesRead) {
						const result = await target.write(buffer, written, bytesRead - written, position + written);
						if (result.bytesWritten === 0) throw new Error("文件写入没有进展");
						written += result.bytesWritten;
					}
					position += bytesRead;
				}
				const after = await source.stat();
				const current = await fs.lstat(sourcePath);
				if (
					after.size !== before.size ||
					after.mtimeMs !== before.mtimeMs ||
					current.isSymbolicLink() ||
					current.ino !== before.ino ||
					current.size !== before.size ||
					current.mtimeMs !== before.mtimeMs
				)
					throw new Error("文件在复制期间发生变化");
				mirror.importedFiles++;
				mirror.importedBytes += before.size;
			} catch (error) {
				await target?.close();
				target = undefined;
				await fs.unlink(destination).catch((unlinkError) => {
					if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
				});
				if (options.signal?.aborted) throw error;
				note(rel, `复制失败（${errorText(error)}）`, true);
			} finally {
				await target?.close();
				await source?.close();
			}
		};
		const directories = [{ rel: "", depth: 0 }];
		let pending: Promise<void>[] = [];
		const copyErrors: unknown[] = [];
		const drain = async () => {
			const settled = await Promise.allSettled(pending);
			pending = [];
			for (const result of settled) if (result.status === "rejected") copyErrors.push(result.reason);
			if (copyErrors.length) throw copyErrors.shift();
		};
		try {
			while (directories.length > 0) {
				options.signal?.throwIfAborted();
				const item = directories.pop()!;
				const absolute = join(originCwd, item.rel);
				const directoryStat = await fs.lstat(absolute);
				if (
					directoryStat.isSymbolicLink() ||
					!directoryStat.isDirectory() ||
					!within(originCwd, await fs.realpath(absolute))
				) {
					note(item.rel, "目录已变化或链接越界", true);
					continue;
				}
				const directory = await fs.opendir(absolute);
				for await (const entry of directory) {
					options.signal?.throwIfAborted();
					if (++examined > limits.entries)
						throw new Error(`工作区超过 ${limits.entries} 个目录项，镜像准备已停止`);
					const rel = join(item.rel, entry.name);
					const exclusion = nonGitMirrorExclusion(rel, entry.isDirectory());
					if (exclusion) {
						note(rel, exclusion);
						continue;
					}
					const stat = await fs.lstat(join(originCwd, rel));
					if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
						note(rel, "链接或非普通文件");
						continue;
					}
					if (stat.isDirectory()) {
						const excluded = nonGitMirrorExclusion(rel, true);
						if (excluded) {
							note(rel, excluded);
							continue;
						}
						if (item.depth >= limits.depth) {
							note(rel, "超过目录深度预算", true);
							continue;
						}
						await fs.mkdir(join(mirror.sandboxPath, rel), { recursive: true });
						directories.push({ rel, depth: item.depth + 1 });
					} else if (stat.size > limits.fileBytes || reservedBytes + stat.size > limits.totalBytes) {
						note(rel, "超过单文件或累计复制大小预算", true);
					} else {
						reservedBytes += stat.size;
						pending.push(
							copy(rel, stat).catch((error) => {
								copyErrors.push(error);
							}),
						);
						if (pending.length >= limits.concurrency) await drain();
					}
				}
			}
		} finally {
			await drain();
		}
		options.signal?.throwIfAborted();
		if (!mirror.complete && mirror.importedFiles === 0)
			throw new Error(`没有成功复制可用文件：${mirror.importNotes.join("；")}`);
		if (mirror.skippedEntries > mirror.importNotes.length)
			mirror.importNotes.push(`另有 ${mirror.skippedEntries - mirror.importNotes.length} 项未带入镜像`);
		mirror.preparationMs = Date.now() - startedAt;
		return { ok: true, handle: mirror };
	} catch (error) {
		if (handle && !markerWritten) {
			// Before publishing ownership no worker or mirror file exists: remove only this newly created directory.
			await fs.unlink(join(handle.containerPath, OWNER_FILE)).catch(() => {});
			await fs.rmdir(handle.containerPath).catch(() => {});
		}
		const cleanup = handle && markerWritten ? await finalizeDelegatedSandbox(handle) : undefined;
		return {
			ok: false,
			error: `准备子代理文件镜像失败：${errorText(error)}${cleanup?.error ? `；${cleanup.error}` : ""}`,
		};
	}
}

/** Only marked containers with dead parent AND worker owners are eligible. No wildcard deletion. */
export async function cleanupStaleDelegatedSandboxes(options: { signal?: AbortSignal } = {}): Promise<string[]> {
	const errors: string[] = [];
	let root: string;
	try {
		root = await checkedRoot();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [errorText(error)];
	}
	const directory = await fs.opendir(root);
	for await (const entry of directory) {
		if (options.signal?.aborted) break;
		if (!entry.isDirectory() || !entry.name.startsWith("myharness-sandbox-")) continue;
		const containerPath = join(root, entry.name);
		try {
			const markerStat = await fs.lstat(join(containerPath, OWNER_FILE));
			if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 8192) continue;
			const owner = JSON.parse(await fs.readFile(join(containerPath, OWNER_FILE), "utf8")) as SandboxOwner;
			const handle: DelegatedSandboxHandle = {
				containerPath,
				sandboxPath: join(containerPath, "workspace"),
				originCwd: owner.originCwd,
				token: owner.token,
				importedFiles: 0,
				importedBytes: 0,
				skippedEntries: 0,
				importNotes: [],
				complete: false,
				preparationMs: 0,
			};
			const verified = await ownerFor(handle);
			if (isAlive(verified.parentPid) || (verified.workerPid !== undefined && isAlive(verified.workerPid))) continue;
			const result = await finalizeDelegatedSandbox(handle);
			if (result.error) errors.push(result.error);
		} catch (error) {
			// Unknown or unmarked directories are never reclaimed.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				errors.push(`未回收 ${containerPath}：${errorText(error)}`);
		}
	}
	return errors;
}
