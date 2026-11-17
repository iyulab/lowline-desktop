using System.Text.Encodings.Web;
using System.Text.Json;

namespace Lowline.Host.Tests;

/// <summary>
/// What a form's first records would be offered if it started from thresholds chosen on another vault of the same form —
/// a sample pack's prior — instead of waiting for its own. Thresholds are chosen once on the vault in
/// <c>LOWLINE_PRIOR_SNAPSHOT</c>, then the first <c>LOWLINE_PRIOR_FIRST</c> (30) records of the vault in
/// <c>LOWLINE_REPLAY_SNAPSHOT</c> are asked about field by field as <see cref="ReplayTests"/> asks them, two ways: on those
/// thresholds kept as they are, and as the app does today — its own thresholds chosen again after each save. For each
/// field it reports how many values were shown, how many were the one saved, and the mean precision promised for them: a
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
        var first = int.TryParse(Environment.GetEnvironmentVariable("LOWLINE_PRIOR_FIRST"), out var n) ? n : 30;
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
        var end = Math.Min(played.Documents.Count, played.BroughtIn + first);
        for (var i = played.BroughtIn; i < end; i++)
        {
            var saved = new VaultSnapshot(played.Templates, [.. played.Documents.Take(i)]);
            using var kept = await Suggestions.BuildAsync(saved, ct, tunings);
            using var own = await Suggestions.BuildAsync(saved, ct);
            await own.ApplyAsync(await own.SelectThresholdsAsync(ct), ct);
            await AskAsync(kept, played.Documents[i], templates, onPrior, ct);
            await AskAsync(own, played.Documents[i], templates, onOwn, ct);
        }

        await Measurement.ReportAsync(
            $"prior · thresholds chosen on {prior.Documents.Count - prior.BroughtIn} records, first {end - played.BroughtIn} records asked"
            + string.Concat(onPrior.Keys.Select(field => $"\n  {field}: on the prior {onPrior[field]} · on its own {onOwn[field]}")), ct);
    }

    /// <summary>Asks each judgment field of <paramref name="document"/> with what comes before it filled, and tallies the answer.</summary>
    private static async Task AskAsync(
        Suggestions suggestions, DocumentSnapshot document, Dictionary<string, TemplateSnapshot> templates,
        Dictionary<string, Tally> tallies, CancellationToken ct)
    {
        var template = templates[document.Template];
        var judged = template.Suggest ?? [];
        foreach (var field in template.Fields.Select(f => f.Name).Where(judged.Contains))
        {
            var values = template.Fields.TakeWhile(f => f.Name != field).Select(f => f.Name)
                .Where(name => document.Values.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 })
                .ToDictionary(name => name, name => document.Values[name], StringComparer.Ordinal);
            var suggestion = await suggestions.SuggestAsync(new SuggestRequest(document.Template, field, values, document.Identity), ct);
            var settled = document.Values.TryGetValue(field, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            if (!tallies.TryGetValue(field, out var tally)) tallies[field] = tally = new Tally();
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
