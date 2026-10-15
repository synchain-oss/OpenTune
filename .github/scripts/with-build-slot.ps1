# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fork-only build tooling (lives under .github/, never goes upstream).
#Requires -Version 7.2
<#
.SYNOPSIS
  Run a heavy command (configure / build / ctest / app launch) only while holding a machine-wide build slot.

.DESCRIPTION
  Slots are named mutexes: with -Slots 1 the name is exactly 'Global\OpenTune-build-slot';
  with -Slots N they are '<SlotName>-0' .. '<SlotName>-(N-1)'. The slot count is, in order: -Slots,
  the environment variable OPENTUNE_BUILD_SLOTS, then 2 (one build uses --parallel 8, two of them
  fit the memory budget of the build machine). A value outside 1..8 or not a whole number is
  rejected (exit 64). A lane that still runs an older copy of this script uses the unsuffixed lock
  name, which does not exclude the suffixed names, so during a transition up to one more build can
  run; the -MinFreeMB check is what keeps that safe. The script
    1. waits (up to -WaitMinutes) for any free slot;
    2. treats an AbandonedMutexException (previous holder crashed or was killed) as a successful
       acquire and says so. (Measured on pwsh 7.6.6 / .NET 10.0.12: after the holder is
       force-killed the wait simply succeeds without the exception; either way the slot is
       taken over immediately, never deadlocked);
    3. waits until available physical memory is at least -MinFreeMB (the measured peak of one build
       at the chosen --parallel plus headroom), still holding the slot so two waiters cannot both
       pass the check and then start together. Measured peaks (cl/link/ninja working set, JUCE 9.0.3,
       MSVC 14.44): Standalone cold j8 3.6 GB, j16 4.2 GB; all targets RelWithDebInfo j8 4.0 GB;
       all targets Release j8 8.9 GB (eight concurrent LTCG test links). Default 6144 covers a
       RelWithDebInfo lane build; pass ~12000 for a Release build that links the tests;
    4. optionally imports the MSVC developer environment (-VsDevShell, via vswhere +
       Launch-VsDevShell.ps1) so Ninja finds cl.exe;
    5. runs the command and exits with its exit code; the slot is released in all cases.

  Exit codes: the command's own code; 75 when no slot or not enough memory within -WaitMinutes;
  64 for bad options. Run it from PowerShell. MSBuild trips over duplicate Path/PATH variables when
  launched from Git Bash.

  Options are parsed by hand (no param block) so that the wrapped command's own dash arguments
  (cmake -S/-B/-G/-D...) are never mistaken for this script's options. Everything after '--' is the
  command. Options: -Slots N, -SlotName NAME, -MinFreeMB N, -WaitMinutes N, -VsDevShell, -Status,
  -ShowConfig (print the resolved slot count and lock names, then exit without taking a lock).

.EXAMPLE
  pwsh -File with-build-slot.ps1 -VsDevShell -MinFreeMB 9000 -- cmake --build C:\lanes\fA-build --config Release --parallel 8
.EXAMPLE
  pwsh -File with-build-slot.ps1 -Status
#>

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$DefaultSlots = 2
$Slots = $null
$SlotName = 'Global\OpenTune-build-slot'
$MinFreeMB = 6144
$WaitMinutes = 120
$VsDevShell = $false
$Status = $false
$ShowConfig = $false
$Command = @()

# Under `pwsh -File`, PowerShell rewrites arguments that look like '-Name:value' (for example
# -DCMAKE_MAKE_PROGRAM=C:/...) before they reach $args. Prefer the process's raw argv after this
# script's path when we were started that way.
$rawArgs = @($args)
$argv = [Environment]::GetCommandLineArgs()
for ($k = 0; $k -lt $argv.Count; $k++) {
    $candidate = $null
    try { $candidate = [System.IO.Path]::GetFullPath($argv[$k]) } catch { }
    if ($candidate -and $PSCommandPath -and $candidate -ieq $PSCommandPath) {
        $rawArgs = @($argv | Select-Object -Skip ($k + 1))
        break
    }
}

