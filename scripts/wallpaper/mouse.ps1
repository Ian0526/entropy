# Forwards the mouse to the wallpaper window. The wallpaper sits behind the desktop icons, so
# Windows never sends it mouse input; this relays mouse moves made over the desktop (not over
# other windows) as window messages, so the page sees ordinary pointer moves and can stir.
# Moves only: a forwarded button press makes Chromium capture the mouse, which takes clicks away
# from the desktop icons.
# Started by start.ps1 (hidden) and stopped by stop.ps1, which ends anything run with the
# TuringLifeWallpaper tag on its command line.
param([long]$Hwnd, [string]$Tag = 'TuringLifeWallpaper')
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class Relay {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  static string Cls(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }

  /** Chromium takes input on its render widget child (or, failing that, the top-level window). */
  static IntPtr Target(IntPtr top) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, (h, l) => { if (Cls(h) == "Chrome_RenderWidgetHostHWND") { found = h; return false; } return true; }, IntPtr.Zero);
    return found != IntPtr.Zero ? found : top;
  }

  static bool OnDesktop(POINT p) {
    string c = Cls(GetAncestor(WindowFromPoint(p), 2)); // GA_ROOT
    return c == "Progman" || c == "WorkerW";
  }

  public static void Run(IntPtr top) {
    SetProcessDPIAware();
    IntPtr target = Target(top);
    POINT last = new POINT { X = int.MinValue };
    while (IsWindow(top)) {
      Thread.Sleep(16);
      POINT p;
      if (!GetCursorPos(out p)) continue;
      if (p.X == last.X && p.Y == last.Y) continue;
      last = p;
      if (!OnDesktop(p)) continue;
      if (!IsWindow(target)) target = Target(top);
      POINT c = p;
      ScreenToClient(target, ref c);
      PostMessage(target, 0x0200, IntPtr.Zero, (IntPtr)(((c.Y & 0xFFFF) << 16) | (c.X & 0xFFFF))); // WM_MOUSEMOVE, no buttons
    }
  }
}
'@
[Relay]::Run([IntPtr]$Hwnd)
