import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type * as TS from "typescript";
import type { ChangeGate, ChangeGateInput, ChangeGateVerdict } from "../../changes/service.ts";
import { decodeTextFile, sha256 } from "../../changes/text-file.ts";
import { loadTypeScript, locateTypeScriptModule } from "../semantic/typescript-heritage.ts";
import type { CodeSymbolIndex } from "./code-index.ts";

const WINDOW = 32;
const MAX_BYTES = 8 * 1024 * 1024;

/** Structural candidates require source/contract review; this does not prove behavioral equivalence. */
export class StructuralReuseGate implements ChangeGate {
	readonly name = "structural-reuse-review-v1";
	private readonly index: CodeSymbolIndex;
	private readonly root: string;
	private readonly runtimeRoots: readonly string[];
	constructor(index: CodeSymbolIndex, root: string, runtimeRoots: readonly string[] = []) {
		this.index = index;
		this.root = root;
		this.runtimeRoots = runtimeRoots;
	}

	async check(input: ChangeGateInput): Promise<ChangeGateVerdict> {
		if (input.changeset.source === "rename") return { allow: true };
		const located = locateTypeScriptModule(this.root, this.runtimeRoots);
		if (!located)
			return this.unknown(input, "a workspace or managed TypeScript compiler is required for reuse review");
		const { ts } = loadTypeScript(located.path, located.source);
		await this.index.ensureFresh(input.signal);
		const facts = this.index.getWorkspaceFacts();
		const scanned: Array<readonly [string, string]> = [];
		let bytes = 0;
		let incomplete = !facts.complete || input.changeset.files.some((file) => !/\.[cm]?[jt]sx?$/iu.test(file.path));
		const originals = new Map<string, Map<string, number>>();
		for (const file of facts.files) {
			if (!/\.[cm]?[jt]sx?$/iu.test(file.path)) continue;
			bytes += file.size;
			if (bytes > MAX_BYTES) {
				incomplete = true;
				break;
			}
			try {
				input.signal?.throwIfAborted();
				const sourceBytes = await readFile(resolve(this.root, file.path));
				scanned.push([file.path, sha256(sourceBytes)]);
				originals.set(file.path, fingerprints(ts, file.path, decodeTextFile(sourceBytes, file.path).text));
			} catch {
				input.signal?.throwIfAborted();
				incomplete = true;
			}
		}
		for (const marker of facts.markers) {
			try {
				scanned.push([marker, sha256(await readFile(resolve(this.root, marker)))]);
			} catch {
				incomplete = true;
			}
		}
		const snapshot = sha256(
			JSON.stringify({
				compiler: ts.version,
				files: facts.files,
				scanned,
				complete: !incomplete,
				preview: input.changeset.files,
			}),
		);
		const refuse = (paths: readonly string[], message: string): ChangeGateVerdict => ({
			allow: false,
			code: "REUSE_REVIEW_REQUIRED",
			paths,
			message,
			...(!incomplete
				? {
						userException: {
							snapshot,
							scope: [...new Set([...input.changeset.files.map((file) => file.path), ...paths])].sort(),
						},
					}
				: {}),
		});
		const candidates = new Map<string, { paths: readonly string[]; message: string }>();
		const addCandidate = (paths: readonly string[], message: string): void => {
			const key = [...paths].sort().join("\u0000");
			if (!candidates.has(key)) candidates.set(key, { paths, message });
		};
		const newBlocks = new Map<string, string>();
		for (const file of input.changeset.files) {
			input.signal?.throwIfAborted();
			if (!/\.[cm]?[jt]sx?$/iu.test(file.path)) {
				incomplete = true;
				continue;
			}
			const after = input.content.after.get(file.path);
			if (!after) return this.unknown(input, `missing proposed content: ${file.path}`);
			if (after.byteLength > MAX_BYTES)
				return this.unknown(input, `proposed file exceeds reuse parsing budget: ${file.path}`);
			const proposed = fingerprints(ts, file.path, decodeTextFile(after, file.path).text);
			const before = originals.get(file.path) ?? new Map<string, number>();
			for (const [fingerprint, count] of proposed) {
				const previousCount = before.get(fingerprint) ?? 0;
				if (count <= previousCount) continue;
				const proposedCandidate = newBlocks.get(fingerprint);
				if (proposedCandidate && proposedCandidate !== file.path)
					addCandidate(
						[proposedCandidate, file.path],
						"The changeset introduces matching structural blocks in multiple files; review a shared implementation before committing.",
					);
				newBlocks.set(fingerprint, file.path);
				if (previousCount === 0 && count > 1)
					addCandidate(
						[file.path],
						`${file.path} introduces repeated structural blocks within the proposed file; review reuse before committing.`,
					);
				if (previousCount > 0)
					addCandidate(
						[file.path],
						`${file.path} introduces additional occurrences of an existing structural code block; review reuse before copying within the same file.`,
					);
				for (const [candidate, existing] of originals) {
					if (candidate !== file.path && existing.has(fingerprint))
						addCandidate(
							[file.path, candidate],
							`${file.path} introduces a ${WINDOW}-token structural clone of ${candidate}. Compare source, tests, side effects and cancellation contracts; reuse or modify the existing implementation. Structural similarity is not behavioral equivalence.`,
						);
				}
			}
		}
		if (candidates.size > 0) {
			const all = [...candidates.values()];
			if (all.length > 100)
				return {
					allow: false,
					code: "REUSE_REVIEW_REQUIRED",
					message: "reuse candidate review exceeds 100 groups; reduce the change scope",
				};
			return refuse([...new Set(all.flatMap((entry) => entry.paths))], all.map((entry) => entry.message).join("\n"));
		}
		return incomplete
			? this.unknown(input, "reuse coverage is incomplete (index, language, read failure or byte budget)")
			: { allow: true };
	}

