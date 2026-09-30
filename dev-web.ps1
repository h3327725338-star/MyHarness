# MyHarness Web UI 静默启动器（Windows，由 dev-web.cmd / dev-web.vbs 调用）
#
# 目标：从快捷方式启动 Web 模式后，不留下可见的 CMD / PowerShell 控制台窗口。
#   * 服务进程（dev.ps1 --web -> tsx -> node）以“无窗口”方式在后台运行，输出写入日志文件。
#   * 本脚本只负责：已有实例则直接打开浏览器；否则启动服务、等待它就绪，失败时弹出错误对话框。
#   * 服务由页面里的“退出 MyHarness”或 POST /api/shutdown 正常结束；结束时整棵进程树随之退出。
#   * 需要看控制台输出时，用 `dev-web.cmd --console`（保留原来的可见窗口方式）。
#   * 启动超过约 1 秒仍未就绪时，显示一个小的进度窗口；进度来自 dev.ps1 / 服务端日志里真实出现的阶段，
#     服务就绪后自动关闭。快速启动时不会出现任何窗口。
#   * 日志由子进程以 UTF-8 写入，读取时必须显式指定 UTF-8，否则 PowerShell 5.1 会按系统 ANSI 代码页
#     （中文系统为 GBK）解码，错误对话框里的中文就会变成乱码。
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
	return ((Get-Content -LiteralPath $Path -Tail $Lines -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`n").Trim()
}

function Read-Log([string]$Path) {
	# 进程还在写日志时文件可能被占用；读取失败按“暂无内容”处理，下一轮再读。
	try {
		$stream = [System.IO.File]::Open($Path, "Open", "Read", "ReadWrite")
		try {
			return (New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)).ReadToEnd()
		} finally {
			$stream.Dispose()
		}
	} catch {
		return ""
	}
}

# dev.ps1 依次打印的真实阶段（“==> ”开头的标题）。进度 = 已出现的阶段数 / 总阶段数，
# 最后一步“服务监听”由服务端打印的 “MyHarness Web UI: http…” 确认。
$Stages = @(
	@{ Match = "读取项目要求"; Text = "读取项目要求" },
	@{ Match = "检查 Node.js"; Text = "检查 Node.js" },
	@{ Match = "检查 npm"; Text = "检查 npm" },
	@{ Match = "检查项目依赖"; Text = "检查项目依赖（首次运行或依赖变更时会安装，可能较久）" },
	@{ Match = "检查 bash"; Text = "检查 bash" },
	@{ Match = "检查 ffmpeg"; Text = "检查 ffmpeg" },
	@{ Match = "启动 MyHarness"; Text = "加载 MyHarness 并启动本地服务" }
)

function Get-StartupProgress([string]$OutText, [string]$ErrText) {
	if ($ErrText -match "MyHarness Web UI: http") {
		return @{ Percent = 100; Text = "本地服务已就绪，正在打开浏览器" }
	}
	$reached = 0
	for ($i = 0; $i -lt $Stages.Count; $i++) {
		if ($OutText.Contains("==> " + $Stages[$i].Match)) { $reached = $i + 1 }
	}
	if ($reached -eq 0) {
		return @{ Percent = 3; Text = "正在启动 PowerShell 环境" }
	}
	# 最后一格留给“服务监听”，所以阶段最多占 95%。
	return @{ Percent = [int](95 * $reached / $Stages.Count); Text = $Stages[$reached - 1].Text }
}

$script:Splash = $null

function Show-Splash {
	try {
		Add-Type -AssemblyName System.Windows.Forms
		Add-Type -AssemblyName System.Drawing
		$form = New-Object System.Windows.Forms.Form
		$form.Text = "MyHarness"
		$form.FormBorderStyle = "FixedDialog"
		$form.ControlBox = $false
		$form.ShowInTaskbar = $false
		$form.TopMost = $true
		$form.StartPosition = "CenterScreen"
		$form.ClientSize = New-Object System.Drawing.Size(420, 96)
		$title = New-Object System.Windows.Forms.Label
		$title.Text = "正在启动 MyHarness Web UI…"
		$title.Location = New-Object System.Drawing.Point(16, 12)
		$title.Size = New-Object System.Drawing.Size(388, 22)
		$title.Font = New-Object System.Drawing.Font($title.Font, [System.Drawing.FontStyle]::Bold)
		$detail = New-Object System.Windows.Forms.Label
		$detail.Location = New-Object System.Drawing.Point(16, 36)
		$detail.Size = New-Object System.Drawing.Size(388, 20)
		$bar = New-Object System.Windows.Forms.ProgressBar
		$bar.Location = New-Object System.Drawing.Point(16, 62)
		$bar.Size = New-Object System.Drawing.Size(388, 16)
		$bar.Minimum = 0
		$bar.Maximum = 100
		$form.Controls.AddRange(@($title, $detail, $bar))
		$form.Show()
		$script:Splash = @{ Form = $form; Detail = $detail; Bar = $bar }
	} catch {
		$script:Splash = $null
	}
}

function Update-Splash($Progress) {
	if (-not $script:Splash) { return }
	$script:Splash.Detail.Text = $Progress.Text
	$script:Splash.Bar.Value = [Math]::Min(100, [Math]::Max(0, $Progress.Percent))
	[System.Windows.Forms.Application]::DoEvents()
}

function Close-Splash {
	if ($script:Splash) {
		try { $script:Splash.Form.Close(); $script:Splash.Form.Dispose() } catch { }
		$script:Splash = $null
	}
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
# 超过 SplashDelayMilliseconds 仍未就绪才显示进度窗口，快速启动时不闪窗。
$SplashDelayMilliseconds = 1000
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
	$errText = Read-Log $ErrLog
	if ($errText -match "MyHarness Web UI: http") {
		$ready = $true
		break
	}
	if ($process.HasExited) { break }
	if (-not $script:Splash -and $clock.ElapsedMilliseconds -ge $SplashDelayMilliseconds) { Show-Splash }
	if ($script:Splash) { Update-Splash (Get-StartupProgress (Read-Log $OutLog) $errText) }
	Start-Sleep -Milliseconds 150
}

if ($ready) {
	if ($script:Splash) { Update-Splash (Get-StartupProgress "" "MyHarness Web UI: http"); Start-Sleep -Milliseconds 250 }
	Close-Splash
	exit 0
}

Close-Splash
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
