param(
    [string]$DotnetPath = 'dotnet',
    [string]$OutputPath = (Join-Path $PSScriptRoot 'artifacts\AntigravityHub'),
    [string]$RuntimeCache = (Join-Path $PSScriptRoot 'work\runtime-cache'),
    [switch]$IncludeLocalBase
)
$ErrorActionPreference = 'Stop'
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$RuntimeCache = [IO.Path]::GetFullPath($RuntimeCache)
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
& $DotnetPath publish (Join-Path $PSScriptRoot 'src\AntigravityHub') -c Release -r win-x64 --self-contained true -o $OutputPath --nologo
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
$runtime = Join-Path $OutputPath 'client\runtime'
$nodeDest = Join-Path $runtime 'node'
New-Item -ItemType Directory -Path $nodeDest -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe'),(Join-Path $nodeRoot 'LICENSE') -Destination $nodeDest -Force
Expand-Archive -LiteralPath $pythonZip -DestinationPath (Join-Path $runtime 'python') -Force
$toolDest = Join-Path $OutputPath 'client\maintenance\tools'
Copy-Item -LiteralPath (Join-Path $tools 'node_modules') -Destination $toolDest -Recurse -Force
if ($IncludeLocalBase) {
    # For private local trials only. Public packages cache the user's clean installation automatically.
    $base = Join-Path $PSScriptRoot 'client\release-2.22.0\base'
    Copy-Item -LiteralPath $base -Destination (Join-Path $OutputPath 'client\release-2.22.0') -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $OutputPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE') -Destination $OutputPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.md') -Destination $OutputPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination $OutputPath -Recurse -Force
Write-Output "Ready: $OutputPath"
