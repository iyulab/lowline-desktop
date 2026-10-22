using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Formbase.Core;
using Formbase.Core.Primitives;
using Formbase.Core.Projection;
using Formbase.Core.Query;
using Formbase.Core.Schema;
using Formbase.Formdown;
using Formbase.Sqlite;
using Microsoft.Data.Sqlite;

namespace Lowline.Host;

/// <summary>
/// Formbase over one SQLite file outside the vault: each template a form type, each document a record
/// keyed by its vault path. The file is a cache — the vault can always rebuild it — so a file that
/// cannot be read is started over, and an ingest appends only what changed since the file last saw
/// the vault.
/// </summary>
internal sealed class ProjectionCache : IAsyncDisposable
{
    private const int PageSize = 1_000;

    /// <summary>
    /// Documents written in one durable write. A batch holds the file while it commits, so a large vault
    /// goes in several.
    /// </summary>
    private const int BatchSize = 2_000;

    private readonly ServiceProvider _provider;
    private readonly string _connectionString;
    private readonly FormbaseEngine _engine;
    private readonly SqliteFieldHintSource _hints;

    /// <summary>
    /// Per form type, the fingerprint of each live record's latest document — read from the raw store the
    /// first time the type is ingested, then kept in step with what this cache appends and retires.
    /// </summary>
    private readonly Dictionary<string, Dictionary<string, string>> _records = new(StringComparer.Ordinal);

    private ProjectionCache(string connectionString)
    {
        _connectionString = connectionString;
        var services = new ServiceCollection();
        services.AddFormbaseCore();
        services.AddSqliteRawStore(connectionString);
        services.AddSqliteProjection(connectionString);
        _provider = services.BuildServiceProvider();
        _engine = _provider.GetRequiredService<FormbaseEngine>();
        _hints = _provider.GetRequiredService<SqliteFieldHintSource>();
    }

    /// <summary>Opens the cache file, starting it over when it cannot be read.</summary>
    public static async Task<ProjectionCache> OpenAsync(string file, CancellationToken cancellationToken)
    {
        var connectionString = new SqliteConnectionStringBuilder { DataSource = file }.ToString();
        var cache = new ProjectionCache(connectionString);
        try
        {
            // Reading any status creates the file's tables, or fails on a file that is not a database.
            await cache._engine.GetProjectionStatusAsync(FormTypeRef.Create("lowline-cache-check@1"), cancellationToken);
            return cache;
        }
        catch (SqliteException)
        {
            await cache.DisposeAsync();
            Delete(file);
            return new ProjectionCache(connectionString);
        }
    }

