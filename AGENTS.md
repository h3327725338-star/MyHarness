# MyHarness Agent Rules

## 项目事实

- 这是一个 npm/TypeScript/ESM monorepo。
- 产品层在 packages/coding-agent/；Agent Core 在 packages/agent/；Provider/AI API 在 packages/ai/；TUI 基础能力在 packages/tui/。
- 当前整体架构和模块归属见 ARCHITECTURE_AND_DEVELOPMENT.md。
- 当前源码没有 packages/coding-agent/src/core/、frontend/、shared/ 或 application/bootstrap/。

## 修改前

- 先读取目标模块的真实源码、调用方、package.json、测试和相关文档。
- 不根据目录名、旧 Phase 文档或经验猜测职责；先确认真实 import/export。
- 任务涉及架构边界、Public API、Session、Settings、Provider、Extension、Prompt 或持久化时，先阅读 ARCHITECTURE_AND_DEVELOPMENT.md 的对应章节。
- 查找已有实现并优先复用；功能有明确领域时放入已有领域目录。

## 修改规则

- 只修改完成当前任务所必须的内容，不顺手重构无关区域。
- 不创建承载任意业务的万能目录，也不把业务逻辑塞进 utils/ 或具体 TUI component。
- Agent 生命周期放 agent/runtime/；Session 格式和 persistence 放 session/；Context/Compact 放 context/；Git 原语放 git/；Provider runtime、Model 和 credential 放 providers/；Tool 放 tools/；Extension 放 extensions/。
- 产品页面放 coding-agent 的 modes/interactive/；可复用终端基础组件放 packages/tui/。
- Tool execution contract 与 presentation 分开；底层业务逻辑不要依赖具体 TUI 展示。
- Application use case 用于跨领域业务流程，不用于替代底层领域模块，也不导入具体 TUI。
- 通过正式 contract、runtime 或 API entry 连接模块，不要为了方便直接依赖不稳定的内部实现。
- 不为了减少代码量破坏已有抽象、错误处理、取消、恢复或持久化语义。
- 不重复实现已经存在的能力。

## 兼容性和安全

- 修改前检查 Public API、package.json exports、src/index.ts、Session JSONL、Settings、Credentials、migration、Extension API、Git metadata 和 Prompt 行为。
- 不因为名称旧就删除 compat、deprecated alias、旧 Session/Settings 格式或 migration。
- 不输出 API Key、OAuth Token、Credential、Cookie、Session 私密内容或用户目录中的敏感数据。
- 非必要不要删除或覆盖 Session、Git metadata、用户配置、cache、Trace 或其他持久化数据。

## 文档同步

如果修改改变了架构、模块职责、路径、Public API、配置、命令、Provider、Session format、Extension contract、Prompt 加载或启动方式，必须同步相关专题文档，并在确实影响整体结构或长期规则时同步 ARCHITECTURE_AND_DEVELOPMENT.md。

普通内部 bugfix 不需要为了形式修改总手册。

## 验证

- 根据修改范围运行最相关测试；不要把未实际运行的命令写成已通过。
- 区分静态检查、单元/集成测试、真实启动、外部 Provider 和机器环境验证。
- npm run check 含 Biome --write，不能把它当作只读检查。
- 构建、lockfile、Session、配置、Git 和用户目录写入都要明确确认影响范围。
- 测试失败时先判断是代码失败、环境失败还是外部服务失败，不要随意修改无关代码。

