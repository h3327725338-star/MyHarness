# RPC mode（已移除）

当前版本的 CLI 不提供 `--mode rpc`，源码中也没有可用的 RPC server、RPC client 或 RPC command protocol。旧版 RPC 文档已从可用说明中移除，避免用户按照不存在的命令启动程序。

现在应按用途选择：

- 需要进程内集成：使用 SDK 中的 `AgentSession` 和 `AgentSessionRuntime`，参阅 [SDK 文档](sdk.md)。
- 需要通过标准输入输出消费结构化事件：使用 `--mode json`，参阅 [JSON mode](json.md)。
- 需要普通命令行输出：使用 `--mode text`、`--print` 或默认交互模式，参阅 [Usage](usage.md)。

如果未来重新引入 RPC，应先建立当前源码、协议版本、命令集合和兼容性测试，再单独发布协议文档；本文件不再描述历史实现。
