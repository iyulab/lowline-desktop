using System.Text.Json;

namespace Lowline.Host.Tests;

public sealed class CurvesTests
{
    private static readonly TemplateSnapshot Intake = Templates.Of("intake@1",
    [
        new TemplateField("요청", "textarea"),
        new TemplateField("부서", "text"),
        new TemplateField("담당", "select"),
        new TemplateField("긴급", "select"),
    ], Suggest: ["담당", "긴급"]);

    private static DocumentSnapshot Document(string path) =>
        new(path, "intake@1", new Dictionary<string, JsonElement>());

    private static SuggestionEvent Event(int minute, string doc, string field, string kind, string? template = null, string? source = null) =>
        new($"2026-09-29T10:{minute:00}:00.000Z", doc, field, kind, "장비", template, source);

    [Fact]
    public void Counts_each_source_of_suggestions_apart_so_each_can_be_read_against_its_promise()
    {
        var events = new List<SuggestionEvent>
        {
            Event(0, "문서/1.md", "담당", "accept", source: "key"),
            Event(1, "문서/1.md", "담당", "accept", source: "key"),
            Event(2, "문서/1.md", "담당", "accept", source: "memory"),
            Event(3, "문서/1.md", "담당", "correct", source: "memory"),
            Event(4, "문서/1.md", "담당", "reject", source: "memory"),
            // Recorded before the source was handed over: in the totals, under no source.
            Event(5, "문서/1.md", "담당", "accept"),
        };

        var curve = Curves.Compute(new VaultSnapshot([Intake], [Document("문서/1.md")], events)).Single(c => c.Field == "담당");

        Assert.Equal((4, 1, 1), (curve.Accepted, curve.Corrected, curve.Rejected));
        Assert.Equal([("key", 2, 2), ("memory", 3, 1)], curve.BySource!.Select(s => (s.Source, s.Decided, s.Accepted)));
    }

    [Fact]
    public void Counts_what_people_did_with_values_another_program_proposed_apart_from_the_curve()
    {
        var events = new List<SuggestionEvent>
        {
            Event(0, "문서/1.md", "담당", "accept", source: "key"),
            Event(1, "문서/1.md", "담당", "reject", source: "proposed"),
            Event(2, "문서/1.md", "담당", "reject", source: "proposed"),
        };

        var curve = Curves.Compute(new VaultSnapshot([Intake], [Document("문서/1.md")], events)).Single(c => c.Field == "담당");

        Assert.Equal((1, 0, 0), (curve.Accepted, curve.Corrected, curve.Rejected));
        Assert.Equal([1.0], curve.Points.Select(p => p.Rate));
        Assert.Equal([("key", 1, 1), ("proposed", 2, 0)], curve.BySource!.Select(s => (s.Source, s.Decided, s.Accepted)));
    }

    [Fact]
    public void Takes_each_rate_over_the_latest_decisions_in_order()
    {
        var kinds = new[] { "reject", "correct", "accept", "accept" };
        var events = kinds.Select((k, i) => Event(i, "문서/1.md", "담당", k)).Reverse().ToList();

        var curve = Curves.Compute(new VaultSnapshot([Intake], [Document("문서/1.md")], events)).Single(c => c.Field == "담당");

        Assert.Equal(("intake@1", "담당", 2, 1, 1), (curve.Template, curve.Field, curve.Accepted, curve.Corrected, curve.Rejected));
        Assert.Equal([0.0, 0.0, 1 / 3.0, 0.5], curve.Points.Select(p => p.Rate));
        Assert.Equal([1, 2, 3, 4], curve.Points.Select(p => p.N));
    }

    [Fact]
    public void Forgets_decisions_older_than_the_window()
    {
        var events = Enumerable.Range(0, Curves.Window)
            .Select(i => Event(i, "문서/1.md", "담당", "reject"))
            .Append(Event(Curves.Window, "문서/1.md", "담당", "accept"))
            .Append(Event(Curves.Window + 1, "문서/1.md", "담당", "accept"))
            .ToList();

        var curve = Curves.Compute(new VaultSnapshot([Intake], [Document("문서/1.md")], events)).Single(c => c.Field == "담당");

        Assert.Equal(2.0 / Curves.Window, curve.Points[^1].Rate, 6);
    }

    [Fact]
    public void Places_an_event_by_its_template_even_when_its_document_is_gone_and_ignores_other_fields()
    {
        var events = new List<SuggestionEvent>
        {
            Event(0, "문서/옛이름.md", "담당", "accept", template: "intake@1"),
            Event(1, "문서/사라짐.md", "담당", "accept"),
            Event(2, "문서/1.md", "요청", "accept"),
            Event(3, "문서/1.md", "긴급", "correct"),
        };

        var curves = Curves.Compute(new VaultSnapshot([Intake], [Document("문서/1.md")], events));

        Assert.Equal([("담당", 1), ("긴급", 1)], curves.Select(c => (c.Field, c.Points.Count)));
    }

    [Fact]
    public void Lists_every_judgment_field_even_before_any_decision_about_it()
    {
        // Documents imported or saved without a suggestion shown: nothing decided yet, and each field still listed
        // — its replay is what there is to show until the first decision.
        var curves = Curves.Compute(new VaultSnapshot([Intake], [Document("문서/1.md")], []));

        Assert.Equal([("담당", 0), ("긴급", 0)], curves.Select(c => (c.Field, c.Points.Count)));
        Assert.All(curves, c => Assert.Equal((0, 0, 0), (c.Accepted, c.Corrected, c.Rejected)));
    }

    [Fact]
    public async Task Says_why_a_field_has_no_replay_while_its_history_is_short()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot([Intake], [Document("문서/1.md")], []), ct);

        var curve = (await vault.CurvesAsync(ct)).Single(c => c.Field == "담당");

        Assert.Null(curve.Replay);
        Assert.Equal(NoReplay.Few, curve.WhyNoReplay);
    }

    [Fact]
    public async Task Carries_how_the_fields_history_did_on_replay_once_its_threshold_is_chosen()
    {
        var ct = TestContext.Current.CancellationToken;
        var documents = Enumerable.Range(1, 15).Select(i => new DocumentSnapshot($"문서/{i}.md", "intake@1",
            JsonSerializer.Deserialize<Dictionary<string, JsonElement>>($$"""{"요청": "노트북 배터리 문제 {{i}}", "부서": "영업", "담당": "장비"}""")!,
            Modified: i)).ToList();
        await using var vault = new VaultProjection();
        // Saved or imported, with no suggestion decided yet: the replay is there before the first decision.
        await vault.IngestAsync(new VaultSnapshot([Intake], documents, []), ct);
        await vault.ThresholdsSelected.WaitAsync(ct);

        var curve = (await vault.CurvesAsync(ct)).Single(c => c.Field == "담당");
        Assert.Empty(curve.Points);
        var replay = curve.Replay;

        Assert.NotNull(replay);
        Assert.Null(curve.WhyNoReplay);
        Assert.Equal(14, replay.Lookups); // every document but the first is asked of the ones before it
        Assert.InRange(replay.AnswerRate, 0, 1);
        Assert.True(replay.Precision >= Suggestions.TargetPrecision);
    }
}
