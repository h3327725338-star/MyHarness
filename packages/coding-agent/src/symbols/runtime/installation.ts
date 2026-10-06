import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline as pipelineCallback, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CodeIntelligenceSettings } from "../../config/settings/index.ts";
import { VERSION } from "../../config.ts";
import { LanguageServerRegistry } from "../lsp/language-server/registry.ts";
import { createBuiltInLanguageServerRegistry } from "./configuration.ts";

const pipeline = promisify(pipelineCallback);
const execFileAsync = promisify(execFile);
const STATE_VERSION = 1;
const INSTALL_MARKER = ".myharness-code-intelligence.json";

export type CodeIntelligenceModuleStatusKind =
	| "not-installed"
	| "installing"
	| "installed"
	| "update-available"
	| "repair-needed"
	| "error"
	| "unavailable";

export interface CodeIntelligenceArtifact {
	readonly fileName: string;
	readonly url?: string;
	readonly urlTemplate?: string;
	readonly sizeBytes?: number | null;
	readonly sha256?: string | null;
	readonly expectedPaths?: readonly string[];
}

export interface CodeIntelligenceModuleManifestEntry {
	readonly id: string;
	readonly label: string;
	readonly languages: readonly string[];
	readonly serverKey: string;
	readonly serverVersion: string;
	readonly sharedComponents: readonly string[];
	readonly availability?: "external-prerequisites-required";
	readonly notes?: string;
	readonly artifact: CodeIntelligenceArtifact | null;
}

export interface CodeIntelligenceSharedComponentManifestEntry {
	readonly id: string;
	readonly label: string;
	readonly version: string;
	readonly artifact: CodeIntelligenceArtifact;
}

export interface CodeIntelligenceManifest {
	readonly schemaVersion: number;
	readonly product: string;
	readonly platform: string;
	readonly defaultMode: "lightweight";
	readonly releaseVersion: string;
	readonly releaseTag: string;
	readonly myharnessVersionRange?: string;
	readonly published: boolean;
	readonly releaseManifestUrlTemplate?: string;
	readonly description?: string;
	readonly modules: readonly CodeIntelligenceModuleManifestEntry[];
	readonly sharedComponents: readonly CodeIntelligenceSharedComponentManifestEntry[];
	readonly licenseFiles?: readonly string[];
}

interface InstalledModuleState {
	readonly version: string;
	readonly installPath: string;
	readonly artifactSizeBytes: number;
	readonly artifactSha256: string;
	readonly installedAt: string;
	readonly sharedComponents: readonly string[];
}

interface InstalledComponentState {
	readonly version: string;
	readonly installPath: string;
	readonly artifactSizeBytes: number;
	readonly artifactSha256: string;
	readonly installedAt: string;
}

interface InstallationState {
	readonly schemaVersion: number;
	readonly modules: Record<string, InstalledModuleState>;
	readonly components: Record<string, InstalledComponentState>;
	readonly errors: Record<string, string>;
}

export interface CodeIntelligenceModuleStatus {
	readonly id: string;
	readonly label: string;
	readonly languages: readonly string[];
	readonly status: CodeIntelligenceModuleStatusKind;
	readonly version: string;
	readonly installedVersion?: string;
	readonly message?: string;
	readonly notes?: string;
	/** The language server behind the module and the shared runtimes it needs, so a UI can describe them. */
	readonly serverKey: string;
	readonly sharedComponents: readonly string[];
	/** Why an "unavailable" module cannot be downloaded (a CodeIntelligenceInstallationError code). */
	readonly reason?: string;
}

export interface CodeIntelligenceDownloadProgress {
	readonly id: string;
	readonly receivedBytes: number;
	readonly totalBytes: number | null;
	readonly percent: number | null;
	readonly remainingSeconds: number | null;
}

export interface CodeIntelligenceInstallationManagerOptions {
	readonly agentDir?: string;
	readonly storeDir?: string;
	readonly manifest?: CodeIntelligenceManifest;
	readonly manifestPath?: string;
	readonly launcherPath?: string;
	readonly myharnessVersion?: string;
	readonly platform?: NodeJS.Platform;
	readonly now?: () => string;
	readonly downloader?: (
		url: string,
		destination: string,
		signal?: AbortSignal,
		onProgress?: (received: number, total: number | null) => void,
	) => Promise<void>;
	readonly extractor?: (archivePath: string, destination: string) => Promise<void>;
}

export class CodeIntelligenceInstallationError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CodeIntelligenceInstallationError";
		this.code = code;
	}
}

