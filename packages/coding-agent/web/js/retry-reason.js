import { N_, t } from "./i18n.js";

// One label per category of the shared backend enum (provider-failure.ts). `other` falls through to the text guess.
const CATEGORY_LABELS = {
	connect_timeout: N_("Connect timed out"),
	connect_failed: N_("Connect failed"),
	first_byte_timeout: N_("No response in time"),
	stream_idle_timeout: N_("Stream went silent"),
	disconnect: N_("Connection dropped"),
	rate_limited: N_("Rate limited"),
	upstream_overloaded: N_("Upstream overloaded"),
};

/** A short, readable cause for a provider error, for the one-line retry strip; the full text stays in the details. */
export function retryReason(message, category) {
	if (CATEGORY_LABELS[category]) return t(CATEGORY_LABELS[category]);
	const text = String(message ?? "");
	const code = /\b([45]\d\d)\b/.exec(text)?.[1];
	if (code === "429" || /rate.?limit|too many requests/i.test(text)) return t("Rate limited");
	if (code === "529" || /overload/i.test(text)) return t("Upstream overloaded");
	if (/time(?:d)?[ -]?out|ETIMEDOUT|deadline/i.test(text)) return t("Request timed out");
	if (/terminated|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network|connection (?:error|reset|closed|lost)|stream (?:ended|closed)/i.test(text)) return t("Connection interrupted");
	if (/empty|no content|without (?:a )?(?:response|content)/i.test(text)) return t("Empty response");
	if (code) return t("Upstream error {code}", { code });
	return t("Request failed");
}
