import type { Socket } from "node:net";
import type { RunState, RunStateSnapshot } from "../agent/runtime/run-state.ts";
import { RUN_STATE_LABELS } from "../agent/runtime/run-state.ts";
import { spawnProcess } from "./child-process.ts";

/** How the reminder is presented on the desktop. */
export type PopupNotificationStyle = "toast" | "window";

/** Outcome category of a terminal run, used for icon/tone and per-kind toggles. */
export type PopupNotificationKind = "completed" | "failed" | "interrupted";

export interface PopupNotificationContent {
	kind: PopupNotificationKind;
	/** Notification/dialog title, e.g. "MyHarness · my-project". */
	title: string;
	/** Popup body text; may contain newlines. */
	message: string;
}

/** A command that renders the popup when spawned, or undefined if unsupported. */
export interface PopupCommand {
	command: string;
	args: string[];
}

/** Map a RunState to the popup kind it should produce, or undefined for non-terminal states. */
export function popupKindForRunState(state: RunState): PopupNotificationKind | undefined {
	switch (state) {
		case "completed":
			return "completed";
		case "failed":
		case "blocked":
		case "timed_out":
			return "failed";
		case "cancelled":
		case "interrupted":
			return "interrupted";
		default:
			return undefined;
	}
}

/** Per-line cap so a long provider error does not blow up the popup. */
const MAX_LINE_LENGTH = 240;

function truncateLine(line: string): string {
	return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

/** Compact human-readable duration between two wall-clock stamps, if meaningful. */
function formatRunDuration(startedAt?: number, lastActivityAt?: number): string | undefined {
	if (!startedAt || !lastActivityAt || lastActivityAt <= startedAt) return undefined;
	const totalSeconds = Math.round((lastActivityAt - startedAt) / 1000);
	if (totalSeconds < 1) return undefined;
	if (totalSeconds < 60) return `用时 ${totalSeconds} 秒`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `用时 ${minutes} 分 ${seconds} 秒`;
	const hours = Math.floor(minutes / 60);
	return `用时 ${hours} 小时 ${minutes % 60} 分`;
}

/** Human-readable popup body for a terminal run-state snapshot. */
export function describeTerminalRunState(state: RunStateSnapshot): string {
	const lines: string[] = [];
	const activity = state.activity?.trim() || RUN_STATE_LABELS[state.state];
	lines.push(activity);
	const error = state.error?.trim();
	if (error && !activity.includes(error)) {
		lines.push(truncateLine(error));
	}
	const duration = formatRunDuration(state.startedAt, state.lastActivityAt);
	if (duration) {
		lines.push(duration);
	}
	return lines.join("\n");
}

/**
 * Build the platform command that renders the popup. Pure so tests can assert
 * on the generated scripts without spawning anything.
 */
export function buildPopupCommand(
	platform: NodeJS.Platform,
	style: PopupNotificationStyle,
	content: PopupNotificationContent,
): PopupCommand | undefined {
	switch (platform) {
		case "win32":
			return style === "window" ? buildWindowsMessageBoxCommand(content) : buildWindowsToastCommand(content);
		case "darwin":
			return buildMacOSCommand(style, content);
		case "linux":
			return buildLinuxCommand(style, content);
		default:
			return undefined;
	}
}

// Windows: Windows PowerShell 5.1 is always present; scripts are passed as
// -EncodedCommand (base64 UTF-16LE) so arbitrary text survives without shell
// quoting, and non-ASCII text is embedded as base64 UTF-8 to stay encoding-safe.

/**
 * AUMID borrowed from the Windows PowerShell start-menu shortcut so toasts are
 * attributed to a known app without registering a custom AppUserModelID.
 */
const WINDOWS_POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function base64Utf8(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function decodeBase64Utf8Statement(variable: string, base64: string): string {
	return `$${variable} = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}'))`;
}

function buildWindowsToastCommand(content: PopupNotificationContent): PopupCommand {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
		decodeBase64Utf8Statement("title", base64Utf8(content.title)),
		decodeBase64Utf8Statement("message", base64Utf8(content.message)),
		"$format = '<toast><visual><binding template=\"ToastGeneric\"><text>{0}</text><text>{1}</text></binding></visual></toast>'",
		"$xmlText = $format -f [Security.SecurityElement]::Escape($title), [Security.SecurityElement]::Escape($message)",
		"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
		"$xml.LoadXml($xmlText)",
		"$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
		`$appId = '${WINDOWS_POWERSHELL_APP_ID}'`,
		"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
	].join("\n");
	return {
		command: "powershell.exe",
		args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeScript(script)],
	};
}

