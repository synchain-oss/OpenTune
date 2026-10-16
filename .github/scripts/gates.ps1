# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fork-only tooling (lives under .github/, never goes upstream).
#Requires -Version 7.2
<#
.SYNOPSIS
  Local gates for the OpenTune fork. Run inside a lane before opening a PR; paste the table into the PR.

.DESCRIPTION
  The steps follow CLAUDE.md section 8, plus the models\ assertion and gitleaks:
  1. LFS settings: lfs.fetchexclude=* and every tracked *.onnx is still an un-smudged LFS pointer.
  2. Unless -SkipBuild: configure (Ninja Multi-Config), build (RelWithDebInfo, --parallel N) and ctest
     (all registered tests except ARALifecycleContractTests), each through with-build-slot.ps1 (machine-wide
     build slots: 2 by default, -BuildSlots or OPENTUNE_BUILD_SLOTS to change; free-memory check). Every test runs with its own OPENTUNE_DATA_DIR under
     <build>\ot-test-data.
     From -Layer L2 up, a second build in <build>\control-on (-DOPENTUNE_ENABLE_CONTROL_API=ON) builds and runs
     the Control tests (ctest -R Control) as its own row; zero Control tests there is FAIL. SKIP for L0 and -SkipBuild.
  3. Test data isolation: ctest runs in two passes (tests whose name contains Control, then the rest) and
     %APPDATA%\OpenTune is snapshotted (files, sizes, write times) around each. Only a change during the
     Control pass is FAIL (those tests set their own OPENTUNE_DATA_DIR); what the other upstream tests
     write there is reported as known upstream behaviour (the hook is Standalone-only by rule) and the
     row stays PASS. Nothing in the user directory is deleted.
  4. The models\ directories that the upstream POST_BUILD step copies next to the binaries (LFS pointers
     plus a 0-byte vocoder placeholder) would shadow the officially installed models: they are deleted
     and their absence is asserted.
  5. Real Standalone launch, and the real Standalone contract and scenario tests: SKIP until the
     control API exists.
  6. fork-checks.mjs: identity, attribution and every other delta check (same code as the fork-gate
     workflow); layer from -Layer, PR range from -Base.
  6b. drift-pins.mjs --check: .github/drift-pins/, Source/Control/mirror-map.json and MIRRORS.md agree
     (every layer, needs no build).
  7. gitleaks on the delta (commits and files); gitleaks 8.30.1 is fetched and sha256-verified by
     fetch-tool.mjs into -ToolsDir.
  8. Staged state: check-ignored-delta (ignored-path allow-list and path guard on the index).

  Prints a markdown PASS / FAIL / SKIP table headed by the commit SHA and exits 1 when any row FAILs.
  The lane, build and temp directories appear as <lane>, <build> and <tmp>.

  Defaults come from the lane lease (<lanes>\<lane>.lease.json: buildDir, base) when present,
  otherwise <lanes>\<lane>-build and origin/feature/control-api. The configure arguments come from
  <build>\lane.json (written when the lane was created) when present.

.EXAMPLE
  pwsh .github/scripts/gates.ps1 -Layer L0
.EXAMPLE
  pwsh .github/scripts/gates.ps1 -Layer L0 -SkipBuild      # only docs or scripts changed
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('L0', 'L2', 'L3', 'L4', 'L5', 'L6', 'L8')][string]$Layer,
    [switch]$SkipBuild,
    [string]$BuildDir,
    [string]$Base,
    [ValidateRange(1, 64)][int]$Parallel = 8,
    [int]$MinFreeMB = 6144,
    # Machine-wide build slots passed to with-build-slot.ps1 -Slots. Unset: the script's own default
    # (OPENTUNE_BUILD_SLOTS, then 2).
    [ValidateRange(1, 8)][int]$BuildSlots,
    [string]$ToolsDir = (Join-Path ([System.IO.Path]::GetTempPath()) 'ot-tools'),
    [string]$ReportPath
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Config = 'RelWithDebInfo'
$ExcludedTests = @('ARALifecycleContractTests')
$scripts = $PSScriptRoot
$laneRoot = [System.IO.Path]::GetFullPath((& git -C $scripts rev-parse --show-toplevel).Trim())
$laneName = Split-Path -Leaf $laneRoot
$laneParent = Split-Path -Parent $laneRoot

# ---------------------------------------------------------------------------------------------
# Defaults from the lane lease
# ---------------------------------------------------------------------------------------------
$lease = $null
$leaseFile = Join-Path $laneParent "$laneName.lease.json"
if (Test-Path -LiteralPath $leaseFile) {
    try { $lease = Get-Content -LiteralPath $leaseFile -Raw | ConvertFrom-Json } catch { $lease = $null }
}
function Get-LeaseValue([string]$Name) {
    if ($lease -and $lease.PSObject.Properties[$Name] -and $lease.$Name) { return [string]$lease.$Name }
    return $null
}
if (-not $BuildDir) { $BuildDir = Get-LeaseValue 'buildDir' }
if (-not $BuildDir) { $BuildDir = Join-Path $laneParent "$laneName-build" }
$BuildDir = [System.IO.Path]::GetFullPath($BuildDir)
if (-not $Base) {
    $leaseBase = Get-LeaseValue 'base'
    $Base = if (-not $leaseBase) { 'origin/feature/control-api' } elseif ($leaseBase -match '^(origin/|refs/)') { $leaseBase } else { "origin/$leaseBase" }
}
$ToolsDir = [System.IO.Path]::GetFullPath($ToolsDir)

