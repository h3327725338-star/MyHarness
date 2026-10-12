/**
 * Standalone ESM import scanner for the HTML export bundler (`bundle-frontend.ts`).
 *
 * Contract:
 * - `scanImports(source)` returns every module specifier in an ES module: static `import`, `export … from`,
 *   and `import("literal")`. Each result satisfies `source.slice(start, end) === specifier` — the range points at
 *   the specifier body itself (quotes excluded), so callers can rewrite specifiers without reparsing.
 * - Correctly skips line/block comments, `'…'`/`"…"` strings, template literals (including nested `${…}`),
 *   and regex literals, so `import …` text inside them is never reported.
 * - Anything the scanner does not understand must throw, never be silently skipped: non-literal `import(x)`,
 *   `import.meta`, template-literal specifiers, escape sequences inside a specifier, an empty specifier,
 *   or unterminated strings/templates/comments. This is deliberate: a missed import would white-screen the
 *   exported page only after someone changes a writing style, which is exactly the failure this scanner exists to
 *   catch. During tests the results are cross-checked against `es-module-lexer` on every frontend module.
 *
 * No runtime dependencies are allowed here (manager decision D-15): `es-module-lexer` is a transitive dev
 * dependency only and would be missing on a production install, where exporting runs on the user's machine.
 */

export type ImportKind = "static" | "export-from" | "dynamic";

export interface ScannedImport {
	readonly kind: ImportKind;
	/** Offset of the specifier body in the source (the opening quote is not included). */
	readonly start: number;
	/** Offset just past the last specifier character (the closing quote is not included). */
	readonly end: number;
	/** Raw specifier text exactly as it appears in the source. */
	readonly specifier: string;
}

export class ScanImportsError extends Error {}

const ID_START = /[A-Za-z_$\u{80}-\u{10FFFF}]/u;
const ID_CONTINUE = /[A-Za-z0-9_$\u{80}-\u{10FFFF}]/u;
const REGEX_FLAG = /[a-z]/;
const HEX_OR_RADIX_PREFIX = /[xXbBoO]/;

/** Word tokens after which a `/` starts a regex literal rather than a division. */
const KEYWORDS_BEFORE_REGEX = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"do",
	"else",
	"case",
	"yield",
	"await",
	"throw",
]);

/** Multi-character punctuators, longest first. Single characters fall through. */
const OPERATORS = [
	"...",
	">>>=",
	">>>",
	"**=",
	"&&=",
	"||=",
	"??=",
	">>=",
	"<<=",
	"===",
	"!==",
	"==",
	"!=",
	"<=",
	">=",
	"=>",
	"**",
	"&&",
	"||",
	"??",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"++",
	"--",
	"?.",
];

class ImportScanner {
	private readonly src: string;
	private readonly out: ScannedImport[] = [];
	private i = 0;
	/** Last significant token, used to tell regex literals from division. */
	private prev = "";

	constructor(source: string) {
		this.src = source;
	}

	scan(): ScannedImport[] {
		this.scanCode(false);
		return [...this.out];
	}

