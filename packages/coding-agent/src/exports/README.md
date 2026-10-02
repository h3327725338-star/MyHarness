# exports/ — 会话导出

## 说明

### 职责

把一个会话导出成可以离线查看的文件。这里的“exports”指导出功能，与 npm 的 `package.json` exports 无关。

### html/

| 文件 | 内容 |
| --- | --- |
| `index.ts` | `exportSessionToHtml()`、`exportFromFile()`：把会话条目、主题颜色和模板拼成单个 HTML |
| `session-export.ts` | `exportAgentSessionToHtml()`：`AgentSession.exportToHtml()` 调用的入口，负责取主题和工具渲染器 |
| `tool-renderer.ts` | 自定义工具的 HTML 渲染：调用工具的终端渲染器，再把 ANSI 转成 HTML |
| `ansi-to-html.ts` | ANSI 颜色/样式转 HTML |
| `template.html` / `template.css` / `template.js` | 导出页面模板（构建时复制到 `dist/exports/html/`） |
| `vendor/` | 模板用到的第三方脚本（构建时复制） |

### jsonl/

`session-export.ts`：`exportSessionBranchToJsonl()`，把当前分支导出成一个线性的 JSONL 文件（会话头 + 分支上的条目，`parentId` 重新串成一条链）。

### 依赖

- 依赖：`session`（manager、类型）、`modes/interactive/theme`（取颜色）、`tools/presentation`（工具渲染器）、`extensions/compat`（工具定义类型）、`src/config.ts`（模板目录）。
- 被依赖：`agent/runtime`（`exportToHtml`、`exportToJsonl`）、`main.ts`（`--export`）。

## 维护

- 导出只读会话，不能改变 Session 内容或工具执行契约。
- 会话内容来自用户和模型，写入 HTML 前必须转义；`export-html-xss.test.ts` 覆盖这一点。
- 模板和 `vendor/` 不是 TypeScript 产物，新增文件要同步 `package.json` 的 `copy-assets` / `copy-binary-assets`。
- 相关测试：`export-html-*.test.ts`、`theme-export.test.ts`、`regressions/5596-missing-theme-export.test.ts`。
