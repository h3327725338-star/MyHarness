# AI / Provider 维护手册

## 依赖方向

`models.ts` 维护 Provider collection、auth resolution、model lookup、refresh、login/logout 和 stream delegation；具体 API payload 在 `api/`；auth contract 在 `auth/`；兼容旧接口在 `compat.ts` 和显式 subpath。不要让 `providers/all.ts` 变成产品层 Provider 注册表。

## Provider contract

一个 Provider 必须有 `id`、`name`、auth、`getModels()`、stream/streamSimple；动态 Provider 可实现 `refreshModels()`。`Models` 负责：

- Provider 注册和唯一 ID；
- provider-scoped credential/header resolution；
- synchronous last-known model read；
- explicit refresh 的 network/cache/cancel/error 结果；
- login/logout 和 stream/complete delegation。

静态模型读取不能被写成“远程目录一定最新”。Provider refresh 失败时要保留已有列表并暴露错误。

## 当前 catalog 规则

修改 `providers/all.ts`、`models.generated.ts` 或 image catalog 时，必须确认是否仍为空 fork compatibility entrypoint。不要只看到 `getBuiltinModel()` 就推断有真实 catalog；它返回的是带 `example.invalid` base URL 的兼容 descriptor。

## 测试与命令

```powershell
npm.cmd --workspace packages/ai run test
npm.cmd --workspace packages/ai run build
npm.cmd --workspace packages/ai run build:offline
```

重点测试位于 `packages/ai/test/models-runtime.test.ts`、`providers.test.ts`、`faux-provider.test.ts`、`myharness-messages.test.ts` 和 system prompt loader 测试。未实际运行时，不得把这些测试写成通过。

## Auth 和安全

- credential store 的 secret 只能通过受控 read/modify/delete 路径处理；日志只写 provider ID、类型和脱敏来源。
- OAuth refresh 使用 credential store 的串行修改语义，失败不能静默 fallback 到另一个 credential。
- `oauth`、`bun-oauth` 和 `auth/oauth` 当前主要提供 contract/通用工具；具体 Provider OAuth flow 需要明确由 extension 或其他宿主注册。
- 直接调用 API implementation 会绕过 Provider auth；文档示例必须明确这一点。
