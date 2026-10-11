param(
    [string]$DotnetPath = 'dotnet',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts\release'),
    [string]$RuntimeCache = (Join-Path $PSScriptRoot 'work\runtime-cache')
)
$ErrorActionPreference = 'Stop'
$releaseRoot = [IO.Path]::GetFullPath($OutputDirectory)
$version = ([xml](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'src\AntigravityHub\AntigravityHub.csproj') -Raw)).Project.PropertyGroup.Version
$packageRoot = Join-Path $releaseRoot 'AntigravityHub'
& (Join-Path $PSScriptRoot 'Build-Release.ps1') -DotnetPath $DotnetPath -OutputPath $packageRoot -RuntimeCache $RuntimeCache
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$windowsZip = Join-Path $releaseRoot "AntigravityHub-$version-Windows-x64.zip"
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'update-manifest.json') -Raw | ConvertFrom-Json
$archive = [IO.Compression.ZipFile]::Open($windowsZip,[IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in @($manifest.Files.Path) + @('update-manifest.json')) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $packageRoot $relative),"AntigravityHub/$relative",[IO.Compression.CompressionLevel]::SmallestSize) | Out-Null
    }
} finally { $archive.Dispose() }
$sourceZip = Join-Path $releaseRoot "AntigravityHub-$version-Source.zip"
git -C $PSScriptRoot archive --format=zip --prefix=AntigravityHub-Source/ -o $sourceZip HEAD
if ($LASTEXITCODE -ne 0) { throw 'Source packaging failed.' }
$checksums = @($windowsZip,$sourceZip) | ForEach-Object { "$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))" }
[IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Output "Release ready: $releaseRoot"
