/**
 * Code Intelligence 的 Windows 路径契约。
 *
 * Code Intelligence 在所有运行环境中都按 Windows 语义处理 workspace、document
 * 和 LSP file URI。可读路径保留规范化后的原始大小写；identity 则单独使用
 * Windows 大小写不敏感的 key，避免把同一个文件拆成多个逻辑对象。
 *
 * 这里不做文件系统访问，也不读取宿主平台。需要验证 workspace
 * 是否真实存在的调用方仍负责执行 stat；本模块只负责纯路径/URI转换。
 */

import { win32 as windowsPath } from "node:path";
import { URL } from "node:url";

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const LEADING_DRIVE_SLASH = /^[/\\][A-Za-z]:[\\/]/;

function requirePath(value: string, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new TypeError(`${label} must be a non-empty path`);
	}
	return value;
}

function stripUriDriveSlash(value: string): string {
	return LEADING_DRIVE_SLASH.test(value) ? value.slice(1) : value;
}

function normalizeAbsolutePath(value: string, base?: string): string {
	const source = stripUriDriveSlash(value);
	const resolved = base === undefined ? windowsPath.resolve(source) : windowsPath.resolve(base, source);
	return windowsPath.normalize(resolved);
}

/** Normalize an absolute Windows workspace root without resolving symlinks. */
export function normalizeWorkspaceRoot(workspaceRoot: string): string {
	const value = requirePath(workspaceRoot, "workspace root");
	return normalizeAbsolutePath(/^file:/i.test(value) ? fromFileUri(value) : value);
}

/**
 * Normalize a document filesystem path or file URI to a canonical/display
 * Windows absolute path. Relative paths are resolved against workspaceRoot.
 */
export function normalizeDocumentPath(documentPath: string, workspaceRoot?: string): string {
	requirePath(documentPath, "document path");
	const filesystemPath = /^file:/i.test(documentPath) ? fromFileUri(documentPath) : documentPath;
	const normalizedWorkspace = workspaceRoot === undefined ? undefined : normalizeWorkspaceRoot(workspaceRoot);
	return normalizeAbsolutePath(filesystemPath, normalizedWorkspace);
}

/** Return a workspace-relative path using forward slashes. */
export function relativeToWorkspace(workspaceRoot: string, documentPath: string): string {
	const root = normalizeWorkspaceRoot(workspaceRoot);
	const document = normalizeDocumentPath(documentPath, root);
	return normalizeWorkspaceRelativePath(windowsPath.relative(root, document));
}

/**
 * Test containment after Windows normalization. The workspace root itself is
 * contained for boundary purposes; document callers must separately reject an
 * empty relative path when a real file is required.
 */
export function isInsideWorkspace(workspaceRoot: string, documentPath: string): boolean {
	const root = normalizeWorkspaceRoot(workspaceRoot);
	const document = normalizeDocumentPath(documentPath, root);
	const relativePath = windowsPath.relative(root, document);
	if (relativePath === "") return true;
	if (windowsPath.isAbsolute(relativePath)) return false;
	return relativePath.split(/[\\/]+/u)[0] !== "..";
}

/** Normalize a workspace-relative path without changing its display casing. */
export function normalizeWorkspaceRelativePath(path: string): string {
	if (typeof path !== "string" || path === "") return "";
	const normalized = windowsPath.normalize(path).replace(/\\/g, "/");
	if (normalized === ".") return "";
	return normalized.replace(/^(?:\.\/)+/u, "").replace(/^\/+/, "");
}

function identityKey(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

/** Return the case/slash-insensitive identity of a workspace root. */
export function getWorkspaceIdentity(workspaceRoot: string): string {
	return identityKey(normalizeWorkspaceRoot(workspaceRoot));
}

/** Return the case/slash-insensitive identity of a workspace-relative path. */
export function getWorkspaceRelativeIdentity(path: string): string {
	return identityKey(normalizeWorkspaceRelativePath(path));
}

/**
 * Return a logical document identity. With a workspace root, relative paths,
 * absolute paths, and file URIs are resolved to the same absolute key. Without
 * a root, relative symbol paths remain relative instead of being tied to cwd.
 */
export function getDocumentIdentity(documentPath: string, workspaceRoot?: string): string {
	if (workspaceRoot !== undefined) return identityKey(normalizeDocumentPath(documentPath, workspaceRoot));
	const strippedPath = stripUriDriveSlash(documentPath);
	if (/^file:/i.test(documentPath) || WINDOWS_DRIVE_PATH.test(strippedPath) || windowsPath.isAbsolute(strippedPath)) {
		return identityKey(normalizeDocumentPath(documentPath));
	}
	return getWorkspaceRelativeIdentity(documentPath);
}

/** Compare two paths using the Windows document identity contract. */
export function samePath(left: string, right: string, workspaceRoot?: string): boolean {
	return getDocumentIdentity(left, workspaceRoot) === getDocumentIdentity(right, workspaceRoot);
}

/** Convert a filesystem path to a standards-compliant Windows file URI. */
export function toFileUri(filePath: string): string {
	const absolutePath = normalizeDocumentPath(filePath);
	const slashPath = absolutePath.replace(/\\/g, "/");
	const parsedPath = windowsPath.parse(absolutePath);
	const uncMatch = parsedPath.root.startsWith("\\\\") ? /^\/\/([^/]+)(?:\/(.*))?$/u.exec(slashPath) : undefined;
	const url = new URL("file:///");
	if (uncMatch) {
		url.hostname = uncMatch[1];
		const segments = (uncMatch[2] ?? "").split("/").filter((segment) => segment !== "");
		url.pathname = `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
		return url.href;
	}
	const [drive, ...segments] = slashPath.split("/");
	url.pathname = `/${drive}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
	return url.href;
}

/** Convert a standards-compliant file URI to a canonical Windows path. */
export function fromFileUri(uri: string): string {
	if (typeof uri !== "string" || uri.trim() === "") throw new TypeError("file URI must be a non-empty string");
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch (cause) {
		throw new TypeError(`invalid file URI: ${String(cause)}`);
	}
	if (parsed.protocol !== "file:") throw new TypeError(`unsupported URI scheme: ${parsed.protocol}`);

	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(parsed.pathname);
	} catch (cause) {
		throw new TypeError(`invalid encoded file URI path: ${String(cause)}`);
	}
	if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") {
		return normalizeDocumentPath(`\\\\${parsed.hostname}${decodedPath.replace(/\//g, "\\")}`);
	}
	const windowsFilesystemPath = /^\/[A-Za-z]:[\\/]/u.test(decodedPath)
		? decodedPath.slice(1)
		: decodedPath.replace(/\//g, "\\");
	return normalizeDocumentPath(windowsFilesystemPath);
}