# 1..8 whole number, otherwise exit 64.
function ConvertTo-SlotCount([string]$Text, [string]$Origin) {
    $n = 0
    if (-not [int]::TryParse($Text, [System.Globalization.NumberStyles]::None, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$n) -or $n -lt 1 -or $n -gt 8) {
        Write-Error "with-build-slot: $Origin must be a whole number 1..8 (got '$Text')" -ErrorAction Continue
        exit 64
    }
    return $n
}

$i = 0
while ($i -lt $rawArgs.Count) {
    $a = [string]$rawArgs[$i]
    if ($a -eq '--') { $Command = @($rawArgs | Select-Object -Skip ($i + 1)); break }
    switch -Regex ($a) {
        '^-Slots$'       { $Slots = ConvertTo-SlotCount ([string]$rawArgs[++$i]) '-Slots' }
        '^-SlotName$'    { $SlotName = [string]$rawArgs[++$i] }
        '^-MinFreeMB$'   { $MinFreeMB = [int]$rawArgs[++$i] }
        '^-WaitMinutes$' { $WaitMinutes = [int]$rawArgs[++$i] }
        '^-VsDevShell$'  { $VsDevShell = $true }
        '^-Status$'      { $Status = $true }
        '^-ShowConfig$'  { $ShowConfig = $true }
        default          { Write-Error "with-build-slot: unknown option '$a' (put the command after --)" -ErrorAction Continue; exit 64 }
    }
    $i++
}
if ($null -eq $Slots) {
    $fromEnv = [Environment]::GetEnvironmentVariable('OPENTUNE_BUILD_SLOTS')
    $Slots = if ([string]::IsNullOrWhiteSpace($fromEnv)) { $DefaultSlots } else { ConvertTo-SlotCount $fromEnv.Trim() 'OPENTUNE_BUILD_SLOTS' }
}

function Write-Slot([string]$Message) { Write-Host "[build-slot $(Get-Date -Format HH:mm:ss)] $Message" }

function Get-AvailableMB {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [int]((New-Object Microsoft.VisualBasic.Devices.ComputerInfo).AvailablePhysicalMemory / 1MB)
}

function Get-SlotNames {
    if ($Slots -eq 1) { return @($SlotName) }
    return @(0..($Slots - 1) | ForEach-Object { "$SlotName-$_" })
}

$names = @(Get-SlotNames)

if ($ShowConfig) {
    Write-Host "slots=$Slots"
    $names | ForEach-Object { Write-Host "name=$_" }
    exit 0
}
$mutexes = @($names | ForEach-Object { [System.Threading.Mutex]::new($false, $_) })

if ($Status) {
    for ($i = 0; $i -lt $mutexes.Count; $i++) {
        $free = $false
        try { $free = $mutexes[$i].WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $free = $true }
        if ($free) { $mutexes[$i].ReleaseMutex() }
        Write-Host ("{0}: {1}" -f $names[$i], $(if ($free) { 'free' } else { 'held' }))
    }
    Write-Host "available physical memory: $(Get-AvailableMB) MB"
    $mutexes | ForEach-Object { $_.Dispose() }
    exit 0
}

if ($Command.Count -eq 0) { Write-Error 'with-build-slot: no command. Usage: with-build-slot.ps1 [options] -- <command> [args...]' -ErrorAction Continue; exit 64 }

