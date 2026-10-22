using System.Text.Encodings.Web;
using System.Text.Json;

namespace Lowline.Host.Tests;

/// <summary>
/// A vault's records played back through the sidecar the way the app meets them: the records brought in at the start
/// ingested together, then each later record asked about field by field in its form's order — what is filled by then is
/// what comes before it, and a value typed out asked again as it is typed — and saved, the vault ingested again with it
/// and its thresholds chosen again as they would be. What was offered for each field is written line by line, for the UI's side to turn into the events a save records
/// and count them (<c>src/__tests__/replay.test.ts</c>, which writes the snapshot and runs this). Runs only when
/// <c>LOWLINE_REPLAY_SNAPSHOT</c> names a snapshot; writes the offers to <c>LOWLINE_REPLAY_OFFERS</c>. With
/// <c>LOWLINE_REPLAY_EVENTS=1</c> the vault also gets, from the next ingest on, what a person did with what was shown: the
/// value last shown for a field accepted when it is the one saved, corrected when another is — so a field's promise is
/// counted as the app counts it once people take its suggestions.
/// </summary>
public sealed class ReplayTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerOptions.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>The snapshot as the UI's side wrote it: the vault, and how many of its first documents were brought in.</summary>
    private sealed record Played(IReadOnlyList<TemplateSnapshot> Templates, IReadOnlyList<DocumentSnapshot> Documents, int BroughtIn);

    /// <summary>
    /// What was offered for one field of one document, with the fields filled when it was asked and, for a value being
    /// typed out, what had been typed by then (null before typing). A field has one line before typing and one more for
    /// each other value shown as its value is typed. <see cref="Promised"/> is the precision the field's replay promised
    /// when the value was offered — what the app shows under the field's curve — or, while typing, the one for the
    /// characters typed; null when nothing was offered.
    /// </summary>
    private sealed record Offered(
        string Doc, string Field, Suggestion Suggestion, IReadOnlyList<string> Filled, string? Typed = null, double? Promised = null,
        IReadOnlyList<string>? KeyFields = null);

    [Fact]
    public async Task Replays_records_in_the_order_they_were_made()
    {
        var snapshot = Environment.GetEnvironmentVariable("LOWLINE_REPLAY_SNAPSHOT");
        Assert.SkipWhen(string.IsNullOrEmpty(snapshot), "set LOWLINE_REPLAY_SNAPSHOT to replay");
        var output = Environment.GetEnvironmentVariable("LOWLINE_REPLAY_OFFERS") ?? Path.ChangeExtension(snapshot!, ".offers.jsonl");
        var ct = TestContext.Current.CancellationToken;
        var played = JsonSerializer.Deserialize<Played>(await File.ReadAllTextAsync(snapshot!, ct), Json)!;
        var templates = played.Templates.ToDictionary(t => t.Ref, StringComparer.Ordinal);

        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot(played.Templates, [.. played.Documents.Take(played.BroughtIn)]), ct);
        await vault.ThresholdsSelected.WaitAsync(ct);

        var tally = new Dictionary<string, (int Right, int Wrong, int Abstained)>(StringComparer.Ordinal);
        var recording = Environment.GetEnvironmentVariable("LOWLINE_REPLAY_EVENTS") == "1";
        var events = new List<SuggestionEvent>();
        await using var offers = new StreamWriter(output, append: false);
        for (var i = played.BroughtIn; i < played.Documents.Count; i++)
        {
            var document = played.Documents[i];
            var template = templates[document.Template];
            var judged = template.Suggest ?? [];
            foreach (var field in template.Fields.Select(f => f.Name).Where(judged.Contains))
            {
                // A person fills the form from the top: what is filled when a field is asked is what comes before it.
                var before = template.Fields.TakeWhile(f => f.Name != field).Select(f => f.Name)
                    .Where(name => document.Values.TryGetValue(name, out var value) && Filled(value)).ToList();
                var values = before.ToDictionary(name => name, name => document.Values[name], StringComparer.Ordinal);
                var asked = new SuggestRequest(document.Template, field, values, document.Identity);
                var suggestion = (await vault.SuggestAsync(asked, ct))!;
                var settled = document.Values.TryGetValue(field, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                // A class is right when the value saved is of it; it is tallied apart from the values.
                var classed = suggestion.Mode == SuggestionMode.Coarse;
                var counted = classed ? $"{field} class" : field;
                var (right, wrong, abstained) = tally.GetValueOrDefault(counted);
                if (suggestion.Value is null) abstained++;
                else if (classed ? settled?.StartsWith(suggestion.Value, StringComparison.Ordinal) == true : suggestion.Value == settled) right++;
                else wrong++;
                tally[counted] = (right, wrong, abstained);
                await offers.WriteLineAsync(JsonSerializer.Serialize(
                    new Offered(document.Identity, field, suggestion, before, Promised: await PromisedAsync(vault, document.Template, field, suggestion, null, ct),
                        KeyFields: (await vault.CurvesAsync(ct)).Single(c => c.Template == document.Template && c.Field == field).Replay?.DependsOn), Json));

                // A value typed out that was not offered: typed from its start, asked again with each of the first three
                // characters, and taken once it is offered. While typing, only a value that adds to the text is shown.
                var shown = suggestion.Value;
                void Decided()
                {
                    if (!recording || shown is null || classed && shown == suggestion.Value) return;
                    var kind = shown == settled ? "accept" : "correct";
                    events.Add(new SuggestionEvent($"{i:D8}", document.Identity, field, kind, shown, document.Template, suggestion.Mode));
                }
                if (settled is not { Length: > 1 } || suggestion.Value == settled || !Suggestions.Typeable(template.Fields.First(f => f.Name == field)))
                {
                    Decided();
                    continue;
                }
                for (var length = 1; length <= Math.Min(3, settled.Length - 1); length++)
                {
                    var typed = settled[..length];
                    var whileTyping = (await vault.SuggestAsync(asked with { Typed = typed }, ct))!;
                    if (whileTyping.Value is null || whileTyping.Value == typed || whileTyping.Value == shown) continue;
                    shown = whileTyping.Value;
                    await offers.WriteLineAsync(JsonSerializer.Serialize(
                        new Offered(document.Identity, field, whileTyping, before, typed, await PromisedAsync(vault, document.Template, field, whileTyping, typed, ct)), Json));
                    if (shown == settled) break;
                }
                Decided();
            }
            await vault.IngestAsync(new VaultSnapshot(played.Templates, [.. played.Documents.Take(i + 1)], [.. events]), ct);
            await vault.ThresholdsSelected.WaitAsync(ct);
        }

        await Measurement.ReportAsync(
            $"replay · {played.BroughtIn} brought in · {played.Documents.Count - played.BroughtIn} asked · " + string.Join(" · ", tally.Select(t =>
                $"{t.Key}: right {t.Value.Right} wrong {t.Value.Wrong} abstained {t.Value.Abstained}"
                + $" ({(t.Value.Right + t.Value.Wrong == 0 ? 0 : 100.0 * t.Value.Right / (t.Value.Right + t.Value.Wrong)):F0}% right)")), ct);
    }

    /// <summary>
    /// What the field's curve promises for what was offered: its replay's promise, its class's for a class, similar documents'
    /// for a value one confirmed, or its replay at that many characters.
    /// </summary>
    private static async Task<double?> PromisedAsync(
        VaultProjection vault, string template, string field, Suggestion offered, string? typed, CancellationToken ct)
    {
        if (offered.Value is null) return null;
        var curve = (await vault.CurvesAsync(ct)).Single(c => c.Template == template && c.Field == field);
        if (offered.Mode == SuggestionMode.Coarse) return curve.Coarse?.Promise;
        if (offered.Mode == SuggestionMode.Memory) return curve.Similar?.Promise;
        return typed is null
            ? curve.Replay?.Promise
            : curve.Typing?.FirstOrDefault(t => t.Characters == typed.Length)?.Precision;
    }

    private static bool Filled(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => false,
        JsonValueKind.String => value.GetString() is { Length: > 0 },
        JsonValueKind.Array => value.GetArrayLength() > 0,
        _ => true,
    };
}
