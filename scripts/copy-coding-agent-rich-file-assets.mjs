import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { familySync } from "detect-libc";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceNodeModules = join(repositoryRoot, "node_modules");
const assetRoot = join(repositoryRoot, "packages", "coding-agent", "dist", "rich-file-assets");
const targetNodeModules = join(assetRoot, "node_modules");

async function copyPackage(packageName) {
	const pathParts = packageName.split("/");
	await cp(join(sourceNodeModules, ...pathParts), join(targetNodeModules, ...pathParts), { recursive: true });
}

async function rewriteSharpRequires(platformPackages) {
	const sharpPackage = platformPackages.find(
		(name) => name.startsWith("@img/sharp-") && !name.startsWith("@img/sharp-libvips-"),
	);
	const libvipsPackage = platformPackages.find((name) => name.startsWith("@img/sharp-libvips-"));
	if (!sharpPackage) throw new Error("Could not determine the Sharp platform package");

	const sharpDist = join(targetNodeModules, "sharp", "dist");
	for (const filename of await readdir(sharpDist)) {
		if (!filename.endsWith(".cjs")) continue;
		const path = join(sharpDist, filename);
		let source = await readFile(path, "utf8");
		source = source
			.replaceAll('require("detect-libc")', 'require("../node_modules/detect-libc/lib/detect-libc.js")')
			.replaceAll("require('detect-libc')", 'require("../node_modules/detect-libc/lib/detect-libc.js")')
			.replaceAll("require('semver')", 'require("../node_modules/semver/index.js")')
			.replaceAll("require('@img/colour')", 'require("../node_modules/@img/colour/index.cjs")')
			.replaceAll(
				`require("${sharpPackage}/sharp.node")`,
				`require("../node_modules/${sharpPackage}/index.cjs")`,
			)
			.replaceAll(
				`require(\`${sharpPackage}/versions\`)`,
				`require("../node_modules/${sharpPackage}/versions.json")`,
			);
		if (libvipsPackage) {
			source = source
				.replaceAll(
					`require(\`${libvipsPackage}/versions\`)`,
					`require("../node_modules/${libvipsPackage}/versions.json")`,
				)
				.replaceAll(
					`require(\`${libvipsPackage}/package\`)`,
					`require("../node_modules/${libvipsPackage}/package.json")`,
				);
		}
		await writeFile(path, source);
	}
}

function getPlatformPackages() {
	const platformArch = `${process.platform}-${process.arch}`;
	switch (platformArch) {
		case "win32-x64":
			return ["@img/sharp-win32-x64", "@napi-rs/canvas-win32-x64-msvc"];
		case "win32-arm64":
			return ["@img/sharp-win32-arm64", "@napi-rs/canvas-win32-arm64-msvc"];
		case "darwin-x64":
			return ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64", "@napi-rs/canvas-darwin-x64"];
		case "darwin-arm64":
			return ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64", "@napi-rs/canvas-darwin-arm64"];
		case "linux-x64": {
			const musl = familySync() === "musl";
			return musl
				? ["@img/sharp-linuxmusl-x64", "@img/sharp-libvips-linuxmusl-x64", "@napi-rs/canvas-linux-x64-musl"]
				: ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@napi-rs/canvas-linux-x64-gnu"];
		}
		case "linux-arm64": {
			const musl = familySync() === "musl";
			return musl
				? ["@img/sharp-linuxmusl-arm64", "@img/sharp-libvips-linuxmusl-arm64", "@napi-rs/canvas-linux-arm64-musl"]
				: ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64", "@napi-rs/canvas-linux-arm64-gnu"];
		}
		case "linux-arm":
			return ["@img/sharp-linux-arm", "@img/sharp-libvips-linux-arm", "@napi-rs/canvas-linux-arm-gnueabihf"];
		case "linux-riscv64":
			return ["@img/sharp-linux-riscv64", "@img/sharp-libvips-linux-riscv64", "@napi-rs/canvas-linux-riscv64-gnu"];
		default:
			throw new Error(`Rich file assets are not configured for ${platformArch}`);
	}
}

await rm(assetRoot, { recursive: true, force: true });
await mkdir(targetNodeModules, { recursive: true });

const platformPackages = getPlatformPackages();
for (const packageName of [
	"sharp",
	"@img/colour",
	"detect-libc",
	"semver",
	"@napi-rs/canvas",
	"jxl-wasm",
	...platformPackages,
]) {
	await copyPackage(packageName);
}

const sharpNodeModules = join(targetNodeModules, "sharp", "node_modules");
await mkdir(sharpNodeModules, { recursive: true });
for (const packageName of ["@img/colour", "detect-libc", "semver", ...platformPackages.filter((name) => name.startsWith("@img/"))]) {
	const pathParts = packageName.split("/");
	await cp(join(sourceNodeModules, ...pathParts), join(sharpNodeModules, ...pathParts), { recursive: true });
}

const canvasPlatformPackage = platformPackages.find((name) => name.startsWith("@napi-rs/canvas-"));
if (canvasPlatformPackage) {
	const pathParts = canvasPlatformPackage.split("/");
	const canvasNodeModules = join(targetNodeModules, "@napi-rs", "canvas", "node_modules");
	await cp(join(sourceNodeModules, ...pathParts), join(canvasNodeModules, ...pathParts), { recursive: true });
	const nativePackage = JSON.parse(
		await readFile(join(sourceNodeModules, ...pathParts, "package.json"), "utf8"),
	);
	const bindingPath = join(targetNodeModules, "@napi-rs", "canvas", "js-binding.js");
	const bindingSource = await readFile(bindingPath, "utf8");
	await writeFile(
		bindingPath,
		bindingSource.replaceAll(
			`require('${canvasPlatformPackage}')`,
			`require('./node_modules/${canvasPlatformPackage}/${nativePackage.main}')`,
		),
	);
}
await rewriteSharpRequires(platformPackages);

const ffmpegPath = require("ffmpeg-static");
if (!ffmpegPath) {
	throw new Error(`ffmpeg-static does not provide a binary for ${process.platform}-${process.arch}`);
}
await cp(ffmpegPath, join(assetRoot, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
const pdfEntryPath = join(assetRoot, "pdf.mjs");
await cp(join(sourceNodeModules, "pdfjs-dist", "legacy", "build", "pdf.mjs"), pdfEntryPath);
await cp(join(sourceNodeModules, "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"), join(assetRoot, "pdf.worker.mjs"));
await cp(join(sourceNodeModules, "pdfjs-dist", "standard_fonts"), join(assetRoot, "standard_fonts"), { recursive: true });
const pdfRequireSetup = 'const require = process.getBuiltinModule("module").createRequire(import.meta.url);';
const externalCanvasRequireSetup = `const nativeRequire = process.getBuiltinModule("module").createRequire(process.execPath);
    const require = specifier => specifier === "@napi-rs/canvas"
      ? nativeRequire(process.getBuiltinModule("path").join(process.getBuiltinModule("path").dirname(process.execPath), "rich-file-assets", "node_modules", "@napi-rs", "canvas", "index.js"))
      : nativeRequire(specifier);`;
const pdfSource = await readFile(pdfEntryPath, "utf8");
await writeFile(pdfEntryPath, pdfSource.replaceAll(pdfRequireSetup, externalCanvasRequireSetup));

console.log(`Copied rich file assets to ${assetRoot}`);
