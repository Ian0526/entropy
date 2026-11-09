# Runs TuringLife as the live desktop background, behind the icons.
#   powershell -ExecutionPolicy Bypass -File scripts\wallpaper\start.ps1 [-World morpho|machines|life|2d|3d] [-Regime id] [-Rule bombers|starwars] [-CellPx n] [-Settings s] [-NoMouse] [-NoHold] [-Port 8077]
#   morpho = the Morphogenesis world (default): multi-channel Lenia, the Director drifting between
#            regimes; -Regime protozoa|protozoa-hd|web|… pins one regime (no drifting),
#            -Settings takes the string the /morpho lab's Controls → Wallpaper gives (look, colours,
#            pointer, physics); moving the mouse over the desktop stirs it unless -NoMouse; it
#            slows to a crawl while a fullscreen app (a game) runs or the GPU or CPU is busy
#            (watch.ps1), unless -NoHold,
#   machines = a Generations rule fed by quantum rain (Bombers unless -Rule starwars),
#   life = SmoothLife fed by quantum rain, 2d/3d = the TuringLife ecosystem.
# Starts a local server (127.0.0.1 only, no password, nothing saved), opens the /wallpaper page in a
# chromeless Edge window, and parents that window to the desktop's WorkerW layer.
# Stop it with scripts\wallpaper\stop.ps1.
param([ValidateSet('morpho', 'machines', 'life', '2d', '3d')][string]$World = 'morpho', [string]$Regime = '', [ValidateSet('bombers', 'starwars')][string]$Rule = 'bombers', [int]$Port = 8077, [double]$CellPx = 0, [string]$Settings = '', [switch]$NoMouse, [switch]$NoHold)
if ($CellPx -le 0) { $CellPx = $(if ($World -eq 'morpho') { 3 } else { 5 }) }
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$profileDir = Join-Path $env:LOCALAPPDATA 'TuringLifeWallpaper'
$cell = $CellPx.ToString([Globalization.CultureInfo]::InvariantCulture)
$url = "http://127.0.0.1:$Port/wallpaper?world=$World&rule=$Rule&cell=$cell"
if ($Settings) { $url += "&s=$([Uri]::EscapeDataString($Settings))" }
if ($Regime) { $url += "&regime=$Regime&auto=0" } # a named regime stays put

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Desk {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

  /** The WorkerW window that sits between the wallpaper and the icons (created on demand by Progman). */
  public static IntPtr WorkerW() {
    IntPtr progman = FindWindow("Progman", null), r;
    SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
        found = FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /** `hide` px of the window's top (the app window's own title bar) go above the screen. */
  public static void Attach(IntPtr win, IntPtr worker, int hide) {
    const int GWL_STYLE = -16;
    const int WS_CHILD = 0x40000000, WS_POPUP = unchecked((int)0x80000000), WS_VISIBLE = 0x10000000;
    SetWindowLong(win, GWL_STYLE, (GetWindowLong(win, GWL_STYLE) & ~(0x00C00000 | 0x00040000 | WS_POPUP)) | WS_CHILD | WS_VISIBLE);
    SetParent(win, worker);
    // WorkerW spans the whole virtual screen; its origin is the virtual screen's top-left.
    int w = GetSystemMetrics(78), h = GetSystemMetrics(79);
    SetWindowPos(win, IntPtr.Zero, 0, -hide, w, h + 2 * hide, 0x0020 | 0x0040); // and a margin below
  }
}
'@

# 1. The local server: one world only, bound to this PC, quantum feed from the LfD QRNG.
#    Always a fresh one: it only serves the build files that existed when it started.
& "$PSScriptRoot\stop.ps1" -Port $Port
$up = $false
if (-not $up) {
  if (-not (Test-Path "$repo\dist\server\index.js")) { throw "Build first: npm run build" }
  $env:PORT = "$Port"; $env:HOST = '127.0.0.1'; $env:QRNG_PROVIDER = 'lfdr'; $env:WALLPAPER = '1'
  # One copy of the world fills the desktop: shaped like the screen, one cell per $CellPx pixels (at most 1024 wide).
  Add-Type -AssemblyName System.Windows.Forms
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $gw = [Math]::Round($vs.Width / $CellPx); $gh = [Math]::Round($vs.Height / $CellPx)
  if ($gw -gt 1024) { $gh = [Math]::Round($gh * 1024 / $gw); $gw = 1024 }
  $env:GRID_W = "$([Math]::Max(64, $gw))"; $env:GRID_H = "$([Math]::Max(64, $gh))"
  # SmoothLife runs in the page; the server only serves it and the quantum pool, so keep its own world tiny.
  if ($World -in 'life', 'machines', 'morpho') { $env:GRID_W = '64'; $env:GRID_H = '64' }
  $env:GRID_3D = $(if ($World -eq '3d') { '64' } else { '0' })
  $env:BUILDER_DATA_DIR = Join-Path $env:TEMP 'turinglife-wallpaper'
  Remove-Item Env:SITE_PASSWORD -ErrorAction SilentlyContinue
  Start-Process node -ArgumentList 'dist/server/index.js' -WorkingDirectory $repo -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 500
    try { $up = (Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
  }
  if (-not $up) { throw "The local server didn't start on port $Port." }
}

# 2. A chromeless Edge window on its own profile. The flags stop it throttling itself when it
#    decides it's hidden, which it would, sitting behind the icons.
# A fresh profile each time: nothing is kept, and no stale cached build is ever served.
Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" }
Start-Process $edge -ArgumentList @(
  "--app=$url", "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check',
  '--disable-features=CalculateNativeWinOcclusion,Translate', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
  '--window-position=0,0', '--window-size=800,600'
) | Out-Null

# Only ever take the window of the browser running on the wallpaper profile: a window title could
# just as well belong to a tab you have open.
$win = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $win -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 500
  $ids = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$profileDir*" -and $_.CommandLine -notlike '*--type=*' }).ProcessId
  foreach ($id in $ids) {
    $h = (Get-Process -Id $id -ErrorAction SilentlyContinue).MainWindowHandle
    if ($h -and $h -ne [IntPtr]::Zero) { $win = $h; break }
  }
}
if ($win -eq [IntPtr]::Zero) { throw "The wallpaper window didn't open." }

# 3. Behind the icons.
$worker = [Desk]::WorkerW()
if ($worker -eq [IntPtr]::Zero) { throw "Couldn't find the desktop's WorkerW layer." }
Start-Sleep -Milliseconds 800
[Desk]::Attach($win, $worker, 40)

# 4. The mouse: moves over the desktop are relayed to the page, so the pointer stirs the world.
#    (Clicks are left to the desktop: forwarding them would steal them from the icons.)
if (-not $NoMouse) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSScriptRoot\mouse.ps1`"", '-Hwnd', "$([long]$win)", '-Tag', 'TuringLifeWallpaper'
  ) | Out-Null
}
# 5. The PC watcher: crawl while a game, a fullscreen app or heavy load is running.
if (-not $NoHold -and $World -eq 'morpho') {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSScriptRoot\watch.ps1`"", '-Port', "$Port", '-Tag', 'TuringLifeWallpaper'
  ) | Out-Null
}
Write-Host "TuringLife ($World) is now your desktop background. Stop: scripts\wallpaper\stop.ps1"
