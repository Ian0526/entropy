using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace TuringLife;

/// <summary>
/// The running app: a tray icon, the wallpaper window, the settings window (created on demand) and
/// the PC watcher. Closing the settings window keeps it running in the tray; Quit ends it and puts
/// the normal wallpaper back.
/// </summary>
internal sealed class App : ApplicationContext
{
    public const string SiteUrl = "https://entropy-production-5b61.up.railway.app";
    public static readonly Icon AppIcon = LoadIcon();

    public Config Config { get; } = Config.Load();
    public WallpaperForm? Wallpaper { get; private set; }
    public bool Quitting { get; private set; }
    /// <summary>A one-line description of the desktop world (regime, GPU share, slowed or not).</summary>
    public event Action<string>? DesktopStatus;

    readonly NotifyIcon tray;
    readonly Watcher watcher;
    readonly ToolStripMenuItem showItem;
    SettingsForm? settings;
    string holdLevel = "run", holdWhy = "";
    JsonObject? lastStatus;

    public App(bool openSettings)
    {
        showItem = new ToolStripMenuItem("Show on desktop", null, (_, _) => { Config.Wallpaper = !Config.Wallpaper; Config.Save(); SetWallpaper(Config.Wallpaper); });
        var menu = new ContextMenuStrip();
        menu.Items.Add(new ToolStripMenuItem("Settings…", null, (_, _) => OpenSettings()) { Font = new Font(menu.Font, FontStyle.Bold) });
        menu.Items.Add(showItem);
        menu.Items.Add(new ToolStripMenuItem("Reseed the world", null, (_, _) => Wallpaper?.Command("reseed")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (_, _) => Quit()));
        menu.Opening += (_, _) => showItem.Checked = Config.Wallpaper;
        tray = new NotifyIcon { Icon = AppIcon, Text = "TuringLife Wallpaper", ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) OpenSettings(); };

        Quantum.Start();
        watcher = new Watcher((level, why) => { holdLevel = level; holdWhy = why; ApplyHold(); });
        if (Config.Wallpaper) SetWallpaper(true);
        if (openSettings || !Config.Wallpaper) OpenSettings();
    }

    static Icon LoadIcon()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico");
        return s != null ? new Icon(s) : SystemIcons.Application;
    }

    public void OpenSettings()
    {
        if (settings == null || settings.IsDisposed) { settings = new SettingsForm(this); settings.Show(); }
        else settings.ShowAgain();
    }

    public void SetWallpaper(bool on)
    {
        if (on && (Wallpaper == null || Wallpaper.IsDisposed))
        {
            Wallpaper = new WallpaperForm(() => Config.SettingsMessage());
            Wallpaper.Status += s => { lastStatus = s; Report(); };
            Wallpaper.FormClosed += (_, _) => { Wallpaper = null; Report(); };
            Wallpaper.Show();
            ApplyHold();
        }
        else if (!on && Wallpaper != null)
        {
            Wallpaper.Close();
            Wallpaper = null;
        }
        Report();
    }

    public void ApplyHold()
    {
        Wallpaper?.SetHold(Config.SlowForGames ? holdLevel : "run");
        Report();
    }

    void Report()
    {
        string text;
        if (Wallpaper == null) text = "Not on the desktop.";
        else if (lastStatus == null) text = "Starting…";
        else
        {
            string name = lastStatus["regimeName"]?.GetValue<string>() ?? "";
            string? to = lastStatus["morphingTo"]?.GetValue<string?>();
            double? gpu = lastStatus["gpu"]?.GetValue<double?>();
            text = $"On the desktop: {name}{(to != null ? " → " + to : "")}" + (gpu is double g ? $" · GPU {g * 100:0}%" : "");
            if (Config.SlowForGames && holdLevel == "slow") text += $" · slowed ({holdWhy})";
        }
        DesktopStatus?.Invoke(text);
        tray.Text = text.Length > 63 ? text[..63] : text;
    }

    public void Quit()
    {
        Quitting = true;
        Config.Save();
        watcher.Dispose();
        Wallpaper?.Close();
        settings?.Close();
        tray.Visible = false;
        tray.Dispose();
        ExitThread();
    }
}

/// <summary>"Start with Windows": a per-user Run entry pointing at this .exe.</summary>
internal static class Startup
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "TuringLifeWallpaper";

    public static bool Enabled
    {
        get
        {
            using var k = Registry.CurrentUser.OpenSubKey(Key);
            return k?.GetValue(Name) is string;
        }
        set
        {
            using var k = Registry.CurrentUser.CreateSubKey(Key);
            if (value) k.SetValue(Name, $"\"{Environment.ProcessPath}\" --background");
            else k.DeleteValue(Name, false);
        }
    }
}
