using System.Text.Json;
using System.Text.Json.Nodes;
using Engine = global::Lowline;

namespace Lowline.Host;

/// <summary>
/// What the UI asks: a value for one judgment field, given the document's other values.
/// <see cref="Document"/> is the document's <see cref="DocumentSnapshot.Identity"/> once it has been saved. <see cref="Typed"/> is
/// the text a person has typed into the field so far: the field stays open, and only a value that begins with it is offered.
/// </summary>
public sealed record SuggestRequest(
    string Template, string Field, IReadOnlyDictionary<string, JsonElement> Values, string? Document = null, string? Typed = null);

/// <summary>
/// A suggestion for one field. <see cref="Value"/> is null when there is none to make (<c>abstain</c>) —
/// nothing is guessed to fill the gap — and <see cref="Reason"/> then says why, as one of
/// <see cref="Abstention"/>'s. <see cref="Source"/> is what it rests on: the value settled alongside (<c>key</c>, <c>coarse</c>),
/// or the similar document whose confirmed value it is (<c>memory</c>). A value rests first on values settled alongside ones
/// the document holds — its observed values, and judgments already confirmed in it; a similar document answers only where
/// those settle nothing, and only on a field whose replay showed that layer right often enough over enough answers
/// (<see cref="Suggestions.SimilarMinimumAnswered"/>) — each layer keeps the precision its own replay promises.
/// </summary>
public sealed record Suggestion(string? Value, string Mode, string? Source, string? Reason = null);

/// <summary>What a <see cref="Suggestion"/> is: a value to offer, none, or none because the person turned it down.</summary>
public static class SuggestionMode
{
    /// <summary>A value settled alongside one the document has.</summary>
    public const string Key = "key";

    /// <summary>
    /// The value a similar document confirmed, where no value settled alongside answers — on a field whose replay showed
    /// similar documents right often enough over at least <see cref="Suggestions.SimilarMinimumAnswered"/> answers.
    /// </summary>
    public const string Memory = "memory";

    /// <summary>No value; <see cref="Suggestion.Reason"/> says why.</summary>
    public const string Abstain = "abstain";

    /// <summary>The person turned down this field's suggestion for this document; it is not offered again.</summary>
    public const string Rejected = "rejected";

    /// <summary>
    /// No value, but its class: the leading characters (<see cref="Suggestion.Value"/>) of the values settled alongside one
    /// the document has, kept to the same promise as a value — for a field whose template names its class length.
    /// </summary>
    public const string Coarse = "coarse";
}

/// <summary>Where a suggestion a person decided came from, as events record it.</summary>
public static class SuggestionSource
{
    /// <summary>A value another program wrote into the document as a suggestion (<see cref="DocumentSnapshot.Proposed"/>).</summary>
    public const string Proposed = "proposed";
}

/// <summary>Why a judgment field gets no suggestion — each is said differently, so "none" is never a wrong reason.</summary>
public static class Abstention
{
    /// <summary>No document holding a confirmed value for the field has been saved yet.</summary>
    public const string NoHistory = "no-history";

    /// <summary>
    /// The values settled alongside the document's other values have not yet shown, on a replay of the field's history, that
    /// they are right often enough — too few confirmed, the replay not finished, or none right often enough — so
    /// nothing is offered for the field until they have.
    /// </summary>
    public const string BelowTarget = "below-target";

    /// <summary>The field's values settled alongside have shown they decide it, and this document's other values settle none.</summary>
    public const string Undecided = "undecided";
}

/// <summary>Why a judgment field has no replay to show yet — one of these, or <see cref="Abstention.BelowTarget"/>.</summary>
public static class NoReplay
{
    /// <summary>Its history is too short to choose a strength from; nothing is offered until it is not.</summary>
    public const string Few = "few";

    /// <summary>Its history is long enough, and the replay that chooses its threshold has not finished yet.</summary>
    public const string Pending = "pending";
}

