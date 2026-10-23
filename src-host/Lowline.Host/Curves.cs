namespace Lowline.Host;

/// <summary>
/// One point of a correction curve: after the <see cref="N"/>th decision about a field's
/// suggestions, the share of the latest ones (up to <see cref="Curves.Window"/>) that were right.
/// </summary>
public sealed record CurvePoint(int N, string At, double Rate);

/// <summary>
/// How a judgment field's suggestions have fared: every decision people made about them, in order.
/// A suggestion was right when it was accepted as offered; corrected or rejected, it was not.
/// Without a <see cref="Replay"/>, <see cref="WhyNoReplay"/> says why (see <see cref="Suggestions.WhyNoReplay"/>), and
/// when the replay fell short of the target, <see cref="Closest"/> says by how much. <see cref="BySource"/> splits the
/// decisions by where each suggestion came from: each source promises the target on its own replay, so each is
/// read against it apart; values another program proposed (<see cref="SuggestionSource.Proposed"/>) and classes offered
/// where the value was not (<see cref="SuggestionMode.Coarse"/>) are counted there alone, not in the curve. <see cref="Typing"/>, for a field whose value is typed out, says how its replay did as typed
/// from its start — whether or not <see cref="Replay"/> found a strength without typing. <see cref="Coarse"/>, for a field
/// whose template names a class, says how the class did on the lookups the value left, once a strength was chosen for it.
/// <see cref="Similar"/> says how similar documents did on the lookups values settled alongside left, once a strength was
/// chosen for them — and whether they are offered. <see cref="Rechoosing"/>: the field's history has grown or shrunk by a
/// tenth since its strengths were chosen and they are being chosen again — what is shown is from before, until they are.
/// A value entered while the field's suggestion was held back to check it is not a decision about a suggestion: it is in
/// none of the counts above, and <see cref="Counting"/> says how checks bear on the field's precision.
/// </summary>
public sealed record FieldCurve(
    string Template, string Field, int Accepted, int Corrected, int Rejected, IReadOnlyList<CurvePoint> Points,
    FieldReplay? Replay = null, string? WhyNoReplay = null, FieldShortfall? Closest = null,
    IReadOnlyList<SourceCount>? BySource = null, IReadOnlyList<TypedReplay>? Typing = null, ClassReplay? Coarse = null,
    SimilarReplay? Similar = null, bool Rechoosing = false, FieldCounting? Counting = null);

/// <summary>
/// What a judgment field's precision was counted on when its strengths were last chosen: <see cref="Checks"/> of its
/// saved documents settled it while its suggestion was held back to check it, and until <see cref="CountOnFrom"/> have
/// (<see cref="Suggestions.ChecksToCountOn"/>) every value a person settled counts (<c>settled</c>) — after, only values
/// entered with nothing in view and checks (<c>unprompted</c>), so a suggestion taken is not counted as right because it
/// was taken. <see cref="Rate"/>: how often a value the field would be shown is held back.
/// </summary>
public sealed record FieldCounting(string Counting, int Checks, int CountOnFrom, double Rate);

/// <summary>What a judgment field's precision is counted on (<see cref="FieldCounting.Counting"/>).</summary>
public static class CountedOn
{
    /// <summary>Every value a person settled, taken from a suggestion or not — until enough checks gather.</summary>
    public const string Settled = "settled";

    /// <summary>Values entered with nothing in view, and checks.</summary>
    public const string Unprompted = "unprompted";
}

/// <summary>
/// How a field's saved documents did when typed from their start, with <see cref="Characters"/> typed, on the replay that
/// chose the strength for that many: of the <see cref="Lookups"/> documents the suggestion before did not get right and
/// long enough to type that far, <see cref="AnswerRate"/> got a suggestion, and <see cref="Precision"/> of those were
/// right. Only the numbers of characters a strength was chosen for are listed.
/// </summary>
public sealed record TypedReplay(int Characters, double Threshold, double Precision, double AnswerRate, int Answered, int Lookups);

/// <summary>
/// How a field's class did on replay, on the lookups its value left: <see cref="AnswerRate"/> of them got a class and
/// <see cref="Precision"/> of those were right, with what to expect next (<see cref="Promise"/>, as for <see cref="FieldReplay"/>).
/// </summary>
public sealed record ClassReplay(
    double Threshold, double Precision, double Promise, double PromiseAnswered, int PromiseOver, double AnswerRate, int Answered, int Lookups);

/// <summary>
/// How similar documents did on replay, on the lookups values settled alongside left: <see cref="AnswerRate"/> of them got a
/// value and <see cref="Precision"/> of those were right, with what to expect next (<see cref="Promise"/>, as for
/// <see cref="FieldReplay"/>). <see cref="Offered"/>: whether the field is offered their values — only once the promise rests
/// on at least <see cref="OfferedFrom"/> answers (<see cref="Suggestions.SimilarMinimumAnswered"/>).
/// </summary>
public sealed record SimilarReplay(
    double Threshold, double Precision, double Promise, double PromiseAnswered, int PromiseOver, double AnswerRate, int Answered, int Lookups,
    bool Offered, int OfferedFrom);

