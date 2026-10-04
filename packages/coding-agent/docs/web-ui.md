# Web UI

MyHarness 默认且唯一的用户交互入口是本机浏览器 Web UI。它使用现有 `AgentSessionRuntime` / `AgentSession`、Session、Settings、Provider、Tool、Git checkpoint 和 Extension，没有第二套 Agent 逻辑。终端 CLI/TUI 已移出本仓库；Web Terminal 面板仍保留。

## 会话治理、快捷键与指标

- 归档和删除同时识别已保存的 Chat 与仍在服务内存中的 Chat（例如输入过草稿或导入附件、尚未发送的对话）。归档未保存的 Chat 时先保存现有会话记录，不生成虚构消息、不把未发送草稿加入模型上下文；归档后可从磁盘恢复会话，未发送草稿仍只按现有浏览器规则保留。删除未保存的 Chat 时释放其 slot，沿用附件清理与产出保留选项；删除当前 Chat 保持请求所在 slot 并替换为新 Chat。任意未知路径仍拒绝操作。
- 会话三点菜单支持归档/取消归档。归档是独立的侧栏逻辑文件夹：在 JSONL 旁保存 `.archived` 标记，保留原磁盘路径、Workspace 归属和分支引用，不搬动原数据目录。归档只在列表里就地移动：被操作的那一行收起并淡出，出现在“归档”文件夹里（取消归档则回到原分组），页面不刷新、不重新载入对话；正在显示的 Chat 归档后继续留在屏幕上（不再替换成新 Chat），正在运行的 Chat 拒绝归档。服务端拒绝时列表恢复原状。
- 会话三点菜单支持置顶/取消置顶（`POST /api/sessions/pin`，在 JSONL 旁保存 `.pinned` 标记，删除 Chat 时一并移除）。置顶的 Chat 行首有图钉，排在所属分组最前；归档文件夹里不按置顶排序。
- 每个分组内的排序：刚新建、还没发消息的空 Chat 在最前，然后是置顶的、正在运行的，其余按最近活动时间从新到旧（`web/js/chat-order.js`）。最近活动时间取保存的最后一条消息时间和服务端 slot 状态 `lastActivityAt`（任务开始/结束、`!` 命令、Git 操作时更新）中较新的一个；只是点开查看不算活动。发送消息、生成中、工具调用、提交的 Chat 立即排到分组第一行；行换位置时只有该行和被它越过的行用 transform 平滑滑动，列表初次出现时不逐行播放展开动画。后台 Chat 的任务结束后也会重新读取它所在分组的列表。
- 点击侧栏里的 Chat 后该行立即标为当前，切换不等待任何动画；连续快速点击时以最后一次点击为准，打开失败会提示原因。所有“下一帧再显示”的动效都带计时器兜底，页面被遮挡或不在前台时也不会让行一直不可见、不可点。Web 删除确认调用永久删除，默认保留对话产出及最小来源信息，删除聊天、附件和工具记录；确认框提供默认不勾选的“同时永久删除产出文件”。勾选后删除原文件并同步移除工作区/全局汇总引用，失败显示原因，不假装成功。
- 设置 → Keyboard shortcuts 录入浏览器专属快捷键，保存在浏览器偏好中；默认为 Ctrl+Alt+K/N/B/L/,/F（命令面板、新 Chat、侧栏、输入焦点、设置、筛选）。重复绑定与非 Ctrl+Alt+字符组合拒绝保存并标红；关于、侧栏和命令面板读取同一注册表。系统/浏览器扩展自定义的全局绑定不在页面可检测范围内。
- 代码智能页每秒查询运行时状态，区分选择的配置、实际 Semantic 后端以及轻量回退。选择与运行时启用状态不同才显示待重启；一键重启拒绝进行中的任务，保存并释放运行时、关闭端口后启动相同入口和端口的新进程。页面等待 ready 后重新加载。重启使用 Node 入口，不保证其他打包执行器支持。
- Session Token 分为普通输入、缓存写入、缓存读取、输出，命中率为缓存读取 ÷（普通输入 + 缓存读取 + 缓存写入），固定两位小数。输入框用量浮层显示会话累计速度（具有配对计时的累计输出 ÷ 累计生成时间）与累计缓存命中；右侧“上下文窗口”仅显示容量进度条、已用/总容量和剩余空间；Session 的 Token 汇总行下方独立显示累计速度与累计命中率，沿用同一双列网格与“输入”左对齐，不再重复展示请求/累计缓存和耗时长列表。自动压缩开关与立即压缩按钮位于上下文进度条下方，与左侧剩余用量同一行；控件组右端与进度条右端对齐。Session 操作区仅保留导出 HTML。`usage` SSE 同批携带统计、cache、speed，正文与用量保留 50ms 合并窗口；这不是零延迟保证，Provider 仅在结束报告的输入和缓存无法提前精确显示。近似值统一用 `≈`，未知显示 `—`，明确报告的零显示 `0`。累计统计缺少部分样本时，只统计有依据的配对样本并标为近似。
- 本地参考研读的是已安装 DeepSeek Harness 的 `app.asar` 中 `dsh-token-meter/lib/types/turn-usage.js`、`usage-projection.js`、`dsh-client-ui-chat/lib/client.js` 与 `dsh-client-ui-trajectory/lib/client.js`：采用不重叠输入分桶、替换当前请求样本避免重复累计，以及首个 Token 到结束的输出测速口径；没有复制其源码。

启动默认加载 Web，`--print`、`--mode`、`--list-models` 已不支持。HTML 导出使用独立暗色 CSS palette 与结构化 Session 数据，不加载终端 Theme 或 ANSI 渲染器；旧 `themeName` 选项仅兼容接收。代码索引扫描与 LSP 连接仍沿用已有按查询触发的实现。

Session 面板保持输入、缓存写入、缓存命中、输出的 Token 汇总行；累计速度与累计命中率放在紧接其下的独立行，左侧为空标签列。上游用量的可选逐项 `reported` 标记区分实测零与未上报；累计指标有任何样本缺项时显示 `—`，费用以 `≈` 标记不完整或生成中估算。旧记录没有逐项标记时，仅正值能证明对应维度有数据。模型输出的正文（包括后续工具调用前的文字）在步骤摘要之外、按发生顺序显示在各折叠块之间，不受步骤默认折叠设置影响。Changes 的任务切换使用共享浮层菜单，不再使用系统原生 select 弹窗。

## 对话产出管理

Files 面板提供“项目文件”和“产出文件”两个入口。产出入口可切换当前对话、当前工作区、所有工作区，显示文件、大小及工作区/对话 ID，并可下载原文件；来源对话删除后仍保留的文件会标记来源已删除。

临时报告、调研方案、一次性测试脚本及结果、中间文件默认写入对应 Session 的 `artifacts/reports|tests|temporary/`。全局 `data/artifacts/` 和 Workspace 的 `artifacts/` 仅保存可重建的 JSON/Markdown 引用索引，不复制文件。正式源码、维护中的测试和项目文档不改路径，用户指定路径优先。运行时 Prompt 提供实际目录，bash/pwsh 提供 `MYHARNESS_ARTIFACTS_DIR`、`MYHARNESS_TEMP_DIR`；这不是强制文件系统隔离，不自动重写任意 shell 输出路径。

删除对话默认保留产出及来源，勾选同时删除才删除原文件及上层引用。“移除工作区”仍只取消登记，不删除项目或聊天；同样可选择删除该工作区所有产出，不勾选则继续从全局入口找到。产出删除有运行任务保护和 symlink/junction 检查。完整存储边界见 [STORAGE](../../../docs/STORAGE.md)。

## 文件导入与浮层响应

输入框和主视口接受外部文件拖放；`+` → “从 Explorer 上传文件”使用浏览器原生文件选择窗口，不限制扩展名。图片继续作为图片附件发送；其他文件通过 `POST /api/files/upload` 保存原始字节到当前 Session JSONL 同级的 `uploads/<随机 ID>/attachment-<文件名>`，附件卡显示原文件名，发送时把完整路径作为上下文引用交给 Agent 的 `read`（沿用已有文本/富文件读取能力，不保证任意二进制都能解码）。每条消息最多 12 个附件，单文件上限 32 MiB；逐个读取和上传，避免同时持有整批 base64。切换 Chat 不会把已开始导入的文件附加到另一个 Chat。移除附件只移除草稿引用，不删除已导入的原始文件。

分支浮层的分支区和 Worktree 列表区按内容自然收缩，达到最大高度后滚动，不为少量条目预留空白。分支标签出现时提前异步加载分支，同一 Chat 重开菜单先显示已有数据再后台刷新，并复用进行中的请求；切换 Chat 不复用其他 Chat 的数据。首次加载尚无数据时不高亮“新建分支”，也不响应 Enter 创建分支。Worktree 默认收起，展开时才查询副本列表，点击整行标题展开创建入口和独立的“已有副本”分组；副本名称与路径分两行显示。折叠只隐藏界面，不改变工作目录或隔离状态。浮层随内容高度变化保持锚定；定位使用不含动画变换的布局尺寸，复用全站淡入/淡出与折叠动效。`GET /api/git/worktrees` 的仓库检测和 Git 列表读取均异步，不阻塞服务事件循环；写操作规则不变。侧栏按最新列表顺序放置新增会话，同时短暂保留退出行播放高度折叠；指定 Workspace 新建时自动展开所属分组。新增和退出只使用 grid 高度折叠与淡入淡出，不叠加列表重排位移；纯排序变化按固定行高计算 transform，不读取逐行布局。侧栏关闭浏览器自动滚动锚定，不主动纠正 scrollTop，已有行保留原 DOM 节点。斜杠/文件候选以 180ms 的轻微向上位移与淡入出现在输入卡上方，放大编辑器时也不覆盖编辑区；键盘选中项只滚动候选列表自身。

## Worktree 副本启动与显示名称

分支浮层的已有副本行悬停或键盘聚焦时提供“进入修改”“启动副本”和重命名。进入修改仍只切换 Chat 的工作目录；启动副本在当前浏览器打开具名的新标签页，运行所选 checkout 的 `web-runtime.ps1`，不经过会替换旧实例的 `dev-web.ps1`。重复点击复用已确认身份的服务，并尽量聚焦原标签页；页面刷新或浏览器限制可能导致重新打开标签页，但仍连接同一个服务。弹窗被拦截时明确报错，标签页/窗口形式由浏览器设置决定。

管理启动仅支持 Windows MyHarness 源码副本；副本必须包含新版本的服务身份协议。旧副本或其他项目会拒绝启动，需要先更新副本代码。首次缺依赖时沿用副本自身启动器的安装流程，不共享或链接主版本的 `node_modules`。服务端口由系统分配；每个副本在 Agent 目录的 `worktrees/services/<path-id>/` 保存独立 Agent 配置、Session、data 和启动日志。模型与凭据等配置首次启动时复制为私有快照（包含敏感凭据，不能提交或公开）；之后副本修改不回写主配置。这是运行数据分离，不是文件权限沙箱，工具仍可访问其权限允许的其他目录。

主标签标题前置 `Main` / `主版本`，管理启动的副本前置 `Copy` / `副本`，后跟截短显示名；副本页面顶栏的标记悬停显示完整名称和启动目录。身份来自服务实际启动目录，不随 Chat 切换改变。副本显示名保存到 `worktrees/names/<path-id>.json`，不修改 Git 分支或文件夹；未命名时用分支名，游离副本用目录名。创建时可填名称或选择主 Agent 命名；自动命名使用当前选中的主模型和当前任务文本，无工具调用，结果先预览，用户保存后才生效。选择自动命名的创建流程先创建副本并停在名称确认，不自动进入；用户保存后可选择进入或启动。已有副本同样可手动改名或请求 AI 建议，手动名称不会被自动覆盖。

