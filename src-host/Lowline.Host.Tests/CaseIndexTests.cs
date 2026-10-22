using System.Text.Json;

namespace Lowline.Host.Tests;

public sealed class CaseIndexTests
{
    private static readonly TemplateSnapshot Intake = Templates.Of("intake@1",
    [
        new TemplateField("요청", "text"),
        new TemplateField("부서", "select"),
        new TemplateField("담당", "select"),
        new TemplateField("태그", "checkbox", Multiple: true),
    ]);

    private static readonly TemplateSnapshot Bug = Templates.Of("bug-report@1", [new TemplateField("제목", "text")]);

    private static DocumentSnapshot Doc(string path, string json, string template = "intake@1", bool conflicted = false, string? id = null) =>
        new(path, template, JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!, Conflicted: conflicted, Id: id);

    private static readonly DocumentSnapshot[] Documents =
    [
        Doc("문서/배터리.md", """{"요청": "노트북 배터리가 금방 닳아요", "부서": "영업", "담당": "장비"}"""),
        Doc("문서/충전.md", """{"요청": "노트북 충전이 안 돼요, 배터리 문제 같아요", "부서": "개발", "담당": "장비"}"""),
        Doc("문서/휴가.md", """{"요청": "휴가 일수를 확인하고 싶어요", "부서": "인사", "담당": "인사", "태그": ["연차"]}"""),
        Doc("문서/표시.md", """{"제목": "배터리 표시가 틀려요"}""", template: "bug-report@1"),
    ];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<string[]> Search(VaultProjection vault, string words, string? template = null) =>
        [.. (await vault.SearchAsync(new CaseQuery(words, template), Ct)).Select(h => h.Path)];

