# MyHarness Interaction Guidelines

这份文档约束 Coding Agent 浏览器产品的设置、导航、确认、反馈和键盘行为。当前视觉布局与状态投影见 [Web UI](web-ui.md)；旧终端组件不属于当前产品。

## 适用范围

MyHarness 当前的产品 UI 是本机浏览器 Web UI，交互见 [Web UI](web-ui.md)；旧终端组件不属于当前产品。

新增或修改交互时，先确认数据语义，再选择下表中的模式。相同语义必须使用相同模式；只有数据关系、提交时机或风险不同，才允许使用不同模式。

## Interaction Contract

| 语义 | MyHarness 实现 | 用户应能预测的行为 |
| --- | --- | --- |
| 即时 Boolean | 设置页 `type: "boolean"` 用 `Toggle` 开关；`/settings` 命令面板里是 `kind: "toggle"`（`src/startup/settings-menu.ts`），Space 切换 | Enter/Space 立即切换，并立即保存 |
| 需要额外配置的功能开关 | 设置页里是独立页面（如 Web search、Code Intelligence）；命令面板里是 `kind: "submenu"`，行尾显示 `›` | 主行进入配置，不把复杂流程伪装成一次切换 |
| 单选 Enum / 预设数字 | 设置页 `type: "enum"` 用 `Select` 下拉；命令面板里是 `kind: "select"` + `choices` 的选择列表 | 当前值显示为用户可读标签；Enter/Space 打开，方向键选择，Enter/Space 确认，Esc 返回 |
| 多选 | 设置页 `type: "multi"` 用 `SearchableMultiSelect` | 每个选项独立选中或取消；“Select all/Clear all”等是可执行命令 |
| 文本 / 数字 | 设置页 `type: "text"` / `"number"` 等输入框，失焦或 Enter 时提交 | 输入错误留在当前页面并说明原因；成功后提交并刷新摘要 |
| Navigation | 设置页左侧的页面列表；命令面板的 `submenu` 行（行尾 `›`，标题栏用 `›` 显示层级） | 点击/确认进入下一层，不执行隐藏动作 |
| 普通 Action | 按钮，或命令面板里不带 `›` 的命令行 | Enter/Space 执行一次命令；不得伪装成一个可切换的设置值 |
| 只读 Status | 只显示文字的行或说明，没有控件 | 显示状态、结果或说明；Enter/Space 不改变数据 |
| 危险操作 | 独立的 destructive 命令/确认页 | 明确写出目标和后果；确认与取消分开，Esc 取消，默认焦点放在安全选项 |

`toggle` 只用于明确的二态设置；Enum、数字选择、返回、保存或任意命令不得用点一下循环切换的方式实现。

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

命令面板（`web/js/command-panel.js`）为 submenu 行显示 `›`，标题栏用 `›` 显示当前层级；↑/↓ 移动，Enter 或 → 进入或应用，← / Esc 返回上一层，Space 切换。进入子页后由子页拥有焦点。Back 可以是明确的 action，但不能用空的设置值充当返回按钮。

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
- Disabled / unavailable：保留可见状态但拒绝 Enter/Space（命令面板行的 `disabled`，设置页行的 `off`）；同时显示不可用原因，不要把不可用项伪装成可执行命令。
- Empty：说明“没有数据”和“加载失败”的区别。搜索无匹配与真实空列表必须可区分。
- Authentication required：明确告诉用户需要登录/凭据，不要用普通“未设置”掩盖认证状态。

专题页面可以为 Provider、Web Search 引擎测试、Code Intelligence 安装和模型刷新实现自己的异步状态，但必须保持以上语义。

## Keyboard、Focus 和 Accessibility

Web UI 的等价键盘 contract：

- 列表使用 Up/Down 移动，Enter 和 Space 激活当前项；Tab 顺序仅在组件明确支持时使用；
- Esc 在子页、输入页和确认页表示取消/返回，不提交草稿；
- 当前焦点必须有可见标记；
- overlay 打开后只把输入交给当前 overlay，关闭后恢复原焦点；
- 每个输入、选择和动作都应有可读 label、当前状态和底部键位提示；
- disabled 项不得响应 Enter/Space，也不得仅靠颜色表达不可用；
- 长状态或错误应截断/换行，不挤掉操作控件。

这些规则对应 WAI-ARIA APG 中 switch、checkbox、radio、combobox、dialog 和 keyboard interface 的核心行为；在 Web UI 中实现的是相同的键盘、焦点、提交和取消语义。

## 允许偏离的场景

以下情况可以偏离简单设置行，但要在代码或页面说明原因：

- Provider/Account Credential/Model/Session/Workspace 之间存在真实数据关系；
- 操作需要异步网络请求、认证、安装、健康检查或 capability probe；
- 多字段配置需要 draft、预览、原子提交或回滚。

偏离只改变交互层，不应为了统一控件而修改身份绑定、持久化格式、Provider 路由、Session 数据或 Workspace 数据。

## 新 UI 的实现检查表

- 这是 toggle、select、navigation、action 还是 status？命令面板是否用了对应的 `kind`，设置页是否用了对应的 `type`？
- Boolean 是否只是开/关，并且确实是即时生效的设置？
- Enum/数字是否通过选择列表或下拉确认，而不是点一下循环切换？
- 当前值是否是用户可读标签，而不是内部 key？
- 导航行是否带 `›`，动作是否是按钮或命令，而不是伪装成设置值？
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