设置 → Network 新增 **Copy tab exit delay**（`worktreeShutdownGraceSeconds`，0–3600 秒）。首次沿用现有主退出值，之后独立保存；主退出值首次修改时保留副本原值。最后一个副本 SSE 页面断开后按该设置退出，至少等待 5 秒保护刷新；还有页面连接时不会退出。副本倒计时读取主配置中的这一设置，主版本不受影响。

上下文用量浮层与 Session 容量区直接读取当前 Chat 的实时快照（budget 优先，usage 兼容回退）和 Session 统计。打开时立即显示已有数字，不再请求 `/api/context` 或显示整块空白转圈；缺失数据用 `—`，真实零保留为零。容量随现有 SSE 更新，切换 Chat 不复用上一 Chat 的值。详细上下文拆分接口仍保留给需要拆分信息的调用方。

## 本地运行状态与语言模块

提交/推送中的 Chat 纳入有效内容和运行中保护，切换或新建 Chat 不会复用、回收或删除它；快照携带 `gitTask`，切回或重新加载页面恢复当前进度。输入过草稿或添加过附件的 Chat 也不再视为完全未使用的空白 Chat。

代码智能语言模块通过 `GET /api/code-intelligence/modules` 读取安装管理器清单，`POST /api/code-intelligence/install` 安装，SSE `code_intelligence_installation` 同步传输百分比、当前归档预计剩余时间与安装状态。共享依赖和语言归档分别显示传输进度，下载完成后仍需校验和解压。未发布、缺少校验信息或需要外部依赖的模块显示不可用原因，不伪造可下载状态；缺少发布信息的模块下载按钮仍可点击，点击后如实提示“下载包尚未发布”，需要自行安装外部依赖或与当前版本不兼容的模块按钮禁用。语言模块在设置里是折叠列表（折叠行只有语言名称和状态，点开后在下方显示功能说明、环境依赖和操作区；说明文字随界面语言显示中文或英文）；下载并校验安装完成后，操作区的下载按钮换成启用/停用开关，由 `POST /api/code-intelligence/language`（`{ id, enabled }`）写入 `codeIntelligence.disabledLanguages`，和引擎设置一样在重新启动运行时后生效。下载包先以原始 `.zip` 文件名放进暂存目录；解压优先用系统自带的 `System32\tar.exe`（能处理超过 260 个字符的路径，大型运行时放进用户目录后会超过这个长度），没有它或失败时才回退到只接受 `.zip` 扩展名的 `Expand-Archive`。引擎设置和新安装模块在重新启动运行时后生效（当前工作区运行时在创建时组装语言服务器）。

桌面通知区分等待输入/确认、成功完成和异常中断；浏览器和系统回退通知共用任务归属、正文结论或错误原因及产出概要，正文按预算主动精简，不仅显示项目名和 Markdown 标题。

## 从 Session 面板重启服务

Session 面板底部的“重启服务”替代原“重新加载资源”按钮，调用现有 `/api/restart`。点击先确认；重启状态在按钮原位显示转圈与阶段文字，不显示顶部重启横幅、不遮挡标题或正文，期间禁止发送但保留草稿。成功用短暂提示反馈；失败在按钮下方保留错误与重试入口。普通断线提示占据独立布局行，不覆盖顶栏。所有已打开 Chat 都必须空闲（包括收尾和 Git 操作）；服务重启恢复发起请求的 Chat，空白但可持久化的 Chat 也会先写入保留标记。浏览器不整页刷新，因此当前草稿和页面布局保留；旧 slot 缓存清除后重新获取状态。页面等待 `/api/boot` 的实例 ID 改变、状态 ready 且原 Session ID 匹配，再提示成功；90 秒内未恢复则显示错误。真实 Shell Terminal 进程仍随旧服务关闭，不是进程热迁移。资源热加载 API 保留，但该按钮不再调用它。

Windows 重启经隐藏 PowerShell `Start-Process` 启动原 Node 入口、相同端口和 Session，移除已不支持的 `--web` 参数；保留 offline、Trust 和资源禁用标志，不重发命令行初始消息。启动日志写入当前 Agent 目录的 `web-restart.out.log` / `web-restart.err.log`。

## 启动

```powershell
# 源码 checkout（Windows）
.\dev-web.cmd
# 查看服务日志：.\dev-web.cmd --console
# 或已构建的 Web 启动入口
myharness
```

| 参数 | 说明 |
| --- | --- |
| `--port <n>` | 端口，默认 `7878`；被占用时依次尝试后面的 10 个端口；`0` 表示由系统分配。 |
| `--no-open` | 不自动打开默认浏览器（终端会打印 `MyHarness Web UI: http://127.0.0.1:<port>/`）。 |

**无窗口启动（Windows 源码 checkout）**：`dev-web.cmd` 不再占用控制台。它把工作交给 `dev-web.vbs`（wscript，本身没有控制台）后立即退出；`dev-web.ps1` 每次启动都不复用已在运行的实例（默认端口 7878 或 `--port`）：先请求旧实例正常退出（`POST /api/shutdown`），15 秒内没退出则只结束确认是 MyHarness 的监听进程；端口被其他程序占用或旧实例无法结束时弹出错误并取消启动。这样打开的总是当前源码的后端（旧实例里未完成的对话会随之结束）。随后以隐藏方式运行 `web-runtime.ps1`，输出（UTF-8）写入 `data/logs/web-launch.out.log` / `web-launch.err.log`，服务就绪（打印出地址）后退出。启动超过约 1 秒仍未就绪时会显示一个小启动窗口（深色、无边框、圆角，带 MyHarness 标志和一条细进度线，颜色与 Web UI 一致，不再是系统默认白色窗口），当前阶段文字对应 `web-runtime.ps1` 打印的真实阶段（读取项目要求、Node.js、npm、依赖、bash、ffmpeg、加载并启动服务）和最后的服务监听，就绪后自动关闭；快速启动时不出现任何窗口。启动小窗右上角有标准的最小化和关闭按钮（按住窗口其余部分可拖动，最小化后从任务栏还原）：最小化只是收到后台，启动继续；关闭（或 Alt+F4）明确取消启动，并结束启动进程及其子进程（`taskkill /T`），不弹错误对话框。“就绪”不只看日志：服务端口一监听，`dev-web.ps1` 每约 0.1 秒用不走代理的短超时请求 `GET /api/boot`，应答就立即认为就绪，所以日志文件暂时读不到也不会一直等；服务端在存储迁移、会话查找、运行时创建之前就开始监听（`main.ts` 里 `startWebBootstrap` 最先执行），页面在这段时间显示 “Starting MyHarness…”。启动失败、进程提前退出或 180 秒仍未就绪时，会停止启动进程并弹出错误对话框（带日志尾部与日志路径；日志必须按 UTF-8 读取，否则中文会乱码）。

**启动耗时**：`web-runtime.ps1` 默认用 `node --import scripts/dev-fast-loader.mjs` 直接运行源码（Node 原生类型剥离）。此前用 `tsx` 时，约 1600 个模块逐个经过转换 hook，从进程启动到服务监听要 11–12 秒；现在约 2.3 秒，双击到页面可用约 5 秒。需要回到 `tsx` 时设置 `MYHARNESS_DEV_LOADER=tsx`。服务用页面里的 **Quit MyHarness** 结束，整棵进程树一起退出。需要看控制台输出时用 `dev-web.cmd --console`（原来的可见窗口方式）。`myharness` 同样启动 Web；旧 `dev.cmd` 与多界面切换参数已移除。

其余参数照常生效：`--session`、`--continue`、`--model`、`--thinking`、`--no-extensions`、`--approve/--no-approve` 等；命令行里的初始 message / `@file` 会在启动后作为第一条消息发送。终端里按 `Ctrl+C`（或界面里的 **Quit MyHarness**）会停止服务并结束当前任务。

**服务的生命周期**：只要还有至少一个浏览器页面连着（以真实的 SSE 连接为准，所以浏览器崩溃、被强制关闭也会被发现），服务就一直运行。最后一个页面断开后，服务等待一段宽限时间再退出；在这段时间内刷新（F5）或重新打开页面会取消退出。宽限时间是设置项 **Web UI exit delay**（`webShutdownGraceSeconds`，设置 → Network，默认 10 秒，范围 0–3600 秒（包含 0–3006 秒），实际等待至少 5 秒以保护刷新与 SSE 重连（包括配置为 0 时）；配置超过 5 秒时按配置等待），每次开始倒计时时重新读取，修改后对下一次生效。从未有页面连接过的服务（例如 `--no-open` 刚启动）不会倒计时。只管理这一个 Web UI 服务自己，不会结束任何 CLI 进程，也不会按名字批量结束进程。倒计时结束时服务的退出方式与 **Quit MyHarness** 相同，正在运行的任务会被停止。

服务只监听 `127.0.0.1`，面向 Windows 桌面浏览器，单用户使用。不提供手机/平板适配、局域网访问或多人协作。

## 界面结构

```text
┌ 侧栏 ──────┬ 会话 ──────────────────────────────┬ 详情面板（可开关，可拖宽）┐
│ Workspaces │ 标题 · 状态 · 面板按钮               │ Changes │ Files │ Terminal │ Session │
│  └ No Folder│ 对话（安静阅读） + 运行摘要          │                          │
│            │ Composer（模型/推理力度/发送/停止）  │                          │
└────────────┴─────────────────────────────────────┴──────────────────────────┘
```

