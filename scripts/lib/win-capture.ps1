# EXT-FRAME-2 — OS-level window capture + pixel sampling helper.
#
# Playwright cannot photograph chrome.sidePanel: the panel is browser chrome,
# not a page (scripts/ext-sidepanel-shots.mjs L17 says so). Every header shade
# decision since 2026-09-16 was therefore judged WITHOUT Chrome's own
# side-panel title bar in frame, which is exactly the surface Dennis compared
# us against. This helper closes that gap: it photographs the real Chromium
# window off the desktop, so the bar and our header are in the same PNG and
# their shades can be sampled from one image.
#
# Actions:
#   focus    -ProcessId N                       bring the window forward
#   rect     -ProcessId N                       print the window rect as JSON
#   capture  -ProcessId N -Out f.png            full window -> PNG
#   crop     -In f.png -Out g.png -X -Y -W -H   crop a PNG
#   sample   -In f.png -Points "x,y;x,y;..."    print sampled hexes as JSON
#   scanrow  -In f.png -Y n                     print every pixel of row Y as hex
#   scancol  -In f.png -X n                     print every pixel of column X as hex
#
# scanrow/scancol exist so the side-panel column is FOUND in the image rather
# than guessed from window metrics: the caller walks in from the right edge
# until the colour changes, which locates Chrome's bar, our header and the body
# without hardcoding a single Chrome frame dimension.
#
# Everything is System.Drawing + two P/Invokes; no modules, no downloads.
param(
  [Parameter(Mandatory = $true)][ValidateSet('focus', 'rect', 'capture', 'crop', 'sample', 'scanrow', 'scancol')]
  [string]$Action,
  [int]$ProcessId = 0,
  [string]$In = '',
  [string]$Out = '',
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
  [string]$Points = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('CcWin' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CcWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  // PrintWindow asks the WINDOW to render itself into our DC. Unlike
  // CopyFromScreen it cannot photograph whatever happens to be stacked on top,
  // which is the whole reason it is used here — see the capture action.
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  // PowerShell starts DPI-UNAWARE, so Windows virtualises every coordinate it
  // asks for: GetWindowRect reports logical pixels (1600) while PrintWindow
  // renders physical ones (2000 at 125%). Mixing the two silently crops the
  // right fifth of the window — which is exactly where the side panel lives.
  // Opting into per-monitor-v2 awareness makes both sides physical.
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  // Process.MainWindowHandle is "the first top-level window found", which for
  // Chromium is regularly a 66x24 helper rather than the browser frame. The
  // real window is chosen by enumerating the PID's visible top-level windows
  // and taking the largest — see Get-Handle.
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
}

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4. Must happen before the first
# window call on this thread; it is a no-op on a system already at 100%.
[void][CcWin]::SetThreadDpiAwarenessContext([IntPtr](-4))

function Get-Handle([int]$pid_) {
  # The LARGEST visible top-level window owned by this PID. MainWindowHandle
  # alone is not safe: Chromium owns several top-level windows and the first
  # one enumerated is often a 66x24 helper, which captures as a 66x24 image
  # that still looks like a successful screenshot. Size is the discriminator,
  # PID is the ownership proof. Polled, because the frame is not up instantly.
  for ($i = 0; $i -lt 60; $i++) {
    $best = [IntPtr]::Zero; $bestArea = 0
    $cb = [CcWin+EnumProc] {
      param($h, $l)
      $wpid = 0
      [void][CcWin]::GetWindowThreadProcessId($h, [ref]$wpid)
      if ($wpid -eq $script:targetPid -and [CcWin]::IsWindowVisible($h)) {
        $r = New-Object CcWin+RECT
        if ([CcWin]::GetWindowRect($h, [ref]$r)) {
          $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
          if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:best = $h }
        }
      }
      return $true
    }
    $script:targetPid = $pid_; $script:best = $best; $script:bestArea = $bestArea
    [void][CcWin]::EnumWindows($cb, [IntPtr]::Zero)
    if ($script:best -ne [IntPtr]::Zero -and $script:bestArea -gt 200000) { return $script:best }
    Start-Sleep -Milliseconds 250
  }
  throw "PID $pid_ has no sizeable visible top-level window after 15s"
}

