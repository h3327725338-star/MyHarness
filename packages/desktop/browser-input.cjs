// Keyboard input of the Agent's own keyboard in the built-in browser: a key name or a combination ("Enter",
// "Control+A", "Shift+Tab", "a") becomes the DevTools protocol key events a real key press produces. The page receives
// trusted keydown/keypress/keyup events, so shortcuts and editing commands behave as when a person presses them.

const MODIFIERS = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', keyCode: 18 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  command: { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};

/** Named keys: DOM `key`, `code`, Windows virtual key code, and the text the key types (if any). */
const NAMED = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
for (let index = 1; index <= 12; index++) NAMED[`f${index}`] = { key: `F${index}`, code: `F${index}`, keyCode: 111 + index };

const PUNCTUATION = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
};

/** One key without modifiers: a named key, a letter, a digit or a punctuation mark. */
const describeKey = (name) => {
  const named = NAMED[name.toLowerCase()];
  if (named) return { ...named };
  if ([...name].length !== 1) throw new Error(`未知的按键：${name}`);
  const char = name;
  if (/^[a-z]$/i.test(char)) return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0), text: char };
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  const punctuation = PUNCTUATION[char];
  if (punctuation) return { key: char, code: punctuation[0], keyCode: punctuation[1], text: char };
  // Any other single character is typed as text (no physical key to name).
  return { key: char, code: '', keyCode: 0, text: char };
};

/**
 * The events of one combination, e.g. "Control+Shift+K": modifiers down in order, the key down (with its text when it
 * types one and no command modifier is held), the key up, modifiers up in reverse order.
 */
exports.keyEvents = (combo) => {
  const parts = String(combo || '').split('+').map((part) => part.trim());
  // "Control++" means Control and the plus key.
  const names = parts.reduce((list, part, index) => {
    if (part === '' && index > 0 && parts[index - 1] === '') return list;
    list.push(part === '' ? '+' : part);
    return list;
  }, []);
  if (!names.length || names.some((name) => !name)) throw new Error(`无法识别的按键组合：${combo}`);
  const keyName = names[names.length - 1];
  const held = names.slice(0, -1).map((name) => {
    const modifier = MODIFIERS[name.toLowerCase()];
    if (!modifier) throw new Error(`未知的修饰键：${name}（可用 Control、Shift、Alt、Meta）`);
    return modifier;
  });
  const lone = MODIFIERS[keyName.toLowerCase()];
  const key = lone ? { key: lone.key, code: lone.code, keyCode: lone.keyCode } : describeKey(keyName);
  let bits = 0;
  const events = [];
  for (const modifier of held) {
    bits |= modifier.bit;
    events.push({ type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, nativeVirtualKeyCode: modifier.keyCode, modifiers: bits });
  }
  const shifted = (bits & 8) !== 0;
  let text = key.text;
  if (text && shifted && /^[a-z]$/.test(text)) text = text.toUpperCase();
  // Control, Alt or Meta turn a printable key into a command (Ctrl+A selects all), so no character is typed.
  const command = (bits & (1 | 2 | 4)) !== 0;
  const base = { key: text && !command ? text : key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: bits };
  if (text && !command) events.push({ type: 'keyDown', ...base, text, unmodifiedText: key.text });
  else events.push({ type: 'rawKeyDown', ...base });
  events.push({ type: 'keyUp', ...base });
  for (const modifier of [...held].reverse()) {
    bits &= ~modifier.bit;
    events.push({ type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, nativeVirtualKeyCode: modifier.keyCode, modifiers: bits });
  }
  return events;
};
