using TauriKit.Sidecar.Loopback;

namespace Lowline.Host;

/// <summary>
/// Failures away from any request — work the sidecar does on its own — kept until the shell takes
/// them, since the sidecar never sends anything itself. Each is a <see cref="FaultView"/>, as a failed
/// request's answer is: what failed, never with what.
/// </summary>
public sealed class HostFailures
{
    /// <summary>Past this many, more of the same would say nothing new.</summary>
    public const int Capacity = 20;

    /// <summary>
    /// The code whose methods a failure names: the app's own, and the libraries it is assembled from —
    /// most of the work happens in them, and the path through them is what tells one failure from
    /// another. The runtime's and the web framework's frames say nothing about which.
    /// </summary>
    public static readonly IReadOnlyList<string> OwnNamespaces = ["Lowline.", "Formbase.", "FluxIndex.", "Flux."];

    private readonly Lock _lock = new();
    private readonly List<FaultView> _kept = [];

    public void Record(Exception exception)
    {
        lock (_lock)
        {
            if (_kept.Count < Capacity) _kept.Add(Fault.Of(exception, OwnNamespaces));
        }
    }

    /// <summary>What failed since the last time, which is then forgotten.</summary>
    public IReadOnlyList<FaultView> Take()
    {
        lock (_lock)
        {
            var taken = _kept.ToList();
            _kept.Clear();
            return taken;
        }
    }
}
