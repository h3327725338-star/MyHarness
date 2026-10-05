// Earlier process blocks describe local work; only the last block carries the whole task's status.
import { t } from "./i18n.js";
import { fmtDuration, plural } from "./util.js";
import { OUTCOME_LABEL } from "./turns.js";

export const OUTCOME_ICON = { completed: "checkCircle", partial: "alertTriangle", failed: "alertCircle", cancelled: "stopCircle", waiting: "clock", unanswered: "alertCircle" };

function summaryText({ outcome, duration, stats, changeCount }) {
	const bits = [];
	if (stats.actions) bits.push(plural(stats.actions, "action"));
	if (changeCount) bits.push(t("{files} changed", { files: plural(changeCount, "file") }));
	const tail = bits.length ? ` · ${bits.join(" · ")}` : "";
	const dur = duration ? fmtDuration(duration) : "";
	switch (outcome) {
		case "completed":
			return `${dur ? t("Worked for {duration}", { duration: dur }) : t("Worked")}${tail}`;
		case "partial":
			return `${t("Partially completed")}${dur ? ` · ${dur}` : ""}${tail}`;
		case "failed":
			return `${dur ? t("Failed after {duration}", { duration: dur }) : t("Failed")}${tail}`;
		case "cancelled":
			return `${dur ? t("Cancelled after {duration}", { duration: dur }) : t("Cancelled")}${tail}`;
		default:
			return `${OUTCOME_LABEL[outcome] ? t(OUTCOME_LABEL[outcome]) : outcome}${tail}`;
	}
}

export function processSummaryState({ last, running, compacting, outcome, duration, stats, changeCount }) {
	const live = !!(last && running && !compacting);
	if (!last) {
		return { live: false, icon: "list", label: stats.actions ? plural(stats.actions, "action") : t("Reasoning"), outcome: "neutral" };
	}
	return {
		live,
		icon: OUTCOME_ICON[outcome] || (outcome === "running" ? "clock" : "checkCircle"),
		label: live ? "" : summaryText({ outcome, duration, stats, changeCount }),
		outcome,
	};
}