# ---------------------------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------------------------
$tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$redactions = @(
    @($BuildDir, '<build>'),
    @($laneRoot, '<lane>'),
    @($tmpRoot, '<tmp>'),
    @($HOME, '<home>')
)
function Hide-Paths([string]$Text) {
    if (-not $Text) { return '' }
    foreach ($pair in $redactions) {
        $p = [string]$pair[0]
        if (-not $p) { continue }
        foreach ($form in @($p, $p.Replace('\', '/'), $p.Replace('\', '\\'))) {
            $Text = $Text -ireplace [regex]::Escape($form), $pair[1]
        }
    }
    return $Text
}

$rows = [System.Collections.Generic.List[object]]::new()
$script:toolError = ''
function Add-Row([string]$Step, [string]$Result, [string]$Detail) {
    $rows.Add([pscustomobject]@{ Step = $Step; Result = $Result; Detail = (Hide-Paths $Detail) })
    $color = switch ($Result) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
    Write-Host ("[gates] {0,-4} {1}" -f $Result, $Step) -ForegroundColor $color
}

function Format-Seconds([double]$Seconds) { return ('{0:N1} s' -f $Seconds) }

# Run node and parse its JSON stdout; stderr goes to a temp file kept for the error message.
function Invoke-NodeJson([string[]]$Arguments) {
    $err = [System.IO.Path]::GetTempFileName()
    try {
        $out = & node @Arguments 2> $err
        $code = $LASTEXITCODE
        $text = ($out | Out-String)
        $data = $null
        try { $data = $text | ConvertFrom-Json } catch { $data = $null }
        return [pscustomobject]@{ Code = $code; Data = $data; Stderr = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
    } finally {
        Remove-Item -LiteralPath $err -ErrorAction SilentlyContinue
    }
}

function Add-CheckRows([string]$Prefix, $Data) {
    foreach ($r in @($Data.results)) {
        $detail = [string]$r.detail
        if ($r.result -ne 'PASS' -and @($r.problems).Count) {
            $detail += '：' + ((@($r.problems) | Select-Object -First 5) -join '；')
            if (@($r.problems).Count -gt 5) { $detail += "；……共 $(@($r.problems).Count) 项" }
        }
        Add-Row "$Prefix $($r.id)（$($r.title)）" ([string]$r.result) $detail
    }
}

# Fetch a pinned tool; returns the executable path or $null (with the reason in $script:toolError).
function Get-PinnedTool([string]$Name) {
    $err = [System.IO.Path]::GetTempFileName()
    try {
        $out = & node (Join-Path $scripts 'fetch-tool.mjs') $Name --dest $ToolsDir 2> $err
        if ($LASTEXITCODE -eq 0 -and $out) { return ([string]($out | Select-Object -Last 1)).Trim() }
        $script:toolError = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue)
        return $null
    } finally {
        Remove-Item -LiteralPath $err -ErrorAction SilentlyContinue
    }
}

$slot = Join-Path $scripts 'with-build-slot.ps1'
$logDir = Join-Path $BuildDir 'ot-gates'

# Run a command under the machine-wide build slot; output goes to <build>\ot-gates\<label>.log.
function Invoke-InSlot([string]$Label, [string[]]$Command, [switch]$VsDevShell) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $log = Join-Path $logDir "$Label.log"
    $a = @('-NoProfile', '-File', $slot, '-MinFreeMB', "$MinFreeMB")
    if ($VsDevShell) { $a += '-VsDevShell' }
    if ($BuildSlots -ge 1) { $a += @('-Slots', "$BuildSlots") }
    $a += '--'
    $a += $Command
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & pwsh @a *> $log
    $code = $LASTEXITCODE
    $sw.Stop()
    $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
    $own = $null
    if ($text -match 'exit -?\d+ after ([\d.,]+)s') { $own = [double]($Matches[1] -replace ',', '') }
    return [pscustomobject]@{ Code = $code; Wall = $sw.Elapsed.TotalSeconds; Own = $own; Log = $log; Text = $text }
}

function Format-Timing($Run) {
    $own = if ($null -ne $Run.Own) { $Run.Own } else { $Run.Wall }
    $wait = [math]::Max(0, $Run.Wall - $own)
    return "耗时 $(Format-Seconds $own)$(if ($wait -ge 1) { "（另等待构建槽/启动 $(Format-Seconds $wait)）" })"
}

function Get-LogTail($Run, [int]$Lines = 12) {
    if (-not $Run.Text) { return '' }
    return ((($Run.Text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last $Lines) -join ' / ')
}

function Find-Ninja {
    $cmd = Get-Command ninja -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere) {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        $n = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
        if (Test-Path -LiteralPath $n) { return $n }
    }
    throw 'ninja.exe not found (neither on PATH nor in the Visual Studio CMake component)'
}

# Test name -> executable target, read from the generated CTestTestfile.cmake files. (ctest
# --show-only omits the command of tests whose executable has not been built yet, so it cannot be
# used to decide what to build.)
function Get-TestTargets([string]$Dir, $Map = $null) {
    if ($null -eq $Map) { $Map = [ordered]@{} }
    $file = Join-Path $Dir 'CTestTestfile.cmake'
    if (-not (Test-Path -LiteralPath $file)) { return $Map }
    $text = Get-Content -LiteralPath $file -Raw
    foreach ($m in [regex]::Matches($text, 'add_test\(\s*(?:\[=\[([^\]]+)\]=\]|([^\s"]+))\s+"([^"]+)"')) {
        $name = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
        if (-not $Map.Contains($name)) { $Map[$name] = [System.IO.Path]::GetFileNameWithoutExtension($m.Groups[3].Value) }
    }
    foreach ($m in [regex]::Matches($text, 'subdirs\(\s*"([^"]+)"\s*\)')) {
        $sub = $m.Groups[1].Value
        $subDir = if ([System.IO.Path]::IsPathRooted($sub)) { $sub } else { Join-Path $Dir $sub }
        [void](Get-TestTargets $subDir $Map)
    }
    return $Map
}

function Find-ModelDirs {
    if (-not (Test-Path -LiteralPath $BuildDir)) { return @() }
    $roots = @(Get-ChildItem -LiteralPath $BuildDir -Directory -Filter '*_artefacts' -ErrorAction SilentlyContinue)
    $controlOn = Join-Path $BuildDir 'control-on'
    if (Test-Path -LiteralPath $controlOn) { $roots += @(Get-ChildItem -LiteralPath $controlOn -Directory -Filter '*_artefacts' -ErrorAction SilentlyContinue) }
    $found = foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root.FullName -Directory -Recurse -Filter 'models' -ErrorAction SilentlyContinue
    }
    return @($found)
}

