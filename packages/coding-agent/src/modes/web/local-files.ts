import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HttpError } from "./http-server.ts";

const execute = promisify(execFile);

/** Folders never descended into by the bounded basename fallback (read-only search). */
const REMAP_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".cache",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
]);

/** Cap on visited entries for the basename fallback so a huge workspace cannot stall the click. */
const REMAP_SEARCH_CAP = 20000;

const DRIVE_SEGMENTS = new Set(["my drive", "google drive"]);

/** Split a requested path on both separators so Windows paths remap on any platform. */
function splitRequestedSegments(value: string): string[] {
	return value.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
}

function isDriveSegment(name: string): boolean {
	return DRIVE_SEGMENTS.has(name.toLowerCase());
}

function isWindowsDriveSegment(name: string): boolean {
	return /^[a-z]:$/i.test(name);
}

/** True when `candidate` stays inside `root` (never escapes, even via `..`). */
function staysInside(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function statIfInside(
	root: string,
	realRoot: string | null,
	candidate: string,
): Promise<{ path: string; directory: boolean } | null> {
	// Reject `..` and absolute suffixes before touching the disk: path.join normalizes
	// `..` so `join(root, "..", "x")` would escape the workspace.
	const rel = path.relative(root, candidate);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	let info: Stats;
	try {
		info = await stat(candidate);
	} catch {
		return null;
	}
	if (!info.isFile() && !info.isDirectory()) return null;
	try {
		const actual = await realpath(candidate);
		if (/^(?:\\\\|\/\/)/.test(actual) && !/^\\\\\?\\[a-z]:\\/i.test(actual)) return null;
		if (realRoot) {
			const realRel = path.relative(realRoot, actual);
			if (realRel.startsWith("..") && actual.toLowerCase() !== realRoot.toLowerCase()) {
				// Symlink inside the workspace points outside: never follow it out.
				return null;
			}
		}
	} catch {
		// realpath failed but stat succeeded (rare race): still treat as a hit, it stays inside root.
	}
	return { path: candidate, directory: info.isDirectory() };
}

/**
 * Cross-computer suffix remap (read-only): try progressively shorter trailing segments of
 * the requested path as `<workspaceRoot>/<suffix>`, longest first. Never escapes the
 * workspace root; suffixes containing `..` or drive letters are skipped. Case sensitivity
 * follows the host filesystem (case-insensitive on Windows).
 */
async function resolveBySuffix(
	root: string,
	realRoot: string | null,
	segments: string[],
): Promise<{ path: string; directory: boolean } | null> {
	const base = segments[0] && isWindowsDriveSegment(segments[0]) ? segments.slice(1) : segments;
	// A path through Google Drive (`.../My Drive/<rest>`) is tried from `<rest>` first so the
	// user-folder prefix from the other computer never blocks the match.
	const marker = base.findIndex((part) => isDriveSegment(part));
	const ordered: string[][] = [];
	if (marker >= 0) {
		const stripped = base.slice(marker + 1);
		for (let start = 0; start < stripped.length; start++) ordered.push(stripped.slice(start));
	}
	for (let start = 0; start < base.length; start++) ordered.push(base.slice(start));
	const seen = new Set<string>();
	for (const suffix of ordered) {
		if (suffix.length < 2) continue; // a bare file name goes through the unique-basename fallback instead
		if (suffix.some((part) => part === "..")) continue;
		if (suffix.some((part) => isWindowsDriveSegment(part))) continue;
		const key = suffix.join("\0");
		if (seen.has(key)) continue;
		seen.add(key);
		const candidate = path.join(root, ...suffix);
		if (!staysInside(root, candidate) && candidate !== root) continue;
		const hit = await statIfInside(root, realRoot, candidate);
		if (hit) return hit;
	}
	return null;
}

/**
 * Bounded read-only basename search under the workspace root. Skips heavy folders and
 * caps visited entries; accepts only exactly one match so an ambiguous link never opens
 * the wrong file. Returns null when capped (cannot prove uniqueness).
 */
async function resolveByBasename(
	root: string,
	realRoot: string | null,
	basename: string,
): Promise<{ path: string; directory: boolean } | null> {
	if (!basename || basename === "." || basename === ".." || basename === "") return null;
	const want = process.platform === "win32" ? basename.toLowerCase() : basename;
	const matches: string[] = [];
	const stack: string[] = [root];
	let visited = 0;
	let capped = false;
	while (stack.length > 0) {
		if (visited > REMAP_SEARCH_CAP) {
			capped = true;
			break;
		}
		const dir = stack.pop()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			visited += 1;
			if (visited > REMAP_SEARCH_CAP) {
				capped = true;
				break;
			}
			const name = entry.name;
			const same = process.platform === "win32" ? name.toLowerCase() === want : name === want;
			if (same) {
				const full = path.join(dir, name);
				const hit = await statIfInside(root, realRoot, full);
				if (hit) {
					matches.push(full);
					if (matches.length > 1) {
						throw new HttpError(
							404,
							`Multiple files named "${basename}" exist under the current workspace, so the link is ambiguous. Open the file from the Files panel instead.`,
						);
					}
				}
			}
			if (entry.isDirectory()) {
				if (REMAP_SKIP_DIRS.has(name)) continue;
				stack.push(path.join(dir, name));
			}
		}
	}
	if (capped) return null;
	if (matches.length === 1) {
		const only = matches[0]!;
		let info: Stats;
		try {
			info = await stat(only);
		} catch {
			return null;
		}
		return { path: only, directory: info.isDirectory() };
	}
	return null;
}

