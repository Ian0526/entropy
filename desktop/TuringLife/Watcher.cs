using System.Diagnostics;
using System.Management;

namespace TuringLife;

/// <summary>
/// Watches what the PC is doing so the wallpaper never competes with it. Every 2 seconds:
///  - a fullscreen app in the foreground (a game, a fullscreen video),
///  - other programs keeping the GPU's 3D engine more than 50% busy, or
///  - the CPU more than 85% busy
/// means "slow": the world crawls (about 1–2 steps and 5 pictures a second, a negligible load) but
/// stays alive. It slows after two such readings in a row and speeds up after three calm ones.
/// </summary>
internal sealed class Watcher : IDisposable
{
    const double CpuSlow = 85, GpuSlow = 50;
    readonly System.Threading.Timer timer;
    readonly SynchronizationContext ui;
    readonly Action<string, string> onChange;
    readonly PerformanceCounter? cpu;
    Dictionary<string, CounterSample> lastGpu = new();
    HashSet<int> ours = new();
    DateTime oursAt = DateTime.MinValue;
    string level = "run", pending = "";
    int count;
    int busy;

    /// <param name="onChange">Called on the UI thread with the new level and the reason.</param>
    public Watcher(Action<string, string> onChange)
    {
        this.onChange = onChange;
        ui = SynchronizationContext.Current ?? new SynchronizationContext();
        try { cpu = new PerformanceCounter("Processor", "% Processor Time", "_Total"); cpu.NextValue(); } catch { cpu = null; }
        timer = new System.Threading.Timer(_ => Tick(), null, 2000, 2000);
    }

    public string Level => level;

    void Tick()
    {
        if (Interlocked.Exchange(ref busy, 1) == 1) return;
        try
        {
            if ((DateTime.UtcNow - oursAt).TotalSeconds > 30) { ours = OurProcesses(); oursAt = DateTime.UtcNow; }
            string want = "run", why = "";
            int fs = Native.FullscreenForeground();
            if (fs != 0 && !ours.Contains(fs) && fs != Environment.ProcessId)
            {
                want = "slow";
                try { why = "fullscreen: " + Process.GetProcessById(fs).ProcessName; } catch { why = "fullscreen app"; }
            }
            else
            {
                double gpu = OthersGpu();
                double c = cpu?.NextValue() ?? 0;
                if (gpu > GpuSlow) { want = "slow"; why = $"GPU busy ({gpu:0}%)"; }
                else if (c > CpuSlow) { want = "slow"; why = $"CPU busy ({c:0}%)"; }
            }

            if (want == level) { pending = ""; count = 0; return; }
            if (want != pending) { pending = want; count = 0; }
            count++;
            if (count >= (want == "slow" ? 2 : 3))
            {
                level = want; pending = ""; count = 0;
                string l = level, w = why;
                ui.Post(_ => onChange(l, w), null);
            }
        }
        catch { /* counters can fail transiently; try again next tick */ }
        finally { Volatile.Write(ref busy, 0); }
    }

    /// <summary>The 3D-engine use of every other process, summed (each process's busiest engine).</summary>
    double OthersGpu()
    {
        var now = new Dictionary<string, CounterSample>();
        var byPid = new Dictionary<int, double>();
        try
        {
            var cat = new PerformanceCounterCategory("GPU Engine");
            var data = cat.ReadCategory()["Utilization Percentage"];
            if (data == null) return 0;
            foreach (InstanceData inst in data.Values)
            {
                string name = inst.InstanceName;
                if (!name.Contains("engtype_3D")) continue;
                now[name] = inst.Sample;
                if (!lastGpu.TryGetValue(name, out var before)) continue;
                int at = name.IndexOf("pid_", StringComparison.Ordinal);
                if (at < 0 || !int.TryParse(name.AsSpan(at + 4, name.IndexOf('_', at + 4) - at - 4), out int pid)) continue;
                if (ours.Contains(pid)) continue;
                double v = CounterSample.Calculate(before, inst.Sample);
                byPid[pid] = Math.Max(byPid.GetValueOrDefault(pid), v);
            }
        }
        catch { return 0; }
        lastGpu = now;
        return byPid.Values.Sum();
    }

    /// <summary>This app and its WebView2 processes (their own GPU use doesn't count).</summary>
    static HashSet<int> OurProcesses()
    {
        var set = new HashSet<int> { Environment.ProcessId };
        try
        {
            var parent = new Dictionary<int, int>();
            using var q = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId FROM Win32_Process WHERE Name='msedgewebview2.exe'");
            foreach (ManagementObject o in q.Get())
                parent[Convert.ToInt32(o["ProcessId"])] = Convert.ToInt32(o["ParentProcessId"]);
            bool grew = true;
            while (grew)
            {
                grew = false;
                foreach (var (pid, pp) in parent)
                    if (!set.Contains(pid) && set.Contains(pp)) { set.Add(pid); grew = true; }
            }
        }
        catch { }
        return set;
    }

    public void Dispose()
    {
        timer.Dispose();
        cpu?.Dispose();
    }
}
