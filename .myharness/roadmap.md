# `.myharness` 后续开发边界

这是项目配置与运行时数据边界的候选方向，不是排期。实现前以 Settings schema、paths、migration 和实际消费者为准。

## 候选方向

- 为项目级与全局 Settings 建立字段、默认值、作用域和 migration 的机器可读索引。
- 为配置变更增加 schema 版本和兼容迁移，同时保持未知字段、旧配置和用户数据的安全处理。
- 为 Session、model store、Trace 和其他 data 目录补充路径诊断与脱敏状态说明。
- 为 Git integration、Provider 配置和工作区身份建立清晰的“配置存在 / 已加载 / 真实运行成功”证据区分。

## 验收要求

任何新字段都要有 schema、默认值、读取方、写入方、迁移策略、测试和文档；不能只添加 README 示例而没有实际消费者。
