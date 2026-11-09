# Stops the TuringLife desktop background: its Edge window and (unless -BrowserOnly) its local server.
param([switch]$BrowserOnly, [int]$Port = 8077)
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*TuringLifeWallpaper*' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not $BrowserOnly) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
}
# Repaint the normal wallpaper.
$wp = (Get-ItemProperty 'HKCU:\Control Panel\Desktop').WallPaper
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, string c, int d);'
[W.U]::SystemParametersInfo(0x14, 0, $wp, 3) | Out-Null
