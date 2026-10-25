# MyHarness 桌面版一键启动器：构建 -> 打包 -> 启动最新产物。
# 双击入口是仓库根目录的 dev-desktop.cmd，本脚本也由它负责调用。
#
# 行为：
#   * 依次运行根 package.json 里的 build（全部包）和 electron-builder 打包，产物写入 dist\desktop。
#   * 新版本总是从固定目录 dist\desktop\current 启动：关闭旧实例后，把刚打好的 release-<时间戳> 改名为 current，
#     原来的 current 改名为 previous（上一个版本，留作回退）。Windows 防火墙和开机自启都按 exe 路径记，
#     路径不变，「允许公用和专用网络访问」只会在第一次问，开机自启也不会指向已删除的旧目录。
#   * 然后清理中间产物（stage-*）和其余 release-* 目录，删不掉的只提示并跳过，不会中断流程。
#   * 启动最新产物前会关闭正在运行的 MyHarness，否则单实例锁会让新版本直接退出、看到的还是旧窗口。
#     关闭走的是窗口关闭（和点右上角 X 一样），服务与子进程随之正常退出。
#     20 秒后仍有残留（如无窗口的孤儿子进程）时，只强制结束位于 dist\desktop 下的 MyHarness 进程。
#   * 失败时保留窗口显示原因，成功时窗口在启动新版本后自动关闭。
#
# 参数：由环境变量控制，脚本本身不消费参数。
#   MYHARNESS_DESKTOP_SKIP_LAUNCH=1  只构建打包，不关闭旧实例、不启动（排查构建问题时用）

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $Root

# 固定产物位置，避免从带 MYHARNESS_ARTIFACTS_DIR 的终端启动时落到会话临时目录。
$OutputRoot = Join-Path $Root "dist\desktop"
$env:MYHARNESS_DESKTOP_OUTPUT = $OutputRoot
$ExecutableName = "MyHarness"
$CurrentDir = Join-Path $OutputRoot "current"
$PreviousDir = Join-Path $OutputRoot "previous"

function Write-Step([string]$Text) {
	Write-Host ""
	Write-Host "==> $Text" -ForegroundColor Cyan
}

function Resolve-NpmCommand {
	# 双击启动时继承的是资源管理器那时的环境：PATH 里常常没有 Node（PATH 变更只对新会话生效）；
	# 而在 MyHarness 服务里跑时 PATH 可能已被前置 Node 目录。所以不依赖 PATH：找不到就退回常见安装位置。
	$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
	if (-not $nodeCommand) {
		$candidates = New-Object System.Collections.Generic.List[string]
		if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles "nodejs\node.exe")) }
		if ($env:LOCALAPPDATA) {
			$candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"))
			$localPrograms = Join-Path $env:LOCALAPPDATA "Programs"
			if (Test-Path -LiteralPath $localPrograms) {
				Get-ChildItem -LiteralPath $localPrograms -Directory -Filter "nodejs*" -ErrorAction SilentlyContinue |
					ForEach-Object { $candidates.Add((Join-Path $_.FullName "node.exe")) }
			}
		}
		foreach ($candidate in $candidates) {
			if (Test-Path -LiteralPath $candidate) {
				$env:Path = (Split-Path -Parent $candidate) + ";" + $env:Path
				Write-Host "  PATH 中没有 node，改用常见安装位置：$candidate" -ForegroundColor DarkYellow
				$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
				break
			}
		}
	}
	if (-not $nodeCommand) {
		throw "找不到 Node.js（命令 node 不可用，常见安装位置也没有）。请安装 Node.js 22.19.0 或更高版本，例如：winget install --id OpenJS.NodeJS.LTS -e；装好后重新双击 dev-desktop.cmd。"
	}

	$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
	if (-not $npmCommand) { throw "找不到 npm（它随 Node.js 一起安装）。请重新安装 Node.js 后重试。" }
	# npm 10+ 自带的 npm.ps1 shim 不适合脚本化调用（参数会被重新拼接），统一改用同目录的 npm.cmd。
	$resolved = $npmCommand.Source
	if ($resolved -like "*.ps1") {
		$sibling = Join-Path (Split-Path -Parent $resolved) "npm.cmd"
		if (Test-Path -LiteralPath $sibling) { $resolved = $sibling }
	}
	if (-not (Test-Path -LiteralPath $resolved)) { throw "找到的 npm 不可用：$resolved" }
	return $resolved
}