$held = -1
$deadline = (Get-Date).AddMinutes($WaitMinutes)
$exitCode = 75
try {
    # 1-2. Acquire a slot.
    $announced = $false
    while ($held -lt 0) {
        try {
            $idx = [System.Threading.WaitHandle]::WaitAny([System.Threading.WaitHandle[]]$mutexes, [TimeSpan]::FromSeconds(5))
            if ($idx -ne [System.Threading.WaitHandle]::WaitTimeout) { $held = $idx }
        } catch [System.Threading.AbandonedMutexException] {
            $held = $_.Exception.MutexIndex
            Write-Slot "previous holder of $($names[$held]) exited without releasing it (abandoned); taking it over"
        }
        if ($held -ge 0) { break }
        if (-not $announced) { Write-Slot "all $Slots slot(s) busy; waiting (max $WaitMinutes min)"; $announced = $true }
        if ((Get-Date) -gt $deadline) { Write-Slot 'gave up waiting for a build slot'; exit 75 }
    }
    Write-Slot "acquired $($names[$held])"

    # 3. Memory gate (while holding the slot).
    $avail = Get-AvailableMB
    $announced = $false
    while ($avail -lt $MinFreeMB) {
        if (-not $announced) { Write-Slot "available memory $avail MB < required $MinFreeMB MB; waiting"; $announced = $true }
        if ((Get-Date) -gt $deadline) { Write-Slot "gave up: available memory stayed below $MinFreeMB MB"; exit 75 }
        Start-Sleep -Seconds 10
        $avail = Get-AvailableMB
    }
    Write-Slot "available memory $avail MB (required $MinFreeMB MB)"

    # 4. MSVC environment. Launch-VsDevShell.ps1 costs 2-30 s per call on a busy machine, so the
    #    resulting environment is cached per VS instance + toolset and re-applied directly.
    if ($VsDevShell -and -not $env:VCToolsInstallDir) {
        $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        if (-not (Test-Path -LiteralPath $vswhere)) { throw "vswhere not found: $vswhere" }
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if (-not $vs) { throw 'No Visual Studio instance with the x64 VC tools found.' }
        $toolsetFile = Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'
        $toolset = if (Test-Path -LiteralPath $toolsetFile) { (Get-Content -LiteralPath $toolsetFile -Raw).Trim() } else { 'unknown' }
        $key = [BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("$vs|$toolset|$env:PATH"))).Replace('-', '').Substring(0, 16)
        $cacheDir = Join-Path $env:LOCALAPPDATA 'OpenTune-build'
        $cacheFile = Join-Path $cacheDir "vsdevenv-$key.json"
        $applied = $false
        if (Test-Path -LiteralPath $cacheFile) {
            try {
                $cached = Get-Content -LiteralPath $cacheFile -Raw | ConvertFrom-Json -AsHashtable
                if ($cached['VCToolsInstallDir'] -and (Test-Path -LiteralPath $cached['VCToolsInstallDir'])) {
                    foreach ($k in $cached.Keys) { [Environment]::SetEnvironmentVariable($k, $cached[$k]) }
                    $applied = $true
                }
            } catch { $applied = $false }
        }
        if (-not $applied) {
            $before = @{}
            foreach ($e in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $before[$e.Key] = $e.Value }
            & (Join-Path $vs 'Common7\Tools\Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
            $delta = @{}
            foreach ($e in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
                if (-not $before.ContainsKey($e.Key) -or $before[$e.Key] -ne $e.Value) { $delta[$e.Key] = $e.Value }
            }
            New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
            $delta | ConvertTo-Json | Set-Content -LiteralPath $cacheFile -Encoding utf8NoBOM
        }
        Write-Slot "MSVC environment ($(if ($applied) { 'cached' } else { 'fresh' })): $env:VCToolsInstallDir"
    }

    # 5. Run.
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Slot "run: $($Command -join ' ')"
    $exe = $Command[0]
    $rest = @($Command | Select-Object -Skip 1)
    & $exe @rest
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = if ($?) { 0 } else { 1 } }
    Write-Slot ("exit {0} after {1:N1}s" -f $exitCode, $sw.Elapsed.TotalSeconds)
} finally {
    if ($held -ge 0) { $mutexes[$held].ReleaseMutex(); Write-Slot "released $($names[$held])" }
    $mutexes | ForEach-Object { $_.Dispose() }
}
exit $exitCode
