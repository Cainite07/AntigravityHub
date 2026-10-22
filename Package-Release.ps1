param(
    [string]$DotnetPath = 'dotnet',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts\release'),
    [string]$RuntimeCache = (Join-Path $PSScriptRoot 'work\runtime-cache'),
    [string]$CorePackageDirectory = '',
    [string]$NodePath = 'node'
)
$ErrorActionPreference = 'Stop'
$releaseRoot = [IO.Path]::GetFullPath($OutputDirectory)
$version = ([xml](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'src\AntigravityHub\AntigravityHub.csproj') -Raw)).Project.PropertyGroup.Version
$packageRoot = Join-Path $releaseRoot 'AntigravityHub'
. (Join-Path $PSScriptRoot 'dev/Package-Layout.ps1')
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
& $NodePath (Join-Path $PSScriptRoot 'dev/check-localization.cjs') --output (Join-Path $releaseRoot 'localization-audit.json')
if ($LASTEXITCODE -ne 0) { throw 'Localization audit failed. Review the reported markers before packaging.' }
if (!$CorePackageDirectory) {
    & (Join-Path $PSScriptRoot 'Build-Release.ps1') -DotnetPath $DotnetPath -OutputPath $packageRoot -RuntimeCache $RuntimeCache
} else {
    # Reuse a published core verbatim. Never produce a small update from a newly
    # compiled executable, and never copy private base/state directories.
    $baseline = Get-Content -LiteralPath (Join-Path $CorePackageDirectory 'update-manifest.json') -Raw | ConvertFrom-Json
    if (!$baseline.CoreVersion -or $baseline.CoreSourcesSha256 -ne (Get-CoreSourcesHash $PSScriptRoot)) { throw 'Core sources changed; publish a full core release instead.' }
    if ([version]$version -le [version]$baseline.Version) { throw 'Adaptation release version must increase.' }
    if (Test-Path -LiteralPath $packageRoot) { throw 'Choose a new output directory.' }
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    foreach ($file in $baseline.Files | Where-Object { !(Test-AdaptationPath $_.Path) }) {
        if ($file.Path -match '[\\:]|(^|/)\.\.?(/|$)' -or $file.Path.StartsWith('/')) { throw 'Unsafe baseline file path.' }
        $source = [IO.Path]::GetFullPath((Join-Path $CorePackageDirectory $file.Path))
        if (!$source.StartsWith([IO.Path]::GetFullPath($CorePackageDirectory).TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Baseline path escaped its root.' }
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Sha256) { throw "Baseline core checksum mismatch: $($file.Path)" }
        $destination = Join-Path $packageRoot $file.Path
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    }
    $roots = @('client/maintenance/tools','client/release-2.22.0/source/hans','src/AntigravityHub/integration','docs')
    foreach ($relativeRoot in $roots) {
        $root = Join-Path $PSScriptRoot $relativeRoot
        Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](node_modules|__pycache__|history)[\\/]|\.(pyc|log)$' } | ForEach-Object {
            $relative = $_.FullName.Substring($PSScriptRoot.Length + 1).Replace('\','/').Replace('src/AntigravityHub/integration/','integration/')
            if ($relative.StartsWith('docs/') -and $relative -cnotin @('docs/USAGE.md','docs/CLIENT_ENHANCEMENTS.md','docs/RELEASE_NOTES_1.4.0.md',"docs/RELEASE_NOTES_$version.md")) { return }
            if (!(Test-AdaptationPath $relative)) { return }
            $destination = Join-Path $packageRoot $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination
        }
    }
    $readme = [IO.File]::ReadAllText((Join-Path $CorePackageDirectory 'README.md')).Replace("RELEASE_NOTES_$($baseline.Version).md", "RELEASE_NOTES_$version.md")
    [IO.File]::WriteAllText((Join-Path $packageRoot 'README.md'),$readme,(New-Object Text.UTF8Encoding($false)))
    & (Join-Path $PSScriptRoot 'Write-UpdateManifest.ps1') -Path $packageRoot -CoreVersion $baseline.CoreVersion
}
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
$adaptationZip = Join-Path $releaseRoot "AntigravityHub-$version-Adaptation.zip"
$archive = [IO.Compression.ZipFile]::Open($adaptationZip,[IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in @($manifest.Files.Path | Where-Object { Test-AdaptationPath $_ }) + @('update-manifest.json')) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $packageRoot $relative),"AntigravityHub/$relative",[IO.Compression.CompressionLevel]::SmallestSize) | Out-Null
    }
} finally { $archive.Dispose() }
$catalogPath = Join-Path $releaseRoot 'update-catalog.json'
$clients = @(Get-ChildItem -LiteralPath (Join-Path $packageRoot 'client/maintenance/tools') -Filter 'unified-profile*.json' | ForEach-Object { (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).version } | Sort-Object -Unique)
$catalog = [ordered]@{ Schema=1; Version=$version; CoreVersion=$manifest.CoreVersion; CoreSha256=(Get-CorePackageHash $manifest); Clients=$clients } | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($catalogPath,$catalog + "`n",(New-Object Text.UTF8Encoding($false)))
$sourceZip = Join-Path $releaseRoot "AntigravityHub-$version-Source.zip"
git -C $PSScriptRoot archive --format=zip --prefix=AntigravityHub-Source/ -o $sourceZip HEAD
if ($LASTEXITCODE -ne 0) { throw 'Source packaging failed.' }
$checksums = @($windowsZip,$adaptationZip,$catalogPath,$sourceZip) | ForEach-Object { "$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))" }
[IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Output "Release ready: $releaseRoot"