* **侧栏**：真实的 Workspace / Chat 结构（`WorkspaceStore` + `SessionManager.list`）。新建 Chat、切换 Chat、重命名（手动或 AI 生成标题）、删除、添加/移除 Workspace。**“从列表移除”只取消 Workspace 的登记**（任何时候都可以，包括当前和最后一个 Workspace）：磁盘上的项目目录、项目文件和 Session 数据都不动，原来属于它的 Chat 继续存在，只是变成不属于任何 Workspace 的 Chat，出现在侧栏的 **No Folder** 分组，仍可打开、继续对话；之后再添加同一个文件夹，会接回它原来的 Chat。**No Folder**（旧版本叫 General / 通用，只改了显示名称）只是侧栏里的一个逻辑分组，和普通 Workspace 一样可展开/收起（默认展开），但它不是 Workspace：没有文件夹、不在 Workspace 登记里，其中 Chat 的磁盘位置和归属都不变。它列出所有不属于 Workspace 的 Chat（新建时没有选 Workspace 的，以及被移除的 Workspace 留下的），分组行右侧的 `+` 新建这样的 Chat；列表只在真正请求中才显示“Loading…”，请求失败（例如正在运行的服务比页面旧、没有 `GET /api/sessions/unbound`）会显示原因和“Retry”，Workspace 的 Chat 列表同理；侧栏顶部的 New chat、`Ctrl+Alt+N` 和命令面板里的 New chat 总是新建一个不属于任何 Workspace 的 Chat（`actions.newChat`）：它立刻作为当前 Chat 列在 No Folder 里（还没有消息时显示为 “New chat”，此时没有重命名/删除菜单），No Folder 处于收起状态时会自动展开；要在某个 Workspace 里新建，用该 Workspace 行右侧的 `+`。斜杠命令 `/new` 不变，仍沿用当前 Chat 的归属。没有任何 Workspace 时输入框、Provider、Model、Agent 和 New Chat 都照常可用。Workspace 可展开/收起（带高度动画，不影响其中正在运行的 Chat）。Workspace 行的更多菜单支持“重命名”：名称就地编辑，Enter 保存、Esc 取消；只保存显示别名，Workspace ID、磁盘路径和 Chat 归属不变，并广播刷新所有页面。新建的空 Chat 出现和离开后的清理使用同一套高度与淡入淡出动效。状态标记固定在 Chat 行右侧，不会挤动标题：运行中是小的空心旋转圆环，等待你回答是琥珀色圆点，**已完成但你还没看过的结果**是蓝色实心圆点，看过之后消失（已读且空闲的 Chat 没有任何标记）。Workspace 名称右侧的蓝点表示其中有未读结果。“看过”＝该 Chat 正显示在页面上且页面可见；未读标记由服务端按 Chat 保存（`SlotStatus.unread`，页面通过 `POST /api/seen` 上报），多个 Chat 并发时互不影响，未读的后台 Chat 不会被回收。还没写入磁盘的进行中 Chat 也会列出，随时可切回。
* **添加 Workspace**：侧栏的 `+` 和 `/workspace` 里的 “Add workspace” 直接打开 Windows 自带的文件夹选择窗口（与资源管理器相同，只能选文件夹），选中后把该文件夹登记为 Workspace，取消则什么都不做。窗口由本机服务打开（`POST /api/fs/pick-folder`，`folder-dialog.ts` 通过 Windows PowerShell 调用系统的 `IFileOpenDialog`，在独立进程里运行，不阻塞服务），显示在浏览器窗口前面；同一时间只开一个。登记仍走原来的 `POST /api/workspaces/add`。没有系统窗口的平台（接口返回 501）才退回页面内置的文件夹选择器：类似资源管理器——后退/前进/上一级、可编辑并可点击的路径（面包屑）、快速访问（主目录/桌面/文档/下载）、盘符、已有 Workspace、筛选、新建文件夹、显示隐藏文件夹；只列目录，选中后显示完整路径再确认。
* **对话**：用户消息、运行摘要、最终回复。一轮回复按发生顺序排列：连续的思考和工具调用是一个可折叠块，模型写出的正文平铺在块之间；正文之后模型再次思考或调用工具时，在这段正文下方新开一个折叠块（`turns.js` 的 `turnSegments`）。分段只影响显示，底层 SSE、Session 和模型上下文仍是同一轮。正在接收输出的块自动展开，输出转到正文或结束后自动收起；用户手动展开或收起过的块保持用户的选择；打开历史 Chat 时按默认展开配置显示。只有一个块时摘要行显示整轮统计；有多个块时，前面的块显示各自的动作数（只有思考的块显示 `Reasoning`），最后一个块显示整轮的结果与用时。用户消息复用回复的安全 Markdown 渲染器，支持标题、列表、代码、粗体与斜体；复制与编辑仍使用原文。默认不展开 Thinking、读文件、搜索、命令和编辑，只显示一行摘要，例如 `Worked for 32s · 9 actions · 4 files changed`。回复下方的小字显示模型和这次回复的 Token 数（`12.7K tokens in / 0.2K tokens out`；千用 `K`、百万用 `M`，固定保留一位小数，例如 `11.6M`）。还没有名称也没有消息的新 Chat，顶部栏不显示标题，只显示 Workspace。用户主动向上滚动离底超过 72px 时，对话区底部正中出现一个只有向下箭头的圆形按钮，点击后平滑滚到最新消息。触底判定保留 10px 容差；内容增加、卡片展开收起和视口尺寸变化会重新核验并保持贴底，不会单独触发按钮。
  * 运行步骤遵循“对话与调度”里的默认展开配置。正文输出和任务结束不重建步骤区，用户主动展开或收起的状态优先；收起总摘要再展开时保留内部子项状态。展开/折叠复用统一的高度与淡入淡出动效，动画关闭设置仍然生效。
  * 第一层：摘要行（`Worked for …` / `Failed after …` / `Partially completed` / `Cancelled after …` / 运行中显示当前动作）。请求已发出、模型还没有返回任何步骤时，这一行只有旋转环、当前动作和计时：没有展开箭头，下面也没有空的步骤区和占位文字；出现第一个步骤后才变成可展开的行。上下文压缩进行中时，这一行不再重复显示压缩：没有旋转环、当前动作和计时（还没有步骤时整行不出现），手动压缩时上一轮保持完成后的样子；压缩只显示在输入框上方的状态条里——“Compacting context (manual)”（简体中文：`正在压缩上下文 (manual)`）、已用时间（例如 `2m 4s`）和 Cancel，文字末尾不加省略号。压缩开始后才打开的页面没有 `compaction_start` 事件，状态条按快照的 `flags.compacting` 显示，不带原因。
  * 第二层：点开后是可读步骤。读文件、搜索、命令、编辑等用自然语言描述，连续同类动作聚合（“Read 8 files”），可继续展开单项；同一种工具永远是同一种样子（图标、字重、右侧的数字、展开方式），与它走哪条调用路径无关（`web/js/tool-rows.js`）。步骤之间只有确实存在下一步时才画一条很细的竖线，从上一步的状态图标连到下一步的；空状态和只有一步时没有线。进行中的步骤（包括摘要行里的当前动作，如“正在请求模型”）左边是一个小的旋转环；完成的步骤显示该类工具自己的图标，失败是红色的感叹号圆圈，被中止的是停止圆圈。编辑/写入的行右侧是真实的 `+N −M`：`write` 返回新增/删除行数（新文件的 `+N` 是它的行数），`edit` 返回 patch，行数从 patch 数出来；没有真实数字的行不显示。运行步骤在开始修改时先显示带轻微弹跳入场的 `+` / `−` 标识；行数标签持续接收进行中的统计，新增和删除各自累计变化至少 3 行时滚动一次：绿色增加行从下往上，红色减少行从上往下，无变化不重播；步骤或任务结束时立即结算不足 3 行的余量，历史记录首次显示不播放动画，动画关闭设置仍生效。`edit` / 本地 `write` 在验证内容后、原子写入前通过工具进度报告真实变更集，进行中的数字表示待写入变更而非逐行落盘进度；写入失败时不保留该预览。没有可靠统计的工具不估算数字，也不为动画拆分原子写入。网页搜索与网页读取聚合成一行，例如 `2 search rounds · 18 results returned · 3 pages opened`（简体中文：`2 轮搜索 · 返回 18 个网页 · 打开 3 个网页`）：数字来自各次 `web_search` / `web_fetch` 返回的 details（搜索次数、各次返回的网页数之和、各次真正打开的网页数之和），展开后逐次列出搜索词、返回的网页、打开的网页和失败原因，没有记录的数字不显示。Thinking 有内容时可展开；sub-agent / workflow 显示阶段与任务进度。
  * 第三层：单项的 Raw details——真实 tool name、arguments、stdout/stderr、exit code、耗时、result details。读取的文件是 Markdown（`.md` / `.markdown` / `.mdx`）时，展开后的结果按 Markdown 渲染（复用对话里同一个渲染器）；其他文件（`.cpp`、`.ts`、`.json`、日志、shell 输出等）保持原样的等宽文本，不会被当作 Markdown 解析。tool 名称、参数、耗时等元数据始终是普通界面。结果正文下面的“结果详情”（result details）与正文之间有一条分隔线，并放在一张单独的带边框卡片里：卡片头是可点击的一行（箭头、标题、右侧的 Show / Hide），展开和收起用统一的折叠动效。
  * **文件变更摘要卡片**：任务确实改了文件时，这一轮的末尾（最终回复之后）出现一张卡片：标题 `Edited 2 files` 和总计 `+4 −2`，下面每个文件一行，右侧是它自己的新增（绿）/删除（红）行数；二进制、过大或缺少基线的文件只显示文件名，不显示行数（此时也不显示总计）。**每个文件行可以点击展开/收起**（统一的折叠动效），展开后是这个文件的行级 Diff（行号、绿色新增、红色删除、语法高亮，复用 Changes 面板的 `DiffView`，在卡片内自己滚动）；Markdown 文件（`.md` / `.markdown` / `.mdx`）自动把连续的未改动/删除/新增行分别按 Markdown 渲染，不再提供视图切换按钮；其他文件保持代码 Diff。**卡片按轮次保存在 Session 里**：任务结束时（`WebHost.recordRunChanges`）把这一轮改动的文件、行数和当时的 Diff 写成一条 custom entry（`web-run-changes`，不进入模型上下文，与 `web-git-status` 同类），wire 里是 `runChanges` 项，挂在它所属那一轮的回复下面。所以继续发起新任务时旧卡片保留在原位，新任务结束后在新回复下面追加新卡片，每张卡片只包含自己那一轮的改动；刷新页面、重启服务后仍在。上一轮未提交的改动不会计入后续纯问答，也不会重复生成卡片；下一轮修改会建立新的 Git 检查点，以修改前的工作区为基线，Undo 本轮时保留之前的未提交内容。旧检查点仍保存在磁盘，纯问答不会关闭此前的 Undo / Commit 入口。展开时通过 `GET /api/changes/card-diff?id=…&path=…` 读取随卡片保存的 Diff；单个文件超过 20 万字符或一轮合计超过 100 万字符的 Diff 不保存，此时回退到本次服务进程里的任务记录，没有记录则提示 Diff 过大未保存。卡片不会打开右侧面板（面板只由顶栏的按钮打开，见下面的“详情面板”）。这项功能之前的旧任务没有卡片；附着到其他进程的会话（mirror）只显示卡片，不写入 Session。
  * 需要用户处理的状态永远不折叠：等待回答/审批、失败、部分完成、取消都有独立的横幅，横幅会说明失败原因、改了几个文件、跑了几条命令，并提供 Retry；任务留下了未提交的改动时还有 Undo or commit（打开行内的 `/git` 面板）。
任务收尾状态条位于输入框上方，持续超过 500ms 才显示；按服务端实际阶段显示“正在核对本轮文件改动”“正在保存任务记录”或“正在整理长期记忆”，完成或异常退出后立即消失，不显示虚构百分比或倒计时。记忆阶段仅在启用 Auto Memory 并进入提取步骤时出现，不再另发重复的开始提示；失败警告仍保留。快照保存阶段和开始时间，刷新或切换 Chat 后继续显示当前阶段。此状态不代表自动测试、审查或修复。

