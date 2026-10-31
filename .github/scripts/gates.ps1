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
  1. LFS settings: lfs.fetchexclude=* and every tracked *.onnx (none since upstream 2c01847, which stopped
     tracking models) is still an un-smudged LFS pointer; models/ has no changes.
  2. Unless -SkipBuild: configure (Ninja Multi-Config), build (RelWithDebInfo, --parallel N) and ctest
     (all registered tests), each through with-build-slot.ps1 (machine-wide
     build slots: 2 by default, -BuildSlots or OPENTUNE_BUILD_SLOTS to change; free-memory check). Every test runs with its own OPENTUNE_DATA_DIR under
     <build>\ot-test-data. Before configuring, the 0-byte model placeholders that the upstream POST_BUILD step
     copies (models\fcpe.onnx, the vocoder file) are created when missing: upstream stopped tracking models
     with 2c01847, and both paths are ignored by git.
     From -Layer L2 up, a second build in <build>\control-on (-DOPENTUNE_ENABLE_CONTROL_API=ON) is made as the
     CI job with the option ON makes it: the Standalone app, the VST3 plug-in and every registered test are
     built, and every test runs, each with its own OPENTUNE_DATA_DIR
     (two passes: the Control tests, then the rest). One row; zero Control tests there is FAIL. SKIP for L0 and -SkipBuild.
  3. Test data isolation: %APPDATA%\OpenTune is snapshotted (files, sizes, write times) around the
     Control pass of each build. A change to anything but the Logs folder during that pass is FAIL (those
     tests set their own OPENTUNE_DATA_DIR); a change in Logs only is WARN, because with several lanes at work
     another process's default-build tests write real logs in the same window. What the other upstream
     tests write there is reported as not isolated (JUCE asks the system for the AppData folder, so pointing
     the APPDATA variable elsewhere would not redirect it, and the data-dir hook is Standalone-only by rule).
     Nothing in the user directory is deleted.
     Builds get a private MSVC PDB server (_MSPDBSRV_ENDPOINT_ = ot-<lane>-build) unless the variable is set,
     so another project's mspdbsrv on the machine cannot make the build fail with C1041. No process is stopped.
  4. The models\ directories that the upstream POST_BUILD step copies next to the binaries (the 0-byte
     placeholders) would shadow the officially installed models: they are deleted
     and their absence is asserted.
  5. Real Standalone launch, and the real Standalone contract and scenario tests: SKIP until the
     control API exists.
  6. fork-checks.mjs: identity, attribution and every other delta check (same code as the fork-gate
     workflow); layer from -Layer, PR range from -Base.
  6b. drift-pins.mjs --check: .github/drift-pins/, Source/Control/mirror-map.json and MIRRORS.md agree
      (needs no build; same rule as fork-gate, from the files changed against -Base plus uncommitted and untracked files: a mismatch is FAIL when this
      branch touches the pin files or drift-pins.mjs, otherwise WARN because the manager L0 follow-up regenerates the pins)
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
    # Upstream mirror ref for the delta ("our increment" = commits not in upstream/* tags or this ref). Unset:
    # fork-checks.mjs picks origin/upstream-mirror, then upstream-mirror. A sync branch based on a newer upstream
    # snapshot than origin/upstream-mirror passes that snapshot's tag here.
    [string]$Mirror,
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
# Tests left out of build and ctest. None: ARALifecycleContractTests, which did not compile under the pinned ARA
# SDK 2.3.0 until upstream 20261008-addb4f4, builds and passes since upstream 2c01847.
$ExcludedTests = @()
# The git-ignored files the upstream POST_BUILD step copies next to the binaries. Upstream stopped tracking models
# with 2c01847, so a clean checkout lacks them and the build would fail at the copy; 0-byte placeholders stand in
# (never committed, never a real model).
$ModelPlaceholders = @('pc_nsf_hifigan_44.1k_ONNX/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.onnx', 'models/fcpe.onnx')
$scripts = $PSScriptRoot
$laneRoot = [System.IO.Path]::GetFullPath((& git -C $scripts rev-parse --show-toplevel).Trim())
$laneName = Split-Path -Leaf $laneRoot
$laneParent = Split-Path -Parent $laneRoot
# MSVC's mspdbsrv is shared machine-wide by default; a build that meets another project's instance can fail with
# C1041. A private endpoint per lane gives this lane's cl.exe its own server (no process is stopped).
if (-not $env:_MSPDBSRV_ENDPOINT_) { $env:_MSPDBSRV_ENDPOINT_ = 'ot-' + ($laneName -replace '[^A-Za-z0-9_-]', '_') + '-build' }

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

