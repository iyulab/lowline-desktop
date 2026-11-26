using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Lowline.Host;

/// <summary>
/// A suggestion this device showed, as its record of them holds it: when, in which template's field, from which source,
/// and with how many characters typed then (absent in those from before it was recorded).
/// </summary>
public sealed record Presentation(string At, string Template, string Field, string? Source = null, double? Typed = null);

/// <summary>What the weekly counts are asked with: this device's record of the suggestions it showed.</summary>
public sealed record WeeklyCountsQuery(IReadOnlyList<Presentation>? Presentations = null);

/// <summary>
/// The weekly counts (<see cref="Export"/>, the format a person hands over) and which template each form number is
/// (<see cref="FormRefs"/>, the first is form 1) — shown to the person exporting so they know which is which, and never
/// exported. Both come from one snapshot, so they never disagree on the numbering.
/// </summary>
public sealed record WeeklyCountsReport(IReadOnlyList<string> FormRefs, WeeklyCountsExport Export);

/// <summary>The format <c>lowline-weekly-counts/1</c>: numbers only — forms and fields are numbered, and no value, name or path is in it.</summary>
public sealed record WeeklyCountsExport(
    string Format, IReadOnlyList<WeekCounts> Counts, IReadOnlyList<FormCounts> Forms, IReadOnlyList<double> DwellEdgesSec,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? PresentedSince = null);

/// <summary>One week of one judgment field (the meaning of each count: the app's <c>weekly-counts</c> types and <c>docs/suggestions.md</c>).</summary>
public sealed class WeekCounts(string week, int form, int field)
{
    public string Week { get; } = week;
    public int Form { get; } = form;
    public int Field { get; } = field;
    public int Presented { get; set; }
    public int Accepted { get; set; }
    public int Corrected { get; set; }
    public int Rejected { get; set; }
    public Dictionary<string, DecidedCount> BySimilarity { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, DecidedCount> BySource { get; } = new(StringComparer.Ordinal);
    /// <summary>Slots <c>"0"</c>, <c>"1"</c>, <c>"2"</c>, <c>"3+"</c>, in that order.</summary>
    public SortedDictionary<string, TypedCounts> ByTyped { get; } = new(StringComparer.Ordinal);
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CheckedCount? Checked { get; set; }
}

public sealed class DecidedCount
{
    public int Decided { get; set; }
    public int Accepted { get; set; }
}

public sealed class CheckedCount
{
    public int Entered { get; set; }
    public int Held { get; set; }
}

public sealed class TypedCounts
{
    public int Presented { get; set; }
    public int Decided { get; set; }
    public int Accepted { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dwell? Dwell { get; set; }
}

/// <summary>Decisions per span of <see cref="WeeklyCounts.DwellEdgesSec"/>.</summary>
public sealed class Dwell
{
    public int[] Accepted { get; } = WeeklyCounts.Spans();
    public int[] AcceptedNoTyping { get; } = WeeklyCounts.Spans();
    public int[] AcceptedAfterTyping { get; } = WeeklyCounts.Spans();
    public int[] Other { get; } = WeeklyCounts.Spans();
}

public sealed record FormCounts(int Form, int Confirmed, int Outside, int Weeks, double PerWeek);

/// <summary>
/// Weekly counts of what people did with suggestions — for a person to hand to whoever studies whether suggestions improve
/// with use. Counted here alone; the app shows and copies what this returns. Weeks are in this device's time
/// (<paramref name="zone"/>), the time a document's file is named by.
/// </summary>
public static partial class WeeklyCounts
{
    public const string Format = "lowline-weekly-counts/1";

    /// <summary>The edges, in seconds, between the spans dwell is counted in: under 0.5 s, 0.5 to under 1 s, … 32 s and over.</summary>
    public static readonly IReadOnlyList<double> DwellEdgesSec = [0.5, 1, 2, 4, 8, 16, 32];

    internal static int[] Spans() => new int[DwellEdgesSec.Count + 1];

    /// <summary>The span of <see cref="DwellEdgesSec"/> a time in seconds falls in.</summary>
    public static int DwellSpan(double seconds) => DwellEdgesSec.Count(edge => seconds >= edge);

    /// <summary>The <c>byTyped</c> slot of a count of characters typed: 0, 1, 2, or 3 and more.</summary>
    public static string TypedSlot(double typed) =>
        typed >= 3 ? "3+" : Math.Max(0, Math.Floor(typed)).ToString(CultureInfo.InvariantCulture);

