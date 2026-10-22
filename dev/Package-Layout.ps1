function Test-AdaptationPath([string]$Relative) {
    return ($Relative -cmatch '^client/release-[^/]+/source/hans/' -or
        ($Relative.StartsWith('client/maintenance/tools/') -and !$Relative.StartsWith('client/maintenance/tools/node_modules/') -and
            $Relative -cnotin @('client/maintenance/tools/package.json','client/maintenance/tools/package-lock.json')) -or
        $Relative.StartsWith('integration/') -or $Relative.StartsWith('docs/') -or $Relative -ceq 'README.md')
}
function Get-CoreSourcesHash([string]$Repo) {
    # Normalizing the public version permits adaptation-only patch releases while
    # any C#, frontend, dependency or build change still requires a new core.
    $paths = @(Get-ChildItem -LiteralPath (Join-Path $Repo 'src/AntigravityHub') -Recurse -File | Where-Object {
        $_.FullName -notmatch '[\\/](bin|obj|integration)[\\/]' -and $_.Extension -ne '.pdb'
    }) + @(Get-Item -LiteralPath (Join-Path $Repo 'Build-Release.ps1'),(Join-Path $Repo 'client/maintenance/tools/package-lock.json'),(Join-Path $Repo 'client/maintenance/tools/package.json'))
    $lines = @($paths | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Repo.Length + 1).Replace('\','/')
        $bytes = [IO.File]::ReadAllBytes($_.FullName)
        if ($_.Extension -eq '.csproj') { $bytes = [Text.Encoding]::UTF8.GetBytes(([Text.Encoding]::UTF8.GetString($bytes) -replace '<Version>[^<]+</Version>','<Version>CORE</Version>')) }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { "$relative`t$([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant())`n" } finally { $sha.Dispose() }
    })
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join '')))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Get-CorePackageHash($Manifest) {
    [string[]]$ordered = @($Manifest.Files | Where-Object { !(Test-AdaptationPath $_.Path) } | ForEach-Object { $_.Path })
    [Array]::Sort($ordered,[StringComparer]::Ordinal)
    $lookup = @{}; foreach ($file in $Manifest.Files) { $lookup[$file.Path] = $file }
    $lines = @($ordered | ForEach-Object {
        $file = $lookup[$_]
        "$($file.Path)`t$($file.Size)`t$($file.Sha256.ToLowerInvariant())`n"
    })
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join '')))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
