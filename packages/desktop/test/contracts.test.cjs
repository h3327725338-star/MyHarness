const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
test('browser URL policy rejects native schemes and credentials', () => {
  const file = path.join(__dirname, '../browser-view.cjs');
  const module = new Module(file);
  module.require = (name) => name === 'electron' ? {} : require(name);
  module._compile(fs.readFileSync(file, 'utf8'), file);
  for (const value of ['file:///C:/Windows', 'javascript:alert(1)', 'https://user:secret@example.com']) assert.throws(() => module.exports.httpUrl(value));
  assert.equal(module.exports.httpUrl('https://github.com'), 'https://github.com/');
});
test('Windows Job API can create and release a kill-on-close job', { skip: process.platform !== 'win32' }, () => {
  const job = require('../windows-job.cjs').createJob(); job.close();
});
test('closing a Job terminates its assigned process', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const job = require('../windows-job.cjs').createJob();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  job.assign(child.pid);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  job.close();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Job did not terminate child')), 3000).unref())]);
  assert.notEqual(child.exitCode, null);
});
test('preload exposes no raw Electron or Node APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.doesNotMatch(source, /exposeInMainWorld\(['"](?:fs|require|ipcRenderer|electron)['"]/);
  assert.match(source, /contextBridge.exposeInMainWorld/);
});
