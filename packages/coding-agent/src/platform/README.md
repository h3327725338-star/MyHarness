# platform/ — 进程与网络的平台适配

## 说明

### 职责

集中处理与操作系统、Node 进程、HTTP 相关的差异，让上层不用各自处理。

### process/

| 文件 | 内容 |
| --- | --- |
| `exec.ts` | `execCommand()`：给扩展和自定义工具用的通用命令执行（超时、取消、输出收集） |
| `http-dispatcher.ts` | 全局 HTTP 分发器：空闲超时选项、代理设置；`configureHttpDispatcher()` 在 `web.ts` 启动时调用 |
| `output-guard.ts` | 接管/恢复 `stdout`，保证 print/json 模式输出干净，以及原始写入与背压 |

### 依赖

- 依赖：`utils/child-process.ts`、`utils/shell.ts`、`undici`。
- 被依赖：`web.ts`、`main.ts`、`config/settings`、`extensions`、`modes/*`、`package-manager-cli.ts`。

## 维护

- 需要新的子进程或输出接管能力时加在这里，不要在工具或命令里再写一套。
- `output-guard.ts` 影响 `--mode json` 的输出格式；改动后跑 `stdout-cleanliness.test.ts` 和 `print-mode.test.ts`。
- HTTP 空闲超时的可选值同时被 Settings 和界面使用，修改时同步 `config/settings` 与 `docs/settings.md`。
- 相关测试：`exec.test.ts`、`http-dispatcher.test.ts`、`stdout-cleanliness.test.ts`。