    /// <summary>The forms counted — those with judgment fields — numbered from 1 in the (ordinal) order of their references.</summary>
    public static IReadOnlyList<TemplateSnapshot> NumberedForms(IEnumerable<TemplateSnapshot> templates) =>
        [.. templates.Where(t => t.Suggest is { Count: > 0 }).OrderBy(t => t.Ref, StringComparer.Ordinal)];

    /// <summary>The Monday of the week <paramref name="at"/> falls in, in <paramref name="zone"/>, as <c>YYYY-MM-DD</c>.</summary>
    public static string WeekOf(DateTimeOffset at, TimeZoneInfo zone) => MondayOf(at, zone).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static DateOnly MondayOf(DateTimeOffset at, TimeZoneInfo zone)
    {
        var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, zone).DateTime);
        return day.AddDays(-(((int)day.DayOfWeek + 6) % 7)); // DayOfWeek: 0 = Sunday
    }

    [GeneratedRegex("^([0-9]{4})-([0-9]{2})-([0-9]{2})(?=[-. ]|$)")]
    private static partial Regex NamedDayPattern();

    /// <summary>
    /// The day a document's file is named by (<c>2026-10-13-문의.md</c>, <c>2026-10-13 (1).md</c>), as the start of that
    /// day in <paramref name="zone"/>; null for a name that starts with no day.
    /// </summary>
    public static DateTimeOffset? NamedDay(string path, TimeZoneInfo zone)
    {
        var match = NamedDayPattern().Match(path[(path.LastIndexOf('/') + 1)..]);
        if (!match.Success) return null;
        var (year, month, day) = (int.Parse(match.Groups[1].Value), int.Parse(match.Groups[2].Value), int.Parse(match.Groups[3].Value));
        if (year < 1 || month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(year, month)) return null;
        var midnight = new DateTime(year, month, day, 0, 0, 0, DateTimeKind.Unspecified);
        return new DateTimeOffset(midnight, zone.GetUtcOffset(midnight));
    }

