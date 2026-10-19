/**
 * Shared text redaction for persisted diagnostics and runtime traces.
 *
 * This module deliberately does not impose a length limit. Callers that own a
 * resource boundary may apply their own cap after redaction; Final Report
 * diagnostics preserve the complete text already captured by the executor.
 */

/**
 * credential key 的单一事实源（whole-text regex 使用）。
 * 覆盖 api_key / api-key / apikey、access_token、auth/authorization、bearer、
 * cookie、credential、password、passphrase、private_key、secret。
 */
const CREDENTIAL_KEY_ALTERNATION =
	"api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|credential|password|passphrase|private[_-]?key|secret";

const CREDENTIAL_VALUE_PATTERN = new RegExp(
	`((?:${CREDENTIAL_KEY_ALTERNATION})\\s*(?:[:=]\\s*|\\s+))(["']?)[^\\s;&|"']+\\2`,
	"gi",
);

const SECRET_VALUE_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{12,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
	CREDENTIAL_VALUE_PATTERN,
];

/** Replace every recognised secret value with a redaction marker. */
export function redactSensitiveText(value: string): string {
	let result = value;
	for (const pattern of SECRET_VALUE_PATTERNS) result = result.replace(pattern, "[REDACTED]");
	return result;
}
