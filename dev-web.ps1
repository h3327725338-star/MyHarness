# MyHarness Web UI 静默启动器（Windows，由 dev-web.cmd / dev-web.vbs 调用）
#
# 目标：从快捷方式启动 Web 模式后，不留下可见的 CMD / PowerShell 控制台窗口。
#   * 服务进程（web-runtime.ps1 -> node）以“无窗口”方式在后台运行，输出写入日志文件。
#   * 本脚本只负责：已有就绪实例且后端源码没变时直接唤醒它（打开浏览器后退出），否则先让旧实例退出（保证运行的是当前源码）再启动服务、等待它就绪，失败时弹出错误对话框。
#   * 服务由页面里的“退出 MyHarness”或 POST /api/shutdown 正常结束；结束时整棵进程树随之退出。
#   * 需要看控制台输出时，用 `dev-web.cmd --console`（保留原来的可见窗口方式）。
#   * 启动超过约 1 秒仍未就绪时，显示一个小的进度窗口；进度来自 web-runtime.ps1 / 服务端日志里真实出现的阶段，
#     服务就绪后自动关闭。快速启动时不会出现任何窗口。
#   * 日志由子进程以 UTF-8 写入，读取时必须显式指定 UTF-8，否则 PowerShell 5.1 会按系统 ANSI 代码页
#     （中文系统为 GBK）解码，错误对话框里的中文就会变成乱码。
#
# 参数：其余参数原样转发给 MyHarness（例如 --port 7878、--no-open）；--restart 只由本脚本消费（强制重启），不转发。

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

# web-runtime.ps1 依次打印的真实阶段（“==> ”开头的标题）。进度 = 已出现的阶段数 / 总阶段数，
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

