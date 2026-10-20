using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Lowline.Host.Tests;

/// <summary>The chat that writes templates, against stand-ins on this computer — nothing leaves it.</summary>
public sealed class ChatAuthoringTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(20);

    /// <summary>The models on this computer, for requests that name an endpoint instead: never asked.</summary>
    private static readonly LocalModels NoLocal = new(new LocalModelsTests.StandIn());

    private const string Template = "---\nid: intake\nversion: 1\n---\n# 접수\n\n@요청: [textarea rows=3]\n";

    /// <summary>An OpenAI chat completion answering <paramref name="text"/>.</summary>
    private static object Completion(string text) => new
    {
        id = "c1",
        @object = "chat.completion",
        created = 0,
        model = "small-4b",
        choices = new[] { new { index = 0, message = new { role = "assistant", content = text }, finish_reason = "stop" } },
        usage = new { prompt_tokens = 1, completion_tokens = 1, total_tokens = 2 },
    };

    [Fact]
    public async Task Tells_the_model_the_rules_and_the_template_then_the_conversation_and_answers_its_reply()
    {
        JsonElement? asked = null;
        var (app, baseUrl) = await ModelConnectionTests.StandIn(async context =>
        {
            asked = await JsonSerializer.DeserializeAsync<JsonElement>(context.Request.Body, cancellationToken: Ct);
            await context.Response.WriteAsJsonAsync(Completion("처리 기한 칸을 넣었습니다."), Ct);
        });
        await using var _ = app;

        var reply = await ChatAuthoring.ReplyAsync(
            new ChatAuthorRequest("custom", baseUrl, null, "small-4b", Template, [new ChatTurn("user", "처리 기한 칸을 넣어 줘")]),
            NoLocal,
            Wait,
            Ct);

        Assert.Equal((true, "처리 기한 칸을 넣었습니다.", null), (reply.Ok, reply.Text, reply.Failure));
        var messages = asked!.Value.GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal(["system", "user"], messages.Select(m => m.GetProperty("role").GetString()));
        var system = messages[0].GetProperty("content").ToString();
        Assert.Contains("lowline:", system);
        Assert.Contains("@요청: [textarea rows=3]", system); // the template as it stands in the editor
        Assert.Equal("small-4b", asked.Value.GetProperty("model").GetString());
    }

    [Fact]
    public void Hands_the_model_a_blank_form_the_person_picked_after_the_rules_and_only_when_there_is_one()
    {
        var form = "| 일련번호 | 품명 | 청구량 |\n| :--- | :--- | :--- |\n| 1 | | |";
        Assert.DoesNotContain("빈 서식", ChatAuthoring.Instructions(Template));

        var told = ChatAuthoring.Instructions(Template, new ChatSource("물품청구서.hwp", form));

        Assert.Contains("«물품청구서.hwp»", told);
        Assert.Contains(form, told);
        Assert.True(told.IndexOf(form, StringComparison.Ordinal) > told.IndexOf("@요청: [textarea rows=3]", StringComparison.Ordinal),
            "the form comes after the template it is carried into");
        Assert.Contains("(인 또는 서명)", told); // a signature box is no field: it is signed on paper
    }

    [Fact]
    public async Task Says_a_key_was_refused_without_the_providers_own_words()
    {
        var (app, baseUrl) = await ModelConnectionTests.StandIn(async context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = new { message = "Incorrect API key provided: sk-wrong" } }, Ct);
        });
        await using var _ = app;

        var reply = await ChatAuthoring.ReplyAsync(
            new ChatAuthorRequest("custom", baseUrl, "sk-wrong", "small-4b", Template, [new ChatTurn("user", "안녕")]), NoLocal, Wait, Ct);

        Assert.Equal((false, null, ModelFailure.Unauthorized), (reply.Ok, reply.Text, reply.Failure));
    }

    [Fact]
    public async Task Says_nothing_listens_where_the_address_points()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();

        var reply = await ChatAuthoring.ReplyAsync(
            new ChatAuthorRequest("custom", $"http://127.0.0.1:{port}/v1", null, "small-4b", Template, [new ChatTurn("user", "안녕")]), NoLocal, Wait, Ct);

        Assert.False(reply.Ok);
        Assert.Contains(reply.Failure, new[] { ModelFailure.Refused, ModelFailure.Unreachable, ModelFailure.Timeout, ModelFailure.Transport });
    }

    [Theory]
    [InlineData("nope", "http://127.0.0.1:1/v1", "m")] // no such preset
    [InlineData("custom", null, "m")] // a custom endpoint has no address of its own
    [InlineData("custom", "http://127.0.0.1:1/v1", " ")] // no model chosen
    public async Task Contacts_nothing_for_what_cannot_be_used(string preset, string? baseUrl, string model)
    {
        var reply = await ChatAuthoring.ReplyAsync(new ChatAuthorRequest(preset, baseUrl, null, model, Template, [new ChatTurn("user", "안녕")]), NoLocal, Wait, Ct);

        Assert.Equal((false, ModelFailure.Invalid), (reply.Ok, reply.Failure));
    }
}
