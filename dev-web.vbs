' MyHarness Web UI silent launcher (Windows).
' wscript.exe is a GUI host, so starting from here never creates a console window;
' the PowerShell that does the work is started hidden (window style 0) and not waited for.
' Point a shortcut straight at this file for a launch with no window flash at all.
' Extra arguments are forwarded, e.g. dev-web.vbs --port 7878 --no-open
Option Explicit

Dim shell, fso, root, command, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\dev-web.ps1"""
For i = 0 To WScript.Arguments.Count - 1
	command = command & " """ & Replace(WScript.Arguments(i), """", "\""") & """"
Next

shell.CurrentDirectory = root
shell.Run command, 0, False
