@echo off
rem MyHarness Web UI dev launcher (Windows) - double-click this file.
rem Starts the Web UI from the current project sources (no build) WITHOUT leaving a
rem console window: this file hands over to dev-web.vbs (a GUI host, no console) and exits
rem right away; the server then runs hidden, logs to data\logs\web-launch.*.log and shows
rem a dialog if it cannot start. Quit it with "Quit MyHarness" in the page.
rem
rem   dev-web.cmd --console   old behaviour: run inside this visible window (for debugging)
rem   dev-web.cmd --port 7878 --no-open   other arguments are forwarded to MyHarness
rem
rem Frontend files (packages\coding-agent\web) are served from disk with no cache:
rem refresh the browser page to see changes. Backend (src\) changes need a restart.

if /i "%~1"=="--console" goto console

start "" wscript.exe //B //Nologo "%~dp0dev-web.vbs" %*
exit /b 0

:console
shift
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0web-runtime.ps1" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
