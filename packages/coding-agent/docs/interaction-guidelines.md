# MyHarness Interaction Guidelines

这份文档约束 Coding Agent 浏览器产品的设置、导航、确认、反馈和键盘行为。当前视觉布局与状态投影见 [Web UI](web-ui.md)；旧终端组件不属于当前产品。

## 适用范围

MyHarness 当前的产品 UI 是 TypeScript/ESM 的终端 TUI：`InteractiveMode` 负责产品页面和流程，`packages/tui` 负责终端渲染、键盘输入、焦点、overlay 和可复用组件。因此本文件把 Windows 桌面应用的语义映射到终端等价物；它不声称终端组件具有浏览器 DOM 或原生 WinUI 的 ARIA role。

新增或修改交互时，先确认数据语义，再选择下表中的模式。相同语义必须使用相同模式；只有数据关系、提交时机或风险不同，才允许使用不同模式。

## Interaction Contract

| 语义 | MyHarness 实现 | 用户应能预测的行为 |
| --- | --- | --- |
| 即时 Boolean | `SettingItem.interaction: "toggle"`，显示 `On`/`Off`，使用 `values: ["Off", "On"]` | Enter/Space 立即切换，并立即调用设置回调 |
| 需要额外配置的功能开关 | 主行显示摘要和 `›`，打开 detail submenu；detail 页中的开关仍使用 `toggle` | 主行进入配置，不把复杂流程伪装成一次切换 |
| 单选 Enum / 预设数字 | `interaction: "select"` + `submenu`，子页使用 `SelectList` | 当前值显示为用户可读标签；Enter/Space 打开，方向键选择，Enter/Space 确认，Esc 返回 |
| 多选 | 每个选项使用 `toggle`；批量操作使用 `action` | 每个选项独立显示 On/Off；“Select all/Clear all”等是可执行命令 |
| 文本 / 数字 | `Input` 或领域输入组件；提交前校验 | 输入错误留在当前页面并说明原因；成功后提交并返回或刷新摘要 |
| Navigation | `submenu` 或明确的导航组件；共享列表显示当前摘要和 `›` | 点击/确认进入下一层，不执行隐藏动作 |
| 普通 Action | `interaction: "action"` + `onActivate`，显示 `▶` | Enter/Space 执行一次命令；不得用虚假的 `values: ["run"]` 伪装动作 |
| 只读 Status | `interaction: "status"`，不提供激活回调 | 显示状态、结果或说明；Enter/Space 不改变数据 |
| 危险操作 | 独立的 destructive 命令/确认页 | 明确写出目标和后果；确认与取消分开，Esc 取消，默认焦点放在安全选项 |

`values` 在新的产品 UI 中只用于明确的二态 `toggle`。共享组件仍保留旧的 inline-cycle 行为，以兼容已有 Extension/调用方；新代码不得用它实现 Enum、数字选择、返回、保存或任意命令。

### 当前值和标签

- 设置行显示用户可理解的值，例如 `On`、`Off`、`DuckDuckGo, Brave`、`3  (0–10)` 和 `One at a time`。数字设置在当前值旁显示合法范围，选择页只列出范围内的值。
- Provider、Model、Workspace、Session 等身份摘要可以显示真实名称，因为它们是用户需要识别的对象；不要显示 `enabled = true`、`scope = allowlist` 这类内部字段表达。
- 选项的存储值可以继续使用稳定的内部 enum；通过选项的 `label` 和回调映射隔离内部值，不要为 UI 改动 Provider、Credential、Model 或 Session 数据模型。

## Immediate Apply 与 Save/Apply

默认规则是简单设置采用 `change → immediately applied`：设置回调负责更新运行时和 Settings persistence。不要让相同语义的设置在不同页面一处循环、一处打开“保存”页而没有数据层原因。

允许使用 draft + `Apply` 的情况：

- 设置包含多个互相依赖的字段，需要原子提交；
- 预览与实际生效分离，例如主题预览；
- 外部检查、认证或安装完成后才能提交；
- 取消需要恢复原始值，而不是回滚一次简单的 Boolean。

此时页面必须明确显示 `Apply`/`Cancel`，说明当前是预览或草稿状态。`Apply` 是 action，不是一个可循环的设置值。

## Navigation、Action 和 Back

共享 `SettingsList` 会为 submenu 显示 `›`，为 action 显示 `▶`，并在底部提示当前行是 open、run、toggle 还是 read-only。进入子页后由子页拥有焦点；Esc 返回上一层并恢复父列表的选中项。Back 可以是明确的 action，但不能用空字符串或单值 `values` 充当返回按钮。

普通 Button/Command 只表示立即执行的操作。打开 Providers、Model、Credential、Git、Web Search、Code Intelligence 或详细配置的行必须保持导航语义，即使它的当前值是 `On`/`Off` 摘要。

