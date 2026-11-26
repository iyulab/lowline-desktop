using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lowline.Host.Tests;

public sealed class WeeklyCountsTests
{
    /// <summary>
    /// Cases with the counts the app's own counting gave before it moved here (in one time zone, as the device's): the
    /// same snapshot and presentations count the same, key for key.
    /// </summary>
    public static TheoryData<string> Cases() => [.. Fixture()["cases"]!.AsArray().Select(c => c!["name"]!.GetValue<string>())];

    private static JsonObject Fixture() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "weekly-counts-cases.json")))!.AsObject();

    [Theory]
    [MemberData(nameof(Cases))]
    public void Counts_as_the_app_counted(string name)
    {
        var fixture = Fixture();
        var zone = TimeZoneInfo.FindSystemTimeZoneById(fixture["timeZone"]!.GetValue<string>());
        var found = fixture["cases"]!.AsArray().Single(c => c!["name"]!.GetValue<string>() == name)!;
        var snapshot = found["snapshot"].Deserialize<VaultSnapshot>(JsonSerializerOptions.Web)!;
        var presentations = found["presentations"].Deserialize<List<Presentation>>(JsonSerializerOptions.Web)!;

        var report = WeeklyCounts.Compute(snapshot, presentations, zone);

        var counted = JsonSerializer.SerializeToNode(report.Export, JsonSerializerOptions.Web);
        Assert.True(JsonNode.DeepEquals(found["expected"], counted), $"expected {found["expected"]!.ToJsonString()}\n counted {counted!.ToJsonString()}");
    }

    /// <summary>
    /// For the app's replay (<c>src/__tests__/replay.test.ts</c>): counts the vault and presentations in the file
    /// <c>LOWLINE_WEEKLY_COUNTS_IN</c> names (<c>{ snapshot, presentations }</c>) in this computer's time, as the app's
    /// learning screen would, and writes the report to <c>LOWLINE_WEEKLY_COUNTS_OUT</c>.
    /// </summary>
    [Fact]
    public void Counts_a_vault_written_to_a_file()
    {
        var input = Environment.GetEnvironmentVariable("LOWLINE_WEEKLY_COUNTS_IN");
        Assert.SkipWhen(string.IsNullOrEmpty(input), "set LOWLINE_WEEKLY_COUNTS_IN to count a vault written to a file");
        var asked = JsonNode.Parse(File.ReadAllText(input))!;
        var report = WeeklyCounts.Compute(
            asked["snapshot"].Deserialize<VaultSnapshot>(JsonSerializerOptions.Web)!,
            asked["presentations"].Deserialize<List<Presentation>>(JsonSerializerOptions.Web) ?? [],
            TimeZoneInfo.Local);
        File.WriteAllText(Environment.GetEnvironmentVariable("LOWLINE_WEEKLY_COUNTS_OUT")!, JsonSerializer.Serialize(report, JsonSerializerOptions.Web));
    }

    [Fact]
    public void Numbers_the_forms_with_judgment_fields_in_the_order_of_their_references()
    {
        TemplateSnapshot Form(string reference, params string[] suggest) => Templates.Of(reference, [new TemplateField("요청", "text")], Suggest: suggest);
        var report = WeeklyCounts.Compute(new VaultSnapshot([Form("note@1"), Form("intake@1", "담당"), Form("bug@2", "원인"), Form("Zeta@1", "칸")], []), [], TimeZoneInfo.Utc);

        // Ordinal: an upper-case letter sorts before every lower-case one, whatever the culture.
        Assert.Equal(["Zeta@1", "bug@2", "intake@1"], report.FormRefs);
        Assert.Equal([1, 2, 3], report.Export.Forms.Select(f => f.Form));
    }

    [Fact]
    public void Writes_the_week_in_the_time_of_the_device()
    {
        var mondayMorningInSeoul = DateTimeOffset.Parse("2026-10-04T23:30:00Z"); // still Sunday in UTC
        Assert.Equal("2026-10-05", WeeklyCounts.WeekOf(mondayMorningInSeoul, TimeZoneInfo.FindSystemTimeZoneById("Asia/Seoul")));
        Assert.Equal("2026-09-28", WeeklyCounts.WeekOf(mondayMorningInSeoul, TimeZoneInfo.Utc));
    }

    [Fact]
    public void Reads_the_day_a_file_is_named_by_if_it_is_one()
    {
        var zone = TimeZoneInfo.Utc;
        Assert.Equal(new DateTimeOffset(2026, 10, 13, 0, 0, 0, TimeSpan.Zero), WeeklyCounts.NamedDay("문서/2026-10-13-문의.md", zone));
        Assert.NotNull(WeeklyCounts.NamedDay("2026-10-13.md", zone));
        Assert.NotNull(WeeklyCounts.NamedDay("문서/2026-10-13 (1).md", zone));
        Assert.Null(WeeklyCounts.NamedDay("문서/2026-02-30-문의.md", zone)); // no such day
        Assert.Null(WeeklyCounts.NamedDay("문서/20261013-문의.md", zone));
        Assert.Null(WeeklyCounts.NamedDay("문서/2026-10-130.md", zone));
        Assert.Null(WeeklyCounts.NamedDay("2026-10-13/문의.md", zone)); // a folder's name is not the file's
        Assert.Null(WeeklyCounts.NamedDay("문서/٢٠٢٦-10-13-문의.md", zone)); // digits of another script are not a day
    }

    [Fact]
    public void Puts_a_time_in_the_span_whose_edge_it_reached() =>
        Assert.Equal([0, 0, 1, 2, 3, 6, 7, 7], new[] { 0, 0.49, 0.5, 1.99, 2, 31.9, 32, 3600 }.Select(WeeklyCounts.DwellSpan));

    [Fact]
    public void Carries_no_name_value_or_path()
    {
        var found = Fixture()["cases"]!.AsArray().Single(c => c!["name"]!.GetValue<string>() == "presentations")!;
        var snapshot = found["snapshot"].Deserialize<VaultSnapshot>(JsonSerializerOptions.Web)!;
        var presentations = found["presentations"].Deserialize<List<Presentation>>(JsonSerializerOptions.Web)!;
        var text = JsonSerializer.Serialize(WeeklyCounts.Compute(snapshot, presentations, TimeZoneInfo.Utc).Export, JsonSerializerOptions.Web);
        foreach (var secret in new[] { "intake", "bug", "담당", "긴급", "장비", "비밀", "환자", "문서", ".md" }) Assert.DoesNotContain(secret, text);
    }
}
