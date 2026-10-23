using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lowline.Host.Tests;

public sealed class SuggestionsTests
{
    private static readonly TemplateSnapshot Intake = Templates.Of("intake@1",
    [
        new TemplateField("요청", "textarea"),
        new TemplateField("부서", "text"),
        new TemplateField("담당", "select"),
    ], Suggest: ["담당"]);

    private static IReadOnlyDictionary<string, JsonElement> Values(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    private static DocumentSnapshot Document(string path, string json) => new(path, "intake@1", Values(json));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<VaultProjection> Vault(params DocumentSnapshot[] documents)
    {
        var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([Intake], documents), Ct);
        return vault;
    }

    /// <summary>
    /// Thirty requests, no two alike, where 부서 decides 담당 — the history a field's values settled alongside need
    /// before replay lets them answer.
    /// </summary>
    private static DocumentSnapshot[] Decided() =>
    [
        .. Enumerable.Range(0, 30).Select(i => new DocumentSnapshot($"문서/{i}.md", "intake@1",
            Values($$"""{"요청": "{{Words[i % 10]}} {{Words[i / 10 * 3 % 10]}} {{i}}", "부서": "{{Departments[i % 3]}}", "담당": "{{Owners[Departments[i % 3]]}}"}"""),
            Modified: i)),
    ];

    private static readonly string[] Words = ["사과", "기차", "구름", "연필", "바다", "시계", "우산", "나무", "모자", "종이"];
    private static readonly Dictionary<string, string> Owners = new() { ["영업"] = "장비", ["개발"] = "인사", ["인사"] = "총무" };
    private static readonly string[] Departments = [.. Owners.Keys];

    private static async Task<VaultProjection> Selected(VaultSnapshot snapshot)
    {
        var vault = new VaultProjection();
        await vault.IngestAsync(snapshot, Ct);
        await vault.ThresholdsSelected.WaitAsync(Ct);
        return vault;
    }