function Get-Rect([IntPtr]$h) {
  $r = New-Object CcWin+RECT
  if (-not [CcWin]::GetWindowRect($h, [ref]$r)) { throw 'GetWindowRect failed' }
  return $r
}

switch ($Action) {
  'focus' {
    $h = Get-Handle $ProcessId
    [void][CcWin]::ShowWindow($h, 9)   # SW_RESTORE
    [void][CcWin]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 600
    Write-Output '{"focused":true}'
  }
  'rect' {
    $r = Get-Rect (Get-Handle $ProcessId)
    Write-Output ('{{"left":{0},"top":{1},"width":{2},"height":{3}}}' -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
  }
  'capture' {
    # PrintWindow(PW_RENDERFULLCONTENT), NOT CopyFromScreen.
    #
    # CopyFromScreen reads the DESKTOP at a rectangle, so it returns whatever
    # window is stacked there. The first run of this helper did exactly that
    # and photographed the operator's own browser — his tabs, his customer
    # records — instead of the harness's Chromium. That is both worthless as
    # evidence and unacceptable as a side effect, so the screen is never read.
    # PrintWindow asks the target window to draw ITSELF, which is correct even
    # when the window is occluded or off-screen, and cannot capture anything
    # that does not belong to the PID we were given.
    $h = Get-Handle $ProcessId
    $r = Get-Rect $h
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
    if ($w -le 0 -or $ht -le 0) { throw "degenerate window rect ${w}x${ht}" }
    $bmp = New-Object System.Drawing.Bitmap $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [CcWin]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    if (-not $ok) { $bmp.Dispose(); throw "PrintWindow failed for PID $ProcessId" }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ('{{"file":"{0}","width":{1},"height":{2},"left":{3},"top":{4}}}' -f ($Out -replace '\\', '/'), $w, $ht, $r.Left, $r.Top)
  }
  'crop' {
    $src = [System.Drawing.Bitmap]::FromFile($In)
    try {
      $x2 = [Math]::Min($X + $W, $src.Width); $y2 = [Math]::Min($Y + $H, $src.Height)
      $cw = $x2 - $X; $ch = $y2 - $Y
      if ($cw -le 0 -or $ch -le 0) { throw "crop outside image ($($src.Width)x$($src.Height))" }
      $rect = New-Object System.Drawing.Rectangle $X, $Y, $cw, $ch
      $dst = $src.Clone($rect, $src.PixelFormat)
      $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $dst.Dispose()
      Write-Output ('{{"file":"{0}","width":{1},"height":{2}}}' -f ($Out -replace '\\', '/'), $cw, $ch)
    } finally { $src.Dispose() }
  }
  'scanrow' {
    # GetPixel per pixel is fine for one row; LockBits would be faster and far
    # more code for a harness that runs twice.
    $src = [System.Drawing.Bitmap]::FromFile($In)
    try {
      $sb = New-Object System.Text.StringBuilder
      for ($i = 0; $i -lt $src.Width; $i++) {
        $c = $src.GetPixel($i, $Y)
        [void]$sb.Append(('{0:x2}{1:x2}{2:x2} ' -f $c.R, $c.G, $c.B))
      }
      Write-Output $sb.ToString().Trim()
    } finally { $src.Dispose() }
  }
  'scancol' {
    $src = [System.Drawing.Bitmap]::FromFile($In)
    try {
      $sb = New-Object System.Text.StringBuilder
      for ($i = 0; $i -lt $src.Height; $i++) {
        $c = $src.GetPixel($X, $i)
        [void]$sb.Append(('{0:x2}{1:x2}{2:x2} ' -f $c.R, $c.G, $c.B))
      }
      Write-Output $sb.ToString().Trim()
    } finally { $src.Dispose() }
  }
  'sample' {
    $src = [System.Drawing.Bitmap]::FromFile($In)
    try {
      $out = @()
      foreach ($pt in ($Points -split ';')) {
        if (-not $pt) { continue }
        $xy = $pt -split ','
        $px = [int]$xy[0]; $py = [int]$xy[1]
        $c = $src.GetPixel($px, $py)
        $out += ('{{"x":{0},"y":{1},"hex":"#{2:x2}{3:x2}{4:x2}"}}' -f $px, $py, $c.R, $c.G, $c.B)
      }
      Write-Output ('[' + ($out -join ',') + ']')
    } finally { $src.Dispose() }
  }
}
