// The Coding / General switch in the sidebar's top-left corner, and the short summary of tasks of the other mode.
// Both read the server's slot list (`/api/slots`, `slots` events); nothing here keeps a task state of its own.
import { html, useLayoutEffect, useMemo, useRef, useState, Icon, Popover, motionEnabled } from "./ui.js";
import { modeIconPaths } from "./mode-icon.js";
import { useStore } from "./store.js";
import { actions } from "./actions.js";
import { modeSignal, modeTasks, otherMode, taskCounts } from "./chat-modes.js";
import { N_, t } from "./i18n.js";
import { chatTitle } from "./util.js";

const MODE_LABEL = { coding: N_("Coding"), general: N_("General") };

/** How each signal looks: running breathes, the others are static marks that differ in shape and colour. */
const SIGNAL_UI = {
	running: { label: N_("Running"), icon: null },
	waiting: { label: N_("Waiting for you"), icon: "clock", cls: "c-warn" },
	failed: { label: N_("Failed"), icon: "alertCircle", cls: "c-danger" },
	partial: { label: N_("Partially completed"), icon: "alertTriangle", cls: "c-warn" },
	completed: { label: N_("Completed"), icon: "checkCircle", cls: "c-ok" },
	cancelled: { label: N_("Cancelled"), icon: "stopCircle", cls: "c-dim" },
};

function SignalMark({ signal, mode }) {
	if (!signal) return null;
	if (signal === "running") return html`<span class=${`mode-breath ${mode}`} title=${t("Running")} />`;
	const ui = SIGNAL_UI[signal];
	return html`<span class=${`mode-mark ${ui.cls}`} title=${t(ui.label)}><${Icon} name=${ui.icon} size=${11} sw=${2.2} /></span>`;
}

/** A soft sliding knob with a continuously morphing icon; task marks stay attached to their own side. */
export function ModeSwitch() {
	const mode = useStore((s) => s.view.modeIntent || s.view.chatMode);
	const slots = useStore((s) => s.slots);
	const activeSlot = useStore((s) => s.activeSlot);
	const signals = useMemo(() => ({ coding: modeSignal(slots, "coding", activeSlot), general: modeSignal(slots, "general", activeSlot) }), [slots, activeSlot]);
	const next = otherMode(mode);
	const label = t("Switch to {mode}", { mode: t(MODE_LABEL[next]) });
	const knob = useRef(null);
	const paths = useRef([]);
	const progress = useRef(mode === "general" ? 1 : 0);
	const previous = useRef(mode);
	useLayoutEffect(() => {
		const target = mode === "general" ? 1 : 0;
		const paint = (value) => {
			progress.current = value;
			modeIconPaths(value).forEach((d, i) => paths.current[i]?.setAttribute("d", d));
		};
		if (previous.current === mode || !motionEnabled()) {
			previous.current = mode;
			paint(target);
			return;
		}
		previous.current = mode;
		const from = progress.current;
		paint(from);
		const start = performance.now();
		let frame;
		const tick = (now) => {
			const t = Math.min(1, (now - start) / 520);
			paint(from + (target - from) * (t * t * (3 - 2 * t)));
			if (t < 1) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		const x = target ? 28 : 0;
		const oldX = from * 28;
		const direction = target ? 1 : -1;
		const animation = knob.current?.animate?.([
			{ transform: `translateX(${oldX}px) scale(1, 1)`, borderRadius: "50%" },
			{ transform: `translateX(${oldX + direction * 12}px) scale(1.3, .78)`, borderRadius: "42%", offset: .35 },
			{ transform: `translateX(${x + direction * 2}px) scale(.88, 1.12)`, borderRadius: "48%", offset: .7 },
			{ transform: `translateX(${x - direction}px) scale(1.05, .96)`, borderRadius: "50%", offset: .87 },
			{ transform: `translateX(${x}px) scale(1, 1)`, borderRadius: "50%" },
		], { duration: 580, easing: "cubic-bezier(.25,.1,.25,1)" });
		return () => { cancelAnimationFrame(frame); animation?.cancel(); };
	}, [mode]);
	return html`<button class=${`mode-switch ${mode}`} role="switch" aria-checked=${mode === "general"} aria-label=${t("General mode")} title=${`${t(MODE_LABEL[mode])} · ${label}`} onClick=${() => actions.switchMode(next)}>
		<span class="mode-side coding" aria-hidden="true"><${Icon} name="terminal" size=${11} sw=${2} /><span class="mode-signal"><${SignalMark} signal=${signals.coding} mode="coding" /></span></span>
		<span class="mode-side general" aria-hidden="true"><${Icon} name="chat" size=${11} sw=${2} /><span class="mode-signal"><${SignalMark} signal=${signals.general} mode="general" /></span></span>
		<span ref=${knob} class="mode-knob" aria-hidden="true"><svg class="mode-morph-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${modeIconPaths(mode === "general" ? 1 : 0).map((d, i) => html`<path ref=${(node) => { paths.current[i] = node; }} d=${d} />`)}</svg></span>
	</button>`;
}

const COUNT_TEXT = {
	waiting: N_("{n} waiting"),
	failed: N_("{n} failed"),
	partial: N_("{n} partial"),
	completed: N_("{n} completed"),
	cancelled: N_("{n} cancelled"),
};

/**
 * Results and pending answers of the mode that is not on screen: one short line (a single task names itself), which
 * opens the list of its tasks; a task in the list opens its chat (and with it its mode).
 */
export function ModeTasks() {
	const mode = useStore((s) => s.view.chatMode);
	const slots = useStore((s) => s.slots);
	const activeSlot = useStore((s) => s.activeSlot);
	const anchor = useRef(null);
	const [open, setOpen] = useState(false);
	const hidden = otherMode(mode);
	const tasks = useMemo(() => modeTasks(slots, hidden, activeSlot), [slots, hidden, activeSlot]);
	const counts = taskCounts(tasks);
	const results = Object.values(counts).reduce((sum, n) => sum + n, 0);
	if (!results) return null;
	const label = (slot) => slot.name || (slot.firstMessage ? chatTitle(slot) : t("New chat"));
	const single = tasks.length === 1 ? tasks[0] : null;
	const summary = single
		? `${t(SIGNAL_UI[single.signal].label)} · ${label(single.slot)}`
		: Object.keys(COUNT_TEXT).filter((key) => counts[key]).map((key) => t(COUNT_TEXT[key], { n: counts[key] })).join(" · ");
	const go = (slot) => {
		setOpen(false);
		actions.openTask(slot);
	};
	return html`<span ref=${anchor} class="mode-tasks-anchor">
		<button class=${`mode-tasks ${hidden}`} aria-haspopup="menu" aria-expanded=${open} title=${t("Tasks in {mode}", { mode: t(MODE_LABEL[hidden]) })} onClick=${() => setOpen(!open)}>
			<span class=${`mode-tag ${hidden}`}>${t(MODE_LABEL[hidden])}</span><span class="truncate">${summary}</span>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} width=${280} maxHeight=${340}>
			<div class="pop-head dim">${t("Tasks in {mode}", { mode: t(MODE_LABEL[hidden]) })}</div>
			${tasks.map(({ slot, signal }) => html`<button key=${slot.slot} class="pop-item mode-task" role="menuitem" onClick=${() => go(slot.slot)} title=${t(SIGNAL_UI[signal].label)}>
				<span class="mode-task-mark"><${SignalMark} signal=${signal} mode=${hidden} /></span><span class="truncate grow">${label(slot)}</span><span class="dim mode-task-state">${t(SIGNAL_UI[signal].label)}</span>
			</button>`)}
		<//>
	</span>`;
}
