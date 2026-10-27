using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lowline.Host.Tests;

/// <summary>
/// The vault as the UI hands it over (<c>ui-snapshot.json</c>) and the questions it asks (<c>ui-requests.json</c>, the
/// body of each, by the shell command that hands it on), both written by the UI's own test from its real functions:
/// every field in them is either read here or left out on purpose, said below with why. A field
/// the UI starts to send fails here until it is one or the other — the sidecar once read a choice field
/// without its options, and so suggested values the template no longer offered.
/// </summary>
public sealed class SnapshotContractTests
{
    /// <summary>What the UI sends that the sidecar has no use for, by the kind of object it is in.</summary>
    private static readonly Dictionary<Type, Dictionary<string, string>> LeftOut = new()
    {
        [typeof(TemplateField)] = new()
        {
            ["label"] = "what the form shows; the table and suggestions go by the field's name",
            ["optionLabels"] = "what the form shows for an option; suggestions go by the option's value",
        },
        [typeof(DocumentSnapshot)] = new()
        {
            ["outside"] = "whether the app has ever saved the document, for the person to see on the learning screen; learned from all the same",
        },
        [typeof(SuggestionEvent)] = new()
        {
            ["value"] = "what was saved is read from the document itself",
            ["recall"] = "which values a suggestion rested on, for the person; not learned from",
            ["similarity"] = "kept in the event format, always empty since similar records stopped being suggested",
            ["filled"] = "the fill order, for studying the curves; not learned from",
            ["decidedAt"] = "timing, for studying the curves; not learned from",
            ["typed"] = "the characters typed when the suggestion was shown, for studying the curves; not learned from",
            ["decidedTyped"] = "the characters in the field when the suggestion was taken or rejected, for studying the curves; not learned from",
        },
    };

    /// <summary>The body each shell command hands the sidecar, and what the sidecar reads it as.</summary>
    private static readonly Dictionary<string, Type> Questions = new()
    {
        ["host_suggest"] = typeof(SuggestRequest),
        ["host_search"] = typeof(CaseQuery),
        ["host_similar"] = typeof(SimilarQuery),
        ["host_projection"] = typeof(ProjectionQuery),
    };

