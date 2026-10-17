import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getWorkspaceUploadsDir } from "../config/paths/index.ts";

export interface WorkspaceSource {
	id: string;
	name: string;
	path: string;
	size: number;
	/** Modification time of the stored file (ms since epoch); shown as the source's date. */
	modified: number;
}
/** Why a source could not be deleted: a malformed id, a source that is not there, or a directory left untouched. */
export class WorkspaceSourceError extends Error {
	readonly code: "invalid" | "not_found" | "refused";
	constructor(code: "invalid" | "not_found" | "refused", message: string) {
		super(message);
		this.code = code;
	}
}
const SOURCE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function sourceRoot(dataRoot: string, workspaceId: string): string {
	const root = getWorkspaceUploadsDir(dataRoot, workspaceId);
	// Refuse indirect roots; never write through a user-created junction/symlink.
	for (const directory of [dataRoot, join(dataRoot, "workspaces"), join(dataRoot, "workspaces", workspaceId), root]) {
		if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
			throw new Error("Indirect source directories are not supported.");
	}
	return root;
}
export function listWorkspaceSources(dataRoot: string, workspaceId: string): WorkspaceSource[] {
	const root = sourceRoot(dataRoot, workspaceId);
	if (!existsSync(root)) return [];
	const sources: WorkspaceSource[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
		try {
			const directory = join(root, entry.name);
			const manifest = join(directory, "source.json");
			if (lstatSync(manifest).isSymbolicLink()) continue;
			const source = JSON.parse(readFileSync(manifest, "utf8"));
			if (
				typeof source.name !== "string" ||
				!Number.isFinite(source.size) ||
				typeof source.storedName !== "string" ||
				!/^source-[^\\/:*?"<>|]+$/.test(source.storedName)
			)
				continue;
			const path = join(directory, source.storedName);
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			sources.push({ id: entry.name, name: source.name, size: source.size, path, modified: stat.mtimeMs });
		} catch {
			/* An incomplete upload does not become a source. */
		}
	}
	return sources;
}
export function uploadWorkspaceSource(
	dataRoot: string,
	workspaceId: string,
	name: string,
	data: string,
): WorkspaceSource {
	if (data.length > Math.ceil((32 * 1024 * 1024) / 3) * 4) throw new Error("Files must be 32 MiB or smaller.");
	if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid base64 file data.");
	const root = sourceRoot(dataRoot, workspaceId);
	if (listWorkspaceSources(dataRoot, workspaceId).length >= 100) throw new Error("At most 100 workspace sources.");
	mkdirSync(root, { recursive: true });
	const id = randomUUID();
	const directory = join(root, id);
	mkdirSync(directory);
	const storedName = `source-${
		name
			.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
			.replace(/[. ]+$/g, "")
			.slice(0, 180) || "file"
	}`;
	const path = join(directory, storedName);
	const bytes = Buffer.from(data, "base64");
	writeFileSync(path, bytes, { flag: "wx" });
	const source = { id, name: name.slice(0, 255), path, size: bytes.length, modified: lstatSync(path).mtimeMs };
	writeFileSync(
		join(directory, "source.json"),
		JSON.stringify({ version: 1, name: source.name, size: source.size, storedName }),
		{ flag: "wx" },
	);
	return source;
}
/**
 * Delete one source: only its own `<uploads>/<id>/` directory. The same indirect-root checks as listing and upload
 * apply first; the directory itself must be a real directory holding only plain files (its manifest and the stored
 * file), so nothing is ever removed through a link and the uploads root and workspace directory stay untouched.
 */
export function deleteWorkspaceSource(dataRoot: string, workspaceId: string, sourceId: string): void {
	if (!SOURCE_ID.test(sourceId)) throw new WorkspaceSourceError("invalid", "Invalid source id.");
	const root = sourceRoot(dataRoot, workspaceId);
	const directory = join(root, sourceId);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(directory);
	} catch {
		throw new WorkspaceSourceError("not_found", "This source no longer exists.");
	}
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new WorkspaceSourceError("refused", "Indirect source directories are not supported.");
	const entries = readdirSync(directory, { withFileTypes: true });
	if (entries.some((entry) => !entry.isFile()))
		throw new WorkspaceSourceError("refused", "The source directory holds unexpected entries and was left as is.");
	try {
		for (const entry of entries) unlinkSync(join(directory, entry.name));
		rmdirSync(directory);
	} catch (error) {
		throw new WorkspaceSourceError(
			"refused",
			`Could not delete the source: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
