import type { LspClientCapabilities, LspClientInfo, LspClientOptions } from "../types.ts";
import { DuplicateLanguageServerDefinitionError, InvalidLanguageServerDefinitionError } from "./errors.ts";
import type { LanguageServerDefinition } from "./types.ts";

export interface LanguageServerDefinitionInput {
	readonly id: string;
	readonly languages: readonly string[];
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly priority?: number;
	readonly configured?: boolean;
	readonly clientOptions?: Omit<LspClientOptions, "logger">;
	readonly clientInfo?: LspClientInfo;
	readonly capabilities?: LspClientCapabilities;
}

interface RegisteredDefinition {
	readonly definition: LanguageServerDefinition;
	readonly registrationOrder: number;
}

/** Normalize language identifiers at the registry boundary. */
export function normalizeLanguageId(language: string): string {
	return language.trim().toLowerCase();
}

function freezeDeep<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	if (Array.isArray(value)) {
		for (const item of value) freezeDeep(item);
	} else {
		for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
	}
	Object.freeze(value);
	return value;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function normalizeDefinition(input: LanguageServerDefinitionInput): LanguageServerDefinition {
	const id = input.id.trim();
	if (!id) throw new InvalidLanguageServerDefinitionError("language server definition id must not be empty");
	if (!input.command.trim()) {
		throw new InvalidLanguageServerDefinitionError("language server definition command must not be empty", {
			definitionId: id,
		});
	}

	const languages = input.languages.map(normalizeLanguageId);
	if (languages.length === 0 || languages.some((language) => !language)) {
		throw new InvalidLanguageServerDefinitionError(
			"language server definition must declare at least one non-empty language",
			{ definitionId: id },
		);
	}
	if (new Set(languages).size !== languages.length) {
		throw new InvalidLanguageServerDefinitionError(
			"language server definition languages must be unique after normalization",
			{ definitionId: id },
		);
	}

	const priority = input.priority ?? 0;
	if (!Number.isFinite(priority)) {
		throw new InvalidLanguageServerDefinitionError("language server definition priority must be finite", {
			definitionId: id,
		});
	}

	const definition: LanguageServerDefinition = {
		id,
		languages: Object.freeze([...languages]),
		command: input.command,
		args: Object.freeze([...(input.args ?? [])]),
		env: input.env === undefined ? undefined : freezeDeep(clone(input.env)),
		priority,
		configured: input.configured ?? false,
		clientOptions: input.clientOptions === undefined ? undefined : freezeDeep(clone(input.clientOptions)),
		clientInfo: input.clientInfo === undefined ? undefined : freezeDeep(clone(input.clientInfo)),
		capabilities: input.capabilities === undefined ? undefined : freezeDeep(clone(input.capabilities)),
	};
	return freezeDeep(definition);
}

/**
 * Registry only owns immutable server definitions and deterministic routing.
 * It never starts processes and never owns runtime client instances.
 */
export class LanguageServerRegistry {
	private readonly definitions = new Map<string, RegisteredDefinition>();
	private nextRegistrationOrder = 0;

	register(input: LanguageServerDefinitionInput): this {
		const definition = normalizeDefinition(input);
		if (this.definitions.has(definition.id)) {
			throw new DuplicateLanguageServerDefinitionError(definition.id);
		}
		this.definitions.set(definition.id, {
			definition,
			registrationOrder: this.nextRegistrationOrder++,
		});
		return this;
	}

	has(id: string): boolean {
		return this.definitions.has(id.trim());
	}

	get(id: string): LanguageServerDefinition | undefined {
		return this.definitions.get(id.trim())?.definition;
	}

	getAll(): readonly LanguageServerDefinition[] {
		return Object.freeze([...this.definitions.values()].map((entry) => entry.definition));
	}

	getCandidates(language: string): readonly LanguageServerDefinition[] {
		const normalizedLanguage = normalizeLanguageId(language);
		if (!normalizedLanguage) return Object.freeze([]);
		const candidates = [...this.definitions.values()]
			.filter((entry) => entry.definition.languages.includes(normalizedLanguage))
			.sort(
				(left, right) =>
					right.definition.priority - left.definition.priority ||
					left.registrationOrder - right.registrationOrder ||
					left.definition.id.localeCompare(right.definition.id),
			)
			.map((entry) => entry.definition);
		return Object.freeze(candidates);
	}

	get size(): number {
		return this.definitions.size;
	}
}
