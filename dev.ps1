# MyHarness 开发启动器（Windows，由 dev.cmd 调用）
#
# 目标：双击 dev.cmd -> 自动准备环境 -> 以“当前项目源码”启动 MyHarness 开发模式。
#
# 事实依据（均来自本仓库源码/文档，非猜测）：
#   * 包管理器 / lockfile：npm + package-lock.json（根 package.json 用 workspaces 定义 monorepo）。
#   * Node 要求：根 package.json 的 engines.node（本脚本从该字段动态读取，不写死版本）。
#   * 官方安装方式：README / docs/development.md 规定 `npm install --ignore-scripts`。
#   * 开发启动方式：项目自带 myharness-test.ps1（Windows）/ myharness-test.sh（Linux、macOS），
#     其本质是 `tsx packages/coding-agent/src/cli.ts`——由 tsx 直接运行 TypeScript 源码，
#     所以修改源码后无需先执行 npm run build（这也是本项目“开发模式”的真实含义）。
#     本脚本复用 myharness-test.ps1，不另造一套启动逻辑。
#   * 仓库不内置上游 Provider 或模型目录。Provider / model 配置属于用户运行时配置
#     （~/.myharness/agent/models.json）；启动器不读取、同步或校验上游模型目录。
#   * bash：docs/windows.md 说明 MyHarness 的 bash 工具需要 bash（Windows 上通常用 Git for Windows）。
#
# 本启动器只做“准备环境 + 复用项目自带开发入口”，不修改任何已跟踪的项目文件。

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

# 输出被重定向到文件时改用 UTF-8，避免中文变成 '?'；直接输出到控制台时保持默认
# （控制台走 WriteConsoleW，中文在任何代码页下都能正确显示）。
if ([Console]::IsOutputRedirected) {
	try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
}

function Write-Head([string]$Message) {
	Write-Host ""
	Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
	Write-Host "    [OK] $Message" -ForegroundColor Green
}

function Write-Note([string]$Message) {
	Write-Host "    [--] $Message" -ForegroundColor DarkGray
}

function Write-WarnLine([string]$Message) {
	Write-Host "    [!!] $Message" -ForegroundColor Yellow
}

function Write-Fail([string]$Message) {
	Write-Host ""
	Write-Host "[ERROR] $Message" -ForegroundColor Red
	exit 1
}

# 运行外部命令并返回退出码。失败只作为退出码处理，不抛出 PowerShell 错误
# （否则在 stderr 被重定向的场景下会被包成 NativeCommandError）。
function Invoke-External {
	param(
		[string]$Command,
		[string[]]$Arguments
	)
	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	$code = 0
	try {
		# 输出直接写回宿主（保持可见），但不进入本函数的返回值，
		# 否则 npm 的输出会混进返回的退出码里。
		& $Command @Arguments | Out-Host
		if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }
	} finally {
		$ErrorActionPreference = $previous
	}
	return $code
}

function Get-ExternalOutput {
	param(
		[string]$Command,
		[string[]]$Arguments
	)
	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	$text = ""
	try {
		$text = (& $Command @Arguments | Out-String).Trim()
	} finally {
		$ErrorActionPreference = $previous
	}
	return $text
}

Write-Host ""
Write-Host "MyHarness Dev Launcher  (Windows / 以项目源码启动开发模式)" -ForegroundColor White
Write-Host "项目根目录: $Root" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. 读取项目要求（engines.node），不写死版本
# ---------------------------------------------------------------------------
Write-Head "读取项目要求 (package.json -> engines.node)"

$packageJsonPath = Join-Path $Root "package.json"
if (-not (Test-Path -LiteralPath $packageJsonPath)) {
	Write-Fail "找不到 $packageJsonPath。dev.cmd 必须放在项目根目录（与 package.json 同级）。"
}

$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$nodeRange = $null
if ($packageJson.PSObject.Properties.Name -contains "engines" -and $packageJson.engines) {
	if ($packageJson.engines.PSObject.Properties.Name -contains "node") {
		$nodeRange = [string]$packageJson.engines.node
	}
}