# The user's real data directory that upstream tests write to while the OPENTUNE_DATA_DIR hook is
# missing, and a snapshot of it: relative path -> 'dir' or '<size>|<last write ticks>'.
$realDataDir = if ($env:APPDATA) { Join-Path $env:APPDATA 'OpenTune' } else { $null }
function Get-DirSnapshot([string]$Dir) {
    $map = @{}
    if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return $map }
    $map['.'] = 'dir'
    $root = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
    foreach ($i in @(Get-ChildItem -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue)) {
        $rel = $i.FullName.Substring($root.Length)
        $map[$rel] = if ($i.PSIsContainer) { 'dir' } else { "$($i.Length)|$($i.LastWriteTimeUtc.Ticks)" }
    }
    return $map
}
function Compare-DirSnapshot($Before, $After) {
    $created = @($After.Keys | Where-Object { -not $Before.ContainsKey($_) } | Sort-Object)
    $changed = @($After.Keys | Where-Object { $Before.ContainsKey($_) -and $Before[$_] -ne $After[$_] } | Sort-Object)
    $removed = @($Before.Keys | Where-Object { -not $After.ContainsKey($_) } | Sort-Object)
    return [pscustomobject]@{ Created = $created; Changed = $changed; Removed = $removed; Count = $created.Count + $changed.Count + $removed.Count }
}
function Test-DataDirHook {
    $prefs = Join-Path $laneRoot 'Source\Utils\AppPreferences.cpp'
    return (Test-Path -LiteralPath $prefs) -and [bool](Select-String -LiteralPath $prefs -SimpleMatch 'OPENTUNE_DATA_DIR' -Quiet)
}

