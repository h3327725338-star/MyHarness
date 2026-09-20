# TUI 维护手册

## 分层

- `Component`：渲染行、输入处理、invalidated 状态。
- `Container`：管理 child 和组合渲染。
- `TUI`：连接 Terminal、focus、overlay、viewport、cursor 和 differential rendering。
- `components/`：可复用的 editor、list、markdown、loader、image 等组件。
- Coding Agent 的 `modes/interactive`：产品交互编排；不要把产品业务反向放入 TUI package。

## 不可破坏的行为

- `render(width)` 返回的每一行必须满足宽度/ANSI 处理约束。
- 状态变化后调用 `invalidate()`，不要直接操控 TUI 的内部 render cache。
- overlay 必须通过 `OverlayOptions`/`OverlayHandle` 管理尺寸、锚点、偏移、可见性和 capture 行为。
- terminal/native capability 变化要保留没有 native helper 时的 fallback。
- differential rendering、Kitty image area、硬件 cursor 和 resize 逻辑要分别测试。

## 命令与测试

```powershell
npm.cmd --workspace packages/tui run test
npm.cmd --workspace packages/tui run build
```

测试使用 Node test runner；测试文件覆盖 editor/input、autocomplete、keybindings、markdown、overlay、terminal/image、render/shrink、width 和回归场景。真实终端、Windows native helper 和各终端 emulator 不会由静态检查自动证明。

## 修改建议

先读 `src/index.ts`、`src/tui.ts`、相关 component 和测试，再修改。公共 API、native prebuild 路径、ANSI 输出和终端输入行为变化时同步 README、维护手册和产品 TUI 文档。