# 启动窗口：无边框深色小窗，配色/字体取自 Web UI 的设计 token（tokens.css 的 dark 主题），
# 只画品牌标记、标题、当前阶段文字和一条细进度线。进度值向真实阶段平滑靠近，不做假进度。
function Show-Splash {
	try {
		Add-Type -AssemblyName System.Windows.Forms
		Add-Type -AssemblyName System.Drawing
		if (-not ("MyHarnessSplashNative" -as [type])) {
			Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MyHarnessSplashNative {
	[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
	[DllImport("user32.dll")] public static extern bool ReleaseCapture();
	[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
}
"@
		}
		$form = New-Object System.Windows.Forms.Form
		$form.Text = "MyHarness"
		$form.FormBorderStyle = "None"
		# 要出现在任务栏：最小化后只能从任务栏还原。
		$form.ShowInTaskbar = $true
		$form.TopMost = $true
		$form.StartPosition = "CenterScreen"
		$form.ClientSize = New-Object System.Drawing.Size(360, 116)
		$form.BackColor = [System.Drawing.Color]::FromArgb(20, 21, 21)
		# WinForms 没有公开的双缓冲开关，用反射打开，避免进度线闪烁。
		[void]$form.GetType().GetProperty("DoubleBuffered", [System.Reflection.BindingFlags]"Instance,NonPublic").SetValue($form, $true, $null)
		# Windows 11：系统圆角；Windows 10 不支持时退回到手工圆角区域。
		$corner = 2
		$rounded = $false
		try { $rounded = ([MyHarnessSplashNative]::DwmSetWindowAttribute($form.Handle, 33, [ref]$corner, 4) -eq 0) } catch { }
		if (-not $rounded) {
			$path = New-Object System.Drawing.Drawing2D.GraphicsPath
			$d = 20
			$path.AddArc(0, 0, $d, $d, 180, 90)
			$path.AddArc(360 - $d, 0, $d, $d, 270, 90)
			$path.AddArc(360 - $d, 116 - $d, $d, $d, 0, 90)
			$path.AddArc(0, 116 - $d, $d, $d, 90, 90)
			$path.CloseFigure()
			$form.Region = New-Object System.Drawing.Region($path)
		}
		$state = @{ Text = ""; Target = 0.0; Shown = 0.0; Hover = ""; Cancel = $false }
		# 右上角的标准窗口按钮：最小化、关闭（各 40x30）。无边框窗口没有系统标题栏，所以自己画、自己做点击判断。
		$form.Add_MouseMove({
			param($sender, $e)
			$hit = Get-SplashButton $e.X $e.Y
			if ($script:Splash -and $script:Splash.State.Hover -ne $hit) {
				$script:Splash.State.Hover = $hit
				$sender.Invalidate()
			}
		})
		$form.Add_MouseLeave({
			param($sender, $e)
			if ($script:Splash -and $script:Splash.State.Hover -ne "") {
				$script:Splash.State.Hover = ""
				$sender.Invalidate()
			}
		})
		$form.Add_MouseDown({
			param($sender, $e)
			if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
			$hit = Get-SplashButton $e.X $e.Y
			if ($hit -eq "min") {
				$sender.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
			} elseif ($hit -eq "close") {
				if ($script:Splash) { $script:Splash.State.Cancel = $true }
			} else {
				# 其余区域按住拖动窗口（HTCAPTION）。
				[void][MyHarnessSplashNative]::ReleaseCapture()
				[void][MyHarnessSplashNative]::SendMessage($sender.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero)
			}
		})
		# Alt+F4 / 任务栏“关闭窗口”与点击关闭按钮一样：取消启动。
		$form.Add_FormClosing({
			param($sender, $e)
			if ($script:Splash -and -not $script:Splash.State.Closing) {
				$e.Cancel = $true
				$script:Splash.State.Cancel = $true
			}
		})
		$form.Add_Paint({
			param($sender, $e)
			$g = $e.Graphics
			$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
			$flags = [System.Windows.Forms.TextFormatFlags]"NoPadding,EndEllipsis,SingleLine,VerticalCenter,Left"
			# 品牌标记：圆角深色方块 + 浅蓝 M（与 favicon.svg 相同的形状）。
			$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
			$x = 24; $y = 22; $size = 32; $r = 8
			$tile.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
			$tile.AddArc($x + $size - $r * 2, $y, $r * 2, $r * 2, 270, 90)
			$tile.AddArc($x + $size - $r * 2, $y + $size - $r * 2, $r * 2, $r * 2, 0, 90)
			$tile.AddArc($x, $y + $size - $r * 2, $r * 2, $r * 2, 90, 90)
			$tile.CloseFigure()
			$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(34, 36, 36))), $tile)
			$g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(58, 61, 61)), 1), $tile)
			$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(121, 168, 245)), 2.4
			$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
			$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
			$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
			$sx = $x + 8; $sy = $y + 8; $u = 16 / 24
			$pts = @(
				(New-Object System.Drawing.PointF ($sx + 0), ($sy + 16 * 1.0)),
				(New-Object System.Drawing.PointF ($sx + 0), ($sy + 4 * 1.0)),
				(New-Object System.Drawing.PointF ($sx + 8), ($sy + 12 * 1.0)),
				(New-Object System.Drawing.PointF ($sx + 16), ($sy + 4 * 1.0)),
				(New-Object System.Drawing.PointF ($sx + 16), ($sy + 16 * 1.0))
			)
			$g.DrawLines($pen, [System.Drawing.PointF[]]$pts)
			$titleFont = New-Object System.Drawing.Font("Segoe UI Semibold", 12.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
			$subFont = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
			[System.Windows.Forms.TextRenderer]::DrawText($g, "MyHarness", $titleFont, (New-Object System.Drawing.Rectangle 68, 20, 200, 20), [System.Drawing.Color]::FromArgb(227, 229, 229), $flags)
			[System.Windows.Forms.TextRenderer]::DrawText($g, "正在启动 Web UI", $subFont, (New-Object System.Drawing.Rectangle 68, 39, 200, 16), [System.Drawing.Color]::FromArgb(122, 128, 128), $flags)
			# 当前阶段文字（右下方一行，过长以省略号截断）。
			[System.Windows.Forms.TextRenderer]::DrawText($g, $script:Splash.State.Text, $subFont, (New-Object System.Drawing.Rectangle 24, 68, 312, 18), [System.Drawing.Color]::FromArgb(168, 173, 173), $flags)
			# 细进度线：2px 轨道 + 浅蓝填充，圆头。
			$trackY = 98; $trackX = 24; $trackW = 312
			$track = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(43, 45, 45)), 2
			$track.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
			$track.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
			$g.DrawLine($track, $trackX + 1, $trackY, $trackX + $trackW - 1, $trackY)
			$fill = [Math]::Max(0.0, [Math]::Min(1.0, $script:Splash.State.Shown / 100.0)) * ($trackW - 2)
			if ($fill -gt 0.5) {
				$bar = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(121, 168, 245)), 2
				$bar.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
				$bar.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
				$g.DrawLine($bar, $trackX + 1, $trackY, $trackX + 1 + $fill, $trackY)
				$bar.Dispose()
			}
			$track.Dispose(); $pen.Dispose(); $titleFont.Dispose(); $subFont.Dispose(); $tile.Dispose()
			# 窗口按钮：悬停时底色高亮（关闭为红色），线条图标。
			$hover = $script:Splash.State.Hover
			$glyph = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(168, 173, 173)), 1.2
			if ($hover -eq "min") { $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(43, 45, 45))), 280, 1, 40, 29) }
			if ($hover -eq "close") {
				$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(196, 43, 28))), 320, 1, 39, 29)
			}
			$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
			$g.DrawLine($glyph, 295, 15, 305, 15)
			$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
			if ($hover -eq "close") { $glyph.Color = [System.Drawing.Color]::White }
			$g.DrawLine($glyph, 335, 10, 345, 20)
			$g.DrawLine($glyph, 345, 10, 335, 20)
			$glyph.Dispose()
			# 1px 边框
			$g.DrawRectangle((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(43, 45, 45)), 1), 0, 0, $form.ClientSize.Width - 1, $form.ClientSize.Height - 1)
		})
		$form.Show()
		$script:Splash = @{ Form = $form; State = $state }
	} catch {
		$script:Splash = $null
	}
}

