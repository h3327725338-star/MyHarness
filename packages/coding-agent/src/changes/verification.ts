import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import type { ChangeStore } from "./change-store.ts";
import { acquireProcessLocks } from "./process-lock.ts";
import type { ChangeGate, ChangeGateInput, ChangeGateVerdict } from "./service.ts";
import { sha256 } from "./text-file.ts";

export interface VerificationCheck {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly timeoutMs?: number;
}
export interface VerificationSettings {
	readonly enabled?: boolean;
	readonly checks?: readonly VerificationCheck[];
	readonly maxRepairAttempts?: number;
}
export interface VerificationResult {
	readonly state: "pending" | "verified" | "failed" | "unknown";
	readonly reason: string;
	readonly snapshot?: string;
	readonly checksHash?: string;
	readonly checks: readonly { name: string; code: number; output: string }[];
}
interface VerificationRecord {
	readonly version: 1;
	readonly changesetId: string;
	readonly files: readonly { path: string; hash: string }[];
	readonly baseline: VerificationResult;
	result: VerificationResult;
	verifiedSnapshot?: string;
	checksHash?: string;
}
export interface VerificationOptions {
	readonly store: ChangeStore;
	readonly workspaceRoot: string;
	readonly settings: () => VerificationSettings;
	/** Must cover source, project configuration and tests; an incomplete snapshot is unknown. */
	readonly snapshot: () => Promise<string | undefined>;
	/** A host-approved check, never an arbitrary command supplied by a tool call. */
	readonly run: (check: VerificationCheck, signal?: AbortSignal) => Promise<{ code: number; output: string }>;
}

