// Lowline's sidecar: projections and suggestions over what the shell hands it. It never reads or
// writes vault files — the shell owns every file, and hands documents over as parsed values.
//
// Started by the shell as a loopback sidecar (TauriKit.Sidecar.Loopback) with a per-launch token in
// LOWLINE_HOST_TOKEN, the directory for projection caches in LOWLINE_HOST_CACHE and the shell's process id in
// LOWLINE_HOST_PARENT — the sidecar quits when that process is gone. It listens on
// 127.0.0.1, on a port the OS picks, and prints one ready line with it; every request must carry the token
// and name this computer as its host.
using Lowline.Host;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using TauriKit.Sidecar.Loopback;

var builder = LoopbackHost.CreateSlimBuilder(args);

// Every route needs the launch's token; it is registered once the app's configuration — the environment, or a test
// host's settings — has been read.
var credentials = new LoopbackCredentials();
builder.Services.AddLoopbackAuthentication(credentials);

// Projection caches live where the shell says, outside any vault; without a place they last one run.
builder.Services.AddSingleton<HostFailures>();
// The model running on this computer for the chat, when the person set one up: one at a time, kept loaded.
builder.Services.AddSingleton<ILocalGenerators, LmSupplyGenerators>();
builder.Services.AddSingleton<LocalModels>();
builder.Services.AddSingleton(services => new VaultProjection(
    services.GetRequiredService<IConfiguration>()[VaultProjection.CacheVariable],
    services.GetRequiredService<HostFailures>()));

// Quits when the shell is gone without having stopped it — killed, say. Tests start the host without one.
if (int.TryParse(builder.Configuration[HostLifecycle.ParentVariable], out var parent) && parent > 0)
    builder.Services.AddParentProcessWatch(parent);

var app = builder.Build();

var token = app.Configuration[HostAuth.TokenVariable];
if (string.IsNullOrEmpty(token) || token.Length < LoopbackCredentials.MinimumLength)
{
    Console.Error.WriteLine(
        $"{HostAuth.TokenVariable} ({LoopbackCredentials.MinimumLength}+ characters) is not set; refusing to start without a token.");
    return 2;
}
credentials.Register(token, "shell");

// Only this computer's names are answered: a page whose own name was pointed at 127.0.0.1 is refused.
app.UseLoopbackHostCheck();
// A failed request says what failed, never with what: its type and the frames it passed through.
app.UseFaults(new FaultOptions { OwnNamespaces = HostFailures.OwnNamespaces });

app.MapGet("/health", (VaultProjection vault) => new Health("ok", VaultIndexed: vault.Indexed, MemoryReady: vault.MemoryReady));

// `vault` is the vault's root as the shell names it: it picks the vault's cache, nothing is read from it.
app.MapPost("/vault/ingest", (VaultSnapshot snapshot, string? vault, VaultProjection projection, CancellationToken ct) =>
    projection.IngestAsync(snapshot, vault ?? "", ct));

app.MapPost("/projection", async (ProjectionQuery query, VaultProjection vault, CancellationToken ct) =>
    await vault.TableAsync(query.Template, query.Filters ?? [], ct) is { } table ? Results.Ok(table) : Results.NotFound());

app.MapGet("/curves", (VaultProjection vault, CancellationToken ct) => vault.CurvesAsync(ct));

// Counts of a template's documents, per value of some fields, each with the documents it is made of.
app.MapPost("/aggregate", async (AggregateQuery query, VaultProjection vault, CancellationToken ct) =>
{
    try
    {
        return await vault.AggregateAsync(query, ct) is { } answer ? Results.Ok(answer) : Results.NotFound();
    }
    catch (ArgumentException)
    {
        return Results.BadRequest();
    }
});

app.MapPost("/suggest", async (SuggestRequest request, VaultProjection vault, CancellationToken ct) =>
    await vault.SuggestAsync(request, ct) is { } suggestion ? Results.Ok(suggestion) : Results.NotFound());

// The vault's text: documents holding some words, and the documents most like one of them.
app.MapPost("/search", (CaseQuery query, VaultProjection vault, CancellationToken ct) => vault.SearchAsync(query, ct));
app.MapPost("/similar", (SimilarQuery query, VaultProjection vault, CancellationToken ct) => vault.SimilarAsync(query, ct));

// Whether a model endpoint the person named answers, with the key the shell read from the credential store for it.
app.MapPost("/model/probe", (ModelProbe probe, CancellationToken ct) => ModelConnection.ProbeAsync(probe, timeout: null, ct));

// The models offered on this computer and where getting one ready stands; getting one ready, fetching it if it is not here.
app.MapGet("/model/local", (LocalModels local) => local.View());
app.MapPost("/model/local/prepare", (LocalModelPick pick, LocalModels local) => local.Prepare(pick.Model));

// A reply of the chat that writes templates, with the key the shell read from the credential store for this one request.
app.MapPost("/chat/author", (ChatAuthorRequest request, LocalModels local, CancellationToken ct) =>
    ChatAuthoring.ReplyAsync(request, local, ChatAuthoring.Deadline, ct));

// A blank form the person picked to start a template from, as Markdown — read here, sent nowhere.
app.MapPost("/files/markdown", (SourceFileRequest request) => SourceFiles.Read(request));

// What to count for a question about a template's documents — never the counts, which /aggregate makes.
app.MapPost("/chat/query", (ChatQueryRequest request, LocalModels local, CancellationToken ct) =>
    ChatQuery.ReplyAsync(request, local, ChatAuthoring.Deadline, ct));

// The records the model reads out of text pasted to bring them in, as values of the template's fields.
app.MapPost("/chat/extract", (ChatExtractRequest request, LocalModels local, CancellationToken ct) =>
    ChatExtraction.ReplyAsync(request, local, ChatAuthoring.Deadline, ct));

// Failures of work no request waited on, since the last time the shell asked.
app.MapPost("/failures/take", (HostFailures failures) => failures.Take());

// The shell asks before it stops the process, so writes under way finish.
app.MapShutdown();

app.Lifetime.ApplicationStarted.Register(() =>
{
    var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>();
    // Under a test server there is no listening address, and nothing to announce.
    if (addresses?.Addresses.FirstOrDefault() is { } address)
    {
        Console.Out.WriteLine(LoopbackHost.ReadyLine(ReadyLine.Prefix, new Uri(address).Port));
        Console.Out.Flush();
    }
});

app.Run();
return 0;

/// <summary>Needed by the integration tests' <c>WebApplicationFactory</c>.</summary>
public partial class Program;
