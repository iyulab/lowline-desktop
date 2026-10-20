using System.Net.Http;
using System.Net.Sockets;
using IronProw.Core;
using IronProw.IronHive;
using LMSupply.Exceptions;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;

namespace Lowline.Host;

/// <summary>One turn of the chat beside a template: who said it (<c>user</c> or <c>assistant</c>) and what.</summary>
public sealed record ChatTurn(string Role, string Text);

/// <summary>
/// What the shell asks for a chat reply about a template: the endpoint and model the person set up, the key the shell
/// read from the credential store for this one request (never kept here), the template's source as it stands in the
/// editor, the conversation so far, the person's last message last — and the blank form the person handed the chat
/// to start from, when there is one.
/// </summary>
public sealed record ChatAuthorRequest(string Preset, string? BaseUrl, string? ApiKey, string Model, string Template, IReadOnlyList<ChatTurn> Turns, ChatSource? Source = null);

/// <summary>A blank form the person picked, as <see cref="SourceFiles"/> read it: the file's name and its Markdown.</summary>
public sealed record ChatSource(string Name, string Markdown);

/// <summary>The model's reply; or, when there is none, why — as one of <see cref="ModelFailure"/>'s, never the provider's words.</summary>
public sealed record ChatReply(bool Ok, string? Text, string? Failure, int? StatusCode);

/// <summary>
/// The model a request is for: an IronProw preset — or <see cref="ChatAuthoring.LocalPreset"/>, a model on this
/// computer — its address when not the preset's own, the key the shell read for this one request, and the model.
/// </summary>
public sealed record ChatModel(string Preset, string? BaseUrl, string? ApiKey, string Model);

/// <summary>
/// The chat that writes templates: what the model is told a Lowline template is, and one reply to the conversation.
/// What the reply's draft is worth — whether it parses, what is wrong in it — is the app's to judge: it shows the draft
/// in the editor and the person saves it.
/// </summary>
public static class ChatAuthoring
{
    /// <summary>How long a reply may take: under the shell's own limit for a request (two minutes), so the app hears the kind.</summary>
    public static readonly TimeSpan Deadline = TimeSpan.FromSeconds(100);

    /// <summary>What the model is told before the conversation: how a Lowline template is written, and the one it works on.</summary>
    public static string Instructions(string template, ChatSource? source = null) => $"""
        당신은 Lowline 서식을 함께 쓰는 도우미입니다. 서식은 Formdown 문법의 마크다운 파일 하나이고, 사람이 그 서식으로 문서를 채웁니다.

        서식의 규칙:
        - 맨 앞 front matter에 `id`(영문 소문자·숫자·하이픈)와 `version`(정수)이 있습니다. 사람이 바꾸라고 하지 않으면 `id`와 `version`은 그대로 둡니다.
        - 칸 하나는 `@칸이름: [형식 속성]`으로 씁니다. 형식과 속성은 반드시 대괄호 안에 씁니다(`@처리_기한: [date]`, `@처리_기한: date`는 칸이 되지 않습니다).
        - 형식: `text`, `textarea rows=3`, `number`, `date`, `email`, `tel`, `select options="가,나,다"`, `radio options="가,나"`, 여러 개 고르기 `checkbox options="가,나"`, 예/아니오 하나 `checkbox content="설명"`.
        - 문장 안의 짧은 글 칸은 `제목: ___@제목`처럼 씁니다.
        - 칸 이름은 한 단어입니다. 띄어쓰기 대신 밑줄(`재현_절차`)을 쓰고, 한 서식에서 두 번 쓰지 않으며, `template`과 `lowline`은 쓰지 않습니다.
        - 다른 서식의 문서를 가리키는 칸은 `@고객 -> customer: [select]`처럼 그 서식의 id를 화살표 뒤에 씁니다.
        - 다른 칸의 답이 어떠할 때만 보이거나 꼭 써야 하는 칸("~일 때만", "~이면")은 속성 `visible-if="칸이름=값"`과 `required-if="칸이름=값"`을 씁니다.
        - 다른 칸의 숫자로 셈하는 칸(금액 = 수량 × 단가, 합계)은 사람이 치지 않습니다 — `number`에 `compute="수량 * 단가"`를 씁니다(숫자·칸 이름·`+ - * /`·괄호). 조건(`visible-if`)으로 쓰지 않습니다.
        - 판단 칸은 사람이 판단해 고르는 칸입니다. 닫힌 선택지(`select`/`radio`)로 만들고, 그 이름을 front matter의 `lowline:` 아래 `suggest:` 목록에 넣습니다. Lowline은 사람이 이전에 확정한 문서들에서 판단 칸의 값을 제안하고, 확정은 사람이 합니다.
        - 같은 칸 묶음이 여러 줄 되풀이되는 표(품목 열다섯 줄처럼)는 칸에 번호를 붙여 펼치지 않습니다(`품목_1_품명`은 쓰지 않습니다). 그 한 줄을 서식 하나로 따로 씁니다 — 줄마다 문서 하나가 되고, 이 서식의 문서를 가리킵니다. 줄 서식은 두 번째 ```formdown 코드 블록에 담습니다: 새 `id`, 맨 앞 칸은 이 서식의 문서를 가리키는 칸(`@청구서 -> 이 서식의 id: [select]`), 그다음 한 줄의 칸들. 이 서식에는 그 줄들을 넣지 않습니다.

        판단 칸이 둘 있고, 긴급도가 높을 때만 정지 시간을 받는 서식의 예:
        ```formdown
        ---
        id: repair-request
        version: 1
        lowline:
          suggest: [긴급도, 담당_팀]
        ---
        # 수리 요청

        @요청자: [text]
        @증상: [textarea rows=3]
        @접수일: [date]
        @긴급도: [radio options="낮음,보통,높음"]
        @담당_팀: [select options="설비,전기,시설"]
        @정지_시간: [number visible-if="긴급도=높음" required-if="긴급도=높음"]
        ```

        주문마다 품목이 여러 줄인 서식의 예 — 줄은 서식 하나로 따로, 두 블록:
        ```formdown
        ---
        id: order
        version: 1
        ---
        # 주문서

        @주문처: [text]
        @주문일: [date]
        ```
        ```formdown
        ---
        id: order-item
        version: 1
        ---
        # 주문 품목

        @주문서 -> order: [select]
        @품명: [text]
        @수량: [number]
        @단가: [number]
        @금액: [number compute="수량 * 단가"]
        ```

        답하는 법:
        - 서식을 바꾸라는 말이면, 한두 문장으로 무엇을 바꿨는지 말하고 바뀐 서식 전체를 ```formdown 코드 블록 하나에 담습니다(되풀이되는 줄이 있으면 줄 서식 블록이 하나 더). 부분만 보내지 않습니다.
        - 묻기만 하면(무엇인지, 왜인지, 어떻게 하는지) 말로만 답하고 서식을 보내지 않습니다.
        - 요청한 것만 바꿉니다. 요청하지 않은 칸·선택지·front matter(`lowline.suggest` 포함)는 있는 그대로 둡니다. 사람이 쓴 칸 이름과 값은 바꾸지 않습니다.
        - 저장은 사람이 합니다. 저장했다고 말하지 않습니다.

        지금 서식:
        ```formdown
        {template}
        ```
        """ + (source is null ? "" : SourceSection(source));