function Get-Packaging {
	# 正在运行的 MyHarness 窗口（打包产物；开发模式的 electron/node 进程不叫这个名字）。
	@(Get-Process -Name $ExecutableName -ErrorAction SilentlyContinue)
}

function Remove-OldArtifacts([string]$Keep) {
	Write-Step "清理旧构建产物"
	$targets = @()
	$targets += @(Get-ChildItem -LiteralPath $OutputRoot -Directory -Filter "release-*" -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $Keep })
	$targets += @(Get-ChildItem -LiteralPath $OutputRoot -Directory -Filter "stage-*" -ErrorAction SilentlyContinue)

	foreach ($item in $targets) {
		# 只删本脚本自己生成、且确认位于产物目录下的普通目录：重解析点（符号链接/junction）一律不碰。
		$full = $item.FullName
		if (-not $full.StartsWith($OutputRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
		if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
			Write-Host "  跳过 $($item.Name)：这是链接，不自动删除" -ForegroundColor DarkYellow
			continue
		}
		try {
			Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
			Write-Host "  已删除 $($item.Name)"
		} catch {
			Write-Host "  跳过 $($item.Name)：$($_.Exception.Message)" -ForegroundColor DarkYellow
		}
	}
}

function Test-PlainDirectory([string]$Path) {
	$item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
	return $item -and $item.PSIsContainer -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# 把新版本放到固定的 current 目录（改名，同一磁盘上是瞬间完成的）。任何一步失败都返回 $null，调用方改从
# release-<时间戳> 原地启动：能用，只是防火墙会把它当新程序再问一次。
function Install-Current([string]$Release) {
	Write-Step "把新版本放到固定目录 current"
	try {
		foreach ($path in @($CurrentDir, $PreviousDir)) {
			if ((Test-Path -LiteralPath $path) -and -not (Test-PlainDirectory $path)) { throw "$path 不是普通目录（可能是链接），不自动改动" }
		}
		if (Test-Path -LiteralPath $PreviousDir) { Remove-Item -LiteralPath $PreviousDir -Recurse -Force -ErrorAction Stop }
		if (Test-Path -LiteralPath $CurrentDir) { Rename-Item -LiteralPath $CurrentDir -NewName "previous" -ErrorAction Stop }
		Rename-Item -LiteralPath $Release -NewName "current" -ErrorAction Stop
		Write-Host "  $CurrentDir"
		return (Join-Path $CurrentDir "win-unpacked\$ExecutableName.exe")
	} catch {
		Write-Host "  没能放到 current：$($_.Exception.Message)" -ForegroundColor DarkYellow
		Write-Host "  改从新构建目录直接启动（Windows 防火墙可能会把它当新程序再询问一次）" -ForegroundColor DarkYellow
		return $null
	}
}

function Stop-RunningInstance {
	$running = Get-Packaging
	if ($running.Count -eq 0) { return }
	Write-Step "正在运行的 MyHarness：$($running.Count) 个进程"
	foreach ($process in $running) { Write-Host "  $($process.Path)" }
	Write-Host "  5 秒后关闭它们并启动新版本（正在进行的对话会中断，按 Ctrl+C 可取消）…"
	Start-Sleep -Seconds 5
	foreach ($process in $running) { [void]$process.CloseMainWindow() }
	$deadline = (Get-Date).AddSeconds(20)
	while ((Get-Packaging).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
	if ((Get-Packaging).Count -gt 0) {
		# 窗口关闭后仍残留的进程多半是主进程已退出后遗留的孤儿子进程（没有窗口，CloseMainWindow 无效），
		# 它们会一直占着旧版本的 MyHarness.exe。只强制结束命令行位于本脚本产物目录下的进程，别的位置的不碰。
		$leftover = @(Get-Packaging | Where-Object {
			$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue
			$cim -and $cim.CommandLine -and $cim.CommandLine.IndexOf($OutputRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
		})
		if ($leftover.Count -gt 0) {
			Write-Host "  有 $($leftover.Count) 个残留进程没有响应窗口关闭，强制结束它们" -ForegroundColor DarkYellow
			foreach ($process in $leftover) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
			$deadline = (Get-Date).AddSeconds(10)
			while ((Get-Packaging).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
		}
	}
	if ((Get-Packaging).Count -gt 0) {
		throw "MyHarness 没有在 20 秒内退出。请手动关闭它的窗口，然后重新双击 dev-desktop.cmd。"
	}
	Write-Host "  已关闭"
}

try {
	Write-Host "MyHarness 桌面版：构建 + 打包 + 启动" -ForegroundColor White
	Write-Host "仓库：$Root"
	Write-Host "产物目录：$OutputRoot"
	Write-Host "第一次构建通常更慢；构建期间可以继续使用已经打开的旧版本。"

	Write-Step "构建并打包（npm run desktop:pack）"
	$npm = Resolve-NpmCommand
	Write-Host "  使用 npm：$npm"
	& $npm run desktop:pack
	if ($LASTEXITCODE -ne 0) { throw "构建或打包失败（npm 退出码 $LASTEXITCODE）。" }

	# 用产物目录的写入时间挑最新的一份；build.mjs 每次生成新的 release-<时间戳> 目录。
	$releases = @(
		Get-ChildItem -LiteralPath $OutputRoot -Directory -Filter "release-*" -ErrorAction SilentlyContinue |
			Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "win-unpacked\$ExecutableName.exe") } |
			Sort-Object LastWriteTime -Descending
	)
	if ($releases.Count -eq 0) { throw "打包结束但没有找到 win-unpacked\$ExecutableName.exe（$OutputRoot）。" }
	$release = $releases[0].FullName
	$exe = Join-Path $release "win-unpacked\$ExecutableName.exe"

	if ($env:MYHARNESS_DESKTOP_SKIP_LAUNCH -eq "1") {
		Write-Host ""
		Remove-OldArtifacts -Keep $release
		Write-Host "已按 MYHARNESS_DESKTOP_SKIP_LAUNCH=1 跳过关闭与启动。产物：$exe" -ForegroundColor Yellow
		exit 0
	}

	Stop-RunningInstance

	$installed = Install-Current -Release $release
	if ($installed) { $exe = $installed; $release = $CurrentDir }
	Remove-OldArtifacts -Keep $release

	# 新版本的 exe 路径不变（current），资源管理器的图标缓存按路径记，换了图标后任务栏和开始菜单仍显示旧图标；
	# ie4uinit -show 让资源管理器重新读取图标（Windows 10/11 自带，只刷新缓存，不改任何设置）。
	$iconRefresher = Join-Path $env:SystemRoot "System32\ie4uinit.exe"
	if (Test-Path -LiteralPath $iconRefresher) { try { & $iconRefresher -show } catch { Write-Host "  图标缓存刷新失败：$($_.Exception.Message)" -ForegroundColor DarkYellow } }

	Write-Step "启动最新版本"
	Write-Host "  $exe"
	Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)

	Write-Host ""
	Write-Host "完成，窗口即将关闭。" -ForegroundColor Green
	Start-Sleep -Milliseconds 800
	exit 0
} catch {
	Write-Host ""
	Write-Host "[失败] $($_.Exception.Message)" -ForegroundColor Red
	Write-Host "窗口保留在这里；修好问题后重新双击 dev-desktop.cmd。"
	[void](Read-Host "按回车键关闭")
	exit 1
}
