using System.Runtime.InteropServices;
using System.Text;

namespace TuringLife;

/// <summary>Win32 calls: the desktop's WorkerW layer, the cursor, fullscreen detection, the wallpaper.</summary>
internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string? c, string? t);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string? c, string? t);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
    [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SystemParametersInfo(int a, int b, string? c, int d);
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);

    public static string ClassOf(IntPtr h)
    {
        var s = new StringBuilder(64);
        GetClassName(h, s, 64);
        return s.ToString();
    }

    /// <summary>
    /// The WorkerW window between the wallpaper and the icons. Progman creates it on demand when
    /// sent 0x052C; it is the WorkerW that follows the one holding the icons (SHELLDLL_DefView).
    /// </summary>
    public static IntPtr WorkerW()
    {
        IntPtr progman = FindWindow("Progman", null);
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out _);
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
                found = FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
            return true;
        }, IntPtr.Zero);
        // Newer Windows 11 builds keep the WorkerW inside Progman.
        if (found == IntPtr.Zero) found = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
        return found;
    }

    /// <summary>Makes `win` a borderless child of `parent` filling `w`×`h` from its top-left.</summary>
    public static void AttachAsChild(IntPtr win, IntPtr parent, int w, int h)
    {
        const int GWL_STYLE = -16;
        const int WS_CHILD = 0x40000000, WS_POPUP = unchecked((int)0x80000000), WS_VISIBLE = 0x10000000;
        const int WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000;
        SetWindowLong(win, GWL_STYLE, (GetWindowLong(win, GWL_STYLE) & ~(WS_CAPTION | WS_THICKFRAME | WS_POPUP)) | WS_CHILD | WS_VISIBLE);
        SetParent(win, parent);
        SetWindowPos(win, IntPtr.Zero, 0, 0, w, h, 0x0020 | 0x0040); // SWP_FRAMECHANGED | SWP_SHOWWINDOW
    }

    /// <summary>Whether the point is over the desktop itself (icons or bare wallpaper), not another window.</summary>
    public static bool OnDesktop(POINT p)
    {
        string c = ClassOf(GetAncestor(WindowFromPoint(p), 2)); // GA_ROOT
        return c == "Progman" || c == "WorkerW";
    }

    /// <summary>The process id of a fullscreen app in the foreground (a game, a fullscreen video), or 0.</summary>
    public static int FullscreenForeground()
    {
        // 2 = busy (a fullscreen app), 3 = Direct3D exclusive fullscreen, 4 = presentation mode.
        bool shellSays = SHQueryUserNotificationState(out int q) == 0 && (q == 2 || q == 3 || q == 4);
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return 0;
        string cls = ClassOf(h);
        if (cls is "Progman" or "WorkerW" or "Shell_TrayWnd") return 0;
        GetWindowRect(h, out RECT r);
        var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
        bool covers = r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
        GetWindowThreadProcessId(h, out int pid);
        return covers || shellSays ? pid : 0;
    }

    /// <summary>Re-applies the user's own wallpaper image, which repaints the desktop behind the icons.</summary>
    public static void RepaintWallpaper()
    {
        string? path = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Control Panel\Desktop", "WallPaper", null) as string;
        SystemParametersInfo(0x14, 0, path, 3); // SPI_SETDESKWALLPAPER, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
    }
}
