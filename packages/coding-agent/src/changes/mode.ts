/**
 * How much of change control is switched on for a workspace.
 *
 *   off     controlled changes still work when a tool asks for them; no gate is applied to edit/write
 *   assist  the default: edits are checked and recorded, problems are reported, and what is risky needs approval
 *   strict  nothing that cannot be checked is allowed: unverifiable entry points are refused, and a change that
 *           could not be verified never counts as verified
 */
export const CHANGE_CONTROL_MODES = ["off", "assist", "strict"] as const;

export type ChangeControlMode = (typeof CHANGE_CONTROL_MODES)[number];

export const DEFAULT_CHANGE_CONTROL_MODE: ChangeControlMode = "assist";

export function isChangeControlMode(value: unknown): value is ChangeControlMode {
	return typeof value === "string" && (CHANGE_CONTROL_MODES as readonly string[]).includes(value);
}
