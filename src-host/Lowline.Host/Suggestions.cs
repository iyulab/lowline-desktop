using System.Text.Json;
using System.Text.Json.Nodes;
using Engine = global::Lowline;

namespace Lowline.Host;

/// <summary>
/// What the UI asks: a value for one judgment field, given the document's other values.
/// <see cref="Document"/> is the document's <see cref="DocumentSnapshot.Identity"/> once it has been saved. <see cref="Typed"/> is
/// the text a person has typed into the field so far: the field stays open, and only a value that begins with it is offered.
/// <see cref="Roll"/> is a number the UI drew uniformly from [0, 1) for this field of the draft, before seeing any answer —
/// the same one each time it asks: below <see cref="Suggestions.Recheck"/>'s rate, a value the field would be shown is held
/// back to check it (<see cref="SuggestionMode.Check"/>). <see cref="Rolls"/> are the same kind of number for the fields
/// settled together with this one: when one of them is drawn to be checked, this one is shown nothing either
/// (<see cref="Abstention.CheckedTogether"/>), so the person settling the checked field is not led by it.
/// </summary>
public sealed record SuggestRequest(
    string Template, string Field, IReadOnlyDictionary<string, JsonElement> Values, string? Document = null, string? Typed = null,
    double? Roll = null, IReadOnlyDictionary<string, double>? Rolls = null);