/// <summary>
/// Suggestions for judgment fields from what people already confirmed in the vault — no model — through the Lowline engine.
/// Each template with judgment fields is one of its forms: the fields its author turned suggestions on for are decided,
/// the rest observed. A saved document is a record settled when it was last saved, each judgment field settled as its
/// events say — taken from a suggestion, changed, or entered with nothing in view — so the precision a field promises
/// rests on the values people entered themselves. Documents say what the answer is; events say which suggestions were
/// wrong — a field whose suggestion was last rejected in a document is not offered there again.
/// </summary>
public sealed class Suggestions : IDisposable
{
    /// <summary>The share of offered values that must have been right for a threshold to be chosen.</summary>
    public const double TargetPrecision = 0.8;

    /// <summary>
    /// The fewest replayed answers a chosen threshold may rest on — the same number of decisions a
    /// correction curve's point is taken over.
    /// </summary>
    public const int MinimumAnswered = Curves.Window;

    /// <summary>
    /// The fewest replayed answers the similar documents layer's promise must rest on for a field to be offered its values.
    /// That layer answers the documents values settled alongside could not, and its precision swings far more from field to
    /// field: on public records replayed as the app asks, every field it answered thirty times or more kept the target with an
    /// honest promise, and every field that fell short had fewer.
    /// </summary>
    public const int SimilarMinimumAnswered = 30;

    /// <summary>
    /// How many checks of a judgment field must be among its documents before its precision is counted on them and on the
    /// values entered with nothing in view alone. Until then every value a person settled counts — taken from a
    /// suggestion or changed too — so a field is not left with nothing to count while its checks gather.
    /// </summary>
    public const int ChecksToCountOn = 20;

    /// <summary>The most characters typed into a field that suggestions are chosen a strength for.</summary>
    private const int TypedLongest = 3;

    /// <summary>The document a draft is asked about: it has no saved version to leave out of the evidence.</summary>
    private const string Unsaved = "\u0000unsaved";

    /// <summary>The field types whose value a person types out, rather than picks, checks or enters as a number or date.</summary>
    private static readonly HashSet<string> TypedTypes = new(StringComparer.Ordinal) { "text", "textarea", "email", "tel", "url", "search" };

    private static readonly HashSet<string> DateTypes = new(StringComparer.Ordinal) { "date", "time", "datetime-local", "month", "week" };

    private readonly Dictionary<string, TemplateSnapshot> _templates;
    private readonly Dictionary<string, Form> _forms;
    private readonly HashSet<(string Doc, string Field)> _rejected;

    /// <summary>One template's engine, the records it learned, and how many of them settled each judgment field.</summary>
    private sealed class Form(Engine.LowlineEngine engine, IReadOnlyList<string> records, Dictionary<string, int> confirmed)
    {
        public Engine.LowlineEngine Engine { get; } = engine;

        /// <summary>The records learned, in settlement order — what a replay chooses on.</summary>
        public IReadOnlyList<string> Records { get; } = records;

        /// <summary>By judgment field, the documents holding a value a person confirmed — not one another program proposed.</summary>
        public Dictionary<string, int> Confirmed { get; } = confirmed;

        /// <summary>The tuning in use, as the engine handed it over; null until one was chosen or kept.</summary>
        public string? Tuning { get; set; }

        /// <summary>How each judgment field's replay went, by field; empty until thresholds were chosen or kept.</summary>
        public Dictionary<string, Engine.FieldReport> Report { get; set; } = new(StringComparer.Ordinal);

        public void Use(string? tuning)
        {
            Engine.Restore(tuning);
            Tuning = tuning;
            Report = (Engine.Report ?? []).ToDictionary(r => r.Field, StringComparer.Ordinal);
        }
    }

    private Suggestions(Dictionary<string, TemplateSnapshot> templates, Dictionary<string, Form> forms, IReadOnlyList<SuggestionEvent> events)
    {
        (_templates, _forms) = (templates, forms);
        _rejected = Rejected(events);
    }

