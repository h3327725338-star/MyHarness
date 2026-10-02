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
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
 public static void Focus(IntPtr h) {
  uint unused;
  uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
  uint current = GetCurrentThreadId();
  bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
  try { SetForegroundWindow(h); } finally { if (attached) AttachThreadInput(current, foreground, false); }
 }
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
}
'@
$done = [Console]::In.ReadToEndAsync()
$windows = [Collections.Generic.HashSet[IntPtr]]::new()
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
   if ($ids.Contains($owner) -and [ChallengeWindow]::IsWindowVisible($h) -and $windows.Add($h)) {
    [void][ChallengeWindow]::ShowWindow($h, 9)
    [void][ChallengeWindow]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 3)
    [ChallengeWindow]::Focus($h)
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
