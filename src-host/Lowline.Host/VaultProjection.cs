using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Formbase.Core.Primitives;
using Formbase.Core.Query;
using Formbase.Core.Schema;
using Formbase.Formdown;

namespace Lowline.Host;

/// <summary>
/// A field of a template, as the UI's Formdown parser reports it: a choice field with its options (none for any
/// other field), and for a field whose value names a document of another template (`-> customer`), that template's id.
/// </summary>
public sealed record TemplateField(
    string Name, string Type, bool Multiple = false, IReadOnlyList<string>? Options = null, string? Reference = null);

/// <summary>
/// A column a template's documents can be counted by: one of its own fields, or — through <see cref="Via"/>, a field of it
/// that names a document of template <see cref="Target"/> — a field of that document, read as it holds it now — with
/// its column as the projection declares it (<see cref="Hint"/>). A checkbox group is no column of its template's table but
/// a section of its own (<see cref="Section"/>): one row per checked option, a document counted by each option it has.
/// </summary>
public sealed record CountColumn(
    string Name, TemplateField Field, FieldHint Hint, string? Via = null, string? Target = null, RelationHint? Section = null);

/// <summary>
/// A template: its `id@version`, its fields in template order, the judgment fields its author
/// turned suggestions on for (none unless named), and for those whose values name a broader class in their leading
/// characters, how many characters (<see cref="Coarse"/> — front matter `lowline.coarse`) — and formdown's schema of
/// those fields (<see cref="Schema"/>, its <c>getSchema</c>), which the projection declares their columns from.
/// </summary>
public sealed record TemplateSnapshot(
    string Ref, IReadOnlyList<TemplateField> Fields, IReadOnlyList<string>? Suggest = null, IReadOnlyDictionary<string, int>? Coarse = null,
    JsonElement? Schema = null)
{
    /// <summary>
    /// The template's declaration as Formbase's formdown adapter reads the schema, so a formdown type has one reading:
    /// each field's column — its type and heading — in its table (<see cref="TableNameOf"/>), and each checkbox group a
    /// section of its own. The UI sends every template's schema; one without it cannot be projected.
    /// </summary>
    public FormdownAdapter.SchemaResult Declaration() =>
        FormdownAdapter.AdaptSchema(
            (Schema ?? throw new InvalidOperationException($"template {Ref} came without its schema")).GetRawText(),
            FormTypeRef.Create(Ref),
            TableNameOf(Ref));

    /// <summary>Each field's column in the template's table — every field but a checkbox group.</summary>
    public IReadOnlyDictionary<string, FieldHint> Columns() => Declaration().Hints.Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);

    /// <summary>An opaque table name for a template: Formbase never shows it, only needs it unique.</summary>
    public static string TableNameOf(string templateRef) =>
        "t_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(templateRef)))[..16].ToLowerInvariant();
}

/// <summary>
/// A document: where it lives in the vault, its template, its recorded values, when it was last
/// saved (ms since the epoch — its values were last confirmed then), if known, and whether a sync
/// client left a conflict copy of it — until the person settles which to keep, its values are not
/// confirmed: it stays in the table, and suggestions do not learn from it. <see cref="Id"/> is what it is
/// known by — the id in its front matter, or its path when it has none — and what events name it by.
/// <see cref="Proposed"/> names its fields holding a value another program wrote as a suggestion, not a person's
/// decision: the value stays in the document, but suggestions do not learn from it.
/// </summary>
public sealed record DocumentSnapshot(
    string Path, string Template, IReadOnlyDictionary<string, JsonElement> Values, long? Modified = null, bool Conflicted = false,
    string? Id = null, IReadOnlyList<string>? Proposed = null)
{
    /// <summary>What suggestions learned and events recorded about the document are keyed by.</summary>
    public string Identity => Id ?? Path;
}

