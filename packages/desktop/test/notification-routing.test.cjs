const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foreignNotificationShortcuts } = require('../notification-routing.cjs');

// Only the build that is still installed exists; the shortcut of a cleaned-up build points at nothing.
const exists = (path) => path.includes('release-1');
const entries = () => [
  // Written by a development run of the checkout's electron.exe: Electron always stores this shortcut without the app
  // path, so Windows would start bare Electron and show its default window instead of this app.
  { name: 'Electron.lnk', aumid: 'MyHarness', target: 'C:\\myharness\\node_modules\\electron\\dist\\electron.exe' },
  // A build that is still installed: starting it forwards to the running app through the single instance lock.
  { name: 'MyHarness.lnk', aumid: 'MyHarness', target: 'C:\\myharness\\dist\\desktop\\release-1\\win-unpacked\\MyHarness.exe' },
  // A build folder that was cleaned up: the shortcut starts nothing.
  { name: 'MyHarness (old).lnk', aumid: 'MyHarness', target: 'C:\\myharness\\dist\\desktop\\release-0\\win-unpacked\\MyHarness.exe' },
  { name: 'Other.lnk', aumid: 'other.app', target: 'C:\\myharness\\node_modules\\electron\\dist\\electron.exe' },
];

test('notification routing removes the shortcuts that claim the app id without starting this app', () => {
  assert.deepEqual(foreignNotificationShortcuts(entries(), { aumid: 'MyHarness', exists }), [
    'Electron.lnk',
    'MyHarness (old).lnk',
  ]);
});

test('notification routing keeps every shortcut of another app id', () => {
  assert.deepEqual(foreignNotificationShortcuts(entries(), { aumid: 'MyHarness.Dev', exists }), []);
});

test('notification routing keeps a shortcut whose executable still starts this app', () => {
  const one = [entries()[1]];
  assert.deepEqual(foreignNotificationShortcuts(one, { aumid: 'MyHarness', exists }), []);
});

test('notification routing treats a shortcut without a local executable as foreign', () => {
  const none = [
    { name: 'Docs.lnk', aumid: 'MyHarness', target: '' },
    { name: 'Shell.lnk', aumid: 'MyHarness', target: 'shell:AppsFolder\\whatever' },
    { name: 'Website.lnk', aumid: 'MyHarness', target: 'https://example.com' },
  ];
  assert.deepEqual(
    foreignNotificationShortcuts(none, { aumid: 'MyHarness', exists: () => true }),
    ['Docs.lnk', 'Shell.lnk', 'Website.lnk'],
  );
});
