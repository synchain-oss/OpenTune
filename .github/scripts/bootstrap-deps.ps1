# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fork-only build tooling (lives under .github/, never goes upstream).
#Requires -Version 7.2
<#
.SYNOPSIS
  Fetch and verify the OpenTune (Windows) build dependencies into a shared, read-only deps root.

.DESCRIPTION
  Reads deps.lock.json (next to this script by default). For each dependency:
    - git deps are shallow-cloned at the pinned ref and must resolve to the pinned commit
      (submodules too, for --recursive deps);
    - archive deps (zip / tar.gz / nupkg) are downloaded once into <DownloadsDir>\<name>\,
      checked against the pinned sha256 (and the publisher's own hash when the lock carries one:
      nugetSha512 / publishedSha256), then extracted into <DepsRoot>\<name>\.
  Entries may carry a "platforms" list (windows / macos); only entries for the host (or -Platform) are
  fetched. On macOS the directory links are symbolic links instead of junctions.
  Each finished dependency gets a stamp file (.ot-dep.json). A re-run skips anything whose stamp
  and verify paths are intact (a cached git dependency must also still be at the pinned commit
  according to `git rev-parse HEAD`; an archive dependency is checked against the stamp's sha256 and the
  verify paths only), so the script is safe to run repeatedly and from several lanes
  (a named mutex serialises concurrent runs).

  Download order for archive deps: the fork's source mirror first (mirror.baseUrl in the lock, or
  -MirrorBaseUrl; the URL is <base>/<file>), then the upstream URLs listed in the lock. Every
  candidate is checked against the same pinned sha256, so the mirror is a convenience, never a
  trust root. An empty base URL (the default until the mirror release exists) means upstream only.
  git deps always come from their upstream repository.

  Nothing is ever extracted over an existing directory: work happens in <name>.partial and is
  renamed into place; an invalid existing directory is renamed to <name>.stale-<timestamp>.

  Model weights are never fetched here: a lock entry that points at an *.onnx file is rejected.

.PARAMETER DepsRoot
  Root directory for dependencies, for example D:\opentune-deps.

.PARAMETER LockFile
  Path to deps.lock.json. Defaults to the file next to this script.

.PARAMETER DownloadsDir
  Where downloaded archives are kept. Defaults to <DepsRoot>\_downloads. CI keeps it outside the
  cached deps root so the cache holds only the extracted trees.

.PARAMETER MirrorBaseUrl
  Overrides mirror.baseUrl from the lock. Pass an empty string to disable the mirror.

.PARAMETER LinkInto
  An OpenTune source tree: after installing, create the directory junctions listed in the lock
  (JUCE-master, ThirdParty\<dep>) pointing into DepsRoot. Existing junctions are re-pointed; a real
  directory at a junction path is never touched (the script fails instead).

.PARAMETER Platform
  windows, macos or all. Defaults to the host. Selects which "platforms"-tagged entries are fetched.

.PARAMETER Only
  Restrict to these dependency names.

.PARAMETER IncludeOptional
  Also fetch dependencies marked "optional" (the JUCE 8.0.15 fallback). Alias: -IncludeFallback.

.PARAMETER RecordMissingHashes
  For archive deps whose sha256 pin is empty: compute it, require that any publisher hash in the
  lock matches, and write the sha256 back into the lock file. Without this switch an empty pin
  is an error.

.EXAMPLE
  pwsh -File .github/scripts/bootstrap-deps.ps1 -DepsRoot D:\opentune-deps
.EXAMPLE
  pwsh -File .github/scripts/bootstrap-deps.ps1 -DepsRoot $env:RUNNER_TEMP\ot-deps -LinkInto $env:GITHUB_WORKSPACE
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DepsRoot,
    [string]$LockFile = (Join-Path $PSScriptRoot 'deps.lock.json'),
    [string]$DownloadsDir,
    [string]$MirrorBaseUrl,
    [string]$LinkInto,
    [string[]]$Only,
    [ValidateSet('windows', 'macos', 'all')][string]$Platform,
    [Alias('IncludeFallback')][switch]$IncludeOptional,
    [switch]$RecordMissingHashes
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$StampName = '.ot-dep.json'

# Which host's dependencies to fetch. Entries without a "platforms" list are shared (JUCE, ARA SDK,
# SoundTouch); entries with one are fetched only when the host is listed (or -Platform all).
if (-not $Platform) { $Platform = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'macos' } else { throw 'bootstrap-deps: unsupported host; pass -Platform windows|macos|all' } }

