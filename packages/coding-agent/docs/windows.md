# Windows 设置

MyHarness 在 Windows 上需要 Bash shell。程序会按以下顺序检查：

1. `~/.myharness/agent/settings.json` 中配置的 custom path；
2. Git Bash（`C:\Program Files\Git\bin\bash.exe`）；
3. PATH 中的 `bash.exe`（Cygwin、MSYS2 或 WSL）。

对大多数用户来说，安装 [Git for Windows](https://git-scm.com/download/win) 就足够了。

## 自定义 Shell 路径

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
