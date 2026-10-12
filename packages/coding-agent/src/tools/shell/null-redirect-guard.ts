/**
 * Guard against cmd-style `>nul` redirects in bash commands.
 *
 * `nul` is a cmd/PowerShell-ism. bash (including Git-Bash on Windows) has no
 * `nul` device, so `... >nul` / `... 2>nul` silently creates a real file named
 * `nul` in the working directory — and `nul` is a Windows reserved device name
 * that Git cannot index, so it also breaks Git checkpoints and commits.
 *
 * This scanner is quote-aware (single/double quotes and backslash escapes are
 * skipped). Heredoc bodies are not specially handled: a heredoc that literally
 * contains `>nul` text is flagged too, which is rare and fail-safe.
 */

/** Redirect target basenames that mean "the Windows NUL device was intended". */
const NUL_TARGET = /^nul(\..*)?$/i;

/** Characters that end an unquoted redirect target token. */
function isTargetEnd(char: string | undefined): boolean {
	return char === undefined || /[\s|;&<>()]/.test(char);
}

/**
 * Find the first cmd-style `>nul` redirect in a bash command.
 * Returns the offending snippet (e.g. `2>nul`), or undefined when clean.
 */
export function findBashNullDeviceRedirect(command: string): string | undefined {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index] as string;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char !== ">") continue;
		// Include a `2>`/`&>`-style prefix in the reported snippet.
		let start = index;
		const prefix = command[index - 1];
		if (prefix === "&" || (prefix !== undefined && /[0-9]/.test(prefix))) start = index - 1;
		let cursor = index + 1;
		if (command[cursor] === ">") cursor += 1; // `>>` append operator
		while (cursor < command.length && /\s/.test(command[cursor] as string)) cursor += 1;
		// `2>&1`-style fd duplication targets another descriptor, not a file.
		if (command[cursor] === "&") continue;
		let target: string;
		const quoteChar = command[cursor];
		if (quoteChar === "'" || quoteChar === '"') {
			const end = command.indexOf(quoteChar, cursor + 1);
			if (end === -1) continue;
			target = command.slice(cursor + 1, end);
			cursor = end + 1;
		} else {
			const targetStart = cursor;
			while (!isTargetEnd(command[cursor])) cursor += 1;
			target = command.slice(targetStart, cursor);
		}
		if (target === "" || target === "=") continue;
		const basename = target.split(/[\\/]/).at(-1) ?? "";
		if (NUL_TARGET.test(basename)) return command.slice(start, cursor);
		index = cursor - 1;
	}
	return undefined;
}
