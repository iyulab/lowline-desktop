using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Lowline.Host;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Lowline.Host.Tests;

public sealed class HostTests : IClassFixture<HostTests.Factory>
{
    public const string Token = "test-token-of-the-length-a-launch-makes";

    public sealed class Factory : WebApplicationFactory<Program>
    {
        // As the shell calls it: by this computer's address and the port the request comes in on (none in a test host).
        public Factory() => ClientOptions.BaseAddress = new Uri("http://127.0.0.1:0");

        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder) =>
            builder.UseSetting(HostAuth.TokenVariable, Token)
                // Models on this computer are stand-ins: a test host fetches and starts nothing.
                .ConfigureTestServices(services => services.AddSingleton<ILocalGenerators, LocalModelsTests.StandIn>());
    }

    private readonly Factory _factory;

    public HostTests(Factory factory) => _factory = factory;

    private HttpClient Client(string? token)
    {
        var client = _factory.CreateClient();
        if (token is not null)
        {
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        return client;
    }

    [Fact]
    public async Task Health_answers_with_the_token()
    {
        var health = await Client(Token).GetFromJsonAsync<Health>("/health", TestContext.Current.CancellationToken);
        Assert.Equal(new Health("ok", VaultIndexed: false, MemoryReady: false), health);
    }

    [Fact]
    public async Task Ingests_a_vault_and_serves_its_table_over_http()
    {
        // Its own host: ingesting changes state the other tests read.
        await using var factory = new Factory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var ingest = await client.PostAsync("/vault/ingest?vault=D%3A%2F%EB%B3%BC%ED%8A%B8", new StringContent("""
            {"templates": [{"ref": "bug-report@1", "fields": [{"name": "제목", "type": "text"}, {"name": "재현됨", "type": "checkbox"}], "schema": {"제목": {"type": "text"}, "재현됨": {"type": "checkbox"}}}],
             "documents": [{"path": "문서/a.md", "template": "bug-report@1", "values": {"제목": "멈춤", "재현됨": true}}]}
            """, System.Text.Encoding.UTF8, "application/json"), TestContext.Current.CancellationToken);
        ingest.EnsureSuccessStatusCode();
        Assert.Equal("""{"appended":1,"retired":0,"projections":["bug-report@1"],"skipped":[],"skippedFields":[]}""",
            await ingest.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));

        var response = await client.PostAsJsonAsync("/projection", new { template = "bug-report@1" }, TestContext.Current.CancellationToken);
        var table = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Equal(
            """{"template":"bug-report@1","columns":[{"name":"제목","type":"text"},{"name":"재현됨","type":"checkbox"}],"rows":[{"path":"문서/a.md","values":{"제목":"멈춤","재현됨":true}}]}""",
            System.Text.RegularExpressions.Regex.Unescape(table));

        var health = await client.GetFromJsonAsync<Health>("/health", TestContext.Current.CancellationToken);
        Assert.True(health!.VaultIndexed);
        Assert.Equal(HttpStatusCode.NotFound,
            (await client.PostAsJsonAsync("/projection", new { template = "none@1" }, TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task Searches_the_vault_text_and_finds_similar_documents_over_http()
    {
        await using var factory = new Factory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var ct = TestContext.Current.CancellationToken;
        (await client.PostAsync("/vault/ingest", new StringContent("""
            {"templates": [{"ref": "intake@1", "fields": [{"name": "요청", "type": "text"}], "schema": {"요청": {"type": "text"}}}],
             "documents": [{"path": "문서/a.md", "template": "intake@1", "values": {"요청": "노트북 배터리가 금방 닳아요"}},
                           {"path": "문서/b.md", "template": "intake@1", "values": {"요청": "노트북 배터리가 부풀었어요"}},
                           {"path": "문서/c.md", "template": "intake@1", "values": {"요청": "휴가를 쓰고 싶어요"}}]}
            """, System.Text.Encoding.UTF8, "application/json"), ct)).EnsureSuccessStatusCode();

        var found = await (await client.PostAsJsonAsync("/search", new { query = "휴가" }, ct)).Content.ReadFromJsonAsync<CaseHit[]>(ct);
        Assert.Equal(["문서/c.md"], found!.Select(h => h.Path));
        var similar = await (await client.PostAsJsonAsync("/similar", new { path = "문서/a.md" }, ct)).Content.ReadFromJsonAsync<CaseHit[]>(ct);
        Assert.Equal("문서/b.md", similar![0].Path);
        Assert.DoesNotContain(similar, h => h.Path == "문서/a.md");
    }

    [Fact]
    public async Task Hands_over_failures_away_from_requests_once_asked()
    {
        await using var factory = new Factory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var ct = TestContext.Current.CancellationToken;
        factory.Services.GetRequiredService<HostFailures>().Record(new TimeoutException());

        var first = await client.PostAsync("/failures/take", null, ct);
        var again = await client.PostAsync("/failures/take", null, ct);

        Assert.Equal("[{\"type\":\"System.TimeoutException\",\"at\":null,\"frames\":[]}]", await first.Content.ReadAsStringAsync(ct));
        Assert.Equal("[]", await again.Content.ReadAsStringAsync(ct));
    }

    [Fact]
    public async Task A_failed_request_answers_with_what_failed_but_not_with_what()
    {
        await using var factory = new Factory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var ct = TestContext.Current.CancellationToken;
        // A template with no reference cannot be a form type.
        var ingest = await client.PostAsync("/vault/ingest", new StringContent("""
            {"templates": [{"ref": "", "fields": [{"name": "요청", "type": "text"}]}],
             "documents": [{"path": "문서/회의록.md", "template": "", "values": {"요청": "노트북 배터리"}}]}
            """, System.Text.Encoding.UTF8, "application/json"), ct);

        Assert.Equal(HttpStatusCode.InternalServerError, ingest.StatusCode);
        var body = await ingest.Content.ReadAsStringAsync(ct);
        var failure = System.Text.Json.JsonSerializer.Deserialize<TauriKit.Sidecar.Loopback.FaultProblem>(body, System.Text.Json.JsonSerializerOptions.Web)!.Fault;
        Assert.False(string.IsNullOrEmpty(failure.Type));
        Assert.Contains(failure.Frames, f => f.StartsWith("Lowline.Host.", StringComparison.Ordinal));
        Assert.DoesNotContain("회의록", body);
        Assert.DoesNotContain("노트북", body);
    }

    [Fact]
    public async Task Reads_a_document_marked_conflicted_over_http()
    {
        await using var factory = new Factory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var ct = TestContext.Current.CancellationToken;
        var ingest = await client.PostAsync("/vault/ingest", new StringContent("""
            {"templates": [{"ref": "intake@1", "fields": [{"name": "요청", "type": "textarea"}, {"name": "담당", "type": "select"}], "suggest": ["담당"], "schema": {"요청": {"type": "textarea"}, "담당": {"type": "select"}}}],
             "documents": [{"path": "문서/a.md", "template": "intake@1", "values": {"요청": "노트북 배터리가 금방 닳아요", "담당": "장비"}, "conflicted": true}]}
            """, System.Text.Encoding.UTF8, "application/json"), ct);
        ingest.EnsureSuccessStatusCode();

        var suggestion = await client.PostAsJsonAsync("/suggest",
            new { template = "intake@1", field = "담당", values = new { 요청 = "노트북 배터리가 금방 닳아요!" } }, ct);

        Assert.Equal(new Suggestion(null, "abstain", null, Abstention.NoHistory), await suggestion.Content.ReadFromJsonAsync<Suggestion>(ct));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("wrong")]
    [InlineData("test-token-of-the-length-a-launch-makes-and-more")]
    public async Task Every_request_without_the_token_is_refused(string? token)
    {
        var response = await Client(token).GetAsync("/health", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Unknown_paths_are_refused_before_routing_without_the_token()
    {
        var response = await Client(null).GetAsync("/nothing-here", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task A_request_naming_another_host_is_refused_even_with_the_token()
    {
        // A web page whose own name was pointed at 127.0.0.1 reaches the port but sends its own name.
        var client = Client(Token);
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Host = "pointed-here.example:0";
        var response = await client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
