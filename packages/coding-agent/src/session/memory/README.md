# 长期记忆存储

`store.ts` 管理当前 Data root 下的 global / Workspace / Conversation Markdown、archive、引用索引、迁移和恢复。Agent runtime 的 `auto-memory.ts` 负责模型请求和 recall selection，不由 store 调用 Provider。

查询使用 `listMemoryFilesAsync(dataRoot, { workspaceId?, sessionId? })`，在遍历前限定目录范围，不先读全树再过滤；全局查询同样异步读正文。同步扫描可给 `listMemoryFiles` 传入 `metadataCache`，按 mtime/ctime/size/inode 复用 id/name，不保留正文，删除文件时移除缓存。每次遍历独立复用祖先路径检查，不跨请求跳过 symlink/junction 校验。

正文按归属只存一份；全局和 Workspace 索引只引用文件。自动 Recall 不调用全树汇总查询，不加载 archive、pending、兄弟对话或其他 Workspace；跨项目与 pending 可见性只走工具（`memory_search` / `memory_get`）与 `readCrossScopeMemoryEntries`，且只读。删除聊天默认保留其 memory 目录（确认框勾选才连带清除）；移除工作区仍只取消登记。

彻底删除（`deleteMemoryPermanently`）连正文带全部归档一起清除、刷新索引，不可恢复；归档文件本身不许直接删。更新和整理替代前仍先保存完整旧文件到同层 archive；恢复先归档当前版本，不删除恢复来源。认领（`claimPendingMemory`）把 `pending/` 条目搬进目标工作区并重写归属 id，是一次移动而非复制。所有写入、删除、认领与恢复拒绝 symlink/junction，并使用 Data memory lock；索引可重建。旧 Agent memory 按来源标记复制迁移，原文件不删除，匹配不唯一的 project 进入 pending。更改归属、保留规则或迁移格式时同步 STORAGE/settings/web-ui，并运行 auto-memory、memory-storage、memory-intelligence、session-artifacts 测试。
