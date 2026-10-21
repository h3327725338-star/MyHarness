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
const output = resolve(process.env.MYHARNESS_DESKTOP_OUTPUT || (process.env.MYHARNESS_ARTIFACTS_DIR ? join(process.env.MYHARNESS_ARTIFACTS_DIR, 'desktop') : join(root, 'dist/desktop')));
mkdirSync(output, { recursive: true });
// Each build has a fresh staging area, never deletes or overwrites an existing output.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const stage = join(output, `stage-${stamp}`);
const destination = join(output, `release-${stamp}`);
mkdirSync(stage, { recursive: true });
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--version'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('TypeScript unavailable');
for (const name of ['main.cjs', 'preload.cjs', 'service-entry.cjs', 'windows-job.cjs', 'browser-view.cjs', 'browser-bookmarks.cjs', 'browser-passwords.cjs', 'browser-tab-preload.cjs', 'legacy-prefs.cjs', 'notification-routing.cjs']) cpSync(join(here, name), join(stage, name));
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
cpSync(join(root, 'system-prompts'), join(runtime, 'system-prompts'), { recursive: true });
writeFileSync(join(stage, 'runtime.json'), JSON.stringify({ workingDirectory: resolve(process.env.MYHARNESS_DESKTOP_CWD || root) }));
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'myharness-desktop', productName: 'MyHarness', version: '0.0.3', main: 'main.cjs', author: 'MyHarness', description: 'MyHarness Windows desktop', license: 'Apache-2.0' }));
await sharp(join(root, 'packages/coding-agent/web/favicon.svg')).resize(256, 256).png().toFile(join(stage, 'icon.png'));
// ICO containing PNG, supported by Windows Vista and later.
const png = readFileSync(join(stage, 'icon.png'));
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
writeFileSync(join(stage, 'icon.ico'), Buffer.concat([header, png]));
console.log(`Desktop runtime: ${copied.size} dependency copies; staging ${stage}`);
await build({ projectDir: stage, config: { appId: 'com.myharness.desktop', productName: 'MyHarness', electronVersion, electronDist, asar: false, npmRebuild: false, directories: { output: destination }, files: ['*.cjs', '*.json', '*.png', '*.ico'], extraFiles: [{ from: join(stage, 'runtime/system-prompts'), to: 'resources/app/runtime/system-prompts' }, { from: join(stage, 'runtime/node_modules'), to: 'resources/app/runtime/node_modules' }, { from: join(stage, 'node_modules'), to: 'resources/app/node_modules' }], win: { target: [{ target: 'dir', arch: ['x64'] }], icon: join(stage, 'icon.ico'), signExecutable: false } } });
console.log(`DESKTOP_EXECUTABLE=${join(destination, 'win-unpacked/MyHarness.exe')}`);