# Step 3: did the control-layer tests write to the real %APPDATA%\OpenTune? $Control is the change during the
# control-test pass and $Other the change during the remaining upstream tests (both $null when not run).
# Only the control pass can FAIL; what the upstream tests write is reported as known upstream behaviour.
function Get-IsolationVerdict($Control, $Other, [bool]$Hook) {
    $otherCount = if ($null -eq $Other) { 0 } else { [int]$Other.Count }
    if ($null -eq $Control) {
        return [pscustomobject]@{ Status = 'SKIP'; Note = '没有名字含 Control 的测试或 ctest 未运行' }
    }
    if ($Control.Count -gt 0) {
        $examples = @(@($Control.Created) + @($Control.Changed) | Select-Object -First 3 | ForEach-Object { if ($_ -eq '.') { 'OpenTune' } else { "OpenTune\$_" } })
        $what = "控制层测试写入了真实的 %APPDATA%\OpenTune：新建 $(@($Control.Created).Count) 项、修改 $(@($Control.Changed).Count) 项、删除 $(@($Control.Removed).Count) 项$(if ($examples.Count) { "（如 $($examples -join '、')）" })"
        if ($Hook) { return [pscustomobject]@{ Status = 'FAIL'; Note = "$what；OPENTUNE_DATA_DIR 钩子已在代码中，控制层测试仍未隔离" } }
        return [pscustomobject]@{ Status = 'SKIP'; Note = "OPENTUNE_DATA_DIR 钩子尚未合入：$what" }
    }
    $note = '控制层测试前后真实目录无任何新建、修改或删除'
    if ($otherCount -gt 0) {
        $oc = @($Other.Created).Count; $om = @($Other.Changed).Count; $orm = @($Other.Removed).Count
        $note += "；上游测试改动了真实目录：新建 $oc 项、修改 $om 项、删除 $orm 项（已知上游行为：这些测试链接 VST3 共享代码，数据目录钩子按规则只在 Standalone 中生效）"
        if ($orm -eq 0) { $note += '；已检查，未删除用户目录中的任何文件' }
    }
    else { $note += '；其余上游测试也没有写入' }
    return [pscustomobject]@{ Status = 'PASS'; Note = $note }
}
function Add-IsolationRow($Control, $Other, [bool]$RanCtest) {
    $step = '测试数据隔离（真实 %APPDATA%\OpenTune）'
    if (-not $RanCtest) { Add-Row $step 'SKIP' 'ctest 未运行'; return }
    $v = Get-IsolationVerdict $Control $Other (Test-DataDirHook)
    Add-Row $step $v.Status $v.Note
}

# The cmake arguments recorded in <build>\lane.json (without -S / -B), minus any argument matching one of the
# -like patterns in $Drop. Shared by the lane build and the control-on build.
function Get-LaneCmakeArgs([string[]]$Drop = @()) {
    $result = @()
    $laneJson = Join-Path $BuildDir 'lane.json'
    if (-not (Test-Path -LiteralPath $laneJson)) { return $result }
    $cfg = Get-Content -LiteralPath $laneJson -Raw | ConvertFrom-Json
    if (-not $cfg.PSObject.Properties['cmakeArgs']) { return $result }
    $src = @($cfg.cmakeArgs)
    for ($i = 0; $i -lt $src.Count; $i++) {
        if ($src[$i] -in @('-S', '-B')) { $i++; continue }
        $arg = [string]$src[$i]
        if (@($Drop | Where-Object { $arg -like $_ }).Count) { continue }
        $result += $arg
    }
    return $result
}

