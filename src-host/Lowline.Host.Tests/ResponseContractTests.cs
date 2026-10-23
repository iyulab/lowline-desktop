using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Lowline.Host.Tests;

/// <summary>
/// What the sidecar answers the UI, as it goes over HTTP, written to <c>src/__tests__/sidecar-responses.json</c>:
/// the UI's own test reads that file and fails on a field its types do not know, or one they need that is not
/// there — the shell passes these answers through untouched, and the UI's types vanish at run time, so a renamed
/// field would otherwise read as empty. Numbers are written as 0: what is pinned is the shape and the words the UI
/// branches on, not what a replay happens to measure. A change here fails until the file is written again with
/// <c>LOWLINE_UPDATE_CONTRACT=1</c> — and then the UI's test says whether the UI still reads it.
/// </summary>
public sealed class ResponseContractTests
{
    private static readonly JsonSerializerOptions Written = new(JsonSerializerOptions.Web)
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly TemplateSnapshot Intake = Templates.Of("intake@1",
    [
        new TemplateField("요청", "textarea"),
        new TemplateField("부서", "select", Options: ["영업", "개발"]),
        new TemplateField("수량", "number"),
        new TemplateField("담당", "select", Options: ["장비", "총무"]),
        new TemplateField("긴급", "select", Options: ["높음", "낮음"]),
    ], Suggest: ["담당", "긴급"]);

    // Two requests name a monitor, one twice: searching for it, and for what is like the first, finds one best each
    // — documents that score the same come back in the order they were indexed, which is not what is pinned here.
    private static readonly Dictionary<int, string> Requests = new() { [2] = "모니터가 깜빡여요 모니터 교체", [3] = "모니터가 깜빡여요" };

    private static DocumentSnapshot Document(int i) => new($"문서/{i}.md", "intake@1",
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(
            $$"""{"요청": "{{Requests.GetValueOrDefault(i, $"노트북 배터리 {i}")}}", "부서": "영업", "수량": {{(i == 1 ? "\"여러 개\"" : "1")}}, "담당": "장비", "긴급": "{{(i % 2 == 0 ? "높음" : "낮음")}}"}""")!,
        Modified: i);

    // Fault codes the machine decides nine times in ten, with five fields of many values that say nothing about them:
    // the replay rests 고장 on 설비 and leaves most of them out, so a curve carries the fields its suggestions rest on.
    // (Of few values, their keys gain new codes so often that how readily they are believed already counts them out.) Picked, not typed: a field typed
    // into is counted while typing too, where the prefix decides more than 설비 and every field is kept.
    private static readonly string[] Noise = ["교대", "라인", "등급", "지역", "공정"];

    private static readonly TemplateSnapshot Faults = Templates.Of("faults@1",
        [.. Noise.Select(n => new TemplateField(n, "select")), new TemplateField("설비", "select"), new TemplateField("고장", "select")],
        Suggest: ["고장"]);

