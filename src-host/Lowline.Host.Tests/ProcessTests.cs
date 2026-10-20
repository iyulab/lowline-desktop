using System.Diagnostics;
using System.Net.Http.Headers;
using Lowline.Host;

namespace Lowline.Host.Tests;

/// <summary>The contract the shell relies on, checked against the real process.</summary>
public sealed class ProcessTests
{
    private static Process Start(string? token, int? parent = null)
    {
        var info = new ProcessStartInfo("dotnet", [typeof(Program).Assembly.Location])
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        info.Environment.Remove(HostAuth.TokenVariable);
        if (token is not null) info.Environment[HostAuth.TokenVariable] = token;
        info.Environment.Remove(HostLifecycle.ParentVariable);
        if (parent is not null) info.Environment[HostLifecycle.ParentVariable] = parent.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Process.Start(info)!;
    }

    [Theory]
    [InlineData(null)]
    [InlineData("t0ken")] // too short to be a secret
    public async Task Refuses_to_start_without_a_token(string? token)
    {
        using var host = Start(token);
        await host.WaitForExitAsync(TestContext.Current.CancellationToken);
        Assert.Equal(2, host.ExitCode);
    }

    [Fact]
    public async Task Prints_its_port_listens_there_on_loopback_and_stops_on_request()
    {
        using var host = Start(HostTests.Token);
        try
        {
            string? line;
            do
            {
                line = await host.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken);
            } while (line is not null && !line.StartsWith(ReadyLine.Prefix, StringComparison.Ordinal));
            Assert.NotNull(line);
            var port = int.Parse(line[ReadyLine.Prefix.Length..], System.Globalization.CultureInfo.InvariantCulture);
            var address = new Uri($"http://127.0.0.1:{port}");

            using var client = new HttpClient { BaseAddress = address };
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", HostTests.Token);
            var health = await client.GetAsync("/health", TestContext.Current.CancellationToken);
            Assert.True(health.IsSuccessStatusCode);

            var shutdown = await client.PostAsync("/shutdown", null, TestContext.Current.CancellationToken);
            Assert.Equal(System.Net.HttpStatusCode.Accepted, shutdown.StatusCode);
            using var exited = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await host.WaitForExitAsync(exited.Token);
            Assert.Equal(0, host.ExitCode);
        }
        finally
        {
            if (!host.HasExited) host.Kill(entireProcessTree: true);
        }
    }

    [Fact]
    public async Task Quits_on_its_own_when_the_shell_that_started_it_is_gone()
    {
        // A shell that has already ended: the sidecar started for it does not stay.
        using var shell = Process.Start(new ProcessStartInfo("dotnet", ["--version"]) { RedirectStandardOutput = true, UseShellExecute = false })!;
        await shell.WaitForExitAsync(TestContext.Current.CancellationToken);
        using var host = Start(HostTests.Token, parent: shell.Id);
        try
        {
            using var exited = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await host.WaitForExitAsync(exited.Token);
            // TODO(upstream: tauri-kit df8f358, the next TauriKit.Sidecar.Loopback.AspNetCore release): with it the host
            // stops cleanly (exit 0); with 0.23.0 the watch stops it while it is still starting, and it ends failing.
            Assert.True(host.HasExited);
        }
        finally
        {
            if (!host.HasExited) host.Kill(entireProcessTree: true);
        }
    }
}