    [Fact]
    public async Task Finds_documents_by_the_words_in_their_values_one_entry_each()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([Intake, Bug], Documents), Ct);

        Assert.Equal(["문서/배터리.md", "문서/충전.md", "문서/표시.md"], (await Search(vault, "배터리")).Order());
        // A stem finds the word with its ending: "충전" in "충전이".
        Assert.Equal(["문서/충전.md"], await Search(vault, "충전"));
        // Within one template.
        Assert.Equal(["문서/배터리.md", "문서/충전.md"], (await Search(vault, "배터리", "intake@1")).Order());
        // A value of a list is text too.
        Assert.Equal(["문서/휴가.md"], await Search(vault, "연차"));
        // A field's name is the template's word, not the document's: it finds nothing.
        Assert.Empty(await Search(vault, "부서"));
        Assert.Empty(await Search(vault, "   "));

        var hit = Assert.Single(await vault.SearchAsync(new CaseQuery("휴가"), Ct));
        Assert.Equal(("문서/휴가.md", "intake@1", false), (hit.Path, hit.Template, hit.Conflicted));
        Assert.Contains("휴가 일수를 확인하고 싶어요", hit.Text);
    }

    [Fact]
    public async Task Finds_a_changed_document_by_its_new_text_only_and_a_removed_one_not_at_all()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([Intake, Bug], Documents), Ct);
        var edited = Documents.Select(d => d.Path == "문서/배터리.md"
            ? Doc(d.Path, """{"요청": "모니터가 깜빡여요", "부서": "영업", "담당": "장비"}""")
            : d).Where(d => d.Path != "문서/휴가.md").ToList();
        await vault.IngestAsync(new VaultSnapshot([Intake, Bug], edited), Ct);

        Assert.Equal(["문서/배터리.md"], await Search(vault, "모니터"));
        // Its old text is gone from the index; it is still found by its name.
        Assert.Empty(await Search(vault, "금방"));
        Assert.Equal(["문서/배터리.md", "문서/충전.md", "문서/표시.md"], (await Search(vault, "배터리")).Order());
        Assert.Empty(await Search(vault, "휴가"));
    }

    [Fact]
    public async Task A_document_whose_values_are_all_cleared_is_not_found_by_what_it_held()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([Intake, Bug], Documents), Ct);
        var cleared = Documents.Select(d => d.Path == "문서/휴가.md" ? Doc(d.Path, "{}") : d).ToList();
        await vault.IngestAsync(new VaultSnapshot([Intake, Bug], cleared), Ct);

        Assert.Empty(await Search(vault, "연차"));
        Assert.Empty(await Search(vault, "일수"));
        Assert.Equal(["문서/배터리.md", "문서/충전.md"], (await Search(vault, "배터리", "intake@1")).Order());
    }

    [Fact]
    public async Task Finds_the_documents_of_the_same_template_most_like_one_leaving_out_itself_and_conflicted_ones()
    {
        await using var vault = new VaultProjection();
        var copy = Doc("문서/충전 2.md", """{"요청": "노트북 충전이 안 돼요, 배터리 문제 같아요", "부서": "개발", "담당": "총무"}""", conflicted: true);
        await vault.IngestAsync(new VaultSnapshot([Intake, Bug], [.. Documents, copy]), Ct);

        var similar = (await vault.SimilarAsync(new SimilarQuery("문서/충전.md"), Ct)).Select(h => h.Path).ToList();
        Assert.Equal("문서/배터리.md", similar[0]);
        Assert.DoesNotContain("문서/충전.md", similar);
        Assert.DoesNotContain("문서/충전 2.md", similar);
        Assert.DoesNotContain("문서/표시.md", similar);
        // The conflicted document is still found by its words: someone has to find it to settle it.
        Assert.Contains(await vault.SearchAsync(new CaseQuery("총무"), Ct), h => h.Path == "문서/충전 2.md" && h.Conflicted);
        Assert.Empty(await vault.SimilarAsync(new SimilarQuery("문서/없는.md"), Ct));
    }

    [Fact]
    public async Task Leaves_out_documents_that_share_only_a_value_every_document_has()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([Intake],
        [
            Doc("문서/충전.md", """{"요청": "노트북 충전이 안 돼요, 배터리 문제 같아요", "부서": "영업", "담당": "장비"}"""),
            Doc("문서/배터리.md", """{"요청": "노트북 배터리가 금방 닳아요", "부서": "영업", "담당": "장비"}"""),
            Doc("문서/회의실.md", """{"요청": "회의실 예약이 안 돼요", "부서": "영업", "담당": "총무"}"""),
            Doc("문서/휴가.md", """{"요청": "휴가 일수를 확인하고 싶어요", "부서": "영업", "담당": "인사"}"""),
        ]), Ct);

        var similar = (await vault.SimilarAsync(new SimilarQuery("문서/충전.md"), Ct)).Select(h => h.Path).ToList();
        Assert.Equal(["문서/배터리.md"], similar);
    }

    [Fact]
    public async Task Finds_a_renamed_document_with_an_id_at_its_new_path_without_indexing_it_again()
    {
        await using var vault = new VaultProjection();
        var before = Doc("문서/옛 이름.md", """{"요청": "프린터 토너가 떨어졌어요"}""", id: "5f0c2c1e");
        await vault.IngestAsync(new VaultSnapshot([Intake], [before]), Ct);
        Assert.Equal(1, await vault.CasesIndexed);

        await vault.IngestAsync(new VaultSnapshot([Intake], [before with { Path = "문서/새 이름.md" }]), Ct);
        Assert.Equal(0, await vault.CasesIndexed);
        Assert.Equal(["문서/새 이름.md"], await Search(vault, "토너"));
    }

    [Fact]
    public async Task A_later_launch_indexes_only_what_changed_and_starts_over_without_its_manifest()
    {
        var directory = Directory.CreateTempSubdirectory("lowline-cases-").FullName;
        try
        {
            var snapshot = new VaultSnapshot([Intake, Bug], Documents);
            async Task<int> Launch()
            {
                await using var vault = new VaultProjection(directory);
                await vault.IngestAsync(snapshot, Ct);
                var indexed = await vault.CasesIndexed;
                Assert.Equal(["문서/휴가.md"], await Search(vault, "휴가"));
                return indexed;
            }
            Assert.Equal(4, await Launch());
            Assert.Equal(0, await Launch());

            // A sync cut short leaves no manifest; the next launch does not trust the file.
            File.Delete(new VaultProjection(directory).CasesFileOf("") + ".manifest.json");
            Assert.Equal(4, await Launch());
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
