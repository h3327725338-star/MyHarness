# System Prompts 后续开发边界

这是基于当前源码的候选方向，不是排期或已承诺功能。任何实现前都要重新检查 loader、composer、Prompt 测试和实际资源目录。

## 候选方向

- 建立静态 Prompt inventory 检查：发现 README 中不存在的文件、未说明的新增目录和模板变量漂移。
- 为替代目录、非法 UTF-8、控制字符、缺少变量和缺失文件补充更明确的测试矩阵。
- 给 Prompt 作用域和组合顺序增加可查询的诊断输出，同时继续脱敏用户路径、会话内容和凭据。
- 在不引入 watcher 或隐式回退的前提下，改善开发期重启/资源复制提示。
- 研究 Prompt 版本或迁移记录；任何版本字段必须与实际 loader 和缓存语义一起落地。

## 不能默认做的事

- 不能把 historical 文档或旧路径重新当作当前 Prompt 文件。
- 不能把 `/commit`、工具 schema、压缩 user message 或 Extension 自定义 Prompt 偷换成固定 system 文本。
- 不能把静态文件存在写成 Provider 请求、CLI 启动或跨平台打包已经成功。

## 验收要求

每项变更都要记录受影响资源、loader/composer 路径、测试命令、重启或真实请求是否验证，以及是否改变打包资源布局。