    /// <summary>
    /// The document fields whose latest event is a rejection. A later accept or correction in the same
    /// document means the field was filled in since, and lifts it. Turning down a value another program proposed
    /// (<see cref="SuggestionSource.Proposed"/>) says nothing about what suggestions here would offer.
    /// </summary>
    private static HashSet<(string, string)> Rejected(IReadOnlyList<SuggestionEvent> events) =>
        events
            .Where(e => e.Source != SuggestionSource.Proposed)
            .GroupBy(e => (e.Doc, e.Field))
            .Where(g => g.MaxBy(e => e.At, StringComparer.Ordinal)!.Kind == "reject")
            .Select(g => g.Key)
            .ToHashSet();

    /// <summary>
    /// Builds memory from the vault's saved documents, leaving out those with a conflict copy — their values are not
    /// confirmed until the person settles which copy to keep — in the order they were saved. Each template keeps the
    /// tuning in <paramref name="kept"/> — chosen by an earlier build, or kept from an earlier launch — until
    /// <see cref="SelectThresholdsAsync"/> chooses again; the engine says when one no longer stands.
    /// </summary>
    public static Task<Suggestions> BuildAsync(
        VaultSnapshot vault, CancellationToken cancellationToken, IReadOnlyDictionary<string, string>? kept = null)
    {
        var documents = vault.Documents.Where(d => !d.Conflicted).ToLookup(d => d.Template, StringComparer.Ordinal);
        var events = vault.Events ?? [];
        var latest = events
            .GroupBy(e => (e.Doc, e.Field))
            .ToDictionary(g => g.Key, g => g.MaxBy(e => e.At, StringComparer.Ordinal)!);
        var templates = vault.Templates
            .Where(t => t.Fields.Any(f => t.Suggest?.Contains(f.Name) == true))
            .ToDictionary(t => t.Ref, StringComparer.Ordinal);
        var forms = new Dictionary<string, Form>(StringComparer.Ordinal);
        try
        {
            foreach (var template in templates.Values)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var engine = Engine.LowlineEngine.Create(Definition(template));
                // A field the template names twice among its judgment fields is one judgment field.
                var confirmed = template.Suggest!.Distinct(StringComparer.Ordinal).ToDictionary(f => f, _ => 0, StringComparer.Ordinal);
                var records = new List<string>();
                foreach (var document in documents[template.Ref]
                    .OrderBy(d => d.Modified ?? 0)
                    .ThenBy(d => d.Identity, StringComparer.Ordinal))
                {
                    var values = Values(template, document.Values);
                    var settled = Settled(template, document, values, latest);
                    foreach (var field in confirmed.Keys)
                    {
                        if (values.ContainsKey(field) && settled.GetValueOrDefault(field) is not Engine.SettlementKind.Fill) confirmed[field]++;
                    }
                    records.Add(engine.Record(
                        document.Identity, values, settled, DateTimeOffset.FromUnixTimeMilliseconds(document.Modified ?? 0)).Json);
                }
                engine.Learn(records);
                var form = new Form(engine, records, confirmed);
                forms[template.Ref] = form;
                form.Use(kept?.GetValueOrDefault(template.Ref));
            }
        }
        catch
        {
            foreach (var form in forms.Values) form.Engine.Dispose();
            throw;
        }
        return Task.FromResult(new Suggestions(templates, forms, events));
    }

    /// <summary>
    /// A template as the engine's form: each field with the kind of value it takes — a field with options is a choice of
    /// them, one a person types out is text — its judgment fields decided and the rest observed, a judgment field's
    /// class length where the template names one, and what a field's <c>suggest:*</c> attributes say beyond that: a
    /// judgment field suggested only for a person to put in (<c>confirm</c>) and its values never to miss, a field kept out
    /// of the clues (<c>evidence</c>), the field another's choices depend on. The precision, answers and gates the
    /// thresholds are chosen to are the app's.
    /// </summary>
    internal static string Definition(TemplateSnapshot template)
    {
        var judged = template.Suggest ?? [];
        var fields = new JsonArray();
        foreach (var field in template.Fields)
        {
            var (kind, choices) = KindOf(field);
            var json = new JsonObject
            {
                ["name"] = field.Name,
                ["kind"] = kind,
                ["role"] = judged.Contains(field.Name) ? "decided" : "observed",
            };
            if (choices is { Count: > 0 }) json["choices"] = new JsonArray([.. choices.Select(c => JsonValue.Create(c))]);
            // A choice field with no options takes whatever is written in it.
            if (kind == "choice" && choices is not { Count: > 0 }) json["open"] = true;
            if (field.Multiple) json["multiple"] = true;
            if (judged.Contains(field.Name) && CoarseOf(template, field.Name) is { } prefix) json["coarse"] = prefix;
            if (field.Suggest is { } said)
            {
                if (judged.Contains(field.Name) && said.Policy == "confirm") json["policy"] = "confirm";
                if (judged.Contains(field.Name) && said.MustCatch is { Count: > 0 } mustCatch)
                {
                    json["mustCatch"] = new JsonArray([.. mustCatch.Select(v => JsonValue.Create(v))]);
                }
                if (said.Evidence is { } evidence) json["evidence"] = evidence;
                if (said.Parent is { } parent && template.Fields.Any(f => f.Name == parent)) json["parent"] = parent;
            }
            fields.Add(json);
        }
        return new JsonObject
        {
            ["name"] = template.Ref,
            ["form"] = new JsonObject { ["fields"] = fields },
            ["tune"] = new JsonObject
            {
                ["targetPrecision"] = TargetPrecision,
                ["minimumAnswered"] = MinimumAnswered,
                ["similarMinimumAnswered"] = SimilarMinimumAnswered,
                ["typedLongest"] = TypedLongest,
                // Every value a person settled until the field's checks gather, then what it did not suggest: counting
                // only the values entered with nothing in view, before there are checks, would never meet a suggestion's
                // own misses.
                ["counting"] = new JsonObject
                {
                    ["settled-until-checked"] = new JsonObject { ["checks"] = ChecksToCountOn },
                },
            },
        }.ToJsonString();
    }

    private static (string Kind, IReadOnlyList<string>? Choices) KindOf(TemplateField field) => field switch
    {
        { Reference: not null } => ("reference", null),
        { Options: [_, ..] options } => ("choice", options),
        { Type: "select" or "radio" } => ("choice", null),
        { Type: "checkbox", Multiple: false } => ("flag", null),
        { Type: "checkbox" } => ("choice", null),
        { Type: "number" or "range" } => ("number", null),
        { Type: var type } when DateTypes.Contains(type) => ("date", null),
        _ => ("text", null),
    };

    /// <summary>Whether a person types a field's value out — one value, of a typed kind, with no choices to pick from.</summary>
    public static bool Typeable(TemplateField field) =>
        !field.Multiple && field.Options is not [_, ..] && TypedTypes.Contains(field.Type);

    /// <summary>
    /// How many leading characters of a field's values name their class, as its template says; null when it says none,
    /// or for a field that takes several values.
    /// </summary>
    private static int? CoarseOf(TemplateSnapshot template, string field) =>
        template.Coarse?.GetValueOrDefault(field) is > 0 and var prefix
        && template.Fields.FirstOrDefault(f => f.Name == field) is { Multiple: false }
            ? prefix
            : null;

    /// <summary>A document's values on its template's fields, as the engine reads them; an empty value is none.</summary>
    private static Dictionary<string, Engine.FieldValue> Values(TemplateSnapshot template, IReadOnlyDictionary<string, JsonElement> values)
    {
        var read = new Dictionary<string, Engine.FieldValue>(StringComparer.Ordinal);
        foreach (var field in template.Fields)
        {
            if (values.TryGetValue(field.Name, out var value) && ValueOf(field, value) is { } held) read[field.Name] = held;
        }
        return read;
    }

    private static Engine.FieldValue? ValueOf(TemplateField field, JsonElement value)
    {
        IReadOnlyList<string> texts = value.ValueKind switch
        {
            JsonValueKind.String => string.IsNullOrWhiteSpace(value.GetString()) ? [] : [value.GetString()!],
            JsonValueKind.True => ["true"],
            JsonValueKind.False => ["false"],
            JsonValueKind.Number => [value.GetRawText()],
            JsonValueKind.Array => [.. value.EnumerateArray().Select(v => v.ToString()).Where(v => !string.IsNullOrWhiteSpace(v))],
            _ => [],
        };
        if (texts.Count == 0) return null;
        return field.Multiple ? Engine.FieldValue.Many(texts) : Engine.FieldValue.One(string.Join(", ", texts));
    }

    /// <summary>
    /// How each judgment field of a saved document was settled. A value another program proposed is filled in, not settled
    /// by a person (<see cref="Engine.SettlementKind.Fill"/>): it stays in the document, and memory neither learns it as a
    /// person's nor counts it. Otherwise the field's latest event says: a suggestion taken, changed, or turned down and
    /// another value written — of the engine's or of another program's. A field no event names was entered with nothing in
    /// view, the engine's default. A field that takes several values is settled as a set.
    /// </summary>
    private static Dictionary<string, Engine.SettlementKind> Settled(
        TemplateSnapshot template, DocumentSnapshot document, IReadOnlyDictionary<string, Engine.FieldValue> values,
        IReadOnlyDictionary<(string, string), SuggestionEvent> latest)
    {
        var settled = new Dictionary<string, Engine.SettlementKind>(StringComparer.Ordinal);
        foreach (var field in template.Suggest!.Distinct(StringComparer.Ordinal))
        {
            if (!values.ContainsKey(field)) continue;
            if (document.Proposed?.Contains(field) == true)
            {
                settled[field] = Engine.SettlementKind.Fill;
                continue;
            }
            if (template.Fields.First(f => f.Name == field).Multiple) continue;
            if (latest.GetValueOrDefault((document.Identity, field)) is not { } decided) continue;
            var other = decided.Source == SuggestionSource.Proposed;
            settled[field] = (decided.Kind, other) switch
            {
                ("accept", false) => Engine.SettlementKind.Accept,
                ("accept", true) => Engine.SettlementKind.AcceptOther,
                (_, false) => Engine.SettlementKind.Correct,
                (_, true) => Engine.SettlementKind.CorrectOther,
            };
        }
        return settled;
    }

    /// <summary>Whether any template's thresholds should be chosen again: never chosen, or no longer standing.</summary>
    public bool NeedsSelection => _forms.Values.Any(f => f.Engine.Stale is not null);

    /// <summary>
    /// Whether a judgment field's thresholds should be chosen again: never chosen, or its template's no longer stand — its
    /// fields or choices changed, or its documents grew or shrank by a tenth since.
    /// </summary>
    public bool Due(string template, string field) =>
        _forms.TryGetValue(template, out var form) && _templates[template].Suggest!.Contains(field) && form.Engine.Stale is not null;

    /// <summary>
    /// Chooses the thresholds of each template whose thresholds are due, by replaying its documents in the order they were
    /// saved; the rest keep theirs. It runs apart from building memory — suggestions go on meanwhile — and its result is
    /// applied with <see cref="ApplyAsync"/>.
    /// </summary>
    public Task<IReadOnlyDictionary<string, string>> SelectThresholdsAsync(CancellationToken cancellationToken)
    {
        var chosen = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (template, form) in _forms.Where(f => f.Value.Engine.Stale is not null).ToList())
        {
            cancellationToken.ThrowIfCancellationRequested();
            chosen[template] = form.Engine.Choose(form.Records);
        }
        return Task.FromResult<IReadOnlyDictionary<string, string>>(chosen);
    }

    /// <summary>Uses the thresholds <see cref="SelectThresholdsAsync"/> chose.</summary>
    public Task ApplyAsync(IReadOnlyDictionary<string, string> chosen, CancellationToken cancellationToken)
    {
        foreach (var (template, tuning) in chosen)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_forms.TryGetValue(template, out var form)) form.Use(tuning);
        }
        return Task.CompletedTask;
    }

    /// <summary>Each template's thresholds as they stand, for a later build or launch to keep; one never chosen is left out.</summary>
    public IReadOnlyDictionary<string, string> Thresholds =>
        _forms.Where(f => f.Value.Tuning is not null).ToDictionary(f => f.Key, f => f.Value.Tuning!, StringComparer.Ordinal);

    /// <summary>How a judgment field's thresholds were chosen, and how its replays went; null until they have been.</summary>
    public Engine.FieldReport? Report(string template, string field) =>
        _forms.TryGetValue(template, out var form) ? form.Report.GetValueOrDefault(field) : null;

    /// <summary>The documents holding a value a person confirmed for a judgment field.</summary>
    public int Confirmed(string template, string field) =>
        _forms.TryGetValue(template, out var form) ? form.Confirmed.GetValueOrDefault(field) : 0;

    public Task<Suggestion?> SuggestAsync(SuggestRequest request, CancellationToken cancellationToken)
    {
        if (!_forms.TryGetValue(request.Template, out var form)) return Task.FromResult<Suggestion?>(null);
        var template = _templates[request.Template];
        if (template.Suggest?.Contains(request.Field) != true || template.Fields.All(f => f.Name != request.Field))
            return Task.FromResult<Suggestion?>(null);
        if (request.Document is { } document && _rejected.Contains((document, request.Field)))
            return Task.FromResult<Suggestion?>(new Suggestion(null, SuggestionMode.Rejected, null, null));

        // A judgment rests on the values the document holds now — filled in, or taken from a suggestion — other than its
        // own; the document's saved version is never its evidence.
        var held = Values(template, request.Values);
        held.Remove(request.Field);
        var typed = string.IsNullOrEmpty(request.Typed) ? null : request.Typed;
        var proposal = form.Engine.ProposeField(request.Document ?? Unsaved, held, request.Field, typed);
        var suggestion = proposal?.Suggestion is { } offered
            ? new Suggestion(
                offered.Value,
                offered.Fit == "prefix" ? SuggestionMode.Coarse : proposal.Layer == Engine.Layer.Similar ? SuggestionMode.Memory : SuggestionMode.Key,
                SourceOf(proposal))
            : Abstain(request.Template, request.Field);
        return Task.FromResult<Suggestion?>(suggestion);
    }

    /// <summary>What a suggestion rests on, as the UI shows it: the value settled alongside, or the similar document.</summary>
    private static string? SourceOf(Engine.Proposal proposal) => proposal.Basis.FirstOrDefault() switch
    {
        { Kind: "value", Field: { } field, Value: { } value } => $"{field}: {value}",
        { Kind: "record", Id: { } id } => id,
        _ => null,
    };

    /// <summary>
    /// No value, with why: nothing confirmed yet, the values settled alongside not yet shown right often enough, or
    /// none settled by this document's other values.
    /// </summary>
    private Suggestion Abstain(string template, string field)
    {
        var reason = Confirmed(template, field) == 0 ? Abstention.NoHistory
            : Report(template, field)?.Key is null ? Abstention.BelowTarget
            : Abstention.Undecided;
        return new Suggestion(null, SuggestionMode.Abstain, null, reason);
    }

    /// <summary>
    /// Why a judgment field has no replay to show, as one of <see cref="NoReplay"/>'s or
    /// <see cref="Abstention.BelowTarget"/>; null once its threshold has been chosen.
    /// </summary>
    public string? WhyNoReplay(string template, string field)
    {
        if (!_forms.ContainsKey(template) || _templates[template].Suggest?.Contains(field) != true) return null;
        return Report(template, field) switch
        {
            { Key: not null } => null,
            { Lookups: var lookups } when lookups >= MinimumAnswered => Abstention.BelowTarget,
            not null => NoReplay.Few,
            null when Confirmed(template, field) - 1 < MinimumAnswered => NoReplay.Few,
            null => NoReplay.Pending,
        };
    }

    public void Dispose()
    {
        foreach (var form in _forms.Values) form.Engine.Dispose();
    }
}
