# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# e2e-windows diagnostics: a desktop screenshot plus the top-level windows (title, class, owner, visibility,
# enabled state) of every OpenTune process. Read-only: it never clicks, closes or changes anything.
# One shot by default; -Loop repeats every -IntervalSeconds until the file -StopFile appears.
param(
  [Parameter(Mandatory)][string]$OutDir,
  [string]$Tag = 'shot',
  [switch]$Loop,
  [int]$IntervalSeconds = 15,
  [string]$StopFile = ''
)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OtWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public static List<string[]> Top() {
    var r = new List<string[]>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      IntPtr owner = GetWindow(h, 4);
      r.Add(new[] { pid.ToString(), h.ToInt64().ToString("x"), c.ToString(), t.ToString(), IsWindowVisible(h).ToString(), IsWindowEnabled(h).ToString(), owner == IntPtr.Zero ? "" : owner.ToInt64().ToString("x") });
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@

function Save-Shot([string]$name) {
  try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  } catch { "screenshot failed: $($_.Exception.Message)" | Set-Content -LiteralPath (Join-Path $OutDir "$name.screenshot-error.txt") }
}

function Save-Windows([string]$name) {
  $procs = @(Get-Process -Name OpenTune -ErrorAction SilentlyContinue)
  $lines = @("# $name  $(Get-Date -Format o)", "OpenTune processes: $($procs.Count)")
  foreach ($p in $procs) { $lines += "pid=$($p.Id) MainWindowTitle='$($p.MainWindowTitle)' Responding=$($p.Responding)" }
  $ids = @($procs | ForEach-Object { [string]$_.Id })
  $lines += 'pid | hwnd | class | title | visible | enabled | owner'
  foreach ($w in [OtWin]::Top()) {
    if ($ids -contains $w[0]) { $lines += ($w -join ' | ') }
  }
  $lines | Set-Content -LiteralPath (Join-Path $OutDir "$name.windows.txt")
}

$n = 0
do {
  $n++
  $name = '{0}-{1:000}' -f $Tag, $n
  Save-Windows $name
  Save-Shot $name
  if (-not $Loop) { break }
  for ($i = 0; $i -lt $IntervalSeconds; $i++) {
    if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
    Start-Sleep -Seconds 1
  }
} while ($Loop -and -not ($StopFile -and (Test-Path -LiteralPath $StopFile)))