const WINDOWS_MESSAGE_BOX_ICONS: Record<PopupNotificationKind, string> = {
	completed: "Information",
	failed: "Error",
	interrupted: "Warning",
};

function buildWindowsMessageBoxCommand(content: PopupNotificationContent): PopupCommand {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms | Out-Null",
		decodeBase64Utf8Statement("title", base64Utf8(content.title)),
		decodeBase64Utf8Statement("message", base64Utf8(content.message)),
		"$form = New-Object System.Windows.Forms.Form",
		"$form.TopMost = $true",
		`$null = [System.Windows.Forms.MessageBox]::Show($form, $message, $title, 'OK', '${WINDOWS_MESSAGE_BOX_ICONS[content.kind]}')`,
	].join("\n");
	return {
		command: "powershell.exe",
		args: [
			"-NoProfile",
			"-NonInteractive",
			"-STA",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			encodeScript(script),
		],
	};
}

function encodeScript(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

// macOS / Linux: pass text as argv (no shell involved); only AppleScript needs quoting.

function escapeAppleScriptString(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r\n|\r/g, "\n")
		.replace(/\n/g, "\\n");
}

function buildMacOSCommand(style: PopupNotificationStyle, content: PopupNotificationContent): PopupCommand {
	const title = escapeAppleScriptString(content.title);
	const message = escapeAppleScriptString(content.message);
	if (style === "window") {
		return {
			command: "osascript",
			args: [
				"-e",
				`display dialog "${message}" with title "${title}" buttons {"OK"} default button 1 giving up after 120`,
			],
		};
	}
	return { command: "osascript", args: ["-e", `display notification "${message}" with title "${title}"`] };
}

function buildLinuxCommand(style: PopupNotificationStyle, content: PopupNotificationContent): PopupCommand {
	if (style === "window") {
		return {
			command: "zenity",
			args: ["--info", `--title=${content.title}`, `--text=${content.message}`, "--timeout=120"],
		};
	}
	return { command: "notify-send", args: ["-a", "MyHarness", content.title, content.message] };
}

/**
 * Fire-and-forget desktop popup. Returns true when a notification process was
 * spawned. Best-effort by design: a missing notifier binary (notify-send,
 * osascript, ...) surfaces as an async spawn error, which is deliberately
 * ignored so an absent desktop environment can never break the agent; the
 * return value only reflects whether this platform/style combination is
 * supported at all.
 *
 * The child gets piped stdio on purpose: with `stdio: "ignore"`, a detached
 * spawn, or an immediately-exiting parent, the Windows toast is silently
 * dropped by the notification platform even though PowerShell exits 0 —
 * verified empirically via ToastNotificationManager history. The only working
 * shape is an attached child with valid pipes whose spawner stays alive while
 * it runs, which always holds for the long-running UI. If the agent quits
 * within a few seconds of a popup firing, that popup may be lost. The pipes
 * are drained and unref'd so the child can never block or keep the agent
 * alive.
 */
export function showPopupNotification(style: PopupNotificationStyle, content: PopupNotificationContent): boolean {
	const popup = buildPopupCommand(process.platform, style, content);
	if (!popup) {
		return false;
	}
	try {
		const child = spawnProcess(popup.command, popup.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		child.on("error", () => {});
		child.unref();
		// The pipes are Sockets at runtime; unref them so a pending popup never
		// keeps the agent's event loop (or its shutdown) waiting on the child.
		(child.stdout as Socket | null)?.unref();
		(child.stderr as Socket | null)?.unref();
	} catch {
		return false;
	}
	return true;
}
