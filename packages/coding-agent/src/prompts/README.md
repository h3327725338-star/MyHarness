# prompts/ — Prompt Template 加载

## 说明

### 职责

发现并加载用户/项目的 Prompt Template（`/模板名 参数` 形式调用的 Markdown 文件），以及把调用展开成最终文本。它不负责系统提示，也不负责 Skill。

### loader/

`index.ts`：

- `loadPromptTemplates()`：从全局目录、项目目录和显式路径加载，解析 frontmatter，产生诊断；
- `dedupePromptTemplates()`：同名去重并报告冲突；
- `parseCommandArgs()` / `substituteArgs()`：参数解析与 `$1`、`$@` 等替换；
- `expandPromptTemplate()`：把 `/模板名 参数` 展开为模板内容。

### 依赖

- 依赖：`src/config.ts`、`extensions/contracts`（诊断、`SourceInfo`）、`utils`（frontmatter、路径）。
- 被依赖：`application/resource-loader.ts`、`agent/runtime`。

## 维护

- 项目级模板是否加载由 `application/resource-loader.ts` 按 Project Trust 决定，本目录不判断信任。
- 保留每个模板的 `sourceInfo` 和诊断，界面靠它们显示来源与冲突。
- 系统提示的内容与组装在 `system-prompts/`，不要合并到这里。
- 用户文档：`docs/prompt-templates.md`。相关测试：`prompt-templates.test.ts`。