# Step 2: configure, build and ctest, each under the build slot. Adds the configure/build/ctest rows
# and sets $script:ctestDataDiff to the change of the real data directory during ctest.
$script:ctestDataDiff = $null
$script:ctestControlDiff = $null
function Invoke-BuildSteps {
    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
    $cmakeArgs = @(Get-LaneCmakeArgs)
    if (-not ($cmakeArgs -contains '-G')) { $cmakeArgs += @('-G', 'Ninja Multi-Config', "-DCMAKE_MAKE_PROGRAM=$((Find-Ninja) -replace '\\', '/')") }
    if (-not ($cmakeArgs | Where-Object { $_ -like '-DCMAKE_CONFIGURATION_TYPES=*' })) { $cmakeArgs += "-DCMAKE_CONFIGURATION_TYPES=$Config;Release" }
    if (-not ($cmakeArgs -contains '-DOPENTUNE_BUILD_TESTS=ON')) { $cmakeArgs += '-DOPENTUNE_BUILD_TESTS=ON' }

    $configure = Invoke-InSlot 'configure' (@('cmake', '-S', $laneRoot, '-B', $BuildDir) + $cmakeArgs) -VsDevShell
    if ($configure.Code -ne 0) {
        Add-Row 'configure' 'FAIL' "exit $($configure.Code)；$(Format-Timing $configure)；日志 $($configure.Log)：$(Get-LogTail $configure)"
        Add-Row 'build' 'SKIP' 'configure 失败'
        Add-Row 'ctest' 'SKIP' 'configure 失败'
    } else {
        Add-Row 'configure' 'PASS' "Ninja Multi-Config；$(Format-Timing $configure)"
        # Targets: the Standalone app, the VST3 plug-in and every registered test except the excluded ones.
        $testTargets = Get-TestTargets $BuildDir
        $targets = [System.Collections.Generic.List[string]]::new()
        foreach ($t in @('OpenTuneStandalone_Standalone', 'OpenTune_VST3')) { $targets.Add($t) }
        foreach ($name in @($testTargets.Keys)) {
            if ($ExcludedTests -contains [string]$name) { continue }
            $exe = [string]$testTargets[$name]
            if ($exe -and -not $targets.Contains($exe)) { $targets.Add($exe) }
        }
        if ($testTargets.Count -eq 0) { throw "no tests registered in <build>\CTestTestfile.cmake (OPENTUNE_BUILD_TESTS=ON?)" }
        $build = Invoke-InSlot 'build' (@('cmake', '--build', $BuildDir, '--config', $Config, '--parallel', "$Parallel", '--target') + $targets) -VsDevShell
        if ($build.Code -ne 0) {
            Add-Row 'build' 'FAIL' "exit $($build.Code)；$(Format-Timing $build)；日志 $($build.Log)：$(Get-LogTail $build)"
            Add-Row 'ctest' 'SKIP' 'build 失败'
        } else {
            Add-Row 'build' 'PASS' "$Config，--parallel $Parallel，$($targets.Count) 个目标（Standalone、VST3 与测试，不含 $($ExcludedTests -join '、')）；$(Format-Timing $build)"
            $summaryPath = Join-Path $logDir 'ctest-summary.json'
            Remove-Item -LiteralPath $summaryPath -ErrorAction SilentlyContinue
            # Two passes so the real data directory can be attributed: the control-layer tests (names containing
            # "Control") all set their own OPENTUNE_DATA_DIR and must not touch the real directory at all; the
            # remaining upstream tests link the VST3 shared code, which the data-directory hook does not cover
            # (the hook is Standalone-only by rule), so what they write there is known upstream behaviour.
            $controlNames = @($testTargets.Keys | ForEach-Object { [string]$_ } | Where-Object { $_ -match 'Control' -and $ExcludedTests -notcontains $_ })
            $otherExclude = @($ExcludedTests) + $controlNames
            $summaryControlPath = Join-Path $logDir 'ctest-summary-control.json'
            Remove-Item -LiteralPath $summaryControlPath -ErrorAction SilentlyContinue
            $ctestControl = $null
            $script:ctestControlDiff = $null
            if ($controlNames.Count) {
                $dataBefore = Get-DirSnapshot $realDataDir
                $ctestControl = Invoke-InSlot 'ctest-control' @('pwsh', '-NoProfile', '-File', (Join-Path $scripts 'run-ctest.ps1'), '-BuildDir', $BuildDir, '-Config', $Config,
                    '-Include', 'Control', '-Exclude', ($ExcludedTests -join ','), '-DataRoot', (Join-Path $BuildDir 'ot-test-data-control'), '-SummaryPath', $summaryControlPath)
                $script:ctestControlDiff = Compare-DirSnapshot $dataBefore (Get-DirSnapshot $realDataDir)
            }
            $dataBefore = Get-DirSnapshot $realDataDir
            $ctest = Invoke-InSlot 'ctest' @('pwsh', '-NoProfile', '-File', (Join-Path $scripts 'run-ctest.ps1'), '-BuildDir', $BuildDir, '-Config', $Config,
                '-Exclude', ($otherExclude -join ','), '-DataRoot', (Join-Path $BuildDir 'ot-test-data'), '-SummaryPath', $summaryPath)
            $script:ctestDataDiff = Compare-DirSnapshot $dataBefore (Get-DirSnapshot $realDataDir)
            $summary = $null
            if (Test-Path -LiteralPath $summaryPath) { $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json }
            $sc = $null
            if (Test-Path -LiteralPath $summaryControlPath) { $sc = Get-Content -LiteralPath $summaryControlPath -Raw | ConvertFrom-Json }
            if ($ctestControl -and $ctestControl.Code -ne 0 -and -not $sc) {
                Add-Row 'ctest' 'FAIL' "控制层测试 exit $($ctestControl.Code)；日志 $($ctestControl.Log)：$(Get-LogTail $ctestControl)"
                return
            }
            if ($sc) {
                # Merge the control pass into the overall summary.
                $ctestCodeControl = $ctestControl.Code
                $summary = [pscustomobject]@{
                    passed = [int]$summary.passed + [int]$sc.passed; total = [int]$summary.total + [int]$sc.total
                    failed = @(@($summary.failed) + @($sc.failed)); excluded = @(@($summary.excluded) | Where-Object { $ExcludedTests -contains $_ })
                }
                if ($ctestCodeControl -ne 0) { $ctest = [pscustomobject]@{ Code = $ctestCodeControl; Log = $ctest.Log } }
            }
            $dataNote = '每个测试设置了独立的 OPENTUNE_DATA_DIR=<build>\ot-test-data\<测试名>（是否生效见「测试数据隔离」一行）'
            if ($ctest.Code -eq 0 -and $summary) {
                Add-Row 'ctest' 'PASS' "$($summary.passed)/$($summary.total) 通过（排除 $(@($summary.excluded) -join '、')：在锁定的 ARA SDK 2.3.0 下编不过，属上游问题）；$dataNote；$(Format-Timing $ctest)"
            } elseif ($summary) {
                Add-Row 'ctest' 'FAIL' "失败：$(@($summary.failed) -join '、')（$($summary.passed)/$($summary.total) 通过）；日志在 <build>\ot-test-data；$(Format-Timing $ctest)"
            } else {
                Add-Row 'ctest' 'FAIL' "exit $($ctest.Code)；日志 $($ctest.Log)：$(Get-LogTail $ctest)"
            }
        }
    }
}

