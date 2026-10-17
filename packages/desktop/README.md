# MyHarness Electron desktop (Windows x64)

This private workspace hosts the existing Web application; it is not another frontend or Agent runtime.

## Commands

From the repository root:

```powershell
npm.cmd install --ignore-scripts
node node_modules/electron/install.js
npm.cmd run desktop:dev
npm.cmd run desktop:pack
npm.cmd run desktop:test
```

**Double-click launcher (daily development)**: `dev-desktop.cmd` in the repository root builds, packages and then starts the newest build in one step (`packages/desktop/pack-and-run.ps1`). It shows real progress in its window and closes on success; on failure the window stays open with the error. Before starting it closes a running MyHarness, because the single-instance lock would otherwise make the new build exit immediately and silently leave the old window in place. It resolves Node/npm itself with the same fallbacks as `web-runtime.ps1` (PATH first, then the usual install locations), so a double-click from Explorer also works when that inherited PATH has no Node.

Artifacts of this launcher land in `dist\desktop` (it pins `MYHARNESS_DESKTOP_OUTPUT`, so an inherited `MYHARNESS_ARTIFACTS_DIR` cannot move them into a conversation folder). After a successful build it deletes older `stage-*` directories and keeps only the newest two `release-*` directories; anything that cannot be deleted (for example a still running build) is reported and skipped. `MYHARNESS_DESKTOP_SKIP_LAUNCH=1` builds without closing or starting anything.

`desktop:pack` runs the unchanged root build, stages only compiled MyHarness packages, Web resources, system prompts and their installed runtime dependency closure, then uses electron-builder to create `win-unpacked/MyHarness.exe`. Keep the entire `win-unpacked` directory together. No external Node, tsx or npm is needed to start it. Bash/Git and optional tools still have the same requirements as the Web product; this does not bundle a development toolchain.

Output goes to `MYHARNESS_DESKTOP_OUTPUT`, otherwise the current conversation's `MYHARNESS_ARTIFACTS_DIR/desktop`, otherwise root `dist/desktop`. Each build uses a new timestamped staging/release directory; `build.mjs` itself never deletes previous builds (only `pack-and-run.ps1` prunes old ones as described above). Electron download failures must be resolved using the actual installer error; no alternative shell is used.

## Startup, storage and lifetime

`MyHarness.exe → Electron main → Electron exe with ELECTRON_RUN_AS_NODE=1 → service-entry.cjs → existing coding-agent dist/web.js → main/startWebBootstrap → HTTP/SSE → existing web/`.

Development uses that same chain with `src/web.ts` and the repository dev loader. Refresh for frontend changes; close/relaunch for backend changes. `dev-web.cmd` remains unchanged.

The source host anchors its working directory to the repository. The packaged host records that directory in `runtime.json` at build time, independently of where the executable is copied. This is intentional for this checkout's desktop/Web shared-data requirement: Agent configuration remains in `~/.myharness/agent` (or the existing environment override); current Session/Workspace data remains in the checkout's `data/`, not a new Electron data store. `MYHARNESS_DESKTOP_CWD` can explicitly select a different working directory; `MYHARNESS_DATA_ROOT` retains the backend's existing semantics. A different machine needs an explicitly chosen existing working directory; a build-time checkout path is not a universal installer data location.

Only Chromium host/third-party profile data is added under the Agent directory's `desktop-profile`. Third-party views use the separate persistent `myharness-third-party` partition, never the system browser profile. Web UI appearance preferences (theme, language, motion, widths, panel tab, run mode, notifications) are kept by the service in the Agent directory's `web-ui-prefs.json` and shared with the browser Web UI (see `packages/coding-agent/docs/web-ui.md`), so the per-start random port no longer resets them. Earlier desktop builds kept them only in the localStorage of each start's origin; on start, when the service has no shared preferences yet, `legacy-prefs.cjs` reads those copies from this profile's LocalStorage log (read-only) and moves the user's last choice of each preference there once. When copies exist but none can be read, the page starts with defaults and says so. Server settings and persisted conversations use the same backend paths.

The service listens on port 0 and reports the actual loopback address. A process waits for IPC before initializing, so the main process can first assign it to a Windows kill-on-close Job Object (Koffi calls Windows APIs). Descendant shells, PTYs and tasks inherit ownership. Window close requests existing graceful shutdown, waits up to eight seconds, then closes the job. The existing restart route retains its work checks and disposal, but desktop restarts are supervised over IPC rather than detached PowerShell. Single-instance locking activates the existing window.

Logs append to the existing data root's `logs/web-launch.out.log` and `web-launch.err.log`. Service/load failures produce a Chinese error page. No Agent data or credentials are copied into the distribution.

## Minimal browser entry

Only in Electron, the header has one additional Browser button. The existing Changes/Files/Terminal/Session panels are unchanged. Enter an HTTP(S) URL and click Open. The main process creates a sandboxed `WebContentsView` without preload or Node integration; it is a top-level browser navigation, not an iframe or webview. Frame-embedding headers therefore do not apply. This does not promise access to blocked networks or bypass site login, bot checks, DRM or Electron-specific site restrictions.

A native view is drawn above the whole page and takes no part in its layout, animations or stacking. The page therefore samples its target box every animation frame and shows the native view only while the box has kept the same whole-pixel place for two frames, no animation moves, resizes or fades it (panel slide, sidebar fold, mode reveal) and nothing of the page lies over it (dialogs, menus, popovers, toasts and anything a hit test finds). The rest of the time the native view is hidden and the box shows the last picture of the page: main captures one (`capturePage`, JPEG) about a second after it is shown or has loaded and every second while it stays shown, and the page draws it as a plain image that moves, fades and is covered like the rest of the page. The box starts 4px inside the panel so the panel's resize handle stays usable. Main clamps bounds to the window. Changing tabs, closing the panel or reloading destroys the view; on close the picture slides out with the panel. Load failure/45-second timeout destroys the view and leaves a visible message and system-browser action. Context menu supports editing/copy and opening externally. No global keyboard shortcut is registered. New-window web links navigate the same view; multi-window OAuth flows and downloads are not implemented as a full browser product. Permissions are denied by default.

## Verification limits

Use actual test reports for evidence. Unit tests and browser module smoke checks do not establish human input, visual alignment at all DPI levels, all Git flows, clean-machine compatibility or login compatibility. The app is unsigned; Windows SmartScreen policy may warn. No auto-updater or installer is provided by the directory target.