    /// <summary>
    /// Brings the file up to this snapshot: new and changed documents are appended as the latest of their
    /// record, records whose document is gone are retired, and a template's table is rebuilt when either
    /// moved it or its fields changed.
    /// </summary>
    public async Task<IngestResult> IngestAsync(VaultSnapshot vault, CancellationToken cancellationToken)
    {
        var skipped = new List<SkippedDocument>();
        var skippedFields = new List<SkippedField>();
        var documents = vault.Templates.ToDictionary(
            t => t.Ref, _ => new Dictionary<string, (string Path, JsonObject Body)>(StringComparer.Ordinal), StringComparer.Ordinal);
        foreach (var document in vault.Documents)
        {
            if (!documents.TryGetValue(document.Template, out var ofTemplate))
            {
                skipped.Add(new SkippedDocument(document.Path, $"template {document.Template} is not in the vault"));
                continue;
            }
            var body = new JsonObject { [VaultProjection.PathColumn] = document.Path, [VaultProjection.IdColumn] = document.Identity };
            // A field left blank — no text, or an empty list — has no value: it is not stored as an empty one.
            foreach (var (name, value) in document.Values)
                if (!IsBlank(value)) body[name] = JsonNode.Parse(value.GetRawText());
            ofTemplate[RecordKeyOf(document.Path).Value] = (document.Path, body);
        }

        // Every template is declared before any is projected: a field that refers to another template's documents is a
        // column read from that template's table, which must be declared to be found. A checkbox group is a section of its
        // template, declared before it: its rows are cut from the template's documents, one per checked option.
        var sectionsOf = new Dictionary<string, IReadOnlyList<FormTypeRef>>(StringComparer.Ordinal);
        foreach (var template in vault.Templates)
        {
            var declared = template.Declaration();
            foreach (var section in declared.Sections) await _hints.DeclareAsync(section, cancellationToken);
            sectionsOf[template.Ref] = [.. declared.Sections.Select(s => s.Type)];
            await _hints.DeclareAsync(declared.Hints with
            {
                Fields =
                [
                    new FieldHint(VaultProjection.PathColumn, ColumnType.Text, Nullable: false),
                    new FieldHint(VaultProjection.IdColumn, ColumnType.Text, Nullable: false),
                    .. VaultProjection.CountColumnsOf(template, vault.Templates).Where(c => c.Section is null).Select(c => c.Hint),
                ],
            }, cancellationToken);
        }

        int appended = 0, retired = 0;
        var projections = new List<string>();
        foreach (var template in vault.Templates)
        {
            var type = FormTypeRef.Create(template.Ref);

            var records = await RecordsAsync(type, cancellationToken);
            var present = documents[template.Ref];
            // What changed, as batches each written in one durable write: accepting documents one by one
            // waits for a commit each, which is most of what filling an empty cache costs.
            var changes = new List<(IntakeDocument Intake, string Key, string? Fingerprint)>();
            foreach (var (key, (_, body)) in present)
            {
                var fingerprint = Fingerprint(body);
                if (records.TryGetValue(key, out var known) && known == fingerprint) continue;
                changes.Add((IntakeDocument.Accept(DocumentBody.Parse(body.ToJsonString()), RecordKey.Create(key)), key, fingerprint));
            }
            foreach (var key in records.Keys.Where(k => !present.ContainsKey(k)))
                changes.Add((IntakeDocument.Retire(RecordKey.Create(key)), key, null));
            foreach (var batch in changes.Chunk(BatchSize))
            {
                await _engine.AcceptManyAsync(type, [.. batch.Select(c => c.Intake)], cancellationToken);
                // Only once the batch is durable does the cache count it as seen.
                foreach (var (_, key, fingerprint) in batch)
                {
                    if (fingerprint is null)
                    {
                        records.Remove(key);
                        retired++;
                    }
                    else
                    {
                        records[key] = fingerprint;
                        appended++;
                    }
                }
            }

            // Stale on either axis: the raw stream moved past the table, or the fields were redeclared. A section reads the
            // template's documents, so it is brought up after them.
            var projected = false;
            foreach (var table in sectionsOf[template.Ref].Prepend(type))
            {
                var status = await _engine.GetProjectionStatusAsync(table, cancellationToken);
                if (status.State != ProjectionState.Projected && (await _engine.ProjectAsync(table, cancellationToken)).Projected)
                    projected = true;
                foreach (var skip in await _engine.GetProjectionSkipsAsync(table, cancellationToken))
                    skipped.Add(new SkippedDocument(await PathOfAsync(skip.DocumentId, present, cancellationToken), skip.Reason));
                foreach (var skip in await _engine.GetProjectionFieldSkipsAsync(table, cancellationToken))
                    skippedFields.Add(new SkippedField(template.Ref, await PathOfAsync(skip.DocumentId, present, cancellationToken), skip.Field, skip.Reason));
            }
            if (projected) projections.Add(template.Ref);
        }
        return new IngestResult(appended, retired, projections, skipped, skippedFields);
    }

    /// <summary>The vault path of a projected document, or its id when the vault no longer holds it.</summary>
    private async Task<string> PathOfAsync(
        DocumentId id, Dictionary<string, (string Path, JsonObject Body)> present, CancellationToken cancellationToken)
    {
        var key = (await _engine.GetDocumentAsync(id, cancellationToken))?.Key?.Value;
        var path = key is not null && present.TryGetValue(key, out var entry) ? entry.Path : key;
        return path ?? id.ToString();
    }

    /// <summary>
    /// The rows of <paramref name="template"/>'s table that <paramref name="filters"/> keep, in path order — a checkbox group's
    /// cell the options its document has checked, read from its section in the order the document lists them.
    /// </summary>
    public async Task<ProjectionTable> TableAsync(
        TemplateSnapshot template, IReadOnlyDictionary<string, CountColumn> columns, IReadOnlyList<ColumnFilter> filters,
        CancellationToken cancellationToken)
    {
        var (fieldFilters, children) = Conditions(columns, filters);
        var result = await _engine.QueryAsync(
            FormTypeRef.Create(template.Ref),
            new QuerySpec(Filters: fieldFilters, OrderBy: [new OrderKey(VaultProjection.PathColumn, Descending: false)], Children: children),
            cancellationToken);
        var paths = result.Rows.Select(row => (string)row.Fields[VaultProjection.PathColumn]!).ToList();
        var checkedOf = new Dictionary<string, Dictionary<string, List<object?>>>(StringComparer.Ordinal);
        foreach (var column in columns.Values.Where(c => c.Section is not null))
            checkedOf[column.Name] = await CheckedAsync(column.Section!, paths, cancellationToken);
        var rows = result.Rows
            .Select((row, i) => new ProjectionRow(
                paths[i],
                template.Fields.ToDictionary(f => f.Name, f => checkedOf.TryGetValue(f.Name, out var options)
                    ? options.TryGetValue(RecordKeyOf(paths[i]).Value, out var list) ? list : null
                    : row.Fields.TryGetValue(f.Name, out var v) ? AsWritten(f, v) : null)))
            .ToList();
        return new ProjectionTable(template.Ref, [.. template.Fields.Select(f => new ProjectionColumn(f.Name, f.Type))], rows);
    }

