using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TuringLife;

/// <summary>
/// The web side: the page (embedded in the .exe as web.zip and unpacked once per build), the
/// WebView2 environment shared by the wallpaper and the preview, and the quantum pool the page
/// asks for at /api/quantum/pool (answered here, so no server is involved).
/// </summary>
internal static class Web
{
    public const string Host = "turinglife.app";
    static CoreWebView2Environment? env;
    static string? webDir;

    /// <summary>The page's folder, unpacked from the embedded web.zip if this build hasn't been yet.</summary>
    public static string WebDir()
    {
        if (webDir != null) return webDir;
        using var zip = Assembly.GetExecutingAssembly().GetManifestResourceStream("web.zip")
            ?? throw new InvalidOperationException("This build has no web page inside (build it with npm run desktop).");
        using var ms = new MemoryStream();
        zip.CopyTo(ms);
        string hash = Convert.ToHexString(SHA256.HashData(ms.ToArray()))[..12];
        string dir = Path.Combine(Paths.WebRoot, hash);
        if (!File.Exists(Path.Combine(dir, "index.html")))
        {
            string tmp = dir + ".tmp";
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            ms.Position = 0;
            ZipFile.ExtractToDirectory(ms, tmp);
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.Move(tmp, dir);
            // Older builds' pages are no longer needed.
            foreach (var old in Directory.GetDirectories(Paths.WebRoot))
                if (!string.Equals(old, dir, StringComparison.OrdinalIgnoreCase)) try { Directory.Delete(old, true); } catch { }
        }
        return webDir = dir;
    }

    /// <summary>
    /// One browser environment for both views. The flags stop Chromium throttling a window it
    /// thinks is hidden, which the wallpaper (behind the icons) would otherwise be.
    /// </summary>
    public static async Task<CoreWebView2Environment> Environment()
    {
        if (env != null) return env;
        var opts = new CoreWebView2EnvironmentOptions(
            "--disable-features=CalculateNativeWinOcclusion --disable-background-timer-throttling " +
            "--disable-renderer-backgrounding --disable-backgrounding-occluded-windows");
        env = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData, opts);
        return env;
    }

    /// <summary>Loads the page into a WebView2 control as `view` (wallpaper | preview).</summary>
    public static async Task Load(WebView2 web, string view)
    {
        var e = await Environment();
        await web.EnsureCoreWebView2Async(e);
        var core = web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
#if !DEBUG
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.SetVirtualHostNameToFolderMapping(Host, WebDir(), CoreWebView2HostResourceAccessKind.Allow);
        core.AddWebResourceRequestedFilter($"https://{Host}/api/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, args) =>
        {
            if (!args.Request.Uri.Contains("/api/quantum/pool")) return;
            var body = new MemoryStream(Encoding.UTF8.GetBytes(Quantum.PoolJson()));
            args.Response = e.CreateWebResourceResponse(body, 200, "OK", "Content-Type: application/json\r\nCache-Control: no-store");
        };
        core.Navigate($"https://{Host}/index.html?view={view}");
    }
}

/// <summary>
/// Quantum random numbers from the LfD QRNG (an ID Quantique Quantis device at Leibniz University
/// Hannover; free, keyless): 1024 uint16s, refreshed every 10 minutes. Until the first batch
/// arrives (or offline) the pool is empty and the page uses its own seeded generator.
/// </summary>
internal static class Quantum
{
    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(20) };
    static string poolJson = "{\"pool\":[]}";
    static System.Threading.Timer? timer;

    public static string PoolJson() => Volatile.Read(ref poolJson);

    public static void Start()
    {
        http.DefaultRequestHeaders.UserAgent.ParseAdd("TuringLife-Wallpaper/1.0");
        timer = new System.Threading.Timer(_ => _ = Refresh(), null, TimeSpan.Zero, TimeSpan.FromMinutes(10));
    }

    static async Task Refresh()
    {
        try
        {
            string json = await http.GetStringAsync("https://lfdr.de/qrng_api/qrng?length=2048&format=HEX");
            string? hex = JsonNode.Parse(json)?["qrn"]?.GetValue<string>();
            if (string.IsNullOrEmpty(hex) || hex.Length < 8) return;
            byte[] bytes = Convert.FromHexString(hex.Length % 2 == 0 ? hex : hex[..^1]);
            var pool = new JsonArray();
            for (int i = 0; i + 1 < bytes.Length; i += 2) pool.Add((bytes[i] << 8) | bytes[i + 1]);
            Volatile.Write(ref poolJson, new JsonObject { ["pool"] = pool, ["source"] = "LfD QRNG" }.ToJsonString());
        }
        catch { /* offline or the service is down: keep the last batch */ }
    }
}
