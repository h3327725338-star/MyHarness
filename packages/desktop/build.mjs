import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'electron-builder';
import { createRequire } from 'node:module';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const sharp = createRequire(join(root, 'packages/coding-agent/package.json'))('sharp');
// The packaged engine is whatever Electron this package has installed (npm may place it in the root or in this
// workspace's node_modules); no version is written here, so an upgrade in package.json is all a new engine needs.
const electronPackage = createRequire(import.meta.url).resolve('electron/package.json');
const electronVersion = JSON.parse(readFileSync(electronPackage, 'utf8')).version;
const electronDist = join(dirname(electronPackage), 'dist');
// `--installer` (npm run desktop:installer) makes a Windows installer for other computers instead of the everyday build.
// It records no working directory, so an installed copy keeps its data in the user's own ~/.myharness/data (main.cjs).
const installer = process.argv.includes('--installer');
const output = resolve(process.env.MYHARNESS_DESKTOP_OUTPUT || (process.env.MYHARNESS_ARTIFACTS_DIR ? join(process.env.MYHARNESS_ARTIFACTS_DIR, 'desktop') : join(root, 'dist/desktop')));
mkdirSync(output, { recursive: true });
// Each build has a fresh staging area, never deletes or overwrites an existing output.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const stage = join(output, `stage-${stamp}`);
const destination = join(output, `release-${stamp}`);
mkdirSync(stage, { recursive: true });
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--version'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('TypeScript unavailable');
for (const name of ['main.cjs', 'preload.cjs', 'service-entry.cjs', 'windows-job.cjs', 'browser-view.cjs', 'browser-bookmarks.cjs', 'browser-help.cjs', 'browser-speed-dial.cjs', 'browser-input.cjs', 'browser-passwords.cjs', 'browser-permissions.cjs', 'browser-downloads.cjs', 'browser-page-helpers.cjs', 'browser-tab-preload.cjs', 'legacy-prefs.cjs', 'notification-routing.cjs', 'preview-links.cjs', 'app-prefs.cjs', 'zoom.cjs', 'browser-dark.cjs', 'browser-language.cjs', 'browser-sync.cjs', 'browser-web-mail.cjs', 'browser-web-mail-send.cjs', 'ui-language.cjs', 'start-page.cjs', 'app-context-menu.cjs']) cpSync(join(here, name), join(stage, name));
const runtime = join(stage, 'runtime');
const copied = new Set();
const installed = new Map();
const filter = (source) => !/(?:^|[\\/])(?:node_modules|\.git|test|tests|__tests__|coverage)(?:[\\/]|$)/.test(source) && !/\.(?:map|pdb|tsbuildinfo)$/.test(source);
function locate(name, from) {
  let folder = from;
  while (true) {
    const candidate = join(folder, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(folder) === folder) return undefined;
    folder = dirname(folder);
  }
}
function copyPackage(name, from, base = join(runtime, 'node_modules')) {
  const source = locate(name, from);
  if (!source) throw new Error(`Missing runtime dependency: ${name} from ${from}`);
  const shared = name === 'koffi' || name.startsWith('@koromix/koffi-') ? join(stage, 'node_modules') : join(runtime, 'node_modules');
  const previous = installed.get(name);
  if (previous === source) return;
  const target = join(previous ? base : shared, name);
  const key = `${target}:${source}`;
  if (copied.has(key)) return;
  copied.add(key);
  if (!previous) installed.set(name, source);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  mkdirSync(target, { recursive: true });
  if (name.startsWith('@myharness/')) {
    for (const item of ['package.json', 'dist', 'web', 'README.md', 'CHANGELOG.md']) if (existsSync(join(source, item))) cpSync(join(source, item), join(target, item), { recursive: true, filter: (p) => !/\.(?:map|tsbuildinfo)$/.test(p) });
  } else {
    // Filter relative paths so the destination's node_modules name isn't itself excluded.
    cpSync(source, target, { recursive: true, filter: (p) => p === source || filter(p.slice(source.length + 1)) });
  }
  for (const dependency of Object.keys(pkg.dependencies || {})) copyPackage(dependency, source, join(target, 'node_modules'));
  for (const dependency of Object.keys(pkg.optionalDependencies || {})) if (locate(dependency, source)) copyPackage(dependency, source, join(target, 'node_modules'));
}
copyPackage('@myharness/coding-agent', root);
copyPackage('koffi', here, join(stage, 'node_modules'));
// Website dark mode (browser-dark.cjs) injects Dark Reader's single-file build; its package dependencies are not needed.
{
  const darkreader = locate('darkreader', here);
  if (!darkreader) throw new Error('Missing runtime dependency: darkreader');
  mkdirSync(join(runtime, 'node_modules', 'darkreader'), { recursive: true });
  for (const file of ['darkreader.js', 'LICENSE', 'package.json']) cpSync(join(darkreader, file), join(runtime, 'node_modules', 'darkreader', file));
}
cpSync(join(root, 'system-prompts'), join(runtime, 'system-prompts'), { recursive: true });
writeFileSync(join(stage, 'runtime.json'), JSON.stringify(installer ? {} : { workingDirectory: resolve(process.env.MYHARNESS_DESKTOP_CWD || root) }));
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'myharness-desktop', productName: 'MyHarness', version: '0.0.3', main: 'main.cjs', author: 'MyHarness', description: 'MyHarness Windows desktop', license: 'Apache-2.0' }));
// The SVG is drawn at a high density first: at the default 72 dpi its 32-unit box would be scaled up blurry.
await sharp(join(root, 'packages/coding-agent/web/favicon.svg'), { density: 600 }).resize(256, 256).png().toFile(join(stage, 'icon.png'));
// ICO of PNG frames (Windows Vista and later). The taskbar, title bar and tray pick the small frames; with only a
// 256 px frame Windows shrinks it itself and the thin strokes of the logo come out blurred or broken.
const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
const frames = await Promise.all(sizes.map((size) => sharp(join(root, 'packages/coding-agent/web/favicon.svg'), { density: 600 }).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + 16 * index;
  header.writeUInt8(size % 256, entry); header.writeUInt8(size % 256, entry + 1); header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += frames[index].length;
});
writeFileSync(join(stage, 'icon.ico'), Buffer.concat([header, ...frames]));
console.log(`Desktop runtime: ${copied.size} dependency copies; staging ${stage}`);
// The installer is the usual Windows kind: the user picks "only for me" or everyone and the folder, it adds Start Menu and
// desktop shortcuts, and uninstalling removes the program only (the data in ~/.myharness stays). Its shortcuts carry the
// appId as their AppUserModelId, which has to be the id main.cjs gives the running app, or the taskbar would show the
// window as another app and notification clicks would start nothing.
const icon = join(stage, 'icon.ico');
const kind = installer
  ? { appId: 'MyHarness', target: 'nsis', nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'MyHarness', deleteAppDataOnUninstall: false, installerLanguages: ['en_US', 'zh_CN'], installerIcon: icon, uninstallerIcon: icon, installerHeaderIcon: icon, artifactName: 'MyHarness-Setup-${version}.${ext}' } }
  : { appId: 'com.myharness.desktop', target: 'dir' };
await build({ projectDir: stage, config: { appId: kind.appId, productName: 'MyHarness', electronVersion, electronDist, asar: false, npmRebuild: false, directories: { output: destination }, files: ['*.cjs', '*.json', '*.png', '*.ico'], extraFiles: [{ from: join(stage, 'runtime/system-prompts'), to: 'resources/app/runtime/system-prompts' }, { from: join(stage, 'runtime/node_modules'), to: 'resources/app/runtime/node_modules' }, { from: join(stage, 'node_modules'), to: 'resources/app/node_modules' }], win: { target: [{ target: kind.target, arch: ['x64'] }], icon, signExecutable: false }, ...(kind.nsis ? { nsis: kind.nsis } : {}) } });
console.log(`DESKTOP_EXECUTABLE=${join(destination, 'win-unpacked/MyHarness.exe')}`);
if (installer) console.log(`DESKTOP_INSTALLER=${join(destination, `MyHarness-Setup-${JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')).version}.exe`)}`);
