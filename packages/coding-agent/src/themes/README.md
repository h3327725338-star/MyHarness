# themes/ — 主题资源加载

## 说明

### 职责

把主题 JSON 文件加载并校验成 `ThemeResource`。这是旧持久化资源的兼容层，不提供终端 Theme 渲染，也不控制浏览器外观。

### loader/

| 文件 | 内容 |
| --- | --- |
| `theme-resource.ts` | 主题 JSON 的 schema、变量引用解析、颜色回退、名称校验、从路径加载 |
| `index.ts` | `loadThemeResources()`：从全局、项目和显式路径加载并去重，产生诊断 |

### 依赖

- 依赖：`src/config.ts`、`extensions/contracts`（诊断、`SourceInfo`）、`utils/paths.ts`。
- 被依赖：`application/resource-loader.ts`、`src/index.ts`。

## 维护

- 本目录不依赖 `modes/interactive` 的 `Theme` 类；资源到终端主题的转换由界面一侧完成。
- 新增颜色键时要提供回退值，旧主题文件不能因此加载失败。
- 项目级主题是否加载由 `application/resource-loader.ts` 按 Project Trust 决定。
- 用户文档：`docs/themes.md`。相关测试：`theme-picker.test.ts`、`theme-detection.test.ts`、`theme-export.test.ts`。
