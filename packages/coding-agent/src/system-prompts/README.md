# system-prompts/ — 系统提示的加载与组装（代码）

## 说明

### 职责

这里只有代码。系统提示的**文本**在仓库根的 `system-prompts/` 目录（Markdown 文件），不在这里。

### loader/

`index.ts`：

- 原样导出 `@myharness/ai/api/system-prompt-loader` 的 `loadSystemPrompt()` 等（定位并读取根目录的提示文件）；
- `discoverSystemPromptFile()` / `discoverAppendSystemPromptFile()`：查找用户的 `SYSTEM.md` 和 `APPEND_SYSTEM.md`。受信任时项目文件优先于全局文件，不受信任时只用全局文件；每个名称只取一个来源；
- `resolveSystemPromptInput()`：把 CLI 传入的提示（文本或文件路径）解析成文本。

### composer/

`index.ts`：`buildSystemPrompt()`。按固定顺序组装：全局核心规则、工具说明与路由规则、自定义/追加提示、项目上下文、Skill 清单、工作目录、模型身份、输出语言、角色边界。`applyAgentRoleBoundary()` 给非主 Agent 加上角色限制。`collectSystemPromptOptions()` 从已加载的资源（Skill、项目上下文文件、`SYSTEM.md`/`APPEND_SYSTEM.md`）、当前启用的工具和模型收集 `buildSystemPrompt()` 的输入。

### 依赖

- 依赖：`@myharness/ai/api`、`src/config.ts`、`agent/runtime/role.ts`、`context/context-policy.ts`、`skills/loader`。
- 被依赖：`agent/runtime`、`application`、`extensions/runtime`，以及所有需要读取提示文本的模块（`tools/*`、`context/compact`、`skills/loader`、`ultracode`、`agent/vision`）。

## 维护

- 改提示内容：改根目录 `system-prompts/` 下的 Markdown，并看 `system-prompts/README.md`、`maintenance.md`。不要在 TypeScript 里写大段提示文本。
- 改顺序或条件：只改 `composer/index.ts`。顺序会影响 Provider 的前缀缓存，尽量保持系统提示在多轮之间字节稳定。
- 根目录没有被 loader 引用的提示文件不会生效；新增文件时要有对应的加载代码。
- 仓库自己的开发规则（根 `AGENTS.md`）不属于产品系统提示。
- 相关测试：`system-prompt.test.ts`、`system-prompt-files.test.ts`、`cache-stability.test.ts`，以及 `packages/ai/test/system-prompt-*.test.ts`。
