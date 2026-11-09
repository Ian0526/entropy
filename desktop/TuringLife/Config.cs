using System.Text.Json;
using System.Text.Json.Nodes;

namespace TuringLife;

/// <summary>Where things live. Everything is per user; nothing needs admin rights.</summary>
internal static class Paths
{
    public static readonly string LocalData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TuringLife");
    public static readonly string RoamingData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TuringLife");
    public static readonly string InstallDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "TuringLife");
    public static readonly string InstalledExe = Path.Combine(InstallDir, "TuringLife.exe");
    public static readonly string ConfigFile = Path.Combine(RoamingData, "config.json");
    public static readonly string WebViewData = Path.Combine(LocalData, "WebView2");
    public static readonly string WebRoot = Path.Combine(LocalData, "web");
}

/// <summary>
/// The app's saved state (%APPDATA%\TuringLife\config.json):
///   settings      the world's settings, exactly as the web page understands them (settings.ts);
///                 the page fills in defaults, so this may be partial
///   regime / auto the chosen regime, and whether the Director drifts between regimes
///   wallpaper     whether the world is shown on the desktop
///   slowForGames  whether a fullscreen game or heavy load slows the world to a crawl
/// </summary>
internal sealed class Config
{
    public JsonObject Settings { get; set; } = new();
    public string? Regime { get; set; }
    public bool Auto { get; set; } = true;
    public bool Wallpaper { get; set; } = true;
    public bool SlowForGames { get; set; } = true;

    public static Config Load()
    {
        try
        {
            if (File.Exists(Paths.ConfigFile) && JsonNode.Parse(File.ReadAllText(Paths.ConfigFile)) is JsonObject o)
            {
                return new Config
                {
                    Settings = o["settings"] as JsonObject is { } s ? (JsonObject)s.DeepClone() : new JsonObject(),
                    Regime = o["regime"]?.GetValue<string?>(),
                    Auto = o["auto"]?.GetValue<bool>() ?? true,
                    Wallpaper = o["wallpaper"]?.GetValue<bool>() ?? true,
                    SlowForGames = o["slowForGames"]?.GetValue<bool>() ?? true,
                };
            }
        }
        catch { /* a damaged file: start from defaults */ }
        return new Config();
    }

    public void Save()
    {
        Directory.CreateDirectory(Paths.RoamingData);
        var o = new JsonObject
        {
            ["settings"] = Settings.DeepClone(),
            ["regime"] = Regime,
            ["auto"] = Auto,
            ["wallpaper"] = Wallpaper,
            ["slowForGames"] = SlowForGames,
        };
        string tmp = Paths.ConfigFile + ".tmp";
        File.WriteAllText(tmp, o.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, Paths.ConfigFile, true);
    }

    /// <summary>The message the page applies: { type: 'settings', settings, regime, auto }.</summary>
    public string SettingsMessage() => new JsonObject
    {
        ["type"] = "settings",
        ["settings"] = Settings.DeepClone(),
        ["regime"] = Regime,
        ["auto"] = Auto,
    }.ToJsonString();

    // ---- dotted-path access into the settings ("display.exposure", "drift.enabled") ----

    public JsonNode? Get(string path)
    {
        JsonNode? n = Settings;
        foreach (var part in path.Split('.'))
        {
            if (n is not JsonObject o || !o.TryGetPropertyValue(part, out n)) return null;
        }
        return n;
    }

    public double GetNumber(string path, double fallback)
    {
        try { return Get(path)?.GetValue<double>() ?? fallback; } catch { return fallback; }
    }

    public bool GetBool(string path, bool fallback)
    {
        try { return Get(path)?.GetValue<bool>() ?? fallback; } catch { return fallback; }
    }

    public string? GetString(string path)
    {
        try { return Get(path)?.GetValue<string>(); } catch { return null; }
    }

    public void Set(string path, JsonNode? value)
    {
        var parts = path.Split('.');
        JsonObject o = Settings;
        for (int i = 0; i < parts.Length - 1; i++)
        {
            if (o[parts[i]] is not JsonObject next) { next = new JsonObject(); o[parts[i]] = next; }
            o = next;
        }
        if (value is null) o.Remove(parts[^1]);
        else o[parts[^1]] = value;
    }
}