/// <summary>
/// What a person did with a suggestion (<c>accept</c>, <c>correct</c> or <c>reject</c>), read from the
/// vault's event files. <see cref="Doc"/> is the document's <see cref="DocumentSnapshot.Identity"/>, <see cref="Template"/> its
/// template (absent in events recorded before it was written down), <see cref="Source"/> where the suggestion came
/// from — <c>key</c> (a value settled alongside one the document has), <c>memory</c> (a similar record), <c>coarse</c> or
/// <c>proposed</c> — as the event file records it.
/// </summary>
public sealed record SuggestionEvent(
    string At, string Doc, string Field, string Kind, string Suggested, string? Template = null, string? Source = null);

/// <summary>
/// Everything the sidecar knows about a vault: what the shell read and the UI parsed — templates,
/// documents, and what people did with suggestions.
/// </summary>
public sealed record VaultSnapshot(
    IReadOnlyList<TemplateSnapshot> Templates,
    IReadOnlyList<DocumentSnapshot> Documents,
    IReadOnlyList<SuggestionEvent>? Events = null);

/// <summary>
/// What an ingest changed: documents appended because they are new or changed, records retired because
/// their document left the vault (or its template), the templates whose tables were rebuilt, and the
/// documents no table shows, and the fields left empty in a row because their value could not be read as
/// the field's type.
/// </summary>
public sealed record IngestResult(
    int Appended, int Retired, IReadOnlyList<string> Projections, IReadOnlyList<SkippedDocument> Skipped,
    IReadOnlyList<SkippedField> SkippedFields);

public sealed record SkippedDocument(string Path, string Reason);

/// <summary>A document's field whose value its row in <see cref="Template"/>'s table leaves empty, and why.</summary>
public sealed record SkippedField(string Template, string Path, string Field, string Reason);

public sealed record ProjectionColumn(string Name, string Type);

/// <summary>A template's documents as a table: one row per document, keyed by its vault path.</summary>
public sealed record ProjectionTable(string Template, IReadOnlyList<ProjectionColumn> Columns, IReadOnlyList<ProjectionRow> Rows);

public sealed record ProjectionRow(string Path, IReadOnlyDictionary<string, object?> Values);

/// <summary>
/// One condition on a template's table. <see cref="Column"/> is a field's name, or
/// <see cref="VaultProjection.PathColumn"/> for the document's vault path; <see cref="Op"/> is <c>contains</c>
/// (text, ignoring case), <c>equal</c>, <c>atLeast</c> / <c>atMost</c> (a number or date field's bounds, both
/// included — a date as the field writes it, read as the same day on every computer), or <c>empty</c> (no value;
/// <see cref="Value"/> is not read).
/// </summary>
public sealed record ColumnFilter(string Column, string Op, string Value)
{
    /// <summary>The condition as Formbase asks it. An operator other than these is a request no screen makes.</summary>
    public FieldFilter ToFieldFilter() => Op == "empty"
        ? new(Column, FilterOperator.IsNull, null)
        : new(Column, Op switch
        {
            "contains" => FilterOperator.Contains,
            "equal" => FilterOperator.Equal,
            "atLeast" => FilterOperator.GreaterThanOrEqual,
            "atMost" => FilterOperator.LessThanOrEqual,
            _ => throw new ArgumentException("unknown filter operator", nameof(Op)),
        }, Value);
}

/// <summary>What the UI asks the text of the vault: documents holding these words, within one template if named.</summary>
public sealed record CaseQuery(string Query, string? Template = null, int? Max = null);

/// <summary>What the UI asks for the documents most like the one at <see cref="Path"/>.</summary>
public sealed record SimilarQuery(string Path, int? Max = null);

/// <summary>
/// What the UI asks to count of a template's documents: those matching every filter, per distinct combination of the
/// <see cref="GroupBy"/> fields — or all of them as one count — each count with up to <see cref="Evidence"/> of the
/// documents it is made of; and, when <see cref="Sum"/> names a number field, what its values add up to.
/// </summary>
public sealed record AggregateQuery(
    string Template, IReadOnlyList<string>? GroupBy = null, IReadOnlyList<ColumnFilter>? Filters = null, int? Evidence = null, string? Sum = null);