$minNode = $null
if ($nodeRange) {
	$rangeMatch = [regex]::Match($nodeRange, "(\d+)\.(\d+)\.(\d+)")
	if ($rangeMatch.Success) {
		$minNode = [version]("{0}.{1}.{2}" -f $rangeMatch.Groups[1].Value, $rangeMatch.Groups[2].Value, $rangeMatch.Groups[3].Value)
		Write-Ok "engines.node = $nodeRange（最低要求 $minNode）"
	} else {
		Write-WarnLine "无法从 engines.node（$nodeRange）解析最低版本，跳过版本比较。"
	}
} else {
	Write-WarnLine "package.json 未声明 engines.node，跳过版本比较。"
}

# ---------------------------------------------------------------------------
# 2. 检查 Node.js
# ---------------------------------------------------------------------------
Write-Head "检查 Node.js"

$nodeExe = Get-Command node -ErrorAction SilentlyContinue
$nodePath = $null
if ($nodeExe) { $nodePath = $nodeExe.Source }

if (-not $nodePath) {
	# PATH 上没有 node 时，尝试常见安装位置（换电脑 / PATH 未生效的场景）
	$candidates = New-Object System.Collections.Generic.List[string]
	if ($env:ProgramFiles) {
		$candidates.Add((Join-Path $env:ProgramFiles "nodejs\node.exe"))
	}
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
			$nodePath = $candidate
			$env:Path = (Split-Path -Parent $candidate) + ";" + $env:Path
			Write-Note "PATH 中未找到 node，改用常见安装位置：$candidate"
			break
		}
	}
}

if (-not $nodePath) {
	Write-Host ""
	Write-Host "[ERROR] 未找到 Node.js（命令 node 不可用，常见安装位置也没有）。" -ForegroundColor Red
	if ($nodeRange) {
		Write-Host "        本项目要求：node $nodeRange" -ForegroundColor Red
	}
	Write-Host "        安装方式（任选其一，安装后重新双击 dev.cmd）：" -ForegroundColor Yellow
	Write-Host "          winget install --id OpenJS.NodeJS.LTS -e" -ForegroundColor Yellow
	Write-Host "          https://nodejs.org/en/download   (Windows Installer, x64)" -ForegroundColor Yellow
	Write-Host "        说明：Node.js 是系统级运行时，安装需要安装程序与管理员权限，" -ForegroundColor Yellow
	Write-Host "              启动器不会静默安装。若刚安装完，请关闭并重新打开窗口" -ForegroundColor Yellow
	Write-Host "              （PATH 变更只对新会话生效）。" -ForegroundColor Yellow
	exit 1
}

$nodeVersionText = Get-ExternalOutput -Command "node" -Arguments @("--version")
$versionMatch = [regex]::Match($nodeVersionText, "^v?(\d+)\.(\d+)\.(\d+)")
if (-not $versionMatch.Success) {
	Write-Fail "无法解析 node 版本（输出：'$nodeVersionText'）。"
}
$nodeVersion = [version]("{0}.{1}.{2}" -f $versionMatch.Groups[1].Value, $versionMatch.Groups[2].Value, $versionMatch.Groups[3].Value)

if ($minNode -and $nodeVersion -lt $minNode) {
	Write-Host ""
	Write-Host "[ERROR] Node.js 版本过低：当前 $nodeVersion，项目要求 >= $minNode。" -ForegroundColor Red
	Write-Host "        请升级 Node.js 后重试（例如：winget upgrade --id OpenJS.NodeJS.LTS -e）。" -ForegroundColor Yellow
	exit 1
}
Write-Ok "node $nodeVersion  ->  $nodePath"

# ---------------------------------------------------------------------------
# 3. 检查 npm
# ---------------------------------------------------------------------------
Write-Head "检查 npm"

