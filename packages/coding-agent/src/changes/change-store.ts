/**
 * On-disk state of controlled changes, below one workspace's change-control root:
 *
 *   changesets/<id>/changeset.json, after/<n>.bin, diffs/<n>.diff   what was planned and previewed
 *   journals/<id>.json, journals/<id>/before/<n>.bin                what an apply attempt did, with before images
 *   permits/<id>.json, permits/<id>.used                            approvals bound to a changeset, one use each
 *   locks/                                                           cross-process lock directories
 *
 * Plans, approvals and journals are separate files on purpose: a journal must survive a crash and be readable
 * without the plan, and an approval is never inferred from a plan. Source text lives only in `after/`, `before/`
 * and `diffs/`, never in Session messages. Ids come from callers (the model), so every id is checked before it
 * becomes a path.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import type { BuiltChangeset, ChangeOperation, Changeset } from "./changeset.ts";
import { ChangeControlError } from "./errors.ts";
import { sha256 } from "./text-file.ts";

const SCHEMA_VERSION = 1;
const CHANGESET_ID = /^[0-9a-f]{32}$/;
const PERMIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type JournalEntryState = "pending" | "committed" | "restored" | "conflict";

export interface JournalEntry {
	readonly index: number;
	readonly path: string;
	readonly absolutePath: string;
	readonly key: string;
	readonly operation: ChangeOperation;
	/** Hash before the change; null for a file the change creates. */
	readonly beforeHash: string | null;
	readonly afterHash: string;
	state: JournalEntryState;
}

export type JournalState = "applying" | "committed" | "rolled_back" | "recovery_conflict";

export interface Journal {
	readonly version: number;
	readonly changesetId: string;
	readonly workspaceRoot: string;
	readonly owner: { readonly pid: number; readonly startedAt: number };
	state: JournalState;
	updatedAt: number;
	readonly entries: JournalEntry[];
	/** What went wrong, for a journal that did not commit. */
	note?: string;
}

