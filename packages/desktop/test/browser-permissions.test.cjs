const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPermissionStore } = require('../browser-permissions.cjs');

test('site permission decisions survive a restart and a revoke removes them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-permissions-'));
  try {
    const file = path.join(dir, 'browser-permissions.json');
    const first = createPermissionStore(file);
    first.set('https://teams.cloud.microsoft\0window-management', true);
    first.set('https://example.com\0media', false);
    const again = createPermissionStore(file);
    assert.equal(again.get('https://teams.cloud.microsoft\0window-management'), true);
    assert.equal(again.get('https://example.com\0media'), false);
    assert.equal(again.get('https://example.com\0geolocation'), undefined);
    assert.equal(again.delete('https://example.com\0media'), true);
    assert.deepEqual([...createPermissionStore(file)], [['https://teams.cloud.microsoft\0window-management', true]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged permission file starts empty and a store without a file keeps decisions in memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-permissions-'));
  try {
    const file = path.join(dir, 'browser-permissions.json');
    fs.writeFileSync(file, '{ not json');
    const logged = [];
    const store = createPermissionStore(file, (line) => logged.push(line));
    assert.equal([...store].length, 0);
    assert.equal(logged.length, 1);
    const memory = createPermissionStore(undefined);
    memory.set('https://a.example\0notifications', true);
    assert.equal(memory.get('https://a.example\0notifications'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
