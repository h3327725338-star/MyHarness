# Windows 设置

MyHarness 在 Windows 上需要 Bash shell。程序会按以下顺序检查：

1. `~/.myharness/agent/settings.json` 中配置的 custom path；
2. Git Bash（`C:\Program Files\Git\bin\bash.exe`）；
3. PATH 中的 `bash.exe`（Cygwin、MSYS2 或 WSL）。

对大多数用户来说，安装 [Git for Windows](https://git-scm.com/download/win) 就足够了。

Agent 的 bash/pwsh 工具和 Web 终端拿到的 PATH，除了服务进程启动时带的那份，还会补上注册表里
（系统和当前用户）此刻的 PATH 条目，排在原有条目之后：MyHarness 运行期间新装的工具不用重启就能找到；
应用被某个只带精简 PATH 的进程启动时，用户自己的条目（例如 Python、MinGW 的 `g++`）也不会丢。
注册表每分钟最多在后台重读一次；`reg.exe` 无法原样输出的非 ASCII 条目会被跳过。

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
