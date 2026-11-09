# Watches what the PC is doing and tells the wallpaper to get out of the way:
#   slow  a fullscreen app has the foreground (a game, a fullscreen video), other programs keep
#         the GPU busier than -GpuSlow %, or the CPU is busier than -CpuSlow %: the world crawls
#         (about 1â€“2 steps and 5 pictures a second, a negligible load) but stays alive;
#   run   otherwise.
# It slows after two readings in a row (~4 s) and speeds back up after three calm ones (~6 s).
# Started by start.ps1 (hidden) and stopped by stop.ps1, which ends anything run with the
# TuringLifeWallpaper tag on its command line.
param([int]$Port = 8077, [int]$CpuSlow = 85, [int]$GpuSlow = 50, [string]$Tag = 'TuringLifeWallpaper')
$ErrorActionPreference = 'Continue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Fg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static Fg() { SetProcessDPIAware(); }

  /** The process id of a fullscreen foreground app, or 0. */
  public static int Fullscreen() {
    int q;
    // 2 = busy (a fullscreen app), 3 = Direct3D exclusive fullscreen, 4 = presentation mode.
    bool shellSays = SHQueryUserNotificationState(out q) == 0 && (q == 2 || q == 3 || q == 4);
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    var c = new StringBuilder(64); GetClassName(h, c, 64);
    string cls = c.ToString();
    if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return 0;
    RECT r; GetWindowRect(h, out r);
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
    bool covers = r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
    int pid; GetWindowThreadProcessId(h, out pid);
    return (covers || shellSays) ? pid : 0;
  }
}
'@

$cpu = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total')
[void]$cpu.NextValue()
$ours = @()
$oursAt = [datetime]::MinValue
$level = 'run'; $pending = ''; $count = 0
$url = "http://127.0.0.1:$Port/api/wallpaper/hold"

function Post($lvl, $why) {
  try { Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json' -Body (@{ level = $lvl; reason = $why } | ConvertTo-Json) -TimeoutSec 3 | Out-Null } catch {}
}
Post 'run' 'watcher started'

while ($true) {
  Start-Sleep -Seconds 2
  # The wallpaper's own browser processes (their GPU use doesn't count against it).
  if (((Get-Date) - $oursAt).TotalSeconds -gt 30) {
    $ours = @((Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$Tag*" }).ProcessId)
    $oursAt = Get-Date
    if (-not ($ours | Where-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).Name -eq 'msedge' -or (Get-Process -Id $_ -ErrorAction SilentlyContinue).Name -eq 'chrome' })) { break } # wallpaper gone
  }

  $want = 'run'; $why = ''
  $fsPid = [Fg]::Fullscreen()
  if ($fsPid -and $ours -notcontains $fsPid) {
    $want = 'slow'; $why = "fullscreen: $((Get-Process -Id $fsPid -ErrorAction SilentlyContinue).Name)"
  } else {
    # Other programs' 3D-engine use, summed per process (instance names carry pid_NNNN).
    $gpu = 0
    try {
      $samples = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction Stop).CounterSamples
      $byPid = @{}
      foreach ($s in $samples) {
        if ($s.InstanceName -match 'pid_(\d+)_') {
          $p = [int]$Matches[1]
          if ($ours -notcontains $p) { $byPid[$p] = [Math]::Max([double]($byPid[$p]), $s.CookedValue) }
        }
      }
      $gpu = ($byPid.Values | Measure-Object -Sum).Sum
    } catch {}
    $c = $cpu.NextValue()
    if ($gpu -gt $GpuSlow) { $want = 'slow'; $why = "GPU busy ($([int]$gpu)%)" }
    elseif ($c -gt $CpuSlow) { $want = 'slow'; $why = "CPU busy ($([int]$c)%)" }
  }

  if ($want -eq $level) { $pending = ''; $count = 0; continue }
  if ($want -ne $pending) { $pending = $want; $count = 0 }
  $count++
  $needed = $(if ($want -eq 'slow') { 2 } else { 3 })
  if ($count -ge $needed) {
    $level = $want; $pending = ''; $count = 0
    Post $level $why
  }
}
