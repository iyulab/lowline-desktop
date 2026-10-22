using System.Runtime.CompilerServices;
using LMSupply;
using LMSupply.Exceptions;
using LMSupply.Generator.Abstractions;
using LMSupply.Generator.Models;

namespace Lowline.Host.Tests;

/// <summary>The model running on this computer for the chat, against stand-ins for LMSupply — nothing is fetched or started.</summary>
public sealed class LocalModelsTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Recommended = "gguf:qwen3-default";
    private const string Larger = "gguf:qwen3-balanced";

    /// <summary>
    /// LMSupply as a test sees it: which models are here, what each load was allowed to fetch, which loads fail, and
    /// models that answer every chat with <see cref="Reply"/>.
    /// </summary>
    public sealed class StandIn : ILocalGenerators
    {
        public HashSet<string> Here { get; } = [Recommended];
        public List<(string Model, bool MayFetch)> Loads { get; } = [];
        public Dictionary<string, Exception> Fails { get; } = [];
        public List<Generator> Loaded { get; } = [];
        public int Releases { get; private set; }
        public string Reply { get; set; } = "칸을 넣었습니다.";

        /// <summary>When set, a fetch holds after its first progress report until it completes.</summary>
        public TaskCompletionSource? Gate { get; set; }

        public Task<bool> IsDownloadedAsync(string model, CancellationToken cancellationToken) => Task.FromResult(Here.Contains(model));

        public async Task<ITextGenerator> LoadAsync(string model, bool mayFetch, IProgress<DownloadProgress> progress, CancellationToken cancellationToken)
        {
            Loads.Add((model, mayFetch));
            if (Fails.TryGetValue(model, out var failure)) throw failure;
            if (!Here.Contains(model))
            {
                if (!mayFetch) throw new ModelNotFoundException($"{model} is not cached", model);
                progress.Report(new DownloadProgress { FileName = "model.gguf", BytesDownloaded = 5, TotalBytes = 10, Kind = DownloadKind.Model });
                if (Gate is { } gate) await gate.Task.WaitAsync(cancellationToken);
                Here.Add(model);
            }
            await Task.Yield();
            var generator = new Generator(model, this);
            Loaded.Add(generator);
            return generator;
        }

        public Task ReleaseIdleAsync()
        {
            Releases++;
            return Task.CompletedTask;
        }
    }

    /// <summary>A loaded model: answers with its stand-in's reply, keeps what it was asked, and knows whether it was let go.</summary>
    public sealed class Generator(string model, StandIn by) : ITextGenerator
    {
        public string ModelId => model;
        public bool Disposed { get; private set; }
        public List<LMSupply.Generator.Models.ChatMessage> Asked { get; } = [];

        public Task<ChatCompletionResult> GenerateChatWithToolsAsync(IEnumerable<LMSupply.Generator.Models.ChatMessage> messages, GenerationOptions? options = null, CancellationToken cancellationToken = default)
        {
            Asked.AddRange(messages);
            return Task.FromResult(new ChatCompletionResult { Content = by.Reply, FinishReason = "stop" });
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }

        public IAsyncEnumerable<string> GenerateAsync(string prompt, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public IAsyncEnumerable<TextStreamChunk> GenerateStreamAsync(string prompt, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public IAsyncEnumerable<string> GenerateChatAsync(IEnumerable<LMSupply.Generator.Models.ChatMessage> messages, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string> GenerateCompleteAsync(string prompt, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<GenerationResult> GenerateCompleteResultAsync(string prompt, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string> GenerateChatCompleteAsync(IEnumerable<LMSupply.Generator.Models.ChatMessage> messages, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<GenerationResult> GenerateChatCompleteResultAsync(IEnumerable<LMSupply.Generator.Models.ChatMessage> messages, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public IAsyncEnumerable<ChatStreamChunk> GenerateChatStreamAsync(IEnumerable<LMSupply.Generator.Models.ChatMessage> messages, GenerationOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task WarmupAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private static ChatAuthorRequest Ask(string model, string text = "처리 기한 칸을 넣어 줘") =>
        new(ChatAuthoring.LocalPreset, null, null, model, "---\nid: intake\nversion: 1\n---\n@요청: [textarea]\n", [new ChatTurn("user", text)]);

    /// <summary>Waits until getting <paramref name="model"/> ready has ended, and says how.</summary>
    private static async Task<LocalModelProgress> Settled(LocalModels local, string model)
    {
        for (var i = 0; i < 200; i++)
        {
            var progress = (await local.ViewAsync(Ct)).Progress;
            if (progress.Model == model && progress.Phase is "ready" or "failed") return progress;
            await Task.Delay(10, Ct);
        }
        throw new TimeoutException($"{model} did not settle");
    }

    [Fact]
    public async Task Offers_the_models_that_write_templates_the_recommended_first_and_says_which_are_here()
    {
        await using var local = new LocalModels(new StandIn());

        var view = await local.ViewAsync(Ct);

        Assert.Equal([Recommended, Larger], view.Models.Select(m => m.Id));
        Assert.Equal([true, false], view.Models.Select(m => m.Recommended));
        Assert.Equal([true, false], view.Models.Select(m => m.Downloaded));
        Assert.All(view.Models, m => Assert.True(m.SizeBytes > 1_000_000_000));
        Assert.Equal(LocalModelProgress.Idle, view.Progress);
    }

    [Fact]
    public async Task Getting_a_model_ready_fetches_it_when_it_is_not_here_then_the_chat_answers_on_it_and_lets_it_go()
    {
        var lmsupply = new StandIn();
        await using var local = new LocalModels(lmsupply);

        Assert.Equal("starting", local.Prepare(Larger).Phase);
        Assert.Equal(new LocalModelProgress(Larger, "ready"), await Settled(local, Larger));
        Assert.True((await local.ViewAsync(Ct)).Models.Single(m => m.Id == Larger).Downloaded);

        var reply = await ChatAuthoring.ReplyAsync(Ask(Larger), local, TimeSpan.FromSeconds(20), Ct);

        Assert.Equal((true, "칸을 넣었습니다.", null), (reply.Ok, reply.Text, reply.Failure));
        // Fetched once when got ready; taken from what is here for the reply.
        Assert.Equal([(Larger, true), (Larger, false)], lmsupply.Loads);
        // Each let go after use: its server stays warm for LMSupply's idle time, then ends.
        Assert.All(lmsupply.Loaded, g => Assert.True(g.Disposed));
        Assert.Equal(0, lmsupply.Releases);
        var asked = lmsupply.Loaded[^1].Asked;
        Assert.Contains("lowline:", asked[0].Content); // the rules and the template, before the conversation
        Assert.Equal("처리 기한 칸을 넣어 줘", asked[^1].Content);
    }

    [Fact]
    public async Task After_a_restart_the_chat_loads_the_model_from_what_is_here_and_never_fetches()
    {
        var lmsupply = new StandIn();
        await using var local = new LocalModels(lmsupply);

        var here = await ChatAuthoring.ReplyAsync(Ask(Recommended), local, TimeSpan.FromSeconds(20), Ct);
        var gone = await ChatAuthoring.ReplyAsync(Ask(Larger), local, TimeSpan.FromSeconds(20), Ct);

        Assert.True(here.Ok);
        Assert.Equal((false, null, ModelFailure.NotDownloaded), (gone.Ok, gone.Text, gone.Failure));
        Assert.Equal([(Recommended, false), (Larger, false)], lmsupply.Loads);
        Assert.DoesNotContain(Larger, lmsupply.Here);
    }

    [Fact]
    public async Task Choosing_another_model_lets_the_first_ones_server_go_at_once()
    {
        var lmsupply = new StandIn { Here = { Larger } };
        await using var local = new LocalModels(lmsupply);
        local.Prepare(Recommended);
        await Settled(local, Recommended);
        await ChatAuthoring.ReplyAsync(Ask(Recommended), local, TimeSpan.FromSeconds(20), Ct);
        Assert.Equal(0, lmsupply.Releases); // the same model again keeps its warm server

        local.Prepare(Larger);
        await Settled(local, Larger);

        Assert.Equal(1, lmsupply.Releases);
        Assert.All(lmsupply.Loaded, g => Assert.True(g.Disposed));
    }

    [Fact]
    public async Task A_model_that_will_not_start_and_one_not_offered_say_why_in_the_apps_words()
    {
        var lmsupply = new StandIn { Fails = { [Recommended] = new InvalidOperationException("llama-server exited with code 3221225477") } };
        await using var local = new LocalModels(lmsupply);

        local.Prepare(Recommended);
        var failed = await Settled(local, Recommended);
        var chat = await ChatAuthoring.ReplyAsync(Ask(Recommended), local, TimeSpan.FromSeconds(20), Ct);
        var unknown = local.Prepare("gguf:qwen3-fast");

        Assert.Equal(new LocalModelProgress(Recommended, "failed", Failure: ModelFailure.NotStarted), failed);
        Assert.Equal((false, ModelFailure.NotStarted), (chat.Ok, chat.Failure));
        Assert.Equal(ModelFailure.Invalid, unknown.Failure);
        Assert.DoesNotContain(lmsupply.Loads, l => l.Model == "gguf:qwen3-fast");
    }

    [Fact]
    public async Task Getting_a_model_ready_twice_while_it_is_on_its_way_loads_it_once()
    {
        var lmsupply = new StandIn();
        await using var local = new LocalModels(lmsupply);

        local.Prepare(Recommended);
        local.Prepare(Recommended);
        await Settled(local, Recommended);
        local.Prepare(Recommended);
        await Settled(local, Recommended);

        Assert.Single(lmsupply.Loaded);
    }
}