# 窗口按钮的点击区域（客户区坐标）：最小化 x 280-319，关闭 x 320-359，高 30。
function Get-SplashButton([int]$X, [int]$Y) {
	if ($Y -lt 0 -or $Y -ge 30) { return "" }
	if ($X -ge 280 -and $X -lt 320) { return "min" }
	if ($X -ge 320 -and $X -lt 360) { return "close" }
	return ""
}

function Test-SplashCancelled {
	return ($script:Splash -and $script:Splash.State.Cancel)
}

function Update-Splash($Progress) {
	if (-not $script:Splash) { return }
	$state = $script:Splash.State
	$state.Text = $Progress.Text
	$state.Target = [Math]::Min(100, [Math]::Max(0, $Progress.Percent))
	Step-Splash
}

# 每个循环调用：进度值按比例靠近目标（只增不减），然后重绘。
function Step-Splash {
	if (-not $script:Splash) { return }
	$state = $script:Splash.State
	if ($state.Shown -lt $state.Target) { $state.Shown = [Math]::Min($state.Target, $state.Shown + [Math]::Max(0.6, ($state.Target - $state.Shown) * 0.18)) }
	$script:Splash.Form.Invalidate()
	[System.Windows.Forms.Application]::DoEvents()
}

function Close-Splash {
	if ($script:Splash) {
		$script:Splash.State.Closing = $true
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
$forceRestart = $forward -contains "--restart"
# --restart is a launcher-only flag: force Stop + restart even when the sources are unchanged.
# It must not reach the server (unknown option there), so it is stripped from the forwarded args.
if ($forceRestart) { $forward = @($forward | Where-Object { $_ -ne "--restart" }) }

# 服务是否已经能应答：直接问 /api/boot（不走代理，0.15 秒超时），不依赖日志文件。
# 就绪时一次只要约 1ms，所以启动分支先问它，再判断端口占用。
function Test-WebReady([int]$Port, [int]$TimeoutMs = 150) {
	try {
		$request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/boot")
		$request.Proxy = $null
		$request.Timeout = $TimeoutMs
		$request.ReadWriteTimeout = $TimeoutMs
		$response = $request.GetResponse()
		try {
			$reader = New-Object System.IO.StreamReader($response.GetResponseStream())
			$text = $reader.ReadToEnd()
		} finally {
			$response.Close()
		}
		return ($text -match '"phase"' -and $text -match '"version"')
	} catch {
		return $false
	}
}

function Test-ExistingInstance([int]$Port, [int]$TimeoutMs = 150) {
	return (Test-WebReady $Port $TimeoutMs)
}

# 已有就绪实例且后端源码没变时直接唤醒它（W157）：读它启动时刻的 startedAtMs，
# 对比后端在启动时会加载的文件的最大 mtime。取不到、扫失败、没就绪就返回 $null，
# 调用方一律退回现有的关停再重启。
function Get-BootStartedAtMs([int]$Port, [int]$TimeoutMs = 150) {
	try {
		$request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/boot")
		$request.Proxy = $null
		$request.Timeout = $TimeoutMs
		$request.ReadWriteTimeout = $TimeoutMs
		$response = $request.GetResponse()
		try {
			$text = (New-Object System.IO.StreamReader($response.GetResponseStream())).ReadToEnd()
		} finally {
			$response.Close()
		}
		if ($text -notmatch '"phase"\s*:\s*"ready"') { return $null }
		if ($text -match '"startedAtMs"\s*:\s*(\d+)') { return [long]$Matches[1] }
		return $null
	} catch {
		return $null
	}
}

# 后端在启动时会加载的文件里最新的修改时间（毫秒时间戳）。失败返回 $null 保守重启。
# 只扫后端加载范围：packages/*/src、packages/*/package.json、根 package.json、tsconfig*.json、
# scripts/dev-fast-loader.mjs、system-prompts。不扫 web/（前端每次请求都从磁盘读，不需要重启）。
function Get-BackendMaxMtimeMs([string]$RepoRoot) {
	try {
		$probe = Get-Command node -ErrorAction Stop
		$scan = @(
			'const fs=require("fs");',
			'const path=require("path");',
			'const root=process.argv[1];',
			'let max=0;',
			'function touch(p){try{const s=fs.statSync(p,{throwIfNoEntry:false});if(s&&s.isFile()&&s.mtimeMs>max)max=s.mtimeMs;}catch(e){}}',
			'function walk(d){let es;try{es=fs.readdirSync(d,{withFileTypes:true});}catch(e){return;}for(const e of es){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else touch(p);}}',
			'for(const pkg of fs.readdirSync(path.join(root,"packages"),{withFileTypes:true})){if(!pkg.isDirectory())continue;const pd=path.join(root,"packages",pkg.name);walk(path.join(pd,"src"));touch(path.join(pd,"package.json"));}',
			'touch(path.join(root,"package.json"));',
			'for(const f of fs.readdirSync(root)){if(/^tsconfig.*\.json$/.test(f))touch(path.join(root,f));}',
			'touch(path.join(root,"scripts","dev-fast-loader.mjs"));',
			'walk(path.join(root,"system-prompts"));',
			'console.log(Math.floor(max));'
		) -join [Environment]::NewLine
		# PowerShell 5.1 strips the double quotes of an external command's argument,
		# so node would see require(fs) instead of require("fs"); escape them first.
		$scan = $scan.Replace('"', '\"')
		$output = & $probe.Source -e $scan $RepoRoot 2>$null
		$maxMtime = 0
		if ($output -match '(\d+)') { [long]::TryParse($Matches[1], [ref]$maxMtime) | Out-Null }
		if ($maxMtime -le 0) { return $null }
		return $maxMtime
	} catch {
		return $null
	}
}

function Invoke-InstanceWake([int]$Port) {
	try {
		$response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/wake" -Method Post -Headers @{ "x-myharness-web" = "1" } -UseBasicParsing -TimeoutSec 3
		return ($response.StatusCode -eq 200 -and $response.Content -match '"ok"\s*:\s*true')
	} catch {
		return $false
	}
}

# 端口上有没有别的程序在监听：只做一次 TCP 连接（0.15 秒超时），不问 HTTP。
# 只在 Test-WebReady 不就绪时调用；Get-NetTCPConnection 首次调用要加载模块（约 1 秒），
# 不能放在每次启动的必经之路上，只在确实需要 PID 的 taskkill 兜底里用。
function Test-PortBusy([int]$Port) {
	$client = $null
	try {
		$client = New-Object System.Net.Sockets.TcpClient
		$async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
		if (-not $async.AsyncWaitHandle.WaitOne(150)) { return $false }
		try {
			$client.EndConnect($async)
		} catch {
			return $false
		}
		return $true
	} catch {
		return $false
	} finally {
		if ($client) { $client.Close() }
	}
}

# 每次启动都必须运行当前源码：源码变了就不能复用已在运行的实例，先让它正常退出再启动新的。
# （复用会让浏览器连上按旧代码启动的后端，看不到最新改动；源码没变时走上面的唤醒快路。）
# 注意：本函数首次调用要加载网络模块（约 1 秒），只允许在需要 PID 的 taskkill 兜底里调用，
# 不得出现在每次启动的必经之路上；普通的“端口空不空”判断用 Test-PortBusy。
function Get-PortListener([int]$Port) {
	Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Wait-PortFree([int]$Port, [int]$Seconds) {
	$until = (Get-Date).AddSeconds($Seconds)
	while ((Get-Date) -lt $until) {
		if (-not (Test-PortBusy $Port)) { return $true }
		Start-Sleep -Milliseconds 200
	}
	return -not (Test-PortBusy $Port)
}

function Stop-ExistingInstance([int]$Port) {
	# 与页面里“退出 MyHarness”相同的请求；服务会先结束会话再退出。
	try {
		Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -Headers @{ "x-myharness-web" = "1" } -UseBasicParsing -TimeoutSec 5 | Out-Null
	} catch { }
	if (Wait-PortFree $Port 15) { return $true }
	# 正常退出没有成功：只结束确认是 MyHarness 的监听进程（连同子进程），绝不动其他程序。
	$listener = Get-PortListener $Port
	$owner = if ($listener) { Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue } else { $null }
	if ($owner -and $owner.CommandLine -match "myharness|coding-agent") {
		& taskkill.exe /PID $owner.ProcessId /T /F | Out-Null
		return (Wait-PortFree $Port 10)
	}
	return $false
}

# 已有实例时只做一次新鲜度判断（W163）：读它的 startedAtMs，对比后端加载范围的
# 最大 mtime。返回 wake（没变，打开浏览器）、keep（--no-open 且没变，静默退出）、
# restart（变了、判不准或 --restart）。普通拉起、--no-open、二次确认三条路共用。
function Get-InstanceDecision([int]$Port, [int]$ProbeTimeoutMs) {
	$clock = [System.Diagnostics.Stopwatch]::StartNew()
	$budgetMs = 3000
	try {
		if (-not $forceRestart) {
			$startedAtMs = Get-BootStartedAtMs $Port $ProbeTimeoutMs
			if ($startedAtMs -and $clock.ElapsedMilliseconds -lt $budgetMs) {
				$maxMtime = Get-BackendMaxMtimeMs $Root
				if ($maxMtime -and $maxMtime -le $startedAtMs -and $clock.ElapsedMilliseconds -lt $budgetMs) {
					if ($noOpen) { return "keep" }
					return "wake"
				}
			}
		}
	} catch {
	}
	return "restart"
}

# 分支顺序：先问 /api/boot（就绪时约 1ms）→ 不就绪再判端口占用 → 空闲直接启动。
# 有就绪实例走上面的新鲜度判断（没变唤醒或静默留、变了关停再起）；端口忙但短超时内
# 问不出 /api/boot 时再给一次长超时确认（实例可能正忙），仍没回答才报“被其他程序占用”。
$existingPort = 0
$probeTimeoutMs = 150
if ($port -ne 0 -and (Test-ExistingInstance $port)) {
	$existingPort = $port
} elseif ($port -ne 0 -and (Test-PortBusy $port)) {
	# 第二次确认：实例正忙（重请求）时 /api/boot 可能错过 150ms 探测，但 TCP 还通。
	# 用 2000ms 再问一次，回答了就按已有就绪实例处理；仍然没回答才报占用。
	if (Test-ExistingInstance $port 2000) {
		$existingPort = $port
		$probeTimeoutMs = 2000
	} else {
		Show-Error "端口 $port 已被其他程序占用，MyHarness 无法启动。请关闭该程序，或用 --port 指定其他端口。"
		exit 1
	}
}
if ($existingPort -ne 0) {
	$decision = Get-InstanceDecision $existingPort $probeTimeoutMs
	if ($decision -eq "wake") {
		if (Invoke-InstanceWake $existingPort) { exit 0 }
	} elseif ($decision -eq "keep") {
		exit 0
	}
	if (-not (Stop-ExistingInstance $existingPort)) {
		Show-Error "无法结束端口 $existingPort 上正在运行的旧 MyHarness，已取消启动，避免打开旧版本。"
		exit 1
	}
}

try {
	New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
	Remove-Item -LiteralPath $OutLog, $ErrLog -Force -ErrorAction SilentlyContinue

	$devScript = Join-Path $Root "web-runtime.ps1"
	$startArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $devScript) + $forward
	$process = Start-Process -FilePath "powershell.exe" -ArgumentList $startArgs -WorkingDirectory $Root `
		-WindowStyle Hidden -PassThru -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
} catch {
	Show-Error "MyHarness 无法启动：$($_.Exception.Message)"
	exit 1
}

# 等待服务打印 “MyHarness Web UI: <url>”（首次运行可能先执行 npm install，所以超时较长）。
# 超过 SplashDelayMilliseconds 仍未就绪才显示进度窗口，快速启动时不闪窗。
$SplashDelayMilliseconds = 300
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
$ready = $false
$cancelled = $false
$lastProbe = 0
while ((Get-Date) -lt $deadline) {
	$errText = Read-Log $ErrLog
	if ($errText -match "MyHarness Web UI: http") {
		$ready = $true
		break
	}
	# 日志读不到（被占用、被缓冲）时不能因此一直等下去：服务端口已经能应答就算就绪。
	if ($port -ne 0 -and ($clock.ElapsedMilliseconds - $lastProbe) -ge 250) {
		$lastProbe = $clock.ElapsedMilliseconds
		if (Test-WebReady $port) {
			$ready = $true
			break
		}
	}
	if ($process.HasExited) { break }
	if (-not $script:Splash -and $clock.ElapsedMilliseconds -ge $SplashDelayMilliseconds) { Show-Splash }
	if ($script:Splash) {
		# 日志约每 150ms 读一次；其间只推进进度动画，让进度线平滑移动。
		Update-Splash (Get-StartupProgress (Read-Log $OutLog) $errText)
		for ($tick = 0; $tick -lt 4; $tick++) {
			Start-Sleep -Milliseconds 35
			Step-Splash
			if (Test-SplashCancelled) { break }
		}
		if (Test-SplashCancelled) {
			$cancelled = $true
			break
		}
	} else {
		Start-Sleep -Milliseconds 50
	}
}

if ($cancelled) {
	# 点了窗口的关闭按钮：明确退出，并结束启动进程及其子进程（powershell -> node）。
	Close-Splash
	& taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
	exit 0
}

if ($ready) {
	if ($script:Splash) {
		Update-Splash (Get-StartupProgress "" "MyHarness Web UI: http")
		for ($tick = 0; $tick -lt 10; $tick++) { Start-Sleep -Milliseconds 30; Step-Splash }
	}
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