/// <summary>
/// One count: the value of each grouping field (as the field writes it; null when blank), how many documents, and the
/// vault paths of the first of them — the documents the count is made of, read in the same read as the count — and,
/// when the query asked for one, the sum of a number field over them.
/// </summary>
public sealed record CountGroup(IReadOnlyDictionary<string, object?> Key, long Count, IReadOnlyList<string> Evidence, GroupSum? Sum = null);

/// <summary>
/// What a number field adds up to over a group's documents: the total (exact; null when none has a value — not 0) and
/// how many of them have a value, the rest being blank there.
/// </summary>
public sealed record GroupSum(decimal? Total, long Counted);

/// <summary>
/// The counts of an <see cref="AggregateQuery"/>, the largest first — of a tie, a blank value last; with a sum, the
/// largest sum first. <see cref="Sum"/> is the field summed, when one was.
/// </summary>
public sealed record AggregateAnswer(string Template, IReadOnlyList<string> GroupBy, IReadOnlyList<CountGroup> Groups, string? Sum = null);

/// <summary>What the UI asks of a template's table: the rows that match every filter.</summary>
public sealed record ProjectionQuery(string Template, IReadOnlyList<ColumnFilter>? Filters = null);

/// <summary>
/// The vault projected through Formbase — tables in a cache outside the vault — and the suggestions and
/// correction curves learned from its confirmed values.
/// </summary>
/// <param name="cacheDirectory">
/// Where projection caches live, one file per vault. Without one they live in a temporary directory for as
/// long as this projection.
/// </param>
public sealed class VaultProjection(string? cacheDirectory = null, HostFailures? failures = null) : IAsyncDisposable
{
    /// <summary>The setting that names the cache directory.</summary>
    public const string CacheVariable = "LOWLINE_HOST_CACHE";

    /// <summary>The column that carries a document's vault path. `$` cannot start a Formdown field name.</summary>
    public const string PathColumn = "$path";

    /// <summary>The column holding what a document is known by — what a field that refers to it holds.</summary>
    public const string IdColumn = "$id";

    /// <summary>
    /// The columns <paramref name="template"/>'s documents can be counted by: its own fields, then, for each field naming one
    /// document of another template in <paramref name="templates"/>, that template's fields as `<field>.<its field>` — not
    /// its own references: one step, not a chain.
    /// </summary>
    public static IReadOnlyList<CountColumn> CountColumnsOf(TemplateSnapshot template, IEnumerable<TemplateSnapshot> templates)
    {
        // The snapshot holds each template once, at its version now: a reference names it by its id.
        var byId = templates.ToDictionary(t => IdOf(t.Ref), StringComparer.Ordinal);
        var declared = template.Declaration();
        var own = declared.Hints.Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
        var sections = (declared.Hints.Relations ?? []).Where(r => r.SectionField is not null).ToDictionary(r => r.SectionField!, StringComparer.Ordinal);
        return
        [
            .. template.Fields.Select(f => sections.TryGetValue(f.Name, out var section)
                // A checked option is a text value of its section's row.
                ? new CountColumn(f.Name, f, new FieldHint(f.Name, ColumnType.Text, Nullable: true), Section: section)
                : new CountColumn(f.Name, f, own[f.Name])),
            .. template.Fields
                .Where(f => !f.Multiple && f.Reference is not null && byId.ContainsKey(f.Reference))
                .SelectMany(f =>
                {
                    var target = byId[f.Reference!];
                    var theirs = target.Columns();
                    // Read from the referred document as it holds the field now, found by what it is known by.
                    return target.Fields
                        .Where(g => g.Reference is null && !g.Multiple)
                        .Select(g => new CountColumn($"{f.Name}.{g.Name}", g,
                            new FieldHint($"{f.Name}.{g.Name}", theirs[g.Name].Type, Nullable: true, SourceKey: null, FieldBinding.Reference,
                                new EntityRef(FormTypeRef.Create(target.Ref), g.Name, TargetLookup.Field(IdColumn), f.Name)),
                            f.Name, target.Ref));
                }),
        ];
    }