    private static JsonObject Read(string file) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, file)))!.AsObject();

    private static JsonObject Sent() => Read("ui-snapshot.json");

    private static JsonObject Asked() => Read("ui-requests.json");

    [Fact]
    public void Every_field_the_UI_sends_is_read_or_left_out_on_purpose()
    {
        var sent = Sent();
        var unread = new List<string>();
        void Check(JsonNode? node, Type type, string where)
        {
            if (node is not JsonObject json) return;
            var read = type.GetConstructors().Single().GetParameters().Select(p => p.Name!).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var leftOut = LeftOut.GetValueOrDefault(type) ?? [];
            foreach (var (name, _) in json)
                if (!read.Contains(name) && !leftOut.ContainsKey(name)) unread.Add($"{where}.{name}");
        }

        Check(sent, typeof(VaultSnapshot), "vault");
        foreach (var template in sent["templates"]!.AsArray())
        {
            Check(template, typeof(TemplateSnapshot), "template");
            foreach (var field in template!["fields"]!.AsArray())
            {
                Check(field, typeof(TemplateField), "field");
                Check(field!["suggest"], typeof(FieldSuggestion), "field.suggest");
            }
        }
        foreach (var document in sent["documents"]!.AsArray()) Check(document, typeof(DocumentSnapshot), "document");
        foreach (var e in sent["events"]!.AsArray()) Check(e, typeof(SuggestionEvent), "event");

        var asked = Asked();
        Assert.Equal(Questions.Keys.Order(), asked.Select(q => q.Key).Order());
        foreach (var (command, body) in asked)
        {
            Check(body, Questions[command], command);
            // A suggestion's values are the document's, by field name: they are read whole.
            if (body!["filters"] is JsonArray filters)
                foreach (var filter in filters) Check(filter, typeof(ColumnFilter), $"{command}.filter");
        }

        Assert.Empty(unread);
    }

    [Fact]
    public void Nothing_left_out_on_purpose_is_read_after_all()
    {
        foreach (var (type, leftOut) in LeftOut)
        {
            var read = type.GetConstructors().Single().GetParameters().Select(p => p.Name!).ToList();
            foreach (var name in leftOut.Keys)
                Assert.DoesNotContain(read, r => string.Equals(r, name, StringComparison.OrdinalIgnoreCase));
        }
    }

    [Fact]
    public void The_sidecar_reads_it_as_sent()
    {
        var vault = JsonSerializer.Deserialize<VaultSnapshot>(Sent().ToJsonString(), JsonSerializerOptions.Web)!;
        var template = Assert.Single(vault.Templates);
        Assert.Equal("intake@2", template.Ref);
        Assert.Equal(["담당"], template.Suggest);
        Assert.Equal(["장비", "총무"], template.Fields.Single(f => f.Name == "담당").Options);
        Assert.True(template.Fields.Single(f => f.Name == "태그").Multiple);
        Assert.Equal(new FieldSuggestion(Evidence: false), template.Fields.Single(f => f.Name == "요청").Suggest);
        var 담당 = template.Fields.Single(f => f.Name == "담당").Suggest!;
        Assert.Equal("confirm", 담당.Policy);
        Assert.Equal(["장비"], 담당.MustCatch!);
        Assert.Equal("부서", template.Fields.Single(f => f.Name == "태그").Suggest!.Parent);
        // The engine's form says each of them: a judgment field confirmed and never to miss 장비, 요청 no clue, 태그 under 부서.
        var form = JsonNode.Parse(Suggestions.Definition(template))!["form"]!["fields"]!.AsArray().ToDictionary(f => f!["name"]!.GetValue<string>());
        Assert.Equal("confirm", form["담당"]!["policy"]!.GetValue<string>());
        Assert.Equal("장비", Assert.Single(form["담당"]!["mustCatch"]!.AsArray())!.GetValue<string>());
        Assert.False(form["요청"]!["evidence"]!.GetValue<bool>());
        Assert.Equal("부서", form["태그"]!["parent"]!.GetValue<string>());
        using var engine = global::Lowline.LowlineEngine.Create(Suggestions.Definition(template));
        var document = Assert.Single(vault.Documents);
        Assert.Equal(("doc-1", "intake@2", 1_790_000_000_000L, true), (document.Identity, document.Template, document.Modified, document.Conflicted));
        Assert.Equal("sales", document.Values["부서"].GetString());
        Assert.Equal(2, vault.Events!.Count);
        var e = vault.Events[0];
        Assert.Equal(("doc-1", "담당", "accept", "장비", "intake@2", "key"), (e.Doc, e.Field, e.Kind, e.Suggested, e.Template, e.Source));
        // A value entered while its suggestion was held back: the value held back, and the chance it was drawn with.
        var check = vault.Events[1];
        Assert.Equal(("고객", SuggestionMode.Check, "customer-2", 0.05), (check.Field, check.Kind, check.Suggested, check.Probability));
    }

    [Fact]
    public void The_sidecar_reads_each_question_as_asked()
    {
        var asked = Asked();
        T Body<T>(string command) => JsonSerializer.Deserialize<T>(asked[command]!.ToJsonString(), JsonSerializerOptions.Web)!;

        var suggest = Body<SuggestRequest>("host_suggest");
        // The saved document it is asked for: a suggestion turned down there is not offered again.
        Assert.Equal(("intake@2", "담당", "doc-1"), (suggest.Template, suggest.Field, suggest.Document));
        Assert.Equal("sales", suggest.Values["부서"].GetString());
        // What has been typed into the field so far: the field stays open, narrowed to values that begin with it.
        Assert.Equal("장", suggest.Typed);
        // The roll drawn for the field before any answer was seen: below the rate, the value is held back to check it.
        Assert.Equal(0.5, suggest.Roll);
        Assert.Equal(("모니터", "intake@2"), (Body<CaseQuery>("host_search").Query, Body<CaseQuery>("host_search").Template));
        Assert.Equal("문서/2026-10-03-모니터.md", Body<SimilarQuery>("host_similar").Path);
        var projection = Body<ProjectionQuery>("host_projection");
        Assert.Equal("intake@2", projection.Template);
        Assert.Equal(new ColumnFilter("부서", "contains", "sales"), Assert.Single(projection.Filters!));
    }
}