$script:curlExe = if ($IsWindows) { 'curl.exe' } else { 'curl' }
$script:tarExe = if ($IsWindows) { Join-Path $env:SystemRoot 'System32\tar.exe' } else { 'tar' }

function Write-Step([string]$Message) { Write-Host "[bootstrap-deps] $Message" }

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Get-Sha512Base64([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA512]::Create()
        try { [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Test-VerifyPaths([string]$Root, $Dep) {
    foreach ($rel in $Dep.verify) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $rel))) { return $false }
    }
    return $true
}

function Read-Stamp([string]$Root) {
    $p = Join-Path $Root $StampName
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try { return Get-Content -LiteralPath $p -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-Stamp([string]$Root, [hashtable]$Data) {
    $Data['writtenUtc'] = (Get-Date).ToUniversalTime().ToString('o')
    $Data | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Root $StampName) -Encoding utf8NoBOM
}

function Move-Aside([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $aside = "$Path.stale-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
        Write-Step "existing '$Path' is not a verified copy; renaming it to '$aside'"
        Move-Item -LiteralPath $Path -Destination $aside
    }
}

function Remove-Partial([string]$Path) {
    # Only ever called on <name>.partial directories this script created.
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Invoke-Git([string[]]$GitArgs) {
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

function Assert-NoModel($Dep) {
    $refs = @([string]$Dep.name)
    foreach ($p in 'file', 'url', 'urls') { if ($Dep.PSObject.Properties[$p]) { $refs += @($Dep.$p) } }
    foreach ($r in $refs) {
        if ([string]$r -match '(?i)\.onnx(\b|$)|pc_nsf_hifigan') { throw "$($Dep.name): lock entry points at model weights ($r); models are never fetched" }
    }
}

function Install-GitDep($Dep, [string]$Dest) {
    $stamp = Read-Stamp $Dest
    # The stamp only records what an earlier run believed; also ask git what the tree is really at.
    $actualHead = if ($stamp -and (Test-Path -LiteralPath (Join-Path $Dest '.git'))) { ((& git -C $Dest rev-parse HEAD 2>$null) | Out-String).Trim() } else { '' }
    if ($stamp -and $stamp.commit -eq $Dep.commit -and $actualHead -eq $Dep.commit -and (Test-VerifyPaths $Dest $Dep)) {
        Write-Step "$($Dep.name): ok (cached at $($Dep.commit.Substring(0,12)))"
        return [ordered]@{ name = $Dep.name; kind = 'git'; url = $Dep.url; ref = $Dep.ref; commit = $Dep.commit; submodules = $stamp.submodules; path = $Dest; action = 'cached' }
    }
    Move-Aside $Dest
    $partial = "$Dest.partial"
    Remove-Partial $partial

    $cloneArgs = @('-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', $Dep.ref)
    if ($Dep.recursive) { $cloneArgs += @('--recurse-submodules', '--shallow-submodules') }
    $cloneArgs += @($Dep.url, $partial)
    Write-Step "$($Dep.name): git clone $($Dep.url) @ $($Dep.ref)"
    try {
        Invoke-Git $cloneArgs
    } catch {
        if (-not $Dep.recursive) { throw }
        # Some servers refuse shallow fetches of non-tip submodule commits; retry with full submodules.
        Write-Step "$($Dep.name): shallow submodule clone failed, retrying with full submodule history"
        Remove-Partial $partial
        Invoke-Git @('-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', $Dep.ref, '--recurse-submodules', $Dep.url, $partial)
    }

    $head = (& git -C $partial rev-parse HEAD).Trim()
    if ($head -ne $Dep.commit) {
        Remove-Partial $partial
        throw "$($Dep.name): ref '$($Dep.ref)' resolved to $head, expected pinned commit $($Dep.commit). Refusing to use it."
    }
    $subs = @()
    if ($Dep.recursive) {
        $status = & git -C $partial submodule status --recursive
        foreach ($line in $status) {
            if ($line -match '^([ +\-U])([0-9a-f]{40}) (\S+)') {
                if ($Matches[1] -ne ' ') {
                    Remove-Partial $partial
                    throw "$($Dep.name): submodule $($Matches[3]) is not at its recorded commit (status '$($Matches[1])')."
                }
                $subs += "$($Matches[3])@$($Matches[2])"
            }
        }
    }
    if (-not (Test-VerifyPaths $partial $Dep)) {
        Remove-Partial $partial
        throw "$($Dep.name): expected files missing after clone: $($Dep.verify -join ', ')"
    }
    Write-Stamp $partial @{ name = $Dep.name; kind = 'git'; url = $Dep.url; ref = $Dep.ref; commit = $head; submodules = $subs }
    Move-Item -LiteralPath $partial -Destination $Dest
    Write-Step "$($Dep.name): installed at $head"
    return [ordered]@{ name = $Dep.name; kind = 'git'; url = $Dep.url; ref = $Dep.ref; commit = $head; submodules = $subs; path = $Dest; action = 'installed' }
}

# Candidate URLs in order: the fork mirror (when configured), then the upstream URLs from the lock.
function Get-DownloadUrls($Dep) {
    $urls = @()
    # Recording a missing hash must come from the upstream URL only: a mirror would become the root of trust.
    if ($script:mirrorBase -and [string]$Dep.sha256) { $urls += "$($script:mirrorBase)/$([uri]::EscapeDataString([string]$Dep.file))" }
    $urls += @($Dep.urls)
    return $urls
}

function Get-Archive($Dep, [string]$DownloadDir, [ref]$LockChanged) {
    New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
    $file = Join-Path $DownloadDir $Dep.file
    $pin = [string]$Dep.sha256

    if ((Test-Path -LiteralPath $file) -and $pin -and ((Get-Sha256 $file) -eq $pin)) {
        Write-Step "$($Dep.name): download cache hit"
        return [pscustomobject]@{ File = $file; Url = $null }
    }

    $part = "$file.part"
    $lastError = $null
    $usedUrl = $null
    foreach ($url in (Get-DownloadUrls $Dep)) {
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
        Write-Step "$($Dep.name): downloading $url"
        & $script:curlExe --fail --location --retry 3 --retry-delay 2 --silent --show-error --output $part $url
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $part)) {
            # A mirror copy that does not match the pin is discarded and the next URL is tried.
            if ($pin -and $script:mirrorBase -and $url.StartsWith($script:mirrorBase) -and (Get-Sha256 $part) -ne $pin) {
                $lastError = "mirror copy $url does not match the pinned sha256"
                Write-Step "$($Dep.name): $lastError; falling back to upstream"
                continue
            }
            $lastError = $null
            $usedUrl = $url
            break
        }
        $lastError = "curl exit $LASTEXITCODE for $url"
        if ($script:mirrorBase -and $url.StartsWith($script:mirrorBase)) { Write-Step "$($Dep.name): mirror unavailable ($lastError); falling back to upstream" }
    }
    if ($lastError -or -not $usedUrl) { throw "$($Dep.name): all download URLs failed ($lastError)" }

    $actual = Get-Sha256 $part
    $size = (Get-Item -LiteralPath $part).Length
    if ($Dep.PSObject.Properties['size'] -and $Dep.size -and $size -ne [int64]$Dep.size) {
        Remove-Item -LiteralPath $part -Force
        throw "$($Dep.name): size $size does not match pinned size $($Dep.size)"
    }
    if ($Dep.PSObject.Properties['nugetSha512'] -and $Dep.nugetSha512) {
        $sha512 = Get-Sha512Base64 $part
        if ($sha512 -ne $Dep.nugetSha512) {
            Remove-Item -LiteralPath $part -Force
            throw "$($Dep.name): SHA512 $sha512 does not match the NuGet catalog hash $($Dep.nugetSha512)"
        }
        Write-Step "$($Dep.name): NuGet catalog SHA512 matches"
    }
    if ($Dep.PSObject.Properties['publishedSha256'] -and $Dep.publishedSha256 -and $actual -ne $Dep.publishedSha256) {
        Remove-Item -LiteralPath $part -Force
        throw "$($Dep.name): sha256 $actual does not match the publisher's sha256 $($Dep.publishedSha256)"
    }
    if ($pin) {
        if ($actual -ne $pin) {
            Remove-Item -LiteralPath $part -Force
            throw "$($Dep.name): sha256 $actual does not match pin $pin"
        }
    } elseif ($RecordMissingHashes) {
        Write-Step "$($Dep.name): recording sha256 $actual into the lock file"
        $Dep.sha256 = $actual
        $LockChanged.Value = $true
    } else {
        Remove-Item -LiteralPath $part -Force
        throw "$($Dep.name): lock has no sha256 pin (got $actual). Re-run with -RecordMissingHashes after checking the source."
    }
    Move-Item -LiteralPath $part -Destination $file -Force
    return [pscustomobject]@{ File = $file; Url = $usedUrl }
}

function Expand-ArchiveTo($Dep, [string]$Archive, [string]$Target) {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    switch ($Dep.format) {
        { $_ -in @('zip', 'nupkg') } {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            # ExtractToDirectory rejects entries that would land outside $Target.
            [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Target)
        }
        'tar.gz' {
            # Windows bsdtar refuses absolute paths and '..' members by default.
            # 'exclude' skips members Windows cannot create (e.g. SoundTouch's dangling .so symlink).
            $tarArgs = @('-xzf', $Archive, '-C', $Target)
            if ($Dep.PSObject.Properties['exclude']) { foreach ($x in $Dep.exclude) { $tarArgs += @('--exclude', $x) } }
            & $script:tarExe @tarArgs
            if ($LASTEXITCODE -ne 0) { throw "$($Dep.name): tar failed with exit code $LASTEXITCODE" }
        }
        default { throw "$($Dep.name): unknown archive format '$($Dep.format)'" }
    }
    if ($Dep.stripSingleRoot) {
        $children = @(Get-ChildItem -LiteralPath $Target -Force)
        if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
            $inner = $children[0].FullName
            foreach ($item in Get-ChildItem -LiteralPath $inner -Force) {
                Move-Item -LiteralPath $item.FullName -Destination $Target
            }
            Remove-Item -LiteralPath $inner -Force
        }
    }
}

