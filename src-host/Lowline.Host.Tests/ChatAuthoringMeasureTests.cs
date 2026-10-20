using System.Diagnostics;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Lowline.Host.Tests;

/// <summary>
/// What a model on this computer makes of requests for templates, each starting from the template a new one starts as:
/// each request's reply, with the fields it asks for and the ones it asks to be judged, for the app's side to judge as
/// the app reads drafts (<c>src/__tests__/chat-authoring-measure.test.ts</c>). A measurement, not a test of the model:
/// only that each reply arrives is asserted. Runs only with <c>LOWLINE_CHAT_AUTHORING_MEASURE</c> naming the file to
/// write and the model (<c>LOWLINE_CHAT_MODEL</c>, the recommended one by default) already on this computer; the requests
/// that hand over a blank form file run only with <c>LOWLINE_BLANK_FORMS</c> naming the folder of them.
/// </summary>
public sealed class ChatAuthoringMeasureTests
{
    /// <summary>
    /// What a new template starts as (the app's <c>starterTemplate</c>); the app's side checks it still is. Its line breaks
    /// are the app's, whatever this file was checked out with.
    /// </summary>
    private static readonly string Starter = """
        ---
        id: new-template
        version: 1
        ---
        # 새 서식

        제목: ___@제목

        @상태: [select options="열림,진행,닫힘"]

        @메모: [textarea rows=4]

        """.ReplaceLineEndings("\n");

    /// <summary>
    /// A request, the fields it names (a field counts when its name holds the word, spaces and underscores aside), the
    /// ones it asks a person to judge from a closed list, the ones it asks to show or require only on another's answer,
    /// the ones worked out from others' numbers, and the fields of a row repeated down a table — asked to be a template of
    /// their own whose documents point at this one's.
    /// </summary>
    private sealed record Case(
        string Id, string Ask, string[] Fields, string[] Judged, string[]? Conditional = null, string[]? Computed = null, string[]? Rows = null,
        BlankForm? From = null);

    /// <summary>
    /// A blank form handed to the chat, as the app's «빈 서식 파일에서» does: the file under <c>LOWLINE_BLANK_FORMS</c> and
    /// the name the person would see it by. A case with one runs only when that folder is set.
    /// </summary>
    private sealed record BlankForm(string File, string Name);

    /// <summary>What the app sends when a blank form is picked (its <c>chatFromFileAsk</c>).</summary>
    private static string FromFileAsk(string name) => $"빈 서식 «{name}»으로 이 서식을 만들어 주세요.";