function missingFileError(value: string, segments: string[]): HttpError {
	const hasDrive = segments.some((part) => isDriveSegment(part));
	if (hasDrive)
		throw new HttpError(
			404,
			'This file is inside a Google Drive folder ("My Drive"/"Google Drive") and Google Drive has not delivered it to this computer yet. Check that Drive sync finished for this folder.',
		);
	const absoluteLike =
		/^[a-z]:[\\/]/i.test(value) || /^[a-z]:$/i.test(value.split(/[\\/]+/)[0] ?? "") || /^[\\/]/.test(value);
	if (absoluteLike)
		throw new HttpError(
			404,
			"This file was created on another computer and has not been synced to this computer, so it was not found under the current workspace.",
		);
	throw new HttpError(404, "Local file or folder does not exist");
}

export async function resolveLocalFile(
	root: string,
	input: unknown,
	/** App-managed roots a synced link may point into (the Data root: artifacts, notes and attachments). */
	extraRoots: string[] = [],
): Promise<{ path: string; directory: boolean }> {
	if (typeof input !== "string" || !input.trim() || input.length > 32768 || /[\x00-\x1f]/.test(input))
		throw new HttpError(400, "Expected a local file path");
	let value = input.trim();
	if (/^file:/i.test(value)) {
		try {
			value = fileURLToPath(value);
		} catch {
			throw new HttpError(400, "Invalid file URL");
		}
	} else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
		throw new HttpError(400, "Only local file paths are supported");
	}
	if (/^(?:\\\\|\/\/)/.test(value)) throw new HttpError(400, "Network and device paths are not supported");
	const full = path.resolve(root, value);
	try {
		const actual = await realpath(full);
		if (/^(?:\\\\|\/\/)/.test(actual) && !/^\\\\\?\\[a-z]:\\/i.test(actual))
			throw new HttpError(400, "Network and device paths are not supported");
		const info = await stat(full);
		if (!info.isFile() && !info.isDirectory()) throw new HttpError(400, "Not a regular file or folder");
		return { path: full, directory: info.isDirectory() };
	} catch (error) {
		if (error instanceof HttpError && error.status !== 404) throw error;
		// Missing locally: fall through to the cross-computer remap below.
	}
	const segments = splitRequestedSegments(value);
	const searched = [root, ...extraRoots.filter((item) => item && item !== root)];
	const roots: { path: string; real: string | null }[] = [];
	for (const candidate of searched) {
		let real: string | null = null;
		try {
			real = await realpath(candidate);
		} catch {
			real = null;
		}
		roots.push({ path: candidate, real });
	}
	const basename = segments[segments.length - 1] ?? "";
	for (const candidate of roots) {
		const suffixHit = await resolveBySuffix(candidate.path, candidate.real, segments);
		if (suffixHit) return suffixHit;
	}
	for (const candidate of roots) {
		const baseHit = await resolveByBasename(candidate.path, candidate.real, basename);
		if (baseHit) return baseHit;
	}
	throw missingFileError(value, segments);
}

