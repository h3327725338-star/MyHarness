/**
 * Explicit extends / implements relations for TypeScript, derived from the project's own compiler.
 *
 * typescript-language-server does not provide the standard `typeHierarchy` requests, so asking it for
 * supertypes or subtypes would only ever fail. The relations a developer means by "inheritance" are the
 * ones written in the source: `class A extends B`, `class A implements I`, `interface I extends J`.
 * Those are read from the compiler's syntax tree and resolved through its symbol table (aliases,
 * re-exports, namespace imports), never inferred from structural compatibility: a class that merely has
 * the same members as an interface is not its subtype.
 *
 * The compiler is not a product dependency. It is loaded from the user's project (`node_modules`) or
 * from the managed language-server runtime; when neither exists the adapter reports
 * `environment_blocked` instead of guessing.
 *
 * Programs are built on the calling thread, so a very large project would stall the process; the adapter
 * refuses projects over a file budget and reports that limit.
 */

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type * as TS from "typescript";
import type { CodePosition, CodeRange } from "../types.ts";
import { buildLineIndex, type LineIndex, offsetAt, positionAt } from "./locator.ts";

export type TypeScriptModuleSource = "workspace" | "managed-runtime";

export interface LoadedTypeScript {
	readonly ts: typeof TS;
	readonly version: string;
	readonly source: TypeScriptModuleSource;
	readonly modulePath: string;
}

const MAX_PROGRAM_FILES = 5_000;
const MAX_PROJECTS = 8;
const loaded = new Map<string, LoadedTypeScript>();

/** Find a `typescript` package: the workspace's own first, then the managed runtime's. */
export function locateTypeScriptModule(
	workspaceRoot: string,
	runtimeRoots: readonly string[] = [],
): { readonly path: string; readonly source: TypeScriptModuleSource } | undefined {
	try {
		const requireFromWorkspace = createRequire(join(workspaceRoot, "noop.js"));
		const modulePath = requireFromWorkspace.resolve("typescript/lib/typescript.js");
		// An isolated project below the product checkout must not accidentally borrow the product's
		// dev-only compiler. Only a compiler inside this workspace is a workspace runtime dependency.
		if (isInside(workspaceRoot, modulePath)) return { path: modulePath, source: "workspace" };
	} catch {
		// Not installed in the project or any parent directory.
	}
	for (const runtimeRoot of runtimeRoots) {
		const candidate = join(runtimeRoot, "node_modules", "typescript", "lib", "typescript.js");
		if (existsSync(candidate)) return { path: candidate, source: "managed-runtime" };
	}
	return undefined;
}

export function loadTypeScript(path: string, source: TypeScriptModuleSource): LoadedTypeScript {
	const cached = loaded.get(path);
	if (cached) return cached;
	const requireModule = createRequire(import.meta.url);
	const ts = requireModule(path) as typeof TS;
	const handle: LoadedTypeScript = { ts, version: ts.version, source, modulePath: path };
	loaded.set(path, handle);
	return handle;
}

export type HeritageRelationKind = "extends" | "implements";

export interface HeritageTypeInfo {
	readonly name: string;
	readonly kind: "class" | "interface";
	/** Workspace-relative POSIX path. */
	readonly path: string;
	readonly selectionRange: CodeRange;
	readonly declarationRange: CodeRange;
	readonly relation: HeritageRelationKind;
}

export interface HeritageQuery {
	readonly workspaceRoot: string;
	/** Workspace-relative POSIX path of the document that holds the target declaration. */
	readonly path: string;
	/** Any position inside the target declaration's name. */
	readonly position: CodePosition;
	readonly direction: "supertypes" | "subtypes";
	/** Workspace-relative tsconfig/jsconfig files of other projects that may contain subtypes. */
	readonly projectConfigs?: readonly string[];
	readonly runtimeRoots?: readonly string[];
	readonly signal?: AbortSignal;
}

export type HeritageResult =
	| {
			readonly status: "ok";
			readonly items: readonly HeritageTypeInfo[];
			readonly warnings: readonly string[];
			readonly projects: readonly string[];
			readonly typescriptVersion: string;
			readonly typescriptSource: TypeScriptModuleSource;
	  }
	| { readonly status: "environment_blocked"; readonly reason: string }
	| { readonly status: "not_a_type"; readonly reason: string }
	| { readonly status: "unsupported"; readonly reason: string };

interface ProjectProgram {
	readonly configPath: string | undefined;
	readonly program: TS.Program;
	readonly stamp: string;
}

const programCache = new Map<string, ProjectProgram>();
const MAX_CACHED_PROGRAMS = 12;

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

function normalizeKey(path: string): string {
	return process.platform === "win32" ? toPosix(path).toLowerCase() : toPosix(path);
}

