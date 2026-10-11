param(
    [string]$DotnetPath = 'dotnet',
    [string]$OutputPath = (Join-Path $PSScriptRoot 'artifacts\AntigravityHub'),
    [string]$RuntimeCache = (Join-Path $PSScriptRoot 'work\runtime-cache'),
    [switch]$IncludeLocalBase
)
$ErrorActionPreference = 'Stop'
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$RuntimeCache = [IO.Path]::GetFullPath($RuntimeCache)
if ((Test-Path -LiteralPath $OutputPath) -and (Get-ChildItem -LiteralPath $OutputPath -Force | Select-Object -First 1)) {
    throw '请选择一个空的发布目录，避免把旧文件或本地数据带入发布包。'
}
New-Item -ItemType Directory -Path $RuntimeCache,$OutputPath -Force | Out-Null
function Get-VerifiedArchive([string]$Name,[string]$Url,[string]$Sha256) {
    $file = Join-Path $RuntimeCache $Name
    if (!(Test-Path -LiteralPath $file)) { Invoke-WebRequest $Url -OutFile $file }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw "Runtime checksum mismatch: $Name" }
    return $file
}
$nodeZip = Get-VerifiedArchive 'node-v24.19.0-win-x64.zip' 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip' '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
$pythonZip = Get-VerifiedArchive 'python-3.14.8-embed-amd64.zip' 'https://www.python.org/ftp/python/3.14.8/python-3.14.8-embed-amd64.zip' 'a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310'
$nodeExpanded = Join-Path $RuntimeCache 'node'
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExpanded -Force
$nodeRoot = Join-Path $nodeExpanded 'node-v24.19.0-win-x64'
$tools = Join-Path $PSScriptRoot 'client\maintenance\tools'
Push-Location -LiteralPath $tools
try {
    & (Join-Path $nodeRoot 'npm.cmd') ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency preparation failed.' }
} finally { Pop-Location }
& $DotnetPath publish (Join-Path $PSScriptRoot 'src\AntigravityHub') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=false -p:IncludeAllContentForSelfExtract=false -p:DebugType=None -p:DebugSymbols=false -o $OutputPath --nologo
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
# Keep these two small compatibility files: existing 1.4.0 update validators
# require them. Managed dependencies load from the bundle without disk extraction.
$managedOutput = Join-Path $PSScriptRoot 'src\AntigravityHub\bin\Release\net10.0-windows\win-x64'
Copy-Item -LiteralPath (Join-Path $managedOutput 'AntigravityHub.dll'),(Join-Path $managedOutput 'AntigravityHub.runtimeconfig.json') -Destination $OutputPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src\AntigravityHub\app.ico') -Destination $OutputPath -Force
$runtime = Join-Path $OutputPath 'client\runtime'
$nodeDest = Join-Path $runtime 'node'
New-Item -ItemType Directory -Path $nodeDest -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe'),(Join-Path $nodeRoot 'LICENSE') -Destination $nodeDest -Force
Expand-Archive -LiteralPath $pythonZip -DestinationPath (Join-Path $runtime 'python') -Force
$toolDest = Join-Path $OutputPath 'client\maintenance\tools'
$modulesRoot = Join-Path $tools 'node_modules'
Get-ChildItem -LiteralPath $modulesRoot -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($modulesRoot.Length + 1)
    # Type declarations, source maps and development command shims are never
    # loaded by the maintenance scripts. Preserve executable JS, metadata and licenses.
    if ($relative -match '^\.bin[\\/]|\.map$|\.d\.ts$|\.(cmd|ps1)$') { return }
    $destination = Join-Path (Join-Path $toolDest 'node_modules') $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
if ($IncludeLocalBase) {
    # For private local trials only. Public packages cache the user's clean installation automatically.
    $base = Join-Path $PSScriptRoot 'client\release-2.22.0\base'
    Copy-Item -LiteralPath $base -Destination (Join-Path $OutputPath 'client\release-2.22.0') -Recurse -Force
}
$packageReadme = @'
# AntigravityHub

双击 **AntigravityHub.exe** 启动，无需安装 .NET、Node.js 或 Python。

支持账号切换、用量统计、客户端状态栏、独立汉化开关和窗口尺寸设置。
首次运行默认最小化到托盘，双击托盘图标打开。

- [使用与配置](docs/USAGE.md)
- [客户端增强与回退](docs/CLIENT_ENHANCEMENTS.md)
- [版本说明](docs/RELEASE_NOTES_1.4.0.md)
- [完整介绍、演示图片与源码](https://github.com/Cainite07/AntigravityHub)

请保留程序旁边的文件和文件夹。账号与设置保存在用户目录中，更新时保留。
'@
[IO.File]::WriteAllText((Join-Path $OutputPath 'README.md'), $packageReadme + "`n", (New-Object Text.UTF8Encoding($false)))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE') -Destination $OutputPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.md') -Destination $OutputPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination $OutputPath -Recurse -Force
$docsRoot = Join-Path $PSScriptRoot 'docs'
Get-ChildItem -LiteralPath $docsRoot -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($docsRoot.Length + 1)
    if ($relative -in @('USAGE.md','CLIENT_ENHANCEMENTS.md','RELEASE_NOTES_1.4.0.md')) {
        $destination = Join-Path (Join-Path $OutputPath 'docs') $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
}
& (Join-Path $PSScriptRoot 'Write-UpdateManifest.ps1') -Path $OutputPath
Write-Output "Ready: $OutputPath"
