# ultracode/ — 调查工具配置

## 说明

### 职责

`profile.ts` 定义 `INVESTIGATION_TOOL_PROFILES`：`workflow` 和 `ultracode` 两种调查工具各自的标签、最少阶段数（workflow 为 1，ultracode 为 2）、工具说明、提示片段和使用规则。工具说明写在 profile 里，提示片段和使用规则从根目录 `system-prompts/tools/` 读取。

它只是配置。真正的执行引擎在 `workflow/engine.ts`，没有第二套 Agent Loop。

### 依赖

- 依赖：`system-prompts/loader`。
- 被依赖：`workflow/engine.ts`。

## 维护

- 改提示片段或使用规则：改根目录 `system-prompts/tools/workflow/`、`system-prompts/tools/ultracode/` 的 Markdown；改工具说明或最少阶段数：改 `profile.ts`。
- 新增一种调查工具：在这里加 profile，并在 `workflow/engine.ts` 加对应的工具定义，再到 `tools/registry.ts` 登记。
- 相关测试：`workflow.test.ts`。
