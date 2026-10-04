# 后续开发路线与边界

这是基于当前源码整理的开发候选清单，不是排期，也不代表功能已经实现。每项工作开始前都要重新核对源码和测试；源码变化后以新的实现为准。

## 当前基线

- 产品入口是 `packages/coding-agent/src/web.ts` → `main.ts`；跨领域装配由 `application/resource-loader.ts` 和 `AgentSession` 完成。
- Agent Core 只处理 Agent state、event、loop、tool lifecycle、取消和队列，不拥有 Provider catalog、TUI 或 Node SQLite。
- AI 包提供 Provider/Models/API/auth contract，但 `providers/all.ts` 不提供上游 Provider catalog；应用必须注册或配置 Provider。
- Coding Agent 的 model runtime 负责 `models.json`、credential、模型 store 和 extension/native Provider 组合。
- Session 当前以 Coding Agent JSONL storage 为产品层路径；Node SQLite 是独立 backend，不能假设产品默认已经切换到它。

## 候选方向

### Provider 与模型运行时

目标：让 `models.json`、extension Provider、credential、缓存和模型解析继续保持清晰边界。

验收条件：Provider 未配置时不会被文档或 UI 伪称为可用；refresh 的 network/cache/cancel/error 状态可观察；API implementation、Provider registration 和真实请求分别有测试证据。

禁止把 `packages/ai/src/providers/all.ts` 重新写成假 catalog 来解决产品层配置问题。

### Agent / Session 能力

目标：扩展 Agent event、队列、取消、compaction、branch 和 persistence 时，沿用现有 Agent/Session contract。

验收条件：新增状态可持久化、恢复、分支和失败；对应 JSONL/migration/SQLite（若涉及）测试同时更新；不把 UI 特例写进 Agent Core。

### Storage backend

目标：继续完善 SQLite backend 或新增 backend 时复用 `packages/storage/sqlite-node/src/sqlite/types.ts` 的抽象。

验收条件：每个 schema 变化都有递增 migration、transaction rollback、materialized state 重建和重开恢复测试；明确 backend 是否真的被产品 runtime 选用。

### Coding Agent 模块演进

目标：保持 `agent/runtime`、`session`、`context`、`providers`、`tools`、`extensions`、`git`、`modes` 等领域边界。

验收条件：新逻辑放入职责最接近的现有目录；公共能力通过正式 API entry/runtime 连接；`src/utils` 不吸收领域业务；新 CLI mode 必须有参数、生命周期和 output contract 测试。

### Prompt、skills 与 extensions

目标：固定系统文本、组合逻辑、用户资源和 extension 变换继续可追踪。

验收条件：修改 Prompt 时同步 loader/composer 文档和相关测试；区分静态文本生效、Project Trust、extension transform 与真实 Provider 请求；不要新增不存在的“隐式”资源文件。

### 工具、Symbols 与 TUI

目标：保持工具执行 contract、presentation、symbols backend 和 TUI 展示层解耦。

验收条件：工具结果可脱敏、可持久化；symbols 明确 lightweight/semantic/runtime source；TUI component 遵守 render/invalidate/focus/overlay contract，并有对应终端测试。

## 每项后续开发都必须留下的记录

1. 受影响的源码目录和公共出口；
2. 配置、Session、migration、Prompt 或 package export 是否改变；
3. 文档入口和 source-to-text 核对结果；
4. 实际运行的测试命令及未验证边界；
5. 是否产生 `dist`、lockfile、用户数据或外部服务写入。