    /// <summary>The options each document at <paramref name="paths"/> has checked in a checkbox group, by its record key.</summary>
    private async Task<Dictionary<string, List<object?>>> CheckedAsync(
        RelationHint section, IReadOnlyList<string> paths, CancellationToken cancellationToken)
    {
        var checkedOf = new Dictionary<string, List<object?>>(StringComparer.Ordinal);
        if (paths.Count == 0) return checkedOf;
        var keys = paths.Select(p => (object)RecordKeyOf(p).Value).ToArray();
        var rows = await _engine.QueryAsync(
            section.Target, new QuerySpec(Filters: [new FieldFilter(section.KeyField, FilterOperator.In, keys)]), cancellationToken);
        foreach (var row in rows.Rows)
        {
            var parent = (string)row.Fields[section.KeyField]!;
            if (!checkedOf.TryGetValue(parent, out var list)) checkedOf[parent] = list = [];
            list.Add(row.Fields[FormdownAdapter.SectionValueField]);
        }
        return checkedOf;
    }

    /// <summary>
    /// <paramref name="filters"/> as Formbase asks them: a condition on a field of the table as a field filter, one on a
    /// checkbox group as a condition on its section — the documents with at least one checked option it keeps. That none
    /// is checked cannot be asked of a section yet, so it is refused.
    /// </summary>
    private static (List<FieldFilter> Fields, List<ChildFilter> Children) Conditions(
        IReadOnlyDictionary<string, CountColumn> columns, IReadOnlyList<ColumnFilter> filters)
    {
        var fields = new List<FieldFilter>();
        var children = new List<ChildFilter>();
        foreach (var filter in filters)
        {
            if (columns.TryGetValue(filter.Column, out var column) && column.Section is { } section)
            {
                if (filter.Op == "empty")
                    throw new ArgumentException($"documents with no option of {filter.Column} checked cannot be asked for", nameof(filters));
                children.Add(new ChildFilter(section.Name, (filter with { Column = FormdownAdapter.SectionValueField }).ToFieldFilter()));
            }
            else
            {
                fields.Add(filter.ToFieldFilter());
            }
        }
        return (fields, children);
    }

    /// <summary>
    /// The documents of <paramref name="template"/> that <paramref name="filters"/> keep, counted per distinct combination
    /// of the <paramref name="groupBy"/> columns (of <paramref name="columns"/> — fields of the template or of documents it refers to), each count with the vault paths of up to <paramref name="evidence"/> of
    /// its documents — and, when <paramref name="sum"/> names a number column, what it adds up to over them, read in the
    /// same read. The largest count first — or with a sum, the largest sum first, a group with no value in it after the
    /// others; of a tie, a group with a blank value after the others, the rest in the order Formbase gives its keys.
    /// </summary>
    public async Task<AggregateAnswer> AggregateAsync(
        TemplateSnapshot template, IReadOnlyDictionary<string, CountColumn> columns, IReadOnlyList<string> groupBy, IReadOnlyList<ColumnFilter> filters,
        int evidence, string? sum, CancellationToken cancellationToken)
    {
        var type = FormTypeRef.Create(template.Ref);
        var (fieldFilters, children) = Conditions(columns, filters);
        var measures = sum is null ? [] : new[] { AggregateMeasure.Sum(sum) };
        CountGroup Counted(AggregateGroup g, IReadOnlyDictionary<string, object?> key) => new(
            key,
            g.Count,
            [.. (g.Records ?? []).Select(r => r.Key?.Value).OfType<string>()],
            sum is null ? null : g.Measures is [var m, ..] ? new GroupSum(m.Value is null ? null : Convert.ToDecimal(m.Value, CultureInfo.InvariantCulture), m.ValueCount) : new GroupSum(null, 0));
        var counted = new List<CountGroup>();
        var byOption = groupBy.Where(c => columns.TryGetValue(c, out var column) && column.Section is not null).ToList();
        if (byOption is [var grouped])
        {
            // Counted by a checkbox group: a document is counted under each option it has checked — its options are its
            // section's rows. Each option's count is the documents with it checked, kept by the other conditions.
            if (groupBy.Count > 1)
                throw new ArgumentException($"{grouped} can be counted by alone, not together with other columns", nameof(groupBy));
            var section = columns[grouped].Section!;
            var options = await _engine.AggregateAsync(section.Target, new AggregateSpec([FormdownAdapter.SectionValueField], [], 1), cancellationToken);
            foreach (var option in options.Groups.Select(g => g.Key[FormdownAdapter.SectionValueField]).OfType<object>())
            {
                var withIt = new ChildFilter(section.Name, FieldFilter.Equal(FormdownAdapter.SectionValueField, option));
                var result = await _engine.AggregateAsync(
                    type, new AggregateSpec([], fieldFilters, evidence) { Measures = measures, Children = [.. children, withIt] }, cancellationToken);
                counted.AddRange(result.Groups.Where(g => g.Count > 0).Select(g => Counted(g, new Dictionary<string, object?> { [grouped] = option })));
            }
        }
        else if (byOption.Count > 1)
        {
            throw new ArgumentException("a count by more than one checkbox group", nameof(groupBy));
        }
        else
        {
            var result = await _engine.AggregateAsync(
                type, new AggregateSpec(groupBy, fieldFilters, evidence) { Measures = measures, Children = children }, cancellationToken);
            counted.AddRange(result.Groups.Select(g => Counted(g,
                groupBy.ToDictionary(c => c, c => g.Key.TryGetValue(c, out var v) && columns.TryGetValue(c, out var column) ? AsWritten(column.Field, v) : null))));
        }
        var groups = counted
            .Select((g, order) => (Order: order, Group: g))
            .OrderByDescending(x => x.Group.Sum is { Total: { } total } ? total : (decimal?)null)
            .ThenByDescending(x => x.Group.Count)
            .ThenBy(x => x.Group.Key.Values.Any(v => v is null) ? 1 : 0)
            .ThenBy(x => x.Order)
            .Select(x => x.Group)
            .ToList();
        return new AggregateAnswer(template.Ref, groupBy, groups, sum);
    }

