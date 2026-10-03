#!/usr/bin/env node
// Builds the Code Intelligence release archives listed in
// packages/coding-agent/code-intelligence/runtime-manifest.json (Windows x64).
//
//   node scripts/build-code-intelligence-artifacts.mjs [--only id,id] [--out dir] [--apply]
//
// Archives and downloads go to .artifacts/ (git-ignored). Upload the archives to
// the GitHub release named by `releaseTag`; --apply then writes their exact size
// and SHA-256 into runtime-manifest.json and marks it published.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciDir = path.join(repoRoot, "packages", "coding-agent", "code-intelligence");
const manifestPath = path.join(ciDir, "runtime-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = option("--only")?.split(",");
const artifactsRoot = path.resolve(option("--out") ?? path.join(repoRoot, ".artifacts", "code-intelligence"));
const cacheDir = path.join(artifactsRoot, "downloads");
const workDir = path.join(artifactsRoot, "work");
const outDir = path.join(artifactsRoot, "release");
const bsdtar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

// Pinned upstream sources. Versions come from runtime-manifest.json where it records them.
const TYPESCRIPT = "5.9.3"; // tsserver.js is required by typescript-language-server and the Vue proxy.
const moduleVersion = (id) => manifest.modules.find((entry) => entry.id === id).serverVersion;
const componentVersion = (id) => manifest.sharedComponents.find((entry) => entry.id === id).version;
const GOPLS_VERSION = moduleVersion("go");
const GO_VERSION = componentVersion("go-runtime");
const RUST_VERSION = componentVersion("rust-toolchain");
const DOTNET_VERSION = componentVersion("dotnet-sdk-10");
const RUBY_VERSION = componentVersion("ruby-runtime-3.4");

const log = (message) => process.stderr.write(`[ci-artifacts] ${message}\n`);

function run(command, commandArgs, options = {}) {
	log(`${path.basename(command)} ${commandArgs.join(" ").slice(0, 160)}`);
	const result = spawnSync(command, commandArgs, { stdio: "inherit", windowsHide: true, shell: false, ...options });
	if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status ?? result.error}`);
}

const npm = (npmArgs, options) => run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...npmArgs], options);

async function download(url, name) {
	const target = path.join(cacheDir, name);
	if (existsSync(target) && statSync(target).size > 0) return target;
	mkdirSync(cacheDir, { recursive: true });
	log(`download ${url}`);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`download failed ${response.status}: ${url}`);
	const partial = `${target}.part`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
	renameSync(partial, target);
	return target;
}

function extract(archive, destination) {
	mkdirSync(destination, { recursive: true });
	run(bsdtar, ["-xf", archive, "-C", destination]);
}

async function freshDir(...parts) {
	const dir = path.join(workDir, ...parts);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	return dir;
}

async function sha256(file) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(file), hash);
	return hash.digest("hex");
}

/** Zip the top-level entries of `directory` (forward-slash paths, no ./ prefix). */
function zipDirectory(directory, fileName) {
	mkdirSync(outDir, { recursive: true });
	const target = path.join(outDir, fileName);
	rmSync(target, { force: true });
	run(bsdtar, ["-a", "-cf", target, "-C", directory, ...readdirSync(directory)]);
	return target;
}

function walk(directory, prefix = "") {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? walk(path.join(directory, entry.name), path.join(prefix, entry.name)) : [path.join(prefix, entry.name)],
	);
}

function the(directory, pattern) {
	const match = readdirSync(directory).find((name) => pattern.test(name));
	if (!match) throw new Error(`no entry matching ${pattern} in ${directory}`);
	return path.join(directory, match);
}

async function npmModule(id, packages) {
	const dir = await freshDir(id);
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `ci-${id}`, private: true, dependencies: packages }, null, 2));
	npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--os=win32", "--cpu=x64"], { cwd: dir });
	rmSync(path.join(dir, "node_modules", ".bin"), { recursive: true, force: true });
	rmSync(path.join(dir, "node_modules", ".package-lock.json"), { force: true });
	const stage = await freshDir(`${id}-stage`);
	await cp(path.join(dir, "node_modules"), path.join(stage, "node_modules"), { recursive: true });
	return stage;
}

const licenseOf = (stage, ...names) => Promise.all(names.map((name) => copyFile(path.join(ciDir, "licenses", name), path.join(stage, name))));

// Each recipe returns the directory whose contents become the archive root.
const recipes = {
	"javascript-typescript": () => npmModule("javascript-typescript", { "typescript-language-server": moduleVersion("javascript-typescript"), typescript: TYPESCRIPT }),
	python: () => npmModule("python", { pyright: moduleVersion("python") }),
	json: () => npmModule("json", { "vscode-langservers-extracted": moduleVersion("json") }),
	scss: () => npmModule("scss", { "vscode-langservers-extracted": moduleVersion("scss") }),
	shell: () => npmModule("shell", { "bash-language-server": moduleVersion("shell") }),
	svelte: () => npmModule("svelte", { "svelte-language-server": moduleVersion("svelte"), typescript: TYPESCRIPT }),
	vue: () => npmModule("vue", { "@vue/language-server": moduleVersion("vue"), typescript: TYPESCRIPT }),
	yaml: () => npmModule("yaml", { "yaml-language-server": moduleVersion("yaml") }),
	php: () => npmModule("php", { "devsense-php-ls": moduleVersion("php") }),
	sql: () => npmModule("sql", { "sqllens-language-server": moduleVersion("sql") }),

	async "c-cpp"() {
		const version = moduleVersion("c-cpp");
		const raw = await freshDir("c-cpp-raw");
		extract(await download(`https://github.com/clangd/clangd/releases/download/${version}/clangd-windows-${version}.zip`, `clangd-windows-${version}.zip`), raw);
		const root = the(raw, /^clangd_/u);
		const stage = await freshDir("c-cpp-stage");
		await cp(path.join(root, "bin"), path.join(stage, "servers", "clangd"), { recursive: true });
		// clangd resolves its built-in headers as <exe dir>/../lib/clang/<major>.
		await cp(path.join(root, "lib"), path.join(stage, "servers", "lib"), { recursive: true });
		return stage;
	},

	async java() {
		const version = moduleVersion("java");
		const listing = await (await fetch(`https://download.eclipse.org/jdtls/milestones/${version}/`)).text();
		const name = /jdt-language-server-[\d.]+-\d+\.tar\.gz(?=['"])/u.exec(listing)?.[0];
		if (!name) throw new Error(`no JDT LS ${version} build found`);
		const raw = await freshDir("java-raw");
		extract(await download(`https://download.eclipse.org/jdtls/milestones/${version}/${name}`, name), raw);
		const stage = await freshDir("java-stage");
		await cp(raw, path.join(stage, "servers", "jdtls"), { recursive: true });
		return stage;
	},

	async rust() {
		const version = moduleVersion("rust");
		const raw = await freshDir("rust-raw");
		extract(await download(`https://github.com/rust-lang/rust-analyzer/releases/download/${version}/rust-analyzer-x86_64-pc-windows-msvc.zip`, `rust-analyzer-${version}.zip`), raw);
		const stage = await freshDir("rust-stage");
		await cp(raw, path.join(stage, "servers", "rust-analyzer"), { recursive: true });
		return stage;
	},

	async go() {
		const goRoot = await goSdk();
		const stage = await freshDir("go-stage");
		const target = path.join(stage, "servers", `go-${GO_VERSION}`);
		await mkdir(target, { recursive: true });
		const env = { ...process.env, GOROOT: goRoot, GOTOOLCHAIN: "local", GOBIN: target, GOPATH: path.join(workDir, "gopath") };
		run(path.join(goRoot, "bin", "go.exe"), ["install", `golang.org/x/tools/gopls@${GOPLS_VERSION}`], { env });
		run(path.join(goRoot, "bin", "go.exe"), ["clean", "-modcache"], { env });
		rmSync(path.join(workDir, "gopath"), { recursive: true, force: true });
		return stage;
	},

	async csharp() {
		const version = moduleVersion("csharp");
		const sdk = await dotnetSdk();
		const stage = await freshDir("csharp-stage");
		const env = { ...process.env, DOTNET_ROOT: sdk, DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_CLI_HOME: path.join(workDir, "dotnet-home"), DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
		run(path.join(sdk, "dotnet.exe"), ["tool", "install", "csharp-ls", "--version", version, "--tool-path", path.join(stage, "servers", "csharp-ls")], { env });
		rmSync(path.join(workDir, "dotnet-home"), { recursive: true, force: true });
		return stage;
	},

	async kotlin() {
		const version = moduleVersion("kotlin");
		const raw = await freshDir("kotlin-raw");
		extract(await download(`https://github.com/fwcd/kotlin-language-server/releases/download/${version}/server.zip`, `kotlin-language-server-${version}.zip`), raw);
		const stage = await freshDir("kotlin-stage");
		await cp(raw, path.join(stage, "servers", "kotlin"), { recursive: true });
		await mkdir(path.join(stage, "servers", "kotlin", "m2"), { recursive: true });
		writeFileSync(path.join(stage, "servers", "kotlin", "m2", ".keep"), "Maven repository used by the Kotlin language server.\n");
		return stage;
	},

	async ruby() {
		const version = moduleVersion("ruby");
		// Install into a scratch copy so the pristine runtime stays what the shared component ships.
		const home = path.join(workDir, "ruby-gems-work");
		await rm(home, { recursive: true, force: true });
		await cp(await rubyRuntime(), home, { recursive: true });
		const gems = path.join(home, "lib", "ruby", "gems", "3.4.0");
		const files = () =>
			new Set([
				...walk(gems).map((file) => path.join("lib", "ruby", "gems", "3.4.0", file)),
				...walk(path.join(home, "bin")).map((file) => path.join("bin", file)),
			]);
		const before = files();
		// Some Solargraph dependencies (jaro_winkler, rbs) compile C extensions, which needs an MSYS2 toolchain.
		if (!process.env.MSYS2_PATH || !existsSync(process.env.MSYS2_PATH))
			throw new Error("Set MSYS2_PATH to an MSYS2 / RubyInstaller DevKit directory (with the ucrt64 gcc toolchain) to build the Ruby module.");
		const env = { ...process.env, GEM_HOME: gems, GEM_PATH: gems, RUBYOPT: "" };
		run(path.join(home, "bin", "ruby.exe"), [path.join(home, "bin", "gem"), "install", "solargraph", "-v", version, "--no-document"], { env });
		// Ship only what solargraph added on top of the shared Ruby runtime.
		const stage = await freshDir("ruby-stage");
		for (const file of files()) {
			if (before.has(file)) continue;
			const target = path.join(stage, "servers", "ruby", file);
			await mkdir(path.dirname(target), { recursive: true });
			await copyFile(path.join(home, file), target);
		}
		await rm(home, { recursive: true, force: true });
		return stage;
	},

	async xml() {
		const version = moduleVersion("xml");
		const jar = await download(`https://repo.eclipse.org/content/repositories/lemminx-releases/org/eclipse/lemminx/org.eclipse.lemminx/${version}/org.eclipse.lemminx-${version}-uber.jar`, `lemminx-${version}.jar`);
		const stage = await freshDir("xml-stage");
		await mkdir(path.join(stage, "servers", "lemminx"), { recursive: true });
		await copyFile(jar, path.join(stage, "servers", "lemminx", "lemminx.jar"));
		return stage;
	},

	async "temurin-jre-21"() {
		const release = componentVersion("temurin-jre-21");
		const tag = encodeURIComponent(`jdk-${release}+1`);
		const raw = await freshDir("jre-raw");
		extract(await download(`https://api.adoptium.net/v3/binary/version/${tag}/windows/x64/jre/hotspot/normal/eclipse`, `temurin-jre-${release}.zip`), raw);
		const stage = await freshDir("jre-stage");
		await cp(the(raw, /^jdk-/u), path.join(stage, "servers", "jre"), { recursive: true });
		return stage;
	},

	async "rust-toolchain"() {
		const stage = await freshDir("rust-toolchain-stage");
		const home = path.join(stage, "servers", "rust-toolchain");
		await mkdir(home, { recursive: true });
		const init = await download("https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe", "rustup-init.exe");
		const env = { ...process.env, RUSTUP_HOME: path.join(home, "rustup"), CARGO_HOME: path.join(home, "cargo") };
		run(init, ["-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", RUST_VERSION, "-c", "rust-src"], { env });
		for (const transient of ["downloads", "tmp"]) rmSync(path.join(home, "rustup", transient), { recursive: true, force: true });
		return stage;
	},

	async "go-runtime"() {
		const goRoot = await goSdk();
		const stage = await freshDir("go-runtime-stage");
		await cp(goRoot, path.join(stage, "servers", `go-${GO_VERSION}`), { recursive: true });
		return stage;
	},

	async "dotnet-sdk-10"() {
		const stage = await freshDir("dotnet-stage");
		await cp(await dotnetSdk(), path.join(stage, "servers", "dotnet-10-sdk"), { recursive: true });
		return stage;
	},

	async "ruby-runtime-3.4"() {
		const stage = await freshDir("ruby-runtime-stage");
		await cp(await rubyRuntime(), path.join(stage, "servers", "ruby"), { recursive: true });
		return stage;
	},
};

async function goSdk() {
	const dir = path.join(workDir, "tool-go");
	if (existsSync(path.join(dir, "go", "bin", "go.exe"))) return path.join(dir, "go");
	await rm(dir, { recursive: true, force: true });
	extract(await download(`https://go.dev/dl/go${GO_VERSION}.windows-amd64.zip`, `go${GO_VERSION}.windows-amd64.zip`), dir);
	return path.join(dir, "go");
}

async function dotnetSdk() {
	const dir = path.join(workDir, "tool-dotnet");
	if (existsSync(path.join(dir, "dotnet.exe"))) return dir;
	await rm(dir, { recursive: true, force: true });
	extract(await download(`https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_VERSION}/dotnet-sdk-${DOTNET_VERSION}-win-x64.zip`, `dotnet-sdk-${DOTNET_VERSION}-win-x64.zip`), dir);
	return dir;
}

async function rubyRuntime() {
	const dir = path.join(workDir, "tool-ruby");
	const marker = path.join(dir, "bin", "ruby.exe");
	if (existsSync(marker)) return dir;
	await rm(dir, { recursive: true, force: true });
	const build = `${RUBY_VERSION}-1`;
	const raw = path.join(workDir, "tool-ruby-raw");
	await rm(raw, { recursive: true, force: true });
	extract(await download(`https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-${build}/rubyinstaller-${build}-x64.7z`, `rubyinstaller-${build}-x64.7z`), raw);
	renameSync(the(raw, /^rubyinstaller-/u), dir);
	return dir;
}

const wanted = (id) => !only || only.includes(id);
const results = {};

async function build(id, fileName) {
	if (!wanted(id)) return;
	log(`== ${id}`);
	const stage = await recipes[id]();
	await licenseOf(stage, ...LICENSES[id] ?? []);
	results[fileName] = zipDirectory(stage, fileName);
	await rm(stage, { recursive: true, force: true });
	log(`built ${fileName} (${statSync(results[fileName]).size} bytes)`);
}

// Notice files kept inside the archive next to the code they describe.
const LICENSES = {
	python: ["PYRIGHT-LICENSE.txt"],
	"javascript-typescript": ["TYPESCRIPT-LANGUAGE-SERVER-LICENSE", "TYPESCRIPT-LICENSE.txt"],
	json: ["VSCODE-LANGSERVERS-LICENSE"],
	scss: ["VSCODE-LANGSERVERS-LICENSE"],
	svelte: ["SVELTE-LANGUAGE-SERVER-LICENSE"],
	vue: ["VUE-LANGUAGE-SERVER-LICENSE", "TYPESCRIPT-LICENSE.txt"],
	php: ["DEVSENSE-PHP-NOTICE.txt"],
	sql: ["SQLLENS-LICENSE"],
	"c-cpp": ["CLANGD-LICENSE.txt"],
	java: ["JDTLS-LICENSE"],
	rust: ["RUST-ANALYZER-LICENSE-MIT", "RUST-ANALYZER-LICENSE-APACHE"],
	go: ["GO-LICENSE"],
	csharp: ["CSHARP-LS-LICENSE"],
	kotlin: ["KOTLIN-LANGUAGE-SERVER-LICENSE.txt", "KOTLIN-LICENSE-REPORT.html"],
	ruby: ["RUBY-LICENSE.txt"],
	xml: ["LEMMINX-LICENSE"],
	"temurin-jre-21": ["TEMURIN-NOTICE"],
	"go-runtime": ["GO-LICENSE"],
	"dotnet-sdk-10": ["DOTNET-LICENSE.txt", "DOTNET-THIRD-PARTY-NOTICES.txt"],
	"ruby-runtime-3.4": ["RUBY-LICENSE.txt"],
};

mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
for (const entry of manifest.modules) if (entry.artifact) await build(entry.id, entry.artifact.fileName);
for (const entry of manifest.sharedComponents) await build(entry.id, entry.artifact.fileName);

// Size and SHA-256 of every archive present in the release folder, not only the ones built in this run.
const metadata = {};
for (const file of readdirSync(outDir).filter((name) => name.endsWith(".zip")).sort()) {
	const target = path.join(outDir, file);
	metadata[file] = { sizeBytes: statSync(target).size, sha256: await sha256(target) };
}
const metadataPath = path.join(outDir, "artifact-metadata.json");
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
log(`wrote ${metadataPath}`);

if (args.includes("--apply")) {
	const all = JSON.parse(readFileSync(metadataPath, "utf8"));
	const names = [...manifest.modules.flatMap((entry) => (entry.artifact ? [entry.artifact.fileName] : [])), ...manifest.sharedComponents.map((entry) => entry.artifact.fileName)];
	const missing = names.filter((name) => !all[name]);
	if (missing.length > 0) throw new Error(`cannot apply, no archive built for: ${missing.join(", ")}`);
	let text = readFileSync(manifestPath, "utf8");
	const crlf = text.includes("\r\n");
	text = text.replace(/\r\n/gu, "\n");
	for (const name of names) {
		const pattern = new RegExp(`("fileName": "${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"[^\\n]*?"sizeBytes": )[^,]+(, "sha256": )[^,]+`, "u");
		if (!pattern.test(text)) throw new Error(`manifest entry not found for ${name}`);
		text = text.replace(pattern, `$1${all[name].sizeBytes}$2"${all[name].sha256}"`);
	}
	text = text.replace('"published": false', '"published": true');
	writeFileSync(manifestPath, crlf ? text.replace(/\n/gu, "\r\n") : text);
	log("runtime-manifest.json updated");
}
