param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
$transaction = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($JobFile))
$resultPath = Join-Path $transaction 'result.json'
$job = $null
$movedOld = $false
$movedNew = $false
$movedUserDirectories = @()

function Assert-PlainPath([string]$Target) {
    $cursor = [IO.Path]::GetFullPath($Target)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Links and junctions are not allowed.' }
        }
        $parentPath = [IO.Path]::GetDirectoryName($cursor)
        if ($parentPath -eq $cursor) { break }
        $cursor = $parentPath
    }
}
function Assert-Within([string]$Base, [string]$Target) {
    $prefix = [IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
    if (-not [IO.Path]::GetFullPath($Target).StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped the transaction boundary.' }
    Assert-PlainPath $Target
}
function Write-Result([string]$Stage, [string]$Message) {
    $result = @{stage=$Stage; message=$Message; time=[DateTime]::UtcNow.ToString('o')}
    if ($job) { $result.version=$job.version; $result.backup=$job.backup; $result.installRoot=$job.installRoot }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json))
    [IO.File]::WriteAllBytes($resultPath + '.tmp',$bytes)
    Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath -Force
    if ($job -and $Stage -ne 'waiting') {
        Assert-PlainPath $job.resultFile
        [IO.File]::WriteAllBytes($job.resultFile + '.tmp',$bytes)
        Move-Item -LiteralPath ($job.resultFile + '.tmp') -Destination $job.resultFile -Force
    }
}
function Assert-Package([string]$Root, [string]$Version, [bool]$AllowMods=$false) {
    Assert-PlainPath $Root
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'kmm-package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'kiriu-mods-manager' -or $manifest.platform -ne 'win32-x64' -or $manifest.version -ne $Version) { throw 'Package identity mismatch.' }
    $seen = @{}
    foreach ($property in $manifest.files.PSObject.Properties) {
        $relative = [string]$property.Name
        if ($relative -match '^(Mods|log)([/\\]|$)') { throw 'Package manifest contains a reserved user directory.' }
        if ($relative -match '(^/|^\\|:|(^|[/\\])\.\.([/\\]|$))') { throw 'Unsafe manifest path.' }
        $target = Join-Path $Root $relative
        Assert-Within $Root $target
        if ($property.Value -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) { throw ('File verification failed: ' + $relative) }
        $seen[$relative.Replace('\','/')] = $true
    }
    $packageEntries = @()
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Force) {
        Assert-PlainPath $entry.FullName
        if ($entry.Name -in @('Mods','log')) {
            if (-not $AllowMods -or -not $entry.PSIsContainer) { throw 'Mods / log are reserved user directories.' }
            continue
        }
        $packageEntries += $entry
        if ($entry.PSIsContainer) { $packageEntries += @(Get-ChildItem -LiteralPath $entry.FullName -Recurse -Force) }
    }
    foreach ($item in $packageEntries) {
        Assert-PlainPath $item.FullName
        if (-not $item.PSIsContainer) {
            $relative = $item.FullName.Substring($Root.TrimEnd('\').Length+1).Replace('\','/')
            if ($relative -ne 'kmm-package.json' -and -not $seen.ContainsKey($relative)) { throw ('Unlisted file: ' + $relative) }
        }
    }
    foreach ($required in @('KiriuModsManager.exe','resources/app/package.json','resources/app/assets/update-helper.ps1')) {
        if (-not $seen.ContainsKey($required)) { throw 'Missing package entry.' }
    }
}
function Move-WithRetry([string]$From, [string]$To) {
    Assert-PlainPath $From
    Assert-PlainPath $To
    if (Test-Path -LiteralPath $To) { throw 'Destination already exists.' }
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        try { Move-Item -LiteralPath $From -Destination $To; return }
        catch { if ($attempt -eq 59) { throw }; Start-Sleep -Milliseconds 500 }
    }
}
function Start-App {
    $env:KMM_UPDATE_JOB = $JobFile
    try { return Start-Process -FilePath (Join-Path $job.installRoot 'KiriuModsManager.exe') -WorkingDirectory $job.installRoot -WindowStyle Hidden -PassThru }
    finally { Remove-Item Env:KMM_UPDATE_JOB -ErrorAction SilentlyContinue }
}
function Move-Mods([string]$FromRoot, [string]$ToRoot, [string]$Name='Mods') {
    if ($Name -notin @('Mods','log')) { throw 'Unrecognized user directory.' }
    Assert-PlainPath $FromRoot
    Assert-PlainPath $ToRoot
    $source = Join-Path $FromRoot $Name
    $destination = Join-Path $ToRoot $Name
    if (-not (Test-Path -LiteralPath $source)) { return }
    Assert-Within $FromRoot $source
    Assert-Within $ToRoot $destination
    if (-not (Get-Item -LiteralPath $source -Force).PSIsContainer) { throw 'User data must be a directory.' }
    Move-WithRetry $source $destination
}
try {
    Assert-PlainPath $JobFile
    if ([IO.Path]::GetFileName($JobFile) -ne 'job.json' -or [IO.Path]::GetFileName($transaction) -notmatch '^\.kmm-update-[\w-]+$') { throw 'Invalid update transaction.' }
    $job = Get-Content -LiteralPath $JobFile -Encoding UTF8 -Raw | ConvertFrom-Json
    $parentPath = [IO.Path]::GetDirectoryName($transaction)
    if ($job.schemaVersion -ne 1 -or $job.pid -le 0 -or [IO.Path]::GetDirectoryName($job.installRoot) -ne $parentPath -or [IO.Path]::GetDirectoryName($job.backup) -ne $parentPath -or [IO.Path]::GetFileName($job.backup) -notmatch '^\.kmm-previous-[a-f0-9-]{36}$') { throw 'Invalid install or backup boundary.' }
    if ([IO.Path]::GetFullPath($job.prepared) -ne (Join-Path $transaction ('unpacked\KiriuModsManager-' + $job.version + '-win-x64'))) { throw 'Invalid prepared path.' }
    Assert-Within $transaction $job.prepared
    Assert-PlainPath $job.backup
    Assert-Package $job.installRoot $job.currentVersion $true
    Assert-Package $job.prepared $job.version
    $owner = Get-Process -Id $job.pid -ErrorAction Stop
    if ($owner.MainModule.FileName -ne (Join-Path $job.installRoot 'KiriuModsManager.exe')) { throw 'Parent executable mismatch.' }
    Write-Result 'waiting' 'Waiting for the current application to exit.'
    if (-not $owner.WaitForExit(60000)) { throw 'Application did not exit; installation unchanged.' }
    Move-WithRetry $job.installRoot $job.backup
    $movedOld = $true
    Move-WithRetry $job.prepared $job.installRoot
    $movedNew = $true
    foreach ($name in @('Mods','log')) {
        if (Test-Path -LiteralPath (Join-Path $job.backup $name)) {
            Move-Mods $job.backup $job.installRoot $name
            $movedUserDirectories += $name
        }
    }
    $newApp = Start-App
    for ($attempt=0; $attempt -lt 120; $attempt++) {
        $ackPath = Join-Path $transaction 'started.json'
        if (Test-Path -LiteralPath $ackPath) {
            $ack = Get-Content -LiteralPath $ackPath -Encoding UTF8 -Raw | ConvertFrom-Json
            if ($ack.version -eq $job.version -and $ack.pid -eq $newApp.Id) { Write-Result 'success' 'Update completed and the new window was loaded.'; exit 0 }
        }
        if ($newApp.HasExited) { throw 'The updated application exited before startup completed.' }
        Start-Sleep -Milliseconds 500
    }
    # A live process without acknowledgement is left intact; the old directory is retained.
    Write-Result 'unconfirmed' 'New application is running but startup is unconfirmed; old package is retained.'
    exit 2
} catch {
    $failure = $_.Exception.Message
    try {
        if ($movedOld) {
            if ($movedNew) {
                foreach ($name in $movedUserDirectories) { Move-Mods $job.installRoot $job.backup $name }
                Move-WithRetry $job.installRoot (Join-Path $transaction 'failed-package')
            }
            Move-WithRetry $job.backup $job.installRoot
            $null = Start-App
            Write-Result 'rolled-back' ('Update failed; previous package restored. ' + $failure)
        } else { Write-Result 'error' $failure }
    } catch { Write-Result 'error' ('Recovery needs manual attention; all package directories retained. ' + $failure + ' / ' + $_.Exception.Message) }
    exit 1
}
