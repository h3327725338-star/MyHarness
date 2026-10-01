/**
 * The operating system's own "choose a folder" window, for adding a Workspace from the Web UI.
 *
 * The Web UI runs in a browser, which cannot hand a folder's real path to a page. The server runs on the same desktop,
 * so it opens the window itself: on Windows the Explorer-style folder picker (IFileOpenDialog with FOS_PICKFOLDERS),
 * owned by the window in front (the browser), started through Windows PowerShell 5.1, which every Windows has.
 */

import { spawnProcess } from "../../utils/child-process.ts";

export type FolderDialogResult = { path: string } | { cancelled: true };

const PICKED = "MYHARNESS_FOLDER:";
const CANCELLED = "MYHARNESS_CANCELLED";

/** C# 5 (the compiler Windows PowerShell 5.1 ships with): the COM folder picker, returning the path or null on cancel. */
const DIALOG_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class MyHarnessFolderDialog {
	[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
	class FileOpenDialog {}

	[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IFileDialog {
		[PreserveSig] int Show(IntPtr parent);
		void SetFileTypes(uint count, IntPtr filterSpec);
		void SetFileTypeIndex(uint index);
		void GetFileTypeIndex(out uint index);
		void Advise(IntPtr events, out uint cookie);
		void Unadvise(uint cookie);
		void SetOptions(uint options);
		void GetOptions(out uint options);
		void SetDefaultFolder(IShellItem item);
		void SetFolder(IShellItem item);
		void GetFolder(out IShellItem item);
		void GetCurrentSelection(out IShellItem item);
		void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
		void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
		void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
		void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
		void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
		void GetResult(out IShellItem item);
	}

	[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IShellItem {
		void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
		void GetParent(out IShellItem parent);
		void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
	}

	[DllImport("user32.dll")]
	static extern IntPtr GetForegroundWindow();

	const uint PickFolders = 0x20;
	const uint ForceFileSystem = 0x40;
	const uint FileSystemPath = 0x80058000;

	public static string Pick(string title) {
		IFileDialog dialog = (IFileDialog)new FileOpenDialog();
		uint options;
		dialog.GetOptions(out options);
		dialog.SetOptions(options | PickFolders | ForceFileSystem);
		if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
		// Any failure code here is "no folder chosen" (the usual one is the user's Cancel).
		if (dialog.Show(GetForegroundWindow()) != 0) return null;
		IShellItem item;
		dialog.GetResult(out item);
		string path;
		item.GetDisplayName(FileSystemPath, out path);
		return path;
	}
}
`;

/** The PowerShell script that shows the window. Texts travel as base64 UTF-8, so any title and path survive intact. */
export function buildFolderDialogScript(title: string): string {
	const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
	return [
		"$ErrorActionPreference = 'Stop'",
		`$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(DIALOG_TYPE)}'))`,
		`$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(title)}'))`,
		"Add-Type -TypeDefinition $source",
		"$path = [MyHarnessFolderDialog]::Pick($title)",
		`if ($path) { '${PICKED}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path)) } else { '${CANCELLED}' }`,
	].join("\n");
}

/** What the script printed: the chosen folder, a cancel, or undefined when it printed neither (the window failed). */
export function parseFolderDialogOutput(stdout: string): FolderDialogResult | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		const text = line.trim();
		if (text === CANCELLED) return { cancelled: true };
		if (text.startsWith(PICKED)) {
			const path = Buffer.from(text.slice(PICKED.length), "base64").toString("utf8");
			if (path) return { path };
		}
	}
	return undefined;
}

export function nativeFolderDialogAvailable(): boolean {
	return process.platform === "win32";
}

let open: Promise<FolderDialogResult> | undefined;

/** True while a folder window is on screen: there is only ever one. */
export function folderDialogOpen(): boolean {
	return open !== undefined;
}

/**
 * Show the folder window and wait for the user. Resolves with the chosen folder or `{ cancelled: true }`; rejects when
 * the window could not be shown. Never blocks the event loop: the window lives in its own process.
 */
export function pickFolderWithSystemDialog(title: string): Promise<FolderDialogResult> {
	if (open) return open;
	const script = Buffer.from(buildFolderDialogScript(title), "utf16le").toString("base64");
	const shown = new Promise<FolderDialogResult>((resolve, reject) => {
		const child = spawnProcess(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", script],
			{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", () => {
			const result = parseFolderDialogOutput(stdout);
			if (result) resolve(result);
			else reject(new Error(stderr.trim().split(/\r?\n/)[0] || "The folder window could not be opened."));
		});
	});
	open = shown;
	const clear = () => {
		if (open === shown) open = undefined;
	};
	shown.then(clear, clear);
	return shown;
}