/** Verification debt survives restart and is cleared only by checks on an unchanged workspace snapshot. */
export class ChangeVerification implements ChangeGate {
	readonly name = "change-verification-baseline";
	private readonly options: VerificationOptions;
	private baseline: VerificationResult | undefined;
	private baselineChecksHash: string | undefined;
	private repairPaths: Set<string> | undefined;
	private repairChecksHash: string | undefined;
	private repairPolicyHash: string | undefined;
	private taskChanges: Set<string> | undefined;
	/** User tasks start fresh; continuation rounds retain this scope and disk history. */
	beginTask(): void {
		this.taskChanges = new Set();
		this.baseline = undefined;
		this.baselineChecksHash = undefined;
		this.endRepair();
	}
	constructor(options: VerificationOptions) {
		this.options = options;
	}
	private path(id: string): string {
		if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid changeset id");
		return join(this.options.store.root, "verification", `${id}.json`);
	}
	private async save(record: VerificationRecord): Promise<void> {
		await mkdir(join(this.options.store.root, "verification"), { recursive: true });
		await writeFileAtomically(this.path(record.changesetId), JSON.stringify(record));
	}
	private async withRecordLock<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
		const held = await acquireProcessLocks([`verification-records:${this.options.store.root.toLowerCase()}`], {
			lockRoot: this.options.store.lockRoot,
			signal,
		});
		try {
			signal?.throwIfAborted();
			const result = await run();
			const compromised = held.compromised();
			if (compromised) throw compromised;
			return result;
		} finally {
			await held.release();
		}
	}
	async check(input: ChangeGateInput): Promise<ChangeGateVerdict> {
		return this.withRecordLock(input.signal, () => this.checkLocked(input));
	}
	private async checkLocked(input: ChangeGateInput): Promise<ChangeGateVerdict> {
		if (
			this.repairPaths &&
			input.changeset.files.some((file) =>
				/(^|\/)(test|tests|__tests__|\.github|\.myharness|system-prompts)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)(AGENTS\.md|CLAUDE\.md|package\.json|tsconfig[^/]*\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|Cargo\.toml|go\.(mod|sum)|pyproject\.toml|pytest\.ini|NuGet\.Config|[^/]+\.csproj|[^/]*config\.[^/]+)$/iu.test(
					file.path,
				),
			)
		) {
			return {
				allow: false,
				code: "PERMIT_REQUIRED",
				message:
					"Automatic repair cannot edit tests, check configuration, dependencies or policy files. Separate user review is required; do not weaken verification to make the repair pass.",
			};
		}
		if (
			this.repairPaths &&
			input.changeset.files.some((file) => !this.repairPaths?.has(file.absolutePath.toLowerCase()))
		) {
			return {
				allow: false,
				code: "PERMIT_REQUIRED",
				message:
					"Automatic repair may only change files in the original authorized changes. Ask the user before expanding scope.",
			};
		}
		if (
			this.repairPaths &&
			(this.repairChecksHash !== this.checksHash() || this.repairPolicyHash !== this.policyHash())
		) {
			return {
				allow: false,
				code: "PERMIT_REQUIRED",
				message:
					"Verification checks changed during automatic repair (commands, enablement or repair budget); reauthorize the repair before writing.",
			};
		}
		if (this.options.settings().enabled === false) return { allow: true };
		if (this.baselineChecksHash !== this.checksHash() || (await this.status()).state === "verified") {
			this.baseline = await this.execute(input.signal);
			this.baselineChecksHash = this.baseline.checksHash;
		}
		this.baseline ??= await this.execute(input.signal);
		if (input.mode === "strict" && this.baseline.state !== "verified") {
			return {
				allow: false,
				code: "PERMIT_REQUIRED",
				message: `Cannot establish a passing verification baseline: ${this.baseline.reason}`,
			};
		}
		this.taskChanges?.add(input.changeset.id);
		await this.save({
			version: 1,
			changesetId: input.changeset.id,
			files: input.changeset.files.map((file) => ({ path: file.absolutePath, hash: file.afterHash })),
			baseline: this.baseline,
			result: { state: "pending", reason: "Change has not been verified", checks: [] },
		});
		return { allow: true };
	}
	private async records(): Promise<VerificationRecord[]> {
		const directory = join(this.options.store.root, "verification");
		let names: string[];
		try {
			names = await readdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const journals = new Set(
			this.options.store
				.listJournals()
				.filter((journal) => journal.state === "committed")
				.map((journal) => journal.changesetId),
		);
		const records: VerificationRecord[] = [];
		for (const name of names) {
			if (!/^[0-9a-f]{32}\.json$/.test(name) || !journals.has(name.slice(0, -5))) continue;
			const record = JSON.parse(await readFile(join(directory, name), "utf8")) as VerificationRecord;
			if (record.version !== 1 || record.changesetId !== name.slice(0, -5))
				throw new Error("Invalid verification record");
			records.push(record);
		}
		return records;
	}
	private checksHash(): string {
		return sha256(Buffer.from(JSON.stringify(this.options.settings().checks ?? [])));
	}
	private policyHash(): string {
		const settings = this.options.settings();
		return sha256(
			JSON.stringify({
				enabled: settings.enabled,
				maxRepairAttempts: settings.maxRepairAttempts,
				checks: settings.checks ?? [],
			}),
		);
	}
	async beginRepair(currentTask = false): Promise<void> {
		this.repairChecksHash = this.checksHash();
		this.repairPolicyHash = this.policyHash();
		this.repairPaths = new Set(
			(await this.unresolvedRecords(currentTask)).flatMap((record) =>
				record.files.map((file) => file.path.toLowerCase()),
			),
		);
	}
	get repairing(): boolean {
		return this.repairPaths !== undefined;
	}
	endRepair(): void {
		this.repairPaths = undefined;
		this.repairChecksHash = undefined;
		this.repairPolicyHash = undefined;
	}
	private async scopedRecords(currentTask: boolean): Promise<VerificationRecord[]> {
		const records = await this.records();
		return currentTask ? records.filter((record) => this.taskChanges?.has(record.changesetId)) : records;
	}
	private async unresolvedRecords(currentTask = false): Promise<VerificationRecord[]> {
		const records = await this.scopedRecords(currentTask);
		if (records.length === 0) return [];
		let snapshot: string | undefined;
		try {
			snapshot = await this.options.snapshot();
		} catch {
			snapshot = undefined;
		}
		const checksHash = this.checksHash();
		return records.filter(
			(record) =>
				record.result.state !== "verified" ||
				snapshot === undefined ||
				record.verifiedSnapshot !== snapshot ||
				record.checksHash !== checksHash,
		);
	}
	async status(currentTask = false): Promise<VerificationResult> {
		const unresolved = await this.unresolvedRecords(currentTask);
		return unresolved.length === 0
			? { state: "verified", reason: "No outstanding controlled-change verification debt", checks: [] }
			: { state: "pending", reason: `${unresolved.length} committed change(s) require verification`, checks: [] };
	}
	async verify(signal?: AbortSignal, currentTask = false): Promise<VerificationResult> {
		return this.withRecordLock(signal, () => this.verifyLocked(signal, currentTask));
	}
	private async verifyLocked(signal: AbortSignal | undefined, currentTask: boolean): Promise<VerificationResult> {
		const records = await this.scopedRecords(currentTask);
		if (records.length === 0) return this.status(currentTask);
		let result = await this.execute(signal);
		// A failing pre-change baseline cannot prove the absence of new errors by comparing exit codes.
		if (result.state === "failed" && records.some((record) => record.baseline.state !== "verified")) {
			result = {
				...result,
				state: "unknown",
				reason: `Pre-change baseline was not passing; cannot attribute failures. ${result.reason}`,
			};
		}
		const snapshot = result.state === "verified" ? result.snapshot : undefined;
		if (result.state === "verified" && snapshot === undefined)
			result = { ...result, state: "unknown", reason: "Workspace snapshot became unavailable" };
		for (const record of records) {
			record.result = result;
			record.verifiedSnapshot = snapshot;
			record.checksHash = result.checksHash;
			await this.save(record);
		}
		return result;
	}
	private async execute(signal?: AbortSignal): Promise<VerificationResult> {
		const configured = this.options.settings().checks ?? [];
		const checksHash = this.checksHash();
		const policyHash = this.policyHash();
		if (configured.length === 0)
			return { state: "unknown", reason: "No approved project verification checks configured", checks: [] };
		const results: { name: string; code: number; output: string }[] = [];
		try {
			// Isolate this run from in-place settings mutation while awaiting a check.
			const checks = configured.map((check) => ({ ...check, args: [...check.args] }));
			const before = await this.options.snapshot();
			if (before === undefined)
				return { state: "unknown", reason: "Workspace snapshot coverage is incomplete", checks: [] };
			for (const check of checks) {
				if (signal?.aborted) throw new Error("Verification cancelled");
				if (
					!check.name ||
					!check.command ||
					!Array.isArray(check.args) ||
					check.args.some((arg) => typeof arg !== "string")
				)
					throw new Error("Invalid verification check configuration");
				const result = await this.options.run(check, signal);
				results.push({ name: check.name, code: result.code, output: result.output.slice(-12000) });
			}
			if (signal?.aborted) throw new Error("Verification cancelled");
			const after = await this.options.snapshot();
			if (signal?.aborted) throw new Error("Verification cancelled");
			if (
				after === undefined ||
				before !== after ||
				checksHash !== this.checksHash() ||
				policyHash !== this.policyHash()
			)
				return {
					state: "unknown",
					reason: "Workspace or verification policy changed during verification; checks are stale",
					checks: results,
				};
			return results.every((result) => result.code === 0)
				? {
						state: "verified",
						reason: "All configured checks passed on the same workspace snapshot",
						snapshot: after,
						checksHash,
						checks: results,
					}
				: { state: "failed", reason: "One or more configured checks failed", checks: results };
		} catch (error) {
			return { state: "unknown", reason: error instanceof Error ? error.message : String(error), checks: results };
		}
	}
}

/** Unknown/custom tools are denied rather than guessing whether their commands can write. Not an OS sandbox. */
export function strictToolAllowed(name: string, trustedBuiltIn: boolean): boolean {
	return trustedBuiltIn && new Set(["read", "grep", "find", "ls", "symbols", "edit", "write", "refactor"]).has(name);
}

export function verificationSnapshot(files: readonly { path: string; hash: string }[]): string {
	return sha256(Buffer.from(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)))));
}
