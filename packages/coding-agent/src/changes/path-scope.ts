/**
 * Which file a change really touches, and whether it may.
 *
 * A path or file URI is resolved to the file's real location before anything is written: links and
 * junctions are followed, short names and spelling differences collapse, and the result must still lie
 * inside the workspace's real root. Files that cannot be replaced safely (hard links, devices, directories)
 * are refused with a reason instead of being written through.
 */

import { realpath, stat } from "node:fs/promises";
import { win32 as windowsPath } from "node:path";
import {
	isInsideWorkspace,
	normalizeDocumentPath,
	normalizeWorkspaceRoot,
	relativeToWorkspace,
} from "../symbols/path-semantics.ts";
import { getMutationQueueKey } from "../tools/files/file-mutation-queue.ts";
import { ChangeControlError } from "./errors.ts";

export interface ScopedFile {
	/** Workspace-relative path with forward slashes, as the file is really named on disk. */
	readonly path: string;
	/** The file to read and replace: the real location, never a link. */
	readonly absolutePath: string;
	/** Identity shared by every spelling of the file; the key of the mutation queue and process lock. */
	readonly key: string;
	readonly exists: boolean;
}

const RESERVED_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function refuseSpecialSpelling(absolutePath: string, input: string): void {
	const withoutRoot = absolutePath.slice(windowsPath.parse(absolutePath).root.length);
	if (absolutePath.startsWith("\\\\?\\") || absolutePath.startsWith("\\\\.\\")) {
		throw new ChangeControlError("PATH_OUT_OF_SCOPE", `${input} uses a device namespace path`, { paths: [input] });
	}
	for (const segment of withoutRoot.split("\\")) {
		if (segment === "") continue;
		if (segment.includes(":")) {
			throw new ChangeControlError("PATH_OUT_OF_SCOPE", `${input} names an alternate data stream`, {
				paths: [input],
			});
		}
		if (RESERVED_DEVICE_NAMES.test(segment) || /[. ]$/u.test(segment)) {
			throw new ChangeControlError("PATH_OUT_OF_SCOPE", `${input} contains a name Windows treats specially`, {
				paths: [input],
			});
		}
	}
}

async function realLocation(absolutePath: string): Promise<string> {
	const missing: string[] = [];
	let current = absolutePath;
	for (;;) {
		try {
			const real = await realpath(current);
			return missing.length === 0 ? real : windowsPath.join(real, ...missing.reverse());
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = windowsPath.dirname(current);
			if (parent === current) return absolutePath;
			missing.push(windowsPath.basename(current));
			current = parent;
		}
	}
}

/**
 * Resolve a workspace-relative path, absolute path or file URI to the file a change would replace.
 * Throws PATH_OUT_OF_SCOPE for anything outside the workspace and UNSUPPORTED_FILE for files that
 * cannot be replaced without side effects on other names.
 */
export async function resolveScopedFile(workspaceRoot: string, input: string): Promise<ScopedFile> {
	const root = normalizeWorkspaceRoot(workspaceRoot);
	let absolute: string;
	try {
		absolute = normalizeDocumentPath(input, root);
	} catch (cause) {
		throw new ChangeControlError("PATH_OUT_OF_SCOPE", `${input} is not a usable file path`, {
			paths: [input],
			cause,
		});
	}
	if (!isInsideWorkspace(root, absolute) || relativeToWorkspace(root, absolute) === "") {
		throw new ChangeControlError("PATH_OUT_OF_SCOPE", `${input} is outside the workspace`, { paths: [input] });
	}
	refuseSpecialSpelling(relativeToWorkspace(root, absolute).replace(/\//g, "\\"), input);

	const realRoot = await realpath(root);
	const real = await realLocation(absolute);
	if (!isInsideWorkspace(realRoot, real)) {
		throw new ChangeControlError("PATH_OUT_OF_SCOPE", `${input} resolves outside the workspace through a link`, {
			paths: [input],
		});
	}
	const path = relativeToWorkspace(realRoot, real);
	if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) {
		throw new ChangeControlError(
			"PATH_OUT_OF_SCOPE",
			`${path} is version-control metadata; controlled changes never touch it`,
			{
				paths: [path],
			},
		);
	}

	let exists = false;
	try {
		const info = await stat(real);
		exists = true;
		if (info.isDirectory()) {
			throw new ChangeControlError("UNSUPPORTED_FILE", `${path} is a directory`, { paths: [path] });
		}
		if (!info.isFile()) {
			throw new ChangeControlError("UNSUPPORTED_FILE", `${path} is not a regular file`, { paths: [path] });
		}
		if (info.nlink > 1) {
			throw new ChangeControlError(
				"UNSUPPORTED_FILE",
				`${path} has other hard links; replacing it would silently detach them`,
				{ paths: [path] },
			);
		}
	} catch (error) {
		if (error instanceof ChangeControlError) throw error;
		if (!isMissing(error)) throw error;
	}
	return { path, absolutePath: real, key: await getMutationQueueKey(real), exists };
}
