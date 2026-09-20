# AI / Provider 后续开发边界

本文件是当前源码基础上的候选方向，不是 Provider 数量或 OAuth 支持承诺。

## Provider registration

继续沿用 `createProvider()`、`Models.setProvider()`、Coding Agent 的 `models.json` 和 extension/native Provider registration。新增 Provider 时必须同时说明：API implementation、model metadata、auth 类型、refresh 策略、headers/compat 和持久化边界。

## Dynamic catalog

为动态 Provider 增加 refresh、cache restore、offline、abort、stale data 和 failure tests。模型 store 只保存可恢复的 catalog metadata，不保存 secret。

## API layer

新增 API implementation 应保持 `stream`/`streamSimple` 形状，复用 lazy wrapper、消息转换、错误分类和 header transform；不要在 API 文件中偷偷注册全局 Provider。

## OAuth

若以后接入具体 OAuth flow，应明确实现归属、Node/Bun/browser 边界、token persistence、refresh locking、re-login 和测试环境。仅新增类型或 loader 不等于新增可登录 Provider。

## 验收条件

- package exports、README 和 compatibility 文档准确反映实际入口；
- Provider 未注册、未认证、刷新失败和请求失败可区分；
- unit test、fake provider test、真实网络测试（如有）分开报告；
- 不恢复一个与当前 MyHarness 设计冲突的“36 个内置 Provider”文字描述。
