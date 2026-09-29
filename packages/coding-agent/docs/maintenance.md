# Coding Agent 产品维护手册

## 启动和装配

当前启动链是 `src/cli.ts` → `src/main.ts`。`main.ts` 在完成参数、Project Trust、Settings、资源、Provider 和 Session 准备后，进入 `InteractiveMode`、print mode，或（`--web`）Web mode。Web mode 会先在 `startWebBootstrap` 里启动 loopback HTTP 服务（这样 Project Trust 问题可以在浏览器里回答），runtime 创建后由 `runWebMode` 接管；细节见 [Web UI](web-ui.md)。新增跨领域装配应优先放 `application/`，不要把所有流程继续堆进 CLI 或具体 UI component。

## Provider / Model 维护

当前 MyHarness AI package 和 `ModelRuntime.create()` 没有默认 Provider catalog。Coding Agent 产品入口会显式注册 OpenAI ChatGPT；除此之外，`ModelRuntime` 从 `models.json`、模型 store、credential 和 extension/native Provider registration 组装 catalog 和 active collection；Provider 环境变量只在相应 Provider 已存在时参与 auth resolution。修改 Provider 时同步检查：

- `providers/models/config.ts` 的 models.json schema；
- `providers/models/composer.ts` 的 base/config/extension 组合；
- `providers/runtime/provider-runtime.ts` 的 active/catalog、refresh、auth、request path；
- `providers/models/store.ts` 的 cache；
- `settings`/Provider UI、`docs/providers.md`、`docs/models.md` 和相关测试。

不要把 API implementation、Provider 注册和真实网络请求混写成一个“内置 Provider 已支持”的结论。

## Session / data / Prompt

- Session JSONL、版本、migration、projection 和 manager 由 `session/` 维护；Workspace registry 由 `data/` 维护。
- Prompt template、skill、theme 和 system prompt 分别有 loader；Project Trust 决定 project-local 资源是否生效。
- 修改 Prompt 资源时同步 `system-prompts/README.md`、AI loader、Coding Agent composer 和测试；不要新增未在实际 loader 中引用的文件。

## Tool / UI / platform

- `tools/` 的 execution details 与 `tools/presentation/` 的展示保持分离。
- `modes/interactive` 负责产品交互；可复用 terminal component 应放 `packages/tui`。
- `modes/web` 只做传输和展示投影：不复制 Agent、Session、Git、Provider 逻辑，改动 wire 格式或新增 API 前先读 [Web UI](web-ui.md) 的“维护”一节；前端（`packages/coding-agent/web/`）没有构建步骤。
- UI 交互修改遵循 [Interaction guidelines](interaction-guidelines.md) 和 [TUI design system](tui-design-system.md)；共享 `SettingItem`/`SettingsList` contract 在产品层统一 Settings、导航、Action、状态和键盘行为。
- `platform/process` 负责 Windows/Bun/Node 进程和 stdout 边界；不要在每个 tool 中复制。
- `symbols` 的结果要保留 backend/source 信息；semantic backend 不可用时不能伪称已成功启动语言服务器。

## 常用验证

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build:offline
npm.cmd --workspace packages/coding-agent run test
npm.cmd run check:ts-imports
npm.cmd run check:pinned-deps
npm.cmd run check:shrinkwrap
npm.cmd run check:install-lock:coding-agent
```

`npm.cmd run check` 会格式化写入；真实 CLI、InteractiveMode、Bun binary、外部 Provider、LSP 和完整 browser smoke 需要单独执行并单独报告。

## 文档同步

以下变化必须同步相关说明：公共 exports、CLI 参数/命令、settings key、Provider/model config、Session format/migration、Prompt loading、Extension contract、启动/构建方式。历史 changelog 和 Phase 文档只做历史记录，不用来掩盖当前实现差异。