## Dangerous Operations

删除 Workspace、Session、Provider、Credential、Model、Git Worktree 或清理用户数据前，应进入确认流程。确认页必须包含：

1. 明确的对象名称；
2. 简短的影响说明；
3. 安全的 Cancel/Back 选项；
4. 单独的 Delete/Reset/Remove action；
5. Enter 确认、Esc 取消，并在完成或失败后显示结果。

低风险的打开、刷新、健康检查和普通设置切换不增加无意义确认。现有 Session、Workspace、Git Worktree、Local Git 和 Provider 凭据流程中已经存在的目标确认、失败提示和焦点恢复语义应保留。

## Feedback 状态

- Loading：显示当前正在执行的任务；不能留下看起来可操作但尚未加载的空列表。
- Success：返回上一层或更新摘要，并给出可理解的完成结果。
- Failure：保留上下文，说明可执行的下一步；不要吞掉异常或把失败显示成空状态。
- Validation：输入错误就地显示，保留用户输入，直到修正或取消。
- Disabled / unavailable：使用 `SettingItem.disabled` 保留可见状态但拒绝 Enter/Space；同时显示不可用原因，不要把不可用项伪装成可执行命令。
- Empty：说明“没有数据”和“加载失败”的区别。搜索无匹配与真实空列表必须可区分。
- Authentication required：明确告诉用户需要登录/凭据，不要用普通“未设置”掩盖认证状态。

专题页面可以为 Provider、Web Search 引擎测试、Code Intelligence 安装和模型刷新实现自己的异步状态，但必须保持以上语义。

## Keyboard、Focus 和 Accessibility

终端 TUI 的等价键盘 contract：

- 列表使用 Up/Down 移动，Enter 和 Space 激活当前项；Tab 顺序仅在组件明确支持时使用；
- Esc 在子页、输入页和确认页表示取消/返回，不提交草稿；
- 当前焦点必须有可见标记；嵌套 Input/Editor 必须接收父组件的 `focused` 状态；
- overlay 打开后只把输入交给当前 overlay，关闭后恢复原焦点；
- 每个输入、选择和动作都应有可读 label、当前状态和底部键位提示；
- disabled 项不得响应 Enter/Space，也不得仅靠颜色表达不可用；
- 渲染行必须遵守传入宽度，长状态或错误应截断/换行而不破坏操作提示。

这些规则对应 WAI-ARIA APG 中 switch、checkbox、radio、combobox、dialog 和 keyboard interface 的核心行为；在终端中实现的是相同的键盘、焦点、提交和取消语义，而不是复制 DOM role。

## 允许偏离的场景

以下情况可以偏离简单设置行，但要在代码或页面说明原因：

- Provider/Account Credential/Model/Session/Workspace 之间存在真实数据关系；
- 操作需要异步网络请求、认证、安装、健康检查或 capability probe；
- 多字段配置需要 draft、预览、原子提交或回滚；
- 现有公开 Extension contract 要求兼容旧的 `SettingItem.values` 行为。

偏离只改变交互层，不应为了统一控件而修改身份绑定、持久化格式、Provider 路由、Session 数据或 Workspace 数据。

## 新 UI 的实现检查表

- 这是 toggle、select、navigation、action 还是 status？是否设置了对应 `interaction`？
- Boolean 是否只显示 `On`/`Off`，并且确实是即时生效的设置？
- Enum/数字是否通过选择子页确认，而不是 inline cycle？
- 当前值是否是用户可读标签，而不是内部 key？
- 导航和动作是否分别有 `›`/`▶` 语义？
- 删除、重置或清理是否有目标明确的确认和安全取消？
- Loading、success、failure、validation、empty、unavailable 是否有清晰反馈？
- Enter、Space、Esc、焦点恢复和宽度截断是否有测试或代码证据？
- 是否保持 Provider、Credential、Model、Session、Workspace 的现有数据关系？

## 规范参考

- [Microsoft ToggleSwitch](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/toggles)：适合即时二态设置；需要额外步骤的选项使用其他控件。
- [Microsoft app settings guidelines](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings)：设置分组、当前值、导航、即时反映和选择控件。
- [Microsoft buttons and commands](https://learn.microsoft.com/en-us/windows/uwp/design/controls-and-patterns/buttons)：Button 用于立即动作；导航应保持导航语义。
- [WAI-ARIA APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)：键盘、焦点和可见焦点行为。
- [WAI-ARIA APG switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/)、[checkbox](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/)、[radio](https://www.w3.org/WAI/ARIA/apg/patterns/radio/)、[dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)：二态、单选和确认流程的语义参考。
- [ISO 9241-110:2020](https://www.iso.org/standard/75258.html)：作为高层 review lens，关注适合任务、可预测、可控、容错和一致性；正式标准文本以当前 ISO 发布版本为准。