	private unknown(input: ChangeGateInput, message: string): ChangeGateVerdict {
		return input.mode === "strict" ? { allow: false, code: "REUSE_REVIEW_REQUIRED", message } : { allow: true };
	}
}

/** Sliding AST-body token windows detect copying into an existing function as well as new declarations. */
export function fingerprints(ts: typeof TS, path: string, text: string): Map<string, number> {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const result = new Map<string, number>();
	const visit = (node: TS.Node): void => {
		if (ts.isFunctionLike(node) && "body" in node && node.body) {
			const body = node.body as TS.Node;
			const locals = new Map<string, string>();
			const bind = (name: TS.BindingName): void => {
				if (ts.isIdentifier(name)) {
					if (!locals.has(name.text)) locals.set(name.text, `$${locals.size}`);
				} else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
			};
			for (const parameter of node.parameters) bind(parameter.name);
			const declarations = (child: TS.Node): void => {
				if (child !== body && ts.isFunctionLike(child)) return;
				if (ts.isVariableDeclaration(child)) bind(child.name);
				ts.forEachChild(child, declarations);
			};
			declarations(body);
			const tokens: string[] = [];
			const leaves = (child: TS.Node): void => {
				// Nested functions are reviewed independently below, not counted twice in their enclosing body.
				if (child !== body && ts.isFunctionLike(child)) {
					tokens.push("<nested-function>");
					return;
				}
				const children = child.getChildren(source);
				if (children.length) {
					for (const entry of children) leaves(entry);
					return;
				}
				if (child.kind === ts.SyntaxKind.EndOfFileToken) return;
				const property =
					ts.isIdentifier(child) &&
					((ts.isPropertyAccessExpression(child.parent) && child.parent.name === child) ||
						(ts.isPropertyAssignment(child.parent) && child.parent.name === child));
				tokens.push(
					ts.isIdentifier(child) && !property ? (locals.get(child.text) ?? child.text) : child.getText(source),
				);
			};
			leaves(body);
			for (let start = 0; start + WINDOW <= tokens.length; start++) {
				const fingerprint = JSON.stringify(tokens.slice(start, start + WINDOW));
				result.set(fingerprint, (result.get(fingerprint) ?? 0) + 1);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return result;
}
