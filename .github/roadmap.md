# `.github` 后续开发边界

这是 CI 与协作自动化的候选方向，不是排期或已执行的远端变更。

## 候选方向

- 保持正式 `ci.yml` 的 `windows-2022` / `windows-2025` runner label 和关键命令一致性检查；辅助 workflow 的平台变化必须单独记录，不改变正式 CI baseline。
- 为 docs-only 变更提供不触发外部 Provider、发布或 binary 构建的最小验证路径。
- 让 workflow 对 lockfile、shrinkwrap、package exports 和 generated assets 的差异给出更直接的失败原因。
- 收紧 artifact、日志和第三方 action 的权限与敏感信息过滤。
- 为 release/binary workflow 补充可复现产物、版本来源和回滚记录。

## 验收要求

每项 workflow 变化都要有 YAML 静态证据、对应脚本证据和（如声称运行成功）实际 GitHub run 链接或日志；本地通过不能替代远端验证。
