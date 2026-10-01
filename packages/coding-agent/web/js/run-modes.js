// What a message sent while the agent is running does. The three behaviours map onto the real AgentSession mechanisms
// (steer / follow-up / interrupt, see actions.js submit); which one Enter uses is a setting (Settings → Conversation).
import { N_ } from "./i18n.js";

export const RUN_MODES = {
	steer: { label: N_("Steer"), long: N_("Steer the current run"), hint: N_("Delivered before the agent's next model step, after its current tool calls.") },
	followUp: { label: N_("Queue"), long: N_("Queue for after this run"), hint: N_("Waits until the agent has finished all of its work.") },
	interrupt: { label: N_("Interrupt"), long: N_("Interrupt and send"), hint: N_("Stops the current run right away, then sends this message.") },
};

export const DEFAULT_RUN_MODE = "steer";

/** A stored choice that is not one of the three behaviours falls back to the default. */
export const runModeOf = (value) => (Object.hasOwn(RUN_MODES, value) ? value : DEFAULT_RUN_MODE);
