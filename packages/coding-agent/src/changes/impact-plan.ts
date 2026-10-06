import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import type { ChangeStore } from "./change-store.ts";
import type { Changeset } from "./changeset.ts";
import { ChangeControlError } from "./errors.ts";
import { resolveScopedFile } from "./path-scope.ts";
import { sha256 } from "./text-file.ts";

export interface ImpactPlan {
	readonly problem: string;
	readonly expectedBehavior: string;
	readonly rootCause: string;
	readonly rootPaths: readonly string[];
	readonly evidence: readonly string[];
	readonly affected: readonly { path: string; disposition: "modify" | "unaffected" | "external"; reason: string }[];
	readonly compatibility: string;
	readonly checks: readonly string[];
	readonly coverage: "complete" | "partial" | "unknown";
	readonly limitations: readonly string[];
}

/** This is an evidence-bearing review, not proof that the model's root-cause judgment is correct. */
export class ImpactPlans {
	private readonly store: ChangeStore;
	constructor(store: ChangeStore) {
		this.store = store;
	}
	private path(id: string): string {
		if (!/^[0-9a-f]{32}$/.test(id)) throw new ChangeControlError("NOT_FOUND", "Invalid changeset id");
		return join(this.store.root, "impact-plans", `${id}.json`);
	}
	async save(changeset: Changeset, plan: ImpactPlan): Promise<void> {
		validateImpactPlan(plan);
		const modified = new Set(plan.affected.filter((item) => item.disposition === "modify").map((item) => item.path));
		if (changeset.files.some((file) => !modified.has(file.path)) || modified.size !== changeset.files.length) {
			throw new ChangeControlError(
				"PERMIT_REQUIRED",
				"Impact plan must account for exactly the previewed modified paths",
			);
		}
		await mkdir(join(this.store.root, "impact-plans"), { recursive: true });
		const evidenceFiles = await this.captureEvidence(changeset, plan);
		await writeFileAtomically(
			this.path(changeset.id),
			JSON.stringify({ version: 2, changesetId: changeset.id, plan, evidenceFiles }),
		);
	}
	async load(id: string): Promise<ImpactPlan | undefined> {
		let text: string;
		try {
			text = await readFile(this.path(id), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const record = JSON.parse(text);
		if (![1, 2].includes(record.version) || record.changesetId !== id) throw new Error("Invalid impact plan record");
		validateImpactPlan(record.plan);
		return record.plan;
	}
	private async captureEvidence(
		changeset: Changeset,
		plan: ImpactPlan,
	): Promise<readonly { path: string; hash: string | null }[]> {
		const paths = new Set([
			...plan.rootPaths,
			...plan.affected.filter((item) => item.disposition !== "external").map((item) => item.path),
		]);
		const evidence: { path: string; hash: string | null }[] = [];
		for (const path of paths) {
			const scoped = await resolveScopedFile(changeset.workspaceRoot, path);
			const proposed = changeset.files.find((file) => file.path === scoped.path);
			if (!scoped.exists && proposed?.operation !== "create")
				throw new ChangeControlError("PERMIT_REQUIRED", `Impact evidence file is missing: ${path}`);
			const hash = scoped.exists ? sha256(await readFile(scoped.absolutePath)) : null;
			if (proposed && hash !== proposed.baseHash)
				throw new ChangeControlError("EDIT_CONFLICT", `Impact preview is stale: ${path}`);
			evidence.push({ path: scoped.path, hash });
		}
		return evidence.sort((a, b) => a.path.localeCompare(b.path));
	}
	/** Legacy declaration-only reviews are readable but cannot authorize strict writes. */
	async assertFresh(changeset: Changeset): Promise<void> {
		const record = JSON.parse(await readFile(this.path(changeset.id), "utf8"));
		if (record.version !== 2 || !Array.isArray(record.evidenceFiles))
			throw new ChangeControlError("PERMIT_REQUIRED", "Impact review has no evidence snapshot; review it again");
		validateImpactPlan(record.plan);
		const current = await this.captureEvidence(changeset, record.plan);
		if (JSON.stringify(current) !== JSON.stringify(record.evidenceFiles))
			throw new ChangeControlError("EDIT_CONFLICT", "Impact evidence changed; repeat the review before applying");
	}
}

export function validateImpactPlan(value: unknown): asserts value is ImpactPlan {
	const plan = value as ImpactPlan | undefined;
	const text = (entry: unknown): boolean =>
		typeof entry === "string" && entry.trim().length > 0 && entry.length <= 8000;
	const list = (entry: unknown): entry is string[] =>
		Array.isArray(entry) && entry.length > 0 && entry.length <= 500 && entry.every(text);
	if (
		!plan ||
		!text(plan.problem) ||
		!text(plan.expectedBehavior) ||
		!text(plan.rootCause) ||
		!text(plan.compatibility) ||
		!list(plan.rootPaths) ||
		!list(plan.evidence) ||
		!list(plan.checks) ||
		!Array.isArray(plan.affected) ||
		plan.affected.length === 0 ||
		plan.affected.length > 500 ||
		!plan.affected.every(
			(item) =>
				item &&
				text(item.path) &&
				text(item.reason) &&
				["modify", "unaffected", "external"].includes(item.disposition),
		) ||
		new Set(plan.affected.map((item) => item.path)).size !== plan.affected.length ||
		!["complete", "partial", "unknown"].includes(plan.coverage) ||
		!Array.isArray(plan.limitations) ||
		!plan.limitations.every(text) ||
		(plan.coverage !== "complete" && plan.limitations.length === 0)
	) {
		throw new ChangeControlError(
			"INVALID_EDIT",
			"Impact plan requires root cause, evidence, affected-path decisions, compatibility, checks and honest coverage limitations",
		);
	}
}