const EMPTY_MANIFEST: CodeIntelligenceManifest = Object.freeze({
	schemaVersion: 1,
	product: "myharness",
	platform: "win32-x64",
	defaultMode: "lightweight",
	releaseVersion: "0.0.0",
	releaseTag: "",
	published: false,
	modules: Object.freeze([]),
	sharedComponents: Object.freeze([]),
});

function normalizeManifest(value: CodeIntelligenceManifest): CodeIntelligenceManifest {
	if (!value || value.schemaVersion !== 1 || value.platform !== "win32-x64") return EMPTY_MANIFEST;
	return Object.freeze({
		...value,
		modules: Object.freeze(
			value.modules.map((entry) =>
				Object.freeze({
					...entry,
					languages: Object.freeze([...entry.languages]),
					sharedComponents: Object.freeze([...entry.sharedComponents]),
				}),
			),
		),
		sharedComponents: Object.freeze(value.sharedComponents.map((entry) => Object.freeze({ ...entry }))),
	});
}

function manifestCandidates(moduleUrl: string): string[] {
	const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
	return [
		...(process.env.MYHARNESS_CODE_INTELLIGENCE_MANIFEST
			? [path.resolve(process.env.MYHARNESS_CODE_INTELLIGENCE_MANIFEST)]
			: []),
		path.resolve(moduleDirectory, "../../../code-intelligence/runtime-manifest.json"),
		path.resolve(moduleDirectory, "../../../../code-intelligence/runtime-manifest.json"),
		path.resolve(process.cwd(), "packages/coding-agent/code-intelligence/runtime-manifest.json"),
		path.resolve(process.cwd(), "code-intelligence/runtime-manifest.json"),
	];
}

export function readCodeIntelligenceManifest(
	manifestPath?: string,
	moduleUrl = import.meta.url,
): CodeIntelligenceManifest {
	const candidates = manifestPath ? [manifestPath] : manifestCandidates(moduleUrl);
	for (const candidate of candidates) {
		try {
			const value = JSON.parse(readFileSync(candidate, "utf8")) as CodeIntelligenceManifest;
			return normalizeManifest(value);
		} catch {
			// A source checkout can run without copied package assets. Lightweight
			// indexing remains available in that case.
		}
	}
	return EMPTY_MANIFEST;
}

