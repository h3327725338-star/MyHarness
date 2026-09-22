#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const repoRoot = process.cwd();
const MAX_TRACKED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_SCAN_BYTES = 8 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/i;

const TEXT_EXTENSIONS = new Set([
	".bat",
	".c",
	".cc",
	".cmd",
	".conf",
	".cpp",
	".css",
	".cjs",
	".go",
	".h",
	".hpp",
	".html",
	".ini",
	".java",
	".js",
	".json",
	".jsonc",
	".jsx",
	".kt",
	".md",
	".mjs",
	".php",
	".ps1",
	".py",
	".rb",
	".rs",
	".sh",
	".sql",
	".swift",
	".toml",
	".ts",
	".tsx",
	".txt",
	".xml",
	".yaml",
	".yml",
]);

const LOCAL_TOOL_STATE_PATH_RULE = {
	pattern: /(^|\/)\.(?:workbuddy|claude|codex|cursor|continue|opencode|agent|agents|pi_config|vscode|zed|idea)(\/|$)/i,
	category: "Agent/Harness/IDE local state directory",
};

const FORBIDDEN_PATH_RULES = [
	LOCAL_TOOL_STATE_PATH_RULE,
	{ pattern: /^(?:data|packages\/[^/]+\/data)(\/|$)/i, category: "user-data directory" },
	{ pattern: /(^|\/)node_modules(\/|$)/i, category: "installed dependency directory" },
	{ pattern: /(^|\/)dist(\/|$)/i, category: "generated build directory" },
	{ pattern: /(^|\/)\.env(?:\.[^/]*)?$/i, category: "environment file" },
	{ pattern: /(^|\/)auth\.json$/i, category: "credential file" },
	{ pattern: /(^|\/)credentials?\.(?:json|ya?ml|toml|ini)$/i, category: "credential file" },
	{ pattern: /(^|\/)\.myharness\/agent(\/|$)/i, category: "user credential/session directory" },
	{ pattern: /(^|\/)code-intelligence\/(?:runtime|\.downloads|\.staging)(\/|$)/i, category: "downloaded Code Intelligence runtime" },
	{ pattern: /(^|\/)(?:coverage|test-artifacts|profiles-node|compaction-results)(\/|$)/i, category: "generated artifact directory" },
	{ pattern: /(^|\/)(?:logs?|crash-dumps?)(\/|$)/i, category: "log or crash dump directory" },
	{ pattern: /\.(?:dmp|sqlite|sqlite3|db|pdb|p12|pfx|pem|key)$/i, category: "private or generated artifact" },
];

function printUsage() {
	console.log(`Usage: node scripts/release-audit.mjs [--staged | --worktree | --ref <commit-ish>] [--require-orphan]

Audits the files that would be committed, the current tracked worktree, or a Git
ref without printing matched secret values. The default mode is --worktree.`);
}

function parseArgs() {
	const options = { mode: "worktree", ref: undefined, requireOrphan: false };
	const args = process.argv.slice(2);

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--staged" || arg === "--worktree") {
			options.mode = arg.slice(2);
			continue;
		}
		if (arg === "--ref") {
			options.mode = "ref";
			options.ref = args[++index];
			if (!options.ref) throw new Error("--ref requires a commit-ish");
			continue;
		}
		if (arg === "--require-orphan") {
			options.requireOrphan = true;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (options.requireOrphan && options.mode !== "ref") {
		throw new Error("--require-orphan can only be used with --ref");
	}

	return options;
}

