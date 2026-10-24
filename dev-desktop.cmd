@echo off
rem MyHarness desktop launcher (Windows) - double-click this file.
rem Builds the current sources, packages the Electron app, then starts the newest
rem packaged executable. The visible window shows real progress and closes by itself
rem on success; on failure it stays open with the error.
rem
rem The packaged app is started from dist\desktop\current\win-unpacked\ (a fixed
rem path, so Windows Firewall asks only once).
rem See packages\desktop\README.md for details.

title MyHarness Desktop Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0packages\desktop\pack-and-run.ps1"
exit /b %ERRORLEVEL%
