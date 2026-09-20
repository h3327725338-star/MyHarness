import xterm from "@xterm/headless";
const { Terminal } = xterm;

const term = new Terminal({ cols: 40, rows: 10, scrollback: 20, allowProposedApi: true });

// Write some initial content that fills the screen and scrolls
for (let i = 0; i < 15; i++) {
    term.write(`Line ${i}\r\n`);
}

// Check cursor position
const cur = term.buffer.active.cursorY;
const viewportY = term.buffer.active.viewportY;
console.log(`After 15 lines: cursorY=${cur}, viewportY=${viewportY}, baseY=${term.buffer.active.baseY}, length=${term.buffer.active.length}`);

// Now do \x1b[2J\x1b[H
term.write("\x1b[2J\x1b[H");
console.log(`After 2J;H: cursorY=${term.buffer.active.cursorY}, viewportY=${term.buffer.active.viewportY}, baseY=${term.buffer.active.baseY}, length=${term.buffer.active.length}`);

// Write new content (10 lines)
for (let i = 0; i < 10; i++) {
    term.write(`New ${i}\r\n`);
}
console.log(`After 10 new lines: cursorY=${term.buffer.active.cursorY}, viewportY=${term.buffer.active.viewportY}, baseY=${term.buffer.active.baseY}, length=${term.buffer.active.length}`);

// Check buffer content
console.log("Buffer lines:");
for (let i = 0; i < term.buffer.active.length; i++) {
    const line = term.buffer.active.getLine(i);
    const text = line?.translateToString(true).trim() || "(null)";
    const marker = i === term.buffer.active.cursorY ? " <-- CURSOR" : "";
    console.log(`  ${i}: "${text}"${marker}`);
}

// Check viewport content
const vy = term.buffer.active.viewportY;
console.log(`\nViewport content (viewportY=${vy}):`);
for (let i = vy; i < vy + 10 && i < term.buffer.active.length; i++) {
    const line = term.buffer.active.getLine(i);
    const text = line?.translateToString(true).trim() || "(null)";
    console.log(`  ${i}: "${text}"`);
}