// PowerShell 5.1 C# interop: enumerate Windows Open With associations and invoke the
// selected handler with a Shell data object (also supports packaged applications).
const DESKTOP_TYPE = String.raw`
using System;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;
public static class MyHarnessLocalFiles {
 [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IEnumAssocHandlers { [PreserveSig] int Next(uint count, out IAssocHandler handler, out uint fetched); }
 [ComImport, Guid("f04061ac-1659-4a3f-a954-775aa57fc083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IAssocHandler {
  void GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
  [PreserveSig] int IsRecommended();
  void MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
  void Invoke([MarshalAs(UnmanagedType.Interface)] object data);
  void CreateInvoker([MarshalAs(UnmanagedType.Interface)] object data, out IntPtr invoker);
 }
 [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellItem {
  void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
  void GetParent(out IShellItem parent);
  void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
 }
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
 static extern void SHAssocEnumHandlers(string extension, uint filter, out IEnumAssocHandlers handlers);
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
 static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
 public class Choice { public string id; public string label; public Choice(string i,string l) { id=i; label=l; } }
 static IEnumerable<IAssocHandler> Handlers(string file) {
  if(String.IsNullOrEmpty(Path.GetExtension(file))) yield break;
  IEnumAssocHandlers e; SHAssocEnumHandlers(Path.GetExtension(file),0,out e);
  if(e==null) yield break;
  try { IAssocHandler h; uint count; while(e.Next(1,out h,out count)==0 && count==1) yield return h; }
  finally { Marshal.ReleaseComObject(e); }
 }
 static List<Choice> DirectoryChoices() {
  var result=new List<Choice>();
  using(var shell=Registry.ClassesRoot.OpenSubKey(@"Directory\shell")) {
   if(shell==null) return result;
   foreach(string verb in shell.GetSubKeyNames()) {
    if(verb=="open" || verb=="explore" || verb=="runas" || verb=="cmd" || verb=="Powershell") continue;
    using(var key=shell.OpenSubKey(verb)) using(var command=key.OpenSubKey("command")) {
     if(command==null || key.GetValue("Extended")!=null) continue;
     string cmd=Environment.ExpandEnvironmentVariables(Convert.ToString(command.GetValue("")));
     string exe=cmd.StartsWith("\"") ? cmd.Split('"')[1] : cmd.Split(' ')[0];
     if(!File.Exists(exe) || !cmd.Contains("%")) continue;
     string label=Convert.ToString(key.GetValue(""));
     if(String.IsNullOrEmpty(label) || label.StartsWith("@")) label=FileVersionInfo.GetVersionInfo(exe).FileDescription;
     if(String.IsNullOrEmpty(label)) label=Path.GetFileNameWithoutExtension(exe);
     label=label.Replace("&","");
     result.Add(new Choice("verb:"+verb,label));
    }
   }
  }
  return result;
 }
 public static Choice[] Choices(string file) {
  if(Directory.Exists(file)) return DirectoryChoices().ToArray();
  var result=new List<Choice>(); var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  foreach(var h in Handlers(file)) {
   try { string id,label; h.GetName(out id); h.GetUIName(out label); if(Path.IsPathRooted(id) && !File.Exists(id)) continue; if(seen.Add(id)) result.Add(new Choice(id,label)); }
   finally { Marshal.ReleaseComObject(h); }
  }
  return result.ToArray();
 }
 public static void Open(string file,string action,string id) {
  if(action=="reveal") { Process.Start(new ProcessStartInfo("explorer.exe",Directory.Exists(file) ? "\""+file+"\"" : "/select,\""+file+"\""){UseShellExecute=true}); return; }
  if(action=="open") { Process.Start(new ProcessStartInfo(file){UseShellExecute=true}); return; }
  if(action!="handler") throw new Exception("Unknown local file action");
  if(Directory.Exists(file)) {
   foreach(var c in DirectoryChoices()) if(c.id==id) { Process.Start(new ProcessStartInfo(file){UseShellExecute=true,Verb=id.Substring(5)}); return; }
  } else {
   foreach(var h in Handlers(file)) {
    try {
     string name; h.GetName(out name); if(name!=id) continue;
     Guid iid=new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"); IShellItem item;
     SHCreateItemFromParsingName(file,IntPtr.Zero,ref iid,out item);
     try {
      Guid bhid=new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4"), dataIid=new Guid("0000010e-0000-0000-C000-000000000046"); object data;
      item.BindToHandler(IntPtr.Zero,ref bhid,ref dataIid,out data);
      try { h.Invoke(data); } finally { Marshal.ReleaseComObject(data); }
     } finally { Marshal.ReleaseComObject(item); }
     return;
    } finally { Marshal.ReleaseComObject(h); }
   }
  }
  throw new Exception("This opening method is no longer available");
 }
}
`;

export function buildLocalFileScript(file: string, action: string, handler = ""): string {
	const decode = (value: string) =>
		`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
	return [
		"$ErrorActionPreference = 'Stop'",
		"[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)",
		`Add-Type -TypeDefinition (${decode(DESKTOP_TYPE)})`,
		`$file = ${decode(file)}`,
		action === "choices"
			? "ConvertTo-Json -Compress -Depth 4 -InputObject @([MyHarnessLocalFiles]::Choices($file))"
			: `[MyHarnessLocalFiles]::Open($file, (${decode(action)}), (${decode(handler)})); '{}'`,
	].join("\n");
}

export async function runLocalFileAction(file: string, action: string, handler = ""): Promise<unknown> {
	if (process.platform !== "win32") throw new HttpError(501, "Local desktop opening is only supported on Windows");
	const script = buildLocalFileScript(file, action, handler);
	try {
		const { stdout } = await execute(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-STA",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			],
			{ windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" },
		);
		return JSON.parse(stdout.trim());
	} catch (error) {
		throw new HttpError(
			500,
			`Unable to perform local desktop action: ${typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr.trim() : error instanceof Error ? error.name : "Desktop bridge failed"}`,
		);
	}
}