* **Composer**：输入卡上方是一行小标签，显示任务在哪里运行：Workspace 路径、Git 分支胶囊（分支名和未提交文件数；当前文件夹是关联 Git Worktree 时图标换成层叠图标、胶囊变成强调色并带 `worktree` 标签）、项目未受信任时的提示（点击打开设置的安全页），以及 Extension 的状态文字；除了分支胶囊和未受信任提示，这些标签只显示信息，不可点击，也不会打开右侧面板。**分支胶囊**点击后在它上方弹出分支浮层（`web/js/branch-menu.js`，展开和收起都有淡入/淡出位移动画）：顶部是分支搜索框（打开时键盘焦点就在这里，↑/↓ 选择、Enter 执行、Esc 关闭），下面是本地分支列表（当前分支在最前并在右侧显示对勾，其余按最近提交排序，右侧是最近提交时间），底部是“+ 新建分支”。点一个分支就切换过去（`git switch`：未提交的改动按 Git 的规则带过去，冲突时 Git 拒绝、什么都不变）；已经在另一个 Worktree 里检出的分支带 `worktree` 标记，点它会打开那个副本。悬停分支行出现删除按钮，再点一次“删除？”确认，用的是安全的 `git branch -d`（当前分支、未合并的分支 Git 会拒绝，原因直接显示），删除的行折叠消失。“新建分支”展开一个输入框（搜索框里已有、且没有同名分支的文字会自动填进去），从当前检出的提交新建并切换过去（`git switch -c`，分支名按 `git check-ref-format --branch` 校验）。浮层下半部分是 **Worktree**：“在隔离副本中工作”开关。打开后填一个新分支名（默认 `task-MMDD-HHmm`），“创建并打开”会从 main 新建一个 Git Worktree 并把这个 Chat 切到它（与 `/git` → Worktrees 的 Create / Enter 同一套服务端用例，进入副本等于在副本文件夹开一个新 Chat），原来的文件夹和分支不受影响；在副本里关掉开关会回到主副本。其他已有副本列在开关下面，可以直接打开。Worktree 用例要求主 Worktree 检出的是 `main`，不满足时开关不可用并显示原因。切换、新建、删除分支和进入副本都需要 Agent 空闲（运行中浮层会说明，服务端返回 409）且项目已信任（否则 403）；接口是 `GET /api/git/branches` 和 `POST /api/git/branches/switch|create|delete`（`routes-git.ts`，Git 原语在 `src/git/repository/branches.ts`，都异步执行），Worktree 仍是 `/api/git/worktrees/*`。输入区只放文字和附件。**输入框把未发送的草稿按 Markdown 排版显示**（`web/js/draft-editor.js` + `draft-markdown.js`）：标题、列表、引用、粗体、斜体、删除线、行内代码、链接、分隔线和代码块边输入边呈现；光标所在的行（选中多行时是所有选中的行）用淡色显示这一行的 Markdown 符号（`#`、`**`、`` ` ``、`>`、列表的 `-`），方便直接修改，其他行只显示排版后的效果。排版只是显示方式：草稿的原始 Markdown 文本是唯一的状态，每个字符都按原顺序保留在页面里，所以发送、历史消息、`/` 与 `@` 候选、复制/剪切（复制出的是原始 Markdown）和 Ctrl+Z / Ctrl+Y 撤销重做都基于原文，发出去的就是输入的原文。除输入法组字外，每次输入、换行（Shift+Enter）、删除（含 Ctrl+Backspace 删词）和粘贴（只粘贴纯文本）都直接改原文再重画；Ctrl+A 选中整个原文。**草稿超过 3 行**（按屏幕上的行数，折行也算）时输入卡右上角出现展开图标：点击后同一张输入卡以缩放淡入的动画放大到窗口中央（背后半透明遮罩），文字、Markdown 排版、附件、模型/Effort 和发送都还在，右上角的收起图标、Esc 或点击遮罩以相反的动画回到底部（Esc 会先关闭候选列表等浮层）。底部工具栏左侧是 `+`（附图片、提及文件、运行 shell、斜杠命令、立即压缩），右侧依次是两个各自独立的入口：**模型**和 **Thinking Effort**（都是纯文字加一个小箭头，前面没有装饰图标），各自在自己的按钮上方弹出一个紧凑浮层，不再有横向展开的二级菜单。模型列表是一个不按 Provider 分组的扁平列表（有多个 Provider 时行尾用弱化文字标出 Provider）；搜索框按模型名、Model ID、`provider/model` 和 Provider 名称匹配，结果按相关性排序（完全匹配 > 前缀 > 名称包含 > Provider 匹配），多个词都要出现；打开列表只读本地已保存的模型，不会联系任何 Provider。Thinking Effort 是一条横向分段滑杆：第一行是名称和当前档位，第二行是两端的含义（更快 / 更强），下面是滑杆——当前模型真实支持几个档位就有几个小节点，当前档位是唯一的滑块；可以点击、拖动，或用 ←/→、Home/End 调整；浮层一打开，键盘焦点就在滑杆上，←/→ 只在当前模型真正可选的档位之间移动，键盘和鼠标走同一条保存路径；Enter 或 Esc 关闭浮层并把焦点还给入口按钮。选中的档位立即显示并保持：同一时间只发一个请求，期间再选的档位排在后面发送，只有最后一次选择的服务端结果（真正生效的档位）会写回界面，中途到达的旧快照和事件不会把它改回去（`store.js` 的 `chooseThinkingLevel`）。模型只有一个或没有可选档位时不显示这个入口，切换模型后档位随之更新。每个模型的档位来自各自的 `thinkingLevelMap`（来源与优先级见 [models.md](models.md)：你自己写的 > Provider 官方文档对它自己 API 的明确说明 > 模型目录 > 真实请求检测）；只有被明确确认不支持的档位才会隐藏，没能检测出结果（`unknown`）的档位仍可选择，Provider 页的模型卡片里用一个小的 “Unconfirmed” 标记标出。官方文档说明某些名称只是按另一档运行时（例如 DeepSeek 的 `medium` 实际按 `high` 运行），只显示实际存在的档位，被合并的名称在模型卡片里作为说明列出。再往右是上下文用量环和发送/停止。MyHarness 没有 Plan / Sandbox / 权限模式这类功能，所以工具栏里也没有这些入口。用量环的填充比例等于当前上下文占用比例（强调色，超过 70% / 90% 变为警告色 / 危险色），任务运行期间随 SSE `usage` 事件实时推进，不需要等任务结束。点击用量环弹出一个小面板：`已用 / 窗口`（例如 `12.2K / 128.0K`）、百分比、剩余（例如 `115.8K`）、**缓存命中**和**生成速度**（`t/s`）（命中率是实时 Session 累计，速度是会话累计输出除以对应的累计生成时间，见上），以及 “Compact now”；小面板不会打开右侧面板。数据来自 `GET /api/context`（返回里的 `cache` 字段是整个 Session 的累计：Provider 报告的 cache read ÷（普通输入 + cache read + cache write），悬停缓存命中时显示）和快照里的 `speed`、`cache`。输入框还支持粘贴/拖放图片、`/` 命令与 skills、`@` 文件提及、`!cmd` / `!!cmd` 直接运行 shell、历史消息（↑/↓）。发送与停止在同一个位置切换。Agent 正在运行时，发送按钮和 Enter 按设置里的“任务运行中”选择处理新消息，Composer 上没有发送方式菜单（见下面的“运行控制”）。
* **生成速度（t/s）与缓存命中**：两个数字都按“每一次模型请求”计算，并经过同样的四种状态：首次请求无可靠数据时显示 `—`（仍保留检测状态提示）；已有可靠数字保留到新请求报告可替换的数据，之后是实时值（带闪烁圆点）、请求结束后的最终值，或者 `—`（没能可靠测量）。
  * 速度只算模型真正输出的时间——从第一个非空流式输出片段（文字、thinking 或工具调用参数）开始计时，内容块开始事件不算，等待首个 Token、输入阶段和工具执行都不算。实时值是最近约 1.5 秒内的吞吐，随每一段流式输出刷新（服务端独立 meter 事件最多每 150 毫秒推送一次，usage 同批携带最新值）：Provider 在流式过程中持续报告输出 Token 数时用它报告的数字；只在结束时报告的 Provider，则按已输出的文字估算（约 4 个字符 1 个 Token，每个中日韩字符约 0.7 个 Token），数值前带 `≈`（快照字段 `speed.estimated`），一旦 Provider 报告了数字就改用它；结束后显示这次回复的平均值（输出 Token ÷ 首个输出到结束的时间；输出包含 Provider 报告的推理 Token，但不重复相加，与 DeepSeek 的输出口径一致），Provider 完全没有报告输出 Token 时平均值也是按文字估算的并带 `≈`。平均值保留到下一次请求取得可靠测量。回复不是流式的或时间太短（< 0.25 秒）时结束为 `—`；任务被停止或失败时，已有的实时值保留为最后一个可靠值，没有数字则是 `—`。最新实时速度由 `generation-speed.ts` 计算，SSE `generation_speed` 推送；会话层 `RequestTimingTracker` 在持久化前记录请求总耗时、首次输出等待、生成时间及工具耗时，统计可从 JSONL 恢复。旧会话缺少计时不会补造。工具累计时间为各次执行之和，并行时可重叠。缓存分项保留缺项；可靠总 Token 减输出可确定完整输入，即使缓存写入缺失也可计算命中率。
  * 缓存命中只用 Provider 在这次请求里报告的 Token：命中率 = cache read ÷（普通输入 + cache read + cache write），Provider 报告了这次请求的用量后显示实时值，请求结束后是最终值。接口明确返回缓存计数为零时，即使是第一次请求也显示真实的 `0%`；没有返回缓存字段时，沿用旧 Session 的兼容判断，否则显示 `—`。Claude（`message_start`）和 Gemini（每个数据块）在回复一开始就带缓存用量，所以是真实的实时值；OpenAI 兼容的 Provider 如果只在最后一个数据块报告 Usage，生成期间显示 `—`，不再根据上一轮输入猜测命中率；收到真实 Usage 后显示实测值，请求中断且没有可靠数字时显示 `—`。悬停数值可以看到这次请求命中的 Token 数和整个 Session 的累计命中率；这个页面还没发过请求（例如刚打开的历史 Chat）时，数值用整个 Session 的累计命中率代替。服务端 `request-cache.ts` 计算，SSE `cache_hit` 推送，快照字段 `cache`。
* **统计格式**：缓存命中固定保留两位小数（包括预估和历史累计值）。Token 数统一用 `util.js` 的 `fmtTokens`：千用 `K`、百万用 `M`，固定一位小数（`187.7K`、`27.1K`、`11.6M`），不到一千显示数字本身；悬停提示、Session 汇总、设置及 Provider 容量说明也使用相同 K/M 格式，不输出原始长整数；编辑字段仍保留原有精度，保存值不变。Session 统计使用“用户 / Agent”；费用没有价格规则或没有可靠正值时显示 `—`（与其他缺省值相同），不把默认零计价当作已确认免费。
* **实时数据**：上下文占用、Session 的消息 / 工具调用计数、输入 / 输出 / 缓存 Token、费用以及 Session 名称和文件由服务端通过 SSE `usage` 推送（`WebHost.broadcastUsage`：每条消息结束、每次工具调用结束、任务开始和结束、压缩结束时发送，流式输出期间与正文同批推送（50ms 合并窗口）；Provider 尚未报告输出用量时按已生成文字估算输出 Token 与对应费用，用 `≈` 标明，结束后由真实用量替换。输入与缓存只使用 Provider 报告的数据）。`store.js` 把它写入 `snap.context`、`snap.session` 和 `stats`，用量环和 Session 面板直接读取，所以右侧面板保持打开时数据随任务实时变化，不需要关闭再打开。
* **对话布局**：对话栏和输入卡使用同一个宽度并居中对齐。宽度默认随窗口变化（主区域的 82%，限制在 720–1060px 之间；窄屏时占满可用宽度），设置 → 外观 → 阅读宽度可以填固定像素（620–1100），留空恢复自动。以前保存的默认值 780 视为自动。
* **详情面板**：每次打开页面都是关闭的，也没有任何东西会替你打开它：只有顶栏右上角的按钮（Changes / Files / Terminal / Session）能打开、关闭或切换它；Changes 角标读取当前 Git 未提交文件数，提交完成并刷新状态后、或工作区干净时归零隐藏，不读取历史任务改动数；聊天里的卡片、Composer 的标签、斜杠命令都不会打开它。面板从右侧平滑滑入/滑出，对话区同时随之重排宽度；面板自己顶部的标签条和关闭按钮仍然可用。面板和对话区互不影响：页面只有一行，高度固定等于窗口（`css/layout.css` 的 `.app`），每一栏的内容都在自己那一栏里滚动（面板是 `.panel-body`），所以切换标签、展开/收起面板里的分组或出现很长的列表都不会改变对话区和输入框的位置与高度。面板里的内容不会把面板撑宽：长路径用省略号截断，Diff、文件内容和终端的命令输出按面板当前宽度自动折行（不横向滚动、不截断）。拖动面板左边缘调整宽度，宽度不会超过窗口留给它的空间，拖动从屏幕上的实际宽度开始；拖动时每一帧只改一次宽度，屏幕外的代码行不参与排版（`content-visibility`），终端在停下后才重新计算行列。
  * **Changes**：这一轮到底改了什么，按代码审阅的方式阅读。顶部是范围（`This task`，或 `Working tree`＝Git 未提交改动）、unified / side-by-side 切换和刷新，下面是 Git 操作条（Commit / Push / Undo task / 更多）和一句说明比较基线的话（“相对任务开始前的工作区”或“相对最新提交 `abc1234`”）。已改文件在一个可折叠的列表里：M / A / D / R 标记、目录弱化而文件名加粗、各自的真实 `+N −M`（二进制、过大或缺少基线的文件不显示数字），↑/↓/Home/End 或“上一个/下一个”按钮切换文件（显示 `3 / 12`）；选中的文件的 diff 占满面板其余部分（行号、上下文行、绿色新增和红色删除、语法高亮），切换文件时已显示的内容保持到新的 diff 到达，不闪烁。按钮名称不带 `…`：点击后还有下一步不是加省略号的理由，只有进行中的状态（“Working…”）和输入框提示保留。
  * **Files**：工作区文件树（带 Git 状态与“本轮改动”标记，文件夹展开/折叠复用统一高度与淡入淡出动效，箭头平滑旋转）、文件名搜索、文件查看（语法高亮、图片预览、跳转到行）、`@` 提及到 prompt。`.md` / `.markdown` 默认显示排版后的 Markdown，可直接点击段落、标题、列表、引用或代码块编辑；排版工具栏可添加标题、粗体、斜体、列表、引用、代码与链接，Save 或 Ctrl+S 写回原始 Markdown（不是 HTML）。未修改的块保留原始文本，修改的块转换成标准 Markdown；UTF-8 与原文件换行方式受到保护。文件在磁盘上被 Agent 或其他程序修改后，保存返回冲突而不会覆盖；截断的大文件只读，返回文件树时会确认未保存的修改。其他代码文件仍保持原来的只读语法高亮查看行为。
  * **Terminal**：真实的交互式终端标签页，不再有“命令记录”入口。先从下拉框选择 Shell，再点 `+` 新建独立实例；可以同时创建多个 CMD、Windows PowerShell、PowerShell 7 或 Git Bash（后两者需本机已安装）。每个标签页有独立进程、输入和输出，服务端按文件夹、Shell 和 `instance` 标识管理，最多同时运行 16 个。标签页清单保存在浏览器，同一文件夹的 Chat 共用清单；切换标签、关闭面板、刷新页面和切换 Chat 不会结束进程，回来时重放已有输出。垃圾桶结束当前实例并移除标签，重启只影响当前实例；Shell 自己退出后仍保留输出，可点“重新启动”或按 Enter。服务退出会结束全部实例。服务端使用 ConPTY，页面使用 xterm.js；Ctrl+C 在有选区时复制，否则中断，Ctrl+V 粘贴。终端按键不触发页面快捷键，命令不进入 Agent 上下文，也不计入 Changes。
  * **Session**：上下文用量与压缩、Session 统计、Git checkpoint、分支树（导航 / fork）、Tools（可开关）、Skills、Prompt templates、Extensions、项目上下文文件、Reload resources。分支操作是常驻、不折行的次级按钮；内置工具名称保留英文，描述随界面语言显示精简短句，不截断。
* **设置**（默认 `Ctrl+Alt+,`）：外观（界面语言/主题/动画/阅读宽度）；对话与调度（任务运行中的发送方式、消息投递卡片中的引导/排队消息顺序、运行步骤默认展开）；Agent（运行、压缩、重试，以及 Auto Memory / Sub-agent / Vision 辅助智能体）；网络搜索（搜索开关、引擎、读取网页数、抓取数量、并发与备用浏览器）；代码智能（独立一级页，Lightweight / Semantic 单选；Semantic 下以折叠列表显示清单语言模块的状态、下载按钮或启用开关、传输进度与预计剩余时间）；图片在 Agent 页常驻平铺展示；Network 与 Shell；安全与隐私（Project Trust、默认信任策略、浏览器通知与任务结束通知、提醒与提示）；终端界面（只影响终端，与终端 `/settings` 同一份）；Providers。浏览器专属配置仍保存在浏览器，其余设置的保存方式不变。打开设置时焦点停在弹窗容器，不自动进入输入框。数字设置名称旁显示有效范围，搜索读取为 0–10、每次抓取 URL 为 1–20、并发下载为 1–8，与实际生效范围一致。各页用同一种卡片 + 横向行布局：名称和精简说明在左，控件在右，包括搜索引擎多选。说明不再用省略号截断，空间不足时只在左侧文字区折行，不把控件移到下方。行最小高度为 33px；行里的输入框、数字框、下拉和模型按钮都是 28px 高（与分段选择、多选控件相同），字号与名称一致；下拉有统一的最小宽度，所以短选项的左边缘也对齐，选项更长时按内容加宽；每一页的控件都结束在同一条右边缘上（滚动条有固定的位置，页面长短不影响它）。Web search 的搜索引擎是紧凑多选，关闭 Web search 时该卡片的其余行变暗。“匿名更新检查”和“共享使用分析数据”不在设置页里（行内 `/settings` 面板仍有这两行，与终端一致）。

  **Project Trust**（安全与隐私页）是一行：项目路径、状态（已信任 / 未信任 / 无需信任）和一个开关。开关打开＝信任这个文件夹，关闭＝不信任；决定保存到 `trust.json` 并立即生效：`POST /api/trust` 保存后先让发起请求的 Chat 按新状态重新加载项目设置和资源，再让同一文件夹里其他空闲的已打开 Chat 跟进（`WebHost.applySavedTrust`、`hub.ts` 的 `trust_changed`）；Chat 正在运行或压缩时返回 409，什么都不保存。项目里没有需要信任的资源时只显示“无需信任”，没有开关。“信任上级文件夹”仍可在行内 `/settings` → Project trust 里选择。

  **任务结束通知**（安全与隐私 → 通知 → Desktop popup when a task ends，与终端共用 `popupNotifications`，默认开启）：任务完成、失败或被中断时都会通知，页面是否在前台都一样。服务端在运行进入终态时按设置决定是否通知（`WebHost.announceTaskEnd`，规则与终端相同），并通过 SSE `task_notification` 先交给打开着的页面：浏览器允许通知时由页面弹出浏览器通知（标题是结果，正文是项目名和 Chat 名称、最终回复的开头、失败原因、用时以及这次做了什么——改了哪些文件、运行了几条命令、读了几个文件、搜索和打开网页的次数；点击回到该 Chat），并用 `POST /api/notifications/answer` 告诉服务端已弹出。浏览器没有通知权限、不支持通知、没有任何页面打开，或 2.5 秒内没有页面回答时，服务端改用系统弹窗（与终端相同的 `showPopupNotification`，内容同样由 `summarizeRunWork` / `describeTaskEnd` 生成），所以通知不依赖浏览器权限。打开这个开关的那次点击会向浏览器申请通知权限（`Notification.requestPermission`，`settings-apply.js`）；开关已打开而浏览器还没决定时，这一行显示“在此浏览器中允许”按钮，浏览器已拦截或不支持时显示“系统弹窗”标记。安全与隐私页的“浏览器通知”是另一个只保存在浏览器里的开关（只在标签页处于后台时通知）；两者都打开时同一个任务只通知一次。

  **保存反馈**（设置页和行内 `/settings` 面板一样，`web/js/settings-apply.js`）：开关、选项和输入框的新值立即显示；本地保存很快，所以什么额外的东西都不出现，只有真的慢（超过约 0.4 秒）的保存才在控件旁显示小的加载圈，显示后至少保持约 0.5 秒，不会闪一下；保存完成后重新读取真实设置，保存失败时值恢复原样并弹出失败原因。**数字类设置只输入数字，单位是固定在输入框里、不可编辑的后缀**：上下文窗口上限显示为 `256 | K tokens`（1K = 1024 Token，右侧小字以统一 K/M 格式显示换算后的 Token 数，保存的仍是准确的 Token 数，留空表示不限制，服务端设置项的 `type` 是 `tokens`）；`Web UI exit delay` 显示为 `10 | seconds`。输入的值不合法时框变红，离开输入框时恢复原值并给出提示。

  **模型设置项**（Compact Model、Auto Memory、Sub-agent、Vision Assistant）使用与 Composer 相同的两个控件：模型按钮打开同一个扁平模型列表，第一项“使用主模型”会清空该项的 Provider、Model 和 Effort，运行时连同主模型当前的 Thinking Effort 一起继承；选了具体模型且它有多个档位时，旁边出现 Effort 按钮，打开同一种滑杆，下面多一个“默认”，表示不覆盖、不发送 Effort（规则见 [settings.md](settings.md)）。

  **Providers 页**是左右两栏：左边是 Provider 列表（状态点：可用 / 缺少 Key / 已停用）和 “Add provider”，右边是选中 Provider 的编辑区。切换 Provider 时如果表单有未保存的改动会先确认。编辑区顶部是名称、ID、状态和启用开关；自定义 Provider 下面是表单，内置 Provider 只显示只读信息和 Key。**打开页面、切换 Provider、重新打开设置、刷新、编辑和保存都不会联系 Provider**，只读本地的 `models.json` 和凭据；没有“刷新全部模型”，旧的 `POST /api/providers/refresh-models` 和 `GET /api/models?refresh=1` 已移除。

  **API Key**：主页面只显示正在使用的 Key 和“管理 API Key”（没有 Key 时是“添加 API Key”）。管理子页面列出全部 Key，可以添加（可选名称；第一个 Key 立即启用，之后的需点“使用这个 Key”）、切换、改名和“删除 API Key”；删除正在使用的 Key 时要选一个替代 Key。OAuth 登录也在这里。“删除 API Key”只删一个 Key，与底部的“删除 Provider”不同；旧的 “Remove credentials”（一次删除全部凭据）入口已去掉。

  **自定义 Provider 表单**：连接卡片（名称、ID、API 格式、Base URL、认证）。**认证**始终提供两种方式，选哪一种都不会让另一种消失：“API Key”（存入凭据库而不是 `models.json`）和“在 models.json 中设置”（继续使用 `models.json` 里的 `apiKey`，界面只提示“Key 在 models.json 中设置（已隐藏）”，不显示也不改动它；文件里还没有 Key 时提示到 JSON 视图添加）。选择保存为 `models.json` 的 `authMode`（`apiKey` / `config`），重新打开时按它恢复；没有 `authMode` 的旧条目在文件里有 `apiKey` 时视为“在 models.json 中设置”。没有“无需认证”选项。**Base URL** 输入框为空时只用很浅的灰色显示示例 `https://api.example.com/v1`，示例不是值：新建 Provider 的 Base URL 为空，示例地址本身也不会被当作有效地址保存。Base URL 没填时仍可保存，但 Provider 不可用：状态显示“缺少 Base URL”，启用开关不可操作（`POST /api/providers/enabled` 返回 409），它的模型不出现在模型列表里；把已启用 Provider 的 Base URL 清空再保存同样允许，保存后提示“Base URL 未填写，Provider 已停用”。补上 Base URL 并保存后即恢复，不需要其他操作。连接卡片之后是与模型卡片（ID、显示名、是否支持推理、可用 Thinking Effort、图片输入、上下文窗口、最大输出；上下文窗口和最大输出以 K 为单位填写，1K = 1000 Token，输入框里固定显示 “K”，下方显示换算后的准确 Token 数，保存到 `models.json` 的仍是真实 Token 数，例如 128000 显示为 `128`，131072 显示为 `131.072`，最多三位小数）。模型卡片默认折叠成一行摘要，点开才编辑；“Add manually”手动添加。底部固定一栏放“删除 Provider”、放弃和保存。“以 JSON 编辑（高级）”是可选的底层编辑入口，与表单共用同一份数据。

  **模型计价**：模型卡片包含“自定义计价”：输入、输出、缓存命中、缓存写入单价，每个基础和阶梯价格标签随币种显示 `($/1M)` 或 `(¥/1M)`，与 Token 阈值输入区别；添加阶梯使用带加号的次级按钮。支持美元或人民币，以及可选的长上下文阶梯。阈值按每次请求的输入与缓存 Token 总量判断，超过阈值时整个请求使用该阶梯；不是把整个 Session 累计 Token 套入阶梯。Session 费用按当前保存的模型规则计算，币种分别显示（`$` / `¥`），不做汇率转换。Provider 报告用量时随 SSE 实时更新；只在请求末尾报告 Token 的 Provider 无法提供准确的生成中费用。详见 [models.md](models.md)。

  **检测模型**：只有点“检测”才会联系 Provider，而且只检测输入框里写的 Model ID（逗号、空格或换行分隔）。`POST /api/providers/custom/detect` 必须带 `modelIds`，用表单**当前**的连接信息（包括刚输入但未保存的 Key）先读一次模型列表（免费；按 API 格式走各自的列表接口：OpenAI 兼容 `/models`、Anthropic/Mistral `/v1/models`、Gemini `/v1beta/models`），只取这些 ID 在列表里明确写出的能力；然后对这些 ID 逐个档位发最小的真实请求检测 Thinking Effort（可能计费，规则见 [models.md](models.md) 的 Thinking Effort 一节，总时长最多 120 秒）。检测只针对填写的 Model ID 本身：不查预置模型表、不按名称猜测，ID 不在列表里或列表读取失败时照样检测；没有 Model ID 就不检测。每个档位独立判断：请求成功为“支持”，服务端明确拒绝该参数或该档位为“不支持”，超时、429、5xx、网络错误和其他异常为“无法确定”，后者最多再试 3 次（共 4 次），其中一次成功即停止。“无法确定”的档位不会被隐藏，也不会改动已有设置。新 ID 会加入表单；已有模型只更新检测能确认的字段（图片输入、上下文、最大输出、目录给出的档位，或检测明确确认支持 / 不支持的档位），其余保持不变；没写的模型完全不动。列表里没有的 ID 仍会加入并提示检查拼写；列表读取失败会给出具体原因（认证失败、Base URL/路径不对或端点不提供列表、网络错误、上游 5xx、响应格式不对），此时仍会尝试检测 Effort。检测结果要点“保存”才写入 `models.json`。

  **删除 Provider**与启停不同：确认后移除 `models.json` 条目、该 Provider 的全部 API Key/登录、指向它的设置（默认模型等）以及备份文件里的对应条目；任何一步失败会回滚 `models.json`。最后一个 Provider 也可以删除，之后 MyHarness 进入“暂无可用模型”的空状态。如果有 Chat 正在用这个 Provider 的模型运行，先弹出选择：“不删除”什么都不改；“立即删除”会立刻停止这些任务再删除（`GET /api/providers/custom/usage` 查询，`POST /api/providers/custom/delete` 需带 `stopRunning: true`，否则只返回运行中的任务列表）。
