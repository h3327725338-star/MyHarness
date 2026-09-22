/**
 * Command Code credential discovery.
 *
 * This module reuses Command Code's *existing* login state rather than
 * introducing a second login protocol. After a browser sign-in the Command Code
 * client persists a long-lived API key to `~/.commandcode/auth.json`; the
 * `COMMAND_CODE_API_KEY` environment variable overrides it.
 *
 * There is no refresh token: the stored key does not expire on a timer, so a
 * re-login is only needed when the platform rejects the key (401).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@myharness/ai";

/** Directory the Command Code client keeps its state in, relative to `$HOME`. */
export const COMMAND_CODE_DIRECTORY_NAME = ".commandcode";

/** Auth file name used by the production Command Code environment. */
export const COMMAND_CODE_AUTH_FILE_NAME = "auth.json";

/** Environment variable that overrides the stored key. */
export const COMMAND_CODE_API_KEY_ENV_VAR = "COMMAND_CODE_API_KEY";

/**
 * Shape of `~/.commandcode/auth.json`. Only `apiKey` is read; the remaining
 * fields exist so callers can surface a non-secret account label.
 */
export interface CommandCodeAuthFile {
	apiKey?: string;
	userId?: string;
	userName?: string;
	keyName?: string;
	authenticatedAt?: string;
}

/** Resolved Command Code credential plus a display-safe provenance label. */
export interface CommandCodeCredential {
	value: string;
	/** Human-readable, secret-free origin, e.g. `~/.commandcode/auth.json`. */
	source: string;
	/** Non-secret account display name, when the auth file records one. */
	accountName?: string;
}

/** Absolute path of the auth file written by the Command Code client. */
export function getCommandCodeAuthPath(home: string = homedir()): string {
	return join(home, COMMAND_CODE_DIRECTORY_NAME, COMMAND_CODE_AUTH_FILE_NAME);
}

/** Read and parse the auth file. Returns undefined when absent or malformed. */
export async function readCommandCodeAuthFile(
	path: string = getCommandCodeAuthPath(),
): Promise<CommandCodeAuthFile | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as CommandCodeAuthFile;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the effective credential: environment override first, then the
 * shared login state. Side-effect free and never network-bound, so it is safe
 * as an availability check.
 */
export async function resolveCommandCodeCredential(
	ctx: AuthContext,
	readAuthFile: () => Promise<CommandCodeAuthFile | undefined> = readCommandCodeAuthFile,
): Promise<CommandCodeCredential | undefined> {
	const envKey = (await ctx.env(COMMAND_CODE_API_KEY_ENV_VAR))?.trim();
	if (envKey) return { value: envKey, source: COMMAND_CODE_API_KEY_ENV_VAR };

	const auth = await readAuthFile();
	const fileKey = auth?.apiKey?.trim();
	if (!fileKey) return undefined;

	return {
		value: fileKey,
		source: `~/${COMMAND_CODE_DIRECTORY_NAME}/${COMMAND_CODE_AUTH_FILE_NAME}`,
		accountName: auth?.userName?.trim() || auth?.keyName?.trim() || undefined,
	};
}
