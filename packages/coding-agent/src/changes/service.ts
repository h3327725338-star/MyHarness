/**
 * ChangeControl: the one owner of controlled changes for a workspace.
 *
 * A change is previewed first (decoded and verified, saved with its exact result, diffed) and applied later by
 * its id: the preview is what gets written, nothing else. Applying runs the gates, asks the policy or the person
 * for approval, mints a permit bound to that exact change, and hands it to the executor, which writes under the
 * locks that every other writer in this process and in other processes shares.
 *
 * What other parts of the product hook in here, so this module depends on none of them:
 *   gates       refuse a change before it is approved (reuse review, strict-mode rules)
 *   approval    a way to ask the person (the host's UI)
 *   onCommitted what to do after a change is on disk (tell language servers, refresh the index, record the debt)
 *               — called while the files are still locked, so a listener must not start another change.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocumentIdentity } from "../symbols/path-semantics.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { type ApprovalPort, assessChangeRisk, type ChangeRisk, describeChangeset } from "./approval.ts";
import { type ChangeStore, type Journal, type MutationPermit, newPermitId } from "./change-store.ts";
import {
	type BuiltChangeset,
	buildChangeset,
	type Changeset,
	type ChangesetContent,
	modifiedFromDecoded,
} from "./changeset.ts";
import { ChangeControlError, type ChangeErrorCode } from "./errors.ts";
import {
	type ApplyResult,
	ChangeExecutor,
	type ChangeExecutorOptions,
	type ChangeFs,
	type RecoveryReport,
} from "./executor.ts";
import { type ImpactPlan, ImpactPlans } from "./impact-plan.ts";
import { type ChangeControlMode, DEFAULT_CHANGE_CONTROL_MODE } from "./mode.ts";
import { type PatchChange, planPatch } from "./patch-plan.ts";
import { resolveScopedFile } from "./path-scope.ts";
import { verifyRenameEdits } from "./rename-check.ts";
import { decodeTextFile, sha256 } from "./text-file.ts";
import { decodeWorkspaceEdit } from "./workspace-edit.ts";

export interface ChangeOrigin {
	readonly kind: "refactor" | "edit" | "write" | "server-edit";
	readonly sessionId?: string;
	readonly toolCallId?: string;
}

export interface ChangeCommitted {
	readonly changeset: Changeset;
	readonly origin: ChangeOrigin;
	readonly approvedBy: "user" | "policy";
}

export interface ChangeGateInput {
	readonly changeset: Changeset;
	readonly content: ChangesetContent;
	readonly origin: ChangeOrigin;
	readonly mode: ChangeControlMode;
	readonly impactPlan?: ImpactPlan;
	readonly signal?: AbortSignal;
}

export type ChangeGateVerdict =
	| { readonly allow: true; readonly evidence?: unknown }
	| {
			readonly allow: false;
			readonly code: ChangeErrorCode;
			readonly message: string;
			readonly paths?: readonly string[];
			readonly userException?: { readonly snapshot: string; readonly scope: readonly string[] };
	  };

/** A rule a change must pass before it may be approved. Gates do not run when change control is off. */
export interface ChangeGate {
	readonly name: string;
	readonly recheckAfterApproval?: boolean;
	check(input: ChangeGateInput): Promise<ChangeGateVerdict>;
}

export interface ChangeControlOptions {
	readonly workspaceRoot: string;
	readonly store: ChangeStore;
	readonly mode?: () => ChangeControlMode;
	readonly approval?: ApprovalPort;
	readonly gates?: readonly ChangeGate[];
	readonly lock?: ChangeExecutorOptions["lock"];
	readonly fs?: ChangeFs;
	/** How long a permit stays valid after approval (default 5 minutes). */
	readonly permitTtlMs?: number;
	readonly now?: () => number;
}

export interface ChangePreview {
	readonly changeset: Changeset;
	/** Unified diff per path. */
	readonly diffs: ReadonlyMap<string, string>;
	readonly risk: ChangeRisk;
}

export interface WorkspaceEditPreviewOptions {
	readonly description: string;
	readonly source?: Changeset["source"];
	/** Absolute path to the version the client holds open (see documentVersionLookup). */
	readonly knownVersion?: (absolutePath: string) => number | undefined;
	/** Check full-name ranges against disk; minimal edits must reconstruct both names uniquely. */
	readonly rename?: { readonly oldName: string; readonly newName?: string };
}