* **命令面板**（默认 `Ctrl+Alt+K`）：动作、斜杠命令、Chat、文件的统一搜索；↑/↓ 选择，Enter 执行，Esc 关闭。
* **搜索排序**：命令、设置项、Workspace、Chat 和模型的候选都用同一条规则（`web/js/search.js` 的 `rankSearch`，与终端 `packages/tui/src/fuzzy.ts` 的 `rankedFilter` 一致），不区分大小写：先按相关性（名称完全匹配 > 名称前缀 > 名称包含 > 说明/关键词匹配 > 字母顺序模糊匹配），同一相关性内再按使用次数，最后保持原有顺序。例如搜索 `git`，`Git` 排在 `GitHub Connect` 前面。搜索框为空时保持原来的按使用次数排序。斜杠命令和 `/settings` 行的使用次数与终端共用（`usageRanking`，由 `POST /api/commands/usage`、`POST /api/settings/usage` 记录）；模型搜索只按相关性。
* **行内命令面板**：在 Composer 输入 `/settings`、`/model`、`/effort`、`/git`、`/restore`、`/undo`、`/workspace` 并回车，会在输入框上方展开一个类似 CLI 菜单的多级面板（不是设置页）。面板是居中的紧凑卡片，宽度按内容决定：滑杆和只有几项的短选择用小卡片（`sm`/`md`），选项很多（超过 6 项）、带详情（待丢弃的文件列表等）或自定义内容的层级才加宽（`lg`），同一个面板里往返不同层级时尺寸平滑过渡；关闭时淡出。操作：↑/↓/PgUp/PgDn/Home/End 移动，Enter 或 → 进入/确认，Space 切换开关，←/Backspace/Esc 返回上一级（有筛选时先清筛选），可键入筛选；鼠标可选。`/settings` 的行、名称、说明、固定选项和顺序只在 `src/cli/settings-menu.ts` 的 `SETTINGS_MENU` 里定义一次：终端的 `/settings` 由它构建，Web 通过 `GET /api/settings` 的 `menu` 拿到同一份（已按与终端共用的使用次数排序），所以增删、改名、调整顺序或选项只改这一处，两边一起变。只属于一个界面的行用 `surfaces` 标出（终端独有：Theme；Web 独有：Appearance、Project trust、Auto-retry、Model cycling scope、Web UI exit delay、Shell path、Command prefix、Analytics、About）。Web 端只声明每一行怎么打开：编辑单个设置的行由 `routes-settings.ts` 的 `SETTINGS_MENU_SETTING` 对应到设置项，自带页面的行由 `web/js/settings-menu.js` 的 `SETTINGS_MENU_PAGES` 列出，`test/web-frontend-logic.test.ts` 检查两者合起来与注册表一一对应。名称保持与终端相同的英文，说明随界面语言显示；编辑的是同一份 `settings.json` / `models.json` / 凭据。面板里每一行都是单行：图标和名称在左，说明以较弱的颜色跟在名称右侧（过长截断），当前值、开关或箭头在最右。Thinking level 和各模型设置项里的 Effort 用与 Composer 相同的横向滑杆（←/→ 调整，Enter 返回）。点击面板以外的任何地方会关闭整个面板（包括多级子页面），面板内的点击和它打开的确认框/菜单不会关闭它；关闭不会清空输入框里的草稿。`/git` 覆盖 Commit、Push、撤销任务、恢复到最新提交、Worktree、历史、仓库登记。一次性命令（如 `/new`、`/compact`）仍直接执行，候选列表与搜索保留。

  **`/commit` 和 `/push` 与终端一致：不需要选择，回车就直接运行**（`/git` 面板里的 Commit / Push 行和 Changes 面板的 Commit / Push 按钮走同一条路径，`web/js/git-flow.js`，服务端用例不变）。运行中，正文会话流中的状态卡显示一行紧凑的进度（旋转环、服务端报告的阶段文字、Cancel）；结束后正文中的结果卡显示真实结果：成功是 `Commit succeeded` / `Push succeeded`（简体中文：`Commit 成功` / `Push 成功`）加真实的短 hash 和一句说明，失败是失败标题加 Git 给出的真实原因（跳过 `warning:` / `hint:` 这类只是提示的行），`Details` 展开完整输出，成功 Commit 详情里的 `(+X/-Y)` 使用与文件列表相同的新增绿、删除红高亮，其他输出保持原样。Commit 的 hooks/代码检查失败时，服务端用不显示的 custom message 触发 Agent 排查代码根因，等待修复任务及完成阶段结束后自动重新提交；不发送用户身份的日志/修复指令。自动修复的排查、Thinking、工具调用、输出和文件变更卡片只显示在当前 Commit 卡片内部，不追加到原任务的步骤或回复中。卡片实时显示当前修复动作，Details 可展开/折叠完整修复记录；成功或失败在同一张卡片原位更新，刷新后仍按已有 `git-commit-repair` 隐藏消息和 `web-git-status` 记录恢复层级，不改变 Session 格式或提交/重试规则。每次操作最多一次修复/重试（包括临时错误重试），失败后停止并显示明确通知和原有错误卡片，Details 保留完整 stdout/stderr；锁、权限等不可修复错误直接停止，不绕过 hooks。Push 的 CI 失败仍保留 “Ask the agent to fix CI” 手动入口。进度与结果直接显示在正文会话流中，不再在输入框上方自动消失。每次操作的结果沿用原状态条的配色、图标、hash 和 Details，作为独立记录保存到 Session 的现有 custom entry（`web-git-status`），不进入模型上下文；即使新 Chat 只有操作卡片而没有模型回复，也立即落盘并保留在侧栏，不作为空 Chat 复用；后续操作不会覆盖它，刷新页面或重新打开 Chat 后仍能看到。Changes 的更多按钮在按钮下方、右侧栏内部展开同一个 Git 命令面板。

  需要选择的命令用键盘可操作的行内面板，默认项是安全的：`/undo` 的第一项是 “Keep changes”，撤销要再确认一次；`/restore` 先列出将被丢弃的文件，第一项是 Cancel，之后才是 “Discard and restore”；它们的结果同样作为独立卡片保留在正文会话流中。`/undo` 需要存在任务检查点，而检查点只在开启 Git integration 时创建；没有检查点时面板说明原因，并指向 “Restore to last commit”。`/workspace` 同样是多级面板：Workspace 与 No Folder → 其中的 Chat（打开）/新建 Chat/从列表移除，以及添加 Workspace。
