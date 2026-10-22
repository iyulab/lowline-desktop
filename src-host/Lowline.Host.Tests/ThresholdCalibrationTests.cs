using System.Text.Json;

namespace Lowline.Host.Tests;

/// <summary>
/// Whether the key layer keeps the precision its threshold replay promises, as the app uses it: documents
/// asked about in turn, each then confirmed and remembered, the thresholds chosen again as the confirmed
/// grow by a tenth. Runs only with <c>LOWLINE_PERF=1</c>; writes its figures to <c>LOWLINE_PERF_OUT</c> when
/// set.
/// </summary>
public sealed class ThresholdCalibrationTests
{
    private static readonly TemplateSnapshot Routing = Templates.Of("routing@1",
    [
        new TemplateField("부서", "select"),
        new TemplateField("유형", "select"),
        new TemplateField("담당", "select"),
    ], Suggest: ["담당"]);

    /// <summary>
    /// Requests whose owner two chosen fields each say something about: mostly the kind of request, sometimes
    /// the department asking, now and then someone else. Each field is a key of the key layer, so this is
    /// where keys agreeing with each other shows.
    /// </summary>
    private static VaultSnapshot Routed(int count, int seed)
    {
        string[] departments = ["영업", "개발", "생산", "지원"];
        string[] kinds = ["장비", "급여", "정산", "출입"];
        string[] owners = ["장비팀", "인사팀", "재무팀", "총무팀"];
        var random = new Random(seed);
        var documents = new List<DocumentSnapshot>(count);
        var start = new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);
        for (var i = 0; i < count; i++)
        {
            var department = random.Next(departments.Length);
            var kind = random.Next(kinds.Length);
            var roll = random.NextDouble();
            var owner = roll < 0.7 ? owners[kind] : roll < 0.9 ? owners[department] : owners[random.Next(owners.Length)];
            var json = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(
                new Dictionary<string, object> { ["부서"] = departments[department], ["유형"] = kinds[kind], ["담당"] = owner }))!;
            documents.Add(new DocumentSnapshot($"문서/{i:D6}.md", "routing@1", json, start.AddMinutes(i * 37).ToUnixTimeMilliseconds()));
        }
        return new VaultSnapshot([Routing], documents, []);
    }

    [Theory]
    [InlineData(50, 300)]
    [InlineData(300, 300)]
    public async Task Measures_the_key_layer_over_two_keys(int confirmed, int asked)
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("LOWLINE_PERF") == "1", "set LOWLINE_PERF=1 to measure");
        var ct = TestContext.Current.CancellationToken;
        var all = Routed(confirmed + asked, seed: confirmed);
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(confirmed)]), ct);
        await vault.ThresholdsSelected.WaitAsync(ct);
        var replay = (await vault.CurvesAsync(ct)).Single();

        // As the app goes: each document asked about is then confirmed and remembered, and the thresholds are
        // chosen again as the confirmed grow by a tenth — so what is asked meets the history as it is by then.
        int right = 0, wrong = 0, abstained = 0;
        var promised = new List<double>();
        for (var i = confirmed; i < all.Documents.Count; i++)
        {
            var document = all.Documents[i];
            var values = document.Values.Where(v => v.Key != "담당").ToDictionary(v => v.Key, v => v.Value);
            var suggestion = (await vault.SuggestAsync(new SuggestRequest("routing@1", "담당", values), ct))!;
            if (suggestion.Value is null) abstained++;
            else
            {
                if (suggestion.Value == document.Values["담당"].GetString()) right++;
                else wrong++;
                if ((await vault.CurvesAsync(ct)).Single().Replay?.Promise is { } promise) promised.Add(promise);
            }
            await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(i + 1)]), ct);
            await vault.ThresholdsSelected.WaitAsync(ct);
        }

        await Measurement.ReportAsync(
            $"two keys · {confirmed} confirmed · {asked} asked · {replay.WhyNoReplay ?? "replay"} threshold {replay.Replay?.Threshold:F4} precision {replay.Replay?.Precision:P0} answered {replay.Replay?.AnswerRate:P0}"
            + $" · asked and confirmed in turn: right {right} wrong {wrong} abstained {abstained}"
            + $" ({(right + wrong == 0 ? 0 : 100.0 * right / (right + wrong)):F0}% right, promised {(promised.Count == 0 ? 0 : 100 * promised.Average()):F0}%)", ct);
    }

    private static readonly TemplateSnapshot Approved = Templates.Of("approved@1",
    [
        new TemplateField("부서", "select"),
        new TemplateField("유형", "select"),
        new TemplateField("담당", "select"),
        new TemplateField("승인", "select"),
    ], Suggest: ["담당", "승인"]);

    /// <summary>
    /// The requests of <see cref="Routed"/>, each also approved by someone who mostly goes with its owner: one judged
    /// field that the other, once confirmed, says the most about.
    /// </summary>
    private static VaultSnapshot RoutedAndApproved(int count, int seed)
    {
        string[] approvers = ["장비 승인", "인사 승인", "재무 승인", "총무 승인"];
        var routed = Routed(count, seed);
        var random = new Random(seed + 1);
        var documents = routed.Documents.Select(d =>
        {
            var owner = Array.IndexOf(["장비팀", "인사팀", "재무팀", "총무팀"], d.Values["담당"].GetString());
            var approver = random.NextDouble() < 0.85 ? approvers[owner] : approvers[random.Next(approvers.Length)];
            var values = new Dictionary<string, JsonElement>(d.Values)
            {
                ["승인"] = JsonSerializer.SerializeToElement(approver),
            };
            return d with { Template = "approved@1", Values = values };
        });
        return new VaultSnapshot([Approved], [.. documents], []);
    }

    /// <summary>
    /// Both judged fields asked about as the form is filled in: the owner from the observed fields, the approver once
    /// the owner is confirmed — the order the threshold replay takes when a document does not say which came first.
    /// </summary>
    [Theory]
    [InlineData(50, 300)]
    [InlineData(300, 300)]
    public async Task Measures_a_judged_field_resting_on_another(int confirmed, int asked)
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("LOWLINE_PERF") == "1", "set LOWLINE_PERF=1 to measure");
        var ct = TestContext.Current.CancellationToken;
        var all = RoutedAndApproved(confirmed + asked, seed: confirmed);
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(confirmed)]), ct);
        await vault.ThresholdsSelected.WaitAsync(ct);

        var tally = new Dictionary<string, (int Right, int Wrong, int Abstained, List<double> Promised)>
        {
            ["담당"] = (0, 0, 0, []),
            ["승인"] = (0, 0, 0, []),
        };
        for (var i = confirmed; i < all.Documents.Count; i++)
        {
            var document = all.Documents[i];
            foreach (var field in (string[])["담당", "승인"])
            {
                // What is filled in by the time the field is asked about: everything before it in the form.
                var before = field == "담당" ? (string[])["부서", "유형"] : ["부서", "유형", "담당"];
                var values = document.Values.Where(v => before.Contains(v.Key)).ToDictionary(v => v.Key, v => v.Value);
                var suggestion = (await vault.SuggestAsync(new SuggestRequest("approved@1", field, values), ct))!;
                var (right, wrong, abstained, promised) = tally[field];
                if (suggestion.Value is null) abstained++;
                else
                {
                    if (suggestion.Value == document.Values[field].GetString()) right++;
                    else wrong++;
                    if ((await vault.CurvesAsync(ct)).Single(c => c.Field == field).Replay?.Promise is { } promise)
                        promised.Add(promise);
                }
                tally[field] = (right, wrong, abstained, promised);
            }
            await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(i + 1)]), ct);
            await vault.ThresholdsSelected.WaitAsync(ct);
        }

        await Measurement.ReportAsync(
            $"judged on judged · {confirmed} confirmed · {asked} asked · " + string.Join(" · ", tally.Select(t =>
                $"{t.Key}: right {t.Value.Right} wrong {t.Value.Wrong} abstained {t.Value.Abstained}"
                + $" ({(t.Value.Right + t.Value.Wrong == 0 ? 0 : 100.0 * t.Value.Right / (t.Value.Right + t.Value.Wrong)):F0}% right,"
                + $" promised {(t.Value.Promised.Count == 0 ? 0 : 100 * t.Value.Promised.Average()):F0}%)")), ct);
    }

    private static readonly string[] Noise = ["부서", "공정", "교대", "라인", "등급", "지역", "유형"];

    private static readonly TemplateSnapshot Faults = Templates.Of("faults@1",
    [
        .. Noise.Select(n => new TemplateField(n, "select")),
        new TemplateField("설비", "select"),
        new TemplateField("고장", "text"),
    ], Suggest: ["고장"]);

    /// <summary>
    /// Fault reports whose code — one of a few hundred — the machine, one of a hundred, decides nine times in ten; seven
    /// more observed fields say nothing about it. A field of many values decided by one of many fields: where every
    /// observed field adding to each value's score blurs the one that decides it.
    /// </summary>
    private static VaultSnapshot Faulted(int count, int seed)
    {
        int[] noiseValues = [4, 10, 3, 12, 5, 8, 4];
        var random = new Random(seed);
        var documents = new List<DocumentSnapshot>(count);
        var start = new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);
        for (var i = 0; i < count; i++)
        {
            var values = new Dictionary<string, object>();
            for (var n = 0; n < Noise.Length; n++) values[Noise[n]] = $"{Noise[n]}{random.Next(noiseValues[n])}";
            var machine = random.Next(100);
            values["설비"] = $"설비{machine}";
            values["고장"] = random.NextDouble() < 0.9 ? $"F{machine:D3}" : $"F{random.Next(300):D3}";
            var json = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(values))!;
            documents.Add(new DocumentSnapshot($"문서/{i:D6}.md", "faults@1", json, start.AddMinutes(i * 37).ToUnixTimeMilliseconds()));
        }
        return new VaultSnapshot([Faults], documents, []);
    }

    [Theory]
    [InlineData(300, 300)]
    [InlineData(1000, 300)]
    public async Task Measures_a_field_of_many_values_decided_by_a_few_fields(int confirmed, int asked)
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("LOWLINE_PERF") == "1", "set LOWLINE_PERF=1 to measure");
        var ct = TestContext.Current.CancellationToken;
        var all = Faulted(confirmed + asked, seed: confirmed);
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(confirmed)]), ct);
        await vault.ThresholdsSelected.WaitAsync(ct);
        var replay = (await vault.CurvesAsync(ct)).Single();

        int right = 0, wrong = 0, abstained = 0;
        var promised = new List<double>();
        var typing = new Typing();
        var selecting = System.Diagnostics.Stopwatch.StartNew();
        var selectingTime = TimeSpan.Zero;
        for (var i = confirmed; i < all.Documents.Count; i++)
        {
            var document = all.Documents[i];
            var values = document.Values.Where(v => v.Key != "고장").ToDictionary(v => v.Key, v => v.Value);
            var suggestion = (await vault.SuggestAsync(new SuggestRequest("faults@1", "고장", values), ct))!;
            if (suggestion.Value is null) abstained++;
            else
            {
                if (suggestion.Value == document.Values["고장"].GetString()) right++;
                else wrong++;
                if ((await vault.CurvesAsync(ct)).Single().Replay?.Promise is { } promise) promised.Add(promise);
            }
            await typing.TypeAsync(vault, new SuggestRequest("faults@1", "고장", values), suggestion, document.Values["고장"].GetString()!, ct);
            await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(i + 1)]), ct);
            selecting.Restart();
            await vault.ThresholdsSelected.WaitAsync(ct);
            selectingTime += selecting.Elapsed;
        }

        await Measurement.ReportAsync(
            $"many values · {confirmed} confirmed · {asked} asked · {replay.WhyNoReplay ?? "replay"} threshold {replay.Replay?.Threshold:F4} precision {replay.Replay?.Precision:P0} answered {replay.Replay?.AnswerRate:P0}"
            + $" · asked and confirmed in turn: right {right} wrong {wrong} abstained {abstained}"
            + $" ({(right + wrong == 0 ? 0 : 100.0 * right / (right + wrong)):F0}% right, promised {(promised.Count == 0 ? 0 : 100 * promised.Average()):F0}%)"
            + $" · waiting on selection {selectingTime.TotalSeconds:F1} s · {typing}", ct);
    }

    private static readonly string[] Surnames = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황"];
    private static readonly string[] Given = ["민준", "서연", "지호", "하은", "도윤", "수아", "예준", "지우", "시우", "서윤"];

    private static readonly TemplateSnapshot Staffed = Templates.Of("staffed@1",
    [
        .. Noise.Select(n => new TemplateField(n, "select")),
        new TemplateField("팀", "select"),
        new TemplateField("담당자", "text"),
    ], Suggest: ["담당자"]);

    /// <summary>
    /// Requests each handled by someone of the asking team — one of forty teams of four — the team's first person half
    /// the time, the other three otherwise; seven more observed fields say nothing. The team narrows the person to four,
    /// whose names begin differently: what a value settled alongside it cannot decide, a first character typed can.
    /// </summary>
    private static VaultSnapshot Staffing(int count, int seed)
    {
        int[] noiseValues = [4, 10, 3, 12, 5, 8, 4];
        var people = Enumerable.Range(0, 40).Select(t => Enumerable.Range(0, 4)
            .Select(m => Surnames[(t * 4 + m) % Surnames.Length] + Given[(t * 7 + m * 3) % Given.Length]).ToArray()).ToArray();
        var random = new Random(seed);
        var documents = new List<DocumentSnapshot>(count);
        var start = new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);
        for (var i = 0; i < count; i++)
        {
            var values = new Dictionary<string, object>();
            for (var n = 0; n < Noise.Length; n++) values[Noise[n]] = $"{Noise[n]}{random.Next(noiseValues[n])}";
            var team = random.Next(people.Length);
            values["팀"] = $"팀{team}";
            values["담당자"] = random.NextDouble() < 0.5 ? people[team][0] : people[team][1 + random.Next(3)];
            var json = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(values))!;
            documents.Add(new DocumentSnapshot($"문서/{i:D6}.md", "staffed@1", json, start.AddMinutes(i * 37).ToUnixTimeMilliseconds()));
        }
        return new VaultSnapshot([Staffed], documents, []);
    }

    /// <summary>
    /// A field typed out whose values a key narrows but does not decide: as the app goes, a person who does not take the
    /// value offered types it from its start, asked again with every character — how many characters they are spared, and
    /// whether what is offered while they type is right as often as its replay promised.
    /// </summary>
    [Theory]
    [InlineData(30, 300)]
    [InlineData(300, 300)]
    [InlineData(1000, 300)]
    public async Task Measures_typing_into_a_field_a_key_narrows(int confirmed, int asked)
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("LOWLINE_PERF") == "1", "set LOWLINE_PERF=1 to measure");
        var ct = TestContext.Current.CancellationToken;
        var all = Staffing(confirmed + asked, seed: confirmed);
        await using var vault = new VaultProjection();
        await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(confirmed)]), ct);
        await vault.ThresholdsSelected.WaitAsync(ct);

        int right = 0, wrong = 0, abstained = 0;
        var typing = new Typing();
        for (var i = confirmed; i < all.Documents.Count; i++)
        {
            var document = all.Documents[i];
            var values = document.Values.Where(v => v.Key != "담당자").ToDictionary(v => v.Key, v => v.Value);
            var asking = new SuggestRequest("staffed@1", "담당자", values);
            var suggestion = (await vault.SuggestAsync(asking, ct))!;
            var settled = document.Values["담당자"].GetString()!;
            if (suggestion.Value is null) abstained++;
            else if (suggestion.Value == settled) right++;
            else wrong++;
            await typing.TypeAsync(vault, asking, suggestion, settled, ct);
            await vault.IngestAsync(new VaultSnapshot(all.Templates, [.. all.Documents.Take(i + 1)]), ct);
            await vault.ThresholdsSelected.WaitAsync(ct);
        }

        await Measurement.ReportAsync(
            $"typing · {confirmed} confirmed · {asked} asked · before typing: right {right} wrong {wrong} abstained {abstained} · {typing}", ct);
    }

    /// <summary>
    /// What choosing the strengths for typing costs on a large vault: the same documents, their 담당자 once a field typed
    /// out and once a choice, timed apart in one run so the machine's load weighs on both alike.
    /// </summary>
    [Theory]
    [InlineData(10000)]
    public async Task Measures_choosing_the_strengths_for_typing_on_a_large_vault(int confirmed)
    {
        Assert.SkipUnless(Environment.GetEnvironmentVariable("LOWLINE_PERF") == "1", "set LOWLINE_PERF=1 to measure");
        var ct = TestContext.Current.CancellationToken;
        var typed = Staffing(confirmed, seed: confirmed);
        var picked = typed with
        {
            Templates = [Staffed with { Fields = [.. Staffed.Fields.Select(f => f.Name == "담당자" ? f with { Type = "select" } : f)] }],
        };

        async Task<(TimeSpan Wall, TimeSpan Cpu)> Choose(VaultSnapshot vault)
        {
            var suggestions = await Suggestions.BuildAsync(vault, ct);
            var process = System.Diagnostics.Process.GetCurrentProcess();
            var cpu = process.TotalProcessorTime;
            var wall = System.Diagnostics.Stopwatch.StartNew();
            await suggestions.ApplyAsync(await suggestions.SelectThresholdsAsync(ct), ct);
            process.Refresh();
            return (wall.Elapsed, process.TotalProcessorTime - cpu);
        }

        await Choose(picked); // warm up
        var asPicked = await Choose(picked);
        var asTyped = await Choose(typed);
        await Measurement.ReportAsync(
            $"choosing strengths · {confirmed} confirmed · a choice: {asPicked.Wall.TotalMilliseconds:F0} ms ({asPicked.Cpu.TotalMilliseconds:F0} ms CPU)"
            + $" · typed out: {asTyped.Wall.TotalMilliseconds:F0} ms ({asTyped.Cpu.TotalMilliseconds:F0} ms CPU)", ct);
    }

    /// <summary>
    /// What typing does for one field over the documents asked about: a person takes the value offered when it is the one
    /// settled, and otherwise types it from its start, asked again after each of the first three characters, taking the
    /// value offered once it is the one.
    /// </summary>
    private sealed class Typing
    {
        private int _characters, _spared, _right, _wrong, _taken, _withdrawn;

        public async Task TypeAsync(VaultProjection vault, SuggestRequest asked, Suggestion offered, string settled, CancellationToken ct)
        {
            _characters += settled.Length;
            if (offered.Value == settled)
            {
                _spared += settled.Length;
                return;
            }
            // A value offered again as typing goes on is the same suggestion, not a new one: each is counted once — and the
            // one offered before typing was counted there.
            var offeredWrong = new HashSet<string>(StringComparer.Ordinal);
            if (offered.Value is { } before) offeredWrong.Add(before);
            for (var length = 1; length <= Math.Min(3, settled.Length - 1); length++)
            {
                var typed = settled[..length];
                if ((await vault.SuggestAsync(asked with { Typed = typed }, ct))?.Value is not { } value || value == typed) continue;
                if (value != settled)
                {
                    if (offeredWrong.Add(value)) _wrong++;
                    continue;
                }
                _right++;
                _taken++;
                _spared += settled.Length - length;
                // A person who goes on typing without looking: is the right value still offered with every character more?
                for (var more = length + 1; more < settled.Length; more++)
                {
                    if ((await vault.SuggestAsync(asked with { Typed = settled[..more] }, ct))?.Value != settled)
                    {
                        _withdrawn++;
                        break;
                    }
                }
                return;
            }
        }

        public override string ToString() =>
            $"while typing: right {_right} wrong {_wrong} ({(_right + _wrong == 0 ? 0 : 100.0 * _right / (_right + _wrong)):F0}% right)"
            + $" · characters spared {_spared} of {_characters} ({(_characters == 0 ? 0 : 100.0 * _spared / _characters):F0}%, {_taken} taken while typing)"
            + $" · withdrawn as typing went on {_withdrawn} of {_right}";
    }
}
