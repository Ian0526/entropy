using System.Diagnostics;
using Microsoft.Win32;

namespace TuringLife;

/// <summary>
/// The .exe installs itself: run from anywhere else (a download), it offers to copy itself to
/// %LOCALAPPDATA%\Programs\TuringLife, add a Start menu shortcut and an entry in Settings → Apps
/// (so it can be uninstalled like any app), and optionally start with Windows. Per user, no admin.
/// </summary>
internal static class Installer
{
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\TuringLifeWallpaper";
    static readonly string StartMenuLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "TuringLife Wallpaper.lnk");
    static readonly string DesktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "TuringLife Wallpaper.lnk");

    public static bool RunningInstalled =>
        string.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(Paths.InstalledExe), StringComparison.OrdinalIgnoreCase);

    /// <summary>Shows the install window. Returns true if the installed copy was started (this one should exit).</summary>
    public static bool Offer()
    {
        bool upgrade = File.Exists(Paths.InstalledExe);
        using var form = new Form
        {
            Text = upgrade ? "Update TuringLife Wallpaper" : "Install TuringLife Wallpaper",
            FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen, Icon = App.AppIcon, AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink, Font = new Font("Segoe UI", 9.5f), Padding = new Padding(16),
        };
        var layout = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
        var title = new Label { Text = "TuringLife Wallpaper", Font = new Font("Segoe UI", 14f, FontStyle.Bold), AutoSize = true };
        var text = new Label
        {
            AutoSize = true, MaximumSize = new Size(440, 0), Margin = new Padding(3, 6, 3, 10),
            Text = "A living Morphogenesis world behind your desktop icons: multi-channel Lenia organisms seeded by " +
                   "quantum randomness, which drift, bond and morph between laws. It slows to a crawl while you game.\n\n" +
                   (upgrade ? "A copy is already installed; this will replace it with this version." : $"It installs for you only, into {Paths.InstallDir}."),
        };
        var startup = new CheckBox { Text = "Start with Windows", Checked = !upgrade || Startup.Enabled, AutoSize = true };
        var desktop = new CheckBox { Text = "Add a desktop shortcut", Checked = File.Exists(DesktopLink), AutoSize = true };
        var buttons = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0, 14, 0, 0) };
        var install = new Button { Text = upgrade ? "Update" : "Install", AutoSize = true, DialogResult = DialogResult.OK, Padding = new Padding(10, 3, 10, 3) };
        var tryIt = new Button { Text = "Just run it", AutoSize = true, DialogResult = DialogResult.Ignore, Padding = new Padding(10, 3, 10, 3) };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel, Padding = new Padding(10, 3, 10, 3) };
        buttons.Controls.AddRange(new Control[] { install, tryIt, cancel });
        layout.Controls.AddRange(new Control[] { title, text, startup, desktop, buttons });
        form.Controls.Add(layout);
        form.AcceptButton = install;
        form.CancelButton = cancel;

        var result = form.ShowDialog();
        if (result == DialogResult.Ignore) return false; // run this copy without installing
        if (result != DialogResult.OK) { Environment.Exit(0); return true; }

        try
        {
            Program.StopOtherInstance();
            Directory.CreateDirectory(Paths.InstallDir);
            File.Copy(Environment.ProcessPath!, Paths.InstalledExe, true);
            Shortcut(StartMenuLink, Paths.InstalledExe);
            if (desktop.Checked) Shortcut(DesktopLink, Paths.InstalledExe);
            else if (File.Exists(DesktopLink)) File.Delete(DesktopLink);
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", "TuringLife Wallpaper");
                k.SetValue("DisplayIcon", Paths.InstalledExe);
                k.SetValue("DisplayVersion", Application.ProductVersion.Split('+')[0]);
                k.SetValue("Publisher", "TuringLife");
                k.SetValue("InstallLocation", Paths.InstallDir);
                k.SetValue("UninstallString", $"\"{Paths.InstalledExe}\" --uninstall");
                k.SetValue("URLInfoAbout", App.SiteUrl);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)(new FileInfo(Paths.InstalledExe).Length / 1024), RegistryValueKind.DWord);
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                if (startup.Checked) k.SetValue("TuringLifeWallpaper", $"\"{Paths.InstalledExe}\" --background");
                else k.DeleteValue("TuringLifeWallpaper", false);
            }
            Process.Start(new ProcessStartInfo(Paths.InstalledExe, "--settings") { UseShellExecute = false });
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show("Installing failed:\n" + ex.Message, "TuringLife", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return true;
        }
    }

    public static void Uninstall()
    {
        if (MessageBox.Show("Remove TuringLife Wallpaper from this PC?", "TuringLife", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        Program.StopOtherInstance();
        try { Startup.Enabled = false; } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
        foreach (var link in new[] { StartMenuLink, DesktopLink }) try { if (File.Exists(link)) File.Delete(link); } catch { }
        try { if (Directory.Exists(Paths.LocalData)) Directory.Delete(Paths.LocalData, true); } catch { }
        try { if (Directory.Exists(Paths.RoamingData)) Directory.Delete(Paths.RoamingData, true); } catch { }
        Native.RepaintWallpaper();
        // This .exe is the one being removed, so its folder goes once it has exited.
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"{Paths.InstallDir}\"")
        { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
        MessageBox.Show("TuringLife Wallpaper has been removed.", "TuringLife", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    static void Shortcut(string link, string target)
    {
        Type? t = Type.GetTypeFromProgID("WScript.Shell");
        if (t == null) return;
        dynamic shell = Activator.CreateInstance(t)!;
        dynamic sc = shell.CreateShortcut(link);
        sc.TargetPath = target;
        sc.Arguments = "--settings";
        sc.WorkingDirectory = Path.GetDirectoryName(target);
        sc.IconLocation = target + ",0";
        sc.Description = "TuringLife Wallpaper settings";
        sc.Save();
    }
}