* **斜杠命令的来源**：内置命令只在 `src/cli/slash-commands.ts` 的注册表里定义一次（名称、别名、说明、`surfaces`：`cli` / `web`，未写表示两边都有），终端 UI 的候选与派发、Web 的 `/api/resources`（`resources.commands`，含 `aliases`）都读它，Web 前端不再有自己的一份命令表。目前所有内置命令两边都有，Web 不再有只属于 Web 的命令（`/diff`、`/terminal`、`/files` 已移除：右侧面板只由顶栏按钮打开）；`/setting` 是 `/settings` 的别名。`web/js/builtin-commands.js` 只声明每个命令在浏览器里怎么执行（`panel` 打开行内面板、`action` 立即执行、`prompt` 作为消息发给 Agent），`test/web-frontend-logic.test.ts` 检查它与注册表一一对应。
* **键盘操作**：行内命令面板的列表超过 4 行时默认带筛选框（设置根层也会搜索每一个具体设置项，例如输入 `exit delay`），进入子层时焦点和选中项稳定，返回上一层时恢复筛选文字与选中项；`Tab`/`Shift+Tab` 循环，`Space` 只在筛选框为空时切换开关，不劫持输入框。命令面板（`Ctrl+K`）和 Composer 的候选用键盘选择时，鼠标停在原位不会抢走选中项（只有鼠标真的移动才会）。需要审批/选择的对话可以直接用键盘回答：←/→/↑/↓/Tab 选择，Enter 确认，Esc 拒绝或取消，选项对话可按 1–9，`Alt+A` 把键盘焦点拉回该对话。
* **斜杠命令候选**：只有 `/` 是消息的第一个字符时才出现（正文、路径或 URL 中间的 `/` 不触发），输入 `/` 立即展开，继续输入实时筛选；中文输入法下 `/` 键打出的全角 `／` 或 `、` 作为第一个字符时按 `/` 处理。输入 `/c` 等内容时候选列表高亮一个命令：`Enter` 直接确认并执行它（多级命令如 `/settings`、`/workspace` 立即打开对应面板，`/compact` 等立即执行），`Tab` 只把命令名补进输入框以便继续写参数，`↑/↓` 换选（从第一项按 ↑ 跳到最后一项、从最后一项按 ↓ 跳回第一项，列表会跟着滚动，选中项始终可见；行内命令面板同样如此），鼠标点选等同 `Enter`。`Esc` 或点击输入卡以外的地方只关闭候选列表，不改动草稿；继续输入会重新出现，删掉后再输入 `/` 也会重新出现。`@` 文件候选没有“执行”，`Enter`/`Tab` 都是插入。

### 界面语言

设置 → 外观 → **界面语言**（或命令面板里的 Language 项）在 English 与简体中文之间切换，立即生效并保存在浏览器；默认 English。只翻译 MyHarness 自己的界面文字（菜单、按钮、状态、设置、提示、空状态、错误、运行状态），不翻译用户与 Agent 的消息、代码、文件内容和命令输出。开发者术语保持英文：Terminal、Session、Workspace、Provider、Commit、Push、Diff、Worktree、Thinking Effort（及 off / minimal / low / medium / high / xhigh / max 等档位名）、Markdown、JSON、PowerShell、Bash、Git 和路径等，只翻译它们周围的句子，中英文之间留空格（`test/web-i18n.test.ts` 检查）。

