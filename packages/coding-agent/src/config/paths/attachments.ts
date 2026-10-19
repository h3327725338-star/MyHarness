import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAttachmentManifestPath } from "./index.ts";

/** One uploaded attachment's manifest, kept as `manifest.json` beside the file. */
export interface AttachmentManifest {
	version: 1;
	/** Random upload id, also the folder name below `uploads/<session>/`. */
	id: string;
	/** Sanitized display name (`attachment-<cleaned>` basename is stored separately). */
	originalName: string;
	/** File name on disk (`attachment-<cleaned>`). */
	storedName: string;
	mime: string;
	size: number;
	/** ISO timestamp of the upload. */
	createdAt: string;
	/** Data-root-relative posix reference (`workspaces/<ws>/uploads/<session>/<id>/<file>`). */
	relativePath: string;
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".pdf": "application/pdf",
};

/** Guess a manifest mime from the file name; unknown types stay opaque bytes. */
export function guessAttachmentMime(fileName: string): string {
	const dot = fileName.toLowerCase().lastIndexOf(".");
	const mime = dot >= 0 ? MIME_BY_EXT[fileName.toLowerCase().slice(dot)] : undefined;
	return mime ?? "application/octet-stream";
}

/** Data-root-relative posix reference for an absolute attachment file. */
export function toAttachmentRelativePath(dataRoot: string, absolutePath: string): string {
	return relative(resolve(dataRoot), resolve(absolutePath)).split(sep).join("/");
}

/** Write (or overwrite) one attachment folder's manifest. The folder must already exist. */
export function writeAttachmentManifest(
	dataRoot: string,
	workspaceId: string,
	sessionId: string,
	attachmentId: string,
	manifest: AttachmentManifest,
): void {
	const file = getAttachmentManifestPath(dataRoot, workspaceId, sessionId, attachmentId);
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Best-effort manifest write for legacy layouts outside the workspace library. */
export function writeLegacyAttachmentManifest(directory: string, manifest: AttachmentManifest): void {
	writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Resolve an attachment reference to an absolute file.
 * New references are data-root-relative (`workspaces/<ws>/uploads/...`); old callers may still pass the absolute
 * path written before the workspace library existed. Absolute paths are returned as-is when the file exists so old
 * drafts keep reading; relative paths are resolved strictly inside the data root (symlinks rejected).
 */
export function resolveAttachmentReference(dataRoot: string, ref: string): string {
	const candidate = ref.trim();
	if (!candidate) throw new Error("Unknown attachment");
	if (isAbsolute(candidate)) {
		// Legacy absolute path: keep reading the bytes where they were written.
		if (!existsSync(candidate)) throw new Error("Unknown attachment");
		return candidate;
	}
	// New relative reference: must stay inside the data root.
	const absolute = resolve(resolve(dataRoot), candidate);
	const rel = relative(resolve(dataRoot), absolute);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Attachment is outside the data root");
	if (!existsSync(absolute)) throw new Error("Unknown attachment");
	assertDirectPath(absolute);
	const realRel = relative(realpathSync(resolve(dataRoot)), realpathSync(absolute));
	if (realRel.startsWith("..") || resolve(resolve(dataRoot), realRel) !== absolute)
		throw new Error("Attachment is outside the data root");
	return absolute;
}

function assertDirectPath(target: string): void {
	let current = resolve(target);
	for (;;) {
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			throw new Error("Attachment path contains a symbolic link or junction");
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}