$npmExe = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmExe) {
	Write-Fail "未找到 npm。npm 随 Node.js 一起安装，请重新安装 Node.js 后重试。"
}
# npm 10+ 自带的 npm.ps1 shim 在被脚本以 “& $Command @Arguments” 方式调用时并不透传
# 参数，而是按调用点的源码文本重建参数（其 “-Command” 分支），会把字面量
# “Command @Arguments” 传给 npm，导致 Unknown command: "Command"。
# 因此只要解析到 npm.ps1，就改用同目录的 npm.cmd 调用（参数原样透传）。
$npmCommand = $npmExe.Source
if ($npmCommand -like "*.ps1") {
	$npmCmdSibling = Join-Path (Split-Path -Parent $npmCommand) "npm.cmd"
	if (Test-Path -LiteralPath $npmCmdSibling) {
		$npmCommand = $npmCmdSibling
		Write-Note "npm.ps1 shim 与脚本化调用不兼容，改用 $npmCommand"
	}
}
# 不再执行 npm --version：npm.cmd 每次启动 node 约 0.5 秒，而版本号只是信息展示。
Write-Ok "npm  ->  $npmCommand"

# ---------------------------------------------------------------------------
# 4. 检查 / 安装项目依赖
# ---------------------------------------------------------------------------
Write-Head "检查项目依赖 (node_modules)"

$tsxPath = Join-Path $Root "node_modules\.bin\tsx.cmd"
$lockPath = Join-Path $Root "package-lock.json"
$installStampPath = Join-Path $Root "node_modules\.package-lock.json"

$needInstall = $false
$installReason = ""
if (-not (Test-Path -LiteralPath $tsxPath)) {
	$needInstall = $true
	$installReason = "缺少 node_modules\.bin\tsx.cmd"
} elseif ((Test-Path -LiteralPath $lockPath) -and (Test-Path -LiteralPath $installStampPath)) {
	if ((Get-Item -LiteralPath $lockPath).LastWriteTimeUtc -gt (Get-Item -LiteralPath $installStampPath).LastWriteTimeUtc) {
		$needInstall = $true
		$installReason = "package-lock.json 比上次安装更新"
	}
}

if ($needInstall) {
	Write-Note "$installReason -> 执行 npm install --ignore-scripts（项目文档规定的安装方式；尊重 lockfile，不升级依赖）"
	$installExit = Invoke-External -Command $npmCommand -Arguments @("install", "--ignore-scripts")
	if ($installExit -ne 0) {
		Write-Fail "npm install --ignore-scripts 失败（退出码 $installExit）。请检查网络/代理后重试。"
	}
	if (-not (Test-Path -LiteralPath $tsxPath)) {
		Write-Fail "依赖安装完成后仍未找到 $tsxPath，请手动执行：npm install --ignore-scripts"
	}
	Write-Ok "依赖安装完成"
} else {
	Write-Ok "依赖已就绪"
}

# ---------------------------------------------------------------------------
# 5. 检查 bash（MyHarness 的 bash 工具需要；不阻塞启动）
# ---------------------------------------------------------------------------
Write-Head "检查 bash（MyHarness 的 bash 工具需要）"

$bashPath = $null
if ($env:USERPROFILE) {
	$globalSettings = Join-Path $env:USERPROFILE ".myharness\agent\settings.json"
	if (Test-Path -LiteralPath $globalSettings) {
		try {
			$globalSettingsJson = Get-Content -LiteralPath $globalSettings -Raw | ConvertFrom-Json
			if ($globalSettingsJson.PSObject.Properties.Name -contains "shellPath" -and $globalSettingsJson.shellPath) {
				$configuredShell = [string]$globalSettingsJson.shellPath
				if (Test-Path -LiteralPath $configuredShell) {
					$bashPath = $configuredShell
				}
			}
		} catch {
			# 全局设置读取失败不影响启动
		}
	}
}
if (-not $bashPath -and $env:ProgramFiles) {
	# docs/windows.md 中列出的 Git for Windows 默认位置
	$gitBash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
	if (Test-Path -LiteralPath $gitBash) {
		$bashPath = $gitBash
	}
}
if (-not $bashPath) {
	$bashCmd = Get-Command bash -ErrorAction SilentlyContinue
	if ($bashCmd) {
		$bashPath = $bashCmd.Source
	}
}