/// <summary>
/// A suggestion for one field. <see cref="Value"/> is null when there is none to make (<c>abstain</c>) —
/// nothing is guessed to fill the gap — and <see cref="Reason"/> then says why, as one of
/// <see cref="Abstention"/>'s. <see cref="Source"/> is what it rests on: the value settled alongside (<c>key</c>, <c>coarse</c>),
/// or the similar document whose confirmed value it is (<c>memory</c>). A value rests first on values settled alongside ones
/// the document holds — its observed values, and judgments already confirmed in it; a similar document answers only where
/// those settle nothing, and only on a field whose replay showed that layer right often enough over enough answers
/// (<see cref="Suggestions.SimilarMinimumAnswered"/>) — each layer keeps the precision its own replay promises. A field drawn
/// to be checked (<see cref="SuggestionMode.Check"/>) is shown no value: <see cref="Held"/> is the one held back, to record
/// with what the person enters, and <see cref="Probability"/> the chance it was drawn with. <see cref="Promise"/> is
/// the precision the layer that gave the value promised when it was shown (for a check, the value held back), to be
/// recorded with what the person does with it; absent when the engine reported none.
/// </summary>
public sealed record Suggestion(
    string? Value, string Mode, string? Source, string? Reason = null, double? Probability = null, string? Held = null,
    double? Promise = null);

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

    /// <summary>
    /// No value: the field was drawn to check it — the value it would be shown is held back, and what the person enters
    /// counts for its precision as a value entered with nothing in view.
    /// </summary>
    public const string Check = "check";
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

    /// <summary>
    /// The field is settled together with others (Formdown's <c>suggest:together</c>) and one of them, still empty, has no
    /// suggestion: shown alone, the sure one would lead the person deciding the unsure one.
    /// </summary>
    public const string Together = "together";

    /// <summary>
    /// A field settled together with this one is drawn to be checked and shown nothing; this one is held back with it. It is
    /// not itself a check: what is entered counts as a value entered with nothing in view, and the reason says no more than
    /// that — a person must not learn which of the group is the check.
    /// </summary>
    public const string CheckedTogether = "checked-together";
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

    /// <summary>How often a judgment field whose value would be shown is drawn instead to check it: one in twenty.</summary>
    public static readonly Engine.Recheck Recheck = new();

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

    /// <summary>
    /// One template's engine, held by each build of suggestions that uses it — a later build of the same template learns
    /// only the documents that changed, and the last build to let go frees it. <see cref="Learned"/> says what each
    /// document it learned was made from, so a later build can tell which changed.
    /// </summary>
    private sealed class Lease(Engine.LowlineEngine engine, string definition)
    {
        private int _holders = 1;
        private int _building;

        public Engine.LowlineEngine Engine { get; } = engine;

        /// <summary>The engine's form, as <see cref="Suggestions.Definition"/> wrote it.</summary>
        public string Definition { get; } = definition;

        /// <summary>By document id, what its record was made from, the record, and the judgment fields it confirmed.</summary>
        public Dictionary<string, Learnt> Learned { get; } = new(StringComparer.Ordinal);

        /// <summary>Holds the engine for another build, which alone learns into it until <see cref="Built"/>; false when it
        /// is freed or another build is learning into it.</summary>
        public bool TryHoldToBuild()
        {
            if (Interlocked.CompareExchange(ref _building, 1, 0) != 0) return false;
            while (true)
            {
                var holders = Volatile.Read(ref _holders);
                if (holders == 0)
                {
                    Volatile.Write(ref _building, 0);
                    return false;
                }
                if (Interlocked.CompareExchange(ref _holders, holders + 1, holders) == holders) return true;
            }
        }

        /// <summary>The build that held the engine to learn into it is done with learning.</summary>
        public void Built() => Volatile.Write(ref _building, 0);

        public void Release()
        {
            if (Interlocked.Decrement(ref _holders) == 0) Engine.Dispose();
        }
    }

    /// <summary>A document as its template's engine learned it: what the record was made from, the record, and the
    /// judgment fields whose value it confirmed.</summary>
    private sealed record Learnt(string Made, string Record, IReadOnlyList<string> Confirmed);

    /// <summary>One template's engine, the records it learned, and how many of them settled each judgment field.</summary>
    private sealed class Form(Lease lease, IReadOnlyList<string> records, Dictionary<string, int> confirmed)
    {
        public Lease Lease { get; } = lease;

        public Engine.LowlineEngine Engine => Lease.Engine;

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
    /// <see cref="SelectThresholdsAsync"/> chooses again; the engine says when one no longer stands. A template that
    /// <paramref name="previous"/> built on the same form goes on with that build's engine: it forgets the documents gone
    /// since and learns only those that changed. Any other is learned from the start.
    /// </summary>
    public static Task<Suggestions> BuildAsync(
        VaultSnapshot vault, CancellationToken cancellationToken, IReadOnlyDictionary<string, string>? kept = null,
        Suggestions? previous = null)
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
                var definition = Definition(template);
                // A field the template names twice among its judgment fields is one judgment field.
                var judged = template.Suggest!.Distinct(StringComparer.Ordinal).ToList();
                var saved = documents[template.Ref]
                    .OrderBy(d => d.Modified ?? 0)
                    .ThenBy(d => d.Identity, StringComparer.Ordinal)
                    .ToList();
                var lease = Continued(previous, template.Ref, definition, saved);
                var learning = lease is null;
                lease ??= new Lease(Engine.LowlineEngine.Create(definition), definition);
                try
                {
                    var confirmed = judged.ToDictionary(f => f, _ => 0, StringComparer.Ordinal);
                    var records = new List<string>(saved.Count);
                    var changed = new List<string>();
                    var learned = new Dictionary<string, Learnt>(StringComparer.Ordinal);
                    foreach (var document in saved)
                    {
                        var made = Made(template, document, latest);
                        if (learning || lease.Learned.GetValueOrDefault(document.Identity) is not { } learnt || learnt.Made != made)
                        {
                            var values = Values(template, document.Values);
                            var (settled, checks) = Settled(template, document, values, latest);
                            var record = lease.Engine.Record(
                                document.Identity, values, settled, DateTimeOffset.FromUnixTimeMilliseconds(document.Modified ?? 0), checks,
                                Account(document, settled, checks, latest)).Json;
                            learnt = new Learnt(made, record,
                                [.. judged.Where(f => values.ContainsKey(f) && settled.GetValueOrDefault(f) is not Engine.SettlementKind.Fill)]);
                            changed.Add(record);
                        }
                        learned[document.Identity] = learnt;
                        records.Add(learnt.Record);
                        foreach (var field in learnt.Confirmed) confirmed[field]++;
                    }
                    // Documents gone since — deleted, or now with a conflict copy — are forgotten.
                    if (!learning) lease.Engine.Forget([.. lease.Learned.Keys.Where(id => !learned.ContainsKey(id))]);
                    lease.Engine.Learn(changed);
                    lease.Learned.Clear();
                    foreach (var (id, learnt) in learned) lease.Learned[id] = learnt;
                    var form = new Form(lease, records, confirmed);
                    forms[template.Ref] = form;
                    form.Use(kept?.GetValueOrDefault(template.Ref));
                }
                catch
                {
                    // An engine this build went on with stays the earlier build's; it is told what it learned no more.
                    if (!learning) lease.Learned.Clear();
                    if (!forms.ContainsKey(template.Ref)) lease.Release();
                    throw;
                }
                finally
                {
                    lease.Built();
                }
            }
        }
        catch
        {
            foreach (var form in forms.Values) form.Lease.Release();
            throw;
        }
        return Task.FromResult(new Suggestions(templates, forms, events));
    }

    /// <summary>
    /// The engine <paramref name="previous"/> built for template <paramref name="template"/>, held for this build — when
    /// it is on the same form, no other build is learning into it, it learned what it was built on, and no document
    /// is among <paramref name="saved"/> twice.
    /// </summary>
    private static Lease? Continued(Suggestions? previous, string template, string definition, IReadOnlyList<DocumentSnapshot> saved)
    {
        if (previous?._forms.GetValueOrDefault(template)?.Lease is not { } lease || lease.Definition != definition) return null;
        if (!lease.TryHoldToBuild()) return null;
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (saved.All(d => ids.Add(d.Identity)) && lease.Learned.Count > 0) return lease;
        lease.Built();
        lease.Release();
        return null;
    }

    /// <summary>
    /// What a document's record is made from: when it was saved, its values, which of its judgment fields another program
    /// proposed, and its judgment fields' latest events — the same for a document unchanged since the last build.
    /// </summary>
    private static string Made(
        TemplateSnapshot template, DocumentSnapshot document, IReadOnlyDictionary<(string, string), SuggestionEvent> latest)
    {
        var made = new System.Text.StringBuilder();
        made.Append(document.Modified).Append('\u0001');
        foreach (var (field, value) in document.Values) made.Append(field).Append('\u0002').Append(value.GetRawText()).Append('\u0001');
        foreach (var field in document.Proposed ?? []) made.Append(field).Append('\u0003');
        foreach (var field in template.Suggest!)
        {
            if (latest.GetValueOrDefault((document.Identity, field)) is { } e)
                made.Append('\u0004').Append(field).Append('\u0002').Append(e.At).Append(e.Kind).Append(e.Source).Append(e.Probability).Append(e.Promise).Append(e.ShownAt);
        }
        return made.ToString();
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
        // A group holds back only judgment fields, and only two or more of them: a group the template's other fields
        // leave with one judgment field says nothing (the engine refuses it).
        var groups = template.Fields
            .Where(f => judged.Contains(f.Name) && f.Suggest?.Together is not null)
            .GroupBy(f => f.Suggest!.Together!)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToHashSet();
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
                if (judged.Contains(field.Name) && said.Together is { } together && groups.Contains(together))
                {
                    json["together"] = together;
                }
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
    /// view, the engine's default. A field that takes several values is settled as a set. A field whose latest event is a
    /// check was entered while its value was held back: it is among the checks, with the probability it was drawn with.
    /// </summary>
    private static (Dictionary<string, Engine.SettlementKind> Settled, Dictionary<string, double> Checks) Settled(
        TemplateSnapshot template, DocumentSnapshot document, IReadOnlyDictionary<string, Engine.FieldValue> values,
        IReadOnlyDictionary<(string, string), SuggestionEvent> latest)
    {
        var settled = new Dictionary<string, Engine.SettlementKind>(StringComparer.Ordinal);
        var checks = new Dictionary<string, double>(StringComparer.Ordinal);
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
            if (decided.Kind == SuggestionMode.Check)
            {
                if (decided.Probability is > 0 and <= 1) checks[field] = decided.Probability.Value;
                continue;
            }
            var other = decided.Source == SuggestionSource.Proposed;
            settled[field] = (decided.Kind, other) switch
            {
                ("accept", false) => Engine.SettlementKind.Accept,
                ("accept", true) => Engine.SettlementKind.AcceptOther,
                (_, false) => Engine.SettlementKind.Correct,
                (_, true) => Engine.SettlementKind.CorrectOther,
            };
        }
        return (settled, checks);
    }

    /// <summary>
    /// The account of what was shown for a document's judgment fields, as the engine's draft reads it, rebuilt from the
    /// events its fields' latest suggestions left — so a record built from a vault says what a record settled while the
    /// form was open says: the answer in view, the layer that gave it, the precision it promised, and the time the person
    /// took. Only what the events say is reported. A layer is named where the event names it (<c>key</c>; <c>memory</c>, a
    /// similar record); a class (<c>coarse</c>) and a value held back for a check do not, so none is written for them. The
    /// order values arrived in is not reported: the events keep the fields filled when a suggestion was made, not those
    /// filled after the last one, and the engine reads a field a list leaves out as there from the start. How long the
    /// document was open and who settled it are in no event. The time a field took is the time from its suggestion coming
    /// into view to the save that confirmed it; the draft has one save time, so each field's reach is placed that far
    /// before the latest save of the document.
    /// </summary>
    private static string? Account(
        DocumentSnapshot document, IReadOnlyDictionary<string, Engine.SettlementKind> settled,
        IReadOnlyDictionary<string, double> checks, IReadOnlyDictionary<(string, string), SuggestionEvent> latest)
    {
        var tracks = new List<(string Field, SuggestionEvent Event, bool Held, long? Took)>();
        foreach (var field in settled.Keys.Concat(checks.Keys))
        {
            if (latest.GetValueOrDefault((document.Identity, field)) is not { } e) continue;
            var held = e.Kind == SuggestionMode.Check;
            if (held != checks.ContainsKey(field)) continue;
            long? took = Instant(e.ShownAt) is { } shown && Instant(e.At) is { } saved && saved >= shown ? saved - shown : null;
            tracks.Add((field, e, held, took));
        }
        if (tracks.Count == 0) return null;
        var fields = new JsonObject();
        foreach (var (field, e, held, took) in tracks)
        {
            var other = e.Source == SuggestionSource.Proposed;
            var answer = new JsonObject
            {
                ["value"] = e.Suggested,
                ["origin"] = other ? "other" : "decider",
                ["fit"] = e.Source == SuggestionMode.Coarse ? "prefix" : "exact",
            };
            var track = new JsonObject();
            if (held) { track["held"] = e.Probability; track["withheld"] = answer; }
            else { track["shown"] = answer; track["declined"] = false; }
            if (!other && e.Source switch { SuggestionMode.Key => "key", SuggestionMode.Memory => "similar", _ => null } is { } layer)
                track["layer"] = layer;
            if (!other && e.Promise is { } promise) track["promise"] = promise;
            fields[field] = track;
        }
        var anchor = tracks.Where(t => t.Took is not null).Select(t => Instant(t.Event.At)).Max();
        if (anchor is { } saveAt)
        {
            foreach (var (field, _, _, took) in tracks)
                if (took is { } ms && saveAt - ms >= 0) fields[field]!["at"] = saveAt - ms;
        }
        var account = new JsonObject { ["opened"] = new JsonObject(), ["fields"] = fields };
        if (anchor is { } at) account["saved_at"] = at;
        return account.ToJsonString();
    }

    /// <summary>A time as the event files write it, in milliseconds since the Unix epoch; null when it is absent or unreadable.</summary>
    private static long? Instant(string? text) =>
        DateTimeOffset.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var at)
            ? at.ToUnixTimeMilliseconds()
            : null;

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

    /// <summary>The records built for a template's documents, as the lines the engine learned from.</summary>
    internal IReadOnlyList<string> RecordsOf(string template) => _forms.TryGetValue(template, out var form) ? form.Records : [];

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
        if (proposal is not null && request.Roll is { } roll && Recheck.Draw(proposal, roll) is { } probability)
            return Task.FromResult<Suggestion?>(new Suggestion(null, SuggestionMode.Check, null, null, probability, proposal.Suggestion!.Value, proposal.Promise));
        if (proposal?.Together is { } group && request.Rolls is { } rolls
            && rolls.Any(r => r.Key != request.Field && PartnerDrawn(template, request, held, group, r.Key, r.Value)))
            return Task.FromResult<Suggestion?>(new Suggestion(null, SuggestionMode.Abstain, null, Abstention.CheckedTogether));
        var suggestion = proposal?.Suggestion is { } offered
            ? new Suggestion(
                offered.Value,
                offered.Fit == "prefix" ? SuggestionMode.Coarse : proposal.Layer == Engine.Layer.Similar ? SuggestionMode.Memory : SuggestionMode.Key,
                SourceOf(proposal),
                Promise: proposal.Promise)
            : proposal?.Abstain == Engine.Abstain.Together
                ? new Suggestion(null, SuggestionMode.Abstain, null, Abstention.Together)
                : Abstain(request.Template, request.Field);
        return Task.FromResult<Suggestion?>(suggestion);
    }

    /// <summary>
    /// Whether <paramref name="partner"/>, a judgment field of the same <paramref name="group"/> as the field asked about, is
    /// drawn for a check by its <paramref name="roll"/> — the way it would be if it were asked about now, with the document's
    /// values but its own.
    /// </summary>
    private bool PartnerDrawn(TemplateSnapshot template, SuggestRequest request, IReadOnlyDictionary<string, Engine.FieldValue> held,
        string group, string partner, double roll)
    {
        if (template.Suggest?.Contains(partner) != true
            || template.Fields.FirstOrDefault(f => f.Name == partner)?.Suggest?.Together != group
            || held.ContainsKey(partner)
            || !_forms.TryGetValue(request.Template, out var form)) return false;
        var rest = held.Where(v => v.Key != partner).ToDictionary(v => v.Key, v => v.Value);
        var other = form.Engine.ProposeField(request.Document ?? Unsaved, rest, partner, null);
        return other is not null && Recheck.Draw(other, roll) is not null;
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
        foreach (var form in _forms.Values) form.Lease.Release();
    }
}
