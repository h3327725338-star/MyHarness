import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ChangeStore, type MutationPermit, newPermitId } from "../../src/changes/change-store.ts";
import { type BuiltChangeset, buildChangeset, type ModifiedFileChange } from "../../src/changes/changeset.ts";
import { ChangeExecutor, type ChangeExecutorOptions } from "../../src/changes/executor.ts";
import { decodeTextFile, sha256 } from "../../src/changes/text-file.ts";
import { getMutationQueueKey } from "../../src/tools/files/file-mutation-queue.ts";

export interface TestWorkspace {
	/** Real (canonical) workspace root. */
	readonly root: string;
	readonly storeRoot: string;
	abs(relativePath: string): string;
	read(relativePath: string): Buffer;
	readText(relativePath: string): string;
	write(relativePath: string, content: string | Uint8Array): void;
	dispose(): void;
}

const created: TestWorkspace[] = [];

export function createTestWorkspace(files: Readonly<Record<string, string | Uint8Array>> = {}): TestWorkspace {
	const base = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-changes-"));
	const root = realpathSync.native(base);
	// The change store lives outside the workspace, as it does in the data root.
	const storeRoot = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-changes-store-"));
	const workspace: TestWorkspace = {
		root,
		storeRoot,
		abs: (relativePath) => join(root, ...relativePath.split("/")),
		read: (relativePath) => readFileSync(join(root, ...relativePath.split("/"))),
		readText: (relativePath) => readFileSync(join(root, ...relativePath.split("/")), "utf8"),
		write(relativePath, content) {
			const target = join(root, ...relativePath.split("/"));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
			rmSync(storeRoot, { recursive: true, force: true });
		},
	};
	for (const [path, content] of Object.entries(files)) workspace.write(path, content);
	created.push(workspace);
	return workspace;
}

export function disposeTestWorkspaces(): void {
	for (const workspace of created.splice(0)) workspace.dispose();
}

/** A modify-change of one file to `afterText`, computed from the file as it is now. */
export async function modification(
	workspace: TestWorkspace,
	path: string,
	afterText: string,
): Promise<ModifiedFileChange> {
	const bytes = workspace.read(path);
	const decoded = decodeTextFile(bytes, path);
	return {
		path,
		absolutePath: workspace.abs(path),
		key: await getMutationQueueKey(workspace.abs(path)),
		baseHash: sha256(bytes),
		baseSize: bytes.length,
		format: { bom: decoded.bom, eol: decoded.eol },
		beforeText: decoded.text,
		afterText,
	};
}

export async function planOf(
	workspace: TestWorkspace,
	changes: Readonly<Record<string, string>>,
): Promise<BuiltChangeset> {
	return buildChangeset({
		workspaceRoot: workspace.root,
		description: "test change",
		source: "patch",
		modified: await Promise.all(Object.entries(changes).map(([path, text]) => modification(workspace, path, text))),
	});
}

export async function permitFor(
	store: ChangeStore,
	built: BuiltChangeset,
	overrides: Partial<MutationPermit> = {},
): Promise<MutationPermit> {
	const permit: MutationPermit = {
		version: 1,
		id: newPermitId(),
		changesetId: built.changeset.id,
		workspaceRoot: built.changeset.workspaceRoot,
		files: built.changeset.files.map((file) => ({
			path: file.path,
			baseHash: file.baseHash,
			afterHash: file.afterHash,
		})),
		approvedBy: "user",
		createdAt: Date.now(),
		expiresAt: Date.now() + 60_000,
		...overrides,
	};
	await store.savePermit(permit);
	return permit;
}

export function createExecutor(
	workspace: TestWorkspace,
	options: Partial<ChangeExecutorOptions> = {},
): { store: ChangeStore; executor: ChangeExecutor } {
	const store = new ChangeStore(workspace.storeRoot);
	const executor = new ChangeExecutor({ store, workspaceRoot: workspace.root, ...options });
	return { store, executor };
}