function safeState(value: unknown): InstallationState {
	if (!value || typeof value !== "object")
		return { schemaVersion: STATE_VERSION, modules: {}, components: {}, errors: {} };
	const state = value as Partial<InstallationState>;
	return {
		schemaVersion: STATE_VERSION,
		modules: state.modules && typeof state.modules === "object" ? { ...state.modules } : {},
		components: state.components && typeof state.components === "object" ? { ...state.components } : {},
		errors: state.errors && typeof state.errors === "object" ? { ...state.errors } : {},
	};
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSafeChild(root: string, target: string, label: string): void {
	if (!isInside(root, target) || path.resolve(root) === path.resolve(target)) {
		throw new CodeIntelligenceInstallationError("unsafe-path", `${label} is outside the Code Intelligence store`);
	}
}

function isSha256(value: string | null | undefined): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function validArtifact(entryId: string, artifact: CodeIntelligenceArtifact | null): CodeIntelligenceArtifact {
	if (!artifact) {
		throw new CodeIntelligenceInstallationError(
			"external-prerequisites",
			`Code Intelligence module "${entryId}" has external prerequisites and is not downloadable by MyHarness`,
		);
	}
	if (
		!artifact.fileName ||
		artifact.sizeBytes === null ||
		artifact.sizeBytes === undefined ||
		artifact.sizeBytes <= 0
	) {
		throw new CodeIntelligenceInstallationError(
			"release-metadata-missing",
			`Code Intelligence module "${entryId}" has no published artifact size; release metadata is not available yet`,
		);
	}
	if (!isSha256(artifact.sha256)) {
		throw new CodeIntelligenceInstallationError(
			"release-metadata-missing",
			`Code Intelligence module "${entryId}" has no published SHA-256; refusing an unverified download`,
		);
	}
	if (!artifact.url && !artifact.urlTemplate) {
		throw new CodeIntelligenceInstallationError(
			"release-metadata-missing",
			`Code Intelligence module "${entryId}" has no download URL`,
		);
	}
	return artifact;
}

function resolveArtifactUrl(artifact: CodeIntelligenceArtifact, manifest: CodeIntelligenceManifest): string {
	const templateValues: Record<string, string> = {
		fileName: artifact.fileName,
		releaseTag: manifest.releaseTag,
		releaseVersion: manifest.releaseVersion,
	};
	const template = artifact.urlTemplate;
	const url =
		artifact.url ??
		template?.replace(/\{(fileName|releaseTag|releaseVersion)\}/gu, (_, key: string) => templateValues[key]);
	if (!url)
		throw new CodeIntelligenceInstallationError(
			"release-metadata-missing",
			"Code Intelligence artifact URL is empty",
		);
	return url;
}

async function defaultDownload(
	url: string,
	destination: string,
	signal?: AbortSignal,
	onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
	if (url.startsWith("file://")) {
		await copyFile(fileURLToPath(url), destination);
		return;
	}
	if (path.isAbsolute(url)) {
		await copyFile(url, destination);
		return;
	}
	let response: Response;
	try {
		response = await fetch(url, signal ? { signal } : undefined);
	} catch (cause) {
		throw new CodeIntelligenceInstallationError(
			"download-failed",
			`Code Intelligence download failed: ${String(cause)}`,
			{
				cause,
			},
		);
	}
	if (!response.ok || !response.body) {
		throw new CodeIntelligenceInstallationError(
			"download-failed",
			`Code Intelligence download returned HTTP ${response.status} for ${url}`,
		);
	}
	const size = Number(response.headers.get("content-length"));
	const total = size > 0 ? size : null;
	let received = 0;
	const stream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
	stream.on("data", (chunk: Buffer) => {
		received += chunk.length;
		onProgress?.(received, total);
	});
	await pipeline(stream, createWriteStream(destination));
}

async function defaultExtract(archivePath: string, destination: string, platform: NodeJS.Platform): Promise<void> {
	if (platform !== "win32") {
		throw new CodeIntelligenceInstallationError(
			"unsupported-platform",
			"Code Intelligence modules are supported on Windows only",
		);
	}
	if (!archivePath.toLowerCase().endsWith(".zip")) {
		throw new CodeIntelligenceInstallationError(
			"unsupported-archive",
			`Unsupported Code Intelligence archive: ${archivePath}`,
		);
	}
	// Windows ships bsdtar as System32\tar.exe. Unlike Expand-Archive in Windows PowerShell 5.1 it unpacks paths
	// beyond MAX_PATH, which the large runtimes reach once nested under the user profile staging directory.
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	const tar = systemRoot ? path.join(systemRoot, "System32", "tar.exe") : undefined;
	if (tar && existsSync(tar)) {
		try {
			await execFileAsync(tar, ["-xf", archivePath, "-C", destination], {
				windowsHide: true,
				maxBuffer: 1024 * 1024,
			});
			return;
		} catch {
			// Fall back to PowerShell below; its error is the one reported.
		}
	}
	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$archive = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(archivePath, "utf8").toString("base64")}'))`,
		`$destination = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(destination, "utf8").toString("base64")}'))`,
		"Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force",
	].join("; ");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	try {
		await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
			windowsHide: true,
			maxBuffer: 1024 * 1024,
		});
	} catch (cause) {
		throw new CodeIntelligenceInstallationError(
			"extract-failed",
			`Code Intelligence archive extraction failed: ${String(cause)}`,
			{
				cause,
			},
		);
	}
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function ensureNoReparsePoints(root: string): Promise<void> {
	const entries = readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
		const target = path.join(root, entry.name);
		const info = lstatSync(target);
		if (info.isSymbolicLink()) {
			throw new CodeIntelligenceInstallationError(
				"unsafe-archive",
				`Archive contains a symbolic link: ${entry.name}`,
			);
		}
		if (entry.isDirectory()) await ensureNoReparsePoints(target);
	}
}

function installedMarkerPath(installPath: string): string {
	return path.join(installPath, INSTALL_MARKER);
}

function normalizeId(value: string): string {
	return value.trim().toLowerCase();
}

function moduleVersion(entry: CodeIntelligenceModuleManifestEntry): string {
	return entry.serverVersion;
}

type VersionParts = readonly [major: number, minor: number, patch: number];