* 机制：`web/js/i18n.js` 以英文原文为 key（`t()` / `N_()` / `tNodes()` / `count()`），中文词典只放在 `web/js/locales/zh-CN.js`；源码里其他位置不出现中文（测试强制）。
* 服务端产生的文本：设置项、错误等英文文本由词典翻译；终端侧固定为中文的文本（运行状态、Git 阶段、命令说明等）通过 `serverTextEn` 在英文模式下映射为英文，未知的中文不会显示在英文界面里。CLI 的输出不变。
* 新增界面文字：用 `t("English text")` 并在 `zh-CN.js` 补条目；`test/web-i18n.test.ts` 会检查缺失的翻译、占位符不一致和源码里的中文。

### 与终端共享同一个会话（双向）

一个 Session 同一时间只有一个进程运行它的 Agent 并写它的 JSONL（持有写入锁的 **owner**）。以前在 Web UI 里切换到终端正在运行的会话会报 `Session is already active in another MyHarness process`；现在 Web 进程（`setMirrorSessionsAllowed(true)`，在 `startWebBootstrap` 里打开）发现会话被另一个活着的进程占用时，会**附着**到它。终端反过来也一样：交互式终端（`main.ts` 在 `appMode === "interactive"` 时打开同一个开关）用 `--session`、`--continue` 或 `/resume` 打开被 Web UI（或另一个终端）占用的会话时，也附着到它，不再报错。谁先打开谁是 owner，另一方是附着方：

* owner 在持有写入锁期间，在回环地址上开一个小服务（`agent/runtime/session-bridge.ts`），端口和随机令牌写在会话旁的 `<session>.jsonl.bridge`（`session/bridge/descriptor.ts`，只含 pid / 端口 / 令牌，不含会话内容；owner 释放锁时删除）。服务把 owner 的每个 `AgentSessionEvent` 连同当时的运行状态（是否在运行、排队消息、模型、后台任务数等）推给附着的进程（流式更新合并为每 40 毫秒一次），并接收 `prompt / steer / followUp / abort / clearQueue / setModel / setThinkingLevel` 命令。
* 附着的一方是 `MirrorAgentSession`（`agent/runtime/mirror-agent-session.ts`）：它是一个普通的 `AgentSession`，读取类能力（消息、模型、上下文用量、设置）照常工作，但 Agent 不在本进程运行。会话 JSONL 由 `SessionManager.syncFromDisk()` 只读取 owner 新追加的字节来跟随；owner 的事件原样回放给本地订阅者，所以 WebHost、前端的对话流、工具输出、运行状态、速度与缓存命中都和终端同步。在 Web 里提交输入等于向这个会话提交任务，由 owner 像在终端里输入一样执行；两端看到同一份对话。附着方不写会话文件，不做完成阶段的 Git checkpoint / Auto Memory / 系统弹窗（这些由 owner 做），`snapshot.flags.mirror` 为 `true`。终端作为附着方时同样不做这些完成阶段工作，也不能执行 `!` 命令（提示到 owner 进程里执行），输入框里的消息和 Esc 取消都交给 owner；启动时显示一行“这个会话正在另一个进程里运行”的提示。
* 同进程通过 junction/symlink 等目录别名打开同一会话时，写锁按真实目录路径共享本地租约，不把第二个 runtime 当成其他进程。锁 owner 标记存在时，bridge 的 PID 必须与它一致才能尝试附着，之后还需通过 bridge 令牌握手；残留 bridge 不能单独证明会话在其他进程运行。明确已退出的 owner 的锁按原有安全校验恢复，未知锁仍保留 stale 等待，不强制删除活进程的锁。Web 协同提示是可手动关闭、也会自动消失的通知，不是阻塞弹窗；不提供强抢活进程写锁的操作。
* owner 进程结束（或关闭该会话）时，附着方收到断开，接手该会话（owner 释放写入锁需要一瞬间，期间重试，最多 15 秒），此后它就是 owner：Web 由 `WebHostHub.reclaimMirror` 在同一个 slot 里重新打开，终端由 `InteractiveMode.reclaimMirrorSession` 用 `switchSession` 重新打开。没有开启附着的运行方式（`--print`、`--mode json/rpc`）遇到被占用的会话仍然报原来的错误。

### 同时运行多个会话

多个 Chat 可以同时运行，互不影响：每个打开的 Chat 是服务端 `WebHostHub`（`hub.ts`）里的一个 slot，拥有独立的 `AgentSessionRuntime`（session、cwd 绑定的服务、Git checkpoint、对话框队列、消息与工具流）。请求通过 `x-myharness-slot` 头（或 `slot` 查询参数）定位 slot，SSE 事件带 `slot` 字段，前端 `store.js` 为每个 slot 保存独立状态并只渲染当前 slot。切换 Chat 只是换显示哪个 slot，后台 Chat 继续运行，回来时看到的是真实状态；侧栏用 `slots` 事件显示每个 Chat 的运行/等待/结果。空闲的后台 slot 最多保留 5 个（`MAX_IDLE_BACKGROUND_SLOTS`），运行中或等待回答的从不释放；已释放的 slot 再请求会返回 410，前端自动重新打开。

### 运行控制

Agent 正在运行时发送消息有三种行为，直接映射 MyHarness 真实的机制。Composer 上没有发送方式菜单：Enter 和发送按钮用哪一种，在设置 → 外观 → 对话 → **While a task is running**（或行内 `/settings` 的 Appearance）里选，保存在浏览器，默认 Steer；输入框的占位文字、发送按钮的提示和 About 里的快捷键说明都会写出当前选择的行为。`Alt+Enter` 始终是 Queue。

| 行为 | 怎么触发 | 效果 | 底层 |
| --- | --- | --- | --- |
| **Steer** | 设置里选它（默认）后按 Enter / 发送 | 在当前运行的下一个模型步骤前送达，不会打断正在执行的工具 | `AgentSession.prompt(..., { streamingBehavior: "steer" })` |
| **Queue** | `Alt+Enter`，或设置里选它后按 Enter / 发送 | 等当前运行完全结束后再送达 | `streamingBehavior: "followUp"` |
| **Interrupt** | 设置里选它后按 Enter / 发送 | 立即中止当前运行，然后发送新消息 | `AgentSession.abort()` → `waitForIdle()` → `prompt()` |
| **Stop** | 停止按钮，或输入框为空时按 Esc | 中止当前运行 | `AgentSession.abort()` |

排队中的消息显示在 Composer 上方，可一键放回输入框。

### 状态语义

“轮次结束”不等于“任务成功”。摘要与横幅使用明确的状态：`Completed`、`Partially completed`（失败/超时但已改动文件）、`Failed`、`Cancelled`、`Waiting for you`。运行中的状态来自 `RunStateSnapshot`；结束后的状态来自 `run_state_changed` 的终态；历史消息（没有运行记录）按最后一条 assistant message 的 `stopReason` 推导，并且只声明能证明的事实（例如“No file edits were recorded”而不是“没有改文件”）。

### 审批与用户问题

MyHarness 核心没有内置的工具权限系统；审批来自 Extension 通过 `ctx.ui.select/confirm/input/editor` 提出的问题（例如 `examples/extensions/permission-gate.ts`）。Web UI 实现了同一套 `ExtensionUIContext` 对话方法（`mode: "web"`）：问题显示在 Composer 上方的醒目操作条里，不是 Modal，头部同时显示 `Waiting for you`；有 timeout 的对话会倒计时。Project Trust 问题（启动或切换到其他项目时）在浏览器里回答。

## 与 CLI 的关系

* Web 服务里每个打开的 Chat 各有一个 `AgentSession`（TUI 一次只有一个），可同时运行；每个都走与 TUI 相同的完成阶段与 Git checkpoint。切换 Chat 不会中断运行中的任务。
* 完成阶段沿用 TUI 的同一批函数：`collectFinalWorkspaceChanges`、Git checkpoint 的 complete / retain、Auto Memory 提取、`agent_response_ready` 事件。
* Git：`/commit`（`GitCommitUseCase`）、`/push`（`GitPushUseCase`）、`/restore`（`discardChangesToHead`）、`/undo`（`restoreGitCheckpoint`）、Worktree（`GitWorktreeUseCase`）、本地仓库登记（`LocalGitRepositoryStore`）都调用现有用例，没有新的 Git 逻辑。
* Settings 通过 `SettingsManager` 写入同一份 `settings.json`；Provider 凭据通过 `ModelRuntime` 写入同一份 `auth.json`。浏览器只会看到密钥的后四位。

