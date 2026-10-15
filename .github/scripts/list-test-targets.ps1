# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fork-only build tooling (lives under .github/, never goes upstream).
#Requires -Version 7.2
<#
.SYNOPSIS
  Print the build targets (executables) of the registered ctest tests whose names match a pattern.

.DESCRIPTION
  Reads the generated CTestTestfile.cmake files under -BuildDir (add_test(<name> "<exe>" ...) and
  subdirs(...)), the same parsing that build-windows.yml and gates.ps1 use when they build "every
  registered test". The executable's file name without extension is the CMake target name. Used by
  workflows that build only part of the tests, for example `-Include Control` (the sanitizer
  workflows build and run every test with 'Control' in its name; tests added later join by name).

  One target per line on stdout. Exit 1 when nothing matches.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BuildDir,
    # Regular expression on the test name. Empty = every test.
    [string]$Include = '',
    # Test names to leave out (comma separated or an array).
    [string[]]$Exclude = @()
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$Exclude = @($Exclude | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

function Get-TestTargets([string]$Dir, $Map) {
    $file = Join-Path $Dir 'CTestTestfile.cmake'
    if (-not (Test-Path -LiteralPath $file)) { return }
    $text = Get-Content -LiteralPath $file -Raw
    foreach ($m in [regex]::Matches($text, 'add_test\(\s*(?:\[=\[([^\]]+)\]=\]|([^\s"]+))\s+"([^"]+)"')) {
        $name = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
        if (-not $Map.Contains($name)) { $Map[$name] = [System.IO.Path]::GetFileNameWithoutExtension($m.Groups[3].Value) }
    }
    foreach ($m in [regex]::Matches($text, 'subdirs\(\s*"([^"]+)"\s*\)')) {
        $sub = $m.Groups[1].Value
        Get-TestTargets $(if ([System.IO.Path]::IsPathRooted($sub)) { $sub } else { Join-Path $Dir $sub }) $Map
    }
}

$tests = [ordered]@{}
Get-TestTargets $BuildDir $tests
$targets = [System.Collections.Generic.List[string]]::new()
foreach ($name in @($tests.Keys)) {
    if ($Exclude -contains [string]$name) { continue }
    if ($Include -and ([string]$name -notmatch $Include)) { continue }
    $exe = [string]$tests[$name]
    if ($exe -and -not $targets.Contains($exe)) { $targets.Add($exe) }
}
if ($targets.Count -eq 0) {
    [Console]::Error.WriteLine("list-test-targets: no registered test matches '$Include' under $BuildDir (OPENTUNE_BUILD_TESTS=ON? option ON?)")
    exit 1
}
$targets
