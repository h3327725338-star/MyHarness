# skills/ — Skill 加载

## 说明

### 职责

发现并解析 Skill（目录里的 `SKILL.md`），供系统提示列出、供用户用 `/skill:名称` 调用。

### loader/

`index.ts`：

- `loadSkills()`：从全局目录、项目目录和显式路径加载；
- `loadSkillsFromDir()`：扫描一个目录，遵守 ignore 规则，校验 frontmatter（名称、说明等），产生诊断和冲突记录；
- `formatSkillsForPrompt()`：生成系统提示中的 Skill 清单。

### invocation.ts

- `expandSkillCommand()`：把 `/skill:名称 参数` 展开成发给模型的 `<skill …>` 块；
- `parseSkillBlock()`：从用户消息里把这个块解析回来（界面和 HTML 导出用）。

### 依赖

- 依赖：`src/config.ts`、`extensions/contracts`（诊断、`SourceInfo`）、`system-prompts/loader`（清单文案）、`startup/slash-commands.ts`（命令解析）、`utils`（frontmatter、路径）。
- 被依赖：`application/resource-loader.ts`、`agent/runtime`、`system-prompts/composer`、`modes/web`、`src/index.ts`。

## 维护

- 本目录只发现、解析和展开。项目级 Skill 是否加载由 `application/resource-loader.ts` 按 Project Trust 决定。
- Skill 名称校验和同名冲突的优先级是已有行为，改动前看 `skills.test.ts` 和 `regressions/2781-skill-collision-precedence.test.ts`。
- `/skill:名称` 的展开在 `invocation.ts`，由 `AgentSession` 在提交、steer、follow-up 时调用。展开后的 `<skill …>` 块格式被界面和 HTML 导出解析，不能随意改。`parseSkillBlock` 仍从 `agent/runtime/agent-session.ts` 和 `src/index.ts` 导出，保持原有导入路径可用。
- 用户文档：`docs/skills.md`。相关测试：`skills.test.ts`、`sdk-skills.test.ts`。