与 TUI 的已知差异（有意为之，见 [维护](#维护)）：

* `/commit` 失败时不会自动进入 Agent 修复循环，而是在输入框上方的状态条里显示失败原因（`Details` 里是完整的 Git 输出）并提供 “Ask the agent to fix it”；`/push` 的 CI 失败同理，提供 “Ask the agent to fix CI”。
* 最终回复不会因 Auto Memory 整理而被延迟显示。
* 主任务以完成、取消、失败、超时或中断结束，或者你按了停止时，它派生的一切一起结束：后台 Explore 批次被中止，它们的卡片立刻变成“已取消”（没有转圈，也没有 “running in the background”），运行中的 workflow 被终止。主任务**正常完成**时也一样：任务结束（`_emitAgentSettled`）后，它启动的后台 Explore 批次同样被中止，卡片立刻变成“已取消”。
* TUI 专用的 Extension 能力（`custom()` 组件、自定义 editor/footer/header）在 Web 中无效；`setStatus`、`setWidget`（字符串数组）、`setWorkingMessage`、`setTitle`、`notify` 与对话方法有效。
* Terminal 面板的交互式终端只在 Web UI 里有：它是用户自己的 Shell，Agent 的 `bash`/`pwsh` 工具仍然每条命令单独执行，不使用这个终端。
* “这一轮改了什么”的数据只在本次服务进程里记录（最近 12 轮）；重启后历史 Chat 仍能看到步骤，但 Changes → This task 不含旧任务。`Working tree` 范围永远读取真实的 Git 状态。

## 安全

* 只绑定 `127.0.0.1`；校验 `Host`（防 DNS rebinding）、`Sec-Fetch-Site`、`Origin`；所有写请求必须带 `x-myharness-web: 1`；响应带严格 CSP（仅同源脚本，无内联脚本）。
* 文件 API 只读，路径解析后必须落在当前 Workspace 内（含符号链接检查）；文件夹选择器只列子目录名。
* 模型输出的 Markdown 不渲染原始 HTML，链接协议白名单，远程图片被 CSP 阻止。
* `models.json` 中的字面量 key / header 在浏览器里显示为占位符，保存时未改动则保留原值。
* Terminal 面板的终端是一个拥有当前用户权限的真实 Shell（与已有的直接运行命令相同的信任边界）。它的接口和其他写请求一样只接受本机同源页面的请求；工作目录由请求所属 Chat 的文件夹决定，页面不能指定；同时运行的终端最多 16 个。

## 实现地图

```text
packages/coding-agent/
├── src/modes/web/                 服务端（TypeScript，随 CLI 一起构建）
│   ├── web-mode.ts                启动 / 关闭；startWebBootstrap（先起 HTTP 以便回答 Project Trust）
│   ├── http-server.ts             loopback HTTP、路由、静态文件、SSE
│   ├── hub.ts                     WebHostHub：每个打开的会话一个 WebHost（slot），并发运行与请求路由
│   ├── host.ts                    WebHost：订阅 AgentSession 事件、完成阶段、快照、prompt 提交
│   ├── lifecycle.ts               WebLifecycle：最后一个页面断开后的宽限倒计时（web-mode.ts 接线，http-server.ts 提供连接数）
│   ├── dialogs.ts                 Extension UI 对话桥（ExtensionUIContext 的 Web 实现）
│   ├── changes.ts                 ChangeTracker：edit/write 快照 + checkpoint → 逐文件 diff
│   ├── folder-dialog.ts           系统文件夹选择窗口（添加 Workspace）
│   ├── generation-speed.ts        模型输出速度（t/s）：只用 Provider 报告的输出 Token 和真实到达时间；每次请求从 detecting 开始
│   ├── request-cache.ts           每次模型请求的缓存命中率：Provider 报告的 cache read / write；只在回复结束时才报告的 Provider 回复期间用上一次请求预估（`estimated`），状态与速度相同
│   ├── wire.ts                    AgentMessage / SessionEntry → JSON wire items
│   ├── terminal.ts                WebTerminals：Terminal 面板的真实 Shell（伪终端，按文件夹 + Shell 保存，输出回放）与可用 Shell 列表
│   └── routes-*.ts                core / sessions / files / git / settings / providers / accounts（GitHub Connect）/ terminal
└── web/                           前端（原生 ES modules，无构建步骤）
    ├── index.html  css/  vendor/  Preact + htm、xterm.js（终端显示）；marked / highlight.js 复用 HTML 导出的 vendor 文件
    └── js/                        store.js（状态+SSE，按 slot 分状态）、turns.js（对话模型）、transcript.js、tool-rows.js（工具行共用的状态图标与网页搜索明细）、composer.js、draft-editor.js / draft-markdown.js（输入框的 Markdown 草稿编辑）、branch-menu.js（分支胶囊与分支 / Worktree 浮层）、
                                   command-panel.js（行内命令面板）、git-flow.js（/commit /push /undo /restore 的运行与结果）、run-modes.js（任务运行中的发送方式）、
                                   settings-apply.js（保存设置的统一反馈）、notifications.js（浏览器通知：权限与弹出）、context-usage.js（上下文用量、速度、缓存命中）、folder-picker.js、
                                   i18n.js / lang.js / locales/（界面语言）、panel-*.js、terminal-session.js（xterm.js 与服务端终端的连接：回放、输入、尺寸、断线后重新同步）、overlays-*.js、providers-page.js（Providers 页：列表、详情、API Key 管理）、provider-form.js（自定义 Provider 表单）、provider-models.js（表单的纯逻辑：Model ID 解析、检测结果写回）、model-menu.js（扁平可搜索的模型列表与 Effort 滑杆）、search.js（统一的搜索排序）、settings-menu.js（`/settings` 各行在 Web 里的打开方式和图标）、builtin-commands.js（内置斜杠命令在浏览器里的执行方式）、sidebar.js、chat-order.js（侧栏分组内的 Chat 排序）、app.js …
```

数据流：浏览器 → `POST /api/...`（命令）；服务端 → `GET /api/events`（SSE：`message_*`、`tool_*`、`usage`、`run_state`、`run_finished`、`task_notification`、`queue_update`、`dialogs`、`session_replaced`、`terminal_data`、`terminal_exit` 等）。客户端 `store.js` 用 `/api/state` 与 `/api/transcript` 做快照，断线重连后重新拉取。

终端的数据流：`POST /api/terminal/open`（Shell、列数、行数）返回该文件夹里这个 Shell 的终端——已有就返回它，没有就启动一个——连同它保留的输出（最近约 40 万字符）和一个序号；之后的输出通过 SSE `terminal_data`（带递增序号）到达，页面发现序号不连续或 SSE 重连后会重新取一次。`/api/terminal/input`、`/resize`、`/close` 按终端 id 操作，`GET /api/terminal/shells` 列出可用的 Shell。终端属于服务而不是某个 slot，所以这两个事件不带 `slot`，由 `web-mode.ts` 创建的 `WebTerminals` 直接广播，`store.js` 把它们原样交给正在显示的终端（`onTerminalEvent`），不进入状态。静态资源目录由 `getWebUiDir()`（`config.ts`）解析，源码、dist、Bun binary 三种布局都指向包根/可执行文件旁的 `web/`。

## 维护

* 前端没有构建步骤；改 `web/` 下的文件后刷新页面即可。
* 图标 + 文字的对齐只有一条规则（`css/base.css`）：这类控件都是 `align-items: center` 的 flex 行、固定 `gap`、整数像素行高；图标旁的 `+/-` 行数用 `text-box` 裁到数字本身的高度。Composer 底部的上下文用量（圆环 + 百分比）是和旁边的模型 / Effort 按钮同一种文字控件：同样的高度、字号和行高，所以圆环与其他图标在同一条中线上，百分比与其他文字在同一条基线上。新增同类控件沿用这条规则，不要逐个位置写偏移量。新增第三方前端库必须放进 `web/vendor/` 并更新 `THIRD_PARTY_NOTICES.md`。
* 尺寸、圆角和留白只有一套规范，数值都在 `css/tokens.css`，不要在各处另写数字：
  * 控件高度：带边框的控件（按钮 `.btn`、下拉 `.select`、输入框 `.field`）只有两档——常规 32px（弹窗、表单）和紧凑 28px（加 `.sm`；分段控件、Composer 的模型按钮、面板标签也是这一档），所以放在同一行时高度一致。只有图标的按钮是 32px，放在行内时 24px（`.icon-btn.sm`）。开关只有一种（`ui.js` 的 `Toggle`，`.toggle`）；命令面板的行本身就是可点的控件，行尾用同一个开关的外形（`<span class="toggle on">`）只显示状态。
  * 交互状态（`css/base.css`）：悬停亮一级（有边框的控件边线加深）、按下再深一级、键盘焦点用 `:focus-visible` 的轮廓（输入框显示在边框上）、禁用统一用 `--disabled-opacity`。新控件沿用这几条，不要各写一套。
  * 圆角按角色取 `--r-xs` … `--r-xl`（标记和菜单行、列表行、控件和浮层、卡片和两块主面板、弹窗和输入卡片），胶囊形（徽标、标签、开关）用 `--r-pill`。
  * 留白：侧栏里的行、按钮和搜索框都从 `--pad-side` 开始、到它结束，行尾的图标按钮（收起侧栏、添加工作区、工作区操作）在同一列；工作区下面代替对话列表的文字（提示、“再显示 n 个”）和对话标题左对齐。右侧面板里每一行（标签条、工具栏、Git 栏、文件列表、Diff 标题、各分组）的内容都从 `--pad-panel` 开始、到它结束，行尾的图标按钮向外挂 4px，让图标本身（而不是它看不见的点击区域）落在这条线上。卡片与卡片之间隔 14px：成组的卡片放进 `.stack`。
  * 不写静态的内联样式：间距、对齐、字号都用样式类（`.row`、`.col`、`.stack`、`.grow`、`.pre-wrap`、`.check-label` 等公共类，或该区域自己的类）；只有由数据算出来的值（进度条宽度、树的缩进、浮层位置、弹窗宽度、终端输出的颜色）才写在 `style` 里。
* 展开/折叠只有一种动效：区域高度用 `ui.js` 的 `Collapse`（grid 0fr→1fr，内容淡入淡出），箭头用 `.disclose`（指向右，展开时转四分之一圈）或 `Fold`（指向下，展开时翻转）；设置里的动画选 Off（或系统要求减少动效）时都不会动。新增可折叠区域沿用它们，不要各写一套。所有下拉（原生 `select` 和打开列表的按钮）画同一个箭头：按钮用 `ui.js` 的 `Chevron`，原生 `select` 用 CSS 变量 `--chev-img`，同样的 12px 描边、垂直居中、右侧留 10px。
* 右侧详情面板只能由 `app.js` 顶栏的按钮和快捷键通过 `actions.togglePanel` 打开、关闭或切换（面板自己的标签条和关闭按钮除外）；聊天、卡片、状态、命令和 Agent 事件都不要调用它，也不要自己 `setView({ panelOpen: true })`。
* 设置项的保存统一走 `settings-apply.js` 的 `saveSetting`（立即显示新值、慢保存才出现加载圈、失败时恢复并提示）；带单位的数字用 `ui.js` 的 `UnitField`（单位是固定后缀），不要给数字框再加一个可编辑的单位。
* 新增 API：在对应 `routes-*.ts` 里注册，调用现有领域模块；不要在路由里复制业务规则。路由里不要调用同步的 Git / 子进程（`runGitSync`、`execFileSync` 等）：Node 服务只有一个事件循环，一次同步 `git` 会让同时进来的所有请求（打开面板、切换 Session、设置）一起等待。常用接口（`/api/git/status`、`/api/git/log`、`/api/changes` 的 Working tree / diff）已改为 `runGitAsync` 并行执行。新增 SSE 事件：在 `host.ts` 转发，在 `web/js/store.js` 消费。
* Terminal 面板的伪终端来自可选依赖 `@lydell/node-pty`（预编译二进制，没有安装脚本），第一次打开终端时才加载（与剪贴板模块相同的两处查找位置）；缺少它或没有当前平台的二进制时，只有终端提示不可用，其余功能不受影响。结束 Shell 用项目自己的 `killProcessTree`，不调用 node-pty 的 `kill()`：后者会用当前可执行文件再启动一个辅助进程，只适合普通的 Node 进程。代价是已结束终端的 `conhost.exe` 会保留到服务退出（服务退出时随进程一起结束）。xterm.js 在 `web/vendor/`，第一次显示终端时才加载；终端的配色取自页面主题（`terminal-session.js`），切换主题时跟着变。
* wire 格式（`wire.ts`）只投影现有数据，不发明字段；前端不要伪造后端没有返回的状态。
* 对话模型的纯逻辑（`turns.js`、`diff-parse.js`、`util.js`、`provider-models.js`）、界面语言（`test/web-i18n.test.ts`）和上下文构成（`test/web-context-breakdown.test.ts`）有单元测试；`ExtensionMode` 现在包含 `"web"`，新增基于 mode 的 Extension 分支时要一并考虑。
* Web 偏好（主题、宽度、面板状态）存在浏览器 `localStorage`（按 origin，即端口区分）；它们不进入 `settings.json`。

## 验证

```powershell
npm.cmd --workspace @myharness/coding-agent test -- test/web-http-server.test.ts test/web-wire-changes-dialogs.test.ts test/web-frontend-logic.test.ts test/web-host.test.ts test/web-i18n.test.ts test/web-context-breakdown.test.ts test/web-lifecycle.test.ts test/web-folder-dialog.test.ts test/web-generation-speed.test.ts test/web-terminal.test.ts test/git-branches.test.ts test/thinking-probe.test.ts test/official-effort.test.ts test/custom-provider-manager.test.ts test/tools.test.ts
```

`thinking-probe.test.ts`、`official-effort.test.ts` 与 `custom-provider-manager.test.ts` 覆盖 Thinking Effort 的官方文档规则、探测和写回规则，`web-generation-speed.test.ts` 覆盖 t/s 和每次请求缓存命中的计算（含缓存命中的预估），`tools.test.ts` 覆盖 `write` / `edit` 返回的 `+N −M`。`web-host.test.ts` 使用真实的 `AgentSessionRuntime`（faux provider）通过 HTTP/SSE 走完整链路：prompt → 工具 → run_finished → Changes/diff（含 `usage` 推送、连续两轮任务各自的改动卡片及其 Diff）→ Files → Settings → Sessions → 直接 shell，以及任务结束通知（页面回答已弹出 / 不能弹出 / 不回答时系统弹窗的去向；系统弹窗在测试里被替换，不会真的弹出）和 Project Trust 决定的立即生效。`web-terminal.test.ts` 通过 HTTP 接口启动真实的 Shell（Windows 上是 CMD）：输出按序号到达、输入生效、再次打开得到同一个终端及其已有输出、调整尺寸、不同文件夹各有终端、重启 / 结束 / Shell 自己退出时的事件与退出码、同时运行数量的上限；它需要可选依赖 `@lydell/node-pty` 的当前平台二进制（Windows x64 上必须有，其他平台没有时跳过）。真实 Provider、浏览器渲染（包括 xterm.js 的显示与键盘输入）和 Windows 桌面行为需要单独运行验证。
