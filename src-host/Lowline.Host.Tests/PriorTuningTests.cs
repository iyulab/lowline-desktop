using System.Text.Encodings.Web;
using System.Text.Json;

namespace Lowline.Host.Tests;

/// <summary>
/// What a form's first records would be offered if it started from thresholds chosen on another vault of the same form —
/// a sample pack's prior — instead of waiting for its own. Thresholds are chosen once on the vault in
/// <c>LOWLINE_PRIOR_SNAPSHOT</c>, then the records of the vault in <c>LOWLINE_REPLAY_SNAPSHOT</c> are asked about field by
/// field as <see cref="ReplayTests"/> asks them, two ways: on those thresholds kept as they are, and as the app does today
/// — its own thresholds chosen again after each save. A field is measured only in its window: from its first record until
/// its own thresholds stand (<see cref="Stands"/>) — the stretch a prior is for, since from then on the app switches to its
/// own. The window is cut at <c>LOWLINE_PRIOR_FIRST</c> records when it is set. For each field it reports how long the
/// window was, how many values were shown in it, how many were the one saved, and the mean precision promised for them: a
/// prior is fit to ship only where what it promised is not above what came true. Both snapshots are written by
/// <c>src/__tests__/replay.test.ts</c>; runs only when both are named.
/// </summary>
public sealed class PriorTuningTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerOptions.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private sealed record Played(IReadOnlyList<TemplateSnapshot> Templates, IReadOnlyList<DocumentSnapshot> Documents, int BroughtIn);

    private sealed class Tally
    {
        public int Asked;
        public int Shown;
        public int Right;
        public double Promised;
        public int WithPromise;

        /// <summary>The records asked before the field's own thresholds stood; null while they never have.</summary>
        public int? StoodAfter;

        public override string ToString() =>
            $"{Right}/{Shown} right of {Asked} asked ({(Shown == 0 ? 0 : 100.0 * Right / Shown):F0}%)"
            + (WithPromise == 0 ? "" : $" · promised {100.0 * Promised / WithPromise:F0}%");
    }

    [Fact]
    public async Task Measures_the_first_records_on_another_vaults_thresholds()
    {
        var priorPath = Environment.GetEnvironmentVariable("LOWLINE_PRIOR_SNAPSHOT");
        var snapshotPath = Environment.GetEnvironmentVariable("LOWLINE_REPLAY_SNAPSHOT");
        Assert.SkipWhen(string.IsNullOrEmpty(priorPath) || string.IsNullOrEmpty(snapshotPath),
            "set LOWLINE_PRIOR_SNAPSHOT and LOWLINE_REPLAY_SNAPSHOT to measure a prior");
        var first = int.TryParse(Environment.GetEnvironmentVariable("LOWLINE_PRIOR_FIRST"), out var n) ? n : int.MaxValue;
        var ct = TestContext.Current.CancellationToken;

        var prior = JsonSerializer.Deserialize<Played>(await File.ReadAllTextAsync(priorPath!, ct), Json)!;
        IReadOnlyDictionary<string, string> tunings;
        using (var chosenOn = await Suggestions.BuildAsync(new VaultSnapshot(prior.Templates, prior.Documents), ct))
        {
            await chosenOn.ApplyAsync(await chosenOn.SelectThresholdsAsync(ct), ct);
            tunings = chosenOn.Thresholds;
        }
        Assert.NotEmpty(tunings);

        var played = JsonSerializer.Deserialize<Played>(await File.ReadAllTextAsync(snapshotPath!, ct), Json)!;
        var templates = played.Templates.ToDictionary(t => t.Ref, StringComparer.Ordinal);
        var onPrior = new Dictionary<string, Tally>(StringComparer.Ordinal);
        var onOwn = new Dictionary<string, Tally>(StringComparer.Ordinal);
        var end = (int)Math.Min(played.Documents.Count, (long)played.BroughtIn + first);
        var asked = 0;
        for (var i = played.BroughtIn; i < end; i++)
        {
            var saved = new VaultSnapshot(played.Templates, [.. played.Documents.Take(i)]);
            using var own = await Suggestions.BuildAsync(saved, ct);
            await own.ApplyAsync(await own.SelectThresholdsAsync(ct), ct);
            var document = played.Documents[i];
            // A field's window closes for good once its own thresholds stand: the app has switched to them by then, and
            // a later choice that stands no more does not bring the prior back.
            foreach (var field in Judged(templates[document.Template]).Where(f => Stands(own, document.Template, f)))
            {
                var tally = Of(onPrior, field);
                tally.StoodAfter ??= i - played.BroughtIn;
            }
            var open = Judged(templates[document.Template])
                .Where(field => Of(onPrior, field).StoodAfter is null).ToHashSet(StringComparer.Ordinal);
            asked = i + 1 - played.BroughtIn;
            if (open.Count == 0)
            {
                if (onPrior.Count > 0 && onPrior.Values.All(t => t.StoodAfter is not null)) break;
                continue;
            }
            using var kept = await Suggestions.BuildAsync(saved, ct, tunings);
            await AskAsync(kept, document, templates, onPrior, open, ct);
            await AskAsync(own, document, templates, onOwn, open, ct);
        }

        await Measurement.ReportAsync(
            $"prior · thresholds chosen on {prior.Documents.Count - prior.BroughtIn} records, {asked} records asked"
            + string.Concat(onPrior.Keys.Select(field =>
                $"\n  {field}: window {(onPrior[field].StoodAfter is { } stood ? $"{stood} records (own thresholds stood)" : $"all {asked} (own never stood)")}"
                + $" · on the prior {onPrior[field]} · on its own {Of(onOwn, field)}")), ct);
    }

    /// <summary>A template's judgment fields, in the order it lays them out.</summary>
    private static IEnumerable<string> Judged(TemplateSnapshot template) =>
        template.Fields.Select(f => f.Name).Where(name => template.Suggest?.Contains(name) == true);

    private static Tally Of(Dictionary<string, Tally> tallies, string field) =>
        tallies.TryGetValue(field, out var tally) ? tally : tallies[field] = new Tally();

    /// <summary>
    /// Whether a field's own thresholds stand — a value would be offered from its records without a prior: its key layer,
    /// a count of characters typed, or the similar records layer offered at a threshold. A class threshold alone does not
    /// count, as a class shown is not counted as a value.
    /// </summary>
    private static bool Stands(Suggestions suggestions, string template, string field) =>
        suggestions.Report(template, field) is { } report
        && (report.Key is not null || report.Typed?.Any(t => t is not null) == true || (report.SimilarOffered && report.Similar is not null));

    /// <summary>Asks each of the <paramref name="open"/> judgment fields of <paramref name="document"/> with what comes before
    /// it filled, and tallies the answer.</summary>
    private static async Task AskAsync(
        Suggestions suggestions, DocumentSnapshot document, Dictionary<string, TemplateSnapshot> templates,
        Dictionary<string, Tally> tallies, IReadOnlySet<string> open, CancellationToken ct)
    {
        var template = templates[document.Template];
        foreach (var field in Judged(template).Where(open.Contains))
        {
            var values = template.Fields.TakeWhile(f => f.Name != field).Select(f => f.Name)
                .Where(name => document.Values.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 })
                .ToDictionary(name => name, name => document.Values[name], StringComparer.Ordinal);
            var suggestion = await suggestions.SuggestAsync(new SuggestRequest(document.Template, field, values, document.Identity), ct);
            var settled = document.Values.TryGetValue(field, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var tally = Of(tallies, field);
            tally.Asked++;
            // A class shown is not a value: it is left out, as a check that shows nothing is.
            if (suggestion?.Value is not { } shown || suggestion.Mode == SuggestionMode.Coarse) continue;
            tally.Shown++;
            if (shown == settled) tally.Right++;
            if (suggestion.Promise is { } promise)
            {
                tally.Promised += promise;
                tally.WithPromise++;
            }
        }
    }
}