    private static DateTimeOffset? Parse(string? when) =>
        DateTimeOffset.TryParse(when, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null;

    public static WeeklyCountsReport Compute(VaultSnapshot vault, IReadOnlyList<Presentation> presentations, TimeZoneInfo zone)
    {
        var forms = NumberedForms(vault.Templates);
        var formNumber = forms.Select((t, i) => (t.Ref, Number: i + 1)).ToDictionary(p => p.Ref, p => p.Number, StringComparer.Ordinal);
        var templateOf = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var document in vault.Documents) templateOf[document.Identity] = document.Template;

        var cells = new Dictionary<(string Week, int Form, int Field), WeekCounts>();
        WeekCounts? CellOf(string? template, string field, string when)
        {
            var form = template is not null && formNumber.TryGetValue(template, out var number) ? number : 0;
            var fieldNumber = form > 0 ? IndexOf(forms[form - 1].Suggest!, field) + 1 : 0;
            if (form == 0 || fieldNumber == 0 || Parse(when) is not { } at) return null;
            var key = (WeekOf(at, zone), form, fieldNumber);
            if (!cells.TryGetValue(key, out var cell)) cells[key] = cell = new WeekCounts(key.Item1, form, fieldNumber);
            return cell;
        }
        static TypedCounts TypedOf(WeekCounts cell, double typed)
        {
            var slot = TypedSlot(typed);
            if (!cell.ByTyped.TryGetValue(slot, out var counts)) cell.ByTyped[slot] = counts = new TypedCounts();
            return counts;
        }
        static DecidedCount Slot(Dictionary<string, DecidedCount> slots, string key)
        {
            if (!slots.TryGetValue(key, out var slot)) slots[key] = slot = new DecidedCount();
            return slot;
        }

        DateTimeOffset? oldestShown = null;
        foreach (var shown in presentations)
        {
            if (Parse(shown.At) is { } at && (oldestShown is null || at < oldestShown)) oldestShown = at;
            if (CellOf(shown.Template, shown.Field, shown.At) is not { } cell) continue;
            cell.Presented++;
            if (shown.Typed is { } typed) TypedOf(cell, typed).Presented++;
        }
        foreach (var e in vault.Events ?? [])
        {
            // An event names its template; older ones are placed through their document, if it is still there.
            if (CellOf(e.Template ?? templateOf.GetValueOrDefault(e.Doc), e.Field, e.At) is not { } cell) continue;
            var accepted = e.Kind == "accept";
            if (e.Kind == "check")
            {
                cell.Checked ??= new CheckedCount();
                cell.Checked.Entered++;
                if (e.Value is { ValueKind: not JsonValueKind.Null and not JsonValueKind.Undefined } value && AsText(value) == e.Suggested)
                    cell.Checked.Held++;
                continue;
            }
            if (accepted) cell.Accepted++;
            else if (e.Kind == "correct") cell.Corrected++;
            else cell.Rejected++;
            if (!string.IsNullOrEmpty(e.Source))
            {
                var slot = Slot(cell.BySource, e.Source);
                slot.Decided++;
                if (accepted) slot.Accepted++;
            }
            if (e.Typed is { } typed)
            {
                var slot = TypedOf(cell, typed);
                slot.Decided++;
                if (accepted) slot.Accepted++;
                // A time that runs backwards says the clock moved, not how long a person took.
                if (!string.IsNullOrEmpty(e.ShownAt) && !string.IsNullOrEmpty(e.DecidedAt)
                    && Parse(e.DecidedAt) is { } decided && Parse(e.ShownAt) is { } shownAt
                    && (decided - shownAt).TotalSeconds is var dwell && dwell >= 0)
                {
                    var spans = slot.Dwell ??= new Dwell();
                    var span = DwellSpan(dwell);
                    if (accepted)
                    {
                        spans.Accepted[span]++;
                        if (e.DecidedTyped is { } decidedTyped)
                            (decidedTyped == typed ? spans.AcceptedNoTyping : spans.AcceptedAfterTyping)[span]++;
                    }
                    else spans.Other[span]++;
                }
            }
            if (e.Similarity is { } similarity)
            {
                var bucket = (Math.Floor(Math.Min(similarity, 1) * 10) / 10).ToString("0.0", CultureInfo.InvariantCulture);
                var slot = Slot(cell.BySimilarity, bucket);
                slot.Decided++;
                if (accepted) slot.Accepted++;
            }
        }

        var formCounts = forms.Select((template, i) =>
        {
            var confirmed = vault.Documents.Where(d =>
                d.Template == template.Ref && !d.Conflicted
                && template.Suggest!.Any(f => d.Values.TryGetValue(f, out var v) && IsFilled(v) && !(d.Proposed?.Contains(f) ?? false))).ToList();
            // A document's day is the one its file is named by, or for a file renamed without it, its last save.
            var times = confirmed
                .Select(d => NamedDay(d.Path, zone)?.ToUnixTimeMilliseconds() ?? d.Modified)
                .OfType<long>().Where(ms => ms > 0).Select(DateTimeOffset.FromUnixTimeMilliseconds).ToList();
            var weeks = times.Count == 0 ? 0 : (MondayOf(times.Max(), zone).DayNumber - MondayOf(times.Min(), zone).DayNumber) / 7 + 1;
            var perWeek = weeks == 0 ? 0 : Math.Round((double)confirmed.Count / weeks * 100, MidpointRounding.AwayFromZero) / 100;
            return new FormCounts(i + 1, confirmed.Count, confirmed.Count(d => d.Outside), weeks, perWeek);
        }).ToList();

        var counts = cells.Values
            .OrderBy(c => c.Week, StringComparer.Ordinal).ThenBy(c => c.Form).ThenBy(c => c.Field).ToList();
        return new WeeklyCountsReport(
            [.. forms.Select(t => t.Ref)],
            new WeeklyCountsExport(Format, counts, formCounts, DwellEdgesSec, oldestShown is { } oldest ? WeekOf(oldest, zone) : null));
    }

    private static int IndexOf(IReadOnlyList<string> names, string name)
    {
        for (var i = 0; i < names.Count; i++) if (names[i] == name) return i;
        return -1;
    }

    private static bool IsFilled(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => false,
        JsonValueKind.String => value.GetString() != "",
        JsonValueKind.Array => value.GetArrayLength() > 0,
        _ => true,
    };

    /// <summary>A value as the event file's reader writes it as text: a list's items joined by <c>", "</c>.</summary>
    private static string AsText(JsonElement value) => value.ValueKind == JsonValueKind.Array
        ? string.Join(", ", value.EnumerateArray().Select(v => v.ValueKind is JsonValueKind.Null ? "" : Scalar(v)))
        : Scalar(value);

    private static string Scalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!,
        JsonValueKind.Number => value.GetDouble().ToString(CultureInfo.InvariantCulture),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Null => "null",
        _ => value.GetRawText(),
    };
}
