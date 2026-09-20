# Agent Core 维护手册

## 领域边界

Agent Core 负责：

- `Agent` state、prompt/continue 生命周期和 event subscription；
- steering/follow-up 队列、取消、重试和 tool execution 生命周期；
- `AgentMessage` 到 LLM `Message` 的转换入口；
- `agent-loop` 的 stream、tool call、assistant response 和 stop/error 处理；
- harness/session/compaction 的可复用 contract。

Agent Core 不负责：

- Provider catalog、API key/OAuth 的具体产品 UI；
- Coding Agent 的 CLI/TUI 展示；
- Node-only `node:sqlite` 实现；
- 用户目录路径解析和项目 Trust。

## 修改检查点

1. 读取 `packages/agent/src/index.ts`、`agent.ts`、`agent-loop.ts` 及调用方。
2. 检查 `AgentOptions`、`AgentState`、event union、`streamFunction`、`convertToLlm` 和 `transformContext` 的兼容性。
3. 保留取消、队列模式、tool execution、错误 stop reason 和 session ID 语义。
4. 需要持久化时只通过 session/harness contract 连接；不要在 Agent Core 直接写产品 JSONL、SQLite 或 TUI。
5. 公共导出变化要同步 package exports、README、SDK/Agent 文档和相关测试。

## 验证入口

```powershell
npm.cmd --workspace packages/agent run test
npm.cmd --workspace packages/agent run test:harness
npm.cmd --workspace packages/agent run coverage:harness
```

当前 package 的测试由 Vitest 驱动；SQLite harness 测试会导入独立 `storage/sqlite-node` 的源码。命令是否通过必须以实际运行结果为准，本手册不预先声明测试状态。

## 兼容性和安全

- 不删除旧 Session/Settings/migration contract，除非有明确迁移方案。
- 不在 event、错误、测试快照或日志中输出 API key、OAuth token、cookie 或完整请求头。
- `Agent` 是可复用 library API；不要把 Coding Agent 的中文 UI 文案、具体 slash command 或项目路径硬编码进来。