    private static IEnumerable<DocumentSnapshot> FaultReports()
    {
        var random = new Random(7);
        for (var i = 0; i < 300; i++)
        {
            var values = Noise.ToDictionary(n => n, n => (object)$"{n}{random.Next(20)}");
            var machine = random.Next(30);
            values["설비"] = $"설비{machine}";
            values["고장"] = random.NextDouble() < 0.9 ? $"F{machine:D2}" : $"F{random.Next(90):D2}";
            yield return new DocumentSnapshot($"고장/{i:D3}.md", "faults@1",
                JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(values))!, Modified: 100 + i);
        }
    }

    // 팀 leaves two people each, and their first characters differ: nothing is suggested before typing, a first character
    // typed is — so a curve carries how typing did.
    private static readonly TemplateSnapshot Handover = Templates.Of("handover@1",
        [new TemplateField("요청", "textarea"), new TemplateField("팀", "select", Options: ["가", "나"]), new TemplateField("담당자", "text")],
        Suggest: ["담당자"]);

    private static IEnumerable<DocumentSnapshot> Handovers()
    {
        string[][] people = [["가", "김철수"], ["나", "이민수"], ["가", "박영희"], ["나", "최지은"]];
        for (var i = 0; i < 60; i++)
        {
            var (team, person) = (people[i % 4][0], people[i % 4][1]);
            yield return new DocumentSnapshot($"인계/{i:D3}.md", "handover@1",
                JsonSerializer.Deserialize<Dictionary<string, JsonElement>>($$"""{"요청": "요청 {{i}}", "팀": "{{team}}", "담당자": "{{person}}"}""")!,
                Modified: 1000 + i);
        }
    }

    // Each 장비 has five codes of one chapter, and the template names the chapter: the code is never suggested before
    // typing and its chapter always is — so a curve carries how the class did.
    private static readonly TemplateSnapshot Chapters = Templates.Of("chapters@1",
        [new TemplateField("장비", "text"), new TemplateField("코드", "text")],
        Suggest: ["코드"], Coarse: new Dictionary<string, int> { ["코드"] = 2 });

    private static IEnumerable<DocumentSnapshot> ChapterReports()
    {
        string[][] units = [["압축기", "21"], ["펌프", "32"], ["밸브", "52"]];
        for (var i = 0; i < 60; i++)
        {
            var (unit, chapter) = (units[i % 3][0], units[i % 3][1]);
            yield return new DocumentSnapshot($"장/{i:D3}.md", "chapters@1",
                JsonSerializer.Deserialize<Dictionary<string, JsonElement>>($$"""{"장비": "{{unit}}", "코드": "{{chapter}}{{i / 3 % 5:D2}}"}""")!,
                Modified: 2000 + i);
        }
    }

    // Every request is worded once, so no value settled alongside ever repeats, but its words say which kind it is: only
    // similar documents answer 분류, and well over enough times for it to be offered — so a curve carries how they did.
    private static readonly TemplateSnapshot Kinds = Templates.Of("kinds@1",
        [new TemplateField("내용", "textarea"), new TemplateField("분류", "select", Options: ["인쇄", "화면", "연결"])],
        Suggest: ["분류"]);

    private static IEnumerable<DocumentSnapshot> KindRequests()
    {
        string[][] kinds = [["인쇄", "프린터 용지 걸림"], ["화면", "모니터 화면 깜빡임"], ["연결", "네트워크 연결 끊김"]];
        for (var i = 0; i < 120; i++)
        {
            var (kind, words) = (kinds[i % 3][0], kinds[i % 3][1]);
            yield return new DocumentSnapshot($"분류/{i:D3}.md", "kinds@1",
                JsonSerializer.Deserialize<Dictionary<string, JsonElement>>($$"""{"내용": "{{words}} {{i}}번째", "분류": "{{kind}}"}""")!,
                Modified: 3000 + i);
        }
    }

    private static SuggestionEvent Event(int minute, string kind) =>
        new($"2026-10-03T10:{minute:00}:00.000Z", "문서/1.md", "담당", kind, "장비", "intake@1", "key");

    private static string FixturePath([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "src", "__tests__", "sidecar-responses.json"));

    [Fact]
    public async Task What_the_sidecar_answers_is_the_file_the_UI_checks_its_types_against()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var factory = new HostTests.Factory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", HostTests.Token);

        async Task<JsonNode> Post(string path, object body)
        {
            var response = await client.PostAsJsonAsync(path, body, JsonSerializerOptions.Web, ct);
            response.EnsureSuccessStatusCode();
            return JsonNode.Parse(await response.Content.ReadAsStringAsync(ct))!;
        }

        // The models on this computer are a stand-in whose fetch holds until let go, and whose recommended model will not start.
        var lmsupply = (LocalModelsTests.StandIn)factory.Services.GetRequiredService<ILocalGenerators>();
        lmsupply.Gate = new TaskCompletionSource();
        lmsupply.Fails["gguf:qwen3-default"] = new InvalidOperationException("llama-server exited");

        // The models offered once getting one ready reaches `phase`, after doing `then`.
        async Task<JsonNode> LocalView(string phase, Func<Task>? then = null)
        {
            if (then is not null) await then();
            for (var i = 0; ; i++)
            {
                var view = JsonNode.Parse(await client.GetStringAsync("/model/local", ct))!;
                if (view["progress"]!["phase"]!.GetValue<string>() == phase) return view;
                Assert.True(i < 500, $"getting a model ready never reached {phase}");
                await Task.Delay(10, ct);
            }
        }
        var idle = JsonNode.Parse(await client.GetStringAsync("/model/local", ct))!;
        var started = await Post("/model/local/prepare", new { model = "gguf:qwen3-balanced" });
        var getting = await LocalView("getting");
        var again = await Post("/model/local/prepare", new { model = "gguf:qwen3-balanced" });
        var ready = await LocalView("ready", then: () => { lmsupply.Gate!.SetResult(); return Task.CompletedTask; });
        var localChat = await Post("/chat/author", new { preset = "local", model = "gguf:qwen3-balanced", template = "# 접수", turns = new[] { new { role = "user", text = "칸을 넣어 줘" } } });
        var failed = await LocalView("failed", then: () => Post("/model/local/prepare", new { model = "gguf:qwen3-default" }));

        // Fifteen documents that settle 담당 by 부서 and split 긴급 evenly; one with a 수량 that is not a number, one
        // of a template the vault does not have, and a suggestion for 담당 turned down on the first document.
        var snapshot = new VaultSnapshot(
            [Intake, Faults, Handover, Chapters, Kinds],
            [.. Enumerable.Range(1, 15).Select(Document), .. FaultReports(), .. Handovers(), .. ChapterReports(), .. KindRequests(), new DocumentSnapshot("문서/옛.md", "gone@1", new Dictionary<string, JsonElement>())],
            [Event(0, "accept"), Event(1, "correct"), Event(2, "reject")]);
        var ingest = await Post("/vault/ingest", snapshot);
        await factory.Services.GetRequiredService<VaultProjection>().ThresholdsSelected.WaitAsync(ct);

        // Lists its models, and answers a chat with one reply.
        var (listingApp, listingUrl) = await ModelConnectionTests.StandIn(context => context.Request.Path.Value!.EndsWith("/models")
            ? context.Response.WriteAsJsonAsync(new { @object = "list", data = new[] { new { id = "qwen3-4b", @object = "model" } } })
            : context.Response.WriteAsJsonAsync(new
            {
                id = "c1",
                @object = "chat.completion",
                created = 0,
                model = "qwen3-4b",
                choices = new[] { new { index = 0, message = new { role = "assistant", content = "칸을 넣었습니다." }, finish_reason = "stop" } },
            }));
        await using var _listing = listingApp;
        var (refusingApp, refusingUrl) = await ModelConnectionTests.StandIn(async context =>
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsJsonAsync(new { error = new { message = "Incorrect API key provided" } });
        });
        await using var _refusing = refusingApp;

        var blankForm = Path.Combine(Directory.CreateTempSubdirectory().FullName, "신청서.pdf");
        File.WriteAllBytes(blankForm, SourceFilesTests.MinimalPdf("Requester name: ____"));

        var observed = new Dictionary<string, object> { ["부서"] = "영업" };
        var responses = new JsonObject
        {
            ["ingest"] = ingest,
            ["projection"] = await Post("/projection", new ProjectionQuery("intake@1", [new ColumnFilter("부서", "contains", "영업")])),
            ["curves"] = JsonNode.Parse(await client.GetStringAsync("/curves", ct)),
            ["suggestions"] = new JsonArray(
                await Post("/suggest", new { template = "intake@1", field = "담당", values = observed }),
                await Post("/suggest", new { template = "intake@1", field = "긴급", values = observed }),
                await Post("/suggest", new { template = "intake@1", field = "담당", values = observed, document = "문서/1.md" }),
                // Drawn to check it: the value it would be shown is held back.
                await Post("/suggest", new { template = "intake@1", field = "담당", values = observed, roll = 0 }),
                await Post("/suggest", new { template = "chapters@1", field = "코드", values = new Dictionary<string, object> { ["장비"] = "펌프" } }),
                await Post("/suggest", new { template = "kinds@1", field = "분류", values = new Dictionary<string, object> { ["내용"] = "모니터 화면 깜빡임 또" } })),
            ["search"] = await Post("/search", new CaseQuery("모니터", Max: 1)),
            ["similar"] = await Post("/similar", new SimilarQuery("문서/3.md", Max: 1)),
            // 담당 counted per 부서 value among the fifteen intake documents, each count with its first two documents — and
            // again with what their 수량 adds up to.
            ["aggregate"] = new JsonArray(
                await Post("/aggregate", new AggregateQuery("intake@1", ["부서"], Evidence: 2)),
                await Post("/aggregate", new AggregateQuery("intake@1", ["부서"], Evidence: 2, Sum: "수량"))),
            // A model endpoint on this computer that lists its models, and one that refuses the key: what a failed check
            // carries is the kind and the status, never the endpoint's words.
            ["probe"] = new JsonArray(
                await Post("/model/probe", new { preset = "custom", baseUrl = listingUrl }),
                await Post("/model/probe", new { preset = "custom", baseUrl = refusingUrl, apiKey = "sk-wrong" })),
            // A chat reply about a template, and one the endpoint refused the key for.
            ["chatAuthor"] = new JsonArray(
                await Post("/chat/author", new { preset = "custom", baseUrl = listingUrl, model = "qwen3-4b", template = "# 접수", turns = new[] { new { role = "user", text = "칸을 넣어 줘" } } }),
                await Post("/chat/author", new { preset = "custom", baseUrl = refusingUrl, apiKey = "sk-wrong", model = "qwen3-4b", template = "", turns = new[] { new { role = "user", text = "안녕" } } }),
                // And one on the model running on this computer.
                localChat),
            // Records read out of pasted text, and a key the endpoint refused: the same reply as the chat's.
            ["chatExtract"] = new JsonArray(
                await Post("/chat/extract", new { preset = "custom", baseUrl = listingUrl, model = "qwen3-4b", template = "# 접수", text = "김민수 님 요청" }),
                await Post("/chat/extract", new { preset = "custom", baseUrl = refusingUrl, apiKey = "sk-wrong", model = "qwen3-4b", template = "", text = "안녕" })),
            // A blank form read into Markdown; one of a kind not read, and one that is not there: the kind, never the parser's words.
            ["sourceFile"] = new JsonArray(
                await Post("/files/markdown", new { path = blankForm }),
                await Post("/files/markdown", new { path = Path.Combine(Path.GetTempPath(), "양식.txt") }),
                await Post("/files/markdown", new { path = Path.Combine(Path.GetTempPath(), "없는 양식.hwp") })),
            // The models on this computer — one here, one not — as getting the one not here ready goes: before, while it is
            // fetched, once it runs; and as the recommended one will not start. Asking to get one ready answers where that
            // stands: started, already on its way, or refused for a model not offered.
            ["localPrepare"] = new JsonArray(started, again, await Post("/model/local/prepare", new { model = "gguf:qwen3-fast" })),
            ["localModels"] = new JsonArray(idle, getting, ready, failed),
            // The words the UI branches on, every one the sidecar can send — not only those this vault happens to draw.
            ["words"] = new JsonObject
            {
                ["mode"] = Words(typeof(SuggestionMode)),
                ["reason"] = Words(typeof(Abstention)),
                ["whyNoReplay"] = Words(typeof(NoReplay), Abstention.BelowTarget),
                ["counting"] = Words(typeof(CountedOn)),
                ["probeFailure"] = Words(typeof(ModelFailure)),
                ["localPhase"] = Words(typeof(LocalPhase)),
                ["localGetting"] = Words(typeof(LocalGetting)),
                ["sourceFailure"] = Words(typeof(SourceFileFailure)),
            },
        };
        var written = Zeroed(responses)!.ToJsonString(Written).ReplaceLineEndings("\n") + "\n";

        // Written into the source tree; checked against the copy the build puts beside the tests.
        if (Environment.GetEnvironmentVariable("LOWLINE_UPDATE_CONTRACT") == "1")
        {
            File.WriteAllText(FixturePath(), written);
            return;
        }
        var path = Path.Combine(AppContext.BaseDirectory, "sidecar-responses.json");
        Assert.True(File.Exists(path), $"{path} is missing; write it with LOWLINE_UPDATE_CONTRACT=1");
        Assert.True(File.ReadAllText(path) == written,
            "The sidecar's answers changed. Write the file again with LOWLINE_UPDATE_CONTRACT=1, then run the UI's tests: " +
            "src/__tests__/response-contract.test.ts says whether the UI still reads them.");
    }

    private static JsonArray Words(Type of, params string[] more) =>
        [.. of.GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.IsLiteral).Select(f => (string)f.GetRawConstantValue()!)
            .Concat(more).Select(w => JsonValue.Create(w))];

    /// <summary>The same answers with every number 0.</summary>
    private static JsonNode? Zeroed(JsonNode? node) => node switch
    {
        JsonObject o => new JsonObject(o.Select(p => KeyValuePair.Create(p.Key, Zeroed(p.Value)))),
        JsonArray a => new JsonArray([.. a.Select(Zeroed)]),
        JsonValue v when v.GetValueKind() == JsonValueKind.Number => JsonValue.Create(0),
        _ => node?.DeepClone(),
    };
}