    [Fact]
    public async Task Does_not_offer_a_similar_documents_value_before_its_replay_rests_on_enough_answers()
    {
        // The request is nearly 문서/1's, but its 부서 settles nothing — and thirty documents give similar documents too few
        // answers for their promise to be offered on.
        await using var vault = await Selected(new VaultSnapshot([Intake], Decided()));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "기차 사과 1!", "부서": "기획"}""")), Ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.Undecided), suggestion);
        Assert.True(vault.MemoryReady);
    }

    /// <summary>
    /// A hundred and twenty requests, each worded once, whose words say which kind it is: no value settled alongside ever
    /// repeats, so only similar documents can answer 분류 — and they do over far more answers than they must rest on.
    /// </summary>
    private static readonly TemplateSnapshot Kinds = Templates.Of("kinds@1",
        [new TemplateField("내용", "textarea"), new TemplateField("분류", "select", Options: ["인쇄", "화면", "연결"])],
        Suggest: ["분류"]);

    private static DocumentSnapshot[] KindRequests(int count) =>
    [
        .. Enumerable.Range(0, count).Select(i => new DocumentSnapshot($"분류/{i}.md", "kinds@1",
            Values($$"""{"내용": "{{KindWords[i % 3]}} {{i}}번째", "분류": "{{KindNames[i % 3]}}"}"""), Modified: i)),
    ];

    private static readonly string[] KindNames = ["인쇄", "화면", "연결"];
    private static readonly string[] KindWords = ["프린터 용지 걸림", "모니터 화면 깜빡임", "네트워크 연결 끊김"];

    [Fact]
    public async Task Offers_a_similar_documents_value_on_a_field_whose_replay_of_them_rests_on_enough_answers()
    {
        await using var vault = await Selected(new VaultSnapshot([Kinds], KindRequests(120)));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("kinds@1", "분류", Values("""{"내용": "모니터 화면 깜빡임 또"}""")), Ct);

        Assert.Equal("화면", suggestion?.Value);
        Assert.Equal(SuggestionMode.Memory, suggestion?.Mode);
        Assert.StartsWith("분류/", suggestion?.Source);
        var similar = (await vault.CurvesAsync(Ct)).Single(c => c.Field == "분류").Similar!;
        Assert.True(similar.Offered);
        Assert.True(similar.PromiseAnswered >= Suggestions.SimilarMinimumAnswered);
    }

    [Fact]
    public async Task Says_how_similar_documents_did_and_does_not_offer_them_while_their_promise_rests_on_too_few_answers()
    {
        // Twenty-five requests: similar documents are right on every one they answer, but over fewer answers than they must rest on.
        await using var vault = await Selected(new VaultSnapshot([Kinds], KindRequests(25)));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("kinds@1", "분류", Values("""{"내용": "모니터 화면 깜빡임 또"}""")), Ct);

        Assert.Equal(SuggestionMode.Abstain, suggestion?.Mode);
        var similar = (await vault.CurvesAsync(Ct)).Single(c => c.Field == "분류").Similar!;
        Assert.False(similar.Offered);
        Assert.True(similar.PromiseAnswered < Suggestions.SimilarMinimumAnswered);
    }

    [Fact]
    public async Task Similar_documents_are_not_offered_while_the_person_types()
    {
        // Replayed before typing only: once a character is typed, the field is left to values settled alongside.
        var typed = Templates.Of(Kinds.Ref, [new TemplateField("내용", "textarea"), new TemplateField("분류", "text")], Kinds.Suggest, Kinds.Coarse);
        await using var vault = await Selected(new VaultSnapshot([typed], KindRequests(120)));

        var before = await vault.SuggestAsync(new SuggestRequest("kinds@1", "분류", Values("""{"내용": "모니터 화면 깜빡임 또"}""")), Ct);
        var typing = await vault.SuggestAsync(
            new SuggestRequest("kinds@1", "분류", Values("""{"내용": "모니터 화면 깜빡임 또"}"""), Typed: "화"), Ct);

        Assert.Equal(SuggestionMode.Memory, before?.Mode);
        Assert.NotEqual(SuggestionMode.Memory, typing?.Mode);
    }

    [Fact]
    public void Tunings_are_kept_as_the_engine_handed_them()
    {
        var file = Path.GetTempFileName();
        try
        {
            ThresholdStore.Save(file, new Dictionary<string, string> { ["kinds@1"] = """{"tuning":{},"report":[]}""" });
            Assert.Equal("""{"tuning":{},"report":[]}""", ThresholdStore.Load(file)["kinds@1"]);
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public async Task Does_not_offer_a_value_only_another_fields_value_backs()
    {
        // 인사 was confirmed with 부서 개발, but the request itself resembles nothing confirmed.
        await using var vault = await Vault(
            Document("문서/1.md", """{"요청": "노트북 배터리가 금방 닳아요", "부서": "영업", "담당": "장비"}"""),
            Document("문서/2.md", """{"요청": "급여 명세서를 다시 받고 싶어요", "부서": "개발", "담당": "인사"}"""));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "회의실 예약 방법이 궁금합니다", "부서": "개발"}""")), Ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.BelowTarget), suggestion);
    }

    [Fact]
    public async Task Does_not_offer_a_value_nothing_in_the_document_backs()
    {
        // 장비 is the field's most frequent value, but nothing in this document points to it.
        await using var vault = await Vault(
            Document("문서/1.md", """{"요청": "노트북 배터리가 금방 닳아요", "부서": "영업", "담당": "장비"}"""),
            Document("문서/2.md", """{"요청": "모니터가 깜빡여요", "부서": "영업", "담당": "장비"}"""));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "회의실 예약 방법이 궁금합니다", "부서": "총무"}""")), Ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.BelowTarget), suggestion);
    }

    [Fact]
    public async Task A_document_is_not_its_own_similar_document()
    {
        await using var vault = await Vault(Document("문서/1.md", """{"요청": "노트북 배터리가 금방 닳아요", "담당": "장비"}"""));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리가 금방 닳아요!"}"""), "문서/1.md"), Ct);

        Assert.Null(suggestion!.Value);
    }

    [Fact]
    public async Task Does_not_learn_from_a_document_with_a_conflict_copy()
    {
        // A sync client kept both devices' edits: which values hold is not settled yet.
        await using var vault = await Vault(
            Document("문서/1.md", """{"요청": "노트북 배터리가 금방 닳아요", "담당": "장비"}""") with { Conflicted = true });

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리가 금방 닳아요!"}""")), Ct);
        var table = await vault.TableAsync("intake@1", Ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.NoHistory), suggestion);
        Assert.Equal("문서/1.md", Assert.Single(table!.Rows).Path);
    }

    [Fact]
    public async Task Learns_from_a_document_again_once_which_copy_holds_is_settled()
    {
        var document = Document("문서/1.md", """{"요청": "노트북 배터리가 금방 닳아요", "담당": "총무"}""");
        await using var vault = await Vault(document with { Conflicted = true });
        var request = new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리가 금방 닳아요"}"""));
        Assert.Equal(Abstention.NoHistory, (await vault.SuggestAsync(request, Ct))!.Reason);

        // The copy kept took the original's place: its values are confirmed again.
        await vault.IngestAsync(new VaultSnapshot([Intake], [document]), Ct);
        Assert.NotEqual(Abstention.NoHistory, (await vault.SuggestAsync(request, Ct))!.Reason);
    }

    [Fact]
    public async Task Does_not_learn_a_value_another_program_proposed()
    {
        // Every 담당 was written by another program as a suggestion: nobody has confirmed one yet.
        await using var vault = await Selected(new VaultSnapshot([Intake], [.. Decided().Select(d => d with { Proposed = ["담당"] })]));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "기차 사과 1!", "부서": "영업"}""")), Ct);
        var table = await vault.TableAsync("intake@1", Ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.NoHistory), suggestion);
        Assert.Equal(30, table!.Rows.Count); // the values stay in the documents
    }

    [Fact]
    public async Task A_proposed_value_does_not_outweigh_what_people_confirmed()
    {
        // People settled 영업 → 장비; another program proposed 총무 for 영업 in more documents since.
        DocumentSnapshot[] proposed =
        [
            .. Enumerable.Range(30, 40).Select(i => new DocumentSnapshot($"문서/{i}.md", "intake@1",
                Values($$"""{"요청": "{{Words[i % 10]}} {{i}}", "부서": "영업", "담당": "총무"}"""), Modified: i, Proposed: ["담당"])),
        ];
        await using var vault = await Selected(new VaultSnapshot([Intake], [.. Decided(), .. proposed]));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "기차 사과 1!", "부서": "영업"}""")), Ct);

        Assert.Equal("장비", suggestion!.Value);
    }

    [Fact]
    public async Task Abstains_until_the_history_shows_what_decides_the_field()
    {
        // The same request confirmed once: too little to show its value is right often enough.
        await using var vault = await Vault(Document("문서/1.md", """{"요청": "노트북 배터리가 금방 닳아요", "담당": "장비"}"""));

        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리가 금방 닳아요"}""")), Ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.BelowTarget), suggestion);
    }

    [Fact]
    public async Task Abstains_on_an_empty_document_and_with_an_empty_memory()
    {
        await using var empty = await Vault();
        var none = await empty.SuggestAsync(new SuggestRequest("intake@1", "담당", Values("""{"요청": "무엇이든"}""")), Ct);
        Assert.Null(none!.Value);

        await using var vault = await Vault(Document("문서/1.md", """{"요청": "배터리", "담당": "장비"}"""));
        var blank = await vault.SuggestAsync(new SuggestRequest("intake@1", "담당", Values("{}")), Ct);
        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.BelowTarget), blank);

        await using var decided = await Selected(new VaultSnapshot([Intake], Decided()));
        var nothing = await decided.SuggestAsync(new SuggestRequest("intake@1", "담당", Values("{}")), Ct);
        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.Undecided), nothing);
    }

    [Fact]
    public async Task A_judgment_field_named_twice_is_one_judgment_field()
    {
        var twice = Intake with { Suggest = ["담당", "담당"] };
        await using var vault = await Selected(new VaultSnapshot([twice], Decided()));
        var suggestion = await vault.SuggestAsync(new SuggestRequest("intake@1", "담당", Values("""{"요청": "기차 사과 1!", "부서": "영업"}""")), Ct);
        Assert.Equal("장비", suggestion!.Value);
    }

    [Fact]
    public async Task Offers_nothing_for_a_field_the_author_did_not_turn_suggestions_on_for()
    {
        await using var vault = await Vault(Document("문서/1.md", """{"요청": "배터리", "부서": "영업", "담당": "장비"}"""));
        Assert.Null(await vault.SuggestAsync(new SuggestRequest("intake@1", "부서", Values("""{"요청": "배터리"}""")), Ct));
        Assert.Null(await vault.SuggestAsync(new SuggestRequest("other@1", "담당", Values("{}")), Ct));
    }

    [Fact]
    public async Task Chooses_a_fields_threshold_from_its_history_once_it_is_long_enough()
    {
        var few = await Suggestions.BuildAsync(new VaultSnapshot([Intake],
            [.. Enumerable.Range(1, 5).Select(i => Document($"문서/{i}.md", $$"""{"요청": "노트북 배터리 문제 {{i}}", "담당": "장비"}"""))]), Ct);
        Assert.Null(few.Report("intake@1", "담당")?.Key); // too short: nothing is offered yet

        var many = await Suggestions.BuildAsync(Many(15), Ct);
        Assert.True(many.NeedsSelection);
        Assert.Null(many.Report("intake@1", "담당")?.Key); // chosen apart from building memory
        await many.ApplyAsync(await many.SelectThresholdsAsync(Ct), Ct);
        Assert.False(many.NeedsSelection);
        var choice = many.Report("intake@1", "담당")?.Key;
        Assert.NotNull(choice);
        Assert.True(choice.Precision >= Suggestions.TargetPrecision);
        Assert.True(choice.Answered >= Suggestions.MinimumAnswered);

        // Rebuilt from the same vault, the field keeps its threshold rather than replaying again.
        var rebuilt = await Suggestions.BuildAsync(Many(15), Ct, kept: many.Thresholds);
        Assert.False(rebuilt.NeedsSelection);
        Assert.Equal(choice, rebuilt.Report("intake@1", "담당")?.Key);
        Assert.True((await Suggestions.BuildAsync(Many(17), Ct, kept: many.Thresholds)).NeedsSelection); // grew by a tenth
    }

    [Fact]
    public async Task A_kept_tuning_is_chosen_again_once_the_template_has_other_fields()
    {
        var many = await Suggestions.BuildAsync(Many(15), Ct);
        await many.ApplyAsync(await many.SelectThresholdsAsync(Ct), Ct);
        Assert.False((await Suggestions.BuildAsync(Many(15), Ct, kept: many.Thresholds)).NeedsSelection);

        // 부서 taken out of the template: what was chosen rested on scores it gave.
        var without = Many(15) with { Templates = [Intake with { Fields = [.. Intake.Fields.Where(f => f.Name != "부서")] }] };
        Assert.True((await Suggestions.BuildAsync(without, Ct, kept: many.Thresholds)).NeedsSelection);
    }

    [Fact]
    public async Task A_field_naming_what_is_judged_is_believed_after_few_settlements_where_suggestions_are_made()
    {
        // Each establishment keeps its risk; an inspection's kind is drawn from three and mostly goes with one risk. The
        // establishment's keys keep their value, so they are believed after a settlement or two — in the form the
        // strengths were chosen on and the one suggestions are made with alike.
        var inspection = Templates.Of("inspection@1",
        [
            new TemplateField("업소", "text"),
            new TemplateField("유형", "select", Options: ["정기", "민원", "재점검"]),
            new TemplateField("위험도", "select", Options: ["상", "중", "하"]),
        ], Suggest: ["위험도"]);
        string[] risks = ["상", "중", "하"];
        string[] kinds = ["정기", "민원", "재점검"];
        // Establishment e has risk e % 3; the kind is that risk's kind except one inspection in five. Establishments
        // 0–39 were inspected twice, 40–59 once.
        var documents = Enumerable.Range(0, 100).Select(i =>
        {
            var e = i % 60;
            var kind = kinds[i % 5 == 4 ? (e + 1) % 3 : e % 3];
            return new DocumentSnapshot($"검사/{i}.md", "inspection@1",
                Values($$"""{"업소": "업소-{{e}}", "유형": "{{kind}}", "위험도": "{{risks[e % 3]}}"}"""), Modified: i);
        }).ToArray();
        var suggestions = await Suggestions.BuildAsync(new VaultSnapshot([inspection], documents), Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);

        // 업소-43, seen once, is 중; 재점검 mostly goes with 하.
        var request = new SuggestRequest("inspection@1", "위험도", Values("""{"업소": "업소-43", "유형": "재점검"}"""));
        Assert.Equal(new Suggestion("중", "key", "업소: 업소-43"), await suggestions.SuggestAsync(request, Ct));
    }

    [Fact]
    public async Task A_field_naming_another_document_decides_a_judgment_field_by_that_documents_id()
    {
        // 고객 names a customer document by its id; which customer it is decides 담당.
        var inquiry = Templates.Of("inquiry@1",
        [
            new TemplateField("요청", "textarea"),
            new TemplateField("고객", "select"),
            new TemplateField("담당", "select"),
        ], Suggest: ["담당"]);
        string[] words = ["사과", "기차", "구름", "연필", "바다", "시계", "우산", "나무", "모자", "종이"];
        var owners = new Dictionary<string, string>
        {
            ["3f2a1b2c-0000-4000-8000-000000000001"] = "장비",
            ["3f2a1b2c-0000-4000-8000-000000000002"] = "인사",
            ["3f2a1b2c-0000-4000-8000-000000000003"] = "총무",
        };
        var customers = owners.Keys.ToArray();
        var vault = new VaultSnapshot([inquiry],
            [.. Enumerable.Range(0, 30).Select(i => new DocumentSnapshot($"문서/{i}.md", "inquiry@1",
                Values($$"""{"요청": "{{words[i % 10]}} {{words[i / 10 * 3 % 10]}} {{i}}", "고객": "{{customers[i % 3]}}", "담당": "{{owners[customers[i % 3]]}}"}"""),
                Modified: i))]);
        var suggestions = await Suggestions.BuildAsync(vault, Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);

        var request = new SuggestRequest("inquiry@1", "담당", Values($$"""{"요청": "전혀 다른 요청", "고객": "{{customers[1]}}"}"""));
        Assert.Equal(new Suggestion("인사", "key", $"고객: {customers[1]}"), await suggestions.SuggestAsync(request, Ct));
    }

    [Fact]
    public async Task Answers_from_a_field_that_decides_it_once_its_history_shows_it_does()
    {
        // 부서 decides 담당 here, while no two requests are alike.
        var suggestions = await Suggestions.BuildAsync(new VaultSnapshot([Intake], Decided()), Ct);
        var request = new SuggestRequest("intake@1", "담당", Values("""{"요청": "전혀 다른 요청", "부서": "개발"}"""));

        // Until replay shows 부서 decides it, a value settled alongside it is only a guess.
        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.BelowTarget), await suggestions.SuggestAsync(request, Ct));

        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);
        Assert.Equal(new Suggestion("인사", "key", "부서: 개발"), await suggestions.SuggestAsync(request, Ct));
    }

    [Fact]
    public async Task A_field_drawn_to_check_it_is_shown_no_value_and_the_one_held_back_is_said()
    {
        var suggestions = await Suggestions.BuildAsync(new VaultSnapshot([Intake], Decided()), Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);
        var request = new SuggestRequest("intake@1", "담당", Values("""{"요청": "전혀 다른 요청", "부서": "개발"}"""));

        Assert.Equal(
            new Suggestion(null, SuggestionMode.Check, null, null, Suggestions.Recheck.Rate, "인사"),
            await suggestions.SuggestAsync(request with { Roll = 0.01 }, Ct));
        Assert.Equal(new Suggestion("인사", "key", "부서: 개발"), await suggestions.SuggestAsync(request with { Roll = 0.5 }, Ct));
        // Nothing to show is nothing to hold back: the roll waits for a field that has a value to show.
        var undecided = new SuggestRequest("intake@1", "담당", Values("""{"요청": "전혀 다른 요청", "부서": "기획"}"""), Roll: 0.01);
        Assert.Equal(SuggestionMode.Abstain, (await suggestions.SuggestAsync(undecided, Ct))!.Mode);
    }

    [Fact]
    public async Task A_value_entered_while_its_suggestion_was_held_back_is_a_check()
    {
        var documents = Decided();
        var checkedDocument = documents[^1].Path;
        var events = new[]
        {
            new SuggestionEvent("2026-10-23T10:00:00.000Z", checkedDocument, "담당", SuggestionMode.Check, "총무", "intake@1", "key", 0.05),
            new SuggestionEvent("2026-10-23T10:00:00.000Z", documents[^2].Path, "담당", "accept", "인사", "intake@1", "key"),
        };
        var suggestions = await Suggestions.BuildAsync(new VaultSnapshot([Intake], documents, events), Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);

        var report = suggestions.Report("intake@1", "담당")!;
        Assert.Equal(1, report.Checks);
        Assert.Equal(global::Lowline.Counting.Settled, report.Counting);
        // A check is a value a person entered: it is confirmed like any other.
        Assert.Equal(30, suggestions.Confirmed("intake@1", "담당"));

        // It was no decision about a suggestion shown: the curve leaves it out.
        var curve = Curves.Compute(new VaultSnapshot([Intake], documents, events)).Single();
        Assert.Equal((1, 0, 0), (curve.Accepted, curve.Corrected, curve.Rejected));
        Assert.Equal([new SourceCount("key", 1, 1)], curve.BySource);
    }

    [Fact]
    public async Task Answers_from_a_judgment_the_person_already_confirmed_in_the_document()
    {
        // 승인 goes with 담당, and nothing observed says which 담당 a request has: only a confirmed 담당 decides 승인.
        var routed = Templates.Of("routed@1",
        [
            new TemplateField("요청", "textarea"),
            new TemplateField("담당", "select"),
            new TemplateField("승인", "select"),
        ], Suggest: ["담당", "승인"]);
        Dictionary<string, string> approvers = new() { ["장비"] = "김", ["인사"] = "이", ["총무"] = "박" };
        var vault = new VaultSnapshot([routed], [
            .. Enumerable.Range(0, 30).Select(i => new DocumentSnapshot($"문서/{i}.md", "routed@1",
                Values($$"""{"요청": "{{Words[i % 10]}} {{i}}", "담당": "{{Owners[Departments[i % 3]]}}", "승인": "{{approvers[Owners[Departments[i % 3]]]}}"}"""),
                Modified: i))]);
        var suggestions = await Suggestions.BuildAsync(vault, Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);

        var asked = new SuggestRequest("routed@1", "승인", Values("""{"요청": "전혀 다른 요청"}"""));
        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.Undecided), await suggestions.SuggestAsync(asked, Ct));
        var owned = asked with { Values = Values("""{"요청": "전혀 다른 요청", "담당": "인사"}""") };
        Assert.Equal(new Suggestion("이", "key", "담당: 인사"), await suggestions.SuggestAsync(owned, Ct));
    }

    [Fact]
    public async Task Says_a_field_its_replay_held_back_apart_from_one_these_values_settle_nothing_for()
    {
        // One 부서, owners alternating: the value last settled alongside it is never the next one's.
        var vault = new VaultSnapshot([Intake],
            [.. Enumerable.Range(1, 15).Select(i => new DocumentSnapshot($"문서/{i}.md", "intake@1",
                Values($$"""{"요청": "노트북 배터리 문제 {{i}}", "부서": "영업", "담당": "{{(i % 2 == 0 ? "장비" : "인사")}}"}"""), Modified: i))]);
        var suggestions = await Suggestions.BuildAsync(vault, Ct);
        Assert.Equal(NoReplay.Pending, suggestions.WhyNoReplay("intake@1", "담당"));

        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);
        Assert.Null(suggestions.Report("intake@1", "담당")?.Key);
        Assert.Equal(Abstention.BelowTarget, suggestions.WhyNoReplay("intake@1", "담당"));
        var suggestion = await suggestions.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리 문제 16", "부서": "영업"}""")), Ct);
        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.BelowTarget), suggestion);
        // How close it came: the latest value settled alongside 영업 was the wrong one every time.
        var closest = suggestions.Report("intake@1", "담당")?.Closest;
        Assert.NotNull(closest);
        Assert.True(closest.Precision < Suggestions.TargetPrecision, $"{closest}");
    }

    [Fact]
    public async Task Says_why_a_field_has_no_replay_yet()
    {
        var empty = await Suggestions.BuildAsync(new VaultSnapshot([Intake], []), Ct);
        Assert.Equal(NoReplay.Few, empty.WhyNoReplay("intake@1", "담당"));

        var few = await Suggestions.BuildAsync(Many(5), Ct);
        await few.ApplyAsync(await few.SelectThresholdsAsync(Ct), Ct);
        Assert.Equal(NoReplay.Few, few.WhyNoReplay("intake@1", "담당"));

        var many = await Suggestions.BuildAsync(Many(15), Ct);
        Assert.Equal(NoReplay.Pending, many.WhyNoReplay("intake@1", "담당"));
        await many.ApplyAsync(await many.SelectThresholdsAsync(Ct), Ct);
        Assert.Null(many.WhyNoReplay("intake@1", "담당"));
        Assert.Null(many.WhyNoReplay("intake@1", "부서")); // not a judgment field
    }

    /// <summary>
    /// A template whose 담당자 is typed out, and sixty requests where 부서 says only which two people it may be — every
    /// value settled alongside it is right half the time, its first character every time.
    /// </summary>
    private static readonly TemplateSnapshot Assigned = Templates.Of("assigned@1",
    [
        new TemplateField("요청", "textarea"),
        new TemplateField("부서", "text"),
        new TemplateField("담당자", "text"),
    ], Suggest: ["담당자"]);

    private static VaultSnapshot TwoEach() => new([Assigned],
        [.. Enumerable.Range(0, 60).Select(i => new DocumentSnapshot($"문서/{i}.md", "assigned@1",
            Values($$"""{"요청": "{{Words[i % 10]}} {{i}}", "부서": "{{(i % 4 < 2 ? "영업" : "개발")}}", "담당자": "{{(i % 4) switch { 0 => "김철수", 1 => "박영희", 2 => "이민수", _ => "최지은" }}}"}"""),
            Modified: i))]);

    [Fact]
    public async Task Typing_narrows_a_field_no_strength_answers_on_its_own()
    {
        var suggestions = await Suggestions.BuildAsync(TwoEach(), Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);
        var asked = new SuggestRequest("assigned@1", "담당자", Values("""{"요청": "전혀 다른 요청", "부서": "영업"}"""));

        // 부서 leaves two people: a value it was settled with is right half the time, so none is offered.
        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.BelowTarget), await suggestions.SuggestAsync(asked, Ct));
        // The first character typed tells them apart.
        Assert.NotNull(suggestions.Report("assigned@1", "담당자")!.Typed?[0]);
        Assert.Equal(new Suggestion("박영희", "key", "부서: 영업"), await suggestions.SuggestAsync(asked with { Typed = "박" }, Ct));
        // Nothing settled with 부서 begins with what is typed: nothing is offered.
        Assert.Null((await suggestions.SuggestAsync(asked with { Typed = "최" }, Ct))!.Value);
    }

    [Fact]
    public async Task A_curve_says_how_typing_did_on_replay_where_no_strength_answers_without()
    {
        await using var vault = await Selected(TwoEach());
        var curve = Assert.Single(await vault.CurvesAsync(Ct));
        Assert.Null(curve.Replay); // nothing is suggested before typing
        var first = Assert.Single(curve.Typing!, t => t.Characters == 1);
        Assert.True(first.Precision >= Suggestions.TargetPrecision);
        Assert.True(first.Answered >= Suggestions.MinimumAnswered);

        // A field whose value is picked says nothing about typing.
        await using var picked = await Selected(Many(15));
        Assert.Null(Assert.Single(await picked.CurvesAsync(Ct)).Typing);
    }

    [Fact]
    public async Task A_field_whose_value_is_picked_has_no_strengths_for_typing()
    {
        var suggestions = await Suggestions.BuildAsync(Many(15), Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);
        // 담당 is a select: there is no typing into it, and text said to be typed there asks nothing.
        Assert.Null(suggestions.Report("intake@1", "담당")!.Typed);
        var typed = new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리 문제", "부서": "영업"}"""), Typed: "장");
        Assert.Null((await suggestions.SuggestAsync(typed, Ct))!.Value);
    }

    private static VaultSnapshot Many(int count) => new([Intake],
        [.. Enumerable.Range(1, count).Select(i => new DocumentSnapshot($"문서/{i}.md", "intake@1",
            Values($$"""{"요청": "노트북 배터리 문제 {{i}}", "부서": "영업", "담당": "장비"}"""), Modified: i))]);

    /// <summary><see cref="Many"/> under a template whose 담당 is a choice of <paramref name="choices"/>.</summary>
    private static VaultSnapshot ManyChoosing(int count, params string[] choices) => Many(count) with
    {
        Templates = [Intake with { Fields = [.. Intake.Fields.Select(f => f.Name == "담당" ? f with { Options = choices } : f)] }],
    };

    [Fact]
    public async Task A_choice_since_dropped_is_not_suggested()
    {
        var request = new SuggestRequest("intake@1", "담당", Values("""{"요청": "모니터가 깜빡여요", "부서": "영업"}"""));
        await using var vault = new VaultProjection();
        await vault.IngestAsync(ManyChoosing(15, "장비", "총무"), Ct);
        await vault.ThresholdsSelected.WaitAsync(Ct);
        Assert.Equal("장비", (await vault.SuggestAsync(request, Ct))!.Value);

        // The template no longer offers 장비: what was settled under it is not offered, though still remembered.
        await vault.IngestAsync(ManyChoosing(15, "총무", "재무"), Ct);
        await vault.ThresholdsSelected.WaitAsync(Ct);
        Assert.Null((await vault.SuggestAsync(request, Ct))!.Value);

        // Taken back, it is offered again.
        await vault.IngestAsync(ManyChoosing(15, "장비", "총무"), Ct);
        await vault.ThresholdsSelected.WaitAsync(Ct);
        Assert.Equal("장비", (await vault.SuggestAsync(request, Ct))!.Value);
    }

    [Fact]
    public async Task Changed_choices_have_the_threshold_chosen_again()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(ManyChoosing(15, "장비", "총무"), Ct);
        await vault.ThresholdsSelected.WaitAsync(Ct);
        await vault.IngestAsync(ManyChoosing(15, "장비", "총무"), Ct);
        Assert.True(vault.ThresholdsSelected.IsCompleted); // nothing changed: no replay

        // Nothing grew, but the values the field may be suggested did: its replay counted others.
        var settled = vault.ThresholdsSelected;
        await vault.IngestAsync(ManyChoosing(15, "장비", "총무", "재무"), Ct);
        Assert.NotSame(settled, vault.ThresholdsSelected);
        await vault.ThresholdsSelected.WaitAsync(Ct);
    }

    [Fact]
    public async Task Only_the_templates_whose_history_moved_by_a_tenth_are_chosen_again()
    {
        // Two templates: one gains a request, far less than a tenth; the other is new to the vault.
        var suggestions = await Suggestions.BuildAsync(new VaultSnapshot([Intake], Decided()), Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);
        var grown = new VaultSnapshot([Intake, Kinds], [.. Decided(), Document("문서/30.md", """{"요청": "새 요청", "부서": "영업", "담당": "장비"}"""), .. KindRequests(40)]);

        var again = await Suggestions.BuildAsync(grown, Ct, suggestions.Thresholds);

        Assert.Equal(["kinds@1"], (await again.SelectThresholdsAsync(Ct)).Keys);
    }

    [Fact]
    public async Task A_vault_ingest_chooses_thresholds_in_the_background()
    {
        await using var vault = new VaultProjection();
        await vault.IngestAsync(Many(15), Ct);
        await vault.ThresholdsSelected.WaitAsync(Ct);
        await vault.IngestAsync(Many(15), Ct);
        Assert.True(vault.ThresholdsSelected.IsCompleted); // nothing grew: no replay started
    }

    [Fact]
    public async Task A_later_launch_starts_from_the_thresholds_the_last_one_chose()
    {
        var caches = Directory.CreateTempSubdirectory("lowline-thresholds-").FullName;
        try
        {
            await using (var first = new VaultProjection(caches))
            {
                await first.IngestAsync(Many(15), "C:/vault", Ct);
                await first.ThresholdsSelected.WaitAsync(Ct);
            }
            await using var later = new VaultProjection(caches);
            await later.IngestAsync(Many(15), "C:/vault", Ct);
            // Nothing grew since: the field answers at the strength its history earned, with no replay to wait for.
            Assert.True(later.ThresholdsSelected.IsCompleted);
            var kept = JsonNode.Parse(ThresholdStore.Load(later.ThresholdsFileOf("C:/vault"))["intake@1"])!;
            Assert.Equal(15, kept["tuning"]!["settled"]!.GetValue<int>());
            Assert.NotNull(kept["report"]![0]!["key"]);

            // Another vault opened next, with a template of the same name, has its own history: its fields
            // are replayed, not handed the first vault's thresholds.
            var settled = later.ThresholdsSelected;
            await later.IngestAsync(Many(15), "C:/other", Ct);
            Assert.NotSame(settled, later.ThresholdsSelected);
            await later.ThresholdsSelected.WaitAsync(Ct);
        }
        finally
        {
            Directory.Delete(caches, recursive: true);
        }
    }

    [Fact]
    public void A_kept_thresholds_file_that_cannot_be_read_is_no_thresholds()
    {
        var file = Path.GetTempFileName();
        try
        {
            File.WriteAllText(file, "{ not json");
            Assert.Empty(ThresholdStore.Load(file));
            File.WriteAllText(file, """{"format": 99, "fields": []}""");
            Assert.Empty(ThresholdStore.Load(file));
            Assert.Empty(ThresholdStore.Load(file + ".missing"));
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public async Task Thresholds_another_version_chose_are_chosen_again()
    {
        var caches = Directory.CreateTempSubdirectory("lowline-thresholds-").FullName;
        try
        {
            string file;
            await using (var first = new VaultProjection(caches))
            {
                await first.IngestAsync(Many(15), "C:/vault", Ct);
                await first.ThresholdsSelected.WaitAsync(Ct);
                file = first.ThresholdsFileOf("C:/vault");
            }
            string VersionIn() => JsonNode.Parse(ThresholdStore.Load(file)["intake@1"])!["tuning"]!["version"]!.GetValue<string>();
            var current = VersionIn();

            // The same file as an earlier version wrote it: its thresholds on that version's scale.
            var tuning = JsonNode.Parse(ThresholdStore.Load(file)["intake@1"])!;
            tuning["tuning"]!["version"] = "0.0.1";
            ThresholdStore.Save(file, new Dictionary<string, string> { ["intake@1"] = tuning.ToJsonString() });

            await using var later = new VaultProjection(caches);
            await later.IngestAsync(Many(15), "C:/vault", Ct);
            // Nothing grew, yet the field is replayed, and its thresholds kept again, now as this version's.
            await later.ThresholdsSelected.WaitAsync(Ct);
            Assert.Equal(current, VersionIn());
        }
        finally
        {
            Directory.Delete(caches, recursive: true);
        }
    }

    [Fact]
    public async Task Asking_teaches_nothing()
    {
        // Only saved documents teach. A request carrying a value for the judgment field — an unsaved
        // draft that already holds one — must not become something later requests are answered from.
        await using var vault = await Selected(new VaultSnapshot([Intake], Decided()));
        await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "사내 동호회 가입 신청서 양식", "부서": "기획", "담당": "총무"}"""), "문서/new.md"), Ct);

        var later = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "사내 동호회 가입 신청서 양식", "부서": "기획"}""")), Ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.Undecided), later);
    }

    // 문서/0, 3, 6 … are 영업's, confirmed with 장비.
    private static readonly DocumentSnapshot[] Confirmed = Decided();

    private static SuggestionEvent Event(string at, string doc, string kind) => new(at, doc, "담당", kind, "장비");

    private static async Task<string?> SuggestedIn(VaultProjection vault, string document)
    {
        var suggestion = await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리가 금방 닳아요", "부서": "영업"}"""), document), Ct);
        return suggestion!.Value;
    }

    [Fact]
    public async Task Does_not_offer_again_what_was_rejected_in_a_document()
    {
        await using var vault = await Selected(new VaultSnapshot([Intake], Confirmed, [Event("2026-09-28T10:00:00.000Z", "문서/2.md", "reject")]));

        Assert.Null(await SuggestedIn(vault, "문서/2.md"));
        Assert.Equal("장비", await SuggestedIn(vault, "문서/3.md"));
        Assert.Equal("rejected", (await vault.SuggestAsync(
            new SuggestRequest("intake@1", "담당", Values("""{"요청": "노트북 배터리가 금방 닳아요"}"""), "문서/2.md"), Ct))!.Mode);
    }

    [Fact]
    public async Task Turning_down_a_value_another_program_proposed_is_no_rejection_of_what_is_suggested_here()
    {
        await using var vault = await Selected(new VaultSnapshot([Intake], Confirmed,
            [Event("2026-09-28T10:00:00.000Z", "문서/2.md", "reject") with { Source = SuggestionSource.Proposed }]));

        Assert.Equal("장비", await SuggestedIn(vault, "문서/2.md"));
    }

    [Fact]
    public async Task A_later_confirmation_in_the_document_lifts_a_rejection()
    {
        await using var vault = await Selected(new VaultSnapshot([Intake], Confirmed,
        [
            Event("2026-09-28T11:00:00.000Z", "문서/2.md", "correct"),
            Event("2026-09-28T10:00:00.000Z", "문서/2.md", "reject"),
        ]));

        Assert.Equal("장비", await SuggestedIn(vault, "문서/2.md"));
    }

    [Fact]
    public async Task A_document_is_known_by_its_id_wherever_its_file_is()
    {
        // The rejection was recorded when the file was 문서/2.md; it has been renamed since.
        var renamed = Confirmed.Select(d => d.Path == "문서/2.md" ? d with { Path = "문서/새 이름.md", Id = "doc-2" } : d).ToArray();
        await using var vault = await Selected(new VaultSnapshot([Intake], renamed, [Event("2026-09-28T10:00:00.000Z", "doc-2", "reject")]));

        Assert.Null(await SuggestedIn(vault, "doc-2"));
        Assert.Equal("장비", await SuggestedIn(vault, "doc-9"));
    }

    [Fact]
    public async Task A_value_that_backs_another_about_one_time_in_three_does_not_answer_for_it()
    {
        // Support requests written from a few stock sentences, so settled documents repeat one another and
        // answer each other right by their own requests. 채널 전화 leans to 배송 but backs it only about a third of
        // the time, and 제품 backs nothing: neither may answer 분류 for a request unlike any settled one, however
        // well the repeats did on the replay.
        var support = Templates.Of("support@1",
        [
            new TemplateField("문의", "textarea"),
            new TemplateField("채널", "select"),
            new TemplateField("제품", "select"),
            new TemplateField("분류", "select"),
        ], Suggest: ["분류"]);
        var sentences = new Dictionary<string, string[]>
        {
            ["고장"] = ["정수기에서 물이 새요", "전원이 들어오지 않아요", "소음이 심해졌어요"],
            ["배송"] = ["주문한 제품이 아직 안 왔어요", "배송 조회가 안 돼요", "다른 주소로 받고 싶어요"],
            ["환불"] = ["환불 받고 싶어요", "결제가 두 번 됐어요", "반품 접수는 어떻게 하나요"],
            ["설치"] = ["설치 기사 방문 일정을 잡고 싶어요", "벽걸이로 달 수 있나요", "이사 후 재설치 문의"],
        };
        var kinds = sentences.Keys.ToArray();
        string[] products = ["정수기", "공기청정기", "비데"];
        var random = new Random(586);
        var vault = new VaultSnapshot([support],
            [.. Enumerable.Range(0, 200).Select(i =>
            {
                var kind = kinds[random.Next(kinds.Length)];
                var phone = random.NextDouble() < (kind == "배송" ? 0.6 : 0.25);
                var channel = phone ? "전화" : random.Next(2) == 0 ? "채팅" : "이메일";
                var json = $$"""{"문의": "{{sentences[kind][random.Next(3)]}}", "채널": "{{channel}}", "제품": "{{products[random.Next(3)]}}", "분류": "{{kind}}"}""";
                return new DocumentSnapshot($"문서/{i:D3}.md", "support@1", Values(json), Modified: i);
            })]);
        var byPhone = vault.Documents.Where(d => d.Values["채널"].GetString() == "전화").ToList();
        var deliveryShare = (double)byPhone.Count(d => d.Values["분류"].GetString() == "배송") / byPhone.Count;
        Assert.InRange(deliveryShare, 0.25, 0.45); // the lean the case is about, measured on the data itself
        Assert.Equal("배송", byPhone.GroupBy(d => d.Values["분류"].GetString()).MaxBy(g => g.Count())!.Key);

        var suggestions = await Suggestions.BuildAsync(vault, Ct);
        await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(Ct), Ct);

        var suggestion = await suggestions.SuggestAsync(new SuggestRequest("support@1", "분류",
            Values("""{"문의": "정수기에서 물이 조금씩 흘러나와요", "채널": "전화", "제품": "정수기"}""")), Ct);
        Assert.NotNull(suggestion);
        Assert.NotEqual("key", suggestion.Mode);
        Assert.NotEqual("배송", suggestion.Value);
    }

    /// <summary>
    /// A fault form whose code's first two characters name its chapter: each 설비 has five codes of one chapter, so the
    /// settled values under a 설비 never decide the code, and always decide its chapter.
    /// </summary>
    private static TemplateSnapshot Fault(IReadOnlyDictionary<string, int>? coarse) => Templates.Of("fault@1",
    [
        new TemplateField("설비", "text"),
        new TemplateField("코드", "text"),
    ], Suggest: ["코드"], Coarse: coarse);

    private static readonly Dictionary<string, string> Chapters = new() { ["압축기"] = "21", ["펌프"] = "32", ["밸브"] = "52" };

    private static DocumentSnapshot[] Faults() =>
    [
        .. Enumerable.Range(0, 60).Select(i =>
        {
            var unit = Chapters.Keys.ElementAt(i % 3);
            return new DocumentSnapshot($"결함/{i}.md", "fault@1", Values($$"""{"설비": "{{unit}}", "코드": "{{Chapters[unit]}}{{i / 3 % 5:D2}}"}"""), Modified: i);
        }),
    ];

    [Fact]
    public async Task Offers_a_fields_class_where_its_value_is_undecided_when_the_template_names_the_class()
    {
        await using var vault = await Selected(new VaultSnapshot([Fault(new Dictionary<string, int> { ["코드"] = 2 })], Faults()));

        var suggestion = await vault.SuggestAsync(new SuggestRequest("fault@1", "코드", Values("""{"설비": "펌프"}""")), Ct);
        Assert.NotNull(suggestion);
        Assert.Equal(SuggestionMode.Coarse, suggestion.Mode);
        Assert.Equal("32", suggestion.Value);
        Assert.Equal("설비: 펌프", suggestion.Source);

        // The learning screen says how the class did where the value was not suggested, as it does for the value.
        var curve = (await vault.CurvesAsync(Ct)).Single(c => c.Field == "코드");
        Assert.NotNull(curve.Coarse);
        Assert.True(curve.Coarse.Precision >= Suggestions.TargetPrecision);
        Assert.True(curve.Coarse.Answered >= Suggestions.MinimumAnswered);

        // Nothing settled under a 설비 never seen: no class either.
        var unknown = await vault.SuggestAsync(new SuggestRequest("fault@1", "코드", Values("""{"설비": "냉각탑"}""")), Ct);
        Assert.Equal(SuggestionMode.Abstain, unknown!.Mode);
    }

    [Fact]
    public async Task Offers_no_class_for_a_field_whose_template_names_none()
    {
        await using var vault = await Selected(new VaultSnapshot([Fault(null)], Faults()));

        var suggestion = await vault.SuggestAsync(new SuggestRequest("fault@1", "코드", Values("""{"설비": "펌프"}""")), Ct);
        Assert.Equal(SuggestionMode.Abstain, suggestion!.Mode);
        Assert.Null(suggestion.Value);
    }

    [Fact]
    public async Task A_class_kept_from_an_earlier_launch_is_chosen_again_when_the_template_names_another_length()
    {
        var two = new VaultSnapshot([Fault(new Dictionary<string, int> { ["코드"] = 2 })], Faults());
        var chosen = await Suggestions.BuildAsync(two, Ct);
        await chosen.ApplyAsync(await chosen.SelectThresholdsAsync(Ct), Ct);
        Assert.NotNull(chosen.Report("fault@1", "코드")!.Coarse);

        var file = Path.GetTempFileName();
        try
        {
            ThresholdStore.Save(file, chosen.Thresholds);
            var kept = ThresholdStore.Load(file);
            Assert.False((await Suggestions.BuildAsync(two, Ct, kept)).NeedsSelection);

            // One character now names the class: a strength chosen for two is not one for it.
            var one = new VaultSnapshot([Fault(new Dictionary<string, int> { ["코드"] = 1 })], Faults());
            Assert.True((await Suggestions.BuildAsync(one, Ct, kept)).NeedsSelection);
            Assert.True((await Suggestions.BuildAsync(new VaultSnapshot([Fault(null)], Faults()), Ct, kept)).NeedsSelection);
        }
        finally
        {
            File.Delete(file);
        }
    }
}
