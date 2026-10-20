# sync/ — Google Drive 同步

## 说明

### 职责

把 MyHarness 中需要跨设备共享的数据同步到用户自己的 Google Drive，并在另一台设备安全合并回来。传输只负责字节；哪些数据属于同步范围、如何合并、删除如何表达，都由本目录的数据适配层决定，不复制整个 Data root，也不把内部状态文件整套覆盖。

### 文件

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 同步协议：实体种类、版本向量、记录、批次、墓碑、冲突、本机状态、状态快照、`DrivePort` 窄接口 |
| `util.ts` | SHA-256、原子 JSON 写、0600 私有写、版本向量比较/合并、稳定 JSON、字节与文本转换 |
| `store.ts` | 本机持久化：`<agentDir>/sync/config.json`、按账号隔离的 `state-<hash>.json`、`credentials.json`（0600）、备份与恢复副本 |
| `scope.ts` | 扫描同步范围：全部记忆（含归档、pending）、通用模式工作区/会话/附件/产物/资料/工具结果、通用个人指令与草稿 |
| `apply.ts` | 应用远端内容：记忆写入（memory 锁）、会话 JSONL 按 entry id 合并、文件原子写、工作区身份导入与本机绑定、草稿/指令写入、显式删除 |
| `engine.ts` | 同步引擎：拉取→推送、批次发布、对象上传/校验、版本向量判定、墓碑、冲突保留、活动会话延期、后台定时与文件监听、引擎锁 |
| `google.ts` | Google OAuth（桌面应用 + PKCE + loopback）与 Drive v3 客户端（可见 `MyHarness` 文件夹、`sync-v1` 布局、multipart 上传、媒体下载） |
| `service.ts` | Web 进程内的同步服务：配置、账号切换、OAuth 流程、引擎重建与生命周期 |

### 云端布局

```text
MyHarness/
├─ README.txt
└─ sync-v1/
   ├─ identity.json
   ├─ batches/<batchId>.json
   ├─ objects/<sha256>
   └─ snapshots/
```

`batches/` 是只追加的提交日志；每个批次先上传所有对象，再发布清单。`objects/` 按内容哈希去重。删除是批次中的显式操作，附版本向量与删除时间，不靠“这轮没列出”推断。`identity.json` 的 `syncId` 标识同步空间；文件夹改名后仍按 Drive 文件 ID 跟随，不按名字重新建库。

### 本机状态

`<agentDir>/sync/` 不属于 Data root，因此不会被同步本身上传：

- `config.json`：设备 ID/名称、开关、暂停、OAuth client id 与 client secret、云端文件夹与账号标签；
- `state-<account hash>.json`：每个 Google 账号独立的版本向量、墓碑、已应用批次、待绑定工作区、冲突、无法自动解决的问题；
- `credentials.json`：OAuth 令牌，0600 原子写；
- `backups/`、`recovered/`：覆盖前的本机版本与未应用的另一版，按 key 保留最近 20 份。

“待上传队列”就是“磁盘现状与已提交状态的差”：批次成功写入云端后才推进 `entities`/`tombstones`，崩溃后重新扫描会重建同一批操作，重复投递因内容哈希与版本向量而幂等。批次按 500 条操作切分发布（接收端上限 5000）；同一设备自己发布的批次到达时只记为已处理、不再重放，避免与本机状态打架。

### 对外接口

`service.ts` 的 `SyncService` 是 Web 层唯一入口：`status()`、`updateConfig()`、`connect()`、`disconnect()`、`runNow()`、`bindWorkspace()`、`start()`、`dispose()`。同步引擎本身可由测试直接构造：`new SyncEngine({ agentDir, dataRoot, deviceId, deviceName, store, accountKey })` 后 `setDrive()` + `runOnce()`。

### 依赖

- 依赖：`config/paths`、`data/workspace-store.ts`（工作区身份导入与绑定）、`session/mode-state.ts`（通用指令与草稿）、`session/memory/store.ts`（记忆锁、归档与索引）、`session/storage/jsonl`（会话头与条目解析）、`utils/atomic-write`、`utils/open-browser`。
- 被依赖：`modes/web/web-mode.ts`（创建服务、注册路由、关闭时释放）、`modes/web/routes-sync.ts`。
- 不依赖：Agent runtime、模型调用、工具执行。应用远端内容只写文件与状态，不触发模型、记忆提取或命令执行。

## 维护

- 只同步数据含义，不整目录复制：新增数据类型时先判断它属于记忆、会话、文件、工作区、草稿还是指令，再改 `scope.ts` 的扫描与 `apply.ts` 的应用；不要并入“全部文件”。
- 编程模式聊天不上传；编程模式记忆通过记忆扫描上传。改动扫描门槛时必须保持这个边界。
- 删除必须是显式批次操作；墓碑永远保留“已删除”事实，旧设备重新上线不能把内容带回来。并发删除与编辑两侧都保留，不能静默丢一边。
- 冲突不阻塞同步：会话合并分支，其余类型保留本机版本 + 另一版副本 + 冲突列表。不要在“无法判断”时自动选一个版本删掉另一个。
- 云端对象先到、批次后到；缺对象时整批延期，不能应用半批。应用前校验 SHA-256。延期超过若干轮后要在 `<agentDir>/sync/state-*.json` 的 `issues` 中报告并停止重试，不能无限循环；损坏批次、超大文件、非法记录同理，一条坏数据不能拖住其他同步。
- Data root 若位于 Google Drive/OneDrive 等同步目录，引擎拒绝启动并提示迁移，避免双重管理。
- 工作区恢复只创建受管理占位目录并标记待绑定；不得因为远端记录里的绝对路径在本机存在就自动写进去。扫描以工作区注册表为准：被用户从所有列表移除的工作区不再上传，重新加入后才继续同步。
- OAuth 使用 `drive.file`（只能访问应用创建/用户明确交给应用的文件），不要升级为全盘权限；令牌只落本机 0600 文件，不能进入日志、聊天或同步内容。
- 账号切换按账号隔离协议状态；切换账号时清空 folder/sync 指针并要求重新连接。
- 相关测试：`test/google-drive-sync.test.ts`（假 Drive、双设备恢复、分支合并、删除不复活、并发冲突保留、草稿与指令、缺对象延期、批次不重放、大变更集分批、自身批次忽略、非法身份拒绝、损坏批次与缺失对象上报、归档标记、移除工作区不再发布）。
