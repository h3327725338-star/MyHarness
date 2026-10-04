# bun/ — Bun 单文件二进制入口

## 说明

### 职责

只服务于 `npm run build:binary` 生成的 Bun 编译产物（`dist/myharness`）。普通 Node CLI 不经过这里。

| 文件 | 内容 |
| --- | --- |
| `web.ts` | Bun Web 进程入口：注册 OAuth 占位、恢复环境变量、注册 Bedrock，再加载 `src/web.ts` |
| `register-bedrock.ts` | 把 `@myharness/ai/bedrock-provider` 注册给 lazy Bedrock API |
| `restore-sandbox-env.ts` | `restoreSandboxEnv()`：Bun 二进制在沙箱里 `process.env` 为空时，从 `/proc/self/environ` 恢复 |

### 依赖

- 依赖：`src/web.ts`、`src/config.ts`、`@myharness/ai/bedrock-provider`、`@myharness/ai/bun-oauth`。
- 被依赖：无（只作为构建入口）。

## 维护

- Bun 专用的适配只放这里，不要让普通 Node 启动路径依赖本目录。
- 二进制的资源路径（主题、模板、`system-prompts`）由 `src/config.ts` 中的 `isBunBinary` 分支决定；改构建产物布局时两处一起改，并同步 `package.json` 的 `copy-binary-assets`。
- 静态检查不能证明二进制可用；真实启动要单独运行并单独报告。
- 相关测试：`restore-sandbox-env.test.ts`。
