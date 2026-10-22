using System.Text.Json;
using Formbase.Core.Schema;

namespace Lowline.Host.Tests;

public sealed class VaultProjectionTests
{
    private static readonly TemplateSnapshot BugReport = Templates.Of("bug-report@1",
    [
        new TemplateField("제목", "text"),
        new TemplateField("심각도", "select"),
        new TemplateField("재현됨", "checkbox"),
        new TemplateField("태그", "checkbox", Multiple: true),
        new TemplateField("점수", "number"),
    ]);

    private static DocumentSnapshot Document(string path, string json) =>
        new(path, "bug-report@1", JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Projects_one_row_per_document_with_korean_columns()
    {
        await using var vault = new VaultProjection();
        var result = await vault.IngestAsync(new VaultSnapshot([BugReport],
        [
            Document("문서/b.md", """{"제목": "저장 후 멈춤", "심각도": "높음", "재현됨": true, "태그": ["UI"], "점수": 3}"""),
            Document("문서/a.md", """{"제목": "열기 실패", "재현됨": false}"""),
        ]), Ct);

        Assert.Equal(2, result.Appended);
        Assert.Equal(["bug-report@1"], result.Projections);
        Assert.Empty(result.Skipped);
        Assert.True(vault.Indexed);

        var table = await vault.TableAsync("bug-report@1", Ct);
        Assert.NotNull(table);
        Assert.Equal(["제목", "심각도", "재현됨", "태그", "점수"], table.Columns.Select(c => c.Name));
        Assert.Equal(["문서/a.md", "문서/b.md"], table.Rows.Select(r => r.Path));
        var b = table.Rows[1].Values;
        Assert.Equal("저장 후 멈춤", b["제목"]);
        Assert.Equal("높음", b["심각도"]);
        Assert.Equal(true, b["재현됨"]);
        Assert.Equal(3m, Convert.ToDecimal(b["점수"]));
        Assert.Null(table.Rows[0].Values["심각도"]);
    }

    [Fact]
    public async Task Counts_documents_per_value_the_largest_first_each_with_the_documents_it_is_made_of()
    {
        var visits = Templates.Of("visit@1", [new TemplateField("원인", "select"), new TemplateField("방문일", "date"), new TemplateField("제목", "text")]);
        static DocumentSnapshot Visit(string path, string json) =>
            new(path, "visit@1", JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!);
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([visits],
        [
            Visit("문서/1.md", """{"원인": "부품", "방문일": "2026-09-03"}"""),
            Visit("문서/2.md", """{"원인": "설정", "방문일": "2026-09-10"}"""),
            Visit("문서/3.md", """{"원인": "부품", "방문일": "2026-09-21"}"""),
            Visit("문서/4.md", """{"원인": "부품", "방문일": "2026-10-01"}"""),
            Visit("문서/5.md", """{"방문일": "2026-09-30"}"""),
        ]), Ct);

        // 지난달(9월)의 원인별 건수: the largest first, a blank value its own group, each with its documents.
        var september = new AggregateQuery("visit@1", ["원인"],
            [new ColumnFilter("방문일", "atLeast", "2026-09-01"), new ColumnFilter("방문일", "atMost", "2026-09-30")]);
        var answer = await vault.AggregateAsync(september, Ct);
        Assert.Equal(["원인"], answer!.GroupBy);
        Assert.Equal([("부품", 2L), ("설정", 1L), (null, 1L)], answer.Groups.Select(g => ((string?)g.Key["원인"], g.Count)));
        Assert.Equal(["문서/1.md", "문서/3.md"], answer.Groups[0].Evidence);
        Assert.Equal(["문서/5.md"], answer.Groups[2].Evidence);

        // No grouping: one count of every kept document; at most as much evidence as asked.
        var all = await vault.AggregateAsync(new AggregateQuery("visit@1", Evidence: 2), Ct);
        Assert.Equal(5L, Assert.Single(all!.Groups).Count);
        Assert.Equal(2, all.Groups[0].Evidence.Count);

        // A date grouped by reads as it was written.
        var byDay = await vault.AggregateAsync(new AggregateQuery("visit@1", ["방문일"], [new ColumnFilter("원인", "equal", "설정")]), Ct);
        Assert.Equal("2026-09-10", Assert.Single(byDay!.Groups).Key["방문일"]);

        // A template the vault does not have answers nothing; a field the template does not have is refused.
        Assert.Null(await vault.AggregateAsync(new AggregateQuery("gone@1", ["원인"]), Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => vault.AggregateAsync(new AggregateQuery("visit@1", ["담당"]), Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => vault.AggregateAsync(new AggregateQuery("visit@1", ["원인", "원인"]), Ct));
    }

    [Fact]
    public async Task Sums_a_number_field_per_group_the_largest_sum_first_saying_how_many_had_a_value()
    {
        var request = Templates.Of("request@1", [new TemplateField("이름", "text"), new TemplateField("예산", "number")]);
        var item = Templates.Of("item@1",
            [new TemplateField("청구서", "select", Reference: "request"), new TemplateField("품명", "text"), new TemplateField("금액", "number")]);
        static DocumentSnapshot Of(string path, string template, string json, string? id = null) =>
            new(path, template, JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!, Id: id);
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([request, item],
        [
            Of("청구/가.md", "request@1", """{"이름": "가", "예산": 100}""", id: "r-1"),
            Of("청구/나.md", "request@1", """{"이름": "나", "예산": 50000}""", id: "r-2"),
            Of("품목/1.md", "item@1", """{"청구서": "r-1", "품명": "볼펜", "금액": 0.1}"""),
            Of("품목/2.md", "item@1", """{"청구서": "r-1", "품명": "공책", "금액": 0.2}"""),
            Of("품목/3.md", "item@1", """{"청구서": "r-1", "품명": "자"}"""),
            Of("품목/4.md", "item@1", """{"청구서": "r-2", "품명": "의자", "금액": 45000}"""),
            Of("품목/5.md", "item@1", """{"품명": "책상"}"""),
        ]), Ct);

        // Per request: the largest sum first, exact (0.1 + 0.2 is 0.3), with how many of its items had an amount; a group
        // with no amount at all has no sum — not 0 — and comes last.
        var perRequest = await vault.AggregateAsync(new AggregateQuery("item@1", ["청구서"], Sum: "금액"), Ct);
        Assert.Equal("금액", perRequest!.Sum);
        Assert.Equal(
            [("r-2", 1L, 45000m, 1L), ("r-1", 3L, 0.3m, 2L), (null, 1L, (decimal?)null, 0L)],
            perRequest.Groups.Select(g => ((string?)g.Key["청구서"], g.Count, g.Sum!.Total, g.Sum.Counted)));

        // No grouping: one sum over every kept document. Without a sum, no group carries one.
        var all = await vault.AggregateAsync(new AggregateQuery("item@1", Sum: "금액"), Ct);
        Assert.Equal(45000.3m, Assert.Single(all!.Groups).Sum!.Total);
        Assert.All((await vault.AggregateAsync(new AggregateQuery("item@1", ["청구서"]), Ct))!.Groups, g => Assert.Null(g.Sum));

        // A number field of the document an item names adds up too, as that document holds it: each item counts its
        // requisition's budget once.
        var budgets = await vault.AggregateAsync(new AggregateQuery("item@1", Sum: "청구서.예산"), Ct);
        Assert.Equal((50300m, 4L), (Assert.Single(budgets!.Groups).Sum!.Total, budgets.Groups[0].Sum!.Counted));

        // Only a number field adds up: text, or a field the template does not have, is refused.
        await Assert.ThrowsAsync<ArgumentException>(() => vault.AggregateAsync(new AggregateQuery("item@1", Sum: "품명"), Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => vault.AggregateAsync(new AggregateQuery("item@1", Sum: "수량"), Ct));
    }

    [Fact]
    public async Task Counts_documents_by_a_field_of_the_document_they_refer_to_as_it_holds_it_now()
    {
        var customer = Templates.Of("customer@2", [new TemplateField("이름", "text"), new TemplateField("지역", "select"), new TemplateField("등록일", "date")]);
        var inquiry = Templates.Of("inquiry@1",
            [new TemplateField("고객", "select", Reference: "customer"), new TemplateField("담당", "select"), new TemplateField("태그", "checkbox", Multiple: true)]);
        static DocumentSnapshot Of(string path, string template, string json, string? id = null) =>
            new(path, template, JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!, Id: id);
        DocumentSnapshot[] Documents(string region) =>
        [
            Of("고객/가나.md", "customer@2", $$"""{"이름": "가나상사", "지역": "{{region}}", "등록일": "2026-03-02"}""", id: "c-1"),
            // Known by its path: a reference to it holds the path.
            Of("고객/다라.md", "customer@2", """{"이름": "다라무역", "지역": "부산"}"""),
            Of("문의/1.md", "inquiry@1", """{"고객": "c-1", "담당": "장비"}"""),
            Of("문의/2.md", "inquiry@1", """{"고객": "c-1", "담당": "인사"}"""),
            Of("문의/3.md", "inquiry@1", """{"고객": "고객/다라.md", "담당": "장비"}"""),
            Of("문의/4.md", "inquiry@1", """{"담당": "장비"}"""),
        ];
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([customer, inquiry], Documents("서울")), Ct);

        var byRegion = await vault.AggregateAsync(new AggregateQuery("inquiry@1", ["고객.지역"]), Ct);
        Assert.Equal([("서울", 2L), ("부산", 1L), (null, 1L)], byRegion!.Groups.Select(g => ((string?)g.Key["고객.지역"], g.Count)));
        Assert.Equal(["문의/1.md", "문의/2.md"], byRegion.Groups[0].Evidence);

        // Kept by a field of the referred document; a date there reads as it was written.
        var seoul = await vault.AggregateAsync(new AggregateQuery("inquiry@1", ["담당"], [new ColumnFilter("고객.지역", "equal", "서울")]), Ct);
        Assert.Equal([("인사", 1L), ("장비", 1L)], seoul!.Groups.Select(g => ((string?)g.Key["담당"], g.Count)).OrderBy(g => g.Item1));
        var registered = await vault.AggregateAsync(new AggregateQuery("inquiry@1", ["고객.등록일"], [new ColumnFilter("고객.등록일", "atLeast", "2026-03-01")]), Ct);
        Assert.Equal(("2026-03-02", 2L), ((string?)Assert.Single(registered!.Groups).Key["고객.등록일"], registered.Groups[0].Count));

        // The customer moves: the count follows the document as it is now.
        await vault.IngestAsync(new VaultSnapshot([customer, inquiry], Documents("대전")), Ct);
        var moved = await vault.AggregateAsync(new AggregateQuery("inquiry@1", ["고객.지역"]), Ct);
        Assert.Equal(2L, moved!.Groups.Single(g => (string?)g.Key["고객.지역"] == "대전").Count);

        // One step only, and only through a field that names one document of a template the vault has.
        await Assert.ThrowsAsync<ArgumentException>(() => vault.AggregateAsync(new AggregateQuery("inquiry@1", ["태그.지역"]), Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => vault.AggregateAsync(new AggregateQuery("inquiry@1", ["고객.없는칸"]), Ct));
    }

    [Fact]
    public async Task Answers_the_rows_that_match_every_filter()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([BugReport],
        [
            Document("문서/2026-01-15 저장 멈춤.md", """{"제목": "저장 후 멈춤", "심각도": "높음"}"""),
            Document("문서/2026-01-16 열기 실패.md", """{"제목": "열기 실패", "심각도": "높음"}"""),
            Document("문서/2026-02-01 저장 느림.md", """{"제목": "저장이 느림", "심각도": "낮음"}"""),
        ]), Ct);

        async Task<string[]> Paths(params ColumnFilter[] filters) =>
            [.. (await vault.TableAsync("bug-report@1", filters, Ct))!.Rows.Select(r => r.Path)];

        Assert.Equal(["문서/2026-01-15 저장 멈춤.md", "문서/2026-02-01 저장 느림.md"], await Paths(new ColumnFilter("제목", "contains", "저장")));
        Assert.Equal(["문서/2026-01-15 저장 멈춤.md", "문서/2026-01-16 열기 실패.md"], await Paths(new ColumnFilter("심각도", "equal", "높음")));
        Assert.Equal(["문서/2026-01-15 저장 멈춤.md"],
            await Paths(new ColumnFilter("제목", "contains", "저장"), new ColumnFilter("심각도", "equal", "높음")));
        // A document's name is its path.
        Assert.Equal(["문서/2026-02-01 저장 느림.md"], await Paths(new ColumnFilter(VaultProjection.PathColumn, "contains", "2026-02")));
        Assert.Empty(await Paths(new ColumnFilter("제목", "contains", "없는 말")));
        await vault.IngestAsync(new VaultSnapshot([BugReport],
        [
            Document("문서/1.md", """{"제목": "하나", "점수": 1}"""),
            Document("문서/2.md", """{"제목": "둘", "점수": 2.5}"""),
            Document("문서/3.md", """{"제목": "셋", "점수": 3}"""),
            Document("문서/4.md", """{"제목": "없음"}"""),
        ]), Ct);
        // A number field's bounds, both included; a document without a value is outside any.
        Assert.Equal(["문서/2.md", "문서/3.md"], await Paths(new ColumnFilter("점수", "atLeast", "2")));
        Assert.Equal(["문서/1.md", "문서/2.md"],
            await Paths(new ColumnFilter("점수", "atLeast", "1"), new ColumnFilter("점수", "atMost", "2.5")));
        await Assert.ThrowsAsync<ArgumentException>(() => Paths(new ColumnFilter("제목", "near", "저장")));
        await vault.IngestAsync(new VaultSnapshot([BugReport],
        [
            Document("문서/a.md", """{"제목": "정함", "심각도": "높음"}"""),
            Document("문서/b.md", """{"제목": "빈 글", "심각도": ""}"""),
            Document("문서/c.md", """{"제목": "공백", "심각도": "  "}"""),
            Document("문서/d.md", """{"제목": "없음"}"""),
        ]), Ct);
        // A field left blank, written as nothing or not written at all, has no value; `empty` asks for those.
        Assert.Equal(["문서/b.md", "문서/c.md", "문서/d.md"], await Paths(new ColumnFilter("심각도", "empty", "")));
        Assert.Equal(["문서/a.md"], await Paths(new ColumnFilter("심각도", "equal", "높음")));
    }

