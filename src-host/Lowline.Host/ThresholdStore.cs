using System.Reflection;
using System.Text.Json;
using DesktopHost.Files;
using Gil.Forms;

namespace Lowline.Host;

/// <summary>
/// The thresholds each judgment field's replay chose, kept beside the vault's projection cache so a later
/// launch starts from them instead of replaying the whole history again — seconds on a large vault, and
/// until it is done the fields would offer nothing, though their history earned it. It is
/// a cache like the projection: outside the vault, this device's own, and a file that cannot be read is no
/// thresholds at all — the replay chooses them again. So is one chosen by another Gil: a threshold is on the
/// scale of the score Gil compares it with, and a release may change that scale.
/// </summary>
public static class ThresholdStore
{
    /// <summary>The shape of the file; one written in another is not read.</summary>
    private const int Format = 9;

    /// <summary>The Gil whose scores the thresholds are on.</summary>
    public static readonly string Scorer =
        typeof(ThresholdSelection).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(ThresholdSelection).Assembly.GetName().Version?.ToString()
        ?? "";

    private sealed record Entry(
        string Template, string Field, ThresholdChoice? Choice, int SelectedAt, ThresholdChoice? Closest, IReadOnlyList<string>? Domain,
        IReadOnlyList<string>? KeyFields, IReadOnlyList<ThresholdChoice?>? Typed, int? CoarsePrefix, ThresholdChoice? Coarse,
        IReadOnlyDictionary<string, double>? KeyConcentrations, ThresholdChoice? Similar = null);

    private sealed record Stored(int Format, string? Scorer, IReadOnlyList<Entry> Fields);

    private static readonly IReadOnlyDictionary<(string, string), FieldThreshold> None = new Dictionary<(string, string), FieldThreshold>();

    /// <summary>
    /// The thresholds kept at <paramref name="path"/>, each with the count of confirmed documents it was chosen
    /// over; <see cref="FieldThreshold.Confirmed"/> is that count too, until the vault says how many it has now.
    /// </summary>
    public static IReadOnlyDictionary<(string Template, string Field), FieldThreshold> Load(string path)
    {
        try
        {
            var stored = JsonSerializer.Deserialize<Stored>(AtomicFile.ReadAllTextShared(path), JsonSerializerOptions.Web);
            if (stored?.Format != Format || stored.Scorer != Scorer) return None;
            return stored.Fields.ToDictionary(
                e => (e.Template, e.Field),
                e => new FieldThreshold(e.Choice, e.SelectedAt, e.SelectedAt, e.Closest, e.Domain, e.KeyFields, e.Typed, e.CoarsePrefix, e.Coarse,
                    e.KeyConcentrations, e.Similar));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return None;
        }
    }

    /// <summary>Keeps the thresholds that have been chosen; one never chosen is left out.</summary>
    public static void Save(string path, IReadOnlyDictionary<(string Template, string Field), FieldThreshold> thresholds)
    {
        var stored = new Stored(Format, Scorer, [.. thresholds
            .Where(t => t.Value.SelectedAt is not null)
            .Select(t => new Entry(t.Key.Template, t.Key.Field, t.Value.Choice, t.Value.SelectedAt!.Value, t.Value.Closest, t.Value.Domain, t.Value.KeyFields, t.Value.Typed,
                t.Value.CoarsePrefix, t.Value.Coarse, t.Value.KeyConcentrations, t.Value.Similar))]);
        // Replaced whole — flushed, and retried while a scanner or sync client holds the file — so a launch never reads
        // half a file.
        AtomicFile.WriteAllText(path, JsonSerializer.Serialize(stored, JsonSerializerOptions.Web));
    }
}
