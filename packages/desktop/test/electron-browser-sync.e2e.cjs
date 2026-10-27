/*
 * Real-Electron check of the built-in browser's sync between computers (browser-sync.cjs). Not part of `node --test`,
 * because it needs an Electron main process and Windows' safeStorage:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<empty dir>
 *
 * Two desktop profiles in one process stand for two computers; copying a vault file from one profile to the other is
 * what Drive sync does (coding-agent src/sync/browser-data.ts). Checked:
 * - the vault is sealed: neither a cookie value nor a password can be read in it, and a wrong passphrase is refused;
 * - persistent sign-ins and saved passwords arrive on the other computer, session and localhost cookies do not;
 * - a newer sign-in wins, a sign-out here is not undone by an older copy, a removed password is removed there too;
 * - a store file written by sync is read again (the page hears about new bookmarks), and the Agent cannot set the
 *   passphrase;
 * - after a restart nothing is resealed when nothing changed, and turning sync off and on keeps the same vault name.
 *
 * The window is never shown. It prints a JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow, session, safeStorage } = require('electron');
const fs = require('node:fs');
const { join } = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
if (!profile) {
  console.error('usage: electron electron-browser-sync.e2e.cjs --profile=<dir>');
  app.exit(2);
}
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', join(profile, 'app'));
app.on('window-all-closed', () => {});

const report = { checks: [], failures: [] };
const check = (ok, name, detail) => {
  report.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  process.stderr.write(`${ok ? 'ok' : 'FAIL'} - ${name}\n`);
  if (!ok) report.failures.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  return !!ok;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(80);
  }
  return undefined;
};
const rejects = async (promise) => { try { await promise; return null; } catch (error) { return error; } };

const { createBrowserSync } = require('../browser-sync.cjs');
const { createPasswordStore } = require('../browser-passwords.cjs');

const PASSPHRASE = 'correct horse battery';
const future = () => Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const computer = (name) => {
  const dir = join(profile, name);
  fs.mkdirSync(dir, { recursive: true });
  const partition = session.fromPartition(`persist:sync-test-${name}`);
  const passwords = createPasswordStore({
    file: join(dir, 'browser-logins.bin.json'),
    crypto: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptString(text), decrypt: (buffer) => safeStorage.decryptString(buffer) },
  });
  const reloads = [];
  const make = () => createBrowserSync({ profileDir: dir, partition, passwords, safeStorage, stores: { 'browser-bookmarks.json': () => reloads.push(Date.now()) } });
  return { name, dir, partition, passwords, reloads, make, sync: make() };
};
const vaults = (item) => fs.readdirSync(item.dir).filter((name) => /^browser-vault-[a-f0-9]{16}\.json$/.test(name));
// A computer's own vault: the one it sealed, not a copy another computer's sync brought.
const vaultOf = (item) => item.own || vaults(item)[0];
const carry = (from, to) => {
  const name = vaultOf(from);
  fs.writeFileSync(join(to.dir, name), fs.readFileSync(join(from.dir, name)));
  return name;
};
const cookieValue = async (item, name) => (await item.partition.cookies.get({ name }))[0]?.value;

async function main() {
  await app.whenReady();
  check(safeStorage.isEncryptionAvailable(), 'Windows encryption is available for the passphrase');
  const a = computer('desktop');
  const b = computer('laptop');
  const site = 'https://site.example/';
  await a.partition.cookies.set({ url: site, name: 'sid', value: 'signed-in-on-desktop', expirationDate: future(), secure: true, httpOnly: true });
  await a.partition.cookies.set({ url: site, name: 'tab', value: 'session-only' });
  await a.partition.cookies.set({ url: 'http://localhost:5173/', name: 'dev', value: 'local', expirationDate: future() });
  a.passwords.save({ origin: 'https://site.example', username: 'bob', password: 'p4ssw0rd-secret' });
  a.passwords.save({ origin: 'https://old.example', username: 'bob', password: 'old-secret' });

  check((await rejects(a.sync.setPassphrase('short')))?.message?.includes('8'), 'a passphrase shorter than 8 characters is refused');
  const on = await a.sync.setPassphrase(PASSPHRASE);
  a.own = vaults(a)[0];
  check(on.on === true && vaults(a).length === 1, 'turning sync on seals a vault for this computer', on);
  const sealed = fs.readFileSync(join(a.dir, vaultOf(a)), 'utf8');
  check(!/signed-in-on-desktop|p4ssw0rd-secret|site\.example|bob/.test(sealed), 'the vault shows neither sign-ins, passwords nor sites');
  check(!fs.readFileSync(join(a.dir, 'browser-sync-key.bin.json'), 'utf8').includes(PASSPHRASE), 'the passphrase is kept encrypted on this computer');

  const vaultName = carry(a, b);
  const wrong = await rejects(b.sync.setPassphrase('another passphrase'));
  check(wrong && /同一个口令|相同的口令/.test(wrong.message), 'a passphrase that does not open the other computer\'s vault is refused', wrong?.message);
  check(b.sync.status().on === false, 'after a refused passphrase sync stays off');
  await b.sync.setPassphrase(PASSPHRASE);
  b.own = vaults(b).find((name) => name !== vaultName);
  check(await cookieValue(b, 'sid') === 'signed-in-on-desktop', 'a persistent sign-in arrives on the other computer');
  check(!(await cookieValue(b, 'tab')) && !(await cookieValue(b, 'dev')), 'session and localhost cookies stay on their computer');
  check(b.passwords.forOrigin('https://site.example')[0]?.password === 'p4ssw0rd-secret', 'a saved password arrives on the other computer');
  check(!!b.own && fs.existsSync(join(b.dir, vaultName)), 'each computer seals its own vault beside the other one', vaults(b));

  // Signed in again on the laptop: the newer sign-in reaches the desktop through the watcher.
  await wait(1100);
  await b.partition.cookies.set({ url: site, name: 'sid', value: 'signed-in-on-laptop', expirationDate: future(), secure: true, httpOnly: true });
  await b.sync.syncNow();
  carry(b, a);
  check(await until(async () => (await cookieValue(a, 'sid')) === 'signed-in-on-laptop'), 'a newer sign-in from the other computer replaces the one here', await cookieValue(a, 'sid'));

  // Signed out on the desktop; the laptop's older copy must not sign it back in.
  await wait(1100);
  await a.partition.cookies.remove(site, 'sid');
  await a.sync.syncNow();
  fs.writeFileSync(join(a.dir, vaultOf(b)), fs.readFileSync(join(b.dir, vaultOf(b))).toString().replace(/"sealedAt":"[^"]+"/, `"sealedAt":"${new Date().toISOString()}"`));
  await wait(2000);
  check(!(await cookieValue(a, 'sid')), 'a sign-out here is not undone by an older copy from the other computer', await cookieValue(a, 'sid'));

  // A password removed on the desktop is removed on the laptop.
  const old = a.passwords.list('https://old.example')[0];
  a.passwords.remove(old.id);
  await a.sync.syncNow();
  carry(a, b);
  check(await until(() => b.passwords.list('https://old.example').length === 0), 'a password removed on one computer is removed on the other');
  check(b.passwords.list('https://site.example').length === 1, 'the other saved passwords stay');

  // A store file written by sync is read again.
  fs.writeFileSync(join(b.dir, 'browser-bookmarks.json'), JSON.stringify({ version: 1, bookmarks: [] }));
  check(await until(() => b.reloads.length > 0, 3000), 'a bookmarks file written by sync makes the store read it again');

  // Restart: the times come back from the vault, so an unchanged state seals nothing new.
  const before = fs.statSync(join(a.dir, vaultOf(a))).mtimeMs;
  a.sync.dispose();
  a.sync = a.make();
  await wait(300);
  check(a.sync.status().on === true, 'sync stays on after a restart');
  await a.sync.syncNow();
  check(fs.statSync(join(a.dir, vaultOf(a))).mtimeMs === before, 'nothing changed since the last seal: the vault is not written again');
  const own = vaultOf(a);
  a.sync.turnOff();
  check(a.sync.status().on === false, 'sync can be turned off');
  await a.sync.setPassphrase(PASSPHRASE);
  check(vaults(a).length === 2 && fs.statSync(join(a.dir, own)).mtimeMs > before, 'turned on again, the computer reseals the vault of the same name', vaults(a));

  // Through the desktop host: the page may ask, the Agent may not.
  const window = new BrowserWindow({ show: false, width: 900, height: 600 });
  const events = [];
  window.webContents.send = (channel, value) => { if (channel === 'desktop:status') events.push(value); };
  const host = join(profile, 'host');
  fs.mkdirSync(host, { recursive: true });
  const browser = require('../browser-view.cjs').createBrowser(window, () => {}, { profileDir: host });
  try {
    const status = await browser.command({ action: 'syncStatus' });
    check(status.available === true && status.on === false, 'the page reads the sync status', status);
    check(!!(await rejects(browser.command({ action: 'syncPassphrase', passphrase: PASSPHRASE }, { agent: true }))), 'the Agent cannot set the sync passphrase');
    fs.writeFileSync(join(host, 'browser-bookmarks.json'), `${JSON.stringify({ version: 1, bookmarks: [{ id: 'x1', title: 'Gmail', url: 'https://mail.google.com/mail/u/0/', addedAt: new Date().toISOString() }] })}\n`);
    check(await until(() => events.some((event) => event.type === 'bookmarks' && event.bookmarks?.[0]?.id === 'x1'), 3000), 'bookmarks that sync wrote reach the page at once');
  } finally {
    browser.destroy();
    window.destroy();
  }
  a.sync.dispose();
  b.sync.dispose();
  report.passed = report.failures.length === 0;
}

setTimeout(() => {
  report.failures.push('watchdog: the run did not finish within 90 s');
  console.log(JSON.stringify(report, null, 1));
  app.exit(1);
}, 90000).unref();

main()
  .catch((error) => report.failures.push(`crashed: ${error?.stack || error}`))
  .finally(() => {
    report.passed = report.failures.length === 0;
    console.log(JSON.stringify(report, null, 1));
    app.exit(report.passed ? 0 : 1);
  });
