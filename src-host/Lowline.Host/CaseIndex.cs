using System.Text;
using System.Text.Json;
using DesktopHost.Files;
using FluxIndex.Core.Application.Interfaces;
using FluxIndex.Core.Application.Services.KeywordSearch;
using FluxIndex.SDK;
using FluxIndex.Storage.SQLite;
using Microsoft.Data.Sqlite;

namespace Lowline.Host;

/// <summary>A document found by its text: where it is, its template, its best-matching text, and how well it matched.</summary>
public sealed record CaseHit(string Path, string Template, string Text, bool Conflicted, double Score);

/// <summary>
/// The vault's documents searchable by their text, and the documents most like one of them: FluxIndex keyword
/// search — character bigrams for Korean, no model — over one SQLite file beside the projection cache. What is
/// indexed is a document's values, one per line: the text a person wrote, not the template's own words, which
/// every document of a template shares. Documents are keyed by what they are known by, so renaming one that has
/// an id changes nothing here. Like the projection this is a cache: a manifest of what it holds lets a later
/// launch index only what changed, and a file without its manifest is started over.
/// </summary>
internal sealed class CaseIndex : IAsyncDisposable
{
    private const string TemplateKey = "template";
    private const string ConflictKey = "conflict";

    /// <summary>The share of the most similar document's score another must reach to be listed as similar.</summary>
    private const double SimilarFloor = 0.3;

    private readonly IFluxIndexContext _context;
    private readonly string _file;
    private readonly Dictionary<string, string> _indexed;

    private CaseIndex(string file, Dictionary<string, string> indexed)
    {
        _file = file;
        _indexed = indexed;
        var builder = FluxIndexContext.CreateBuilder().UseSQLite(file);
        // Chunks and their keyword index only: no entity graph (a second file) and no semantic cache.
        builder.Options.GraphStore.Provider = "None";
        builder.Options.SemanticCache.Provider = "None";
        _context = builder
            .AddSQLiteStorage()
            // Korean has no spaces between a stem and its endings: bigrams let "충전" find "충전이".
            .ConfigureServices(services => services.AddSingleton<ITextAnalyzer>(CjkBigramTextAnalyzer.Instance))
            // The sidecar's standard output carries its ready line and nothing else.
            .SuppressStartupMessages()
            .Build();
    }

    /// <summary>Opens the index file, starting it over when its manifest is missing or cannot be read.</summary>
    public static CaseIndex Open(string file)
    {
        var indexed = ReadManifest(file);
        if (indexed is null)
        {
            Delete(file);
            indexed = new Dictionary<string, string>(StringComparer.Ordinal);
        }
        return new CaseIndex(file, indexed);
    }

    /// <summary>
    /// Brings the index up to this snapshot: new and changed documents are indexed again, documents gone from
    /// the vault (or from its templates) are removed. Returns how many documents it indexed.
    /// </summary>
    public async Task<int> SyncAsync(VaultSnapshot vault, CancellationToken cancellationToken)
    {
        var templates = vault.Templates.ToDictionary(t => t.Ref, StringComparer.Ordinal);
        var present = new Dictionary<string, (string Text, Dictionary<string, object> Metadata, string Fingerprint)>(StringComparer.Ordinal);
        foreach (var document in vault.Documents)
        {
            if (!templates.TryGetValue(document.Template, out var template)) continue;
            var text = TextOf(document, template);
            var fingerprint = $"{document.Template}\n{document.Conflicted}\n{text}";
            present[document.Identity] = (text, Metadata(document), fingerprint);
        }

        var changed = present.Where(p => !_indexed.TryGetValue(p.Key, out var known) || known != p.Value.Fingerprint).ToList();
        var gone = _indexed.Keys.Where(k => !present.ContainsKey(k)).ToList();
        if (changed.Count == 0 && gone.Count == 0) return 0;
        // Until this sync is written down, the manifest would describe an index that no longer is: without it,
        // a sync cut short is started over on the next launch rather than trusted.
        File.Delete(ManifestFile);

        var indexed = 0;
        // A document with no values has nothing to find by: what it held before leaves the index.
        foreach (var (identity, (_, _, fingerprint)) in changed.Where(c => c.Value.Text.Length == 0))
        {
            if (_indexed.ContainsKey(identity)) await _context.Indexer.DeleteByDocumentIdAsync(identity, cancellationToken);
            _indexed[identity] = fingerprint;
        }
        var toIndex = changed.Where(c => c.Value.Text.Length > 0).ToList();
        if (toIndex.Count > 0)
        {
            // Written together, one transaction per store; an id already indexed is replaced, not added to.
            var result = await _context.Indexer.IndexDocumentsBatchAsync(
                toIndex.Select(c => (DocumentId: c.Key, Content: c.Value.Text, Metadata: (Dictionary<string, object>?)c.Value.Metadata)), new IndexingOptions(), null, cancellationToken);
            var failed = result.Results.Where(r => !r.Success).Select(r => r.DocumentId).ToHashSet(StringComparer.Ordinal);
            foreach (var (identity, (_, _, fingerprint)) in toIndex)
            {
                // One that could not be prepared is left out of the manifest, so the next sync tries it again.
                if (failed.Contains(identity)) continue;
                _indexed[identity] = fingerprint;
                indexed++;
            }
        }
        foreach (var identity in gone)
        {
            await _context.Indexer.DeleteByDocumentIdAsync(identity, cancellationToken);
            _indexed.Remove(identity);
        }
        await WriteManifestAsync(cancellationToken);
        return indexed;
    }

