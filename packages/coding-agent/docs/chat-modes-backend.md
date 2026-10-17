# Coding / General：后端与前端接入约定

## 范围与状态

两个入口共用现有 AgentSession、工具、Provider、设置、记忆及运行机制。此文描述后端接口；模式开关、主题、扩散动画、列表展示和浏览器接入的实现见 [web-ui.md](web-ui.md#coding--general-双模式)。

`mode` 为 `coding | general`。Session JSONL v3 header 增加可选 `mode`；旧文件缺省为 Coding，不批量重写旧数据。新建、同类型新聊天和分支保持模式。打开已有聊天以文件记录为准，没有修改已有聊天模式的 API。

Workspace 保存模式登记 `modes`，旧登记默认仅 Coding。同一物理文件夹在两边添加时复用稳定 Workspace ID，因而项目记忆和数据归属不分裂；两边侧栏登记独立，移除一侧只取消这一侧登记，不删除另一侧或任何文件。Workspace 显示名称仍属于共享稳定身份。

## 请求与事件

继续使用 `x-myharness-slot`（或 `slot` query）指定聊天运行实例。模式是聊天属性，不是请求的全局环境。`POST /api/prompt` 原来的 `mode` 仍表示 `auto | steer | followUp | interrupt`，不是产品模式，不得混用。

- `GET /api/state` 顶层增加 `mode`。
- `GET /api/slots` 与 SSE `slots` 的每条状态增加 `mode`，已有 `active / waiting / completion / lastOutcome / unread` 保留。前端按模式汇总；不增加另一套任务状态机。
- `POST /api/sessions/new` 接受可选 `mode`，省略时继承请求 slot。`rootPath / unbound` 保持原语义。空白聊天仅同模式可复用。
- `POST /api/sessions/open` 保持原接口，打开结果所属模式从快照读取；不能用界面模式覆盖文件模式。
- `GET /api/workspaces?mode=general`：只返回该模式登记。省略模式时使用请求 slot 模式。
- `GET /api/workspaces/sessions?path=...&mode=general`、`GET /api/sessions/unbound?mode=general`、`GET /api/sessions/archived?mode=general`：只返回该模式聊天。每个 summary 增加 `mode` 和 `blank`：Session 文件里除了创建时写入的模型和思考级别设置之外没有别的记录（没有消息、名称、标签、操作卡片等）时为 `true`。前端用它不再列出被留下的空白聊天（文件不删除，见 web-ui.md）。
- `POST /api/workspaces/add|remove|rename` 接受可选 `mode`，用于匹配登记；默认请求 slot 模式。`remove` 仅取消该模式登记。重命名仍修改共享 Workspace 名称。明确删除产出仍是共享数据操作，需保留现有确认和运行中保护。
- General 快捷新建（Coding 不可用）：`GET /api/workspaces/create-target?mode=general` 返回注册表已解析 Data root 下的 `workspace-folders/`，不跟随已有工作区父目录或桌面；`POST /api/workspaces/create` body `{ name, mode: "general" }` 创建子目录并登记。已有未登记目录直接登记，不移动、覆盖文件；已登记名称占用返回 409，同名普通文件返回可换名的错误。既有工作区路径不变。
- General 两种工作区入口共用菜单中的“工作区设置”：`GET /api/workspaces/settings?id=...` 返回设置及来源清单；`POST /api/workspaces/settings` 保存 `{ id, name, instructions, memoryEnabled, libraryEnabled }`。注册表 v3、metadata v2 双写并参与 reconcile；旧字段默认说明为空、两个开关开启。来源清单每项为 `{ id, name, path, size, modified }`，`modified` 是存储文件的修改时间（毫秒），供项目资料页显示日期与排序。Coding 不注入这些说明或来源。说明与来源清单按后续请求重新读取，不写入旧聊天。有说明时，`<workspace_context>` 内先放 `system-prompts/common/session/workspace-instructions.md` 的优先级声明：工作区说明与 `<user_personalization>` 同时生效，冲突时以工作区说明为准。该块仍留在系统提示词内（不随每轮变化，内容不变时逐字一致；修改说明或资料只让下一次请求的系统提示词变化一次）。
- 资料写入 `workspaces/<id>/uploads/<source-id>/`，与 `sessions/<session-id>/uploads/` 独立，数量不设上限。单文件资料沿用 version 1：`source-<名称>` 加 `source.json`（`{ version: 1, name, size, storedName }`）；文件夹资料为 version 2：`source.json` 是 `{ version: 2, kind: "folder", name, storedName: "folder-<名称>" }`，原目录树放在 `folder-<名称>/` 下。旧资料不迁移、不改写。网页用分片接口上传：`POST /api/workspaces/sources/stage` 接受 `{ id, items: [{ kind, name, files: [{ path, size }] }] }`，整批检查（单文件 500 MiB、路径合法、Windows 路径长度），有问题时返回 `{ problems: [{ item, path, reason }] }` 且不写任何东西；通过后返回各项的 `sourceId`，文件夹资料立即带 `source.json` 出现在列表里。`/chunk` 接受 `{ id, sourceId, index, offset, data }`（base64，单片不超过 8 MiB，必须按顺序，`offset` 为 0 时该文件从头重传），完整的文件从 `staging/` 移到位；`/finish` 在全部文件到齐后写单文件的 `source.json` 并返回资料。暂存的上传只保存在服务进程内存里。目录名逐级沿用原有非法字符清洗，并处理 Windows 设备名；超过 250 字符的路径逐步截短各级名称（重名加 `~2`），截到最短仍超长才整批拒收。`GET /api/workspaces/sources/tree?id=&sourceId=` 返回文件夹资料的目录树；`POST /api/workspaces/sources/delete` 可带 `path` 只删文件夹资料里的一个文件或子文件夹；删除前整棵树逐项检查，含符号链接/junction 或非普通条目时整体拒绝、原样保留。旧的一次性 `POST /api/workspaces/sources/upload`（`{ id, name, data }`，32 MiB）保留。清单注入时文件夹资料只占一行 `{"name","path","type":"folder","files":N}`，不逐个列出文件，模型需要时用 `ls`/`read` 进入。模型收到清单后按需 `read`，不做 embedding；关闭资料开关仅取消清单注入，不是文件系统权限沙箱。记忆开关控制本工作区层自动召回与维护写入，不关闭全局和当前对话层，也不限制显式工具读取。
- `POST /api/workspaces/sources/delete` 接受 `{ id, sourceId }`，只删除该资料自己的 `uploads/<source-id>/` 目录（其中只能是普通文件）；沿用来源根目录的 symlink/junction 检查，目录本身是链接或含非普通文件时拒绝（409）并保持原样。`sourceId` 不是 36 位 uuid 返回 400，已不存在返回 404，删除失败返回 409；成功后广播 `workspaces_changed`。不触碰其他资料、会话文件与对话附件。
- 两种模式共用的 `/api/prompt` 增加可选 `clientMessageId`，仅通过内存 WeakMap 关联到 `message_start` SSE，不改变 Session JSONL 或消息对象结构。浏览器立即插入占位，按该 ID 替换；HTTP 拒绝移除占位并沿用 Composer 草稿恢复。排队发送的 300ms 等待在占位之后；本地 `/`、`!`、`!!` 分支不创建聊天占位。
- `POST /api/sessions/clear` 仅清理指定 `mode` 的聊天（默认请求 slot 模式），不能误删另一侧。

## 模式导航与状态保存

状态保存在 `<agentDir>/chat-mode-state.json`，原子写入并加锁，不放进模型上下文或 credentials。每个模式独立保存 `lastSessionFile / model / drafts`；草稿以稳定 Session ID 为键，不以短期 slot 为键。模型选择包括 `provider / id`，Provider 和可用模型配置共用。

- `GET /api/modes/state` → `{ coding: ModeState, general: ModeState }`。
- `POST /api/modes/state` → `{ state: ModeState }`。body：`{ mode, sessionFile?, draft? }`，必须发送到匹配聊天 slot。`sessionFile` 必须等于该 slot 的文件；这会保存空白 Session，以便重新打开；它在上面的列表里带 `blank: true`。`draft` 为 `{ text, attachments: object[] }`，`null` 或空草稿清除记录。文本最多 1,000,000 字符、附件最多 12 个；附件是现有前端附件描述，不进行第二次上传、不作为已发送消息。草稿内容同时决定这个聊天是否算“输入过”：文本去掉空白后非空或带附件为是，否则（包括 `null`）为否；标记变化时广播 `session_info`，`slots` 里的 `hasContent` 随之更新。
- `POST /api/sessions/touched`，body `{ touched?: boolean }`（省略为 `true`）：页面在输入框里有内容（有文字或附件）时发 `true`，删空后发 `false`，不必等草稿的延迟保存。标记为“输入过”的空聊天不会被 `POST /api/sessions/new` 复用，也不会被当作被留下的空白聊天；标记为否的就和没输入过的新聊天一样。上传附件、保存非空草稿也会置为“输入过”。
- `POST /api/modes/open` body `{ mode }` → `{ slot, created, mode, state }`。优先恢复上次聊天，仍在运行时复用原 slot；无有效记录时创建该模式的 unbound 空白聊天。文件存在但打开失败会明确报错，不掩盖损坏或丢失目录。
- 模型实际切换后后端保存该聊天模式的模型选择；新聊天使用本模式保存的选择。已有聊天优先恢复自己的模型记录。模型已删除、禁用或无认证时沿用现有回退，不伪造可用状态。

前端必须在草稿编辑时适度 debounce 保存，切换前 flush；成功发送后清除该聊天的草稿，防止重开后恢复已发送内容。普通模式切换用 `/api/modes/open`。点击任务提醒直接打开任务对应 slot/Session，再将其保存为该模式最近聊天。普通聊天选择也要调用状态保存。页面初始化读取模式状态并恢复对应聊天；当前界面模式由前端保存，不传给运行中的聊天。

前端附件描述需要映射到 `draft.attachments` 并在恢复时映射回现有 Composer 使用的数据。不要只依赖 `beforeunload` 保存；关闭时最后一个请求可能无法完成。空白聊天保存在磁盘不意味着草稿进入模型消息。

## 个性化提示词

存储字段为 `chat-mode-state.json` 的 `codingPersonalPrompt` 和 `generalPersonalPrompt`，两套彼此独立；旧文件缺少 `codingPersonalPrompt` 时按空字符串处理，不视为损坏。

- `GET /api/modes/personal-prompt` → `{ coding, general }`。
- `POST /api/modes/personal-prompt` body `{ coding?: string, general?: string }`（至少一项）→ 返回保存后的 `{ coding, general }`。不设长度上限，空字符串清除，含 NUL 拒绝。
- 保存后 SSE `mode_preferences_changed` 提示前端刷新编辑内容。
- 个性化提示词以最高优先级放在各自模式 System Prompt 最前，优先于内置身份、核心规则与其它通用指令；只注入当前模式的提示词，Coding/General 互不串扰。已有正在执行的一次模型请求不会中途替换；后续请求使用已保存内容。
- Project Trust、SYSTEM/APPEND、AGENTS/CLAUDE、skills 和扩展的既有语义保留；General 也读取项目上下文。

## Prompt 资源

静态共享资源位于根 `system-prompts/common/`；Coding / General 身份位于 `coding/identity.md`、`general/identity.md`。原 loader 逻辑资源名保持可用：先使用替代目录中的旧路径，否则在同一目录的 `common/` 查找，不跨替代目录回退。作用域路径显式读取，不自动扫描目录。

核心规则移除编程身份，编程身份由 Coding 文件提供；标题请求改为按真实主题生成，摘要、记忆、视觉、安全审查保持独立用途，不套用主聊天模式身份。子进程 Explore 通过内部环境字段继承聊天模式，不改变工具授权。

## 前端需求（已在 Web UI 实现，见 web-ui.md）

左上角装饰图标改椭圆开关，左 Coding 强调色、右 General 绿色，两色常显、滑块表明模式。Coding 保留现色，General 深墨绿背景与柔绿强调色。从开关向外扩展显示新配色和内容，包括侧栏；不做真实水波。两边各自 Workspace/聊天列表和状态，功能仍共用。

对应一侧运行中呼吸点；完成、失败、待处理使用可区分静态提示。多个结果显示简短汇总，点击展开任务列表，再点击直达对应聊天。查看后继续通过匹配 slot 的 `/api/seen` 清除未读；隐藏模式不能被误标为已读。前端配色和动画不改变后端任务生命周期。

## 验证边界

使用 faux Provider 验证实际 HTTP/运行实例隔离，使用持久化测试验证旧聊天默认、新建/分支继承、模式登记、草稿附件及偏好重新读取。前端纯逻辑（附件映射、任务汇总）由 `test/web-frontend-logic.test.ts` 覆盖；开关、配色、扩散动画、草稿恢复和跨模式任务提醒需在浏览器中验证。真实外部 Provider 不在这些测试范围内；后端测试不能代替这些结果。
