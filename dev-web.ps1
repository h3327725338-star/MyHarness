# MyHarness Web UI 静默启动器（Windows，由 dev-web.cmd / dev-web.vbs 调用）
#
# 目标：从快捷方式启动 Web 模式后，不留下可见的 CMD / PowerShell 控制台窗口。
#   * 服务进程（dev.ps1 --web -> tsx -> node）以“无窗口”方式在后台运行，输出写入日志文件。
#   * 本脚本只负责：已有实例则直接打开浏览器；否则启动服务、等待它就绪，失败时弹出错误对话框。
#   * 服务由页面里的“退出 MyHarness”或 POST /api/shutdown 正常结束；结束时整棵进程树随之退出。
#   * 需要看控制台输出时，用 `dev-web.cmd --console`（保留原来的可见窗口方式）。
#
# 参数：其余参数原样转发给 MyHarness（例如 --port 7878、--no-open）。

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

$LogDir = Join-Path $Root "data\logs"
$OutLog = Join-Path $LogDir "web-launch.out.log"
$ErrLog = Join-Path $LogDir "web-launch.err.log"
$ReadyTimeoutSeconds = 180

function Show-Error([string]$Message) {
	# 没有控制台可以打印，所以用对话框把错误交给用户。
	try {
		Add-Type -AssemblyName System.Windows.Forms
		[void][System.Windows.Forms.MessageBox]::Show($Message, "MyHarness", "OK", "Error")
	} catch {
		# 连对话框都无法显示时，日志文件是最后的依据。
	}
}

function Get-Tail([string]$Path, [int]$Lines = 15) {
	if (-not (Test-Path -LiteralPath $Path)) { return "" }
	return ((Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue) -join "`n").Trim()
}

# 参数里的 --port 用于探测已有实例；其余参数只是转发。
$forward = @($args)
$port = 7878
for ($i = 0; $i -lt $forward.Count; $i++) {
	if ($forward[$i] -eq "--port" -and ($i + 1) -lt $forward.Count) {
		$parsed = 0
		if ([int]::TryParse([string]$forward[$i + 1], [ref]$parsed)) { $port = $parsed }
	}
}
$noOpen = $forward -contains "--no-open"

function Test-ExistingInstance([int]$Port) {
	try {
		$response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
		return ($response.Content -match "MyHarness")
	} catch {
		return $false
	}
}

if ($port -ne 0 -and (Test-ExistingInstance $port)) {
	if (-not $noOpen) { Start-Process "http://127.0.0.1:$port/" }
	exit 0
}

try {
	New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
	Remove-Item -LiteralPath $OutLog, $ErrLog -Force -ErrorAction SilentlyContinue

	$devScript = Join-Path $Root "dev.ps1"
	$startArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $devScript, "--web") + $forward
	$process = Start-Process -FilePath "powershell.exe" -ArgumentList $startArgs -WorkingDirectory $Root `
		-WindowStyle Hidden -PassThru -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
} catch {
	Show-Error "MyHarness 无法启动：$($_.Exception.Message)"
	exit 1
}

# 等待服务打印 “MyHarness Web UI: <url>”（首次运行可能先执行 npm install，所以超时较长）。
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
	if ((Get-Content -LiteralPath $ErrLog -Raw -ErrorAction SilentlyContinue) -match "MyHarness Web UI: http") {
		$ready = $true
		break
	}
	if ($process.HasExited) { break }
	Start-Sleep -Milliseconds 300
}

if ($ready) { exit 0 }

$detail = (Get-Tail $ErrLog) + "`n" + (Get-Tail $OutLog)
if ($process.HasExited) {
	$reason = "启动进程已退出（退出码 $($process.ExitCode)）。"
} else {
	# 超时：不留下悬空的隐藏进程。
	& taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
	$reason = "等待 $ReadyTimeoutSeconds 秒仍未就绪，已停止启动进程。"
}
Show-Error ("MyHarness Web UI 没有启动成功。`n$reason`n`n" + $detail.Trim() + "`n`n完整日志：`n$OutLog`n$ErrLog")
exit 1
