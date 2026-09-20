@echo off
rem MyHarness dev launcher (Windows) - double-click this file.
rem Locates the project root from this file's own location, then runs dev.ps1,
rem which prepares the environment and starts MyHarness in development mode
rem from the current project sources (tsx on packages/coding-agent/src/cli.ts).
rem
rem Any arguments passed to this file are forwarded to the MyHarness CLI.

setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "POWERSHELL_EXE=powershell.exe"

where %POWERSHELL_EXE% >nul 2>nul
if errorlevel 1 (
	>&2 echo [dev] powershell.exe not found.
	>&2 echo [dev] Windows PowerShell is required to prepare the environment.
	>&2 echo [dev] It ships with Windows; if missing, run dev.ps1 manually.
	echo.
	pause
	exit /b 1
)

%POWERSHELL_EXE% -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%dev.ps1" %*
set "DEV_EXIT=%ERRORLEVEL%"

if not "%DEV_EXIT%"=="0" (
	echo.
	echo [dev] Launcher exited with code %DEV_EXIT%. See the messages above.
	echo [dev] This window is kept open so the error stays visible.
	pause
)

exit /b %DEV_EXIT%
