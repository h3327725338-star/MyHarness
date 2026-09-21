# System Prompts 维护手册

本目录保存可编辑的静态 Prompt 文本；它不是 Prompt 编译产物，也不是运行时日志。功能说明见 [README](README.md)，后续方向见 [roadmap](roadmap.md)。

## 修改边界

- 固定文本只改 `system-prompts/` 下对应的 UTF-8 `.md` 文件。
- 加载、变量替换、编码和 warning 语义以 `packages/ai/src/api/system-prompt-loader.ts` 为准。
- 编程会话的组合、角色重建和扩展变换以 `packages/coding-agent/src/system-prompts/composer/`、`loader/` 及相关 `AgentSession` 源码为准。
- 本目录只维护面向所有 MyHarness 项目的产品运行时 System Prompt。仓库自己的 CI、维护流程、开发规则和 Agent 文档不写入这里；它们由根 `AGENTS.md`、`DOCUMENTATION_INDEX.md` 和专题维护手册负责。
- 用户 `SYSTEM.md`、`APPEND_SYSTEM.md`、`AGENTS.md`、`CLAUDE.md`、Skill 和 Extension Prompt 不复制到本目录；它们继续由各自 loader 负责。项目受信任时，项目 SYSTEM/APPEND 文件优先于全局同名文件；不受信任时使用全局文件，不能把两者简单合并。
- 不为不存在的运行时行为新增静态文件。当前 `/commit` 的授权边界由 Coding Agent 源码处理，不对应本目录中的 `session/commit-authorization.md`。

## 修改步骤

1. 先用 `rg --files system-prompts` 确认目标文件真实存在，再读对应 loader/composer 和测试。
2. 保留现有模板变量、文本作用域、文件末尾换行和英文正文约定；不要把 API schema 或 user message 模板误迁为 system Prompt。
3. 同步更新 `system-prompts/README.md` 的文件表或加载说明（确实受影响时才改）。
4. 运行受影响 package 的测试；需要确认新文本已被进程读取时，重启 MyHarness。当前没有 watcher。
5. 检查 `git diff --check`，确认没有把本机路径、Token、Cookie 或会话内容写入 Prompt。

## 验证边界

- 静态核对只能证明文件和 loader/composer 的关系；不能证明外部 Provider 已收到新 Prompt。
- 测试通过只能证明测试覆盖的 loader/composer 行为；不能替代真实 CLI、OAuth 或模型请求验证。
- `MYHARNESS_SYSTEM_PROMPT_DIR` 是替代目录，不是缺失文件的回退目录；文档和测试都应保持这一点。
- 可由机器判断的仓库开发和 CI 约束应由 workflow、脚本和测试执行，不能只依赖本目录中的 Prompt 文本。