export interface MutationPermit {
	readonly version: number;
	readonly id: string;
	readonly changesetId: string;
	readonly workspaceRoot: string;
	readonly files: ReadonlyArray<{
		readonly path: string;
		readonly baseHash: string | null;
		readonly afterHash: string;
	}>;
	readonly approvedBy: "user" | "policy";
	readonly reason?: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

function requireId(value: string, pattern: RegExp, what: string): string {
	if (!pattern.test(value)) throw new ChangeControlError("NOT_FOUND", `${what} is not a valid id`);
	return value;
}

export function newPermitId(): string {
	return randomUUID();
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export class ChangeStore {
	readonly root: string;
	private readonly lockDirectory: string;

	/**
	 * `lockRoot` may be shared by several workspaces (a data root's lock directory), so overlapping workspaces
	 * still exclude each other; by default the locks live beside the rest of this workspace's state.
	 */
	constructor(root: string, options: { readonly lockRoot?: string } = {}) {
		this.root = root;
		this.lockDirectory = options.lockRoot ?? join(root, "locks");
	}

	get lockRoot(): string {
		return this.lockDirectory;
	}

	private dir(...parts: string[]): string {
		const path = join(this.root, ...parts);
		mkdirSync(path, { recursive: true });
		return path;
	}

	// --- changesets -------------------------------------------------------------------------------------------

	private changesetDir(id: string): string {
		return join(this.root, "changesets", requireId(id, CHANGESET_ID, "changeset id"));
	}

	async saveChangeset(built: BuiltChangeset): Promise<void> {
		const base = this.dir("changesets", requireId(built.changeset.id, CHANGESET_ID, "changeset id"));
		mkdirSync(join(base, "after"), { recursive: true });
		mkdirSync(join(base, "diffs"), { recursive: true });
		for (const [index, file] of built.changeset.files.entries()) {
			const after = built.content.after.get(file.path);
			if (!after) throw new Error(`changeset ${built.changeset.id} has no content for ${file.path}`);
			await writeFileAtomically(join(base, "after", `${index}.bin`), after);
			await writeFileAtomically(join(base, "diffs", `${index}.diff`), built.content.diffs.get(file.path) ?? "");
		}
		await writeFileAtomically(
			join(base, "changeset.json"),
			JSON.stringify({ version: SCHEMA_VERSION, changeset: built.changeset }),
		);
	}

	/** Forget a previewed changeset (its plan, after images and diffs). Journals and permits are left alone. */
	removeChangeset(id: string): void {
		rmSync(this.changesetDir(id), { recursive: true, force: true });
	}

	/** The stored changeset with its after images, each checked against the hash the plan recorded. */
	async loadChangeset(id: string): Promise<BuiltChangeset | undefined> {
		const base = this.changesetDir(id);
		let changeset: Changeset;
		try {
			const stored = JSON.parse(await readFile(join(base, "changeset.json"), "utf8")) as {
				version?: number;
				changeset?: Changeset;
			};
			if (stored.version !== SCHEMA_VERSION || !stored.changeset) {
				throw new ChangeControlError("NOT_FOUND", `changeset ${id} was stored by an incompatible version`);
			}
			changeset = stored.changeset;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		const after = new Map<string, Buffer>();
		const diffs = new Map<string, string>();
		for (const [index, file] of changeset.files.entries()) {
			const bytes = await readFile(join(base, "after", `${index}.bin`));
			if (sha256(bytes) !== file.afterHash) {
				throw new ChangeControlError("INVALID_EDIT", `stored content of ${file.path} does not match its plan`, {
					paths: [file.path],
				});
			}
			after.set(file.path, bytes);
			diffs.set(file.path, await readFile(join(base, "diffs", `${index}.diff`), "utf8").catch(() => ""));
		}
		return { changeset, content: { after, diffs } };
	}

	// --- journals ---------------------------------------------------------------------------------------------

	private journalPath(id: string): string {
		return join(this.root, "journals", `${requireId(id, CHANGESET_ID, "changeset id")}.json`);
	}

	private beforePath(id: string, index: number): string {
		return join(this.root, "journals", requireId(id, CHANGESET_ID, "changeset id"), "before", `${index}.bin`);
	}

	async writeJournal(journal: Journal): Promise<void> {
		this.dir("journals");
		journal.updatedAt = Date.now();
		await writeFileAtomically(this.journalPath(journal.changesetId), JSON.stringify(journal));
	}

	readJournal(id: string): Journal | undefined {
		try {
			const journal = JSON.parse(readFileSync(this.journalPath(id), "utf8")) as Journal;
			return journal.version === SCHEMA_VERSION ? journal : undefined;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	listJournals(): Journal[] {
		const directory = join(this.root, "journals");
		if (!existsSync(directory)) return [];
		const journals: Journal[] = [];
		for (const name of readdirSync(directory)) {
			const match = /^([0-9a-f]{32})\.json$/.exec(name);
			if (!match) continue;
			const journal = this.readJournal(match[1] as string);
			if (journal) journals.push(journal);
		}
		return journals;
	}

	async writeBefore(id: string, index: number, bytes: Uint8Array): Promise<void> {
		mkdirSync(join(this.root, "journals", requireId(id, CHANGESET_ID, "changeset id"), "before"), {
			recursive: true,
		});
		await writeFileAtomically(this.beforePath(id, index), bytes);
	}

	async readBefore(id: string, index: number): Promise<Buffer> {
		return readFile(this.beforePath(id, index));
	}

	removeBefore(id: string): void {
		rmSync(join(this.root, "journals", requireId(id, CHANGESET_ID, "changeset id")), {
			recursive: true,
			force: true,
		});
	}

	// --- permits ----------------------------------------------------------------------------------------------

	private permitPath(id: string, suffix: "json" | "used"): string {
		return join(this.root, "permits", `${requireId(id, PERMIT_ID, "permit id")}.${suffix}`);
	}

	async savePermit(permit: MutationPermit): Promise<void> {
		this.dir("permits");
		await writeFileAtomically(this.permitPath(permit.id, "json"), JSON.stringify(permit));
	}

	loadPermit(id: string): MutationPermit | undefined {
		try {
			const permit = JSON.parse(readFileSync(this.permitPath(id, "json"), "utf8")) as MutationPermit;
			return permit.version === SCHEMA_VERSION ? permit : undefined;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	permitUsed(id: string): boolean {
		return existsSync(this.permitPath(id, "used"));
	}

	/** Mark a permit used. Exactly one caller wins, even across processes; the others get false. */
	async consumePermit(id: string): Promise<boolean> {
		this.dir("permits");
		try {
			const handle = await open(this.permitPath(id, "used"), "wx");
			await handle.close();
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	}

	/** Give the one use of a permit back (the apply failed before it changed anything). */
	releasePermit(id: string): void {
		rmSync(this.permitPath(id, "used"), { force: true });
	}
}

export const CHANGE_STORE_SCHEMA_VERSION = SCHEMA_VERSION;
