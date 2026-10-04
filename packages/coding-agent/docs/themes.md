# Web 外观与旧 Theme 数据

浏览器外观通过 Settings → Appearance 设置，使用 Web 页面自身的样式，不提供终端 Theme 渲染 API。

已有 Settings、包资源清单与用户 Theme JSON 文件的读取兼容仍保留。它们不控制 Web 配色，也不应在清理终端入口时删除或覆盖。新扩展不能依赖终端 Theme、ANSI component 或 Tool terminal render callbacks。

HTML 导出使用独立 CSS palette；旧 `themeName` 输入只兼容接收，不会恢复终端渲染。参见 [Web UI](web-ui.md) 和 [Extensions](extensions.md)。
