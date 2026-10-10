/**
 * Per-session shell state records for the bash/pwsh tools' `preserve_state`
 * mode (no PTY: every command still runs in a fresh shell process).
 *
 * When preserve_state is enabled the command text gets a marked probe block
 * appended AFTER the user command (`#MYHARNESS_STATE_PROBE_BEGIN#` ...
 * `#MYHARNESS_STATE_PROBE_END#`). The probe prints the shell's final cwd and
 * its exported environment. The tool parses the probe from the returned
 * snapshot tail, strips it from the visible output, and stores a
 * ShellSessionRecord. The next preserve_state call spawns with the recorded
 * cwd and env deltas applied, so `cd`/`export` effects survive across calls.
 *
 * Design guarantees:
 * - Default mode (preserve_state absent/false) never appends anything and the
 *   execution path is byte-for-byte the old one.
 * - Any parse failure (missing markers, malformed probe, truncated output)
 *   silently keeps the previous record and reports no error.
 * - The wrapper is appended only inside execute(), after guard extensions
 *   have already inspected `event.input.command`, so read-only/write guards
 *   that parse the raw command text are unaffected.
 */

import { existsSync } from "node:fs";
import { open, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROBE_BEGIN_MARKER = "#MYHARNESS_STATE_PROBE_BEGIN#";
export const PROBE_END_MARKER = "#MYHARNESS_STATE_PROBE_END#";

export type ShellProbeKind = "bash" | "pwsh";

export interface ShellSessionRecord {
	/** Working directory recorded from the last successful probe. */
	cwd: string;
	/** Environment keys whose values changed (applied on top of the base env). */
	envOverrides: Record<string, string>;
	/** Environment keys the command removed (deleted from the base env). */
	removedEnvKeys: string[];
	updatedAt: number;
}

const MAX_SESSION_ENV_KEYS = 256;

// Shell-managed bookkeeping variables that appear in bash `export -p` output
// but are not user environment intent. PWD stays recorded because it is
// consistent with the recorded cwd.
const BASH_NOISE_ENV_KEYS = new Set(["_", "!", "SHLVL", "OLDPWD", "BASH_EXECUTION_STRING", "BASHOPTS", "SHELLOPTS"]);

const records = new Map<string, ShellSessionRecord>();

export function getShellSessionRecord(sessionKey: string): ShellSessionRecord | undefined {
	return records.get(sessionKey);
}

/** Test helper: drop all per-session records. */
export function resetShellSessionRecords(): void {
	records.clear();
}

/** Build the probe block appended to a bash command in preserve_state mode. */
export function buildBashProbeSuffix(): string {
	return (
		`\n__myharness_ec=$?` +
		`\nprintf '\\n${PROBE_BEGIN_MARKER}\\n'` +
		`\n(pwd -W 2>/dev/null || pwd -P 2>/dev/null || pwd)` +
		`\nexport -p` +
		`\nprintf '%s\\n' '${PROBE_END_MARKER}'` +
		`\nexit $__myharness_ec`
	);
}

/** Build the probe block appended to a PowerShell command in preserve_state mode. */
export function buildPwshProbeSuffix(): string {
	return (
		`\n$__myharness_ec = $LASTEXITCODE; if (-not $?) { if ($null -eq $__myharness_ec -or $__myharness_ec -eq 0) { $__myharness_ec = 1 } }` +
		`\nWrite-Output '${PROBE_BEGIN_MARKER}'` +
		`\n(Get-Location).ProviderPath` +
		`\nGet-ChildItem Env: | ForEach-Object { [string]$_.Name + [char]31 + [string]$_.Value }` +
		`\nWrite-Output '${PROBE_END_MARKER}'` +
		`\nif ($null -ne $__myharness_ec -and $__myharness_ec -ne 0) { exit $__myharness_ec }`
	);
}

/**
 * Locate the (last) probe block in the output text. Returns the user-visible
 * output with the block removed plus the raw probe body, or undefined when
 * the block is incomplete (parse failure: keep old record, show text as-is).
 */
export function splitProbeBlock(text: string): { output: string; probe: string } | undefined {
	const begin = text.lastIndexOf(PROBE_BEGIN_MARKER);
	if (begin === -1) return undefined;
	const afterBegin = begin + PROBE_BEGIN_MARKER.length;
	const end = text.indexOf(PROBE_END_MARKER, afterBegin);
	if (end === -1) return undefined;
	const probe = text
		.slice(afterBegin, end)
		.replace(/^\r?\n/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	// Remove the probe block plus the newline the wrapper prepended before BEGIN.
	let cutStart = begin;
	while (cutStart > 0 && (text[cutStart - 1] === "\n" || text[cutStart - 1] === "\r")) cutStart -= 1;
	const output = text.slice(0, cutStart) + text.slice(end + PROBE_END_MARKER.length).replace(/^\r?\n/, "");
	return { output, probe };
}

/**
 * Strip the state probe block or an in-flight probe prefix from a partial
 * streaming output update, preventing probe markers and environment dump
 * leakage to listeners while preserve_state is enabled.
 */
export function stripProbeFromPartialOutput(text: string): string {
	const lastIndex = text.lastIndexOf(PROBE_BEGIN_MARKER);
	if (lastIndex !== -1) {
		let cutStart = lastIndex;
		while (cutStart > 0 && (text[cutStart - 1] === "\n" || text[cutStart - 1] === "\r")) {
			cutStart -= 1;
		}
		text = text.slice(0, cutStart);
	}
	const maxPrefixLen = Math.min(PROBE_BEGIN_MARKER.length - 1, text.length);
	for (let len = maxPrefixLen; len >= 1; len--) {
		const prefix = PROBE_BEGIN_MARKER.slice(0, len);
		if (text.endsWith(prefix)) {
			let cutStart = text.length - len;
			while (cutStart > 0 && (text[cutStart - 1] === "\n" || text[cutStart - 1] === "\r")) {
				cutStart -= 1;
			}
			return text.slice(0, cutStart);
		}
	}
	return text;
}

const MAX_PROBE_FILE_TAIL_BYTES = 1024 * 1024;
const PROBE_BEGIN_MARKER_BUFFER = Buffer.from(PROBE_BEGIN_MARKER, "utf8");

/**
 * Truncate the probe block from the end of a fullOutputPath temp file when
 * preserve_state is enabled, ensuring dumped environment variables never persist
 * on disk. Reads at most 1MB from the tail, finds the last PROBE_BEGIN_MARKER,
 * and truncates before it. Swallows any exception (best-effort).
 */
export async function truncateProbeFromFullOutputFile(filePath: string): Promise<void> {
	try {
		const fileStat = await stat(filePath);
		const fileSize = fileStat.size;
		if (fileSize === 0) return;
		const readLen = Math.min(fileSize, MAX_PROBE_FILE_TAIL_BYTES);
		const tailOffset = fileSize - readLen;
		let buffer = Buffer.allocUnsafe(readLen);
		const handle = await open(filePath, "r");
		try {
			const result = await handle.read(buffer, 0, readLen, tailOffset);
			buffer = buffer.subarray(0, result.bytesRead);
		} finally {
			await handle.close();
		}
		const relIndex = buffer.lastIndexOf(PROBE_BEGIN_MARKER_BUFFER);
		if (relIndex === -1) return;
		let cutRel = relIndex;
		while (cutRel > 0 && (buffer[cutRel - 1] === 0x0a || buffer[cutRel - 1] === 0x0d)) {
			cutRel -= 1;
		}
		const truncateOffset = tailOffset + cutRel;
		await truncate(filePath, truncateOffset);
	} catch {
		// Best-effort truncate: must never fail the tool call.
	}
}

function unquoteBashDeclareValue(raw: string): { value: string; closed: boolean } | undefined {
	if (raw.startsWith("$'")) {
		let value = "";
		let escaped = false;
		for (let index = 2; index < raw.length; index += 1) {
			const char = raw[index];
			if (escaped) {
				if (char === "\\") value += "\\";
				else if (char === "'") value += "'";
				else if (char === "n") value += "\n";
				else if (char === "r") value += "\r";
				else if (char === "t") value += "\t";
				else value += char;
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === "'") return { value, closed: true };
			value += char;
		}
		return { value, closed: false };
	}
	if (raw.startsWith("'")) {
		const end = raw.indexOf("'", 1);
		if (end !== -1) return { value: raw.slice(1, end), closed: true };
		return { value: raw.slice(1), closed: false };
	}
	if (!raw.startsWith('"')) {
		return { value: raw, closed: true };
	}
	let value = "";
	let escaped = false;
	for (let index = 1; index < raw.length; index += 1) {
		const char = raw[index];
		if (escaped) {
			// bash only escapes $ ` \ " inside declare -x double quotes.
			value += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') return { value, closed: true };
		value += char;
	}
	// Unbalanced quote: the value contains a real newline; the rest continues
	// on the following output line. Signal "not closed" for the caller.
	if (escaped) value += "\\";
	return { value, closed: false };
}

/** Parse `export -p` output into an env map. Skip malformed lines defensively. */
export function parseBashProbe(probe: string): { cwd: string; env: Record<string, string> } | undefined {
	const lines = probe.split("\n");
	const cwd = lines[0]?.trim();
	if (!cwd) return undefined;
	const env: Record<string, string> = {};
	let index = 1;
	while (index < lines.length) {
		const line = lines[index];
		if (line === "") {
			index += 1;
			continue;
		}
		// Exported-without-value entries are skipped, not recorded.
		if (/^declare -x [A-Za-z_][A-Za-z0-9_]*$/.test(line)) {
			index += 1;
			continue;
		}
		const match = /^declare -x ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match) {
			index += 1;
			continue;
		}
		const parsed = unquoteBashDeclareValue(match[2]);
		if (!parsed) {
			index += 1;
			continue;
		}
		let value = parsed.value;
		index += 1;
		if (!parsed.closed) {
			// Multi-line value: consume lines until the quote closes.
			for (;;) {
				if (index >= lines.length) break;
				const continuation = unquoteBashDeclareValue(`"${value}\n${lines[index]}`);
				if (!continuation) {
					index += 1;
					break;
				}
				value = continuation.value;
				index += 1;
				if (continuation.closed) break;
			}
		}
		env[match[1]] = value;
	}
	return { cwd, env };
}

/** Parse the pwsh probe body: cwd line, then `NAME<0x1F>VALUE` lines. */
export function parsePwshProbe(probe: string): { cwd: string; env: Record<string, string> } | undefined {
	const lines = probe.split("\n").filter((line) => line !== "");
	const cwd = lines[0]?.trim();
	if (!cwd) return undefined;
	const env: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		const separator = line.indexOf("\u001f");
		if (separator <= 0) return undefined;
		env[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return { cwd, env };
}

/**
 * Diff a probe env snapshot against the environment the command was spawned
 * with, producing the deltas to store in the session record.
 */
export function diffProbeEnv(
	baseEnv: NodeJS.ProcessEnv,
	probeEnv: Record<string, string>,
	caseInsensitive: boolean,
): { envOverrides: Record<string, string>; removedEnvKeys: string[] } | undefined {
	const fold = (key: string) => (caseInsensitive ? key.toLowerCase() : key);
	const probeByFold = new Map<string, string>();
	for (const [key, value] of Object.entries(probeEnv)) probeByFold.set(fold(key), value);

	const envOverrides: Record<string, string> = {};
	for (const [probeKey, probeValue] of Object.entries(probeEnv)) {
		let changed = true;
		for (const [baseKey, baseValue] of Object.entries(baseEnv)) {
			if (fold(baseKey) === fold(probeKey)) {
				changed = baseValue !== probeValue;
				break;
			}
		}
		if (changed) envOverrides[probeKey] = probeValue;
		if (Object.keys(envOverrides).length > MAX_SESSION_ENV_KEYS) return undefined;
	}

	const removedEnvKeys: string[] = [];
	for (const baseKey of Object.keys(baseEnv)) {
		if (!probeByFold.has(fold(baseKey))) removedEnvKeys.push(baseKey);
		if (removedEnvKeys.length > MAX_SESSION_ENV_KEYS) return undefined;
	}
	return { envOverrides, removedEnvKeys };
}

/** Apply a session record on top of a freshly built base env. */
export function applySessionEnv(baseEnv: NodeJS.ProcessEnv, record: ShellSessionRecord | undefined): NodeJS.ProcessEnv {
	if (!record) return baseEnv;
	const caseInsensitive = process.platform === "win32";
	const fold = (key: string) => (caseInsensitive ? key.toLowerCase() : key);
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	const removeFolded = new Set(record.removedEnvKeys.map(fold));
	for (const key of Object.keys(env)) {
		if (removeFolded.has(fold(key))) delete env[key];
	}
	for (const [key, value] of Object.entries(record.envOverrides)) {
		if (caseInsensitive) {
			for (const existing of Object.keys(env)) {
				if (existing.toLowerCase() === key.toLowerCase() && existing !== key) delete env[existing];
			}
		}
		env[key] = value;
	}
	return env;
}

/**
 * Parse the probe from the finished output text. On success updates the
 * session record and returns the stripped output; on any failure leaves the
 * record untouched and returns undefined (caller keeps the original text).
 */
export function updateSessionFromProbeText(
	sessionKey: string,
	kind: ShellProbeKind,
	outputText: string,
	spawnEnv: NodeJS.ProcessEnv,
): { output: string; record: ShellSessionRecord } | undefined {
	try {
		const split = splitProbeBlock(outputText);
		if (!split) return undefined;
		const parsed = kind === "bash" ? parseBashProbe(split.probe) : parsePwshProbe(split.probe);
		if (!parsed) return undefined;
		const deltas = diffProbeEnv(spawnEnv, parsed.env, process.platform === "win32");
		if (!deltas) return undefined;
		if (kind === "bash") {
			for (const noise of BASH_NOISE_ENV_KEYS) delete deltas.envOverrides[noise];
			deltas.removedEnvKeys = deltas.removedEnvKeys.filter((key) => !BASH_NOISE_ENV_KEYS.has(key));
		}
		const record: ShellSessionRecord = {
			cwd: parsed.cwd,
			envOverrides: deltas.envOverrides,
			removedEnvKeys: deltas.removedEnvKeys,
			updatedAt: Date.now(),
		};
		records.set(sessionKey, record);
		return { output: split.output, record };
	} catch {
		return undefined;
	}
}

/**
 * Resolve the effective spawn cwd/env for a preserve_state call. A deleted
 * directory falls back to the session cwd (the record stops advancing).
 */
export function resolvePreservedSpawnTarget(
	sessionKey: string,
	defaultCwd: string,
	baseEnv: NodeJS.ProcessEnv,
): { cwd: string; env: NodeJS.ProcessEnv } {
	const record = records.get(sessionKey);
	if (!record) return { cwd: defaultCwd, env: baseEnv };
	let cwd = defaultCwd;
	if (record.cwd) {
		if (existsSync(record.cwd)) {
			cwd = record.cwd;
		} else if (process.platform === "win32") {
			const driveMatch = /^\/([a-zA-Z])\/(.*)$/.exec(record.cwd);
			if (driveMatch) {
				const drivePath = `${driveMatch[1]}:/${driveMatch[2]}`;
				if (existsSync(drivePath)) cwd = drivePath;
			} else if (record.cwd.startsWith("/tmp/") || record.cwd === "/tmp") {
				const tmpPath = join(tmpdir(), record.cwd.slice(5));
				if (existsSync(tmpPath)) cwd = tmpPath;
			}
		}
	}
	return { cwd, env: applySessionEnv(baseEnv, record) };
}
