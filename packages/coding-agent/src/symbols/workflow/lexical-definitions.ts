import { escapeRegExp } from "../lexical/search.ts";

/**
 * Heuristic declaration lines for files no language server covers (or when
 * the server is unavailable). Every result built from these is labelled
 * lexical: the line looks like a declaration, but its kind, scope and extent
 * are guesses.
 */

const KEYWORD_DECLARATION =
	/^\s*(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|virtual|inline|unsafe|pub(?:\([^)]*\))?|open|sealed|data|suspend|extern|const)\s+)*(?:function\*?|def|class|interface|struct|enum|trait|impl|fn|func|type|module|namespace|object|record|protocol|extension|sub|proc|fun|val|var|let|const)\s+([A-Za-z_$][\w$]*)/;
const GO_METHOD = /^\s*func\s*\([^)]*\)\s*([A-Za-z_]\w*)\s*[[(]/;
const ASSIGNED_FUNCTION =
	/^\s*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const C_LIKE_METHOD =
	/^\s*(?:[\w$:<>,[\]*&?]+\s+)+\**&?([A-Za-z_$~][\w$]*)\s*\([^;{}]*\)?\s*(?:const\s*)?(?:->\s*[^{;]+)?\s*(?:throws\s+[\w.,\s]+)?\{?\s*$/;
const NOT_A_DECLARATION =
	/^\s*(?:return|if|else|for|while|switch|case|catch|throw|new|await|yield|do|try|using|import|from|#include)\b/;

/** The declared name when a line looks like a declaration, else undefined. */
export function declarationNameOnLine(line: string): string | undefined {
	if (NOT_A_DECLARATION.test(line)) return undefined;
	return (
		KEYWORD_DECLARATION.exec(line)?.[1] ??
		GO_METHOD.exec(line)?.[1] ??
		ASSIGNED_FUNCTION.exec(line)?.[1] ??
		C_LIKE_METHOD.exec(line)?.[1]
	);
}

/** A ripgrep pattern for lines that may declare `name`. */
export function declarationPatternFor(name: string): string {
	const escaped = escapeRegExp(name);
	return [
		`\\b(function\\*?|def|class|interface|struct|enum|trait|fn|func|type|module|namespace|object|record|protocol|fun|sub|proc)\\s+${escaped}\\b`,
		`\\b${escaped}\\s*[:=]\\s*(async\\s+)?(function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)`,
		`func\\s*\\([^)]*\\)\\s*${escaped}\\b`,
		`[\\w>\\]*&]\\s+\\*?${escaped}\\s*\\(`,
	].join("|");
}

const COMMENT_OR_DECORATION = [
	/^@[\w.]+/, // decorators and annotations (TS, Python, Java, Kotlin, PHP 8 docs)
	/^#\[/, // Rust and PHP attributes
	/^\[[A-Za-z_][\w.]*(?:\(.*\))?\]$/, // C# attributes
	/^\/\/\/?/, // line comments and doc comments
	/^\/\*\*?/, // block comment start
	/^\*(?!\w)/, // block comment continuation
	/^\*\//, // block comment end
	/^--/, // SQL, Lua
	/^<!--/, // markup comments
];

/**
 * Comments, doc comments, decorators and attributes directly above a
 * declaration (no blank line in between) belong to it: a slice without them
 * can hide the contract (`@deprecated`, `@staticmethod`, `#[test]`).
 */
export function isLeadingDecorationLine(line: string, language: string | undefined): boolean {
	const trimmed = line.trim();
	if (trimmed === "") return false;
	if (trimmed.startsWith("#") && !trimmed.startsWith("#[")) {
		// `#` starts a comment in Python, Ruby, shell and YAML; in C-family languages it is the preprocessor.
		return language !== "c" && language !== "cpp" && language !== "csharp";
	}
	return COMMENT_OR_DECORATION.some((pattern) => pattern.test(trimmed));
}

/** First line of the leading comment/decorator block that ends right above `line`. */
export function leadingDecorationStart(
	lines: readonly string[],
	line: number,
	language: string | undefined,
	maxLines = 40,
): number {
	let start = line;
	while (start > 0 && line - start < maxLines && isLeadingDecorationLine(lines[start - 1] ?? "", language)) start--;
	return start;
}

const IMPORT_LINE = [
	/^\s*import\b/, // TS, JS, Python, Java, Kotlin, Go, Swift, Scala
	/^\s*from\s+\S+\s+import\b/, // Python
	/^\s*export\s+(?:\*|\{[^}]*\})\s+from\b/, // TS re-exports
	/^\s*(?:const|let|var)\s+.+=\s*require\(/, // CommonJS
	/^\s*using\s+[\w.]+\s*;/, // C#
	/^\s*use\s+[\w:{}, *]+;/, // Rust, PHP
	/^\s*#\s*include\b/, // C, C++
	/^\s*require(?:_relative|_once)?\b/, // Ruby, PHP
	/^\s*package\s+[\w.]+/, // Java, Kotlin, Go
	/^\s*(?:mod|extern\s+crate)\s+\w+\s*;/, // Rust
	/^\s*"[^"]+"$/, // Go import block entries
	/^\s*\w+\s+"[^"]+"$/, // Go aliased import block entries
];

export function isImportLine(line: string): boolean {
	return IMPORT_LINE.some((pattern) => pattern.test(line));
}
