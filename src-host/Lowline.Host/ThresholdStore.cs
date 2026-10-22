using System.Text.Json;
using DesktopHost.Files;

namespace Lowline.Host;

/// <summary>
/// The thresholds each template's replay chose, as the engine hands them over, kept beside the vault's projection cache so
/// a later launch starts from them instead of replaying the whole history again — seconds on a large vault, and until it is
/// done the fields would offer nothing, though their history earned it. It is a cache like the projection: outside the
/// vault, this device's own, and a file that cannot be read is no thresholds at all — the replay chooses them again. So is a
/// template's tuning the engine says no longer stands: chosen by another version, or over other fields.
/// </summary>
public static class ThresholdStore
{
    /// <summary>The shape of the file; one written in another is not read.</summary>
    private const int Format = 10;

    private sealed record Stored(int Format, IReadOnlyDictionary<string, string> Templates);

    private static readonly IReadOnlyDictionary<string, string> None = new Dictionary<string, string>();

    /// <summary>The tuning of each template kept at <paramref name="path"/>.</summary>
    public static IReadOnlyDictionary<string, string> Load(string path)
    {
        try
        {
            var stored = JsonSerializer.Deserialize<Stored>(AtomicFile.ReadAllTextShared(path), JsonSerializerOptions.Web);
            return stored?.Format == Format ? stored.Templates : None;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return None;
        }
    }

    /// <summary>Keeps the tunings chosen.</summary>
    public static void Save(string path, IReadOnlyDictionary<string, string> tunings)
    {
        // Replaced whole — flushed, and retried while a scanner or sync client holds the file — so a launch never reads
        // half a file.
        AtomicFile.WriteAllText(path, JsonSerializer.Serialize(new Stored(Format, tunings), JsonSerializerOptions.Web));
    }
}