    /// <summary>
    /// The documents whose values hold the words of <paramref name="query"/>, best first, one entry per document —
    /// within one template when <paramref name="template"/> is given. Conflicted documents are found too: they are
    /// files a person has to find to settle.
    /// </summary>
    public async Task<IReadOnlyList<(string Identity, string Text, double Score)>> SearchAsync(
        string query, string? template, int max, CancellationToken cancellationToken)
    {
        var filter = template is null ? null : new Dictionary<string, object> { [TemplateKey] = template };
        // A document's text may come back as several chunks: ask for more, keep each document's best.
        var chunks = await _context.Retriever.KeywordSearchAsync(query, max * 4, filter, cancellationToken);
        return [.. chunks
            .GroupBy(c => c.DocumentChunk.DocumentId)
            .Select(g => g.MaxBy(c => c.Score)!)
            .OrderByDescending(c => c.Score)
            .Take(max)
            .Select(c => (c.DocumentChunk.DocumentId, c.DocumentChunk.Content, (double)c.Score))];
    }

    /// <summary>
    /// The documents of the same template most like the one known by <paramref name="identity"/>, best first,
    /// itself left out — and conflicted ones too, whose values nobody has confirmed yet.
    /// </summary>
    public async Task<IReadOnlyList<(string Identity, string Text, double Score)>> SimilarAsync(
        string identity, string template, int max, CancellationToken cancellationToken)
    {
        if (!_indexed.ContainsKey(identity)) return [];
        var filter = new Dictionary<string, object> { [TemplateKey] = template, [ConflictKey] = "no" };
        var found = (await _context.Retriever.FindSimilarAsync(identity, max, 0f, filter, cancellationToken)).ToList();
        // Keyword similarity has no floor of its own: a document sharing one value every document has (a
        // department, say) scores above nothing. Only those near the best are like it; the rest are not shown.
        var best = found.Count > 0 ? found.Max(c => c.Score) : 0;
        return [.. found
            .Where(c => c.Score >= best * SimilarFloor)
            .Select(c => (c.DocumentChunk.DocumentId, c.DocumentChunk.Content, (double)c.Score))];
    }

    /// <summary>
    /// A document's values in template order, one per line; list values one per line too. Lines end in <c>\n</c>
    /// wherever the sidecar runs, so the text it answers with does not depend on the system.
    /// </summary>
    internal static string TextOf(DocumentSnapshot document, TemplateSnapshot template)
    {
        var text = new StringBuilder();
        void Line(string s) => text.Append(s).Append('\n');
        foreach (var field in template.Fields)
        {
            if (!document.Values.TryGetValue(field.Name, out var value)) continue;
            switch (value.ValueKind)
            {
                case JsonValueKind.String when value.GetString() is { Length: > 0 } s:
                    Line(s.Trim());
                    break;
                case JsonValueKind.Number:
                    Line(value.GetRawText());
                    break;
                case JsonValueKind.Array:
                    foreach (var item in value.EnumerateArray())
                        if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } s) Line(s.Trim());
                    break;
            }
        }
        // A document with no text still exists to be found by what it is known as.
        return text.Length > 0 ? text.ToString().TrimEnd() : System.IO.Path.GetFileNameWithoutExtension(document.Path);
    }

    private static Dictionary<string, object> Metadata(DocumentSnapshot document) => new()
    {
        [TemplateKey] = document.Template,
        [ConflictKey] = document.Conflicted ? "yes" : "no",
        // Scored beside the values: a document is also found by its name.
        ["title"] = System.IO.Path.GetFileNameWithoutExtension(document.Path),
    };

    private string ManifestFile => ManifestOf(_file);

    private static string ManifestOf(string file) => file + ".manifest.json";

    private static Dictionary<string, string>? ReadManifest(string file)
    {
        try
        {
            return File.Exists(file) && File.Exists(ManifestOf(file))
                ? JsonSerializer.Deserialize<Dictionary<string, string>>(AtomicFile.ReadAllTextShared(ManifestOf(file))) is { } read
                    ? new Dictionary<string, string>(read, StringComparer.Ordinal)
                    : null
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task WriteManifestAsync(CancellationToken cancellationToken)
    {
        await AtomicFile.WriteAllTextAsync(ManifestFile, JsonSerializer.Serialize(_indexed), cancellationToken);
    }

    /// <summary>Removes an index file, its manifest, and what SQLite keeps beside it.</summary>
    public static void Delete(string file)
    {
        foreach (var path in new[] { file, file + "-wal", file + "-shm", file + "-journal", ManifestOf(file) })
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _context.DisposeAsync();
        // Pooled connections keep the file open, which on Windows keeps it from being deleted.
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = _file }.ToString());
        SqliteConnection.ClearPool(connection);
    }
}
