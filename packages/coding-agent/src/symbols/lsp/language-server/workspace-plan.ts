/**
 * Server selection for workspace-level requests (no source file to pick a server from).
 *
 * The old behavior picked the single highest-priority definition of the whole registry, which let an
 * unrelated installed server (for example clangd) answer for a TypeScript workspace and return an
 * empty "semantic" result. The plan below selects servers from the languages that are actually present
 * in the workspace and makes the choice, the skipped candidates and the limits visible.
 */

import { isDataLanguage } from "../../index/workspace-inventory.ts";
import { discoverExecutable } from "./discovery.ts";
import {
	LanguageServerDefinitionNotFoundError,
	NoLanguageServerRegisteredError,
	UnsupportedLanguageError,
} from "./errors.ts";
import type { LanguageServerRegistry } from "./registry.ts";
import { normalizeLanguageId } from "./registry.ts";
import type { LanguageServerDefinition } from "./types.ts";

export const DEFAULT_MAX_WORKSPACE_SERVERS = 3;

export interface WorkspaceServerPlanOptions {
	readonly workspaceRoot: string;
	/** Explicit language: only candidates of that language are considered. */
	readonly language?: string;
	/** Explicit definition: strictly this server and nothing else. */
	readonly definitionId?: string;
	/** Languages found in the workspace, most files first. Absent when no inventory is available. */
	readonly languages?: readonly string[];
	readonly maxServers?: number;
}

export interface PlannedWorkspaceServer {
	readonly definition: LanguageServerDefinition;
	/** Present languages (or the requested one) this server answers for. */
	readonly languages: readonly string[];
	readonly discovered: boolean;
}

export interface SkippedWorkspaceServer {
	readonly definitionId?: string;
	readonly language?: string;
	readonly reason: string;
	/** True when skipping this candidate leaves part of the workspace unqueried (a coverage gap). */
	readonly affectsCoverage: boolean;
}

export interface WorkspaceServerPlan {
	readonly mode: "explicit-definition" | "explicit-language" | "inventory" | "unranked";
	readonly selected: readonly PlannedWorkspaceServer[];
	readonly skipped: readonly SkippedWorkspaceServer[];
}

function pickPreferred(
	candidates: readonly LanguageServerDefinition[],
	workspaceRoot: string,
): { definition: LanguageServerDefinition; discovered: boolean } | undefined {
	let first: { definition: LanguageServerDefinition; discovered: boolean } | undefined;
	for (const definition of candidates) {
		const discovered = discoverExecutable(definition.command, workspaceRoot).discovered;
		first ??= { definition, discovered };
		if (discovered) return { definition, discovered };
	}
	return first;
}

export function planWorkspaceServers(
	registry: LanguageServerRegistry,
	options: WorkspaceServerPlanOptions,
): WorkspaceServerPlan {
	const maxServers = Math.max(1, Math.floor(options.maxServers ?? DEFAULT_MAX_WORKSPACE_SERVERS));
	const language = options.language === undefined ? undefined : normalizeLanguageId(options.language);

	if (options.definitionId !== undefined) {
		const definitionId = options.definitionId.trim();
		const definition = registry.get(definitionId);
		if (!definition) throw new LanguageServerDefinitionNotFoundError(definitionId);
		if (language !== undefined && !definition.languages.includes(language)) {
			throw new UnsupportedLanguageError(`language server definition does not support language "${language}"`, {
				definitionId: definition.id,
				language,
			});
		}
		return {
			mode: "explicit-definition",
			selected: [
				{
					definition,
					languages: language === undefined ? definition.languages : [language],
					discovered: discoverExecutable(definition.command, options.workspaceRoot).discovered,
				},
			],
			skipped: [],
		};
	}

	if (language !== undefined) {
		const candidates = registry.getCandidates(language);
		if (candidates.length === 0) throw new NoLanguageServerRegisteredError(language);
		const preferred = pickPreferred(candidates, options.workspaceRoot);
		if (!preferred) throw new NoLanguageServerRegisteredError(language);
		return {
			mode: "explicit-language",
			selected: [{ definition: preferred.definition, languages: [language], discovered: preferred.discovered }],
			skipped: candidates
				.filter((candidate) => candidate.id !== preferred.definition.id)
				.map((candidate) => ({
					definitionId: candidate.id,
					language,
					reason:
						"lower-priority candidate for the requested language (used only if the preferred server is unavailable)",
					affectsCoverage: false,
				})),
		};
	}

	const skipped: SkippedWorkspaceServer[] = [];
	if (options.languages !== undefined) {
		const selected = new Map<
			string,
			{ definition: LanguageServerDefinition; languages: string[]; discovered: boolean }
		>();
		for (const rawLanguage of options.languages) {
			const present = normalizeLanguageId(rawLanguage);
			const candidates = registry.getCandidates(present);
			if (candidates.length === 0) {
				skipped.push({
					language: present,
					reason: "no language server is registered for this language",
					affectsCoverage: !isDataLanguage(present),
				});
				continue;
			}
			const preferred = pickPreferred(candidates, options.workspaceRoot);
			if (!preferred) continue;
			const existing = selected.get(preferred.definition.id);
			if (existing) {
				existing.languages.push(present);
				continue;
			}
			if (selected.size >= maxServers) {
				skipped.push({
					definitionId: preferred.definition.id,
					language: present,
					reason: `not queried: the per-query server limit (${maxServers}) was reached`,
					affectsCoverage: true,
				});
				continue;
			}
			selected.set(preferred.definition.id, {
				definition: preferred.definition,
				languages: [present],
				discovered: preferred.discovered,
			});
		}
		return { mode: "inventory", selected: [...selected.values()], skipped };
	}

	const ranked = [...registry.getAll()].sort(
		(left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
	);
	const withDiscovery = ranked.map((definition) => ({
		definition,
		discovered: discoverExecutable(definition.command, options.workspaceRoot).discovered,
	}));
	const usable = withDiscovery.filter((entry) => entry.discovered);
	const chosen = (usable.length > 0 ? usable : withDiscovery).slice(0, maxServers);
	for (const entry of withDiscovery) {
		if (!chosen.includes(entry)) {
			skipped.push({
				definitionId: entry.definition.id,
				reason: entry.discovered
					? `not queried: the per-query server limit (${maxServers}) was reached`
					: "not queried: executable was not found",
				affectsCoverage: true,
			});
		}
	}
	return {
		mode: "unranked",
		selected: chosen.map((entry) => ({
			definition: entry.definition,
			languages: entry.definition.languages,
			discovered: entry.discovered,
		})),
		skipped,
	};
}