function Install-ArchiveDep($Dep, [string]$Dest, [string]$DownloadsRoot, [ref]$LockChanged) {
    $stamp = Read-Stamp $Dest
    if ($stamp -and $Dep.sha256 -and $stamp.sha256 -eq $Dep.sha256 -and (Test-VerifyPaths $Dest $Dep)) {
        Write-Step "$($Dep.name): ok (cached, sha256 $($Dep.sha256.Substring(0,12)))"
        return [ordered]@{ name = $Dep.name; kind = 'archive'; url = $stamp.url; file = $Dep.file; sha256 = $Dep.sha256; size = $stamp.size; path = $Dest; action = 'cached' }
    }
    $got = Get-Archive $Dep (Join-Path $DownloadsRoot $Dep.name) $LockChanged
    $archive = $got.File
    $source = if ($got.Url) { $got.Url } else { $Dep.urls[0] }
    Move-Aside $Dest
    $partial = "$Dest.partial"
    Remove-Partial $partial
    Write-Step "$($Dep.name): extracting"
    Expand-ArchiveTo $Dep $archive $partial
    if (-not (Test-VerifyPaths $partial $Dep)) {
        Remove-Partial $partial
        throw "$($Dep.name): expected files missing after extraction: $($Dep.verify -join ', ')"
    }
    $size = (Get-Item -LiteralPath $archive).Length
    Write-Stamp $partial @{ name = $Dep.name; kind = 'archive'; url = $source; file = $Dep.file; sha256 = $Dep.sha256; size = $size }
    Move-Item -LiteralPath $partial -Destination $Dest
    Write-Step "$($Dep.name): installed"
    return [ordered]@{ name = $Dep.name; kind = 'archive'; url = $source; file = $Dep.file; sha256 = $Dep.sha256; size = $size; path = $Dest; action = 'installed' }
}

