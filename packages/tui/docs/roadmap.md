# TUI 后续开发边界

## 组件与交互

新增组件应复用现有 Component、Focusable、Editor、SelectList、Overlay 和 width utilities。组件只表达终端 UI 行为，不直接访问 Provider、Session、Git 或用户 credential。

## 渲染

继续以 differential rendering 为中心，分别处理 viewport、resize、content diff、cursor 和 Kitty image ranges。任何优化都必须保持全量重绘 fallback。

## 平台

终端能力探测、native modifier/console mode 和 ANSI 写入保持在 TUI 的 terminal/platform 边界；不要让 Coding Agent 的 Windows 特例散落进通用 component。

## 验收条件

- Node test runner 覆盖新增组件的渲染、宽度、输入、invalidate 和取消/关闭路径；
- 有必要时增加真实 terminal smoke，但把 emulator/native 结果单独记录；
- 不把“源码可构建”写成“所有终端都已验证”。
