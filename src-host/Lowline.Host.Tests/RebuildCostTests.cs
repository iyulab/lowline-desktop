using System.Diagnostics;
using System.Text.Json;

namespace Lowline.Host.Tests;

/// <summary>
/// What ingesting the vault costs at 1,000 and 10,000 documents: filling an empty cache, a snapshot with
/// nothing changed, one outside edit, and a later launch over the filled cache — and what a long-used vault's edit
/// history adds.
/// Runs only with <c>LOWLINE_PERF=1</c>; writes its figures to <c>LOWLINE_PERF_OUT</c> when set.
/// </summary>
public sealed class RebuildCostTests
{
    internal static readonly TemplateSnapshot Intake = Templates.Of("intake@1",
    [
        new TemplateField("요청", "textarea"),
        new TemplateField("부서", "text"),
        new TemplateField("담당", "select"),
        new TemplateField("긴급", "checkbox"),
    ], Suggest: ["담당"]);

    private static readonly string[] Things = ["노트북", "모니터", "급여 명세서", "휴가 신청", "출입 카드", "프린터", "메일 계정", "법인 카드", "교육 일정", "의자"];
    private static readonly string[] Troubles = ["이 고장났어요", "을 다시 받고 싶어요", "이 안 돼요", "을 바꾸고 싶어요", "문의드립니다", "이 느려요"];
    private static readonly string[] Departments = ["영업", "개발", "인사", "재무", "운영"];
    private static readonly string[] Owners = ["장비", "인사", "재무", "총무"];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    internal static VaultSnapshot Synthetic(int count)
    {
        var random = new Random(count);
        var start = new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var documents = new List<DocumentSnapshot>(count);
        var events = new List<SuggestionEvent>();
        for (var i = 0; i < count; i++)
        {
            var thing = random.Next(Things.Length);
            var values = new Dictionary<string, object>
            {
                ["요청"] = $"{Things[thing]}{Troubles[random.Next(Troubles.Length)]} ({i})",
                ["부서"] = Departments[random.Next(Departments.Length)],
                ["담당"] = Owners[thing % Owners.Length],
                ["긴급"] = random.Next(5) == 0,
            };
            var json = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(values))!;
            var path = $"문서/{i:D6}.md";
            var at = start.AddMinutes(i * 37);
            documents.Add(new DocumentSnapshot(path, "intake@1", json, at.ToUnixTimeMilliseconds()));
            if (i % 2 == 0)
                events.Add(new SuggestionEvent(at.ToString("O"), path, "담당", random.Next(4) == 0 ? "correct" : "accept", Owners[thing % Owners.Length], "intake@1"));
        }
        return new VaultSnapshot([Intake], documents, events);
    }

    [Theory]
    [InlineData(1_000)]
    [InlineData(10_000)]
    public async Task Measures_ingests(int count)
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("LOWLINE_PERF") == "1", "set LOWLINE_PERF=1 to measure");
        var snapshot = Synthetic(count);
        var edited = snapshot with { Documents = [Edited(snapshot.Documents[0]), .. snapshot.Documents.Skip(1)] };
        var directory = Directory.CreateTempSubdirectory("lowline-perf-").FullName;
        try
        {
            string line;
            await using (var vault = new VaultProjection(directory))
            {
                // The first ingest fills an empty cache and pays for loading the embedder and warming the runtime.
                var first = Stopwatch.StartNew();
                Assert.Equal(count, (await vault.IngestAsync(snapshot, Ct)).Appended);
                first.Stop();
                // When the text index, filling beside the thresholds, is ready — counted from the ingest's end.
                var sinceIngest = Stopwatch.StartNew();
                var indexedAt = vault.CasesIndexed.ContinueWith(_ => sinceIngest.ElapsedMilliseconds, TaskScheduler.Default);
                // Thresholds are chosen apart from the ingest, by replaying the history once.
                var thresholds = Stopwatch.StartNew();
                await vault.ThresholdsSelected.WaitAsync(Ct);
                thresholds.Stop();
                // The text index fills apart from the ingest too; a search waits for it.
                var cases = Stopwatch.StartNew();
                Assert.Equal(count, await vault.CasesIndexed.WaitAsync(Ct));
                cases.Stop();
                var unchanged = Stopwatch.StartNew();
                Assert.Equal(0, (await vault.IngestAsync(snapshot, Ct)).Appended);
                unchanged.Stop();
                // What one outside edit costs.
                var edit = Stopwatch.StartNew();
                Assert.Equal(1, (await vault.IngestAsync(edited, Ct)).Appended);
                edit.Stop();

                var table = Stopwatch.StartNew();
                var rows = (await vault.TableAsync("intake@1", Ct))!.Rows.Count;
                table.Stop();
                Assert.Equal(count, rows);

                var request = new SuggestRequest("intake@1", "담당",
                    JsonSerializer.Deserialize<Dictionary<string, JsonElement>>("""{"요청": "노트북이 고장났어요", "부서": "영업"}""")!);
                var suggest = Stopwatch.StartNew();
                Assert.NotNull(await vault.SuggestAsync(request, Ct));
                suggest.Stop();

                var curves = Stopwatch.StartNew();
                await vault.CurvesAsync(Ct);
                curves.Stop();

                // The share of an edit that is the suggestions' own rebuild, apart from the projection — going on from the
                // build before, as an ingest does.
                var fresh = Stopwatch.StartNew();
                using var built = await Suggestions.BuildAsync(snapshot, Ct);
                fresh.Stop();
                var suggestions = Stopwatch.StartNew();
                using var rebuilt = await Suggestions.BuildAsync(edited, Ct, built.Thresholds, built);
                suggestions.Stop();

                // Projection alone: a changed field list rebuilds the table with nothing appended.
                var widened = edited with { Templates = [Templates.Of(Intake.Ref, [.. Intake.Fields, new TemplateField("비고", "text")], Intake.Suggest, Intake.Coarse)] };
                var project = Stopwatch.StartNew();
                Assert.Equal(0, (await vault.IngestAsync(widened, Ct)).Appended);
                project.Stop();

                line = $"{count} docs · first ingest {first.ElapsedMilliseconds} ms (suggestions from nothing {fresh.ElapsedMilliseconds} ms, projection {project.ElapsedMilliseconds} ms) · thresholds {thresholds.ElapsedMilliseconds} ms · text index {cases.ElapsedMilliseconds} ms (after thresholds; ready {await indexedAt} ms after the ingest) · "
                    + $"unchanged {unchanged.ElapsedMilliseconds} ms · one edit {edit.ElapsedMilliseconds} ms (suggestions {suggestions.ElapsedMilliseconds} ms) · "
                    + $"table {table.ElapsedMilliseconds} ms · suggest {suggest.ElapsedMilliseconds} ms · curves {curves.ElapsedMilliseconds} ms · "
                    + $"managed heap {GC.GetTotalMemory(forceFullCollection: true) / (1024 * 1024)} MB";
            }

            // A later launch finds the cache filled.
            await using (var restarted = new VaultProjection(directory))
            {
                var start = Stopwatch.StartNew();
                Assert.Equal(0, (await restarted.IngestAsync(edited, Ct)).Appended);
                start.Stop();
                line += $" · restart {start.ElapsedMilliseconds} ms · cache {new FileInfo(restarted.CacheFileOf("")).Length / (1024 * 1024)} MB";
            }

            await Measurement.ReportAsync(line, Ct);
        }
        finally
        {
            // Each cache clears its own file's pool when disposed: nothing of another test's is touched.
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// What a vault used for a long time costs: the cache keeps every saved version of a document (raw is
    /// append-only), so its size and a later launch grow with the edits made, not with the documents held.
    /// </summary>
    [Fact]
    public async Task Measures_a_long_used_vault()
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("LOWLINE_PERF") == "1", "set LOWLINE_PERF=1 to measure");
        const int count = 1_000, rounds = 10;
        var snapshot = Synthetic(count);
        var directory = Directory.CreateTempSubdirectory("lowline-perf-").FullName;
        try
        {
            var lines = new List<string>();
            long CacheBytes(VaultProjection vault) => new FileInfo(vault.CacheFileOf("")).Length
                + (File.Exists(vault.CacheFileOf("") + "-wal") ? new FileInfo(vault.CacheFileOf("") + "-wal").Length : 0);
            long IndexBytes(VaultProjection vault) => new FileInfo(vault.CasesFileOf("")).Length;
            async Task<long> OneEdit(VaultProjection vault, VaultSnapshot now)
            {
                var edit = Stopwatch.StartNew();
                Assert.Equal(1, (await vault.IngestAsync(now with { Documents = [Edited(now.Documents[0]), .. now.Documents.Skip(1)] }, Ct)).Appended);
                edit.Stop();
                await vault.IngestAsync(now, Ct); // back as it was
                return edit.ElapsedMilliseconds;
            }

            await using (var vault = new VaultProjection(directory))
            {
                await vault.IngestAsync(snapshot, Ct);
                await vault.CasesIndexed.WaitAsync(Ct);
                lines.Add($"edits ×0: cache {CacheBytes(vault) / 1024} KB · index {IndexBytes(vault) / 1024} KB · one edit {await OneEdit(vault, snapshot)} ms");
                // Every document saved again, round after round — each save a new version in raw.
                for (var round = 1; round <= rounds; round++)
                {
                    snapshot = snapshot with
                    {
                        Documents = [.. snapshot.Documents.Select(d => d with
                        {
                            Values = new Dictionary<string, JsonElement>(d.Values) { ["부서"] = JsonSerializer.SerializeToElement(Departments[round % Departments.Length] + $" {round}") },
                        })],
                    };
                    Assert.Equal(count, (await vault.IngestAsync(snapshot, Ct)).Appended);
                    await vault.CasesIndexed.WaitAsync(Ct);
                    if (round % 5 == 0)
                        lines.Add($"edits ×{round}: cache {CacheBytes(vault) / 1024} KB · index {IndexBytes(vault) / 1024} KB · one edit {await OneEdit(vault, snapshot)} ms");
                }
            }

            // A later launch reads the raw stream again to learn each record's latest version.
            await using (var restarted = new VaultProjection(directory))
            {
                var start = Stopwatch.StartNew();
                Assert.Equal(0, (await restarted.IngestAsync(snapshot, Ct)).Appended);
                start.Stop();
                lines.Add($"restart after {count * rounds} saved versions: {start.ElapsedMilliseconds} ms");
            }

            var line = $"{count} docs, long used · " + string.Join(" · ", lines);
            await Measurement.ReportAsync(line, Ct);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static DocumentSnapshot Edited(DocumentSnapshot document)
    {
        var values = new Dictionary<string, JsonElement>(document.Values)
        {
            ["요청"] = JsonSerializer.SerializeToElement("노트북 충전기가 고장났어요 (고침)"),
        };
        return document with { Values = values };
    }
}
