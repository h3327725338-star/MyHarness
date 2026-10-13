# modes/ — 运行模式

## 说明

### 职责

`AgentSessionRuntime` 的唯一“外壳”只负责输入和输出：

| 模式 | 入口 | 说明 |
| --- | --- | --- |
| Web UI | `web/web-mode.ts` 的 `runWebMode()` | 本机回环 HTTP + SSE 服务，浏览器前端。详见 [web/README.md](web/README.md) |

`index.ts` 只导出 Web 模式；由 `main.ts` 按参数创建（`startWebBootstrap()` 先起服务、`runWebMode()` 在 runtime 创建后接管）。

### 依赖

- 依赖：`agent/runtime`（会话与运行时）、`application`（资源加载与用例）、各领域的公开函数。
- 被依赖：`main.ts`、`src/index.ts`（`runWebMode`、`startWebBootstrap`）。

## 维护

- 模式只做输入、展示和交互流程。业务规则（Agent 运行、Session 格式、Git、Provider、压缩）留在各自领域；需要多步跨领域流程时写成 `application/use-cases/` 的用例，让 Web 调用。
- Web 订阅的是 `AgentSessionEvent`。改事件含义时检查 `modes/web/host.ts` 与扩展事件。
- 新增一种模式：放在本目录下，由 `main.ts` 创建；不要复制 Agent 或 Session 逻辑。
