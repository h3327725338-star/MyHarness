import { resolvePath } from "../../utils/paths.ts";
import type { Extension, ExtensionRuntime, InlineExtension, LoadExtensionsResult } from "../compat/types.ts";
import type { EventBus } from "../runtime/event-bus.ts";
import {
	clearExtensionCache,
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensionsCached,
} from "./index.ts";

export interface ExtensionResourceLoaderOptions {
	cwd: string;
	eventBus: EventBus;
	extensionFactories: InlineExtension[];
}

/**
 * Extension-specific loading and ordering. PackageManager still decides which
 * paths are enabled; this module is responsible only for turning those paths
 * (and inline factories) into a LoadExtensionsResult.
 */
export class ExtensionResourceLoader {
	private readonly cwd: string;
	private readonly eventBus: EventBus;
	private readonly extensionFactories: InlineExtension[];

	constructor(options: ExtensionResourceLoaderOptions) {
		this.cwd = options.cwd;
		this.eventBus = options.eventBus;
		this.extensionFactories = options.extensionFactories;
	}

	createEmptyResult(): LoadExtensionsResult {
		return { extensions: [], errors: [], runtime: createExtensionRuntime() };
	}

	clearCache(): void {
		clearExtensionCache();
	}

	async loadCurrent(paths: string[], options: { includeInlineFactories: boolean }): Promise<LoadExtensionsResult> {
		const result = await loadExtensionsCached(paths, this.cwd, this.eventBus);
		if (!options.includeInlineFactories) {
			return result;
		}

		const inlineExtensions = await this.loadInlineFactories(result.runtime);
		result.extensions.push(...inlineExtensions.extensions);
		result.errors.push(...inlineExtensions.errors);
		return result;
	}

	async loadFinal(paths: string[], preTrustExtensions?: LoadExtensionsResult): Promise<LoadExtensionsResult> {
		if (!preTrustExtensions) {
			const result = await loadExtensionsCached(paths, this.cwd, this.eventBus);
			const inlineExtensions = await this.loadInlineFactories(result.runtime);
			result.extensions.push(...inlineExtensions.extensions);
			result.errors.push(...inlineExtensions.errors);
			this.addConflictDiagnostics(result);
			return result;
		}

		const preloadedByPath = new Map(
			preTrustExtensions.extensions
				.filter((extension) => !extension.path.startsWith("<inline:"))
				.map((extension) => [extension.resolvedPath, extension]),
		);
		const failedPreloadPaths = new Set(
			preTrustExtensions.errors.map((error) => this.resolveExtensionLoadPath(error.path)),
		);
		const remainingPaths = paths.filter((path) => {
			const resolvedPath = this.resolveExtensionLoadPath(path);
			return !preloadedByPath.has(resolvedPath) && !failedPreloadPaths.has(resolvedPath);
		});
		const remainingExtensions = await loadExtensionsCached(
			remainingPaths,
			this.cwd,
			this.eventBus,
			preTrustExtensions.runtime,
		);
		const loadedByPath = new Map(preloadedByPath);
		for (const extension of remainingExtensions.extensions) {
			loadedByPath.set(extension.resolvedPath, extension);
		}

		const inlineExtensions = preTrustExtensions.extensions.filter((extension) =>
			extension.path.startsWith("<inline:"),
		);
		const orderedExtensions = paths
			.map((path) => loadedByPath.get(this.resolveExtensionLoadPath(path)))
			.filter((extension): extension is Extension => extension !== undefined);
		orderedExtensions.push(...inlineExtensions);

		const result: LoadExtensionsResult = {
			extensions: orderedExtensions,
			errors: [...preTrustExtensions.errors, ...remainingExtensions.errors],
			runtime: preTrustExtensions.runtime,
		};
		this.addConflictDiagnostics(result);
		return result;
	}

	private resolveExtensionLoadPath(path: string): string {
		return resolvePath(path, this.cwd, { normalizeUnicodeSpaces: true });
	}

	private async loadInlineFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, input] of this.extensionFactories.entries()) {
			const isNamed = typeof input !== "function";
			const factory = isNamed ? input.factory : input;
			const extensionPath = `<inline:${isNamed ? input.name : index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extension.hidden = isNamed && input.hidden;
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private addConflictDiagnostics(result: LoadExtensionsResult): void {
		for (const conflict of this.detectConflicts(result.extensions)) {
			result.errors.push({ path: conflict.path, error: conflict.message });
		}
	}

	private detectConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const extension of extensions) {
			for (const toolName of extension.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== extension.path) {
					conflicts.push({
						path: extension.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, extension.path);
				}
			}

			for (const flagName of extension.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== extension.path) {
					conflicts.push({
						path: extension.path,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, extension.path);
				}
			}
		}

		return conflicts;
	}
}
