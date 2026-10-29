const test = require('node:test');
const assert = require('node:assert/strict');
const { appContextMenu, attachAppContextMenu } = require('../app-context-menu.cjs');

const say = (english) => english;
const page = 'http://127.0.0.1:7967/';
const fakes = () => {
  const calls = [];
  return {
    calls,
    contents: { copyImageAt: (x, y) => calls.push(['copyImageAt', x, y]), downloadURL: (url) => calls.push(['downloadURL', url]) },
    clipboard: { writeText: (text) => calls.push(['writeText', text]) },
  };
};
const labels = (template) => template.map((item) => (item.type === 'separator' ? '—' : item.label));

test('selected text in the page gets Copy, and nothing else is offered', () => {
  const { contents, clipboard } = fakes();
  const template = appContextMenu({ selectionText: 'hello', pageURL: page, editFlags: {} }, { contents, clipboard, say });
  assert.deepEqual(labels(template), ['Copy']);
  assert.equal(template[0].role, 'copy');
});

test('a right-click on empty page shows no menu', () => {
  const { contents, clipboard } = fakes();
  assert.deepEqual(appContextMenu({ selectionText: '  ', pageURL: page, editFlags: {} }, { contents, clipboard, say }), []);
});

test('a text field gets the editing commands, enabled as the engine says', () => {
  const { contents, clipboard } = fakes();
  const template = appContextMenu({ isEditable: true, pageURL: page, editFlags: { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }, { contents, clipboard, say });
  assert.deepEqual(labels(template), ['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', '—', 'Select all']);
  assert.equal(template.find((item) => item.role === 'undo').enabled, false);
  assert.equal(template.find((item) => item.role === 'paste').enabled, true);
});

test('a picture can be copied and saved; only an outside picture offers its address', () => {
  const { contents, clipboard, calls } = fakes();
  const own = appContextMenu({ mediaType: 'image', srcURL: `${page}api/sessions/image?id=1`, x: 10, y: 20, pageURL: page, editFlags: {} }, { contents, clipboard, say });
  assert.deepEqual(labels(own), ['Copy image', 'Save image as…']);
  own[0].click();
  own[1].click();
  assert.deepEqual(calls, [['copyImageAt', 10, 20], ['downloadURL', `${page}api/sessions/image?id=1`]]);
  const outside = appContextMenu({ mediaType: 'image', srcURL: 'https://example.com/a.png', selectionText: '', pageURL: page, editFlags: {} }, { contents, clipboard, say });
  assert.deepEqual(labels(outside), ['Copy image', 'Save image as…', 'Copy image address']);
  outside[2].click();
  assert.deepEqual(calls.at(-1), ['writeText', 'https://example.com/a.png']);
});

test('a web or mail link offers its address after the text commands; an app link does not', () => {
  const { contents, clipboard, calls } = fakes();
  const template = appContextMenu({ linkURL: 'https://example.com/x', selectionText: 'x', pageURL: page, editFlags: {} }, { contents, clipboard, say });
  assert.deepEqual(labels(template), ['Copy', '—', 'Copy link address']);
  template[2].click();
  assert.deepEqual(calls, [['writeText', 'https://example.com/x']]);
  assert.deepEqual(labels(appContextMenu({ linkURL: 'mailto:a@example.com', pageURL: page, editFlags: {} }, { contents, clipboard, say })), ['Copy link address']);
  assert.deepEqual(appContextMenu({ linkURL: `${page}#/settings`, pageURL: page, editFlags: {} }, { contents, clipboard, say }), []);
});

test('the window shows the menu only when there is something in it', () => {
  const listeners = {};
  const shown = [];
  const window = { webContents: { on: (name, listener) => { listeners[name] = listener; } } };
  const Menu = { buildFromTemplate: (template) => ({ popup: (options) => shown.push({ template, options }) }) };
  attachAppContextMenu(window, { Menu, clipboard: fakes().clipboard, say });
  listeners['context-menu']({}, { pageURL: page, editFlags: {} });
  assert.equal(shown.length, 0);
  listeners['context-menu']({}, { selectionText: 'hi', pageURL: page, editFlags: {} });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.window, window);
});
