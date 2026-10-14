import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { getDataDir, getSessionDir, getWorkspaceDir, type SessionDataPathInfo } from "../../config/paths/index.ts";
import { assertDirectPath } from "../../session/artifacts/store.ts";
import type { PreprocessedLocalFile } from "../../utils/file-preprocess.ts";

const VERSION = 1;
const MAX_CACHE_BYTES = 96 * 1024 * 1024;

export function extractionCacheRoots(scope?: SessionDataPathInfo): string[] {
	const dataRoot = scope?.dataRoot ?? getDataDir();
	return [
		...(scope
			? [
					join(getSessionDir(dataRoot, scope.workspaceId, scope.sessionId), "artifacts", "temporary", "extracted"),
					join(getWorkspaceDir(dataRoot, scope.workspaceId), "cache", "extracted"),
				]
			: []),
		join(dataRoot, "cache", "extracted"),
	];
}

export function extractionDestination(source: string, scope?: SessionDataPathInfo, cwd?: string): string {
	const roots = extractionCacheRoots(scope);
	if (!scope || scope.workspaceId === "unbound") return roots[roots.length - 1]!;
	const session = getSessionDir(scope.dataRoot, scope.workspaceId, scope.sessionId);
	const inside = (root: string) => {
		const path = relative(resolve(root), resolve(source));
		return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.includes(":"));
	};
	if (inside(session)) return roots[0]!;
	return cwd && inside(cwd) ? roots[1]! : roots[roots.length - 1]!;
}

export function extractionKey(source: string, size: number, mtimeMs: number, variant: string): string {
	const path = resolve(source).replace(/\\/g, "/");
	return createHash("sha256")
		.update(
			JSON.stringify([VERSION, process.platform === "win32" ? path.toLowerCase() : path, size, mtimeMs, variant]),
		)
		.digest("hex");
}

export async function readExtractionCache(roots: string[], key: string): Promise<PreprocessedLocalFile | undefined> {
	for (const root of roots) {
		try {
			const path = join(root, key, "result.json");
			assertDirectPath(path);
			if ((await stat(path)).size > MAX_CACHE_BYTES) continue;
			const entry = JSON.parse(await readFile(path, "utf8"));
			if (
				entry.version !== VERSION ||
				entry.key !== key ||
				typeof entry.result?.text !== "string" ||
				!Array.isArray(entry.result.images)
			)
				continue;
			const result = entry.result as PreprocessedLocalFile;
			if (
				!result.images.every(
					(image) =>
						image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string",
				)
			)
				continue;
			if (result.documentManifestPath) await stat(result.documentManifestPath);
			return result;
		} catch {
			/* A missing or incomplete cache never prevents source extraction. */
		}
	}
	return undefined;
}

export async function writeExtractionCache(
	root: string,
	key: string,
	source: string,
	size: number,
	mtimeMs: number,
	result: PreprocessedLocalFile,
): Promise<void> {
	// Diagnostics are retried rather than becoming permanent cached failures.
	if (result.text.includes("失败") || result.kind === "unsupported") return;
	const directory = join(root, key);
	assertDirectPath(directory);
	await mkdir(directory, { recursive: true });
	const body = JSON.stringify({ version: VERSION, key, sourcePath: resolve(source), size, mtimeMs, result });
	if (Buffer.byteLength(body) > MAX_CACHE_BYTES) return;
	const temporary = join(directory, `${randomUUID()}.tmp`);
	assertDirectPath(temporary);
	await writeFile(temporary, body, "utf8");
	assertDirectPath(join(directory, "result.json"));
	await rename(temporary, join(directory, "result.json"));
	if (result.kind !== "image") {
		assertDirectPath(join(directory, "extracted.md"));
		await writeFile(join(directory, "extracted.md"), result.fullText ?? result.text, "utf8");
	}
	for (const [index, image] of result.images.entries()) {
		const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/png" ? "png" : "bin";
		const imagePath = join(directory, `image-${index + 1}.${extension}`);
		assertDirectPath(imagePath);
		await writeFile(imagePath, Buffer.from(image.data, "base64"));
	}
}
