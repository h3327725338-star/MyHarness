# MyHarness TUI Design System

这份文档是 MyHarness 当前终端 UI 的视觉和状态设计 contract。它约束产品层 `InteractiveMode` 与可复用的 `@myharness/tui` 组件如何共同表达层级、状态、焦点和反馈；它不改变 Provider、Session、Tool 或 Extension 的数据契约。

## 目标

界面优先满足以下用户可感知的结果：

- 主要回答和用户输入最突出；工具调用、思考和元数据逐级减弱。
- 活动状态、历史结果和错误结果一眼可区分；终态不能继续伪装成运行中。
- 同一语义使用同一套颜色、符号、间距和键盘行为。
- 状态更新不改变历史 transcript 的语义；活动投影只反映当前任务。
- 宽度不足时优先保留身份、状态和可执行提示，次要说明再截断。

这些目标与 ISO 9241-110 / NIST 人机中心设计中的任务适合性、自描述性、符合预期、可控性、容错和个性化原则一致。它们是 review lens，不是把 Web 控件直接搬进终端。

## 当前布局层级

`InteractiveMode` 的稳定顺序是：

1. Header 和已加载资源；
2. 主 transcript：User、Assistant、Thinking、Tool 和错误内容；
3. transient status 与可并存的后台指示器；
4. widgets / overlay；
5. editor / composer；
6. footer 元数据；
7. `TaskStatusBar` 任务级稳定锚点。

规则：

- transcript 是事实记录；完成的工具和思考不重新包装成当前活动。
- transient status 只说明短期反馈；不能覆盖主回答或留下不可操作的“加载中”空壳。
- footer 只承载 cwd、Session、Provider/Model、context 等上下文元数据。
- `TaskStatusBar` 只承载当前 RunState 的一个短投影和时长；它不是第二个 transcript。
- 同一状态可以在 transcript 中保留历史记录，但活动区必须使用当前快照。

## Token 约定

### 语义颜色

产品语义颜色由 `packages/coding-agent/src/modes/interactive/theme/theme.ts` 和主题 JSON 提供：

| 角色 | 用途 |
| --- | --- |
| `text` | 主要正文 |
| `accent` | 当前焦点、活动和可执行强调 |
| `muted` | 工具结果、次要说明 |
| `dim` | footer、提示和低优先级元数据 |
| `success` | 已完成结果 |
| `warning` | 等待用户决定、恢复或可恢复异常 |
| `error` | 失败和错误 |
| `border` / `borderMuted` | 结构分隔，不承担状态含义 |

`packages/tui/src/design-tokens.ts` 只放跨组件的非产品语义 token：`TUI_SYMBOLS` 和 `TUI_SPACING`。颜色仍由调用方主题决定，避免基础 TUI 依赖 Coding Agent 的具体主题。

### 符号与间距

- 活动：`●`；完成：`✓`；错误：`✕`；警告：`⚠`；中断/取消：`■`；恢复：`↻`。
- 选择、导航、动作、禁用：`→ `、`›`、`▶`、`⊘`。
- 工具结果和树形摘要：`⎿`、`├─`、`└─`、`│  `。
- 默认 inline gap 为 2 个终端单元，通用缩进为 2 个终端单元，区块间距为 1 行。

新组件不得重新定义这些常用符号；如果领域语义确实不同，应在代码和测试中说明原因。

## 状态投影

`RunState` 是运行时事实，`TaskLifecyclePhase` 是交互工作流阶段。两者不能互相覆盖事实：

| 情况 | 活动区显示 |
| --- | --- |
| `queued` / `starting` / `running` / `waiting` / `recovering` | 活动符号、简短 activity 和可选 detail |
| `completion` 且 RunState 非终态 | 完成工作流的活动提示 |
| `awaiting_decision` 且 RunState 非终态 | 等待用户决定和等待时长 |
| `completed` / `failed` / `blocked` / `timed_out` / `cancelled` / `interrupted` | 终态符号和用时，不显示运行中、重试、加载或等待计时 |

终态优先于 transient phase。Git checkpoint 或其他真实决策仍可打开 selector；selector 是当前可操作控件，底部任务锚点仍应保留已经发生的终态，而不是把任务改写成“正在等待”。

持久化的未决 checkpoint 不是活动 selector：用户取消选择器后，checkpoint 可以继续保留，之后只能由用户输入 `/undo` 重新打开；任务 phase 回到 `idle`，下一条普通消息照常发送，不能被 checkpoint 拦截、清空或替换成恢复选择。

## 交互与焦点

设置和导航语义以 [Interaction guidelines](interaction-guidelines.md) 为准：

- Boolean 使用即时 `toggle`；Enum / 预设值使用 `select` 子页；导航使用 `›`；Action 使用 `▶`。
- Enter 与 Space 在列表中保持一致；Esc 返回或取消；disabled 项可见但不可激活。
- 子页或 overlay 接管输入时，父列表保留选中项；关闭后恢复原焦点。
- 空列表要明确区分“没有数据”和“没有匹配项”，方向键不能制造无效焦点。

## 组件迁移规则

- 新的状态行优先复用 `TaskStatusBar`、`StatusIndicator`、`Loader` 和主题回调，不再创建独立的计时器、颜色表或状态符号。
- 连续的只读工具可以分组；工具结果保持弱于主要回答，但错误必须保留可见。
- 自定义 border 可以存在于 Markdown 表格等有专门布局算法的组件中；普通横线和选择列表应复用现有 TUI primitive/token。
- 所有新增/修改的渲染组件至少覆盖窄宽度、空状态、活动态和终态；涉及生命周期的组件还要覆盖取消、失败、恢复和决策返回。

## Review checklist

- 这行内容属于 transcript、活动状态、操作控件还是元数据？
- 是否重复显示了已经由 footer、status indicator 或 task bar 提供的信息？
- 终态快照是否会被 phase、旧 activity 或 timer 覆盖？
- 符号、颜色、间距和截断是否使用共享 token / theme？
- Enter、Space、Esc、方向键、disabled、空列表和 resize 是否有真实测试？
- 若没有真实终端截图或交互运行，报告中必须把视觉结论标为未验证。

## 参考

- [NIST Human-Centered Design](https://www.nist.gov/itl/iad/human-factors-human-centered-design)
- [ISO 9241-110 official page](https://www.iso.org/obp/ui?_escaped_fragment_=iso%3Astd%3Aiso%3A9241%3A-110%3Adis%3Aed-2%3Av1%3Aen)
- [Claude Code CLI usage](https://code.claude.com/docs/en/cli-usage) — 对交互/恢复/可访问模式的外部对照，不是 MyHarness 的实现依赖。
- [Monospace Design TUI](https://github.com/coreyt/monospace-design-tui) — 终端布局、焦点、状态和 footer pattern 的社区参考。