# The run-ctest.ps1 arguments that leave the named tests out; none when the list is empty (an empty argument would
# be dropped by the command line and swallow the next parameter name).
function Get-ExcludeArgs([string[]]$Names) {
    $list = @($Names | Where-Object { $_ })
    if ($list.Count -eq 0) { return @() }
    return @('-Exclude', ($list -join ','))
}

# Creates the missing model placeholders (see $ModelPlaceholders); returns the relative paths it created.
function New-ModelPlaceholders {
    $created = [System.Collections.Generic.List[string]]::new()
    foreach ($rel in $ModelPlaceholders) {
        $path = Join-Path $laneRoot $rel
        if (Test-Path -LiteralPath $path) { continue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        New-Item -ItemType File -Path $path | Out-Null
        $created.Add($rel)
    }
    return , $created.ToArray()
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

# The failed test names of ctest summaries (run-ctest.ps1), in order. A summary that is $null, has no `failed`
# member or a null one adds nothing: @($s.failed) of a null member is one $null element, which would be counted as a
# failed test (and reading a missing member stops the script under strict mode).
function Get-FailedTestNames([object[]]$Summaries) {
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($s in @($Summaries)) {
        if ($null -eq $s -or $null -eq $s.PSObject.Properties['failed']) { continue }
        foreach ($name in @($s.failed)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$name)) { $names.Add([string]$name) }
        }
    }
    return , $names.ToArray()
}

# A member of a ctest summary (run-ctest.ps1) or $Default: a summary that is $null, has no such member or a null one
# gives $Default, because reading a missing member stops the script under strict mode (as `failed` above).
function Get-SummaryMember($Summary, [string]$Name, $Default = $null) {
    if ($null -eq $Summary) { return $Default }
    $property = $Summary.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}