    /// <summary>
    /// A cell as the field writes it. A date comes back from the table as a day; a date and time as an instant in UTC —
    /// which is how its zone-less text was read — so its UTC parts are exactly what was written.
    /// </summary>
    private static object? AsWritten(TemplateField field, object? value) => (field.Type, value) switch
    {
        ("date", DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        ("datetime-local", DateTimeOffset at) => at.UtcDateTime.ToString(
            at.Second == 0 && at.Millisecond == 0 ? "yyyy-MM-dd'T'HH:mm" : "yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture),
        _ => value,
    };

    /// <summary>
    /// The record a vault path names. Sync clients and file systems spell one path in either Unicode form,
    /// and Formbase compares keys exactly, so the key is the composed form.
    /// </summary>
    public static RecordKey RecordKeyOf(string path) => RecordKey.Create(path.Normalize(NormalizationForm.FormC));

    /// <summary>Whether a field's value is blank: null, text of nothing but white space, or an empty list.</summary>
    internal static bool IsBlank(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => true,
        JsonValueKind.String => string.IsNullOrWhiteSpace(value.GetString()),
        JsonValueKind.Array => value.GetArrayLength() == 0,
        _ => false,
    };

    /// <summary>Removes a cache file and what SQLite keeps beside it.</summary>
    public static void Delete(string file)
    {
        foreach (var path in new[] { file, file + "-wal", file + "-shm", file + "-journal" })
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _provider.DisposeAsync();
        // Pooled connections keep the file open, which on Windows keeps it from being deleted.
        using var connection = new SqliteConnection(_connectionString);
        SqliteConnection.ClearPool(connection);
    }

    /// <summary>The live records of a form type, read from the raw store on first use.</summary>
    private async Task<Dictionary<string, string>> RecordsAsync(FormTypeRef type, CancellationToken cancellationToken)
    {
        var name = type.ToString();
        if (_records.TryGetValue(name, out var records)) return records;
        var stream = new List<StoredDocument>();
        var after = Watermark.Zero;
        while (true)
        {
            var page = await _engine.ReadDocumentsAsync(type, after, PageSize, cancellationToken);
            if (page.Documents.Count == 0) break;
            stream.AddRange(page.Documents);
            after = page.Documents[^1].Watermark;
        }
        records = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var document in RecordFold.Latest(stream))
        {
            if (document.IsRetirement || document.Key is not { } key) continue;
            records[key.Value] = Fingerprint(JsonNode.Parse(document.Body!.Root.GetRawText())!);
        }
        _records[name] = records;
        return records;
    }

    /// <summary>A document's content in a form that does not depend on the order of its fields.</summary>
    private static string Fingerprint(JsonNode body) => Canonical(body)!.ToJsonString();

    private static JsonNode? Canonical(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj
            .OrderBy(p => p.Key, StringComparer.Ordinal)
            .Select(p => KeyValuePair.Create(p.Key, Canonical(p.Value)))),
        JsonArray array => new JsonArray([.. array.Select(Canonical)]),
        _ => node?.DeepClone(),
    };

}