# Junction <Tree>\<rel> -> $Target (a symbolic link on macOS). Re-points an existing link; refuses to
# touch a real directory.
function Set-Junction([string]$Tree, [string]$Rel, [string]$Target) {
    $linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
    $link = Join-Path $Tree ($Rel -replace '/', [string][System.IO.Path]::DirectorySeparatorChar)
    $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($item) {
        if ($item.LinkType -ne $linkType) { throw "$link exists and is not a $($linkType.ToLowerInvariant()). Refusing to touch it; move it away by hand." }
        if ([string]@($item.Target)[0] -ieq $Target) { Write-Step "junction ok: $Rel"; return }
        # Directory.Delete(non-recursive) on a junction removes only the link, never the target's contents.
        [System.IO.Directory]::Delete($link)
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $link) | Out-Null
    New-Item -ItemType $linkType -Path $link -Target $Target | Out-Null
    Write-Step "junction: $Rel -> $Target"
}

# ---------------------------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $LockFile)) { throw "Lock file not found: $LockFile" }
$lock = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json
if ($lock.schema -ne 1) { throw "Unsupported lock schema $($lock.schema)" }

$script:mirrorBase = if ($PSBoundParameters.ContainsKey('MirrorBaseUrl')) { $MirrorBaseUrl }
                     elseif ($lock.PSObject.Properties['mirror'] -and $lock.mirror.PSObject.Properties['baseUrl']) { [string]$lock.mirror.baseUrl }
                     else { '' }