# A count member of a ctest summary as an integer, 0 when the summary does not have it.
function Get-SummaryCount($Summary, [string]$Name) {
    return [int](Get-SummaryMember $Summary $Name 0)
}
# The names in the excluded / failed list of a ctest summary, without the empty ones (see Get-FailedTestNames). An empty
# list comes out of a function as $null, so a caller that needs .Count or an array wraps the call in @().
function Get-SummaryNames($Summary, [string]$Name) {
    return @(@(Get-SummaryMember $Summary $Name @()) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
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
    $count = $created.Count + $changed.Count + $removed.Count
    # The Logs folder takes new files whenever any OpenTune process runs, other lanes' default-build tests included.
    $logCount = @(@($created) + @($changed) + @($removed) | Where-Object { $_ -match '^Logs(\\|$)' }).Count
    return [pscustomobject]@{ Created = $created; Changed = $changed; Removed = $removed; Count = $count; LogCount = $logCount; SettingsCount = $count - $logCount }
}
# The names of the log files a snapshot comparison found created, changed or removed (at most 20, otherwise the total).
# AppLogger names its files by date (juce::FileLogger::createDateStampedLogger), with no pid, so a log cannot be tied
# to this run's ctest processes: the names are listed for a human to judge, the row stays WARN.
function Get-LogNameList($Diff) {
    $names = @(@($Diff.Created) + @($Diff.Changed) + @($Diff.Removed) | Where-Object { $_ -match '^Logs\\.' } | ForEach-Object { Split-Path -Leaf $_ } | Sort-Object -Unique)
    if ($names.Count -le 20) { return "$($names -join '、')" }
    return "共 $($names.Count) 个，前 20 个为 $(($names | Select-Object -First 20) -join '、')"
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
        # No control pass: the build has no test with "Control" in its name (the lane's default build has the control
        # API switched off, so none is registered). ctest itself did run for the other tests when $Other is set.
        $note = '本构建没有名字含 Control 的测试（控制接口关闭，控制层测试只在 control-on 一轮注册），所以没有可判定的控制层测试；其余上游测试的 ctest 已运行'
        if ($otherCount -gt 0) { $note += "（它们改动了真实目录：新建 $(@($Other.Created).Count) 项、修改 $(@($Other.Changed).Count) 项、删除 $(@($Other.Removed).Count) 项；已知上游行为）" }
        return [pscustomobject]@{ Status = 'SKIP'; Note = "$note；控制层测试的隔离见「测试数据隔离（control-on 一轮）」一行" }
    }
    if ($Control.Count -gt 0) {
        $examples = @(@($Control.Created) + @($Control.Changed) | Select-Object -First 3 | ForEach-Object { if ($_ -eq '.') { 'OpenTune' } else { "OpenTune\$_" } })
        $what = "控制层测试写入了真实的 %APPDATA%\OpenTune：新建 $(@($Control.Created).Count) 项、修改 $(@($Control.Changed).Count) 项、删除 $(@($Control.Removed).Count) 项$(if ($examples.Count) { "（如 $($examples -join '、')）" })"
        if ($Control.SettingsCount -eq 0) {
            return [pscustomobject]@{ Status = 'WARN'; Note = "$what；变化只在 Logs 目录，设置文件未变（新增或改动的日志文件：$(Get-LogNameList $Control)）：日志文件名只含日期、不含进程号，无法判断是否属于本轮 ctest；多条 lane 并发时别的进程的测试也会写真实日志，所以只记 WARN，不判 FAIL" }
        }
        if ($Hook) { return [pscustomobject]@{ Status = 'FAIL'; Note = "$what；OPENTUNE_DATA_DIR 钩子已在代码中，控制层测试仍未隔离" } }
        return [pscustomobject]@{ Status = 'SKIP'; Note = "OPENTUNE_DATA_DIR 钩子尚未合入：$what" }
    }
    $note = '控制层测试前后真实目录无任何新建、修改或删除'
    if ($otherCount -gt 0) {
        $oc = @($Other.Created).Count; $om = @($Other.Changed).Count; $orm = @($Other.Removed).Count
        $note += "；上游测试不隔离：它们改动了真实目录（新建 $oc 项、修改 $om 项、删除 $orm 项；已知上游行为，这些测试链接 VST3 共享代码，数据目录钩子按规则只在 Standalone 中生效，而 JUCE 向系统取 AppData 目录，改 APPDATA 变量重定向不了）"
        if ($orm -eq 0) { $note += '；已检查，未删除用户目录中的任何文件' }
    }
    else { $note += '；其余上游测试也没有写入' }
    return [pscustomobject]@{ Status = 'PASS'; Note = $note }
}
function Add-IsolationRow($Control, $Other, [bool]$RanCtest) {
    $step = '测试数据隔离（真实 %APPDATA%\OpenTune）'
    if (-not $RanCtest) {
        $why = if ($script:ctestNotRunReason) { $script:ctestNotRunReason } else { '没有 ctest 结果可比对（见 configure / build / ctest 各行）' }
        Add-Row $step 'SKIP' $why
        return
    }
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
# Why no ctest ran (configure or build failed), for the isolation row; $null when nothing says so.
$script:ctestNotRunReason = $null
function Invoke-BuildSteps {
    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
    New-ModelPlaceholders | Out-Null
    $cmakeArgs = @(Get-LaneCmakeArgs)
    if (-not ($cmakeArgs -contains '-G')) { $cmakeArgs += @('-G', 'Ninja Multi-Config', "-DCMAKE_MAKE_PROGRAM=$((Find-Ninja) -replace '\\', '/')") }
    if (-not ($cmakeArgs | Where-Object { $_ -like '-DCMAKE_CONFIGURATION_TYPES=*' })) { $cmakeArgs += "-DCMAKE_CONFIGURATION_TYPES=$Config;Release" }
    if (-not ($cmakeArgs -contains '-DOPENTUNE_BUILD_TESTS=ON')) { $cmakeArgs += '-DOPENTUNE_BUILD_TESTS=ON' }

    $configure = Invoke-InSlot 'configure' (@('cmake', '-S', $laneRoot, '-B', $BuildDir) + $cmakeArgs) -VsDevShell
    if ($configure.Code -ne 0) {
        Add-Row 'configure' 'FAIL' "exit $($configure.Code)；$(Format-Timing $configure)；日志 $($configure.Log)：$(Get-LogTail $configure)"
        Add-Row 'build' 'SKIP' 'configure 失败'
        Add-Row 'ctest' 'SKIP' 'configure 失败'
        $script:ctestNotRunReason = 'configure 失败，ctest 未运行'
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
            $script:ctestNotRunReason = 'build 失败，ctest 未运行'
        } else {
            Add-Row 'build' 'PASS' "$Config，--parallel $Parallel，$($targets.Count) 个目标（Standalone、VST3 与全部已注册测试）；$(Format-Timing $build)"
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
                $ctestControl = Invoke-InSlot 'ctest-control' (@('pwsh', '-NoProfile', '-File', (Join-Path $scripts 'run-ctest.ps1'), '-BuildDir', $BuildDir, '-Config', $Config,
                    '-Include', 'Control') + (Get-ExcludeArgs $ExcludedTests) + @('-DataRoot', (Join-Path $BuildDir 'ot-test-data-control'), '-SummaryPath', $summaryControlPath))
                $script:ctestControlDiff = Compare-DirSnapshot $dataBefore (Get-DirSnapshot $realDataDir)
            }
            $dataBefore = Get-DirSnapshot $realDataDir
            $ctest = Invoke-InSlot 'ctest' (@('pwsh', '-NoProfile', '-File', (Join-Path $scripts 'run-ctest.ps1'), '-BuildDir', $BuildDir, '-Config', $Config) +
                (Get-ExcludeArgs $otherExclude) + @('-DataRoot', (Join-Path $BuildDir 'ot-test-data'), '-SummaryPath', $summaryPath))
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
                    passed = (Get-SummaryCount $summary 'passed') + (Get-SummaryCount $sc 'passed')
                    total = (Get-SummaryCount $summary 'total') + (Get-SummaryCount $sc 'total')
                    failed = Get-FailedTestNames @($summary, $sc)
                    excluded = @(Get-SummaryNames $summary 'excluded' | Where-Object { $ExcludedTests -contains $_ })
                }
                if ($ctestCodeControl -ne 0) { $ctest = [pscustomobject]@{ Code = $ctestCodeControl; Log = $ctest.Log } }
            }
            $dataNote = '每个测试设置了独立的 OPENTUNE_DATA_DIR=<build>\ot-test-data\<测试名>（是否生效见「测试数据隔离」一行）'
            if ($ctest.Code -eq 0 -and $summary) {
                $excludedNote = if ($ExcludedTests.Count) { "（排除 $((Get-SummaryNames $summary 'excluded') -join '、')）" } else { '（未排除任何测试）' }
                Add-Row 'ctest' 'PASS' "$(Get-SummaryCount $summary 'passed')/$(Get-SummaryCount $summary 'total') 通过$excludedNote；$dataNote；$(Format-Timing $ctest)"
            } elseif ($summary) {
                Add-Row 'ctest' 'FAIL' "失败：$((Get-SummaryNames $summary 'failed') -join '、')（$(Get-SummaryCount $summary 'passed')/$(Get-SummaryCount $summary 'total') 通过）；日志在 <build>\ot-test-data；$(Format-Timing $ctest)"
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
$script:controlOnOtherDiff = $null
$ControlOnStep = 'control-on（OPENTUNE_ENABLE_CONTROL_API=ON：configure / build / ctest -R Control）'
function Invoke-ControlOnSteps {
    $dir = Join-Path $BuildDir 'control-on'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    New-ModelPlaceholders | Out-Null
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
    # The targets of the CI job with the option ON: the Standalone app, the VST3 plug-in and every registered test
    # (except $ExcludedTests, empty at present).
    $targets = [System.Collections.Generic.List[string]]::new()
    foreach ($t in @('OpenTuneStandalone_Standalone', 'OpenTune_VST3')) { $targets.Add($t) }
    foreach ($name in @($testTargets.Keys)) {
        if ($ExcludedTests -contains [string]$name) { continue }
        $exe = [string]$testTargets[$name]
        if ($exe -and -not $targets.Contains($exe)) { $targets.Add($exe) }
    }
    $build = Invoke-InSlot 'control-on-build' (@('cmake', '--build', $dir, '--config', $Config, '--parallel', "$Parallel", '--target') + $targets) -VsDevShell
    if ($build.Code -ne 0) {
        Add-Row $ControlOnStep 'FAIL' "build exit $($build.Code)；日志 $($build.Log)：$(Get-LogTail $build)"
        return
    }
    # Two passes, as for the lane build, so that the real data directory can be attributed: the Control tests set
    # their own OPENTUNE_DATA_DIR and must not touch it; the other upstream tests are not isolated.
    $summaryControlPath = Join-Path $logDir 'ctest-summary-control-on-control.json'
    $summaryOtherPath = Join-Path $logDir 'ctest-summary-control-on.json'
    Remove-Item -LiteralPath $summaryControlPath, $summaryOtherPath -ErrorAction SilentlyContinue
    $dataBefore = Get-DirSnapshot $realDataDir
    $ctestControl = Invoke-InSlot 'control-on-ctest-control' (@('pwsh', '-NoProfile', '-File', (Join-Path $scripts 'run-ctest.ps1'), '-BuildDir', $dir, '-Config', $Config,
        '-Include', 'Control') + (Get-ExcludeArgs $ExcludedTests) + @('-DataRoot', (Join-Path $dir 'ot-test-data-control'), '-SummaryPath', $summaryControlPath))
    $script:controlOnDiff = Compare-DirSnapshot $dataBefore (Get-DirSnapshot $realDataDir)
    $otherNames = @($testTargets.Keys | ForEach-Object { [string]$_ } | Where-Object { $_ -notmatch 'Control' -and $ExcludedTests -notcontains $_ })
    $ctestOther = $null
    if ($otherNames.Count) {
        $dataBefore = Get-DirSnapshot $realDataDir
        $ctestOther = Invoke-InSlot 'control-on-ctest' (@('pwsh', '-NoProfile', '-File', (Join-Path $scripts 'run-ctest.ps1'), '-BuildDir', $dir, '-Config', $Config) +
            (Get-ExcludeArgs (@($ExcludedTests) + $controlNames)) + @('-DataRoot', (Join-Path $dir 'ot-test-data'), '-SummaryPath', $summaryOtherPath))
        $script:controlOnOtherDiff = Compare-DirSnapshot $dataBefore (Get-DirSnapshot $realDataDir)
    }
    $sc = $null
    if (Test-Path -LiteralPath $summaryControlPath) { $sc = Get-Content -LiteralPath $summaryControlPath -Raw | ConvertFrom-Json }
    $so = $null
    if (Test-Path -LiteralPath $summaryOtherPath) { $so = Get-Content -LiteralPath $summaryOtherPath -Raw | ConvertFrom-Json }
    if (-not $sc) {
        Add-Row $ControlOnStep 'FAIL' "ctest exit $($ctestControl.Code)；日志 $($ctestControl.Log)：$(Get-LogTail $ctestControl)"
    } elseif ((Get-SummaryCount $sc 'total') -eq 0) {
        Add-Row $ControlOnStep 'FAIL' '运行了 0 个 Control 测试'
    } elseif ($ctestOther -and -not $so) {
        Add-Row $ControlOnStep 'FAIL' "其余测试 ctest exit $($ctestOther.Code)；日志 $($ctestOther.Log)：$(Get-LogTail $ctestOther)"
    } else {
        $failed = Get-FailedTestNames @($sc, $so)
        $total = (Get-SummaryCount $sc 'total') + (Get-SummaryCount $so 'total')
        $passed = (Get-SummaryCount $sc 'passed') + (Get-SummaryCount $so 'passed')
        $timing = "$(Format-Timing $build)；ctest（Control）$(Format-Timing $ctestControl)$(if ($ctestOther) { "；ctest（其余）$(Format-Timing $ctestOther)" })"
        if ($failed.Count -gt 0) {
            Add-Row $ControlOnStep 'FAIL' "失败：$($failed -join '、')（$passed/$total 通过）；日志在 <build>\control-on\ot-test-data*；$timing"
        } else {
            Add-Row $ControlOnStep 'PASS' "$passed/$total 个测试通过（Control $(Get-SummaryCount $sc 'total') 个，其余 $(Get-SummaryCount $so 'total') 个；未排除任何测试）；构建 $($targets.Count) 个目标（Standalone、VST3 与测试，同 CI）；每个测试独立的 OPENTUNE_DATA_DIR；$timing"
        }
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
    elseif ($onnx.Count -eq 0) { Add-Row 'LFS 设置' 'PASS' "lfs.fetchexclude=*；仓库不跟踪任何 *.onnx（上游自 2c01847 起不再跟踪模型）；models/ 无改动" }
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
        $what = "control-on 一轮的 Control 测试期间，真实的 %APPDATA%\OpenTune 有变化：新建 $(@($d.Created).Count) 项、修改 $(@($d.Changed).Count) 项、删除 $(@($d.Removed).Count) 项$(if ($ex.Count) { "（如 $($ex -join '、')）" })"
        # Only the settings decide: with several lanes at work, other processes write real logs in the same window.
        if ($d.SettingsCount -eq 0) { Add-Row $isoControlOn 'WARN' "$what；变化只在 Logs 目录，设置文件未变（新增或改动的日志文件：$(Get-LogNameList $d)）：日志文件名只含日期、不含进程号，无法判断是否属于本轮 ctest；别的进程的测试也会写真实日志，只记 WARN，不判 FAIL" }
        else { Add-Row $isoControlOn 'FAIL' $what }
    }
    else {
        $o = $script:controlOnOtherDiff
        $otherNote = if ($null -ne $o -and $o.Count -gt 0) { "；上游测试不隔离：其余测试改动了真实目录（新建 $(@($o.Created).Count) 项、修改 $(@($o.Changed).Count) 项、删除 $(@($o.Removed).Count) 项），已知上游行为，未删除用户目录中的任何文件" } else { '' }
        Add-Row $isoControlOn 'PASS' "control-on 一轮的 Control 测试前后真实目录无任何新建、修改或删除$otherNote"
    }

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
    if ($Mirror) { $fcArgs += @('--mirror', $Mirror) }
    if ($clangFormat) { $fcArgs += @('--clang-format', $clangFormat) }
    else { $fcArgs += @('--clang-format', (Join-Path $ToolsDir 'clang-format-unavailable')) }
    $fc = Invoke-NodeJson $fcArgs
    if ($null -eq $fc.Data) { Add-Row 'fork-checks' 'FAIL' "fork-checks.mjs 运行失败（exit $($fc.Code)）：$($fc.Stderr)" }
    else { Add-CheckRows 'fork-checks' $fc.Data }

    # 6b. mirror pins: .github/drift-pins/, mirror-map.json and MIRRORS.md agree (needs no build)
    $dpErr = [System.IO.Path]::GetTempFileName()
    try {
        # Same rule as fork-gate: decideEnforcement of drift-pins.mjs, as a pull request into the base branch.
        # The changed-file list is the committed range plus uncommitted work (tracked changes and untracked files),
        # so a pin file edited but not yet committed counts. A failing git command is FAIL, never "nothing changed".
        $dpFiles = New-Object System.Collections.Generic.List[string]
        foreach ($dpGit in @(
            @('diff', '--no-renames', '--name-only', "$Base...HEAD"),
            @('diff', '--no-renames', '--name-only', 'HEAD'),
            @('ls-files', '--others', '--exclude-standard'),
            # The upstream .gitignore ignores .github/ wholesale (.*/), so the line above never lists untracked pin files.
            @('ls-files', '--others', '--', '.github/drift-pins', '.github/scripts/drift-pins.mjs'))) {
            $dpLines = @(& git @dpGit 2> $null)
            if ($LASTEXITCODE -ne 0) { throw "git $($dpGit -join ' ') 失败（exit $LASTEXITCODE），无法确定改动文件列表" }
            foreach ($dpLine in $dpLines) { if ($dpLine -and -not $dpFiles.Contains([string]$dpLine)) { $dpFiles.Add([string]$dpLine) } }
        }
        $dpChanged = [System.IO.Path]::GetTempFileName()
        Set-Content -LiteralPath $dpChanged -Value $dpFiles.ToArray()
        $dpBase = $Base -replace '^(refs/remotes/)?origin/', ''
        $dpArgs = @('--check', '--json', '--event', 'pull_request', '--base', $dpBase, '--changed-files', $dpChanged)
        $dpOut = (& node (Join-Path $scripts 'drift-pins.mjs') @dpArgs 2> $dpErr | Out-String).Trim()
        $dpCode = $LASTEXITCODE
        Remove-Item -LiteralPath $dpChanged -ErrorAction SilentlyContinue
        $dpRaw = [string](Get-Content -LiteralPath $dpErr -Raw -ErrorAction SilentlyContinue)
        $dpText = ($dpRaw -replace '\r?\n', ' ').Trim()
        $dpJson = $null
        try { $dpJson = $dpOut | ConvertFrom-Json -ErrorAction Stop } catch { }
        $dpName = 'drift-pins（镜像锁清单三处一致）'
        if ($null -eq $dpJson) { Add-Row $dpName 'FAIL' "exit ${dpCode}：$dpText $dpOut" }
        else {
            $dpProblems = @($dpJson.problems)
            if ($dpProblems.Count -eq 0) { Add-Row $dpName 'PASS' "$($dpJson.mirrors) 条镜像、$($dpJson.groups) 个组，三处一致" }
            elseif ($dpJson.advisory) { Add-Row $dpName 'WARN' "不一致（$($dpProblems.Count) 处），本分支没改清单与脚本，只报告；由 manager 的 L0 跟进用 node .github/scripts/drift-pins.mjs --write 补齐。$($dpProblems -join '；')" }
            else { Add-Row $dpName 'FAIL' "不一致（$($dpProblems.Count) 处）：$($dpProblems -join '；')。$($dpJson.fix)" }
        }
    } catch {
        Add-Row 'drift-pins（镜像锁清单三处一致）' 'FAIL' "drift-pins.mjs 运行失败：$($_.Exception.Message)"
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
