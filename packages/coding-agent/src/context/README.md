# context/ — 上下文预算、压缩与项目上下文

## 说明

### 职责

决定“发给模型的上下文里有什么、占多少、超了怎么办”。包括：上下文窗口与预算计算、压缩（compaction）、分支摘要、项目上下文文件加载、按角色过滤，以及宿主“添加到上下文”的文件/差异条目。

### 文件

| 文件 | 内容 |
| --- | --- |
| `context-window.ts` | 上下文窗口设置的解析、规范化、展示格式，模型有效窗口 `getModelContextWindow()` |
| `context-budget.ts` | 当前上下文用量的统一快照 `ContextBudgetSnapshot`，以及超预算时的 `ContextBudgetBlockedError` |
| `coordinator.ts` | `AgentSessionContextCoordinator`：`AgentSession` 用它在每次请求前检查预算、必要时触发自动压缩 |
| `context-breakdown.ts` | 上下文按类别的占用明细（系统提示、工具、消息等），供 Web UI 展示 |
| `context-policy.ts` | 按 Agent 角色过滤项目上下文中的“仅主 Agent”段落 |
| `project-context-loader.ts` | 加载 `AGENTS.md` / `CLAUDE.md`：全局目录 + 从最上层祖先到当前目录 |
| `context-items.ts` | 宿主添加的上下文条目（文件、范围、差异、评论）的校验与序列化 |
| `file-presentation.ts` | 文件预览：路径解析、二进制检测、行数/字节上限 |
| `file-diff.ts` | 文件差异：来自真实 `git diff HEAD` |

### compact/ — 压缩与分支摘要

| 文件 | 内容 |
| --- | --- |
| `compaction.ts` | `prepareCompaction()` 选切分点，`compact()` 调模型生成摘要；用量估算 |
| `branch-summarization.ts` | 会话树切换分支时，对离开的分支生成摘要 |
| `utils.ts` | 对话序列化、文件操作清单、工具执行记录与用户锚点的延续信息、摘要系统提示 |
| `session-compaction.ts` | `SessionCompactionRunner`：一个会话的一次压缩怎么做——选压缩模型与 Thinking 档位、准备切分、让扩展否决或替换、生成并写入检查点、重建上下文和预算、通知扩展。手动和自动压缩共用 |
| `tree-navigation.ts` | `navigateSessionTree()`：在会话树里把叶子移到另一个条目，需要时对离开的分支生成摘要 |
| `index.ts` | 出口 |

`session-compaction.ts` 和 `tree-navigation.ts` 不导入扩展或 Provider：询问扩展、取凭证、查压缩模型都通过各自的 Host 回调，由 `AgentSession` 提供。压缩何时运行、如何取消、向前端发什么事件仍由 `AgentSession` 决定。

### 对外接口

`src/index.ts` 导出 `context/compact`、`context-items.ts`、`file-diff.ts`、`file-presentation.ts`。`extensions/api-entry.ts` 也向扩展提供压缩相关函数。

### 依赖

- 依赖：`agent/runtime`（`messages.ts`、`role.ts`）、`session`（类型、projection、manager 类型）、`config/settings`、`git/repository/integration.ts`（差异）、`tools`（路径和截断工具）、`system-prompts/loader`。
- 被依赖：`agent/runtime`、`application`、`session/projection`（`compact/utils.ts`）、`system-prompts/composer`、`modes/*`、`extensions`、`config/settings`、`cli`。

## 维护

- 所有“当前占了多少、还剩多少”的展示和判断都以 `ContextBudgetSnapshot` 为准，不要在界面里另算一套。
- 压缩会写入 Session 的 `compaction` 条目并改变下一次请求可见的历史；改切分规则或摘要内容前，先看 `docs/compaction.md` 和压缩相关测试。
- 压缩/摘要逻辑不依赖具体界面；不要导入 `modes/interactive`。
- `AGENTS.md`/`CLAUDE.md` 不受 Project Trust 限制（除非 `--no-context-files`）；角色过滤由 `context-policy.ts` 和 composer 执行。
- `session/projection` 依赖 `compact/utils.ts`，这两处有相互引用，改动时避免引入运行时的初始化顺序问题。
- 相关测试：`compaction*.test.ts`、`context-budget.test.ts`、`context-window.test.ts`、`context-policy.test.ts`、`context-items.test.ts`、`file-diff.test.ts`、`file-presentation.test.ts`、`agent-session-compact*.test.ts`、`agent-session-context-*.test.ts`、`branch-summary-extensions.test.ts`。
