using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.WinForms;

namespace TuringLife;

/// <summary>
/// The settings window: native controls on the left, the live world (?view=preview) on the right.
/// Every change is saved and sent to both the preview and the wallpaper at once. Presets (looks,
/// palettes), imported codes and "reset" are worked out by the page, which knows the defaults, and
/// come back as a 'changed' message; the page also echoes every settings message back with all
/// defaults filled in ('normalised'), which is what the controls show.
/// </summary>
internal sealed class SettingsForm : Form
{
    readonly App app;
    readonly WebView2 preview = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(2, 4, 11) };
    readonly Label previewStatus = new() { Dock = DockStyle.Bottom, Height = 24, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(8, 0, 0, 0) };
    readonly Label desktopStatus = new() { AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(3, 2, 3, 6) };
    readonly FlowLayoutPanel side = new() { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(10, 8, 6, 8) };
    readonly List<Action> refreshers = new();
    readonly ComboBox regimeBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 330 };
    readonly ComboBox lookBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 160 };
    readonly ComboBox paletteBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 160 };
    readonly System.Windows.Forms.Timer sendSoon = new() { Interval = 60 };
    readonly System.Windows.Forms.Timer saveSoon = new() { Interval = 400 };
    readonly ToolTip tips = new() { AutoPopDelay = 15000 };
    List<(string id, string name)> regimes = new();
    List<(string id, string name)> looks = new();
    List<(string id, string name)> palettes = new();
    JsonArray ranges = new();
    bool previewReady, refreshing;
    const int ControlWidth = 330;

    public SettingsForm(App app)
    {
        this.app = app;
        Text = "TuringLife Wallpaper";
        Icon = App.AppIcon;
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1320, 860);
        MinimumSize = new Size(900, 560);
        Font = new Font("Segoe UI", 9f);

        var split = new SplitContainer { Dock = DockStyle.Fill, FixedPanel = FixedPanel.Panel1, SplitterWidth = 4 };
        split.Panel1.Controls.Add(side);
        split.Panel2.Controls.Add(preview);
        split.Panel2.Controls.Add(previewStatus);
        Controls.Add(split);
        Load += (_, _) => split.SplitterDistance = LogicalToDeviceUnits(390);

        BuildControls();
        sendSoon.Tick += (_, _) => { sendSoon.Stop(); Broadcast(); };
        saveSoon.Tick += (_, _) => { saveSoon.Stop(); app.Config.Save(); };
        app.DesktopStatus += s => desktopStatus.Text = s;
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try
        {
            await Web.Load(preview, "preview");
            preview.CoreWebView2.WebMessageReceived += (_, args) => OnPageMessage(args.WebMessageAsJson);
        }
        catch (Exception ex)
        {
            previewStatus.Text = "The preview couldn't start: " + ex.Message;
        }
    }

    // Hidden in the tray instead of closed, and the preview stops working while hidden.
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing && !app.Quitting)
        {
            e.Cancel = true;
            Hide();
            app.Config.Save();
            if (preview.CoreWebView2 != null) { previewReady = false; preview.CoreWebView2.Navigate("about:blank"); }
            return;
        }
        base.OnFormClosing(e);
    }

    public void ShowAgain()
    {
        if (preview.CoreWebView2 != null && preview.Source?.Host != Web.Host)
            preview.CoreWebView2.Navigate($"https://{Web.Host}/index.html?view=preview");
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    // ---- messages from the preview page ----

    void OnPageMessage(string json)
    {
        if (JsonNode.Parse(json) is not JsonObject m) return;
        switch (m["type"]?.GetValue<string>())
        {
            case "ready":
                previewReady = true;
                regimes = List(m["regimes"]);
                looks = List(m["looks"]);
                palettes = List(m["palettes"]);
                ranges = m["ranges"] as JsonArray ?? new JsonArray();
                FillCombos();
                PostPreview(app.Config.SettingsMessage());
                break;
            case "normalised":
                if (m["settings"] is JsonObject n) { app.Config.Settings = (JsonObject)n.DeepClone(); RefreshAll(); saveSoon.Start(); }
                break;
            case "changed":
                if (m["error"] is JsonNode err) { MessageBox.Show(this, err.GetValue<string>(), "TuringLife", MessageBoxButtons.OK, MessageBoxIcon.Information); break; }
                if (m["settings"] is JsonObject s) app.Config.Settings = (JsonObject)s.DeepClone();
                if (m["auto"] is JsonNode a) app.Config.Auto = a.GetValue<bool>();
                if (m["regime"] is JsonNode r) app.Config.Regime = r.GetValue<string>();
                Changed();
                RefreshAll();
                break;
            case "status":
                string name = m["regimeName"]?.GetValue<string>() ?? "";
                string? to = m["morphingTo"]?.GetValue<string?>();
                double? gpu = m["gpu"]?.GetValue<double?>();
                previewStatus.Text = $"Preview: {name}{(to != null ? " → " + to : "")}" + (gpu is double g ? $" · GPU {g * 100:0}%" : "");
                break;
        }
    }

    static List<(string, string)> List(JsonNode? n) =>
        (n as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(o => (o["id"]!.GetValue<string>(), o["name"]!.GetValue<string>())).ToList();

    void PostPreview(string json)
    {
        if (previewReady && preview.CoreWebView2 != null) preview.CoreWebView2.PostWebMessageAsJson(json);
    }

    /// <summary>A setting changed here: save soon, and send to both views (coalesced per frame or so).</summary>
    void Changed()
    {
        if (refreshing) return;
        saveSoon.Stop(); saveSoon.Start();
        if (!sendSoon.Enabled) sendSoon.Start();
    }

    void Broadcast()
    {
        string msg = app.Config.SettingsMessage();
        PostPreview(msg);
        app.Wallpaper?.Post(msg);
    }

    void RefreshAll()
    {
        refreshing = true;
        try { foreach (var r in refreshers) r(); }
        finally { refreshing = false; }
    }

    // ---- the controls ----

    void BuildControls()
    {
        Section("Wallpaper");
        Check("Show on my desktop", () => app.Config.Wallpaper, v => { app.Config.Wallpaper = v; app.SetWallpaper(v); app.Config.Save(); });
        Check("Start with Windows", () => Startup.Enabled, v => Startup.Enabled = v);
        Check("Slow down while gaming or under heavy load", () => app.Config.SlowForGames, v => { app.Config.SlowForGames = v; app.Config.Save(); app.ApplyHold(); },
            "A fullscreen app (a game, a fullscreen video) or a busy GPU or CPU makes the world crawl at a negligible load until you're done.");
        side.Controls.Add(desktopStatus);

        Section("World");
        regimeBox.SelectedIndexChanged += (_, _) =>
        {
            if (refreshing || regimeBox.SelectedIndex < 0) return;
            if (regimeBox.SelectedIndex == 0) app.Config.Auto = true;
            else { app.Config.Auto = false; app.Config.Regime = regimes[regimeBox.SelectedIndex - 1].id; }
            Changed();
        };
        refreshers.Add(() =>
        {
            int i = app.Config.Auto ? 0 : regimes.FindIndex(r => r.id == app.Config.Regime) + 1;
            if (i >= 0 && i < regimeBox.Items.Count) regimeBox.SelectedIndex = i;
        });
        Add(regimeBox);
        Buttons(("Reseed", () => { PostPreview(Command("reseed")); app.Wallpaper?.Command("reseed"); }),
                ("Drop a seed", () => { PostPreview(Command("nucleate")); app.Wallpaper?.Command("nucleate"); }));

        Section("Look");
        lookBox.SelectedIndexChanged += (_, _) => { if (!refreshing && lookBox.SelectedIndex > 0) { Apply("look", looks[lookBox.SelectedIndex - 1].id); ResetPicker(lookBox); } };
        paletteBox.SelectedIndexChanged += (_, _) => { if (!refreshing && paletteBox.SelectedIndex > 0) { Apply("palette", palettes[paletteBox.SelectedIndex - 1].id); ResetPicker(paletteBox); } };
        var presets = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 4) };
        presets.Controls.Add(lookBox);
        presets.Controls.Add(paletteBox);
        Add(presets);
        Colours();
        Combo("Upscaling", "display.filter", new[] { ("bicubic", "Smooth (bicubic)"), ("bilinear", "Sharp (bilinear)") });
        Slider("display.exposure", "Exposure", 0.2, 2.5, 0.05);
        Slider("display.body", "Body fill", 0, 1.5, 0.05);
        Slider("display.edge", "Membrane glow", 0, 2, 0.05);
        Slider("display.halo", "Halo", 0, 2, 0.05);
        Slider("display.haloRadius", "Halo radius (cells)", 1, 20, 0.5);
        Slider("display.crests", "Phase crests", 0, 1, 0.01);
        Slider("display.geneTint", "Genome tint", 0, 1, 0.05);
        Slider("display.relief", "DIC relief", 0, 1, 0.05);
        Slider("display.iridescence", "Iridescence", 0, 1, 0.05);
        Slider("display.specular", "Wet highlight", 0, 1.5, 0.05);
        Slider("display.pellicle", "Pellicle ring", 0, 1, 0.05);
        Slider("display.nucleus", "Nucleus glow", 0, 1.5, 0.05);
        Slider("display.vorticity", "Vorticity glow", 0, 2, 0.05);
        Slider("display.tonemap", "Film tonemap", 0, 1, 0.05);
        Slider("display.grain", "Sensor grain", 0, 3, 0.05);
        Slider("display.vignette", "Lens vignette", 0, 2, 0.05);

        Section("Drift");
        Note("Endless smooth randomisation: whatever is ticked eases toward a new random target, colours blending and sliders gliding; regimes morph into each other.");
        Check("Drift", "drift.enabled");
        Check("Optics", "drift.look");
        Check("Colours", "drift.colours");
        Check("Physics (flow, vortices)", "drift.physics");
        Check("Regimes (morphs)", "drift.regimes");
        Check("Speed", "drift.speed");
        Slider("drift.period", "Seconds per change", 10, 300, 5);
        Buttons(("Edit ranges…", EditRanges));

        Section("Physics");
        Note("Overrides for every regime. ↺ returns one to the regime's own value.");
        Override("physics.speciation", "Speciation (μ spread)", 0, 0.02, 0.001);
        Override("physics.curl", "Curl flow", 0, 2, 0.01);
        Override("physics.swirl", "Phase swirl", 0, 1.5, 0.01);
        Override("physics.vortexMu", "Vortex μ", 0, 0.03, 0.001);

        Section("Size and speed");
        Slider("cellPx", "Pixels per cell (smaller = more organisms, more GPU)", 1.5, 6, 0.5);
        Slider("speed", "Steps per second", 2, 60, 1);
        Slider("budget", "GPU budget (most of the GPU it may use)", 0.15, 0.9, 0.05, percent: true);
        Slider("minSteps", "Lowest step rate it may drop to", 0.2, 1, 0.05, percent: true);
        Check("Smooth motion (interpolated frames)", "smooth");

        Section("Mouse");
        Combo("Moving the mouse over the desktop", "interaction.move", new[] { ("stir", "Stirs the liquid"), ("ripple", "Taps the cover slip"), ("off", "Does nothing") });
        Slider("interaction.strength", "Strength", 0.1, 3, 0.05);
        Slider("interaction.radius", "Reach (× organism radius)", 0.2, 2, 0.05);

        Section("Share");
        Note("A settings code carries every setting (and a pinned regime). The web lab makes them too.");
        Buttons(("Import code…", ImportCode), ("Copy code", CopyCode), ("Reset all", () =>
        {
            if (MessageBox.Show(this, "Put every setting back to its default?", "TuringLife", MessageBoxButtons.OKCancel) == DialogResult.OK) Apply("reset", "true");
        }));
        var link = new LinkLabel { Text = "Open the web lab", AutoSize = true, Margin = new Padding(3, 4, 3, 12) };
        link.LinkClicked += (_, _) => System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(App.SiteUrl) { UseShellExecute = true });
        Add(link);
    }

    static string Command(string name) => new JsonObject { ["type"] = "command", ["name"] = name }.ToJsonString();

    void Apply(string what, string value)
    {
        var m = new JsonObject { ["type"] = "apply" };
        if (what == "reset") m["reset"] = true; else m[what] = value;
        PostPreview(m.ToJsonString());
    }

    void FillCombos()
    {
        refreshing = true;
        regimeBox.Items.Clear();
        regimeBox.Items.Add("Let it drift between all regimes");
        foreach (var r in regimes) regimeBox.Items.Add(r.name);
        lookBox.Items.Clear();
        lookBox.Items.Add("Apply a look…");
        foreach (var l in looks) lookBox.Items.Add(l.name);
        paletteBox.Items.Clear();
        paletteBox.Items.Add("Apply a palette…");
        foreach (var p in palettes) paletteBox.Items.Add(p.name);
        lookBox.SelectedIndex = 0;
        paletteBox.SelectedIndex = 0;
        refreshing = false;
        RefreshAll();
    }

    void ResetPicker(ComboBox box) => BeginInvoke(() => { refreshing = true; box.SelectedIndex = 0; refreshing = false; });

    // ---- control builders ----

    void Add(Control c)
    {
        c.Margin = c.Margin == default ? new Padding(3, 2, 3, 2) : c.Margin;
        side.Controls.Add(c);
    }

    void Section(string title)
    {
        side.Controls.Add(new Label
        {
            Text = title, AutoSize = true, Font = new Font(Font.FontFamily, 11f, FontStyle.Bold),
            Margin = new Padding(0, side.Controls.Count == 0 ? 0 : 14, 0, 4),
        });
    }

    void Note(string text) => side.Controls.Add(new Label { Text = text, MaximumSize = new Size(LogicalToDeviceUnits(ControlWidth), 0), AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(3, 0, 3, 4) });

    void Check(string label, Func<bool> get, Action<bool> set, string? tip = null)
    {
        var c = new CheckBox { Text = label, AutoSize = true };
        c.CheckedChanged += (_, _) => { if (!refreshing) set(c.Checked); };
        refreshers.Add(() => c.Checked = get());
        if (tip != null) tips.SetToolTip(c, tip);
        Add(c);
    }

    void Check(string label, string path) =>
        Check(label, () => app.Config.GetBool(path, false), v => { app.Config.Set(path, v); Changed(); });

    void Combo(string label, string path, (string value, string text)[] items)
    {
        side.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(3, 4, 3, 0) });
        var box = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = ControlWidth };
        foreach (var i in items) box.Items.Add(i.text);
        box.SelectedIndexChanged += (_, _) => { if (!refreshing && box.SelectedIndex >= 0) { app.Config.Set(path, items[box.SelectedIndex].value); Changed(); } };
        refreshers.Add(() => box.SelectedIndex = Math.Max(0, Array.FindIndex(items, i => i.value == app.Config.GetString(path))));
        Add(box);
    }

    void Buttons(params (string text, Action click)[] buttons)
    {
        var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 2, 0, 2) };
        foreach (var (text, click) in buttons)
        {
            var b = new Button { Text = text, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(6, 2, 6, 2) };
            b.Click += (_, _) => click();
            row.Controls.Add(b);
        }
        side.Controls.Add(row);
    }

    (Label, TrackBar) SliderRow(string label, double min, double max, double step, Action<double> onScroll)
    {
        var head = new Label { AutoSize = true, Margin = new Padding(3, 4, 3, 0) };
        var bar = new TrackBar
        {
            Minimum = 0, Maximum = (int)Math.Round((max - min) / step), TickStyle = TickStyle.None,
            Width = ControlWidth, AutoSize = false, Height = 26, Margin = new Padding(0),
        };
        bar.SmallChange = 1;
        bar.LargeChange = Math.Max(1, bar.Maximum / 10);
        bar.Scroll += (_, _) => onScroll(min + bar.Value * step);
        side.Controls.Add(head);
        side.Controls.Add(bar);
        return (head, bar);
    }

    static string Fmt(double v, double step, bool percent) =>
        percent ? $"{v * 100:0}%" : step >= 1 ? v.ToString("0") : step >= 0.1 ? v.ToString("0.0") : step >= 0.01 ? v.ToString("0.00") : v.ToString("0.000");

    void Slider(string path, string label, double min, double max, double step, bool percent = false)
    {
        Label head = null!;
        TrackBar bar = null!;
        (head, bar) = SliderRow(label, min, max, step, v =>
        {
            app.Config.Set(path, Math.Round(v, 4));
            head.Text = $"{label}: {Fmt(v, step, percent)}";
            Changed();
        });
        refreshers.Add(() =>
        {
            double v = app.Config.GetNumber(path, min);
            bar.Value = Math.Clamp((int)Math.Round((v - min) / step), bar.Minimum, bar.Maximum);
            head.Text = $"{label}: {Fmt(v, step, percent)}";
        });
    }

    void Override(string path, string label, double min, double max, double step)
    {
        Label head = null!;
        TrackBar bar = null!;
        (head, bar) = SliderRow(label, min, max, step, v =>
        {
            app.Config.Set(path, Math.Round(v, 4));
            head.Text = $"{label}: {Fmt(v, step, false)}";
            Changed();
        });
        var reset = new Button { Text = "↺", Width = 28, Height = 24, Margin = new Padding(3, 0, 3, 0) };
        tips.SetToolTip(reset, "Back to the regime's own value");
        reset.Click += (_, _) => { app.Config.Set(path, null); Changed(); RefreshAll(); };
        side.Controls.Remove(head);
        var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 4, 0, 0) };
        head.Margin = new Padding(3, 5, 3, 0);
        row.Controls.Add(head);
        row.Controls.Add(reset);
        side.Controls.Add(row);
        side.Controls.SetChildIndex(row, side.Controls.GetChildIndex(bar));
        refreshers.Add(() =>
        {
            var n = app.Config.Get(path);
            double v = n == null ? min : app.Config.GetNumber(path, min);
            bar.Value = Math.Clamp((int)Math.Round((v - min) / step), bar.Minimum, bar.Maximum);
            head.Text = n == null ? $"{label}: regime's own" : $"{label}: {Fmt(v, step, false)}";
            reset.Enabled = n != null;
        });
    }

    void Colours()
    {
        var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 2, 0, 4) };
        foreach (var (path, label) in new[] { ("display.colours.0", "A"), ("display.colours.1", "B"), ("display.colours.2", "C"), ("display.background", "Vacuum"), ("display.haloColour", "Halo") })
        {
            var b = new Button { Width = 62, Height = 40, Text = label, TextAlign = ContentAlignment.BottomCenter, FlatStyle = FlatStyle.Flat, Margin = new Padding(0, 0, 4, 0) };
            b.Click += (_, _) =>
            {
                using var dlg = new ColorDialog { Color = b.BackColor, FullOpen = true };
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                SetColour(path, dlg.Color);
                Changed();
                RefreshAll();
            };
            refreshers.Add(() =>
            {
                var c = GetColour(path);
                b.BackColor = c;
                b.ForeColor = c.GetBrightness() > 0.5 ? Color.Black : Color.White;
            });
            row.Controls.Add(b);
        }
        side.Controls.Add(row);
    }

    Color GetColour(string path)
    {
        JsonNode? n = path.EndsWith(".0") || path.EndsWith(".1") || path.EndsWith(".2")
            ? (app.Config.Get("display.colours") as JsonArray)?[int.Parse(path[^1..])]
            : app.Config.Get(path);
        if (n is not JsonArray a || a.Count < 3) return Color.Black;
        int C(int i) => Math.Clamp((int)Math.Round(a[i]!.GetValue<double>() * 255), 0, 255);
        return Color.FromArgb(C(0), C(1), C(2));
    }

    void SetColour(string path, Color c)
    {
        var rgb = new JsonArray(Math.Round(c.R / 255.0, 4), Math.Round(c.G / 255.0, 4), Math.Round(c.B / 255.0, 4));
        if (path.StartsWith("display.colours."))
        {
            var arr = app.Config.Get("display.colours") as JsonArray ?? new JsonArray(new JsonArray(0, 0, 0), new JsonArray(0, 0, 0), new JsonArray(0, 0, 0));
            arr[int.Parse(path[^1..])] = rgb;
            app.Config.Set("display.colours", arr.DeepClone());
        }
        else app.Config.Set(path, rgb);
    }

    // ---- dialogs ----

    void EditRanges()
    {
        using var dlg = new Form
        {
            Text = "Drift ranges", Size = new Size(460, 640), StartPosition = FormStartPosition.CenterParent,
            MinimizeBox = false, MaximizeBox = false, Icon = Icon, Font = Font,
        };
        var grid = new DataGridView
        {
            Dock = DockStyle.Fill, AllowUserToAddRows = false, AllowUserToDeleteRows = false, RowHeadersVisible = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, SelectionMode = DataGridViewSelectionMode.CellSelect,
        };
        grid.Columns.Add("name", "Setting");
        grid.Columns.Add("min", "Min");
        grid.Columns.Add("max", "Max");
        grid.Columns[0].ReadOnly = true;
        grid.Columns[0].FillWeight = 180;
        var mine = app.Config.Get("drift.ranges") as JsonObject;
        foreach (var r in ranges.OfType<JsonObject>())
        {
            string key = r["key"]!.GetValue<string>();
            var own = mine?[key] as JsonArray;
            double lo = own?[0]?.GetValue<double>() ?? r["min"]!.GetValue<double>();
            double hi = own?[1]?.GetValue<double>() ?? r["max"]!.GetValue<double>();
            int i = grid.Rows.Add(r["label"]!.GetValue<string>(), lo, hi);
            grid.Rows[i].Tag = r;
        }
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Padding = new Padding(6) };
        var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, AutoSize = true };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        var defaults = new Button { Text = "Defaults", AutoSize = true };
        defaults.Click += (_, _) =>
        {
            foreach (DataGridViewRow row in grid.Rows)
            {
                var r = (JsonObject)row.Tag!;
                row.Cells[1].Value = r["min"]!.GetValue<double>();
                row.Cells[2].Value = r["max"]!.GetValue<double>();
            }
        };
        buttons.Controls.AddRange(new Control[] { ok, cancel, defaults });
        dlg.Controls.Add(grid);
        dlg.Controls.Add(buttons);
        dlg.AcceptButton = ok;
        dlg.CancelButton = cancel;
        if (dlg.ShowDialog(this) != DialogResult.OK) return;

        var result = new JsonObject();
        foreach (DataGridViewRow row in grid.Rows)
        {
            var r = (JsonObject)row.Tag!;
            if (!double.TryParse(Convert.ToString(row.Cells[1].Value), out double lo) || !double.TryParse(Convert.ToString(row.Cells[2].Value), out double hi)) continue;
            double limit = r["limit"]!.GetValue<double>();
            lo = Math.Clamp(lo, 0, limit);
            hi = Math.Clamp(hi, 0, limit);
            if (lo > hi) (lo, hi) = (hi, lo);
            if (Math.Abs(lo - r["min"]!.GetValue<double>()) > 1e-9 || Math.Abs(hi - r["max"]!.GetValue<double>()) > 1e-9)
                result[r["key"]!.GetValue<string>()] = new JsonArray(lo, hi);
        }
        app.Config.Set("drift.ranges", result);
        Changed();
    }

    void ImportCode()
    {
        string text = Clipboard.ContainsText() ? Clipboard.GetText().Trim() : "";
        using var dlg = new Form
        {
            Text = "Import a settings code", Size = new Size(520, 220), StartPosition = FormStartPosition.CenterParent,
            MinimizeBox = false, MaximizeBox = false, Icon = Icon, Font = Font, FormBorderStyle = FormBorderStyle.FixedDialog,
        };
        var box = new TextBox { Multiline = true, Dock = DockStyle.Fill, Text = text, ScrollBars = ScrollBars.Vertical };
        var hint = new Label { Dock = DockStyle.Top, Text = "Paste a code from the web lab (Controls → Desktop wallpaper) or from Copy code:", Height = 28, Padding = new Padding(4, 6, 4, 0) };
        var ok = new Button { Text = "Import", DialogResult = DialogResult.OK, Dock = DockStyle.Bottom, Height = 30 };
        dlg.Controls.Add(box);
        dlg.Controls.Add(hint);
        dlg.Controls.Add(ok);
        dlg.AcceptButton = ok;
        if (dlg.ShowDialog(this) == DialogResult.OK && box.Text.Trim().Length > 0) Apply("code", box.Text.Trim());
    }

    void CopyCode()
    {
        string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(app.Config.Settings.ToJsonString())).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        string code = b64 + (app.Config.Auto || app.Config.Regime == null ? "" : "." + app.Config.Regime);
        Clipboard.SetText(code);
        MessageBox.Show(this, "Copied. Paste it into another copy of the app (Import code), or open it in the web lab as " +
            $"{App.SiteUrl}/?s=<code>.", "TuringLife", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
