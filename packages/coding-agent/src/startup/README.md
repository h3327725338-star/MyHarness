# startup/ — Web 启动与命令协议

本目录保留 Web 服务需要的启动参数、初始消息处理和浏览器命令注册表，不提供终端聊天界面。

| 文件 | 职责 |
| --- | --- |
| `args.ts` | Web 服务启动参数；公开 `Args` 和 `parseArgs` |
| `help.ts` | Web 启动帮助；由 `web-startup-help.test.ts` 验证 |
| `file-processor.ts` | `@file` 文本、图片和富文档输入 |
| `initial-message.ts` | 合并初始消息和附件；SDK 输入兼容保留 |
| `project-trust.ts` | 将启动阶段信任询问交给浏览器 |
| `slash-commands.ts` | Web 斜杠命令唯一注册表和解析 |
| `settings-menu.ts` | 浏览器 `/settings` 菜单定义 |

Node 进程入口为 `src/web.ts`，Bun 入口为 `src/bun/web.ts`。`main.ts` 负责装配运行时。
旧终端输出参数不再作为核心参数解析；未知参数仍通过扩展参数校验处理。

维护时同步参数帮助与相关测试。不要在本目录实现模型请求、会话持久化或 Git 规则。
