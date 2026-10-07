import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HttpError } from "./http-server.ts";

const execute = promisify(execFile);

export async function resolveLocalFile(root: string, input: unknown): Promise<{ path: string; directory: boolean }> {
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
	const actual = await realpath(full).catch(() => {
		throw new HttpError(404, "Local file or folder does not exist");
	});
	if (/^(?:\\\\|\/\/)/.test(actual) && !/^\\\\\?\\[a-z]:\\/i.test(actual))
		throw new HttpError(400, "Network and device paths are not supported");
	let info: Stats;
	try {
		info = await stat(full);
	} catch {
		throw new HttpError(404, "Local file or folder does not exist");
	}
	if (!info.isFile() && !info.isDirectory()) throw new HttpError(400, "Not a regular file or folder");
	return { path: full, directory: info.isDirectory() };
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
