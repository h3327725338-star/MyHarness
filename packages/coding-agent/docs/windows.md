# Windows 设置

MyHarness 在 Windows 上需要 Bash shell。程序会按以下顺序检查：

1. `~/.myharness/agent/settings.json` 中配置的 custom path；
2. Git Bash（`C:\Program Files\Git\bin\bash.exe`）；
3. PATH 中的 `bash.exe`（Cygwin、MSYS2 或 WSL）。

对大多数用户来说，安装 [Git for Windows](https://git-scm.com/download/win) 就足够了。

MyHarness 的用户平台是 Windows 桌面 x64。GitHub Actions 的正式 CI baseline 使用
`windows-2022` 和 `windows-2025` 两个 Windows Server x64 runner；它们只表示
自动化 workflow 在这两个环境中的验证，不表示 MyHarness 只支持 Windows Server，
也不表示已经逐一验证 Windows 10/11 的每个桌面版本。

## 自定义 Shell 路径

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