    /// <summary>A template's id: its `id@version` without the version.</summary>
    private static string IdOf(string templateRef) => templateRef[..(templateRef.LastIndexOf('@') is var at and >= 0 ? at : templateRef.Length)];

    private const int DefaultMax = 20;

    private readonly SemaphoreSlim _gate = new(1, 1);
    /// <summary>Held while the text index changes; a search waits for the sync in progress.</summary>
    private readonly SemaphoreSlim _casesGate = new(1, 1);
    private CaseIndex? _cases;
    /// <summary>The documents of the latest snapshot by what they are known as, and by path.</summary>
    private Dictionary<string, DocumentSnapshot> _byIdentity = new(StringComparer.Ordinal);
    private Dictionary<string, DocumentSnapshot> _byPath = new(StringComparer.Ordinal);
    private readonly bool _ownsDirectory = string.IsNullOrEmpty(cacheDirectory);
    private ProjectionCache? _cache;
    private string? _vault;
    private Dictionary<string, TemplateSnapshot>? _templates;
    private Suggestions? _suggestions;
    private CancellationTokenSource? _selecting;
    private IReadOnlyList<FieldCurve> _curves = [];

    /// <summary>The directory the caches live in.</summary>
    public string CacheDirectory { get; } = string.IsNullOrEmpty(cacheDirectory)
        ? Path.Combine(Path.GetTempPath(), $"lowline-projection-{Guid.NewGuid():N}")
        : cacheDirectory;