	private scanCode(stopOnBrace: boolean): void {
		let depth = 0;
		const n = this.src.length;
		while (this.i < n) {
			const c = this.src[this.i]!;
			if (c === "}") {
				if (stopOnBrace && depth === 0) return;
				if (depth > 0) depth--;
				this.i++;
				this.prev = "}";
				continue;
			}
			if (c === "{") {
				depth++;
				this.i++;
				this.prev = "{";
				continue;
			}
			if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f") {
				this.i++;
				continue;
			}
			if (c === "/" && this.src[this.i + 1] === "/") {
				this.skipLineComment();
				continue;
			}
			if (c === "/" && this.src[this.i + 1] === "*") {
				this.skipBlockComment();
				continue;
			}
			if (c === "/") {
				if (this.regexAllowed() && this.tryRegex()) continue;
				this.i += this.src[this.i + 1] === "=" ? 2 : 1;
				this.prev = "/";
				continue;
			}
			if (c === '"' || c === "'") {
				this.readString(c);
				continue;
			}
			if (c === "`") {
				this.readTemplate();
				continue;
			}
			if (ID_START.test(c)) {
				const word = this.readWord();
				this.handleWord(word);
				continue;
			}
			if (c >= "0" && c <= "9") {
				this.readNumber();
				continue;
			}
			this.readPunct();
		}
		if (stopOnBrace) throw new ScanImportsError("unterminated code block: expected '}'");
	}

	private handleWord(word: string): void {
		if ((word === "import" || word === "export") && this.prev !== "." && this.prev !== "?." && this.prev !== "#") {
			if (word === "import") this.scanImport();
			else this.scanExport();
			return;
		}
		this.prev = word;
	}

	private scanImport(): void {
		this.skipTrivia();
		const c = this.src[this.i];
		if (c === undefined) throw new ScanImportsError("unexpected end of source after 'import'");
		if (c === ".") {
			this.i++;
			this.skipTrivia();
			const name = ID_START.test(this.src[this.i] ?? "") ? this.readWord() : "";
			throw new ScanImportsError(
				`unsupported syntax: 'import.${name || "?"}' — bundled modules must not use import.meta or other import-keyword property access`,
			);
		}
		if (c === "(") {
			this.i++;
			this.skipTrivia();
			const q = this.src[this.i];
			if (q === '"' || q === "'") {
				const lit = this.readString(q);
				this.skipTrivia();
				if (this.src[this.i] !== ")") {
					throw new ScanImportsError(`dynamic import() must take exactly one string literal (index ${lit.start})`);
				}
				this.i++;
				this.record("dynamic", lit.start, lit.end, lit.text);
				this.prev = ")";
				return;
			}
			if (q === "`") {
				throw new ScanImportsError(
					`dynamic import() with a template-literal specifier is not supported (index ${this.i})`,
				);
			}
			throw new ScanImportsError(`non-literal dynamic import() is not supported (index ${this.i})`);
		}
		if (c === '"' || c === "'") {
			const lit = this.readString(c);
			this.record("static", lit.start, lit.end, lit.text);
			return;
		}
		// Clause form: `import … from "…"` with `{…}`, `*`, `* as x`, a default binding, or any combination.
		for (;;) {
			this.skipTrivia();
			const cc = this.src[this.i];
			if (cc === "{") {
				this.i++;
				this.scanCode(true);
				if (this.src[this.i] !== "}") throw new ScanImportsError("unterminated '{ … }' import clause");
				this.i++;
				this.prev = "}";
			} else if (cc === "*") {
				this.i++;
				this.skipTrivia();
				if (this.tryWord("as")) {
					this.skipTrivia();
					if (!ID_START.test(this.src[this.i] ?? ""))
						throw new ScanImportsError("expected a binding name after 'import * as'");
					this.readWord();
				}
			} else if (cc !== undefined && ID_START.test(cc)) {
				this.readWord();
			} else {
				throw new ScanImportsError(
					`unsupported syntax after 'import': ${JSON.stringify(this.src.slice(this.i, this.i + 24))}`,
				);
			}
			this.skipTrivia();
			if (this.src[this.i] === ",") {
				this.i++;
				this.prev = ",";
				continue;
			}
			if (this.tryWord("from")) {
				this.readSpecifier("static");
				return;
			}
			throw new ScanImportsError(
				`import clause must be followed by 'from': ${JSON.stringify(this.src.slice(this.i - 8, this.i + 24))}`,
			);
		}
	}

	private scanExport(): void {
		this.skipTrivia();
		const c = this.src[this.i];
		if (c === "{") {
			this.i++;
			this.scanCode(true);
			if (this.src[this.i] !== "}") throw new ScanImportsError("unterminated '{ … }' export clause");
			this.i++;
			this.prev = "}";
			this.skipTrivia();
			if (this.tryWord("from")) this.readSpecifier("export-from");
			return;
		}
		if (c === "*") {
			this.i++;
			this.skipTrivia();
			if (this.tryWord("as")) {
				this.skipTrivia();
				if (!ID_START.test(this.src[this.i] ?? ""))
					throw new ScanImportsError("expected a namespace name after 'export * as'");
				this.readWord();
				this.skipTrivia();
			}
			if (!this.tryWord("from")) throw new ScanImportsError("'export *' must be followed by 'from'");
			this.readSpecifier("export-from");
			return;
		}
		// Every other `export …` (default, const, let, function, class, …) is a declaration; keep scanning as normal code.
		this.prev = "export";
	}

	private readSpecifier(kind: ImportKind): void {
		this.skipTrivia();
		const q = this.src[this.i];
		if (q === "`") {
			throw new ScanImportsError(
				`module specifier after 'from' must be a string literal, not a template literal (index ${this.i})`,
			);
		}
		if (q !== '"' && q !== "'") {
			throw new ScanImportsError(
				`non-literal module specifier after 'from' (index ${this.i}): ${JSON.stringify(this.src.slice(this.i, this.i + 24))}`,
			);
		}
		const lit = this.readString(q);
		this.record(kind, lit.start, lit.end, lit.text);
	}

	private record(kind: ImportKind, start: number, end: number, specifier: string): void {
		if (this.src.slice(start, end) !== specifier) {
			throw new ScanImportsError(
				`internal: specifier range ${start}..${end} does not match ${JSON.stringify(specifier)}`,
			);
		}
		if (specifier.length === 0) throw new ScanImportsError("empty module specifier");
		if (specifier.includes("\\")) {
			throw new ScanImportsError(`module specifier must not contain escape sequences: ${JSON.stringify(specifier)}`);
		}
		this.out.push({ kind, start, end, specifier });
	}

	/** Returns the raw (unescaped) text between the quotes; `this.i` ends after the closing quote. */
	private readString(quote: string): { start: number; end: number; text: string } {
		const start = this.i + 1;
		let j = start;
		while (j < this.src.length) {
			const c = this.src[j]!;
			if (c === "\\") {
				j += 2;
				continue;
			}
			if (c === quote) {
				this.i = j + 1;
				this.prev = "string";
				return { start, end: j, text: this.src.slice(start, j) };
			}
			if (c === "\n") throw new ScanImportsError(`unterminated string literal at index ${start - 1}`);
			j++;
		}
		throw new ScanImportsError("unterminated string literal at end of source");
	}

	private readTemplate(): void {
		this.i++;
		const n = this.src.length;
		while (this.i < n) {
			const c = this.src[this.i]!;
			if (c === "\\") {
				this.i += 2;
				continue;
			}
			if (c === "`") {
				this.i++;
				this.prev = "template";
				return;
			}
			if (c === "$" && this.src[this.i + 1] === "{") {
				this.i += 2;
				this.scanCode(true);
				if (this.src[this.i] !== "}") throw new ScanImportsError("unterminated template substitution");
				this.i++;
				continue;
			}
			this.i++;
		}
		throw new ScanImportsError("unterminated template literal");
	}

	private tryRegex(): boolean {
		let j = this.i + 1;
		const n = this.src.length;
		let inClass = false;
		while (j < n) {
			const c = this.src[j]!;
			if (c === "\\") {
				j += 2;
				continue;
			}
			if (c === "\n" || c === "\r") return false;
			if (inClass) {
				if (c === "]") inClass = false;
				j++;
				continue;
			}
			if (c === "[") {
				inClass = true;
				j++;
				continue;
			}
			if (c === "/") {
				j++;
				while (j < n && REGEX_FLAG.test(this.src[j]!)) j++;
				this.i = j;
				this.prev = "regex";
				return true;
			}
			j++;
		}
		return false;
	}

	private regexAllowed(): boolean {
		const p = this.prev;
		if (p === "") return true;
		if (p === ")" || p === "]") return false;
		const c0 = p[0]!;
		if (ID_START.test(c0) || (c0 >= "0" && c0 <= "9")) return KEYWORDS_BEFORE_REGEX.has(p);
		return true;
	}

	private skipTrivia(): void {
		for (;;) {
			const c = this.src[this.i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f") {
				this.i++;
				continue;
			}
			if (c === "/" && this.src[this.i + 1] === "/") {
				this.skipLineComment();
				continue;
			}
			if (c === "/" && this.src[this.i + 1] === "*") {
				this.skipBlockComment();
				continue;
			}
			return;
		}
	}

	private skipLineComment(): void {
		this.i += 2;
		while (this.i < this.src.length && this.src[this.i] !== "\n" && this.src[this.i] !== "\r") this.i++;
	}

	private skipBlockComment(): void {
		const end = this.src.indexOf("*/", this.i + 2);
		if (end < 0) throw new ScanImportsError("unterminated block comment");
		this.i = end + 2;
	}

	private readWord(): string {
		const end = this.wordEnd(this.i);
		const word = this.src.slice(this.i, end);
		this.i = end;
		return word;
	}

	private tryWord(word: string): boolean {
		if (!ID_START.test(this.src[this.i] ?? "")) return false;
		const end = this.wordEnd(this.i);
		if (this.src.slice(this.i, end) !== word) return false;
		this.i = end;
		this.prev = word;
		return true;
	}

	private wordEnd(from: number): number {
		let j = from;
		while (j < this.src.length && ID_CONTINUE.test(this.src[j]!)) j++;
		return j;
	}

	private readNumber(): void {
		let j = this.i;
		const n = this.src.length;
		if (this.src[j] === "0" && HEX_OR_RADIX_PREFIX.test(this.src[j + 1] ?? "")) j += 2;
		for (;;) {
			while (j < n && (ID_CONTINUE.test(this.src[j]!) || this.src[j] === ".")) j++;
			const c = this.src[j];
			const p = j > 0 ? this.src[j - 1] : "";
			if ((c === "+" || c === "-") && (p === "e" || p === "E")) {
				j++;
				continue;
			}
			break;
		}
		this.i = j;
		this.prev = "number";
	}

	private readPunct(): void {
		for (const op of OPERATORS) {
			if (this.src.startsWith(op, this.i)) {
				this.i += op.length;
				this.prev = op;
				return;
			}
		}
		this.prev = this.src[this.i]!;
		this.i++;
	}
}

export function scanImports(source: string): ScannedImport[] {
	return new ImportScanner(source).scan();
}
