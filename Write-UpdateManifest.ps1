param([Parameter(Mandatory)][string]$Path, [string]$CoreVersion = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev/Package-Layout.ps1')
$packageRoot = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
$version = ([xml](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'src\AntigravityHub\AntigravityHub.csproj') -Raw)).Project.PropertyGroup.Version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$files = @(Get-ChildItem -LiteralPath $packageRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($packageRoot.Length + 1).Replace('\','/')
    if ($relative -eq 'update-manifest.json' -or $relative -match '(^|/)base/|^client/maintenance/state/|\.(log|pdb)$') { return }
    if ($relative -match '(^|/)(accounts\.json|app_settings\.json|oauth_client\.dat|oauth_creds\.json|window_state\.json)$|\.(asar|dat|db|sqlite3)$|^(\.git|\.antigravity_hub|accounts|work|outputs|artifacts|publish)/') {
        throw "Public package contains private state: $relative"
    }
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Package contains a link: $relative" }
    [ordered]@{ Path=$relative; Size=$_.Length; Sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
foreach ($required in @('AntigravityHub.exe','AntigravityHub.dll','AntigravityHub.runtimeconfig.json','wwwroot/index.html')) {
    if ($required -notin $files.Path) { throw "Incomplete package: $required" }
}
if (!$CoreVersion) { $CoreVersion = $version }
$json = [ordered]@{ Schema=1; Version=$version; CoreVersion=$CoreVersion; CoreSourcesSha256=(Get-CoreSourcesHash $PSScriptRoot); Files=$files } | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $packageRoot 'update-manifest.json'), $json, (New-Object Text.UTF8Encoding($false)))
Write-Output "Update manifest: $version / $($files.Count) files"