# Layer L2 and above: the lane build directory is control-API-off by default, so a change that only touches
# test code could run no Control test at all. Configure, build and run the Control tests once more in
# <build>\control-on with the control API switched on; zero Control tests counts as FAIL. One row.
$script:controlOnDiff = $null
$ControlOnStep = 'control-on（OPENTUNE_ENABLE_CONTROL_API=ON：configure / build / ctest -R Control）'
function Invoke-ControlOnSteps {
    $dir = Join-Path $BuildDir 'control-on'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $cmakeArgs = @(Get-LaneCmakeArgs @('-DOPENTUNE_ENABLE_CONTROL_API=*', '-DOPENTUNE_BUILD_TESTS=*'))
    if (-not ($cmakeArgs -contains '-G')) { $cmakeArgs += @('-G', 'Ninja Multi-Config', "-DCMAKE_MAKE_PROGRAM=$((Find-Ninja) -replace '\\', '/')") }
    if (-not ($cmakeArgs | Where-Object { $_ -like '-DCMAKE_CONFIGURATION_TYPES=*' })) { $cmakeArgs += "-DCMAKE_CONFIGURATION_TYPES=$Config;Release" }
    $cmakeArgs += @('-DOPENTUNE_ENABLE_CONTROL_API=ON', '-DOPENTUNE_BUILD_TESTS=ON')

    $configure = Invoke-InSlot 'control-on-configure' (@('cmake', '-S', $laneRoot, '-B', $dir) + $cmakeArgs) -VsDevShell
    if ($configure.Code -ne 0) {
        Add-Row $ControlOnStep 'FAIL' "configure exit $($configure.Code)；日志 $($configure.Log)：$(Get-LogTail $configure)"
        return
    }
    $testTargets = Get-TestTargets $dir
    $controlNames = @($testTargets.Keys | ForEach-Object { [string]$_ } | Where-Object { $_ -match 'Control' -and $ExcludedTests -notcontains $_ })
    if ($controlNames.Count -eq 0) {
        Add-Row $ControlOnStep 'FAIL' '控制接口打开的构建里没有名字含 Control 的测试（0 个）'
        return
    }
    $targets = @($controlNames | ForEach-Object { [string]$testTargets[$_] } | Where-Object { $_ } | Select-Object -Unique)
    $build = Invoke-InSlot 'control-on-build' (@('cmake', '--build', $dir, '--config', $Config, '--parallel', "$Parallel", '--target') + $targets) -VsDevShell
    if ($build.Code -ne 0) {
        Add-Row $ControlOnStep 'FAIL' "build exit $($build.Code)；日志 $($build.Log)：$(Get-LogTail $build)"
        return
    }
    $summaryPath = Join-Path $logDir 'ctest-summary-control-on.json'
    Remove-Item -LiteralPath $summaryPath -ErrorAction SilentlyContinue
    $dataBefore = Get-DirSnapshot $realDataDir
    $ctest = Invoke-InSlot 'control-on-ctest' @('pwsh', '-NoProfile', '-File', (Join-Path $scripts 'run-ctest.ps1'), '-BuildDir', $dir, '-Config', $Config,
        '-Include', 'Control', '-Exclude', ($ExcludedTests -join ','), '-DataRoot', (Join-Path $dir 'ot-test-data'), '-SummaryPath', $summaryPath)
    $script:controlOnDiff = Compare-DirSnapshot $dataBefore (Get-DirSnapshot $realDataDir)
    $summary = $null
    if (Test-Path -LiteralPath $summaryPath) { $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json }
    if (-not $summary) {
        Add-Row $ControlOnStep 'FAIL' "ctest exit $($ctest.Code)；日志 $($ctest.Log)：$(Get-LogTail $ctest)"
    } elseif ([int]$summary.total -eq 0) {
        Add-Row $ControlOnStep 'FAIL' '运行了 0 个 Control 测试'
    } elseif ($ctest.Code -ne 0) {
        Add-Row $ControlOnStep 'FAIL' "失败：$(@($summary.failed) -join '、')（$($summary.passed)/$($summary.total) 通过）；日志在 <build>\control-on\ot-test-data；$(Format-Timing $ctest)"
    } else {
        Add-Row $ControlOnStep 'PASS' "$($summary.passed)/$($summary.total) 个 Control 测试通过（构建 $($targets.Count) 个目标；$(Format-Timing $build)；$(Format-Timing $ctest)）"
    }
}