function git(args, encoding = "utf8") {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding,
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function readGitBlobs(specs) {
	if (specs.length === 0) return new Map();
	const output = execFileSync("git", ["cat-file", "--batch"], {
		cwd: repoRoot,
		encoding: "buffer",
		input: Buffer.from(`${specs.join("\n")}\n`, "utf8"),
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const blobs = new Map();
	let offset = 0;
	for (const spec of specs) {
		const headerEnd = output.indexOf(10, offset);
		if (headerEnd < 0) throw new Error(`git cat-file returned no header for ${spec}`);
		const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
		const size = Number(header[2]);
		if (header[1] !== "blob" || !Number.isInteger(size) || size < 0) throw new Error(`git cat-file could not read ${spec}`);
		const dataStart = headerEnd + 1;
		blobs.set(spec, output.subarray(dataStart, dataStart + size));
		offset = dataStart + size;
		if (output[offset] === 10) offset += 1;
	}
	return blobs;
}

function splitNul(value) {
	return value.split("\0").filter(Boolean);
}

function toPosixPath(value) {
	return value.replaceAll("\\", "/");
}

function parseTreeEntries(ref) {
	return git(["ls-tree", "-r", "-z", "--long", ref])
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const separator = record.indexOf("\t");
			const metadata = record.slice(0, separator).split(/\s+/);
			return {
				mode: metadata[0],
				object: metadata[2],
				size: Number(metadata[3]),
				path: record.slice(separator + 1),
			};
		});
}

function parseIndexEntries() {
	return splitNul(git(["ls-files", "--stage", "-z"]))
		.map((record) => {
			const separator = record.indexOf("\t");
			const [mode, object, stage] = record.slice(0, separator).split(/\s+/);
			return { mode, object, stage, path: record.slice(separator + 1) };
		})
		.filter((entry) => entry.stage === "0");
}

function getEntries(options) {
	if (options.mode === "ref") {
		const entries = parseTreeEntries(options.ref);
		const blobs = readGitBlobs(entries.map((entry) => `${options.ref}:${entry.path}`));
		return entries.map((entry) => ({
			...entry,
			read: () => blobs.get(`${options.ref}:${entry.path}`),
		}));
	}

	if (options.mode === "staged") {
		const changed = new Set(splitNul(git(["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "-z"])));
		const entries = parseIndexEntries().filter((entry) => changed.has(entry.path));
		const blobs = readGitBlobs(entries.map((entry) => `:${entry.path}`));
		return entries.map((entry) => {
			const blob = blobs.get(`:${entry.path}`);
			return { ...entry, size: blob.length, read: () => blob };
		});
	}

	return splitNul(git(["ls-files", "-z"]))
		.map((path) => {
			const absolutePath = resolve(repoRoot, path);
			if (!existsSync(absolutePath)) return null;
			const stat = statSync(absolutePath);
			return {
				mode: stat.isFile() ? "100644" : "",
				object: undefined,
				size: stat.size,
				path,
				read: () => readFileSync(absolutePath),
			};
		})
		.filter(Boolean);
}

function checkStagedIndexToolDirectories(findings) {
	for (const entry of parseIndexEntries()) {
		const path = toPosixPath(entry.path);
		if (LOCAL_TOOL_STATE_PATH_RULE.pattern.test(path)) {
			addFinding(findings, `${LOCAL_TOOL_STATE_PATH_RULE.category} is tracked`, path, "", 0);
		}
	}
}

function lineNumber(text, index) {
	return text.slice(0, index).split("\n").length;
}

function pathLooksSynthetic(path) {
	return /(^|\/)(?:test|tests|__tests__|examples|fixtures)(\/|$)/i.test(toPosixPath(path));
}

function isPlaceholder(value, path) {
	const normalized = value.toLowerCase();
	if (/^(?:\.\.\.|<[^>]+>|\[redacted\]|\$[a-z0-9_{}-]+|your[-_ ].*|replace[-_ ].*|example[-_ ].*|placeholder.*|dummy.*|fake.*|test.*|secret(?:[-_ ].*)?|local[-_ ].*|fixture[-_ ].*|my[-_ ]temp[-_ ].*|public|.*temp[-_ ]key.*)$/i.test(normalized)) {
		return true;
	}
	if (pathLooksSynthetic(path) && /^(?:abc|abcdef|secret|test|dummy|fake|fixture|local|ambient|stored|request|provider|oauth|explicit|resolved|private|temp|demo|value|token|key)[a-z0-9_-]*$/i.test(normalized)) {
		return true;
	}
	if (pathLooksSynthetic(path) && /(?:test|secret|dummy|fake|fixture|local|demo|temp|example)/i.test(normalized)) {
		return true;
	}
	if (pathLooksSynthetic(path) && /^(?:sk|ghp|npm)-(?:\d{6,}|[0-9a-f]{12,})$/i.test(normalized)) {
		return true;
	}
	if (pathLooksSynthetic(path) && /^(?:[a-z]+-){1,4}[a-z0-9-]+$/i.test(normalized)) return true;
	if (pathLooksSynthetic(path) && /^[A-Z][A-Z0-9_]{5,}$/.test(value) && /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(value)) return true;
	return false;
}

function isSyntheticPrivateKey(text, path, matchIndex) {
	if (!pathLooksSynthetic(path)) return false;
	const block = text.slice(matchIndex, matchIndex + 256);
	return /BEGIN PRIVATE KEY-----(?:\\n|\s)*(?:secret|test|dummy)(?:\\n|\s)*-----END PRIVATE KEY-----/i.test(block);
}

function addFinding(findings, category, path, text, index, severity = "error") {
	findings.push({ category, path, line: lineNumber(text, index), severity });
}

function scanText(path, text, findings) {
	const normalizedPath = toPosixPath(path);

	for (const match of text.matchAll(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/g)) {
		if (!isSyntheticPrivateKey(text, normalizedPath, match.index)) {
			addFinding(findings, "private key material", normalizedPath, text, match.index);
		}
	}

	const tokenPatterns = [
		{ category: "provider or Git token", regex: /\b(?:sk-(?:proj-|ant-|sp-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g },
		{ category: "bearer token", regex: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi },
	];

	for (const { category, regex } of tokenPatterns) {
		for (const match of text.matchAll(regex)) {
			const value = match[1] ?? match[0];
			if (!isPlaceholder(value, normalizedPath)) addFinding(findings, category, normalizedPath, text, match.index);
		}
	}

	const assignmentRegex = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*["'`]([^"'`\r\n]{12,})["'`]/gi;
	for (const match of text.matchAll(assignmentRegex)) {
		if (!isPlaceholder(match[1], normalizedPath)) addFinding(findings, "credential-like assignment", normalizedPath, text, match.index);
	}

	const queryRegex = /[?&](?:token|key|secret|password|access_token|api_key)=([^&#\s]{12,})/gi;
	for (const match of text.matchAll(queryRegex)) {
		if (!isPlaceholder(match[1], normalizedPath)) addFinding(findings, "credential in URL", normalizedPath, text, match.index);
	}

	const windowsPathRegex = /[A-Za-z]:\\Users\\([^\\/\s'"`<>]+)(?:\\[^\\/\s'"`<>]+)+/g;
	for (const match of text.matchAll(windowsPathRegex)) {
		if (!/^(?:test|example|user|username|public|default|default user|all users)$/i.test(match[1])) {
			addFinding(findings, "concrete Windows user path", normalizedPath, text, match.index);
		}
	}

	const posixPathRegex = /\/(?:Users|home)\/([^/\s'"`<>]+)(?:\/[^\s'"`<>]+)+/g;
	for (const match of text.matchAll(posixPathRegex)) {
		if (!/^(?:test|example|user|username|runner|root|shared|foo|bar)$/i.test(match[1])) {
			addFinding(findings, "concrete POSIX user path", normalizedPath, text, match.index);
		}
	}

	const emailRegex = /\b(?:email|e-mail|user[_ -]?email|contact)\b\s*[:=]\s*["']?([\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,})/gi;
	for (const match of text.matchAll(emailRegex)) {
		if (!/@(?:example\.(?:com|org|net|invalid)|test\.(?:invalid|example)|localhost)$/i.test(match[1])) {
			addFinding(findings, "email address requiring review", normalizedPath, text, match.index);
		}
	}

	const phoneRegex = /\b(?:phone|mobile|telephone|tel)\b\s*[:=]?\s*(\+?[0-9][0-9 ()-]{8,}[0-9])/gi;
	for (const match of text.matchAll(phoneRegex)) {
		if (!isPlaceholder(match[1], normalizedPath)) addFinding(findings, "phone number requiring review", normalizedPath, text, match.index);
	}
}

function checkManifest(entries, findings) {
	const entry = entries.find((candidate) => candidate.path === "packages/coding-agent/code-intelligence/runtime-manifest.json");
	if (!entry) {
		addFinding(findings, "missing Code Intelligence runtime manifest", "packages/coding-agent/code-intelligence/runtime-manifest.json", "", 0);
		return;
	}

	let manifest;
	try {
		manifest = JSON.parse(entry.read().toString("utf8"));
	} catch {
		addFinding(findings, "invalid Code Intelligence runtime manifest", entry.path, "", 0);
		return;
	}

	if (manifest.defaultMode !== "lightweight") addFinding(findings, "Code Intelligence default is not lightweight", entry.path, "", 0);
	const artifacts = [
		...(manifest.modules ?? []).map((module) => module.artifact),
		...(manifest.sharedComponents ?? []).map((component) => component.artifact),
	].filter(Boolean);
	const metadataPresent = artifacts.some((artifact) => artifact.sizeBytes !== null || artifact.sha256 !== null);
	if (!manifest.published && metadataPresent) addFinding(findings, "unpublished runtime has release metadata", entry.path, "", 0);
	if (manifest.published) {
		for (const artifact of artifacts) {
			if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || !SHA256_RE.test(artifact.sha256 ?? "")) {
				addFinding(findings, "published runtime artifact lacks exact size or SHA-256", entry.path, "", 0);
			}
		}
	}

	const runtimeFiles = entries.filter((candidate) => /(^|\/)code-intelligence\/(?:runtime|\.downloads|\.staging)(\/|$)/i.test(candidate.path));
	if (runtimeFiles.length > 0) {
		addFinding(findings, "downloaded Code Intelligence runtime is tracked", runtimeFiles[0].path, "", 0);
	}
	const archiveFiles = entries.filter((candidate) => /(^|\/)code-intelligence\/.*\.(?:zip|7z|tar|gz|exe|dll)$/i.test(candidate.path));
	if (!manifest.published && archiveFiles.length > 0) {
		addFinding(findings, "unpublished Code Intelligence archive is tracked", archiveFiles[0].path, "", 0);
	}
}

function checkLicenseFiles(entries, findings) {
	const paths = new Set(entries.map((entry) => entry.path));
	for (const required of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
		if (!paths.has(required)) addFinding(findings, `missing ${required}`, required, "", 0);
	}

	const licenseEntry = entries.find((entry) => entry.path === "LICENSE");
	if (licenseEntry && !/Apache License, Version 2\.0/i.test(licenseEntry.read().toString("utf8"))) {
		addFinding(findings, "root LICENSE is not Apache-2.0 text", "LICENSE", "", 0);
	}

	for (const entry of entries.filter((candidate) => candidate.path.endsWith("package.json"))) {
		let packageJson;
		try {
			packageJson = JSON.parse(entry.read().toString("utf8"));
		} catch {
			continue;
		}
		if (typeof packageJson.name === "string" && packageJson.name.startsWith("@myharness/") && packageJson.license !== "Apache-2.0") {
			addFinding(findings, "MyHarness package license is not Apache-2.0", entry.path, "", 0);
		}
	}
}

function checkTreeShape(entries, findings, skipLocalToolStatePaths = false) {
	for (const entry of entries) {
		const path = toPosixPath(entry.path);
		for (const rule of FORBIDDEN_PATH_RULES) {
			if (skipLocalToolStatePaths && rule === LOCAL_TOOL_STATE_PATH_RULE) continue;
			if (rule.pattern.test(path)) {
				addFinding(findings, `${rule.category} is tracked`, path, "", 0);
				break;
			}
		}
		if (entry.mode === "160000") addFinding(findings, "submodule entry", path, "", 0);
		if (entry.size > MAX_TRACKED_FILE_BYTES) addFinding(findings, "unexpectedly large tracked file", path, "", 0);
		const buffer = entry.read();
		if (buffer.subarray(0, 80).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
			addFinding(findings, "Git LFS pointer", path, "", 0);
		}
	}
}

function scanContents(entries, findings) {
	for (const entry of entries) {
		const path = toPosixPath(entry.path);
		if (entry.size > MAX_TEXT_SCAN_BYTES) continue;
		const extension = extname(path).toLowerCase();
		if (!TEXT_EXTENSIONS.has(extension) && basename(path) !== "LICENSE" && basename(path) !== "NOTICE") continue;
		const buffer = entry.read();
		if (buffer.includes(0)) continue;
		scanText(path, buffer.toString("utf8"), findings);
	}
}

function checkOrphan(ref, findings) {
	const parents = git(["rev-list", "--parents", "-n", "1", ref]).trim().split(/\s+/).filter(Boolean);
	if (parents.length !== 1) addFinding(findings, "public ref has parent history", ref, "", 0);
}

function printIgnoredWorktreeInfo() {
	const ignored = splitNul(git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]));
	if (ignored.length === 0) return;
	const topLevel = [...new Set(ignored.map((path) => path.split(/[\\/]/)[0]))].sort();
	console.log(`Ignored local files are present but not audited as release content (${ignored.length} files; top-level: ${topLevel.join(", ")}).`);
}

function main() {
	const options = parseArgs();
	const entries = getEntries(options);
	const findings = [];

	if (options.mode === "staged") checkStagedIndexToolDirectories(findings);
	if (options.mode === "ref" && options.requireOrphan) checkOrphan(options.ref, findings);
	checkTreeShape(entries, findings, options.mode === "staged");
	if (options.mode !== "staged") {
		checkManifest(entries, findings);
		checkLicenseFiles(entries, findings);
	}
	scanContents(entries, findings);

	if (options.mode === "worktree") printIgnoredWorktreeInfo();

	const errors = findings.filter((finding) => finding.severity === "error");
	const modeLabel = options.mode === "ref" ? `ref ${options.ref}` : options.mode;
	console.log(`Release audit: ${modeLabel}; audited ${entries.length} tracked files.`);
	if (errors.length === 0) {
		console.log("Release audit passed; no high-confidence release/privacy findings.");
		return;
	}

	console.error(`Release audit failed with ${errors.length} finding(s):`);
	for (const finding of errors) {
		const location = finding.line ? `${finding.path}:${finding.line}` : finding.path;
		console.error(`- ${finding.category}: ${location}`);
	}
	process.exitCode = 1;
}

try {
	main();
} catch (error) {
	console.error(`Release audit could not run: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