function isInside(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function fileStamp(fileNames: readonly string[]): string {
	let total = 0;
	let latest = 0;
	for (const fileName of fileNames) {
		try {
			const stats = statSync(fileName);
			total += stats.size;
			latest = Math.max(latest, stats.mtimeMs);
		} catch {
			total += 1;
		}
	}
	return `${fileNames.length}:${total}:${latest}`;
}

interface ParsedProject {
	readonly configPath: string | undefined;
	readonly options: TS.CompilerOptions;
	readonly fileNames: readonly string[];
	readonly references: readonly string[];
}

function parseProject(ts: typeof TS, configPath: string): ParsedProject | undefined {
	const host: TS.ParseConfigFileHost = {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: () => undefined,
	};
	const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
	if (!parsed) return undefined;
	const references = (parsed.projectReferences ?? []).map((reference) => {
		const referenced = reference.path;
		return /\.json$/iu.test(referenced) ? resolve(referenced) : join(resolve(referenced), "tsconfig.json");
	});
	return { configPath, options: parsed.options, fileNames: parsed.fileNames, references };
}

function inferredProject(ts: typeof TS, fileName: string): ParsedProject {
	return {
		configPath: undefined,
		options: {
			allowJs: true,
			checkJs: false,
			noEmit: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			skipLibCheck: true,
		},
		fileNames: [fileName],
		references: [],
	};
}

/** The tsconfig/jsconfig files above a file, nearest first, stopping at the workspace root. */
function enclosingConfigs(workspaceRoot: string, fileName: string): string[] {
	const configs: string[] = [];
	const rootKey = normalizeKey(workspaceRoot);
	let directory = dirname(fileName);
	for (;;) {
		for (const name of ["tsconfig.json", "jsconfig.json"]) {
			const candidate = join(directory, name);
			if (existsSync(candidate)) configs.push(candidate);
		}
		if (normalizeKey(directory) === rootKey) break;
		const parent = dirname(directory);
		if (parent === directory || relative(workspaceRoot, parent).startsWith("..")) break;
		directory = parent;
	}
	return configs;
}

function createProjectProgram(ts: typeof TS, project: ParsedProject, extraRoots: readonly string[]): ProjectProgram {
	const rootNames = [...new Set([...project.fileNames, ...extraRoots])];
	const key = project.configPath ? normalizeKey(project.configPath) : `inferred:${normalizeKey(extraRoots[0] ?? "")}`;
	const stamp = fileStamp(rootNames);
	const cached = programCache.get(key);
	if (cached && cached.stamp === stamp) return cached;
	const program = ts.createProgram({
		rootNames,
		options: { ...project.options, noEmit: true },
		oldProgram: cached?.program,
	});
	const entry: ProjectProgram = { configPath: project.configPath, program, stamp };
	programCache.delete(key);
	programCache.set(key, entry);
	while (programCache.size > MAX_CACHED_PROGRAMS) {
		const oldest = programCache.keys().next().value;
		if (oldest === undefined) break;
		programCache.delete(oldest);
	}
	return entry;
}

function findOwningProject(
	ts: typeof TS,
	workspaceRoot: string,
	fileName: string,
	warnings: string[],
): { readonly project: ParsedProject; readonly includesFile: boolean } {
	const fileKey = normalizeKey(fileName);
	const visited = new Set<string>();
	const tryConfig = (configPath: string, depth: number): ParsedProject | undefined => {
		const key = normalizeKey(configPath);
		if (visited.has(key) || !existsSync(configPath)) return undefined;
		visited.add(key);
		const parsed = parseProject(ts, configPath);
		if (!parsed) return undefined;
		if (parsed.fileNames.some((candidate) => normalizeKey(candidate) === fileKey)) return parsed;
		if (depth < 2) {
			for (const reference of parsed.references) {
				const owner = tryConfig(reference, depth + 1);
				if (owner) return owner;
			}
		}
		return undefined;
	};
	const configs = enclosingConfigs(workspaceRoot, fileName);
	for (const config of configs) {
		const owner = tryConfig(config, 0);
		if (owner) return { project: owner, includesFile: true };
	}
	const first = configs[0];
	if (first) {
		const parsed = parseProject(ts, first);
		if (parsed) {
			warnings.push(
				`${toPosix(relative(workspaceRoot, fileName))} is not included by ${toPosix(relative(workspaceRoot, first))}; it was added to the project as an extra root`,
			);
			return { project: parsed, includesFile: false };
		}
	}
	warnings.push("no tsconfig.json or jsconfig.json found; the file was analyzed as an inferred project");
	return { project: inferredProject(ts, fileName), includesFile: false };
}

type HeritageHost = TS.ClassDeclaration | TS.InterfaceDeclaration;

function isHeritageHost(ts: typeof TS, node: TS.Node): node is HeritageHost {
	return (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name !== undefined;
}

/** Nodes from the source file down to the innermost node that contains the offset (parents are not set yet). */
function nodesAtOffset(ts: typeof TS, sourceFile: TS.SourceFile, offset: number): TS.Node[] {
	const chain: TS.Node[] = [];
	const descend = (node: TS.Node): void => {
		chain.push(node);
		ts.forEachChild(node, (child) => {
			if (child.getStart(sourceFile) <= offset && offset <= child.getEnd()) {
				descend(child);
				return true;
			}
			return undefined;
		});
	};
	descend(sourceFile);
	return chain;
}

/** The innermost class or interface declaration whose text contains the offset. */
function targetDeclaration(ts: typeof TS, sourceFile: TS.SourceFile, offset: number): HeritageHost | undefined {
	const chain = nodesAtOffset(ts, sourceFile, offset);
	for (let index = chain.length - 1; index >= 0; index--) {
		const node = chain[index];
		if (isHeritageHost(ts, node)) return node;
	}
	return undefined;
}

function declarationKey(declaration: TS.Declaration): string {
	const sourceFile = declaration.getSourceFile();
	return `${normalizeKey(sourceFile.fileName)}:${declaration.getStart(sourceFile)}`;
}

interface ResolvedHeritage {
	readonly declarations: readonly HeritageHost[];
	readonly relation: HeritageRelationKind;
	readonly unresolved?: string;
}

function resolveHeritageTarget(
	ts: typeof TS,
	checker: TS.TypeChecker,
	expression: TS.ExpressionWithTypeArguments,
	relation: HeritageRelationKind,
): ResolvedHeritage {
	const target = expression.expression;
	let symbol = checker.getSymbolAtLocation(target);
	if (!symbol) symbol = checker.getTypeAtLocation(target).symbol;
	if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
	if (!symbol) return { declarations: [], relation, unresolved: target.getText() };
	const declarations = (symbol.declarations ?? []).filter((declaration): declaration is HeritageHost =>
		isHeritageHost(ts, declaration),
	);
	if (declarations.length === 0) return { declarations: [], relation, unresolved: target.getText() };
	return { declarations, relation };
}

function* heritageExpressions(
	ts: typeof TS,
	declaration: HeritageHost,
): Generator<{ expression: TS.ExpressionWithTypeArguments; relation: HeritageRelationKind }> {
	for (const clause of declaration.heritageClauses ?? []) {
		const relation: HeritageRelationKind =
			clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
		for (const expression of clause.types) yield { expression, relation };
	}
}

function toRange(lineIndex: LineIndex, start: number, end: number): CodeRange {
	return { start: positionAt(lineIndex, start), end: positionAt(lineIndex, end) };
}

function describeDeclaration(
	ts: typeof TS,
	workspaceRoot: string,
	declaration: HeritageHost,
	relation: HeritageRelationKind,
): HeritageTypeInfo | undefined {
	const sourceFile = declaration.getSourceFile();
	if (!declaration.name) return undefined;
	const absolute = resolve(sourceFile.fileName);
	if (!isInside(workspaceRoot, absolute)) return undefined;
	const lineIndex = buildLineIndex(sourceFile.text);
	return {
		name: declaration.name.text,
		kind: ts.isClassDeclaration(declaration) ? "class" : "interface",
		path: toPosix(relative(workspaceRoot, absolute)),
		selectionRange: toRange(lineIndex, declaration.name.getStart(sourceFile), declaration.name.getEnd()),
		declarationRange: toRange(lineIndex, declaration.getStart(sourceFile), declaration.getEnd()),
		relation,
	};
}

export function analyzeHeritage(query: HeritageQuery): HeritageResult {
	const workspaceRoot = resolve(query.workspaceRoot);
	const located = locateTypeScriptModule(workspaceRoot, query.runtimeRoots ?? []);
	if (!located) {
		return {
			status: "environment_blocked",
			reason:
				"no TypeScript compiler was found in the project or the managed language-server runtime; install the project's dependencies to enable inheritance queries",
		};
	}
	const handle = loadTypeScript(located.path, located.source);
	const { ts } = handle;
	throwIfAborted(query.signal);

	const warnings: string[] = [];
	const fileName = resolve(workspaceRoot, query.path);
	if (!existsSync(fileName)) return { status: "unsupported", reason: `${query.path} does not exist` };
	const { project } = findOwningProject(ts, workspaceRoot, fileName, warnings);
	if (project.fileNames.length > MAX_PROGRAM_FILES) {
		return {
			status: "unsupported",
			reason: `the project has ${project.fileNames.length} files, over the ${MAX_PROGRAM_FILES} file budget of the inheritance adapter`,
		};
	}
	const owning = createProjectProgram(ts, project, [fileName]);
	const sourceFile = owning.program.getSourceFile(fileName);
	if (!sourceFile) return { status: "unsupported", reason: `${query.path} is not part of any TypeScript project` };
	const lineIndex = buildLineIndex(sourceFile.text);
	const offset = offsetAt(lineIndex, query.position);
	if (offset === undefined) return { status: "unsupported", reason: "position is outside the document" };
	const declaration = targetDeclaration(ts, sourceFile, offset);
	if (!declaration) {
		return { status: "not_a_type", reason: "the position is not inside a class or interface declaration" };
	}
	throwIfAborted(query.signal);

	const checker = owning.program.getTypeChecker();
	const projects = [owning.configPath ? toPosix(relative(workspaceRoot, owning.configPath)) : "(inferred)"];
	const items = new Map<string, HeritageTypeInfo>();
	let outsideWorkspace = 0;
	const add = (target: HeritageHost, relation: HeritageRelationKind): void => {
		const info = describeDeclaration(ts, workspaceRoot, target, relation);
		if (!info) {
			outsideWorkspace++;
			return;
		}
		items.set(`${info.path}:${info.selectionRange.start.line}:${info.selectionRange.start.character}`, info);
	};

	if (query.direction === "supertypes") {
		for (const { expression, relation } of heritageExpressions(ts, declaration)) {
			const resolved = resolveHeritageTarget(ts, checker, expression, relation);
			if (resolved.unresolved !== undefined) {
				warnings.push(`${relation} "${resolved.unresolved}" is not a statically resolvable class or interface`);
				continue;
			}
			for (const target of resolved.declarations) add(target, relation);
		}
	} else {
		const targetSymbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
		const targetKeys = new Set((targetSymbol?.declarations ?? []).map((candidate) => declarationKey(candidate)));
		const scanned = new Set<string>();
		const scan = (entry: ProjectProgram, projectLabel: string): void => {
			const entryChecker = entry.program.getTypeChecker();
			for (const file of entry.program.getSourceFiles()) {
				if (entry.program.isSourceFileDefaultLibrary(file) || entry.program.isSourceFileFromExternalLibrary(file))
					continue;
				const fileKey = normalizeKey(file.fileName);
				if (scanned.has(fileKey)) continue;
				scanned.add(fileKey);
				const visit = (node: TS.Node): void => {
					if (isHeritageHost(ts, node)) {
						for (const { expression, relation } of heritageExpressions(ts, node)) {
							const resolved = resolveHeritageTarget(ts, entryChecker, expression, relation);
							if (resolved.declarations.some((candidate) => targetKeys.has(declarationKey(candidate)))) {
								add(node, relation);
							}
						}
					}
					ts.forEachChild(node, visit);
				};
				visit(file);
			}
			if (!projects.includes(projectLabel)) projects.push(projectLabel);
		};
		scan(owning, projects[0]);
		for (const config of (query.projectConfigs ?? []).slice(0, MAX_PROJECTS)) {
			throwIfAborted(query.signal);
			const configPath = resolve(workspaceRoot, config);
			if (owning.configPath && normalizeKey(owning.configPath) === normalizeKey(configPath)) continue;
			const parsed = parseProject(ts, configPath);
			if (!parsed) {
				warnings.push(`${toPosix(config)} could not be parsed and was not searched`);
				continue;
			}
			if (parsed.fileNames.length > MAX_PROGRAM_FILES) {
				warnings.push(
					`${toPosix(config)} has ${parsed.fileNames.length} files and was not searched (limit ${MAX_PROGRAM_FILES})`,
				);
				continue;
			}
			scan(createProjectProgram(ts, parsed, []), toPosix(config));
		}
		if ((query.projectConfigs ?? []).length > MAX_PROJECTS) {
			warnings.push(`only ${MAX_PROJECTS} projects were searched for subtypes`);
		}
	}
	if (outsideWorkspace > 0) {
		warnings.push(`${outsideWorkspace} related type(s) are declared outside the workspace and are not listed`);
	}
	return {
		status: "ok",
		items: [...items.values()].sort(
			(left, right) =>
				left.path.localeCompare(right.path) ||
				left.selectionRange.start.line - right.selectionRange.start.line ||
				left.selectionRange.start.character - right.selectionRange.start.character,
		),
		warnings,
		projects,
		typescriptVersion: handle.version,
		typescriptSource: handle.source,
	};
}

export function clearTypeScriptProgramCache(): void {
	programCache.clear();
}
