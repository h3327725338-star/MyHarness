import { spawn } from "node:child_process";

/** Only the dedicated challenge browser and its children; never windows selected by title or browser name. */
export function keepChallengeForeground(pid: number | undefined): () => void {
	if (process.platform !== "win32" || !pid) return () => {};
	const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChallengeWindow {
 public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
 // A browser window a person works in: not owned by another window (a tooltip, a menu) and not a tiny helper window.
 public static bool IsMain(IntPtr h) {
  RECT r;
  return GetWindow(h, 4) == IntPtr.Zero && GetWindowRect(h, out r) && r.Right - r.Left >= 200 && r.Bottom - r.Top >= 200;
 }
 public static bool Focus(IntPtr h) {
  if (GetForegroundWindow() == h) return true;
  uint unused;
  uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
  uint current = GetCurrentThreadId();
  bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
  uint owner = GetWindowThreadProcessId(h, out unused);
  bool ownerAttached = owner != 0 && owner != current && owner != foreground && AttachThreadInput(current, owner, true);
  try {
   BringWindowToTop(h); SetForegroundWindow(h);
   if (GetForegroundWindow() != h) {
    // Windows only lets the process that received the last input take the foreground. Alt pressed and released from
    // here makes this process that one; the second press takes back the menu the first one would open.
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    BringWindowToTop(h); SetForegroundWindow(h);
   }
   SetFocus(h);
  }
  finally {
   if (ownerAttached) AttachThreadInput(current, owner, false);
   if (attached) AttachThreadInput(current, foreground, false);
  }
  return GetForegroundWindow() == h;
 }
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
}
'@
# Ends when the caller closes stdin. The raw stream is read: Console.In is a synchronized reader whose ReadToEndAsync
# blocks until the end of the input, which would keep the loop below from ever running.
$done = [Console]::OpenStandardInput().ReadAsync((New-Object byte[] 16), 0, 16)
$windows = [Collections.Generic.HashSet[IntPtr]]::new()
# How often each window was still brought to the front: it is tried again until it has the focus, but only during the
# first seconds, so a person who then switches to another window is not pulled back.
$tries = @{}
$deadline = [DateTime]::UtcNow.AddMinutes(4)
try {
 while (!$done.IsCompleted -and [DateTime]::UtcNow -lt $deadline) {
  $processes = @(Get-CimInstance Win32_Process)
  if (!($processes | Where-Object ProcessId -eq ${pid})) { break }
  $ids = [Collections.Generic.HashSet[uint32]]::new()
  [void]$ids.Add(${pid})
  do {
   $count = $ids.Count
   foreach ($p in $processes) { if ($ids.Contains([uint32]$p.ParentProcessId)) { [void]$ids.Add([uint32]$p.ProcessId) } }
  } while ($ids.Count -ne $count)
  [ChallengeWindow]::EnumWindows({ param($h, $unused)
   $owner = [uint32]0
   [void][ChallengeWindow]::GetWindowThreadProcessId($h, [ref]$owner)
   if ($ids.Contains($owner) -and [ChallengeWindow]::IsWindowVisible($h) -and [ChallengeWindow]::IsMain($h)) {
    if ($windows.Add($h)) {
     $tries[$h] = 0
     if ([ChallengeWindow]::IsIconic($h)) { [void][ChallengeWindow]::ShowWindow($h, 9) }
    }
    if ($tries[$h] -lt 20) {
     # Topmost keeps the window above every other one even if the system refuses it the focus.
     [void][ChallengeWindow]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43)
     if ($windows.Contains([ChallengeWindow]::GetForegroundWindow()) -or [ChallengeWindow]::Focus($h)) { $tries[$h] = 20 }
     else { $tries[$h] = $tries[$h] + 1 }
    }
   }
   return $true
  }, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 250
 }
} finally {
 foreach ($h in $windows) { if ([ChallengeWindow]::IsWindow($h)) { [void][ChallengeWindow]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 19) } }
}
`;
	const child = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
		{ windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
	);
	child.on("error", () => {});
	child.stdin.on("error", () => {});
	return () => child.stdin.end();
}
