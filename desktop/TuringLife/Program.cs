using Microsoft.Web.WebView2.Core;

namespace TuringLife;

/// <summary>
/// TuringLife Wallpaper.
///   TuringLife.exe               (downloaded) offers to install; (installed) runs, opening settings
///   TuringLife.exe --background  runs in the tray with the wallpaper only (used at sign-in)
///   TuringLife.exe --settings    runs and opens the settings window
///   TuringLife.exe --portable    runs this copy without offering to install
///   TuringLife.exe --uninstall   removes it (Settings → Apps uses this)
/// Only one copy runs; starting another just opens the running one's settings.
/// </summary>
internal static class Program
{
    const string MutexName = @"Local\TuringLife.Wallpaper";
    const string ShowEventName = @"Local\TuringLife.Wallpaper.Show";
    const string QuitEventName = @"Local\TuringLife.Wallpaper.Quit";

    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        bool has(string a) => args.Any(x => string.Equals(x, a, StringComparison.OrdinalIgnoreCase));

        if (has("--uninstall")) { Installer.Uninstall(); return; }

        if (!Installer.RunningInstalled && !has("--portable") && !has("--background"))
        {
            if (Installer.Offer()) return;
        }

        using var mutex = new Mutex(true, MutexName, out bool first);
        if (!first)
        {
            // Already running: bring its settings window up instead.
            try { using var ev = EventWaitHandle.OpenExisting(ShowEventName); ev.Set(); } catch { }
            return;
        }

        try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch
        {
            if (MessageBox.Show("TuringLife needs the Microsoft Edge WebView2 Runtime, which isn't installed.\n\nOpen the download page?",
                    "TuringLife", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
            return;
        }

        var app = new App(openSettings: !has("--background"));
        var ui = SynchronizationContext.Current!;
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        using var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
        var listener = new Thread(() =>
        {
            var handles = new WaitHandle[] { showEvent, quitEvent };
            while (true)
            {
                int i = WaitHandle.WaitAny(handles);
                if (i == 0) ui.Post(_ => app.OpenSettings(), null);
                else { ui.Post(_ => app.Quit(), null); break; }
            }
        }) { IsBackground = true };
        listener.Start();
        Application.Run(app);
    }

    /// <summary>Asks a running copy to quit (before installing over it or uninstalling) and waits for it.</summary>
    public static void StopOtherInstance()
    {
        try
        {
            using var ev = EventWaitHandle.OpenExisting(QuitEventName);
            ev.Set();
        }
        catch { return; } // none running
        for (int i = 0; i < 50; i++)
        {
            try
            {
                using var m = Mutex.OpenExisting(MutexName);
            }
            catch { return; } // gone
            Thread.Sleep(100);
        }
    }
}