    /// <summary>
    /// The cache file of the vault at <paramref name="vault"/> (its root, as the shell names it): named by a
    /// hash of the root, so moving a vault starts a new cache and nothing of the path shows in the name.
    /// </summary>
    public string CacheFileOf(string vault) => Path.Combine(CacheDirectory,
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(vault.Normalize(NormalizationForm.FormC))))[..32].ToLowerInvariant() + ".db");

    public bool Indexed => _templates is not null;

    /// <summary>Whether suggestions have been built from the vault's confirmed values.</summary>
    public bool MemoryReady => _suggestions is not null;

    /// <summary>
    /// The threshold selection the latest ingest started, if it needed one; completes when its result is
    /// in use (or it was superseded by a later ingest).
    /// </summary>
    public Task ThresholdsSelected { get; private set; } = Task.CompletedTask;

    /// <summary>
    /// The text-index sync the latest ingest started: completes, with how many documents it indexed, when the index
    /// holds that snapshot.
    /// </summary>
    public Task<int> CasesIndexed { get; private set; } = Task.FromResult(0);

    /// <summary>The chosen thresholds of the vault at <paramref name="vault"/>, beside its projection cache.</summary>
    public string ThresholdsFileOf(string vault) => Path.ChangeExtension(CacheFileOf(vault), ".thresholds.json");

    /// <summary>The text index file of the vault at <paramref name="vault"/>, beside its projection cache.</summary>
    public string CasesFileOf(string vault) => Path.ChangeExtension(CacheFileOf(vault), ".cases.db");

    /// <summary>Brings the projection, suggestions and curves up to this snapshot of an unnamed vault.</summary>
    public Task<IngestResult> IngestAsync(VaultSnapshot vault, CancellationToken cancellationToken) =>
        IngestAsync(vault, "", cancellationToken);

    /// <summary>
    /// Brings the projection, suggestions and curves up to this snapshot of the vault at <paramref name="root"/>.
    /// Another vault than the last one switches to that vault's cache.
    /// </summary>
    public async Task<IngestResult> IngestAsync(VaultSnapshot vault, string root, CancellationToken cancellationToken)
    {
        // The thresholds this vault's fields last had: from the suggestions in use when it is the vault already open,
        // else as an earlier launch kept them — never another vault's, whose fields may share a template's name.
        var kept = _vault == root && _suggestions is { } current ? current.Thresholds : ThresholdStore.Load(ThresholdsFileOf(root));
        var suggestions = await Suggestions.BuildAsync(vault, cancellationToken, kept);
        var curves = Curves.Compute(vault);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_cache is not null && _vault != root)
            {
                await _cache.DisposeAsync();
                _cache = null;
                await CloseCasesAsync();
            }
            if (_cache is null)
            {
                Directory.CreateDirectory(CacheDirectory);
                _cache = await ProjectionCache.OpenAsync(CacheFileOf(root), cancellationToken);
                _cases = CaseIndex.Open(CasesFileOf(root));
                _vault = root;
            }
            var result = await _cache.IngestAsync(vault, cancellationToken);
            _templates = vault.Templates.ToDictionary(t => t.Ref, StringComparer.Ordinal);
            _byIdentity = vault.Documents.GroupBy(d => d.Identity, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            _byPath = vault.Documents.ToDictionary(d => d.Path, StringComparer.Ordinal);
            CasesIndexed = SyncCasesAsync(_cases!, vault);
            _suggestions = suggestions;
            _curves = curves;
            _selecting?.Cancel();
            _selecting = null;
            if (suggestions.NeedsSelection)
            {
                _selecting = new CancellationTokenSource();
                ThresholdsSelected = SelectThresholdsAsync(suggestions, root, _selecting.Token);
            }
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Chooses thresholds away from the request that ingested the vault — the replay takes seconds on a large
    /// vault — and uses them if no later ingest has replaced these suggestions meanwhile.
    /// </summary>
    private async Task SelectThresholdsAsync(Suggestions suggestions, string root, CancellationToken cancellationToken)
    {
        try
        {
            var chosen = await Task.Run(() => suggestions.SelectThresholdsAsync(cancellationToken), cancellationToken);
            await _gate.WaitAsync(cancellationToken);
            try
            {
                if (ReferenceEquals(_suggestions, suggestions))
                {
                    await suggestions.ApplyAsync(chosen, cancellationToken);
                    ThresholdStore.Save(ThresholdsFileOf(root), suggestions.Thresholds);
                }
            }
            finally
            {
                _gate.Release();
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // superseded by a later ingest
        }
        catch (Exception e)
        {
            // No request is waiting on this: the shell takes the failure the next time it asks.
            failures?.Record(e);
        }
    }

    /// <summary>
    /// Indexes the vault's text away from the request that ingested it — the first index of a large vault takes
    /// seconds — one sync at a time, in the order the ingests came.
    /// </summary>
    private async Task<int> SyncCasesAsync(CaseIndex cases, VaultSnapshot vault)
    {
        await _casesGate.WaitAsync();
        try
        {
            // An index closed meanwhile belongs to a vault no longer open.
            return ReferenceEquals(cases, _cases) ? await Task.Run(() => cases.SyncAsync(vault, CancellationToken.None)) : 0;
        }
        catch (Exception e)
        {
            // No request is waiting on this: the shell takes the failure the next time it asks.
            failures?.Record(e);
            return 0;
        }
        finally
        {
            _casesGate.Release();
        }
    }

    private async Task CloseCasesAsync()
    {
        await _casesGate.WaitAsync();
        try
        {
            if (_cases is not null) await _cases.DisposeAsync();
            _cases = null;
        }
        finally
        {
            _casesGate.Release();
        }
    }

    /// <summary>
    /// The documents whose values hold the words asked for, best first, one per document — within one template if
    /// one is named. Waits for the text index to hold the latest ingest.
    /// </summary>
    public async Task<IReadOnlyList<CaseHit>> SearchAsync(CaseQuery query, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(query.Query)) return [];
        await CasesIndexed.WaitAsync(cancellationToken);
        await _casesGate.WaitAsync(cancellationToken);
        try
        {
            if (_cases is null) return [];
            var found = await _cases.SearchAsync(query.Query, query.Template, query.Max ?? DefaultMax, cancellationToken);
            return Hits(found);
        }
        finally
        {
            _casesGate.Release();
        }
    }

    /// <summary>
    /// The documents of the same template most like the one at a path, best first — itself and conflicted documents
    /// left out — or none when the vault has no document there.
    /// </summary>
    public async Task<IReadOnlyList<CaseHit>> SimilarAsync(SimilarQuery query, CancellationToken cancellationToken)
    {
        await CasesIndexed.WaitAsync(cancellationToken);
        await _casesGate.WaitAsync(cancellationToken);
        try
        {
            if (_cases is null || !_byPath.TryGetValue(query.Path, out var document)) return [];
            var found = await _cases.SimilarAsync(document.Identity, document.Template, query.Max ?? DefaultMax, cancellationToken);
            return Hits(found);
        }
        finally
        {
            _casesGate.Release();
        }
    }

    /// <summary>What the index found, as documents of the latest snapshot; one gone since is left out.</summary>
    private List<CaseHit> Hits(IEnumerable<(string Identity, string Text, double Score)> found) =>
        [.. found.SelectMany(f => _byIdentity.TryGetValue(f.Identity, out var d)
            ? [new CaseHit(d.Path, d.Template, f.Text, d.Conflicted, f.Score)]
            : Array.Empty<CaseHit>())];

    /// <summary>The table for one template, or null when the vault has no such template.</summary>
    public Task<ProjectionTable?> TableAsync(string template, CancellationToken cancellationToken) =>
        TableAsync(template, [], cancellationToken);

    /// <summary>
    /// The rows of one template's table that match every filter — Formbase answers them from the projection —
    /// or null when the vault has no such template.
    /// </summary>
    public async Task<ProjectionTable?> TableAsync(string template, IReadOnlyList<ColumnFilter> filters, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return _cache is not null && _templates?.TryGetValue(template, out var snapshot) == true
                ? await _cache.TableAsync(snapshot, ColumnsOf(snapshot), filters, cancellationToken)
                : null;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The columns a template's documents can be counted and filtered by, by name.</summary>
    private Dictionary<string, CountColumn> ColumnsOf(TemplateSnapshot template) =>
        CountColumnsOf(template, _templates!.Values).ToDictionary(c => c.Name, StringComparer.Ordinal);

    /// <summary>The most documents a count carries as its evidence, and how many when the query does not say.</summary>
    public const int MaxEvidence = 20, DefaultEvidence = 5;

    /// <summary>
    /// The counts <paramref name="query"/> asks for — Formbase counts the projection, the documents behind each count
    /// read with it — or null when the vault has no such template. A grouping or filter column may be a field of a document
    /// the template's documents refer to (<see cref="CountColumnsOf"/>), read as that document holds it now; one that is
    /// neither is refused (<see cref="ArgumentException"/>): a count of a field that is not there answers nothing.
    /// </summary>
    public async Task<AggregateAnswer?> AggregateAsync(AggregateQuery query, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_cache is null || _templates is null || !_templates.TryGetValue(query.Template, out var snapshot)) return null;
            var columns = ColumnsOf(snapshot);
            var groupBy = query.GroupBy ?? [];
            var filters = query.Filters ?? [];
            if (groupBy.Distinct().Count() != groupBy.Count || groupBy.Concat(filters.Select(f => f.Column)).Any(c => !columns.ContainsKey(c) && c != PathColumn))
                throw new ArgumentException("a column that is neither one of the template's fields nor one it refers to", nameof(query));
            if (query.Sum is { } sum && (!columns.TryGetValue(sum, out var summed) || summed.Hint.Type != ColumnType.Decimal))
                throw new ArgumentException("a sum of a column that is not a number field", nameof(query));
            var evidence = Math.Clamp(query.Evidence ?? DefaultEvidence, 1, MaxEvidence);
            return await _cache.AggregateAsync(snapshot, columns, groupBy, filters, evidence, query.Sum, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// The correction curve of every judgment field — empty until a suggestion for it is decided — with how its
    /// saved documents did on replay once its threshold has been chosen, and why not until then.
    /// </summary>
    public async Task<IReadOnlyList<FieldCurve>> CurvesAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return [.. _curves.Select(Typing).Select(Classed).Select(Similar).Select(c => _suggestions?.Choice(c.Template, c.Field) is { } choice
                ? c with
                {
                    Replay = new FieldReplay(
                        choice.Threshold, choice.Precision, choice.Promise, choice.PromiseAnswered, Gil.Forms.ThresholdSelection.RecentDocuments, choice.AnswerRate,
                        choice.Answered, choice.Lookups, _suggestions.KeyFields(c.Template, c.Field)),
                }
                : c with
                {
                    WhyNoReplay = _suggestions?.WhyNoReplay(c.Template, c.Field) ?? NoReplay.Pending,
                    Closest = _suggestions?.Closest(c.Template, c.Field) is { } closest
                        ? new FieldShortfall(closest.Precision, closest.AnswerRate, closest.Answered, closest.Lookups, Suggestions.TargetPrecision)
                        : null,
                }).Select(Rechoosing)];
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// A curve whose field shows strengths chosen before — or that none was right often enough — while a replay over the history
    /// it has grown or shrunk to chooses again: what it shows is from before until that replay is done. A field never chosen
    /// says so by itself (<see cref="NoReplay.Pending"/>).
    /// </summary>
    private FieldCurve Rechoosing(FieldCurve curve) =>
        !ThresholdsSelected.IsCompleted && curve.WhyNoReplay is not (NoReplay.Pending or NoReplay.Few) && _suggestions?.Due(curve.Template, curve.Field) == true
            ? curve with { Rechoosing = true }
            : curve;

    /// <summary>A curve with how similar documents did on its field's replay, when a strength was chosen for them.</summary>
    private FieldCurve Similar(FieldCurve curve) => _suggestions?.SimilarChoice(curve.Template, curve.Field) is { Similar: { } similar } threshold
        ? curve with
        {
            Similar = new SimilarReplay(
                similar.Threshold, similar.Precision, similar.Promise, similar.PromiseAnswered, Gil.Forms.ThresholdSelection.RecentDocuments,
                similar.AnswerRate, similar.Answered, similar.Lookups, threshold.SimilarOffered, Suggestions.SimilarMinimumAnswered),
        }
        : curve;

    /// <summary>A curve with how its field's class did on replay, when its template names one and a strength was chosen.</summary>
    private FieldCurve Classed(FieldCurve curve) => _suggestions?.CoarseChoice(curve.Template, curve.Field) is { } coarse
        ? curve with
        {
            Coarse = new ClassReplay(
                coarse.Threshold, coarse.Precision, coarse.Promise, coarse.PromiseAnswered, Gil.Forms.ThresholdSelection.RecentDocuments, coarse.AnswerRate,
                coarse.Answered, coarse.Lookups),
        }
        : curve;

    /// <summary>A curve with how its field did on replay as typed from its start, when it is a field typed out.</summary>
    private FieldCurve Typing(FieldCurve curve) => _suggestions?.Typed(curve.Template, curve.Field) is { } typed
        ? curve with
        {
            Typing = [.. typed
                .Select((choice, i) => choice is null ? null
                    : new TypedReplay(i + 1, choice.Threshold, choice.Precision, choice.AnswerRate, choice.Answered, choice.Lookups))
                .OfType<TypedReplay>()],
        }
        : curve;

    /// <summary>A suggestion for a judgment field, or null when the template has no such judgment field.</summary>
    public async Task<Suggestion?> SuggestAsync(SuggestRequest request, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return _suggestions is null ? null : await _suggestions.SuggestAsync(request, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _selecting?.Cancel();
        if (_cache is not null) await _cache.DisposeAsync();
        await CloseCasesAsync();
        if (_ownsDirectory && Directory.Exists(CacheDirectory)) Directory.Delete(CacheDirectory, recursive: true);
    }
}