# ---------------------------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------------------------
$started = [Diagnostics.Stopwatch]::StartNew()
$sha = '0000000'
$branch = '(unknown)'
$dirty = @()
Push-Location -LiteralPath $laneRoot
try {
    $sha = (& git rev-parse HEAD).Trim()
    $branch = (& git branch --show-current)
    $branch = if ($branch) { $branch.Trim() } else { '(detached)' }
    $dirty = @(& git status --porcelain --untracked-files=no)

    # 1. LFS
    $problems = @()
    $fetchExclude = (& git config --get lfs.fetchexclude)
    if ($fetchExclude -ne '*') { $problems += "lfs.fetchexclude=$fetchExclude（应为 *）" }
    $onnx = @(((& git ls-files -z -- '*.onnx') -join '') -split "`0" | Where-Object { $_ })
    foreach ($f in $onnx) {
        $p = Join-Path $laneRoot $f
        if (-not (Test-Path -LiteralPath $p)) { $problems += "$f 不在工作树中"; continue }
        $len = (Get-Item -LiteralPath $p).Length
        $first = ''
        if ($len -le 1024) { $first = (Get-Content -LiteralPath $p -TotalCount 1) }
        if ($len -gt 1024 -or $first -ne 'version https://git-lfs.github.com/spec/v1') { $problems += "$f 不是未 smudge 的 LFS 指针（$len 字节）" }
    }
    $modelChanges = @(& git status --porcelain -- models)
    if ($modelChanges.Count) { $problems += "models/ 有改动：$($modelChanges -join '；')" }
    if ($problems.Count) { Add-Row 'LFS 设置' 'FAIL' ($problems -join '；') }
    else { Add-Row 'LFS 设置' 'PASS' "lfs.fetchexclude=*；$($onnx.Count) 个 *.onnx 均为未 smudge 的 LFS 指针；models/ 无改动" }

    # 2. configure / build / ctest
    if ($SkipBuild) {
        foreach ($s in 'configure', 'build', 'ctest') { Add-Row $s 'SKIP' '-SkipBuild（只改了文档或脚本）' }
    } else {
        try {
            Invoke-BuildSteps
        } catch {
            Add-Row 'configure / build / ctest' 'FAIL' "$($_.Exception.Message)（$($_.InvocationInfo.PositionMessage -replace '\r?\n', ' ')）"
        }
    }

    # 2b. control API ON build with the Control tests (L2 and above)
    if ($Layer -eq 'L0' -or $SkipBuild) {
        Add-Row $ControlOnStep 'SKIP' $(if ($SkipBuild) { '-SkipBuild（只改了文档或脚本）' } else { 'L0 层不涉及原生代码' })
    } else {
        try {
            Invoke-ControlOnSteps
        } catch {
            Add-Row $ControlOnStep 'FAIL' "$($_.Exception.Message)（$($_.InvocationInfo.PositionMessage -replace '\r?\n', ' ')）"
        }
    }

    # 2c. test data isolation of the control-on ctest pass: any create / change / delete under the real
    # %APPDATA%\OpenTune during that pass is a FAIL (the control tests set their own OPENTUNE_DATA_DIR).
    $isoControlOn = '测试数据隔离（control-on 一轮）'
    if ($Layer -eq 'L0' -or $SkipBuild) { Add-Row $isoControlOn 'SKIP' $(if ($SkipBuild) { '-SkipBuild（ctest 未运行）' } else { 'L0 层不涉及原生代码' }) }
    elseif ($null -eq $script:controlOnDiff) { Add-Row $isoControlOn 'SKIP' 'control-on 的 ctest 未运行' }
    elseif ($script:controlOnDiff.Count -gt 0) {
        $d = $script:controlOnDiff
        $ex = @(@($d.Created) + @($d.Changed) | Select-Object -First 3 | ForEach-Object { if ($_ -eq '.') { 'OpenTune' } else { "OpenTune\$_" } })
        Add-Row $isoControlOn 'FAIL' "control-on 一轮 ctest 写入了真实的 %APPDATA%\OpenTune：新建 $(@($d.Created).Count) 项、修改 $(@($d.Changed).Count) 项、删除 $(@($d.Removed).Count) 项$(if ($ex.Count) { "（如 $($ex -join '、')）" })"
    }
    else { Add-Row $isoControlOn 'PASS' 'control-on 一轮 ctest 前后真实目录无任何新建、修改或删除' }

    # 3. test data isolation
    if ($SkipBuild) { Add-Row '测试数据隔离（真实 %APPDATA%\OpenTune）' 'SKIP' '-SkipBuild（ctest 未运行）' }
    else { Add-IsolationRow $script:ctestControlDiff $script:ctestDataDiff ($null -ne $script:ctestDataDiff) }

    # 4. models\ produced by POST_BUILD must not survive
    $modelDirs = @(Find-ModelDirs)
    $removed = @()
    foreach ($d in $modelDirs) {
        $full = [System.IO.Path]::GetFullPath($d.FullName)
        if (-not $full.StartsWith($BuildDir + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw "refusing to delete outside the build dir: $full" }
        Remove-Item -LiteralPath $full -Recurse -Force
        $removed += $full
    }
    $left = @(Find-ModelDirs)
    if ($left.Count) { Add-Row 'models\ 已删除' 'FAIL' "仍存在：$(($left | ForEach-Object FullName) -join '；')" }
    elseif ($removed.Count) { Add-Row 'models\ 已删除' 'PASS' "删除了 POST_BUILD 生成的 $($removed.Count) 个 models\（$($removed -join '；')），断言已不存在" }
    else { Add-Row 'models\ 已删除' 'PASS' 'build 输出中不存在 POST_BUILD 生成的 models\' }

    # 5. real Standalone launch and contract / scenario tests
    Add-Row 'Standalone 真机启动' 'SKIP' '尚无控制接口（随后续 PR 加入）'
    Add-Row '真 Standalone 契约与场景测试' 'SKIP' '尚无控制接口'

    # 6. fork-checks (identity, attribution and the other delta checks)
    $clangFormat = Get-PinnedTool 'clang-format'
    $fcArgs = @((Join-Path $scripts 'fork-checks.mjs'), '--json', '--layer', $Layer, '--base', $Base, '--head-branch', $branch)
    if ($clangFormat) { $fcArgs += @('--clang-format', $clangFormat) }
    else { $fcArgs += @('--clang-format', (Join-Path $ToolsDir 'clang-format-unavailable')) }
    $fc = Invoke-NodeJson $fcArgs
    if ($null -eq $fc.Data) { Add-Row 'fork-checks' 'FAIL' "fork-checks.mjs 运行失败（exit $($fc.Code)）：$($fc.Stderr)" }
    else { Add-CheckRows 'fork-checks' $fc.Data }

    # 6b. mirror pins: .github/drift-pins/, mirror-map.json and MIRRORS.md agree (needs no build)
    $dpErr = [System.IO.Path]::GetTempFileName()
    try {
        $dpOut = (& node (Join-Path $scripts 'drift-pins.mjs') --check 2> $dpErr | Out-String).Trim()
        $dpCode = $LASTEXITCODE
        $dpRaw = [string](Get-Content -LiteralPath $dpErr -Raw -ErrorAction SilentlyContinue)
        $dpText = ($dpRaw -replace '\r?\n', ' ').Trim()
        if ($dpCode -eq 0) { Add-Row 'drift-pins（镜像锁清单三处一致）' 'PASS' $dpOut }
        else { Add-Row 'drift-pins（镜像锁清单三处一致）' 'FAIL' "exit $dpCode：$dpText" }
    } finally {
        Remove-Item -LiteralPath $dpErr -ErrorAction SilentlyContinue
    }

    # 7. gitleaks
    $gitleaks = Get-PinnedTool 'gitleaks'
    if (-not $gitleaks) { Add-Row 'gitleaks' 'FAIL' "无法获取或校验 gitleaks 8.30.1：$script:toolError" }
    else {
        $gl = Invoke-NodeJson @((Join-Path $scripts 'gitleaks-delta.mjs'), '--json', '--gitleaks', $gitleaks)
        if ($null -eq $gl.Data) { Add-Row 'gitleaks' 'FAIL' "gitleaks-delta.mjs 运行失败（exit $($gl.Code)）：$($gl.Stderr)" }
        else { Add-CheckRows 'gitleaks' $gl.Data }
    }

    # 8. staged state
    $idx = Invoke-NodeJson @((Join-Path $scripts 'fork-checks.mjs'), '--json', '--index', '--only', 'delta,ignored-paths,path-guard')
    if ($null -eq $idx.Data) { Add-Row 'check-ignored-delta' 'FAIL' "fork-checks.mjs --index 运行失败（exit $($idx.Code)）：$($idx.Stderr)" }
    else { Add-CheckRows 'check-ignored-delta（暂存区）' $idx.Data }
} catch {
    Add-Row 'gates 内部错误' 'FAIL' "$($_.Exception.Message)（$($_.InvocationInfo.PositionMessage -replace '\r?\n', ' ')）"
} finally {
    Pop-Location
}
$started.Stop()

# ---------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------
$overall = if ($rows | Where-Object { $_.Result -eq 'FAIL' }) { 'FAIL' } else { 'PASS' }
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("### gates · $($sha.Substring(0, 7)) · $branch · 层 $Layer · $overall")
$lines.Add('')
$lines.Add("提交 ``$sha``$(if ($dirty.Count) { '（工作树另有未提交的改动）' })；base ``$Base``；总耗时 $(Format-Seconds $started.Elapsed.TotalSeconds)")
$lines.Add('')
$lines.Add('| # | 检查 | 结果 | 说明 |')
$lines.Add('|---|---|---|---|')
$n = 0
foreach ($r in $rows) {
    $n++
    $lines.Add("| $n | $($r.Step -replace '\|', '\|') | $($r.Result) | $(($r.Detail -replace '\r?\n', ' ') -replace '\|', '\|') |")
}
$report = ($lines -join "`n") + "`n"
Write-Host ''
Write-Output $report
if ($ReportPath) { Set-Content -LiteralPath $ReportPath -Value $report -Encoding utf8NoBOM }
exit $(if ($overall -eq 'FAIL') { 1 } else { 0 })
