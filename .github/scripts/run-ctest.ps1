# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fork-only build tooling (lives under .github/, never goes upstream).
#Requires -Version 7.2
<#
.SYNOPSIS
  Run the registered ctest tests one at a time, each with its own OPENTUNE_DATA_DIR.

.DESCRIPTION
  Equivalent to `ctest -C <Config> -E ARALifecycleContractTests`, except that every test gets a fresh
  OPENTUNE_DATA_DIR = <DataRoot>\<test name>, so tests never share (or write to the user's real)
  preferences, logs or discovery files once the data-dir hook is in place. gates.ps1 runs this script
  inside with-build-slot.ps1.

  ARALifecycleContractTests is excluded by default: it assigns ARA_DRAFT's persistentID, which the
  ARA SDK 2.3.0 pinned by CMake does not have, so it does not compile (an upstream issue).

  -Include '<regex>' keeps only tests whose name matches (the asan workflow runs `-Include Control`:
  every test with 'Control' in its name, so tests added later are picked up by name).

  Writes a JSON summary to -SummaryPath (when given) and exits 1 when any test fails.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BuildDir,
    [string]$Config = 'RelWithDebInfo',
    [string[]]$Exclude = @('ARALifecycleContractTests'),
    # Regular expression on the test name (PowerShell -match): matching tests are left out as well.
    # Empty = no pattern exclusion.
    [string]$ExcludePattern = '',
    # Regular expression: only tests whose name matches run (like `ctest -R`). Empty = all tests.
    [string]$Include = '',
    [Parameter(Mandatory)][string]$DataRoot,
    [string]$SummaryPath
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
# `pwsh -File` passes "a,b" as one string: accept comma-separated names as well.
$Exclude = @($Exclude | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$listing = (& ctest --test-dir $BuildDir -C $Config --show-only=json-v1) | Out-String | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "ctest --show-only failed ($LASTEXITCODE)" }
$all = @($listing.tests | ForEach-Object { [string]$_.name })
$excluded = @($all | Where-Object { $Exclude -contains $_ -or ($ExcludePattern -and $_ -match $ExcludePattern) })
$tests = @($all | Where-Object { $excluded -notcontains $_ -and (-not $Include -or $_ -match $Include) })
if ($tests.Count -eq 0) { throw "no tests registered in $BuildDir$(if ($Include) { " that match '$Include'" })" }

if (Test-Path -LiteralPath $DataRoot) { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null

$total = [Diagnostics.Stopwatch]::StartNew()
$results = foreach ($name in $tests) {
    if ($name -notmatch '^[A-Za-z0-9_.-]+$') { throw "unexpected test name '$name'" }
    $dir = Join-Path $DataRoot $name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $env:OPENTUNE_DATA_DIR = $dir
    $log = Join-Path $DataRoot "$name.log"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # Escape the name: a '.' in a test name must not act as a regex wildcard in ctest -R.
    & ctest --test-dir $BuildDir -C $Config -R "^$([regex]::Escape($name))`$" --output-on-failure --no-tests=error *> $log
    $code = $LASTEXITCODE
    $sw.Stop()
    Write-Host ('{0,-40} {1,-6} {2,6:N2} s' -f $name, $(if ($code -eq 0) { 'Passed' } else { 'FAILED' }), $sw.Elapsed.TotalSeconds)
    [pscustomobject]@{ name = $name; passed = ($code -eq 0); exitCode = $code; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2) }
}
$total.Stop()
Remove-Item Env:OPENTUNE_DATA_DIR -ErrorAction SilentlyContinue

$failed = @($results | Where-Object { -not $_.passed })
$summary = [ordered]@{
    config   = $Config
    excluded = $excluded
    total    = $tests.Count
    passed   = $tests.Count - $failed.Count
    failed   = @($failed | ForEach-Object { $_.name })
    seconds  = [math]::Round($total.Elapsed.TotalSeconds, 1)
    tests    = @($results)
}
if ($SummaryPath) { $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $SummaryPath -Encoding utf8NoBOM }
Write-Host ("{0}/{1} passed in {2:N1} s; excluded: {3}" -f $summary.passed, $summary.total, $total.Elapsed.TotalSeconds, ($summary.excluded -join ', '))
exit $(if ($failed.Count) { 1 } else { 0 })