/// <summary>Of a field's decisions about suggestions from one source, how many there were and how many were accepted.</summary>
public sealed record SourceCount(string Source, int Decided, int Accepted);

/// <summary>
/// How close a field's replay came when no threshold was right often enough: at the most precise threshold that still
/// gathered enough answers, <see cref="Precision"/> of its answers were right, against the <see cref="Target"/>. That
/// precision can reach the target and the field still not be offered, when a band of answers within it falls short.
/// </summary>
public sealed record FieldShortfall(double Precision, double AnswerRate, int Answered, int Lookups, double Target);

/// <summary>
/// How a field's suggestions did when its saved documents were replayed in the order they were saved, each asked
/// of the ones before it, at the strength the replay chose for values settled alongside the observed ones: <see cref="AnswerRate"/> of the lookups
/// got a suggestion, and <see cref="Precision"/> of those were right. Unlike the curve, which counts only
/// suggestions that were made, this says how often none was. <see cref="DependsOn"/> names the fields the replay chose
/// for the field's suggestions to rest on — the fields that key it — when resting on them alone was suggested more often
/// at the same precision; null when every value filled in counts. <see cref="Promise"/> is what to expect of the next
/// suggestions at least: the precision of those among the latest <see cref="PromiseOver"/> documents, or of the whole
/// replay when they are too few to rest on — a replay's precision runs over every document, so it keeps a time the field
/// did better long after — lowered to what the <see cref="PromiseAnswered"/> answers it rests on can vouch for, since the
/// strength was chosen on those very answers and a few of them flatter it.
/// </summary>
public sealed record FieldReplay(
    double Threshold, double Precision, double Promise, double PromiseAnswered, int PromiseOver, double AnswerRate, int Answered, int Lookups,
    IReadOnlyList<string>? DependsOn = null);

/// <summary>
/// Correction curves from the vault's event files — whether suggestions get better with use.
/// Only decisions count: a suggestion never offered (nothing close enough was remembered) leaves no event.
/// </summary>
public static class Curves
{
    /// <summary>How many of the latest decisions each point's rate is taken over.</summary>
    public const int Window = 10;

    /// <summary>
    /// A curve for every judgment field of every template, in the templates' order and each template's own —
    /// a field nothing has been decided about yet has one with no points, so its replay still has a place.
    /// </summary>
    public static IReadOnlyList<FieldCurve> Compute(VaultSnapshot vault)
    {
        // A copied file carries its original's id: either names the template.
        var templateOf = vault.Documents
            .GroupBy(d => d.Identity, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.First().Template, StringComparer.Ordinal);
        // An event names its template; older ones are placed through their document, if it is still there.
        var decided = (vault.Events ?? [])
            .Select(e => (Event: e, Template: e.Template ?? templateOf.GetValueOrDefault(e.Doc)))
            .Where(x => x.Template is not null)
            .ToLookup(x => (Template: x.Template!, x.Event.Field), x => x.Event);
        return vault.Templates
            .SelectMany(t => (t.Suggest ?? []).Distinct(StringComparer.Ordinal).Select(field => (t.Ref, Field: field)))
            .Select(f => Curve(f.Ref, f.Field, decided[(f.Ref, f.Field)]))
            .ToList();
    }

    private static FieldCurve Curve(string template, string field, IEnumerable<SuggestionEvent> events)
    {
        // The curve is how the suggestions made here fared; values another program proposed are counted only by source.
        var all = events.OrderBy(e => e.At, StringComparer.Ordinal).ToList();
        var ordered = all
            .Where(e => e.Kind != SuggestionMode.Check && e.Source is not (SuggestionSource.Proposed or SuggestionMode.Coarse))
            .ToList();
        var points = new List<CurvePoint>(ordered.Count);
        for (var i = 0; i < ordered.Count; i++)
        {
            var from = Math.Max(0, i + 1 - Window);
            var latest = ordered.Skip(from).Take(i + 1 - from).ToList();
            points.Add(new CurvePoint(i + 1, ordered[i].At, (double)latest.Count(e => e.Kind == "accept") / latest.Count));
        }
        return new FieldCurve(
            template,
            field,
            ordered.Count(e => e.Kind == "accept"),
            ordered.Count(e => e.Kind == "correct"),
            ordered.Count(e => e.Kind == "reject"),
            points,
            BySource: all
                .Where(e => e.Kind != SuggestionMode.Check && e.Source is not null)
                .GroupBy(e => e.Source!, StringComparer.Ordinal)
                .OrderBy(g => g.Key, StringComparer.Ordinal)
                .Select(g => new SourceCount(g.Key, g.Count(), g.Count(e => e.Kind == "accept")))
                .ToList());
    }
}
