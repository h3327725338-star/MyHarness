# AI / Provider 文档索引

`@myharness/ai` 提供 `Models`、`Provider`、API stream、auth/credential、dynamic model store、image model contract 和工具类型。

## 当前实现入口

- 公共根入口：`packages/ai/src/index.ts`。
- Provider/Models runtime：`packages/ai/src/models.ts`。
- Provider compatibility entrypoint：`packages/ai/src/providers/all.ts`。
- API implementations：`packages/ai/src/api/`。
- auth/credential/OAuth contract：`packages/ai/src/auth/`。
- dynamic model persistence：`packages/ai/src/models-store.ts`。
- test provider：`packages/ai/src/providers/faux.ts`。
- 按目录的源码说明与维护规则：[src/README.md](../src/README.md)。

## 最重要的当前事实

本 fork 不打包上游 Provider factories 或 generated model catalog：`getBuiltinProviders()`、`getBuiltinModels()`、`builtinProviders()` 和 image 对应入口返回空集合；`builtinModels()`/`builtinImagesModels()` 只创建空 collection。`getBuiltinModel()` 只是 legacy model-shaped descriptor，不会注册 Provider、认证或网络能力。

因此：

- library 使用者应调用 `createModels()` + `createProvider()`，再 `setProvider()`；
- Coding Agent 使用 `models.json`、模型 store、credential 和 extension/native Provider registration；
- API implementation 存在不等于 Provider 已注册；
- OAuth 类型和通用 refresh contract 存在不等于本 fork 已提供上游 OAuth Provider flow。

## 现有说明

- [AI README](../README.md)：API、Provider、auth、stream、tool 和 compatibility 说明。
- [维护手册](maintenance.md)：公共 contract、测试和发布边界。
- [后续开发](roadmap.md)：Provider/API/auth 的候选方向。
- [Coding Agent Provider 文档](../../coding-agent/docs/providers.md)：产品层配置和模型运行时。

## Usage 统计约定

`Usage.input` 是不含缓存命中与缓存写入的普通输入；总输入为 `input + cacheRead + cacheWrite`。OpenAI 兼容接口按 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、顶层 `cached_tokens` 的优先级读取缓存命中；`prompt_tokens` 已含缓存，DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 分别表示命中与未命中，不能再把命中加到完整 prompt 上。`output` 已含报告的 reasoning Token，费用不再次加上 reasoning。

可选的 `Usage.reported` 分别记录 input、output、cacheRead、cacheWrite 是否由上游有效数值确认；算术字段保留原有数字类型，缺项不再被展示层当成实测零。旧记录未带标记时，零值无法证明已上报。该字段为兼容性追加，不改变原有计费计算。

可选的 `Usage.totalReported` 表示完整总数来自上游有效总数或完整输入/输出计数，不是缺项分桶的简单求和；展示层可据此用总数减输出确定完整输入，在缓存写入字段缺失时仍计算可靠命中率。

可选的 `Usage.cacheReported` 表示接口明确返回了缓存计数（包括零）；缺省仍兼容旧 Session，不能将缺少字段当作实测零。费用按当前模型配置的每百万 Token 单价、每次请求的完整输入阶梯计算，不使用 Session 累计输入判阶梯。

## 客户端请求计时

可选的 `AssistantMessage.requestDurationMs` 保存客户端 API 全程耗时（毫秒）。目前 `openai-completions` adapter 使用 `performance.now()`，在调用 SDK 前开始、消费完响应流后结束。包含首字等待、网络、SDK 处理及配置的 SDK 内部重试，不是服务器纯生成耗时；不包含调用前的 payload hook、Agent 消费、持久化或 Web 展示。其他 adapter 尚未接入时不应虚构计时。

## 运行时证据

源码和 package manifest 可以证明导出与静态行为；不能单独证明外部 API、OAuth、网络 model refresh 或真实请求成功。此类结论必须附实际运行日志/测试结果，并脱敏。