if ($bashPath) {
	Write-Ok "找到 bash：$bashPath"
} else {
	Write-WarnLine "未找到 bash。MyHarness 的 bash 工具在 Windows 上需要 bash（通常安装 Git for Windows 即可）。"
	Write-WarnLine "此项不影响本次启动；缺失时 bash 相关工具不可用。"
}

# ---------------------------------------------------------------------------
# 5b. 检查 ffmpeg-static（图片/视频预处理用；不阻塞启动）
#     npm install --ignore-scripts 会跳过 ffmpeg-static 的 install 脚本，
#     项目 CI 因此额外执行 npm rebuild ffmpeg-static。这里只提示，不自动下载。
# ---------------------------------------------------------------------------
Write-Head "检查 ffmpeg-static（媒体预处理用）"

$ffmpegDir = Join-Path $Root "node_modules\ffmpeg-static"
$ffmpegBinary = $null
if (Test-Path -LiteralPath $ffmpegDir) {
	$ffmpegBinary = Get-ChildItem -LiteralPath $ffmpegDir -Filter "ffmpeg*.exe" -File -ErrorAction SilentlyContinue |
		Select-Object -First 1 -ExpandProperty FullName
}

if ($ffmpegBinary) {
	Write-Ok "找到 ffmpeg：$ffmpegBinary"
} else {
	Write-WarnLine "ffmpeg-static 二进制缺失（--ignore-scripts 安装会跳过它的 install 脚本）。"
	Write-WarnLine "此项不影响本次启动；缺失时图片/视频预处理不可用。如需补齐：npm rebuild ffmpeg-static"
}

Write-Note "手动 Provider 模式：仓库不加载上游 Provider catalog，使用用户 models.json"

# ---------------------------------------------------------------------------
# 6. 启动开发模式（复用项目自带开发入口，直接运行源码，不构建）
# ---------------------------------------------------------------------------
Write-Head "启动 MyHarness 开发模式"

$entryScript = Join-Path $Root "myharness-test.ps1"
if (-not (Test-Path -LiteralPath $entryScript)) {
	Write-Fail "找不到 $entryScript（项目自带的开发入口）。"
}

# 默认用 Node 原生类型剥离 + scripts\dev-fast-loader.mjs 直接运行源码：tsx 会让约 1600 个模块
# 逐个经过转换 hook，启动到 Web UI 监听前要 10 秒以上，原生方式约 2 秒。
# 设置 MYHARNESS_DEV_LOADER=tsx（或使用 --no-env）可回到原来的 tsx 入口 myharness-test.ps1。
$fastLoader = Join-Path $Root "scripts\dev-fast-loader.mjs"
$useTsx = ($env:MYHARNESS_DEV_LOADER -eq "tsx") -or ($args -contains "--no-env") -or (-not (Test-Path -LiteralPath $fastLoader))

$runExit = 0
$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
	if ($useTsx) {
		Write-Note "入口：tsx packages\coding-agent\src\cli.ts（复用项目自带 myharness-test.ps1）"
		Write-Note "修改配置或核心源码后，请重启进程以加载改动。"
		Write-Host ""
		& $entryScript @args
	} else {
		Write-Note "入口：node --import scripts\dev-fast-loader.mjs packages\coding-agent\src\cli.ts"
		Write-Note "修改配置或核心源码后，请重启进程以加载改动。"
		Write-Host ""
		& node --import "./scripts/dev-fast-loader.mjs" "./packages/coding-agent/src/cli.ts" @args
	}
	if ($null -ne $LASTEXITCODE) { $runExit = [int]$LASTEXITCODE }
} finally {
	$ErrorActionPreference = $previous
}

Write-Host ""
if ($runExit -eq 0) {
	Write-Host "MyHarness 开发进程已退出。" -ForegroundColor DarkGray
} else {
	Write-Host "MyHarness 开发进程异常退出，退出码 $runExit。" -ForegroundColor Yellow
}
exit $runExit
