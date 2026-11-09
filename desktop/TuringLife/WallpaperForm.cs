using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.WinForms;

namespace TuringLife;

/// <summary>
/// The world behind the desktop icons: a borderless window holding the page (?view=wallpaper),
/// made a child of the desktop's WorkerW layer and stretched over every monitor.
/// Windows never sends it mouse input (the icons are on top), so the cursor's position over the
/// desktop is passed to the page as a message: moving the mouse stirs the world. Clicks are left
/// alone, so the icons work as usual.
/// </summary>
internal sealed class WallpaperForm : Form
{
    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(2, 4, 11) };
    readonly System.Windows.Forms.Timer mouse = new() { Interval = 16 };
    readonly Func<string> settingsMessage;
    bool ready;
    Native.POINT lastCursor = new() { X = int.MinValue };
    string hold = "run";

    /// <summary>The page's latest status message (regime, GPU share…), for the settings window.</summary>
    public event Action<JsonObject>? Status;

    public WallpaperForm(Func<string> settingsMessage)
    {
        this.settingsMessage = settingsMessage;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(2, 4, 11);
        Text = "TuringLife wallpaper";
        Bounds = SystemInformation.VirtualScreen;
        Controls.Add(web);
        mouse.Tick += (_, _) => RelayMouse();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        IntPtr worker = Native.WorkerW();
        if (worker == IntPtr.Zero)
        {
            MessageBox.Show("Couldn't find the desktop layer to draw the wallpaper on.", "TuringLife", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
            return;
        }
        var vs = SystemInformation.VirtualScreen;
        Native.AttachAsChild(Handle, worker, vs.Width, vs.Height);
        try
        {
            await Web.Load(web, "wallpaper");
        }
        catch (Exception ex)
        {
            MessageBox.Show("The wallpaper couldn't start its web view:\n" + ex.Message, "TuringLife", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }
        web.CoreWebView2.WebMessageReceived += (_, args) =>
        {
            if (JsonNode.Parse(args.WebMessageAsJson) is not JsonObject m) return;
            switch (m["type"]?.GetValue<string>())
            {
                case "ready":
                    ready = true;
                    Post(settingsMessage());
                    Post(new JsonObject { ["type"] = "hold", ["level"] = hold }.ToJsonString());
                    break;
                case "status":
                    Status?.Invoke(m);
                    break;
            }
        };
        mouse.Start();
    }

    public void Post(string json)
    {
        if (ready && web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(json);
    }

    public void SetHold(string level)
    {
        if (level == hold) return;
        hold = level;
        Post(new JsonObject { ["type"] = "hold", ["level"] = level }.ToJsonString());
    }

    public void Command(string name) => Post(new JsonObject { ["type"] = "command", ["name"] = name }.ToJsonString());

    void RelayMouse()
    {
        if (!ready || !Native.GetCursorPos(out var p)) return;
        if (p.X == lastCursor.X && p.Y == lastCursor.Y) return;
        lastCursor = p;
        if (!Native.OnDesktop(p)) return;
        var c = p;
        Native.ScreenToClient(Handle, ref c);
        double scale = Native.GetDpiForWindow(Handle) / 96.0;
        if (scale <= 0) scale = 1;
        Post(new JsonObject { ["type"] = "pointer", ["x"] = c.X / scale, ["y"] = c.Y / scale }.ToJsonString());
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        mouse.Stop();
        web.Dispose();
        base.OnFormClosed(e);
        Native.RepaintWallpaper();
    }
}