export interface ApplyChangeOptions {
	readonly origin: ChangeOrigin;
	readonly signal?: AbortSignal;
}

export interface ApplyOutcome {
	readonly changeset: Changeset;
	readonly result: ApplyResult;
	readonly approvedBy: "user" | "policy";
}

export type ChangeLifecycle = "previewed" | Journal["state"];

export interface ChangeStatusEntry {
	readonly id: string;
	readonly state: ChangeLifecycle;
	readonly files: readonly string[];
	readonly description?: string;
	readonly note?: string;
	readonly updatedAt?: number;
}

/** A request for the client to apply an edit a language server asked for (workspace/applyEdit). */
export interface ServerEditRequest {
	readonly label: string | undefined;
	readonly edit: unknown;
	readonly definitionId: string;
	readonly workspaceRoot: string;
	readonly documentVersions: Readonly<Record<string, number>>;
	readonly signal: AbortSignal;
}

export interface ServerEditResponse {
	readonly applied: boolean;
	readonly failureReason?: string;
}

/** Someone has decided that the next edit from this server may be considered; it is checked and approved like any change. */
export interface ServerEditWindow {
	readonly label: string;
	readonly origin: ChangeOrigin;
	/** Only this server's edits are considered; undefined accepts any server. */
	readonly definitionId?: string;
}

export const DEFAULT_PERMIT_TTL_MS = 5 * 60_000;

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Look up the version a client holds for a document, whichever way the path is spelled. */
export function documentVersionLookup(
	versions: Readonly<Record<string, number>>,
	workspaceRoot: string,
): (absolutePath: string) => number | undefined {
	const byIdentity = new Map<string, number>();
	for (const [path, version] of Object.entries(versions)) {
		byIdentity.set(getDocumentIdentity(path, workspaceRoot), version);
	}
	return (absolutePath) => byIdentity.get(getDocumentIdentity(absolutePath, workspaceRoot));
}

export class ChangeControl {
	readonly workspaceRoot: string;
	readonly store: ChangeStore;
	readonly impactPlans: ImpactPlans;
	verification?: import("./verification.ts").ChangeVerification;
	private readonly options: ChangeControlOptions;
	private readonly executor: ChangeExecutor;
	private readonly listeners = new Set<(event: ChangeCommitted) => void | Promise<void>>();
	private readonly inFlight = new Map<string, Pick<ChangeCommitted, "origin" | "approvedBy">>();
	private readonly windows = new Set<ServerEditWindow>();
	private recovery: Promise<readonly RecoveryReport[]> | undefined;
	private recoveryFailure: string | undefined;

	constructor(options: ChangeControlOptions) {
		this.options = options;
		this.workspaceRoot = options.workspaceRoot;
		this.store = options.store;
		this.impactPlans = new ImpactPlans(options.store);
		this.executor = new ChangeExecutor({
			store: options.store,
			workspaceRoot: options.workspaceRoot,
			fs: options.fs,
			lock: options.lock,
			onCommitted: (changeset) => this.notifyCommitted(changeset),
		});
	}

	async reviewImpact(changesetId: string, plan: ImpactPlan): Promise<void> {
		const built = await this.store.loadChangeset(changesetId);
		if (!built) throw new ChangeControlError("NOT_FOUND", "Preview the change before reviewing its impact");
		await this.impactPlans.save(built.changeset, plan);
	}

	get mode(): ChangeControlMode {
		return this.options.mode?.() ?? DEFAULT_CHANGE_CONTROL_MODE;
	}

	/** Roll back what an earlier crash left unfinished. Runs once, before the first change of this process. */
	ready(): Promise<readonly RecoveryReport[]> {
		this.recovery ??= this.executor.recover().catch((error: unknown) => {
			this.recoveryFailure = describe(error);
			return [];
		});
		return this.recovery;
	}

