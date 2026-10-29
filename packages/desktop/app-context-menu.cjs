// The right-click menu of the app window (the Web UI). The page has no menu of its own for text, links and pictures, so
// the host gives the usual one for what was clicked: editing commands in a text field, Copy for selected text, a link's
// address, and Copy / Save as for a picture. Nothing is shown when there is nothing to do. A part of the page with its
// own menu (a chat row, a file) cancels the page's contextmenu event, and then the engine asks for no menu at all.

/** A link or picture address worth copying: a web or mail address, not one of the app's own pages or a data: picture. */
function outsideAddress(url, pageUrl) {
  let address;
  try { address = new URL(url); } catch { return false; }
  if (address.protocol === 'mailto:') return true;
  if (address.protocol !== 'http:' && address.protocol !== 'https:') return false;
  try { return address.origin !== new URL(pageUrl).origin; } catch { return true; }
}

/**
 * The menu template for one right-click (Electron's context-menu `params`), or [] when there is nothing to offer.
 * `contents` is the app window's webContents, `clipboard` Electron's clipboard, `say(english, chinese)` the host language.
 */
function appContextMenu(params, { contents, clipboard, say }) {
  const flags = params.editFlags || {};
  const groups = [];
  if (params.isEditable) {
    groups.push(
      [{ role: 'undo', label: say('Undo', '撤销'), enabled: !!flags.canUndo }, { role: 'redo', label: say('Redo', '重做'), enabled: !!flags.canRedo }],
      [
        { role: 'cut', label: say('Cut', '剪切'), enabled: !!flags.canCut },
        { role: 'copy', label: say('Copy', '复制'), enabled: !!flags.canCopy },
        { role: 'paste', label: say('Paste', '粘贴'), enabled: !!flags.canPaste },
      ],
      [{ role: 'selectAll', label: say('Select all', '全选'), enabled: flags.canSelectAll !== false }],
    );
  } else if (params.selectionText?.trim()) {
    groups.push([{ role: 'copy', label: say('Copy', '复制') }]);
  }
  if (params.linkURL && outsideAddress(params.linkURL, params.pageURL)) {
    groups.push([{ label: say('Copy link address', '复制链接地址'), click: () => clipboard.writeText(params.linkURL) }]);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    const picture = [
      { label: say('Copy image', '复制图片'), click: () => contents.copyImageAt(params.x, params.y) },
      // No save path is set for the app window's downloads, so the engine asks where to save (the usual Save As dialog).
      { label: say('Save image as…', '图片另存为…'), click: () => contents.downloadURL(params.srcURL) },
    ];
    if (outsideAddress(params.srcURL, params.pageURL)) picture.push({ label: say('Copy image address', '复制图片地址'), click: () => clipboard.writeText(params.srcURL) });
    groups.push(picture);
  }
  return groups.flatMap((group, index) => (index ? [{ type: 'separator' }, ...group] : group));
}

/** Shows `appContextMenu` on every right-click in `window`'s page. */
function attachAppContextMenu(window, { Menu, clipboard, say }) {
  const contents = window.webContents;
  contents.on('context-menu', (_event, params) => {
    const template = appContextMenu(params, { contents, clipboard, say });
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });
}

module.exports = { appContextMenu, attachAppContextMenu };
