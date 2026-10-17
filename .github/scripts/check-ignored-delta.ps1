# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fork-only tooling (lives under .github/, never goes upstream).
#Requires -Version 7.2
<#
.SYNOPSIS
  Run after staging (git add -f -- <exact path>): checks the staged state against the upstream base.

.DESCRIPTION
  Every staged path that the upstream .gitignore ignores must be on the fork's force-add allow-list
  (.github/**, CLAUDE.md, docs/control-api.md, docs/control-api.en.md); build output, dependencies and
  models must never be force-added. The path guard (models/, *.onnx, the vocoder directory,
  ThirdParty/, D3D12 runtimes) is applied to the staged changes as well.
  Same implementation as fork-gate: fork-checks.mjs --index (checks delta, ignored-paths, path-guard).
  Exit code 0 = PASS, 1 = FAIL, 2 = usage or git error. Extra arguments are passed to fork-checks.mjs.

.EXAMPLE
  git add -f -- .github/scripts/gates.ps1
  pwsh .github/scripts/check-ignored-delta.ps1
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$top = (& git -C $PSScriptRoot rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or -not $top) { Write-Error 'check-ignored-delta: not inside a git work tree' -ErrorAction Continue; exit 2 }
Push-Location -LiteralPath $top
try {
    & node (Join-Path $PSScriptRoot 'fork-checks.mjs') --index --only 'delta,ignored-paths,path-guard' @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code