	onCommitted(listener: (event: ChangeCommitted) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// --- preview ----------------------------------------------------------------------------------------------

	async previewWorkspaceEdit(raw: unknown, options: WorkspaceEditPreviewOptions): Promise<ChangePreview> {
		await this.ready();
		const decoded = await decodeWorkspaceEdit(raw, {
			workspaceRoot: this.workspaceRoot,
			knownVersion: options.knownVersion,
		});
		if (decoded.files.length === 0) {
			throw new ChangeControlError("INVALID_EDIT", "the edit changes nothing");
		}
		if (options.rename) verifyRenameEdits(decoded.files, options.rename.oldName, options.rename.newName);
		return this.keep(
			buildChangeset({
				workspaceRoot: this.workspaceRoot,
				description: options.description,
				source: options.source ?? "workspace-edit",
				modified: decoded.files.map(modifiedFromDecoded),
				needsConfirmation: decoded.needsConfirmation,
				now: this.options.now?.(),
			}),
		);
	}

	async previewPatch(
		changes: readonly PatchChange[],
		options: { readonly description: string },
	): Promise<ChangePreview> {
		await this.ready();
		return this.keep(
			await planPatch(changes, { workspaceRoot: this.workspaceRoot, description: options.description }),
		);
	}

	/** Keep an already built changeset so it can be applied by id. */
	async keep(built: BuiltChangeset): Promise<ChangePreview> {
		await this.store.saveChangeset(built);
		return { changeset: built.changeset, diffs: built.content.diffs, risk: assessChangeRisk(built.changeset) };
	}

	/** Plan an explicit full-file write, including overwrites. The executor still compares the original hash. */
	async previewWrite(path: string, text: string): Promise<ChangePreview> {
		await this.ready();
		const scoped = await resolveScopedFile(this.workspaceRoot, path);
		if (!scoped.exists)
			return this.keep(
				buildChangeset({
					workspaceRoot: this.workspaceRoot,
					description: `Write ${scoped.path}`,
					source: "write-tool",
					created: [{ ...scoped, text }],
				}),
			);
		const bytes = await readFile(scoped.absolutePath);
		const decoded = decodeTextFile(bytes, scoped.path);
		return this.keep(
			buildChangeset({
				workspaceRoot: this.workspaceRoot,
				description: `Write ${scoped.path}`,
				source: "write-tool",
				modified: [
					{
						...scoped,
						baseHash: sha256(bytes),
						baseSize: bytes.length,
						format: { bom: undefined, eol: undefined },
						beforeText: decoded.text,
						afterText: text,
					},
				],
			}),
		);
	}

	// --- apply ------------------------------------------------------------------------------------------------

	async apply(changesetId: string, options: ApplyChangeOptions): Promise<ApplyOutcome> {
		await this.ready();
		const built = await this.store.loadChangeset(changesetId);
		if (!built) throw new ChangeControlError("NOT_FOUND", `no stored change ${changesetId}; preview it again`);
		const { changeset, content } = built;
		const impactPlan = this.mode === "strict" ? await this.impactPlans.load(changeset.id) : undefined;
		const gateInput: ChangeGateInput = {
			changeset,
			content,
			origin: options.origin,
			mode: this.mode,
			impactPlan,
			signal: options.signal,
		};

		const exceptions = new Map<ChangeGate, { snapshot: string; scope: readonly string[]; approvedAt: number }>();
		if (this.mode !== "off") {
			for (const gate of [...(this.options.gates ?? []), ...(this.verification ? [this.verification] : [])]) {
				await this.requireGate(gate, gateInput, exceptions);
			}
		}
		if (this.mode === "strict") {
			const plan = await this.impactPlans.load(changeset.id);
			if (!plan || plan.coverage !== "complete") {
				throw new ChangeControlError(
					"PERMIT_REQUIRED",
					"Strict changes require an exact-preview root/impact plan with complete declared coverage; missing or uncertain coverage is not approval",
				);
			}
		}
		if (this.mode === "strict") await this.assertImpactReviewUnchanged(changeset, impactPlan);
		const risk = assessChangeRisk(changeset);
		const approval = await this.approve(changeset, risk, options.signal);
		const approvedBy = exceptions.size > 0 ? "user" : approval;
		if (this.mode === "strict") await this.assertImpactReviewUnchanged(changeset, impactPlan);
		if (this.mode !== "off") {
			for (const gate of this.options.gates ?? []) {
				if (gate.recheckAfterApproval || exceptions.has(gate)) await this.requireGate(gate, gateInput, exceptions);
			}
		}
		if (this.mode === "strict") await this.assertImpactReviewUnchanged(changeset, impactPlan);
		options.signal?.throwIfAborted();

		const now = this.options.now?.() ?? Date.now();
		const permit: MutationPermit = {
			version: 1,
			id: newPermitId(),
			changesetId: changeset.id,
			workspaceRoot: changeset.workspaceRoot,
			files: changeset.files.map((file) => ({
				path: file.path,
				baseHash: file.baseHash,
				afterHash: file.afterHash,
			})),
			approvedBy,
			...(risk.level === "needs_user" ? { reason: risk.reasons.join("; ") } : {}),
			createdAt: now,
			expiresAt: now + (this.options.permitTtlMs ?? DEFAULT_PERMIT_TTL_MS),
		};
		await this.store.savePermit(permit);

		this.inFlight.set(changeset.id, { origin: options.origin, approvedBy });
		try {
			const result = await this.executor.apply(changeset.id, { permitId: permit.id, signal: options.signal, now });
			return { changeset, result, approvedBy };
		} finally {
			this.inFlight.delete(changeset.id);
		}
	}

	private async assertImpactReviewUnchanged(changeset: Changeset, expected: ImpactPlan | undefined): Promise<void> {
		if (JSON.stringify(await this.impactPlans.load(changeset.id)) !== JSON.stringify(expected))
			throw new ChangeControlError(
				"EDIT_CONFLICT",
				"Impact plan changed during apply; repeat review and approval before writing",
			);
		await this.impactPlans.assertFresh(changeset);
	}

	private async requireGate(
		gate: ChangeGate,
		input: ChangeGateInput,
		exceptions: Map<ChangeGate, { snapshot: string; scope: readonly string[]; approvedAt: number }>,
	): Promise<void> {
		input.signal?.throwIfAborted();
		let verdict = await gate.check(input);
		const accepted = exceptions.get(gate);
		if (accepted) {
			const elapsed = (this.options.now?.() ?? Date.now()) - accepted.approvedAt;
			if (
				verdict.allow ||
				verdict.userException?.snapshot !== accepted.snapshot ||
				JSON.stringify(verdict.userException.scope) !== JSON.stringify(accepted.scope) ||
				elapsed < 0 ||
				elapsed > (this.options.permitTtlMs ?? DEFAULT_PERMIT_TTL_MS)
			)
				throw new ChangeControlError("REUSE_REVIEW_REQUIRED", "Reuse exception changed or expired after approval");
			verdict = { allow: true, evidence: { approvedBy: "user", exception: accepted, reason: verdict.message } };
		}
		if (!verdict.allow && verdict.userException && this.options.approval) {
			const candidate = verdict;
			const binding = verdict.userException;
			const startedAt = this.options.now?.() ?? Date.now();
			const decision = await this.options.approval.request(
				{
					title: "Review reuse exception",
					message: `${verdict.message}\n\nAccept only after comparing source and contracts and determining reuse is unsuitable. This exception covers only this preview and source snapshot.\nScope: ${binding.scope.join(", ")}\nSnapshot: ${binding.snapshot}\n\n${describeChangeset(input.changeset)}`,
					changeset: input.changeset,
					risk: { level: "needs_user", reasons: [verdict.message] },
				},
				{ signal: input.signal },
			);
			input.signal?.throwIfAborted();
			if (!decision.approved) throw new ChangeControlError(candidate.code, decision.reason);
			const fresh = await gate.check(input);
			const elapsed = (this.options.now?.() ?? Date.now()) - startedAt;
			if (
				fresh.allow ||
				fresh.code !== candidate.code ||
				fresh.message !== candidate.message ||
				fresh.userException?.snapshot !== binding.snapshot ||
				JSON.stringify(fresh.userException.scope) !== JSON.stringify(binding.scope) ||
				elapsed < 0 ||
				elapsed > (this.options.permitTtlMs ?? DEFAULT_PERMIT_TTL_MS)
			)
				throw new ChangeControlError(
					candidate.code,
					"Reuse review changed or expired during approval; review current candidates again",
				);
			const approvedAt = this.options.now?.() ?? Date.now();
			exceptions.set(gate, { ...binding, approvedAt });
			verdict = {
				allow: true,
				evidence: { approvedBy: "user", exception: binding, reason: candidate.message, approvedAt },
			};
		}
		if (verdict.allow && verdict.evidence !== undefined) {
			const directory = join(this.store.root, "gate-evidence");
			await mkdir(directory, { recursive: true });
			await writeFileAtomically(
				join(directory, `${input.changeset.id}-${sha256(gate.name)}.json`),
				JSON.stringify({
					version: 1,
					changesetId: input.changeset.id,
					gate: gate.name,
					files: input.changeset.files.map((file) => ({
						path: file.path,
						baseHash: file.baseHash,
						afterHash: file.afterHash,
					})),
					evidence: verdict.evidence,
				}),
			);
		}
		if (!verdict.allow)
			throw new ChangeControlError(verdict.code, verdict.message, {
				paths: verdict.paths ? [...verdict.paths] : undefined,
			});
	}

	private async approve(
		changeset: Changeset,
		risk: ChangeRisk,
		signal: AbortSignal | undefined,
	): Promise<"user" | "policy"> {
		if (risk.level === "low" || this.mode === "off") return "policy";
		const port = this.options.approval;
		if (!port) {
			throw new ChangeControlError(
				"PERMIT_REQUIRED",
				`this change needs the user's approval and nobody can be asked here: ${risk.reasons.join("; ")}`,
			);
		}
		const decision = await port.request(
			{
				title: "Apply this change?",
				message: `${describeChangeset(changeset)}\n\nIt needs your approval because it ${risk.reasons.join("; ")}.`,
				changeset,
				risk,
			},
			{ signal },
		);
		if (!decision.approved) {
			throw new ChangeControlError("PERMIT_REQUIRED", `the user did not approve this change: ${decision.reason}`);
		}
		return "user";
	}

	private async notifyCommitted(changeset: Changeset): Promise<void> {
		const context = this.inFlight.get(changeset.id) ?? {
			origin: { kind: "refactor" as const },
			approvedBy: "policy" as const,
		};
		const failures: string[] = [];
		for (const listener of [...this.listeners]) {
			try {
				await listener({ changeset, ...context });
			} catch (error) {
				failures.push(describe(error));
			}
		}
		if (failures.length > 0) throw new Error(failures.join("; "));
	}

	/** Drop a preview that will not be applied. A change that is being applied or could not be undone is kept. */
	discard(changesetId: string): void {
		const journal = this.store.readJournal(changesetId);
		if (journal && (journal.state === "applying" || journal.state === "recovery_conflict")) {
			throw new ChangeControlError(
				"RECOVERY_CONFLICT",
				`change ${changesetId} is unfinished and cannot be discarded`,
			);
		}
		this.store.removeChangeset(changesetId);
	}

	// --- recovery and status ----------------------------------------------------------------------------------

	/** Try again to finish the unfinished changes of this workspace, and report what became of each. */
	async recover(): Promise<RecoveryReport[]> {
		await this.ready();
		return this.executor.recover();
	}

	/** One change by id, or the unfinished and the most recent ones. */
	status(changesetId?: string): { readonly entries: readonly ChangeStatusEntry[]; readonly recoveryFailure?: string } {
		const failure = this.recoveryFailure === undefined ? {} : { recoveryFailure: this.recoveryFailure };
		if (changesetId !== undefined) {
			const journal = this.store.readJournal(changesetId);
			if (journal) return { entries: [journalEntry(journal)], ...failure };
			return { entries: [{ id: changesetId, state: "previewed", files: [] }], ...failure };
		}
		const journals = this.store
			.listJournals()
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, 20);
		return { entries: journals.map(journalEntry), ...failure };
	}

