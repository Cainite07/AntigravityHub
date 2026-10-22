param([string]$DotnetPath = 'dotnet')
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    $sdkVersion = & $DotnetPath --version
    if ($LASTEXITCODE -ne 0 -or [int]($sdkVersion.Split('.')[0]) -lt 10) { throw '需要 .NET 10 SDK。' }
    function Invoke-Check([string[]]$Arguments) {
        & $DotnetPath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "检查失败：$($Arguments -join ' ')" }
    }
    New-Item -ItemType Directory -Path 'outputs','work' -Force | Out-Null
    Invoke-Check @('build','src/AntigravityHub','-c','Release','--nologo')
    foreach ($mode in @('--client-restart-only','--client-settings-only','--date-window-only','--settings-cache-only','--reliability-only','--current-login-only','--history-safety-only','--aggregation-only','--snapshot-cache-only')) {
        Invoke-Check @('run','--project','tests/AuditHarness','--',$mode)
    }
    Invoke-Check @('run','--project','tests/WpfHarness')
    $env:DOTNET_ROOT = Split-Path -Parent (Get-Command $DotnetPath).Source
    Invoke-Check @('run','--project','tests/UpdateHarness','-c','Release')
    node --check 'src/AntigravityHub/wwwroot/app.js'
    if ($LASTEXITCODE -ne 0) { throw '页面脚本语法检查失败。' }
    node 'client/release-2.22.0/source/hans/tests/test_archive_layouts.js'
    if ($LASTEXITCODE -ne 0) { throw '归档与历史提示汉化检查失败。' }
    foreach ($test in @('localization-audit.cjs','frontend-regression.cjs','hud-regression.cjs','hud-focused.cjs','activity-time.cjs','session-speed.cjs','client-settings.cjs','client-quit.cjs','translation-switches.cjs','client-2230.cjs','client-package.cjs')) {
        node (Join-Path 'tests' $test)
        if ($LASTEXITCODE -ne 0) { throw "检查失败：$test" }
    }
    Write-Output 'PASS: all isolated checks; no real account, IDE or installation changes.'
} finally { Pop-Location }