    /// <summary>The blank form the person handed the chat, after the instructions: what it is and how to carry it over.</summary>
    static string SourceSection(ChatSource source) => $"""


        사람이 준 빈 서식 «{source.Name}» — 종이 서식 파일을 마크다운으로 읽은 것입니다(표는 마크다운 표, 칸 경계가 어긋날 수 있습니다):
        ```markdown
        {source.Markdown}
        ```
        이 빈 서식으로 만들어 달라고 하면, 지금 서식의 본문을 빈 서식대로 새로 씁니다:
        - 지금 서식에 있던 칸 가운데 빈 서식에 없는 칸(새 서식의 `제목`·`상태`·`메모` 같은)은 뺍니다. front matter의 `id`와 `version`은 그대로 둡니다.
        - 서식 제목(`# 제목`)은 빈 서식의 제목을 씁니다.
        - 사람이 채우는 빈칸마다 칸 하나를 위 규칙대로 만듭니다. 칸 이름은 그 빈칸 옆에 적힌 이름을 그대로 씁니다(띄어쓰기는 밑줄로). 칸 줄은 `@`로 시작합니다 — 빈 서식의 표 모양(`|`)을 서식에 옮겨 쓰지 않습니다.
        - `□`·`[ ]` 같은 고르는 표시가 붙은 글은 선택지입니다 — 하나만 고르면 `radio`, 여럿이면 `checkbox`.
        - 점검표처럼 항목마다 같은 선택지(«□ 정상 □ 불량»)가 붙은 표는, 항목마다 그 선택지의 `radio` 칸을 하나씩 만듭니다(칸 이름은 항목 이름). 항목들을 긴 글 칸 하나로 합치지 않습니다.
        - 같은 칸 묶음을 줄마다 새로 적는 표(일련번호 1, 2, 3…이 붙은 빈 줄들)는 위 규칙대로 줄 서식을 두 번째 ```formdown 블록에 따로 씁니다.
        - 법령 이름·서식 번호·개정일 머리말, 결재란, 서명·날인 칸(«(인 또는 서명)»), 작성 안내문은 칸으로 만들지 않습니다 — 확정은 사람이 Lowline에서 하고, 서명은 출력한 종이에 합니다.
        - 빈 서식에는 판단 칸 표시가 없습니다. 사람이 말하지 않으면 `lowline:`·`suggest:`를 넣지 않습니다.
        """ + string.Concat(SourceFiles.RepeatedRows(source.Markdown).Select(RowsNote));

