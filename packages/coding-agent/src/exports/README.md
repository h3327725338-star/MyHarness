# exports/ — 会话导出

## 说明

### 职责

把一个会话导出成可以离线查看的文件。这里的“exports”指导出功能，与 npm 的 `package.json` exports 无关。

### html/

| 文件 | 内容 |
| --- | --- |
| `index.ts` | 旧静态模板导出：`exportSessionToHtml()`、`exportFromFile()`（CLI `--export` 仍用它）。把会话条目、独立暗色 palette 和模板拼成单个 HTML；`themeName` 仅兼容接收 |
| `session-export.ts` | `exportAgentSessionToHtml()`：`AgentSession.exportToHtml()` 调用的旧模板入口（只传会话与输出路径，不传主题和工具渲染器） |
| `replay/` | Web UI 导出（`GET/POST /api/sessions/export`）用的自包含回放页组装：`build.ts`（`buildReplayHtml()`：打包前端、内嵌投影数据与完整原始 JSONL、写入响应前做无外部引用自检）、`bundle-frontend.ts`（导出时在服务端运行时把 `web/` 前端打包成 importmap + 内联模块/样式）、`project.ts`（会话投影，与 `modes/web` 共用 `entriesToWire`）、`routes.ts`（内嵌路由表）、`shell.ts`（回放外壳与只读强化）、`scan-imports.ts`（自研 import 扫描器）、`limits.ts`（体积上限 `EXPORT_MAX_JSONL_BYTES` = 30 MiB，超限抛 `ReplayExportTooLargeError`，路由返回 HTTP 413） |
| `template.html` / `template.css` / `template.js` | 旧导出页面模板（构建时复制到 `dist/exports/html/`），仅 CLI 旧导出使用 |
| `vendor/` | `marked.min.js` / `highlight.min.js`：旧模板与回放页内嵌共用；Web UI 运行时也通过 `/vendor-md/` 从这里挂载同一份文件 |

### jsonl/

`session-export.ts`：`exportSessionBranchToJsonl()`，把当前分支导出成一个线性的 JSONL 文件（会话头 + 分支上的条目，`parentId` 重新串成一条链）。

### 依赖

- 依赖：`session`（manager、类型）、`modes/web`（`wire.ts` 的 `entriesToWire` 等投影逻辑）、`observability`（`collectSessionUsageStats` 会话统计）、`extensions/compat`（工具定义类型）、`src/config.ts`（模板目录与 `getWebUiDir` 的前端目录）。
- 被依赖：`agent/runtime`（`exportToHtml`、`exportToJsonl`）、`main.ts`（`--export` 走旧模板）、`modes/web/routes-sessions.ts`（`/api/sessions/export` 走 `replay/build.ts`）。

## 维护

- 导出只读会话，不能改变 Session 内容或工具执行契约。回放页始终内嵌完整原始 JSONL，不静默裁剪；超过 `EXPORT_MAX_JSONL_BYTES`（30 MiB）时抛错，由路由返回 HTTP 413。
- 会话内容来自用户和模型，写入 HTML 前必须转义；`export-html-xss.test.ts` 覆盖旧模板这一点，`export-replay-build.test.ts` 覆盖回放页的转义与无外部引用自检。
- 模板和 `vendor/` 不是 TypeScript 产物，新增文件要同步 `package.json` 的 `copy-assets` / `copy-binary-assets`。`replay/` 不需要复制：它在导出时直接读取包内的 `web/` 前端与 `vendor/` 文件。
- 相关测试：旧模板 `export-html-*.test.ts`；回放页 `export-replay-*.test.ts`（打包器、组装、投影、体积上限）与 `web-export-replay-*.test.ts`（前端只读钩子、浏览器端到端）。