    [Fact]
    public async Task A_new_snapshot_replaces_the_old_one()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([BugReport], [Document("문서/a.md", """{"제목": "첫 값"}""")]), Ct);
        await vault.IngestAsync(new VaultSnapshot([BugReport], [Document("문서/a.md", """{"제목": "고친 값"}""")]), Ct);

        var table = await vault.TableAsync("bug-report@1", Ct);
        var row = Assert.Single(table!.Rows);
        Assert.Equal("고친 값", row.Values["제목"]);
    }

    [Fact]
    public async Task Documents_of_a_template_missing_from_the_vault_are_reported()
    {
        await using var vault = new VaultProjection();
        var result = await vault.IngestAsync(new VaultSnapshot([BugReport],
            [new DocumentSnapshot("문서/x.md", "gone@1", new Dictionary<string, JsonElement>())]), Ct);

        Assert.Equal(0, result.Appended);
        var skipped = Assert.Single(result.Skipped);
        Assert.Equal("문서/x.md", skipped.Path);
    }

    [Fact]
    public async Task Date_fields_are_dates_the_same_on_every_computer_and_an_unreadable_one_empties_only_its_field()
    {
        var visits = Templates.Of("visit@1",
        [
            new TemplateField("제목", "text"),
            new TemplateField("방문일", "date"),
            new TemplateField("예약", "datetime-local"),
        ]);
        static DocumentSnapshot Visit(string path, string json) =>
            new(path, "visit@1", JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!);

        await using var vault = new VaultProjection();
        var result = await vault.IngestAsync(new VaultSnapshot([visits],
        [
            Visit("문서/1.md", """{"제목": "하나", "방문일": "2026-01-15", "예약": "2026-01-15T09:30"}"""),
            Visit("문서/2.md", """{"제목": "둘", "방문일": "2026-01-31"}"""),
            Visit("문서/3.md", """{"제목": "셋", "방문일": "2026-02-01"}"""),
            Visit("문서/4.md", """{"제목": "넷", "방문일": "다음 주쯤"}"""),
        ]), Ct);

        // The document with an unreadable date is still a row; only that field is empty, and it is said where.
        Assert.Empty(result.Skipped);
        var skip = Assert.Single(result.SkippedFields);
        Assert.Equal(("문서/4.md", "방문일"), (skip.Path, skip.Field));

        var table = await vault.TableAsync("visit@1", Ct);
        Assert.Equal(["문서/1.md", "문서/2.md", "문서/3.md", "문서/4.md"], table!.Rows.Select(r => r.Path));
        // A date reads back as it was written, whatever the computer's time zone.
        Assert.Equal("2026-01-15", table.Rows[0].Values["방문일"]);
        Assert.Equal("2026-01-15T09:30", table.Rows[0].Values["예약"]);
        Assert.Null(table.Rows[3].Values["방문일"]);

        async Task<string[]> Paths(params ColumnFilter[] filters) =>
            [.. (await vault.TableAsync("visit@1", filters, Ct))!.Rows.Select(r => r.Path)];
        // A date range, both ends included, matches dates — not the order of their text.
        Assert.Equal(["문서/2.md", "문서/3.md"], await Paths(new ColumnFilter("방문일", "atLeast", "2026-01-16")));
        Assert.Equal(["문서/1.md", "문서/2.md"], await Paths(new ColumnFilter("방문일", "atMost", "2026-01-31")));
    }

    [Fact]
    public async Task An_unreadable_number_empties_only_its_field_and_is_said_where()
    {
        var orders = Templates.Of("order@1", [new TemplateField("제목", "text"), new TemplateField("수량", "number")]);
        static DocumentSnapshot Order(string path, string json) =>
            new(path, "order@1", JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!);

        await using var vault = new VaultProjection();
        var result = await vault.IngestAsync(new VaultSnapshot([orders],
        [
            Order("문서/1.md", """{"제목": "하나", "수량": 12.5}"""),
            Order("문서/2.md", """{"제목": "둘", "수량": "1,000"}"""),
        ]), Ct);

        Assert.Empty(result.Skipped);
        var skip = Assert.Single(result.SkippedFields);
        Assert.Equal(("문서/2.md", "수량"), (skip.Path, skip.Field));
        var table = await vault.TableAsync("order@1", Ct);
        Assert.Equal(["문서/1.md", "문서/2.md"], table!.Rows.Select(r => r.Path));
        Assert.Null(table.Rows[1].Values["수량"]);
    }

    [Fact]
    public async Task A_cache_that_held_dates_as_text_shows_them_as_dates_once_the_field_is_a_date()
    {
        // A cache filled before date fields were dates holds them as text: the same template, its field now a
        // date, rebuilds the table rather than comparing text.
        static TemplateSnapshot Visits(string type) => Templates.Of("visit@1", [new TemplateField("방문일", type)]);
        var documents = new[]
        {
            new DocumentSnapshot("문서/1.md", "visit@1", new Dictionary<string, JsonElement> { ["방문일"] = JsonSerializer.SerializeToElement("2026-1-9") }),
            new DocumentSnapshot("문서/2.md", "visit@1", new Dictionary<string, JsonElement> { ["방문일"] = JsonSerializer.SerializeToElement("2026-01-10") }),
        };
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([Visits("text")], documents), Ct);

        var result = await vault.IngestAsync(new VaultSnapshot([Visits("date")], documents), Ct);
        Assert.Equal(["visit@1"], result.Projections);
        // As text, "2026-1-9" sorts after "2026-01-10"; as dates it is the day before.
        var table = await vault.TableAsync("visit@1", [new ColumnFilter("방문일", "atLeast", "2026-01-10")], Ct);
        Assert.Equal(["문서/2.md"], table!.Rows.Select(r => r.Path));
        Assert.Equal("2026-01-10", table.Rows[0].Values["방문일"]);
    }

    [Fact]
    public async Task An_unknown_template_has_no_table()
    {
        await using var vault = new VaultProjection();
        Assert.Null(await vault.TableAsync("bug-report@1", Ct));
        await vault.IngestAsync(new VaultSnapshot([BugReport], []), Ct);
        Assert.Null(await vault.TableAsync("other@1", Ct));
        Assert.Empty((await vault.TableAsync("bug-report@1", Ct))!.Rows);
    }
}
