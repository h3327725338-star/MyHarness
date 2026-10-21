import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  const executable = require('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [here], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(`Electron 启动失败：${error.message}`); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code || 0; });
} catch (error) {
  console.error(`Electron 二进制未就绪：${error.message}\n请运行 npm exec -w @myharness/desktop -- install-electron 下载，然后重试。`);
  process.exitCode = 1;
}