    /// <summary>A table of rows to add one after another, found in the blank form: said outright, with its columns.</summary>
    static string RowsNote(IReadOnlyList<string> columns) => $"""

        - 이 빈 서식에서 «{string.Join(" · ", columns)}» 표는 번호 붙은 빈 줄을 하나씩 채우는 표입니다. 이 서식에는 그 칸을 넣지 않습니다(`{columns[0]}_1_…`처럼 번호로 펼치지 않습니다). 그 한 줄을 줄 서식으로 두 번째 ```formdown 블록에 씁니다 — 맨 앞 칸은 이 서식의 문서를 가리키는 칸, 그다음 «{string.Join(" · ", columns.Skip(1))}»(번호 칸은 빼도 됩니다).
        """;

    /// <summary>The preset of the model running on this computer (<see cref="LocalModels"/>) — Lowline's, not IronProw's.</summary>
    public const string LocalPreset = "local";

    /// <summary>
    /// One reply to <paramref name="request"/>'s conversation, as long as <paramref name="timeout"/> — on
    /// <paramref name="local"/> for <see cref="LocalPreset"/>, loading the model from what is here when it is not running.
    /// </summary>
    public static Task<ChatReply> ReplyAsync(ChatAuthorRequest request, LocalModels local, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (request.Turns.Count == 0) return Task.FromResult(new ChatReply(false, null, ModelFailure.Invalid, null));
        List<ChatMessage> messages = [new(ChatRole.System, Instructions(request.Template, request.Source))];
        messages.AddRange(request.Turns.Select(t => new ChatMessage(t.Role == "assistant" ? ChatRole.Assistant : ChatRole.User, t.Text)));
        return SendAsync(new ChatModel(request.Preset, request.BaseUrl, request.ApiKey, request.Model), messages, local, timeout, cancellationToken);
    }

    /// <summary>
    /// <paramref name="messages"/> to <paramref name="model"/>, as long as <paramref name="timeout"/>: its reply, or why
    /// there is none. A model on this computer is taken from what is here; an endpoint goes through IronProw's presets.
    /// </summary>
    public static async Task<ChatReply> SendAsync(ChatModel model, IList<ChatMessage> messages, LocalModels local, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(model.Model)) return new ChatReply(false, null, ModelFailure.Invalid, null);

        using var within = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        within.CancelAfter(timeout);
        try
        {
            if (model.Preset == LocalPreset)
            {
                var (text, failure) = await local.ReplyAsync(model.Model.Trim(), messages, within.Token);
                return new ChatReply(failure is null, text, failure, null);
            }
            return await RemoteAsync(model, messages, within.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ChatReply(false, null, ModelFailure.Timeout, null);
        }
        catch (Exception e) when (e is not OperationCanceledException && model.Preset == LocalPreset)
        {
            // The model's own server is on this computer: whatever broke, it did not run the request.
            return new ChatReply(false, null, e is ModelNotFoundException ? ModelFailure.NotDownloaded : ModelFailure.NotStarted, null);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            var (failure, status) = Failure(e);
            return new ChatReply(false, null, failure, status);
        }
    }

    /// <summary>A reply from an endpoint the person named — a server nearby or a company's service — through IronProw's presets.</summary>
    private static async Task<ChatReply> RemoteAsync(ChatModel model, IList<ChatMessage> messages, CancellationToken cancellationToken)
    {
        var endpoint = new ByoEndpoint(model.Preset, Blank(model.BaseUrl), Blank(model.ApiKey));
        if (ByoPresets.Validate(endpoint) is not null) return new ChatReply(false, null, ModelFailure.Invalid, null);

        var services = new ServiceCollection();
        services.AddIronProw().AddIronHiveByo("chat", 0, model.Model.Trim(), endpoint);
        await using var provider = services.BuildServiceProvider();
        var chat = provider.GetRequiredService<IChatClient>();
        var response = await chat.GetResponseAsync(messages, cancellationToken: cancellationToken);
        return new ChatReply(true, response.Text, null, null);
    }

    /// <summary>Why a call failed, as the probe words it: an HTTP answer by its status, a connection by what the socket said.</summary>
    public static (string Failure, int? StatusCode) Failure(Exception e)
    {
        if (new IronHiveHttpFailureReader().Read(e) is { } http)
            return (http.StatusCode is 401 or 403 ? ModelFailure.Unauthorized : ModelFailure.HttpStatus, http.StatusCode);
        for (var inner = e; inner is not null; inner = inner.InnerException)
        {
            if (inner is SocketException socket)
                return (socket.SocketErrorCode switch
                {
                    SocketError.ConnectionRefused => ModelFailure.Refused,
                    SocketError.HostNotFound or SocketError.NoData => ModelFailure.HostNotFound,
                    SocketError.NetworkUnreachable or SocketError.HostUnreachable or SocketError.NetworkDown => ModelFailure.Unreachable,
                    SocketError.TimedOut => ModelFailure.Timeout,
                    _ => ModelFailure.Transport,
                }, null);
            if (inner is TimeoutException) return (ModelFailure.Timeout, null);
            if (inner is HttpRequestException { StatusCode: { } code })
                return ((int)code is 401 or 403 ? ModelFailure.Unauthorized : ModelFailure.HttpStatus, (int)code);
        }
        return (ModelFailure.Transport, null);
    }

    private static string? Blank(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();
}
