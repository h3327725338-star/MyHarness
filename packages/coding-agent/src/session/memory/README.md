# 长期记忆存储

`store.ts` 管理当前 Data root 下的 global / Workspace / Conversation Markdown、archive、引用索引、迁移和恢复。Agent runtime 的 `auto-memory.ts` 负责模型请求和 recall selection，不由 store 调用 Provider。

正文按归属只存一份；全局和 Workspace 索引只引用文件。Recall 不调用全树汇总查询，不加载 archive、pending、兄弟对话或其他 Workspace。删除聊天保留其 memory 目录；移除工作区仍只取消登记。

更新和整理替代前保存完整旧文件到同层 archive。恢复先归档当前版本，不删除恢复来源。所有写入与恢复拒绝 symlink/junction，并使用 Data memory lock；索引可重建。旧 Agent memory 按来源标记复制迁移，原文件不删除，匹配不唯一的 project 进入 pending。更改归属、保留规则或迁移格式时同步 STORAGE/settings/web-ui，并运行 auto-memory、memory-storage、session-artifacts 测试。
