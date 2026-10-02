# modes/ — 运行模式

## 说明

### 职责

同一个 `AgentSessionRuntime` 有三种“外壳”，各自只负责输入和输出：

| 模式 | 入口 | 说明 |
| --- | --- | --- |
| 终端交互（TUI） | `interactive/interactive-mode.ts` 的 `InteractiveMode` | 默认模式。详见 [interactive/README.md](interactive/README.md) |
| 单次输出 | `print-mode.ts` 的 `runPrintMode()` | `myharness -p "…"` 输出最终文本；`--mode json` 输出事件流 |
| Web UI | `web/web-mode.ts` 的 `runWebMode()` | `--web`：本机回环 HTTP + SSE 服务，浏览器前端。详见 [web/README.md](web/README.md) |

`index.ts` 是三种模式的出口；由 `main.ts` 根据参数选择。

### 依赖

- 依赖：`agent/runtime`（会话与运行时）、`application`（资源加载与用例）、各领域的公开函数；`interactive/` 额外依赖 `@myharness/tui`。
- 被依赖：`main.ts`、`src/index.ts`；`interactive/` 的主题、组件、快捷键还被 `cli`、`extensions`、`exports/html`、`tools/presentation` 使用。

## 维护

- 模式只做输入、展示和交互流程。业务规则（Agent 运行、Session 格式、Git、Provider、压缩）留在各自领域；需要多步跨领域流程时写成 `application/use-cases/` 的用例，让 TUI 和 Web 共用。
- 三种模式订阅的是同一套 `AgentSessionEvent`。改事件含义时三处都要看。
- 新增一种模式：放在本目录下，由 `main.ts` 创建；不要复制 Agent 或 Session 逻辑。
- print/json 模式的 stdout 必须干净（见 `platform/process/output-guard.ts`）。相关测试：`print-mode.test.ts`、`stdout-cleanliness.test.ts`。