$script:mirrorBase = ([string]$script:mirrorBase).TrimEnd('/')
if ($script:mirrorBase -and $script:mirrorBase -notmatch '^https://') { throw "mirror base URL must be https: $($script:mirrorBase)" }

New-Item -ItemType Directory -Force -Path $DepsRoot | Out-Null
$DepsRoot = (Resolve-Path -LiteralPath $DepsRoot).Path
$downloadsRoot = if ($DownloadsDir) { [System.IO.Path]::GetFullPath($DownloadsDir) } else { Join-Path $DepsRoot '_downloads' }
if ($LinkInto) {
    $LinkInto = (Resolve-Path -LiteralPath $LinkInto).Path
    if (-not (Test-Path -LiteralPath (Join-Path $LinkInto 'CMakeLists.txt'))) { throw "$LinkInto does not look like an OpenTune source tree" }
}
Write-Step "mirror: $(if ($script:mirrorBase) { $script:mirrorBase } else { 'none (upstream URLs only)' })"

$mutex = [System.Threading.Mutex]::new($false, 'Global\OpenTune-deps-bootstrap')
$haveMutex = $false
try {
    try { $haveMutex = $mutex.WaitOne([TimeSpan]::FromMinutes(30)) } catch [System.Threading.AbandonedMutexException] { $haveMutex = $true }
    if (-not $haveMutex) { throw 'Timed out waiting for another bootstrap-deps run to finish.' }

    $lockChanged = $false
    $results = @()
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
    foreach ($dep in $lock.deps) {
        if ($Only -and ($dep.name -notin $Only)) { continue }
        if ($Platform -ne 'all' -and $dep.PSObject.Properties['platforms'] -and $Platform -notin @($dep.platforms)) { continue }
        if ($dep.PSObject.Properties['optional'] -and $dep.optional -and -not $IncludeOptional -and -not $Only) {
            Write-Step "$($dep.name): skipped (optional '$($dep.optional)'; pass -IncludeOptional)"
            continue
        }
        Assert-NoModel $dep
        $dest = Join-Path $DepsRoot $dep.name
        $t0 = $sw.Elapsed.TotalSeconds
        if ($dep.kind -eq 'git') {
            $r = Install-GitDep $dep $dest
        } elseif ($dep.kind -eq 'archive') {
            $r = Install-ArchiveDep $dep $dest $downloadsRoot ([ref]$lockChanged)
        } else {
            throw "$($dep.name): unknown kind '$($dep.kind)'"
        }
        $r['junction'] = $dep.junction
        $r['optional'] = [bool]($dep.PSObject.Properties['optional'] -and $dep.optional)
        $r['seconds'] = [math]::Round($sw.Elapsed.TotalSeconds - $t0, 1)
        $results += [pscustomobject]$r
    }
    } finally {
        # Keep hashes recorded so far even if a later dependency fails.
        if ($lockChanged) {
            $lock | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $LockFile -Encoding utf8NoBOM
            Write-Step "lock file updated: $LockFile"
        }
    }

    # Merge into the manifest so partial (-Only) runs do not drop other entries.
    $manifestPath = Join-Path $DepsRoot 'deps-manifest.json'
    $byName = [ordered]@{}
    if (Test-Path -LiteralPath $manifestPath) {
        try { foreach ($e in (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).deps) { $byName[$e.name] = $e } } catch { }
    }
    foreach ($r in $results) { $byName[$r.name] = $r }
    [ordered]@{
        generatedUtc = (Get-Date).ToUniversalTime().ToString('o')
        lockFile     = (Resolve-Path -LiteralPath $LockFile).Path
        lockSha256   = Get-Sha256 $LockFile
        deps         = @($byName.Values)
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

    if ($LinkInto) {
        # Deps installed by this run, required ones first, so an optional fallback (JUCE 8.0.15)
        # never replaces the default it shares a junction with.
        $linked = @{}
        foreach ($r in @($results | Sort-Object -Stable { $_.optional })) {
            if (-not $r.junction -or $linked.ContainsKey($r.junction)) { continue }
            Set-Junction $LinkInto $r.junction $r.path
            $linked[$r.junction] = $r.name
        }
    }

    $results | Format-Table name, action, seconds, @{ n = 'pin'; e = { if ($_.kind -eq 'git') { $_.commit.Substring(0, 12) } else { $_.sha256.Substring(0, 12) } } } -AutoSize | Out-Host
    Write-Step ("done in {0:N1}s; manifest: {1}" -f $sw.Elapsed.TotalSeconds, $manifestPath)
} finally {
    if ($haveMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
