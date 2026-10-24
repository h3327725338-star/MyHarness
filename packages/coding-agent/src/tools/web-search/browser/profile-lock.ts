import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * A browser that is still running on a dedicated profile must be found by the profile's lock file, not by its command
 * line: a Firefox that restarted itself (after an update, for example) gets the profile through the environment, so its
 * command line names no profile. Launching another browser on that profile makes Firefox show a modal "Firefox is
 * already running" box on the user's desktop, even when headless, and fail. So before every launch the lock is
 * checked, its holders are ended, and no browser is started while the profile is still held.
 */

/** The file a running browser keeps open, without sharing, inside its profile. */
export function profileLockFile(kind: "firefox" | "chrome" | "edge", profileDir: string): string {
	return join(profileDir, kind === "firefox" ? "parent.lock" : "lockfile");
}

/** True when some process holds the lock file open (Windows only: elsewhere the lock is not an open file). */
export function isProfileLocked(lockFile: string): boolean {
	if (process.platform !== "win32" || !existsSync(lockFile)) return false;
	try {
		closeSync(openSync(lockFile, "r+"));
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EBUSY" || code === "EPERM" || code === "EACCES";
	}
}

// Windows Restart Manager names the processes that have a file open. Only browser processes are returned.
const HOLDERS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class MyHarnessLockHolders {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, IntPtr app, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static int[] Get(string path) {
    var pids = new List<int>(); uint handle;
    if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0) return pids.ToArray();
    try {
      if (RmRegisterResources(handle, 1, new[] { path }, 0, IntPtr.Zero, 0, null) != 0) return pids.ToArray();
      uint needed = 0, count = 0, reasons = 0;
      if (RmGetList(handle, out needed, ref count, null, ref reasons) == 234) {
        var info = new RM_PROCESS_INFO[needed]; count = needed;
        if (RmGetList(handle, out needed, ref count, info, ref reasons) == 0) for (int i = 0; i < count; i++) pids.Add(info[i].Process.dwProcessId);
      }
    } finally { RmEndSession(handle); }
    return pids.ToArray();
  }
}
'@
$path = [Console]::In.ReadToEnd().Trim()
[MyHarnessLockHolders]::Get($path) | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } |
  Where-Object { $_.ProcessName -match '^(firefox|chrome|msedge)$' } | ForEach-Object { $_.Id }
`;

/** The browser processes that hold the lock file open (Windows only). */
export function profileLockHolders(lockFile: string): Promise<number[]> {
	if (process.platform !== "win32") return Promise.resolve([]);
	return new Promise((resolve) => {
		const child = execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HOLDERS_SCRIPT],
			{ encoding: "utf8", windowsHide: true, timeout: 20_000 },
			(error, stdout) => {
				if (error) return resolve([]);
				resolve(
					stdout
						.split(/\s+/u)
						.map(Number)
						.filter((pid) => Number.isSafeInteger(pid) && pid > 0),
				);
			},
		);
		child.stdin?.end(lockFile);
	});
}