function parseVersion(value: string): VersionParts | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(left: VersionParts, right: VersionParts): number {
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

function isVersionCompatible(version: string, range: string | undefined): boolean {
	if (!range?.trim()) return true;
	const current = parseVersion(version);
	if (!current) return false;
	return range
		.trim()
		.split(/\s+/u)
		.filter(Boolean)
		.every((constraint) => {
			const match = /^(<=|>=|<|>|=)?v?(\d+)\.(\d+)\.(\d+)$/u.exec(constraint);
			if (!match) return false;
			const expected: VersionParts = [Number(match[2]), Number(match[3]), Number(match[4])];
			const comparison = compareVersions(current, expected);
			switch (match[1] ?? "=") {
				case "<":
					return comparison < 0;
				case "<=":
					return comparison <= 0;
				case ">":
					return comparison > 0;
				case ">=":
					return comparison >= 0;
				default:
					return comparison === 0;
			}
		});
}

export class CodeIntelligenceInstallationManager {
	readonly agentDir: string;
	readonly storeDir: string;
	readonly manifest: CodeIntelligenceManifest;

	private readonly platform: NodeJS.Platform;
	private readonly launcherPath?: string;
	private readonly myharnessVersion: string;
	private readonly now: () => string;
	private readonly downloader: NonNullable<CodeIntelligenceInstallationManagerOptions["downloader"]>;
	private readonly extractor: NonNullable<CodeIntelligenceInstallationManagerOptions["extractor"]>;
	private readonly operations = new Map<string, Promise<void>>();
	private state: InstallationState;
	private readonly listeners = new Set<(progress?: CodeIntelligenceDownloadProgress) => void>();
	private readonly progress = new Map<string, CodeIntelligenceDownloadProgress>();

	subscribe(listener: (progress?: CodeIntelligenceDownloadProgress) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getDownloadProgress(): readonly CodeIntelligenceDownloadProgress[] {
		return [...this.progress.values()];
	}

	private notify(progress?: CodeIntelligenceDownloadProgress): void {
		for (const listener of this.listeners) listener(progress);
	}

	constructor(options: CodeIntelligenceInstallationManagerOptions = {}) {
		this.agentDir = path.resolve(
			options.agentDir ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".myharness", "agent"),
		);
		this.storeDir = path.resolve(options.storeDir ?? path.join(this.agentDir, "code-intelligence"));
		this.manifest = normalizeManifest(options.manifest ?? readCodeIntelligenceManifest(options.manifestPath));
		this.platform = options.platform ?? process.platform;
		this.launcherPath = options.launcherPath ?? this.findLauncherPath();
		this.myharnessVersion = options.myharnessVersion ?? VERSION;
		this.now = options.now ?? (() => new Date().toISOString());
		this.downloader = options.downloader ?? defaultDownload;
		this.extractor =
			options.extractor ?? ((archive, destination) => defaultExtract(archive, destination, this.platform));
		this.state = this.readState();
	}

	get statePath(): string {
		return path.join(this.storeDir, "state.json");
	}

	/** Keep language-server workspace data below the install store, not beside Session data. */
	getWorkspaceDataRoot(workspaceRoot: string): string {
		const key = createHash("sha256").update(path.resolve(workspaceRoot).toLowerCase()).digest("hex").slice(0, 24);
		return path.join(this.storeDir, "data", key);
	}

	getModule(id: string): CodeIntelligenceModuleManifestEntry | undefined {
		const normalized = normalizeId(id);
		return this.manifest.modules.find((entry) => normalizeId(entry.id) === normalized);
	}

	getModuleStatuses(): readonly CodeIntelligenceModuleStatus[] {
		return Object.freeze(this.manifest.modules.map((entry) => this.getModuleStatus(entry.id)));
	}

	getModuleStatus(id: string): CodeIntelligenceModuleStatus {
		const entry = this.getModule(id);
		if (!entry)
			throw new CodeIntelligenceInstallationError("unknown-module", `Unknown Code Intelligence module: ${id}`);
		const installed = this.state.modules[entry.id];
		const base = {
			id: entry.id,
			label: entry.label,
			languages: Object.freeze([...entry.languages]),
			version: moduleVersion(entry),
			notes: entry.notes,
			serverKey: entry.serverKey,
			sharedComponents: Object.freeze([...entry.sharedComponents]),
		};
		if (!isVersionCompatible(this.myharnessVersion, this.manifest.myharnessVersionRange)) {
			return Object.freeze({
				...base,
				status: "unavailable",
				reason: "incompatible-version",
				message: `This Code Intelligence release requires MyHarness ${this.manifest.myharnessVersionRange ?? "a compatible version"}; current version is ${this.myharnessVersion}`,
			});
		}
		if (entry.availability === "external-prerequisites-required" || !entry.artifact) {
			return Object.freeze({
				...base,
				status: "unavailable",
				reason: "external-prerequisites",
				message: entry.notes ?? "External prerequisites required",
			});
		}
		if (this.operations.has(entry.id)) {
			return Object.freeze({ ...base, status: "installing", installedVersion: installed?.version });
		}
		if (this.state.errors[entry.id] && !installed) {
			return Object.freeze({ ...base, status: "error", message: this.state.errors[entry.id] });
		}
		if (!installed) {
			try {
				validArtifact(entry.id, entry.artifact);
			} catch (error) {
				return Object.freeze({
					...base,
					status: "unavailable",
					reason: error instanceof CodeIntelligenceInstallationError ? error.code : undefined,
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return Object.freeze({ ...base, status: "not-installed" });
		}
		if (installed.version !== moduleVersion(entry)) {
			return Object.freeze({ ...base, status: "update-available", installedVersion: installed.version });
		}
		if (!this.isHealthyInstall(installed.installPath, entry.artifact) || !this.hasHealthySharedComponents(entry)) {
			return Object.freeze({ ...base, status: "repair-needed", installedVersion: installed.version });
		}
		return Object.freeze({ ...base, status: "installed", installedVersion: installed.version });
	}

	async install(id: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		const entry = this.getModule(id);
		if (!entry)
			throw new CodeIntelligenceInstallationError("unknown-module", `Unknown Code Intelligence module: ${id}`);
		return this.runOperation(entry.id, async () => {
			this.requireInstallableModule(entry.id);
			this.ensureWindows();
			const oldModule = this.state.modules[entry.id];
			let stagingRoot: string | undefined;
			try {
				for (const componentId of entry.sharedComponents)
					await this.ensureComponent(componentId, options.signal, entry.id);
				const artifact = validArtifact(entry.id, entry.artifact);
				const url = resolveArtifactUrl(artifact, this.manifest);
				stagingRoot = await this.createStagingDirectory(entry.id);
				const archivePath = path.join(stagingRoot, artifact.fileName);
				const extractedPath = path.join(stagingRoot, "module");
				await mkdir(extractedPath, { recursive: true });
				const started = Date.now();
				let lastSent = 0;
				await this.downloader(url, archivePath, options.signal, (receivedBytes, reportedTotal) => {
					const totalBytes = reportedTotal ?? artifact.sizeBytes ?? null;
					const elapsed = (Date.now() - started) / 1000;
					const progress = {
						id: entry.id,
						receivedBytes,
						totalBytes,
						percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : null,
						remainingSeconds:
							totalBytes && receivedBytes >= totalBytes
								? 0
								: totalBytes && receivedBytes > 0 && elapsed > 0
									? Math.max(0, ((totalBytes - receivedBytes) * elapsed) / receivedBytes)
									: null,
					};
					this.progress.set(entry.id, progress);
					if (Date.now() - lastSent >= 100 || receivedBytes === totalBytes) {
						lastSent = Date.now();
						this.notify(progress);
					}
				});
				await this.verifyArchive(archivePath, artifact);
				await this.extractor(archivePath, extractedPath);
				await this.validateExtracted(extractedPath, artifact);
				await writeFile(
					installedMarkerPath(extractedPath),
					JSON.stringify(
						{
							kind: "myharness-code-intelligence-module",
							id: entry.id,
							version: moduleVersion(entry),
							artifact: { sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 },
						},
						null,
						2,
					),
					"utf8",
				);
				const finalPath = this.modulePath(entry.id, moduleVersion(entry));
				await this.replaceDirectory(extractedPath, finalPath);
				this.state = {
					...this.state,
					modules: {
						...this.state.modules,
						[entry.id]: {
							version: moduleVersion(entry),
							installPath: finalPath,
							artifactSizeBytes: artifact.sizeBytes as number,
							artifactSha256: artifact.sha256 as string,
							installedAt: this.now(),
							sharedComponents: [...entry.sharedComponents],
						},
					},
					errors: withoutKey(this.state.errors, entry.id),
				};
				await this.saveState();
				if (oldModule && oldModule.installPath !== finalPath) await this.removePathIfSafe(oldModule.installPath);
				await this.removeUnreferencedComponents();
				await this.saveState();
			} catch (cause) {
				this.state = { ...this.state, errors: { ...this.state.errors, [entry.id]: errorMessage(cause) } };
				try {
					await this.removeUnreferencedComponents();
				} catch {
					// Preserve the original installation error; the next repair can retry cleanup.
				}
				await this.saveState();
				throw cause;
			} finally {
				if (stagingRoot) await this.removePathIfSafe(stagingRoot);
			}
		});
	}

	async update(id: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		const status = this.getModuleStatus(id);
		if (status.status === "installed") return;
		return this.install(id, options);
	}

	async repair(id: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		return this.install(id, options);
	}

	async remove(id: string): Promise<void> {
		const entry = this.getModule(id);
		if (!entry)
			throw new CodeIntelligenceInstallationError("unknown-module", `Unknown Code Intelligence module: ${id}`);
		return this.runOperation(entry.id, async () => {
			const installed = this.state.modules[entry.id];
			if (installed) {
				this.ensureStorePath(installed.installPath);
				await rm(installed.installPath, { recursive: true, force: true });
			}
			const modules = withoutKey(this.state.modules, entry.id);
			const components = { ...this.state.components };
			for (const [componentId, component] of Object.entries(components)) {
				const stillReferenced = Object.values(modules).some((module) =>
					module.sharedComponents.includes(componentId),
				);
				if (!stillReferenced) {
					await this.removePathIfSafe(component.installPath);
					delete components[componentId];
				}
			}
			this.state = { ...this.state, modules, components, errors: withoutKey(this.state.errors, entry.id) };
			await this.saveState();
		});
	}

	/** Build definitions from installed modules without downloading or starting anything. */
	createInstalledLanguageServerRegistry(
		settings: CodeIntelligenceSettings = {},
		dataRoot?: string,
	): LanguageServerRegistry | undefined {
		const registry = new LanguageServerRegistry();
		const disabled = new Set((settings.disabledLanguages ?? []).map(normalizeId));
		if (this.launcherPath && existsSync(this.launcherPath)) {
			for (const entry of this.manifest.modules) {
				const installed = this.state.modules[entry.id];
				if (
					!installed ||
					!isVersionCompatible(this.myharnessVersion, this.manifest.myharnessVersionRange) ||
					entry.availability ||
					!this.isHealthyInstall(installed.installPath, entry.artifact) ||
					!this.hasHealthySharedComponents(entry)
				)
					continue;
				const languages = entry.languages.filter((language) => !disabled.has(normalizeId(language)));
				if (languages.length === 0) continue;
				const sharedRoots = entry.sharedComponents
					.map((componentId) => this.state.components[componentId]?.installPath)
					.filter((value): value is string => typeof value === "string" && existsSync(value));
				registry.register({
					id: `managed-${entry.id}`,
					languages,
					command: process.execPath,
					args: [this.launcherPath, entry.serverKey],
					priority: 200,
					configured: true,
					env: {
						MYHARNESS_CODE_INTELLIGENCE_ROOT: installed.installPath,
						MYHARNESS_CODE_INTELLIGENCE_SHARED_ROOTS: sharedRoots.join(path.delimiter),
						MYHARNESS_SYMBOLS_DATA_ROOT: dataRoot ?? path.join(this.storeDir, "data"),
					},
					clientInfo: { name: "myharness-symbols", version: this.manifest.releaseVersion },
				});
			}
		}
		for (const definition of createBuiltInLanguageServerRegistry(settings).getAll()) {
			if (!definition.configured || registry.has(definition.id)) continue;
			registry.register(definition);
		}
		return registry.size === 0 ? undefined : registry;
	}

	private hasHealthySharedComponents(entry: CodeIntelligenceModuleManifestEntry): boolean {
		return entry.sharedComponents.every((id) => {
			const installed = this.state.components[id];
			const component = this.manifest.sharedComponents.find((candidate) => candidate.id === id);
			return Boolean(installed && component && this.isHealthyInstall(installed.installPath, component.artifact));
		});
	}

	private requireInstallableModule(id: string): CodeIntelligenceModuleManifestEntry {
		const entry = this.getModule(id);
		if (!entry)
			throw new CodeIntelligenceInstallationError("unknown-module", `Unknown Code Intelligence module: ${id}`);
		if (!isVersionCompatible(this.myharnessVersion, this.manifest.myharnessVersionRange)) {
			throw new CodeIntelligenceInstallationError(
				"incompatible-version",
				`This Code Intelligence release requires MyHarness ${this.manifest.myharnessVersionRange ?? "a compatible version"}; current version is ${this.myharnessVersion}`,
			);
		}
		validArtifact(entry.id, entry.artifact);
		return entry;
	}

	private ensureWindows(): void {
		if (this.platform !== "win32") {
			throw new CodeIntelligenceInstallationError(
				"unsupported-platform",
				"Code Intelligence modules are supported on Windows only",
			);
		}
	}

	private readState(): InstallationState {
		try {
			return safeState(JSON.parse(readFileSync(this.statePath, "utf8")) as unknown);
		} catch {
			return { schemaVersion: STATE_VERSION, modules: {}, components: {}, errors: {} };
		}
	}

	private async saveState(): Promise<void> {
		await mkdir(this.storeDir, { recursive: true });
		const tempPath = `${this.statePath}.${randomUUID()}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
		await rename(tempPath, this.statePath);
	}

	private modulePath(id: string, version: string): string {
		return path.join(this.storeDir, "modules", normalizeId(id), version.replace(/[^a-z0-9._-]+/giu, "-"));
	}

	private componentPath(id: string, version: string): string {
		return path.join(this.storeDir, "components", normalizeId(id), version.replace(/[^a-z0-9._-]+/giu, "-"));
	}

	private async ensureComponent(id: string, signal?: AbortSignal, moduleId?: string): Promise<string> {
		const entry = this.manifest.sharedComponents.find((candidate) => candidate.id === id);
		if (!entry)
			throw new CodeIntelligenceInstallationError(
				"missing-dependency",
				`Missing Code Intelligence dependency manifest entry: ${id}`,
			);
		const existing = this.state.components[id];
		if (existing && this.isHealthyInstall(existing.installPath, entry.artifact) && existing.version === entry.version)
			return existing.installPath;
		const artifact = validArtifact(id, entry.artifact);
		const stagingRoot = await this.createStagingDirectory(`component-${id}`);
		const archivePath = path.join(stagingRoot, artifact.fileName);
		const extractedPath = path.join(stagingRoot, "component");
		try {
			await mkdir(extractedPath, { recursive: true });
			const started = Date.now();
			let lastSent = 0;
			await this.downloader(
				resolveArtifactUrl(artifact, this.manifest),
				archivePath,
				signal,
				(receivedBytes, reportedTotal) => {
					if (!moduleId) return;
					const totalBytes = reportedTotal ?? artifact.sizeBytes ?? null;
					const elapsed = (Date.now() - started) / 1000;
					const progress = {
						id: moduleId,
						receivedBytes,
						totalBytes,
						percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : null,
						remainingSeconds:
							totalBytes && receivedBytes >= totalBytes
								? 0
								: totalBytes && receivedBytes > 0 && elapsed > 0
									? Math.max(0, ((totalBytes - receivedBytes) * elapsed) / receivedBytes)
									: null,
					};
					this.progress.set(moduleId, progress);
					if (Date.now() - lastSent >= 100 || receivedBytes === totalBytes) {
						lastSent = Date.now();
						this.notify(progress);
					}
				},
			);
			await this.verifyArchive(archivePath, artifact);
			await this.extractor(archivePath, extractedPath);
			await this.validateExtracted(extractedPath, artifact);
			await writeFile(
				installedMarkerPath(extractedPath),
				JSON.stringify(
					{
						kind: "myharness-code-intelligence-component",
						id,
						version: entry.version,
						artifact: { sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 },
					},
					null,
				),
				"utf8",
			);
			const finalPath = this.componentPath(id, entry.version);
			await this.replaceDirectory(extractedPath, finalPath);
			this.state = {
				...this.state,
				components: {
					...this.state.components,
					[id]: {
						version: entry.version,
						installPath: finalPath,
						artifactSizeBytes: artifact.sizeBytes as number,
						artifactSha256: artifact.sha256 as string,
						installedAt: this.now(),
					},
				},
			};
			await this.saveState();
			if (existing && existing.installPath !== finalPath) await this.removePathIfSafe(existing.installPath);
			return finalPath;
		} finally {
			await this.removePathIfSafe(stagingRoot);
		}
	}

	private async createStagingDirectory(id: string): Promise<string> {
		const stagingRoot = path.join(
			this.storeDir,
			".staging",
			`${normalizeId(id).replace(/[^a-z0-9._-]+/giu, "-")}-${randomUUID()}`,
		);
		assertSafeChild(this.storeDir, stagingRoot, "staging path");
		await mkdir(stagingRoot, { recursive: true });
		return stagingRoot;
	}

	private async verifyArchive(archivePath: string, artifact: CodeIntelligenceArtifact): Promise<void> {
		const info = await stat(archivePath);
		if (info.size !== artifact.sizeBytes) {
			throw new CodeIntelligenceInstallationError(
				"integrity-mismatch",
				`Code Intelligence archive size mismatch: expected ${artifact.sizeBytes}, got ${info.size}`,
			);
		}
		const actual = await sha256File(archivePath);
		if (actual.toLowerCase() !== String(artifact.sha256).toLowerCase()) {
			throw new CodeIntelligenceInstallationError(
				"integrity-mismatch",
				`Code Intelligence archive SHA-256 mismatch: expected ${artifact.sha256}, got ${actual}`,
			);
		}
	}

	private async validateExtracted(extractedPath: string, artifact: CodeIntelligenceArtifact): Promise<void> {
		await ensureNoReparsePoints(extractedPath);
		for (const expected of artifact.expectedPaths ?? []) {
			const target = path.resolve(extractedPath, expected);
			if (!isInside(extractedPath, target) || !existsSync(target)) {
				throw new CodeIntelligenceInstallationError(
					"invalid-archive",
					`Code Intelligence archive is missing ${expected}`,
				);
			}
		}
		if (readdirSync(extractedPath).length === 0) {
			throw new CodeIntelligenceInstallationError("invalid-archive", "Code Intelligence archive is empty");
		}
	}

	private async replaceDirectory(source: string, destination: string): Promise<void> {
		this.ensureStorePath(destination);
		await mkdir(path.dirname(destination), { recursive: true });
		const backup = `${destination}.backup-${randomUUID()}`;
		let movedOld = false;
		try {
			if (existsSync(destination)) {
				await rename(destination, backup);
				movedOld = true;
			}
			await rename(source, destination);
			if (movedOld) await rm(backup, { recursive: true, force: true });
		} catch (cause) {
			if (movedOld && !existsSync(destination) && existsSync(backup)) await rename(backup, destination);
			throw new CodeIntelligenceInstallationError(
				"install-commit-failed",
				`Could not activate Code Intelligence files: ${String(cause)}`,
				{
					cause,
				},
			);
		}
	}

	private ensureStorePath(target: string): void {
		assertSafeChild(this.storeDir, target, "installation path");
	}

	private async removePathIfSafe(target: string): Promise<void> {
		if (!isInside(this.storeDir, target) || path.resolve(target) === path.resolve(this.storeDir)) return;
		await rm(target, { recursive: true, force: true });
	}

	private async removeUnreferencedComponents(): Promise<void> {
		const referenced = new Set(Object.values(this.state.modules).flatMap((module) => module.sharedComponents));
		const components = { ...this.state.components };
		let changed = false;
		for (const [componentId, component] of Object.entries(components)) {
			if (referenced.has(componentId)) continue;
			await this.removePathIfSafe(component.installPath);
			delete components[componentId];
			changed = true;
		}
		if (changed) this.state = { ...this.state, components };
	}

	private isHealthyInstall(installPath: string, artifact: CodeIntelligenceArtifact | null): boolean {
		if (!isInside(this.storeDir, installPath) || !existsSync(installedMarkerPath(installPath))) return false;
		if (!artifact) return false;
		try {
			if (readdirSync(installPath).length <= 1) return false;
			const marker = JSON.parse(readFileSync(installedMarkerPath(installPath), "utf8")) as {
				artifact?: { sizeBytes?: unknown; sha256?: unknown };
			};
			const markerArtifact = marker.artifact;
			return (
				markerArtifact?.sizeBytes === artifact.sizeBytes &&
				typeof markerArtifact?.sha256 === "string" &&
				markerArtifact.sha256.toLowerCase() === String(artifact.sha256).toLowerCase()
			);
		} catch {
			return false;
		}
	}

	private findLauncherPath(): string | undefined {
		const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [
			...(process.env.MYHARNESS_CODE_INTELLIGENCE_LAUNCHER
				? [process.env.MYHARNESS_CODE_INTELLIGENCE_LAUNCHER]
				: []),
			path.resolve(moduleDirectory, "../../../code-intelligence/lsp-launcher.mjs"),
			path.resolve(moduleDirectory, "../../../../code-intelligence/lsp-launcher.mjs"),
			path.resolve(process.cwd(), "packages/coding-agent/code-intelligence/lsp-launcher.mjs"),
		];
		return candidates.map((candidate) => path.resolve(candidate)).find((candidate) => existsSync(candidate));
	}

	private runOperation(id: string, operation: () => Promise<void>): Promise<void> {
		const current = this.operations.get(id);
		if (current) return current;
		const promise = operation()
			.catch(async (error) => {
				if (this.state.errors[id] !== errorMessage(error)) {
					this.state = { ...this.state, errors: { ...this.state.errors, [id]: errorMessage(error) } };
					await this.saveState();
				}
				throw error;
			})
			.finally(() => {
				this.operations.delete(id);
				this.progress.delete(id);
				this.notify();
			});
		this.operations.set(id, promise);
		this.notify();
		return promise;
	}
}

function withoutKey<T>(value: Record<string, T>, key: string): Record<string, T> {
	const result = { ...value };
	delete result[key];
	return result;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