	// --- edits that language servers ask for ------------------------------------------------------------------

	/**
	 * Allow the next workspace/applyEdit of a server while a flow that runs one of its commands is waiting. The
	 * edit is previewed and applied like any other change; the caller must not hold any change lock meanwhile.
	 */
	openServerEditWindow(window: ServerEditWindow): { close(): void } {
		this.windows.add(window);
		return {
			close: () => {
				this.windows.delete(window);
			},
		};
	}

	/** The answer to a server's workspace/applyEdit: refused unless a window allows it, else what really happened. */
	async handleServerEdit(request: ServerEditRequest): Promise<ServerEditResponse> {
		const window = [...this.windows].find(
			(candidate) => candidate.definitionId === undefined || candidate.definitionId === request.definitionId,
		);
		if (!window) {
			return {
				applied: false,
				failureReason: "no change the user authorized is waiting for an edit from this server",
			};
		}
		try {
			const preview = await this.previewWorkspaceEdit(request.edit, {
				description: request.label ?? window.label,
				source: "workspace-edit",
				knownVersion: documentVersionLookup(request.documentVersions, this.workspaceRoot),
			});
			await this.apply(preview.changeset.id, { origin: window.origin, signal: request.signal });
			return { applied: true };
		} catch (error) {
			return { applied: false, failureReason: describe(error) };
		}
	}
}

function journalEntry(journal: Journal): ChangeStatusEntry {
	return {
		id: journal.changesetId,
		state: journal.state,
		files: journal.entries.map((entry) => entry.path),
		...(journal.note === undefined ? {} : { note: journal.note }),
		updatedAt: journal.updatedAt,
	};
}
