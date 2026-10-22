using System.Text;
using System.Text.Json;

namespace Lowline.Host.Tests;

/// <summary>
/// The projection is a cache kept outside the vault: each document one record keyed by its path, so a
/// later snapshot adds only what changed and the cache outlives the sidecar.
/// </summary>
public sealed class ProjectionCacheTests : IDisposable
{
    private static readonly TemplateSnapshot Note = Templates.Of("note@1",
    [
        new TemplateField("제목", "text"),
        new TemplateField("분류", "select"),
    ]);

    private static readonly TemplateSnapshot Memo = Templates.Of("memo@1", [new TemplateField("제목", "text")]);

    private readonly string _directory = Directory.CreateTempSubdirectory("lowline-cache-").FullName;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DocumentSnapshot Document(string path, string json, string template = "note@1") =>
        new(path, template, JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!);

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(_directory, recursive: true);
    }

    [Fact]
    public async Task The_same_snapshot_again_appends_nothing()
    {
        await using var vault = new VaultProjection(_directory);
        var snapshot = new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "첫 값"}"""), Document("문서/b.md", """{"제목": "둘"}""")]);

        Assert.Equal(2, (await vault.IngestAsync(snapshot, Ct)).Appended);
        var again = await vault.IngestAsync(snapshot, Ct);

        Assert.Equal(0, again.Appended);
        Assert.Equal(0, again.Retired);
        Assert.Equal(2, (await vault.TableAsync("note@1", Ct))!.Rows.Count);
    }

    [Fact]
    public async Task Values_in_another_order_are_not_a_change()
    {
        await using var vault = new VaultProjection(_directory);
        await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "가", "분류": "나"}""")]), Ct);

        var again = await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/a.md", """{"분류": "나", "제목": "가"}""")]), Ct);

        Assert.Equal(0, again.Appended);
    }

    [Fact]
    public async Task A_changed_document_is_appended_as_a_correction_of_its_record()
    {
        await using var vault = new VaultProjection(_directory);
        await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "첫 값"}"""), Document("문서/b.md", """{"제목": "둘"}""")]), Ct);

        var result = await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "고친 값"}"""), Document("문서/b.md", """{"제목": "둘"}""")]), Ct);

        Assert.Equal(1, result.Appended);
        var rows = (await vault.TableAsync("note@1", Ct))!.Rows;
        Assert.Equal(["고친 값", "둘"], rows.Select(r => r.Values["제목"]));
    }

    [Fact]
    public async Task A_document_gone_from_the_vault_is_retired()
    {
        await using var vault = new VaultProjection(_directory);
        await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "가"}"""), Document("문서/b.md", """{"제목": "나"}""")]), Ct);

        var result = await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/b.md", """{"제목": "나"}""")]), Ct);

        Assert.Equal(1, result.Retired);
        Assert.Equal(["문서/b.md"], (await vault.TableAsync("note@1", Ct))!.Rows.Select(r => r.Path));
    }

    [Fact]
    public async Task A_document_that_returns_after_it_was_retired_is_shown_again()
    {
        await using var vault = new VaultProjection(_directory);
        var a = Document("문서/a.md", """{"제목": "가"}""");
        await vault.IngestAsync(new VaultSnapshot([Note], [a]), Ct);
        await vault.IngestAsync(new VaultSnapshot([Note], []), Ct);

        var result = await vault.IngestAsync(new VaultSnapshot([Note], [a]), Ct);

        Assert.Equal(1, result.Appended);
        Assert.Equal(["문서/a.md"], (await vault.TableAsync("note@1", Ct))!.Rows.Select(r => r.Path));
    }

    [Fact]
    public async Task One_path_spelled_in_two_unicode_forms_is_one_record()
    {
        var composed = "노트/회의록.md".Normalize(NormalizationForm.FormC);
        var decomposed = composed.Normalize(NormalizationForm.FormD);
        Assert.NotEqual(composed, decomposed);
        await using var vault = new VaultProjection(_directory);
        await vault.IngestAsync(new VaultSnapshot([Note], [Document(composed, """{"제목": "가"}""")]), Ct);

        await vault.IngestAsync(new VaultSnapshot([Note], [Document(decomposed, """{"제목": "나"}""")]), Ct);

        var row = Assert.Single((await vault.TableAsync("note@1", Ct))!.Rows);
        Assert.Equal("나", row.Values["제목"]);
        Assert.Equal(decomposed, row.Path);
    }

    [Fact]
    public async Task A_document_moved_to_another_template_leaves_the_old_table()
    {
        await using var vault = new VaultProjection(_directory);
        await vault.IngestAsync(new VaultSnapshot([Note, Memo], [Document("문서/a.md", """{"제목": "가"}""")]), Ct);

        var result = await vault.IngestAsync(new VaultSnapshot([Note, Memo], [Document("문서/a.md", """{"제목": "가"}""", "memo@1")]), Ct);

        Assert.Equal((1, 1), (result.Appended, result.Retired));
        Assert.Empty((await vault.TableAsync("note@1", Ct))!.Rows);
        Assert.Equal(["문서/a.md"], (await vault.TableAsync("memo@1", Ct))!.Rows.Select(r => r.Path));
    }

    [Fact]
    public async Task A_changed_template_is_projected_again_though_no_document_changed()
    {
        await using var vault = new VaultProjection(_directory);
        var a = Document("문서/a.md", """{"제목": "가", "분류": "나"}""");
        await vault.IngestAsync(new VaultSnapshot([Memo with { Ref = "note@1" }], [a]), Ct);

        var result = await vault.IngestAsync(new VaultSnapshot([Note], [a]), Ct);

        Assert.Equal(0, result.Appended);
        var table = (await vault.TableAsync("note@1", Ct))!;
        Assert.Equal(["제목", "분류"], table.Columns.Select(c => c.Name));
        Assert.Equal("나", Assert.Single(table.Rows).Values["분류"]);
    }

    [Fact]
    public async Task The_cache_outlives_the_sidecar()
    {
        var snapshot = new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "가"}"""), Document("문서/b.md", """{"제목": "나"}""")]);
        await using (var first = new VaultProjection(_directory))
        {
            await first.IngestAsync(snapshot, Ct);
        }

        await using var second = new VaultProjection(_directory);
        var result = await second.IngestAsync(snapshot with { Documents = [snapshot.Documents[1]] }, Ct);

        Assert.Equal((0, 1), (result.Appended, result.Retired));
        Assert.Equal(["문서/b.md"], (await second.TableAsync("note@1", Ct))!.Rows.Select(r => r.Path));
    }

    [Fact]
    public async Task A_damaged_cache_is_started_over()
    {
        await using var vault = new VaultProjection(_directory);
        await File.WriteAllTextAsync(vault.CacheFileOf(""), "not a database", Ct);

        var result = await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "가"}""")]), Ct);

        Assert.Equal(1, result.Appended);
        Assert.Single((await vault.TableAsync("note@1", Ct))!.Rows);
    }

    [Fact]
    public async Task Each_vault_keeps_its_own_cache()
    {
        await using var vault = new VaultProjection(_directory);
        var first = new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "가"}""")]);
        var second = new VaultSnapshot([Note], [Document("문서/b.md", """{"제목": "나"}""")]);
        await vault.IngestAsync(first, "D:/첫 볼트", Ct);

        var other = await vault.IngestAsync(second, "D:/둘째 볼트", Ct);
        Assert.Equal((1, 0), (other.Appended, other.Retired));
        Assert.Equal(["문서/b.md"], (await vault.TableAsync("note@1", Ct))!.Rows.Select(r => r.Path));

        var back = await vault.IngestAsync(first, "D:/첫 볼트", Ct);
        Assert.Equal((0, 0), (back.Appended, back.Retired));
        Assert.Equal(["문서/a.md"], (await vault.TableAsync("note@1", Ct))!.Rows.Select(r => r.Path));
        Assert.NotEqual(vault.CacheFileOf("D:/첫 볼트"), vault.CacheFileOf("D:/둘째 볼트"));
        Assert.Equal(_directory, Path.GetDirectoryName(vault.CacheFileOf("D:/첫 볼트")));
    }

    [Fact]
    public async Task Without_a_cache_directory_the_cache_lasts_as_long_as_the_sidecar()
    {
        string file;
        await using (var vault = new VaultProjection())
        {
            await vault.IngestAsync(new VaultSnapshot([Note], [Document("문서/a.md", """{"제목": "가"}""")]), Ct);
            file = vault.CacheFileOf("");
            Assert.True(File.Exists(file));
        }
        Assert.False(Directory.Exists(Path.GetDirectoryName(file)));
    }
}
