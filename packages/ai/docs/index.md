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

## 运行时证据

源码和 package manifest 可以证明导出与静态行为；不能单独证明外部 API、OAuth、网络 model refresh 或真实请求成功。此类结论必须附实际运行日志/测试结果，并脱敏。
