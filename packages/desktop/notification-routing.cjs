// Windows turns a toast click into a start of whatever the Start Menu shortcut carrying the app's AppUserModelId points
// at, so that shortcut has to be able to start this app. Electron keeps one shortcut per executable (named after the
// executable's product name) and never repairs one it did not write: a development run of electron.exe leaves
// "Electron.lnk" claiming the app id with a target that is the bare electron.exe, and a build folder that was replaced or
// cleaned up leaves a shortcut whose executable is gone. Both make a click start Electron's default window or nothing at
// all instead of the running app. Electron writes its own shortcut again before the next notification, so removing the
// ones that cannot start this app restores the one shortcut-to-one app mapping permanently.
const { spawn } = require('node:child_process');
const { existsSync, rmSync } = require('node:fs');

/** A shortcut that cannot start an app: no local executable, Electron's own binary, or an executable that is gone. */
function startable(target, exists) {
  const file = String(target ?? '').trim();
  if (!/^[a-z]:[\\/]/iu.test(file)) return false;
  if (/[\\/]electron\.exe$/iu.test(file)) return false;
  return exists(file);
}

/**
 * The Start Menu shortcuts that claim `aumid` without being able to start this app. Shortcuts of another installation
 * that still exists are kept: that executable forwards its start to the running app.
 */
function foreignNotificationShortcuts(entries, options) {
  const exists = options.exists ?? existsSync;
  return entries
    .filter((entry) => entry && String(entry.aumid ?? '').trim() === options.aumid)
    .filter((entry) => !startable(entry.target, exists))
    .map((entry) => entry.name);
}

/** The Start Menu shortcuts of the current user, as `{ name, aumid, target }`. */
function startMenuShortcuts() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
    'if (-not (Test-Path $dir)) { return }',
    '$shell = New-Object -ComObject Shell.Application',
    '$folder = $shell.Namespace($dir)',
    'if ($null -eq $folder) { return }',
    'foreach ($file in Get-ChildItem $dir -Filter *.lnk -File) {',
    '  $item = $folder.ParseName($file.Name)',
    '  if ($null -eq $item) { continue }',
    "  $aumid = [string]$item.ExtendedProperty('System.AppUserModel.ID')",
    "  $target = [string]$item.ExtendedProperty('System.Link.TargetParsingPath')",
    "  Write-Output (@($file.Name, $aumid, $target) -join [char]9)",
    '}',
  ].join('\n');
  return runPowerShell(script).then((output) =>
    output
      .split(/\r?\n/u)
      .filter((line) => line.includes('\t'))
      .map((line) => {
        const [name, aumid, target] = line.split('\t');
        return { name, aumid, target };
      }),
  );
}

/** Runs a PowerShell script hidden and resolves its standard output ('' when PowerShell cannot run). */
function runPowerShell(script) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-64000);
    });
    child.stderr.on('data', () => {});
    // Startup work only: the pipes and the child must never hold the app open while it quits.
    child.unref();
    child.stdout.unref?.();
    child.stderr.unref?.();
    child.once('error', () => resolve(''));
    child.once('close', () => resolve(output));
  });
}

/**
 * The taskbar shows a window under the Start Menu shortcut that carries the same AppUserModelId, with that shortcut's
 * icon. Electron's shortcut takes its icon from the executable, and Explorer caches icons by file path: the executable
 * keeps its path across builds (dist\desktop\current), so after a logo change the taskbar kept the old picture for good.
 * The shortcuts of this app (same id, target this executable) get `icon` instead, a file whose name changes with its
 * content, so a new logo is a path the cache has never seen. Resolves the names of the shortcuts it changed.
 */
async function pointShortcutIcons({ aumid, exe, icon, log }) {
  if (!aumid || !exe || !icon || process.platform !== 'win32') return [];
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
    'if (-not (Test-Path $dir)) { return }',
    `$aumid = ${quote(aumid)}`,
    `$exe = ${quote(exe)}`,
    `$icon = ${quote(`${icon},0`)}`,
    '$shell = New-Object -ComObject Shell.Application',
    '$wsh = New-Object -ComObject WScript.Shell',
    '$folder = $shell.Namespace($dir)',
    'if ($null -eq $folder) { return }',
    'foreach ($file in Get-ChildItem $dir -Filter *.lnk -File) {',
    '  $item = $folder.ParseName($file.Name)',
    '  if ($null -eq $item) { continue }',
    "  if ([string]$item.ExtendedProperty('System.AppUserModel.ID') -ne $aumid) { continue }",
    "  if ([string]$item.ExtendedProperty('System.Link.TargetParsingPath') -ne $exe) { continue }",
    '  $link = $wsh.CreateShortcut($file.FullName)',
    '  if ($link.IconLocation -eq $icon) { continue }',
    '  $link.IconLocation = $icon',
    '  $link.Save()',
    '  Write-Output $file.Name',
    '}',
  ].join('\n');
  const changed = (await runPowerShell(script)).split(/\r?\n/u).filter(Boolean);
  for (const name of changed) log?.(`启动菜单快捷方式 ${name} 的图标已改为 ${icon}`);
  return changed;
}

/**
 * Removes the Start Menu shortcuts that claim `aumid` without being able to start this app, and reports what it
 * removed. Best effort: a missing PowerShell or an unreadable shortcut leaves the Start Menu as it was.
 */
async function removeForeignShortcuts({ aumid, log }) {
  if (!aumid || process.platform !== 'win32') return [];
  const entries = await startMenuShortcuts();
  const programs = `${process.env.APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs`;
  const removed = [];
  for (const name of foreignNotificationShortcuts(entries, { aumid })) {
    const file = `${programs}\\${name}`;
    try {
      rmSync(file, { force: true });
      removed.push(name);
      log?.(`已移除占用了应用 ID 的启动菜单快捷方式：${file}`);
    } catch (error) {
      log?.(`无法移除启动菜单快捷方式 ${file}：${error.message}`);
    }
  }
  return removed;
}

exports.foreignNotificationShortcuts = foreignNotificationShortcuts;
exports.removeForeignShortcuts = removeForeignShortcuts;
exports.startMenuShortcuts = startMenuShortcuts;
exports.pointShortcutIcons = pointShortcutIcons;