    private static readonly Case[] Cases =
    [
        new("inquiry", "고객 문의 접수 서식으로 바꿔 줘. 고객 이름, 연락처, 문의 내용을 받고, 문의 유형(배송·환불·고장·기타)과 담당 부서(고객지원·물류·기술)는 사람이 판단해 고르는 칸으로 해 줘.",
            ["이름", "연락처", "내용", "유형", "부서"], ["유형", "부서"]),
        new("inspection", "설비 점검 기록 서식으로 바꿔 줘. 설비 번호, 점검일, 점검자, 점검 메모를 적고, 판정(정상·주의·이상)과 조치 시기(즉시·계획·불필요)는 사람이 판단해 고르는 칸으로 해 줘.",
            ["설비", "점검일", "점검자", "메모", "판정", "조치"], ["판정", "조치"]),
        new("nonconformity", "부적합 보고서 서식으로 바꿔 줘. 품목, 로트 번호, 발견일, 부적합 내용을 받고, 원인 분류(작업자·설비·자재·방법)와 처리 방법(재작업·폐기·특채)은 판단 칸으로 해 줘.",
            ["품목", "로트", "발견일", "내용", "원인", "처리"], ["원인", "처리"]),
        new("rental", "장비 대여 신청 서식으로 바꿔 줘. 신청자, 부서, 장비 이름, 대여 시작일과 반납일을 받고, 승인 여부(승인·보류·반려)는 사람이 판단해 고르는 칸으로 해 줘.",
            ["신청자", "부서", "장비", "시작", "반납", "승인"], ["승인"]),
        new("defect", "시설 하자 접수 서식으로 바꿔 줘. 위치, 발견일, 하자 내용을 받고, 하자 종류(누수·균열·전기·기타)와 책임 구분(시공사·관리주체·입주자)은 판단 칸으로 해 줘.",
            ["위치", "발견일", "내용", "종류", "책임"], ["종류", "책임"]),
        new("quote", "견적 요청 서식으로 바꿔 줘. 회사명, 담당자, 이메일, 품목과 수량, 희망 납기를 받고, 우선순위(일반·우선·긴급)는 사람이 판단해 고르는 칸으로 해 줘.",
            ["회사", "담당자", "이메일", "품목", "수량", "납기", "우선순위"], ["우선순위"]),
        // Requests drawn from published blank forms (statute appendix forms): more fields, choices of several, fields
        // that apply only on another's answer, and a table of rows the language has no field for.
        new("disclosure", "정보공개청구서 서식으로 바꿔 줘. 청구인의 성명, 생년월일, 주소(소재지), 전화번호, 전자우편을 받고 청구 내용을 길게 적게 해 줘. 공개 방법(열람ㆍ시청·사본ㆍ출력물·전자파일·복제ㆍ인화물)과 수령 방법(직접 방문·우편·팩스·정보통신망·전자우편)은 여러 개를 고를 수 있게 하고, 수수료(감면 대상임·감면 대상 아님)를 고르게 한 뒤 감면 대상일 때만 감면 사유를 적게 해 줘.",
            ["성명", "생년월일", "주소", "전화", "전자우편", "청구", "공개", "수령", "수수료", "감면사유"], [], ["감면사유"]),
        new("accident", "산업재해조사표 서식으로 바꿔 줘. 사업장명, 근로자 수, 업종, 재해자 성명, 입사일, 고용형태(상용·임시·일용·무급가족종사자·자영업자), 근무형태(정상·2교대·3교대·4교대·시간제), 상해종류, 상해부위, 휴업예상일수, 사망 여부, 발생일시, 발생장소, 재해발생 당시 상황, 재발방지계획을 받아 줘. 업종이 건설업일 때만 공사종류와 공정률을 받고, 재해 원인 분류(떨어짐·끼임·넘어짐·부딪힘·기타)는 사람이 판단해 고르는 칸으로 해 줘.",
            ["사업장", "근로자수", "업종", "성명", "입사일", "고용형태", "근무형태", "상해종류", "상해부위", "휴업", "사망", "발생일시", "발생장소", "상황", "재발방지", "공사종류", "공정률", "원인"], ["원인"], ["공사종류", "공정률"]),
        new("event-safety", "체육행사 안전점검표를 만들어 줘. 행사명, 개최자, 종목, 참석예정 인원, 안전관리책임자를 받고, 비상구 개폐·비상등 점등과 응급 용품 사용 가능 여부 두 항목은 각각 점검일자와 결과(양호·미흡)를 받되 결과가 미흡일 때만 조치사항을 적게 해 줘. 종합 판정(진행·조건부 진행·연기)은 사람이 판단해 고르는 칸으로 해 줘.",
            ["행사명", "개최자", "종목", "참석", "안전관리책임자", "비상구", "응급", "조치", "종합"], ["종합"], ["조치"]),
        new("requisition", "물품청구서 서식으로 바꿔 줘. 운용부서명, 예산과목, 청구일을 받고, 품목마다 품명, 청구량, 단가, 금액, 용도를 열다섯 줄까지 적을 수 있게 해 줘.",
            ["운용부서", "예산과목", "청구일", "품명", "청구량", "단가", "금액", "용도"], [], Computed: ["금액"], Rows: ["품명", "청구량", "단가", "금액", "용도"]),
        // The same kind of request made by handing over the blank form itself, read from its HWP file.
        new("requisition-file", FromFileAsk("물품청구서.hwp"),
            ["품명", "청구량", "단가", "금액", "용도"], [], Computed: ["금액"], Rows: ["품명", "청구량", "단가", "금액", "용도"],
            From: new("goods/form.hwp", "물품청구서.hwp")),
        new("fire-check-file", FromFileAsk("소방시설 외관점검표.hwp"),
            ["대상명", "동호수", "점검일", "점검자", "전화번호"], [],
            From: new("fire_unit/form.hwp", "소방시설 외관점검표.hwp")),
        new("disclosure-file", FromFileAsk("정보공개청구서.hwp"),
            ["성명", "생년월일", "주소", "전화", "청구", "공개", "수령"], [],
            From: new("inforeq/form.hwp", "정보공개청구서.hwp")),
    ];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerOptions.Web) { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    [Fact]
    public async Task Measures_drafts_of_templates_asked_for()
    {
        var output = Environment.GetEnvironmentVariable("LOWLINE_CHAT_AUTHORING_MEASURE");
        Assert.SkipWhen(string.IsNullOrEmpty(output), "set LOWLINE_CHAT_AUTHORING_MEASURE to the file to write");
        var model = Environment.GetEnvironmentVariable("LOWLINE_CHAT_MODEL") ?? LocalModels.Offered[0];
        var generators = new LmSupplyGenerators();
        Assert.SkipUnless(generators.IsDownloaded(model), $"{model} is not on this computer");
        var ct = TestContext.Current.CancellationToken;
        await using var local = new LocalModels(generators);
        List<string> lines = [JsonSerializer.Serialize(new { model, template = Starter }, Json)];
        // `LOWLINE_CHAT_AUTHORING_CASES` (ids, comma-separated) asks only those.
        var only = Environment.GetEnvironmentVariable("LOWLINE_CHAT_AUTHORING_CASES")?.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var blankForms = Environment.GetEnvironmentVariable("LOWLINE_BLANK_FORMS");
        foreach (var c in Cases.Where(c => only is not { Length: > 0 } || only.Contains(c.Id)))
        {
            ChatSource? source = null;
            if (c.From is { } from)
            {
                if (string.IsNullOrEmpty(blankForms)) continue;
                var read = SourceFiles.Read(new SourceFileRequest(Path.Combine(blankForms, from.File)));
                Assert.True(read.Ok, $"{c.Id}: {read.Failure}");
                source = new ChatSource(from.Name, read.Markdown!);
            }
            var clock = Stopwatch.StartNew();
            var reply = await ChatAuthoring.ReplyAsync(
                new ChatAuthorRequest(ChatAuthoring.LocalPreset, null, null, model, Starter, [new ChatTurn("user", c.Ask)], source),
                local, TimeSpan.FromMinutes(5), ct);
            clock.Stop();
            Assert.True(reply.Ok, $"{c.Id}: {reply.Failure}");
            lines.Add(JsonSerializer.Serialize(new { c.Id, c.Ask, c.Fields, c.Judged, conditional = c.Conditional ?? [], computed = c.Computed ?? [], rows = c.Rows ?? [], reply = reply.Text, ms = clock.ElapsedMilliseconds }, Json));
        }
        await File.WriteAllLinesAsync(output!, lines, ct);
    }

    /// <summary>A draft the app asks for again: its request, the first reply, and what the app says is wrong with it.</summary>
    private sealed record AskedAgain(string Id, string Ask, string First, string Retry);

    /// <summary>
    /// The second time the chat asks, as it does when a draft has problems: the conversation as it went — the request and
    /// the first reply — and the app's message saying what is wrong (<c>retryMessage</c>), from the file the app's side
    /// wrote (<c>LOWLINE_CHAT_AUTHORING_RETRIES</c>). The replies go to <c>LOWLINE_CHAT_AUTHORING_SECOND</c> for the app's
    /// side to judge as what a person is shown.
    /// </summary>
    [Fact]
    public async Task Measures_second_drafts_after_the_app_says_what_is_wrong()
    {
        var retries = Environment.GetEnvironmentVariable("LOWLINE_CHAT_AUTHORING_RETRIES");
        var output = Environment.GetEnvironmentVariable("LOWLINE_CHAT_AUTHORING_SECOND");
        Assert.SkipWhen(string.IsNullOrEmpty(retries) || string.IsNullOrEmpty(output),
            "set LOWLINE_CHAT_AUTHORING_RETRIES and LOWLINE_CHAT_AUTHORING_SECOND to measure second drafts");
        var model = Environment.GetEnvironmentVariable("LOWLINE_CHAT_MODEL") ?? LocalModels.Offered[0];
        var generators = new LmSupplyGenerators();
        Assert.SkipUnless(generators.IsDownloaded(model), $"{model} is not on this computer");
        var ct = TestContext.Current.CancellationToken;
        await using var local = new LocalModels(generators);
        List<string> lines = [];
        foreach (var line in await File.ReadAllLinesAsync(retries!, ct))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var retry = JsonSerializer.Deserialize<AskedAgain>(line, Json)!;
            var clock = Stopwatch.StartNew();
            var reply = await ChatAuthoring.ReplyAsync(
                new ChatAuthorRequest(ChatAuthoring.LocalPreset, null, null, model, Starter,
                    [new ChatTurn("user", retry.Ask), new ChatTurn("assistant", retry.First), new ChatTurn("user", retry.Retry)]),
                local, TimeSpan.FromMinutes(5), ct);
            clock.Stop();
            Assert.True(reply.Ok, $"{retry.Id}: {reply.Failure}");
            lines.Add(JsonSerializer.Serialize(new { retry.Id, reply = reply.Text, ms = clock.ElapsedMilliseconds }, Json));
        }
        await File.WriteAllLinesAsync(output!, lines, ct);
    }
}
