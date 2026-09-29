@echo off
rem MyHarness Web UI dev launcher (Windows) - double-click this file.
rem Runs dev.cmd (development mode from the current project sources, no build)
rem with --web, so the browser UI opens instead of the terminal UI.
rem
rem Frontend files (packages\coding-agent\web) are served from disk with no cache:
rem refresh the browser page to see changes. Backend (src\) changes need a restart.
rem
rem Extra arguments are forwarded, e.g. dev-web.cmd --port 7878 --no-open

call "%~dp0dev.cmd" --web %*
exit /b %ERRORLEVEL%
