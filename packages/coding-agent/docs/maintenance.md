# Coding Agent 产品维护手册

## 启动和装配

当前启动链是 `src/web.ts` → `src/main.ts`。`main.ts` 在完成参数、Project Trust、Settings、资源、Provider 和 Session 准备后，进入唯一的 Web mode。已移除 InteractiveMode、print mode；启动不会读取控制台输入。Web mode 会先在 `startWebBootstrap` 里启动 loopback HTTP 服务（这样 Project Trust 问题可以在浏览器里回答），runtime 创建后由 `runWebMode` 接管；细节见 [Web UI](web-ui.md)。新增跨领域装配应优先放 `application/`，不要把所有流程继续堆进进程入口或具体 UI component。

## Provider / Model 维护

当前 MyHarness AI package 和 `ModelRuntime.create()` 没有默认 Provider catalog。Coding Agent 产品入口也不内置 Provider；`ModelRuntime` 从 `models.json`、模型 store、credential 和 extension/native Provider registration 组装 catalog 和 active collection；Provider 环境变量只在相应 Provider 已存在时参与 auth resolution。修改 Provider 时同步检查：

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
- `web/` 负责浏览器产品交互。Web Terminal 的 node-pty/xterm 是 Web 功能，不属于已移出的 CLI/TUI。
- `modes/web` 只做传输和展示投影：不复制 Agent、Session、Git、Provider 逻辑，改动 wire 格式或新增 API 前先读 [Web UI](web-ui.md) 的“维护”一节；前端（`packages/coding-agent/web/`）没有构建步骤。
- UI 交互修改遵循 [Interaction guidelines](interaction-guidelines.md)；`startup/settings-menu.ts` 保留共享设置元数据，但 Web API 不展示 Terminal 专用设置。
- `platform/process` 负责 Windows/Bun/Node 进程和 stdout 边界；不要在每个 tool 中复制。
- `symbols` 的结果要保留 backend/source 信息；semantic backend 不可用时不能伪称已成功启动语言服务器。

## 大批量 Git 提交

Git repository integration 对 `add`、按路径 `commit` 和失败回滚 `reset` 使用临时 NUL 分隔 pathspec 文件；提交说明通过 `-F` 文件传递，避免 Windows 命令行长度限制。同步与异步入口均保留选定路径提交语义，不会连带提交无关已暂存文件；临时文件在执行后释放。提交成功后先将选定路径的索引内容同步到 HEAD，再用 `update-index --index-info` 重建这些路径的索引条目，清除过期的文件大小和时间记录；不重新暂存工作区内容，不隐藏提交后真正产生的修改，也不改变无关文件的暂存内容。收尾失败会明确报告提交已创建但索引清理失败。

`git/commits/ai-message.ts` 负责只读 Diff 收集与分批提交说明。根据当前模型上下文预算分批，全部片段必须有经校验的分析和来源；关联分组只是线索，不是语义正确性的证明。大摘要分层合并，汇总可按稳定 ID 补读原始片段。分析失败或仓库变化不执行提交，最终由 GitCommitUseCase 正常提交；仅对明确报告的 pre-commit hook 失败启动 Agent 代码修复，最多 3 轮；每轮修复成功后重新采集 Diff、生成说明并带正常 hooks 重试提交。第 3 轮后仍失败则停止并报告轮次上限及最后一次检查错误；修复失败或取消立即停止。修复是否成功依据收尾后保留的 terminalReason，而非已经回到 idle 的实时状态。超时、取消、启动失败及其他 Git 错误不触发修复；不绕过检查或署名。异步 Git 文本输出必须跨 chunk 解码 UTF-8，避免大中文 Diff 被错误替换字符导致仓库变化误报。相关测试包括 `git-commit-batching.test.ts`、`git-ai-message.test.ts`、`git-ai-message-integration.test.ts` 和 Web/用例测试；真实模型描述质量必须单独验证。

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

`npm.cmd run check` 会格式化写入；真实无控制台 Web 启动、Bun binary、外部 Provider、LSP 和完整 browser smoke 需要单独执行并单独报告。

## 文档同步

以下变化必须同步相关说明：公共 exports、CLI 参数/命令、settings key、Provider/model config、Session format/migration、Prompt loading、Extension contract、启动/构建方式。历史 changelog 和 Phase 文档只做历史记录，不用来掩盖当前实现差异。
