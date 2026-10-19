using Microsoft.Extensions.AI;

namespace Lowline.Host;

/// <summary>
/// What the shell asks to turn a question about a template's documents into a count to make: the model set up (the key
/// read for this one request), the template's source, the question, the fields of the documents its fields refer to
/// that can be counted by too (<see cref="Referred"/>), and the templates whose documents refer to its own
/// (<see cref="Referring"/>) — names and choices, never a value.
/// </summary>
public sealed record ChatQueryRequest(
    string Preset, string? BaseUrl, string? ApiKey, string Model, string Template, string Question,
    IReadOnlyList<ReferredColumn>? Referred = null, IReadOnlyList<ReferringTemplate>? Referring = null);

/// <summary>
/// A field of the documents a field of the template refers to, as a column to count by: `<field>.<its field>`, its type,
/// and its choices when it has them.
/// </summary>
public sealed record ReferredColumn(string Name, string Type, IReadOnlyList<string>? Options = null);

/// <summary>
/// A template whose documents refer to the template asked about — inspections naming their business — as a question may
/// count them: its name as the vault shows it, its fields that name the asked template's documents (<see cref="Via"/>),
/// and the columns its documents are counted by.
/// </summary>
public sealed record ReferringTemplate(string Name, IReadOnlyList<string> Via, IReadOnlyList<ReferredColumn> Columns);

/// <summary>
/// Asking the vault: the model turns a question into what to count — which fields to count by, which documents to keep,
/// which number field to add up — and nothing more. It is given the template, never a document or a value; the counts, and the documents behind each,
/// come from the vault (<see cref="VaultProjection.AggregateAsync"/>), so an answer's numbers and evidence are the
/// vault's, never the model's. What the plan is worth is the app's to judge: it checks it against the template's fields.
/// </summary>
public static class ChatQuery
{
    /// <summary>
    /// What the model is told: what to answer with, the day it is — for "지난달" and the like — the template, the fields
    /// of the documents it refers to that can be counted by, and the templates whose documents refer to its own.
    /// </summary>
    public static string Instructions(
        string template, DateOnly today, IReadOnlyList<ReferredColumn>? referred = null, IReadOnlyList<ReferringTemplate>? referring = null) => $$"""
        당신은 Lowline 기록에 대한 질문을 「무엇을 셀지」로 바꾸는 도우미입니다. 기록을 직접 보지 않습니다 — 세는 일은 Lowline이 합니다.

        답하는 법:
        - JSON 객체 하나만 ```json 코드 블록에 담아 답합니다. 다른 말은 쓰지 않습니다.
        - `groupBy`: 무엇별로 셀지 — 칸 이름의 배열(`@` 없이). 전체 건수만 물으면 `[]`.
        - `filters`: 어떤 기록만 셀지 — `{"field": 칸 이름, "op": 조건, "value": 값}`의 배열. 조건은 `equal`(같음), `contains`(글에 포함), `atLeast`(이상), `atMost`(이하), `empty`(비어 있음, 값 없이), `period`(날짜 칸의 기간).
        - `filters`에는 질문이 말한 조건만 넣습니다. 질문이 거르라고 하지 않으면 `[]`입니다 — 「가장 많은」「~별」은 거르는 조건이 아닙니다.
        - 「오늘·어제·이번 주·지난주·이번 달·지난달·올해·작년」은 날짜를 계산하지 말고 `period`로 씁니다 — 값은 `today`, `yesterday`, `this-week`, `last-week`, `this-month`, `last-month`, `this-year`, `last-year` 중 하나. 날짜는 Lowline이 셉니다.
        - 달 하나나 해 하나를 말하면 그것도 `period`로 씁니다 — 값은 달이면 `YYYY-MM`, 해면 `YYYY`. 오늘은 {{today:yyyy-MM-dd}}이니 「작년 12월」은 `{{today.Year - 1}}-12`, 「3월」은 `{{today.Year}}-03`입니다.
        - `period`의 값은 위의 낱말 하나, `YYYY-MM` 하나, `YYYY` 하나 중 하나입니다. 둘을 섞어 쓰지 않습니다.
        - 「9월 1일부터」처럼 날을 직접 말한 질문만 `atLeast`·`atMost`에 `YYYY-MM-DD`로 씁니다(연도를 말하지 않으면 올해).
        - `top`: 「상위 3개」처럼 몇 개만 물으면 그 수. 아니면 넣지 않습니다.
        - `sum`: 「합계·총액·얼마」처럼 숫자 칸(`number`)의 값을 더하라고 할 때만 그 숫자 칸 이름 하나. 건수는 함께 셉니다. 「몇 건·몇 번·몇 개·몇 곳·몇 대」는 건수를 묻는 것이니 `sum`을 넣지 않습니다.
        - 칸 이름과 선택지는 서식에 있는 그대로 씁니다. 질문이 선택지의 값을 말하면(그 뜻이나 다른 말로라도) 그 칸에 `equal`로 거릅니다.
        - 「A별 B」처럼 칸 둘로 나누어 물으면 `groupBy`에 둘 다 넣습니다. 질문이 값을 정해 말하지 않은 칸에는 `equal`을 걸지 않습니다.
        - Lowline은 건수와 숫자 칸의 합계를 셉니다. 비율·평균을 물으면 `unanswerable`로 답합니다.
        - 질문이 서식의 어느 칸에도 적히지 않는 것을 물으면 비슷한 다른 칸으로 바꿔 세지 말고 `{"unanswerable": "이유"}`로 답합니다.

        예: 칸이 `원인`(부품·설정·사용자)·`방문일`(날짜)·`지역`(글)·`수리비`(숫자)인 서식에서
        - 「원인이 가장 많은 것 3개?」 — 거르는 조건이 없다.
        ```json
        {"groupBy": ["원인"], "filters": [], "top": 3}
        ```
        - 「지난달 원인 상위 2개?」
        ```json
        {"groupBy": ["원인"], "filters": [{"field": "방문일", "op": "period", "value": "last-month"}], "top": 2}
        ```
        - 「원인별 수리비 합계는?」 — 더하는 것은 숫자 칸 `수리비`.
        ```json
        {"groupBy": ["원인"], "filters": [], "sum": "수리비"}
        ```
        - 「고객이 가장 많이 불평한 점은?」 — 불평을 적는 칸이 없다. `원인`은 고장의 원인이지 불평이 아니다.
        ```json
        {"unanswerable": "불평을 적는 칸이 없습니다"}
        ```

        서식:
        ```formdown
        {{template}}
        ```{{Referred(referred)}}{{Referring(referring)}}
        """;

    /// <summary>
    /// The columns a field of the template brings from the documents it refers to — said apart, so a question about the
    /// customer's region counts by it — or nothing when no field refers to another template's documents.
    /// </summary>
    private static string Referred(IReadOnlyList<ReferredColumn>? referred) => referred is not { Count: > 0 }
        ? ""
        : "\n" + $"""
            다른 서식의 문서를 가리키는 칸(`-> 서식`)은 그 문서의 칸으로도 셀 수 있습니다. 이름은 `칸.그 문서의 칸`입니다:
            {string.Join("\n", referred.Select(c => $"- {Column(c)}"))}
            가리키는 문서 하나로 거를 때는 그 칸(예: `{referred[0].Name[..referred[0].Name.IndexOf('.')]}`)에 `equal`과 그 문서의 이름을 씁니다.
            """;

    /// <summary>
    /// The templates whose documents refer to the template's — said with the fields that do and what their documents are
    /// counted by, and how to count them by the document each names — or nothing when none does.
    /// </summary>
    private static string Referring(IReadOnlyList<ReferringTemplate>? referring) => referring is not { Count: > 0 }
        ? ""
        : "\n" + $$"""
            이 서식의 문서를 가리키는 다른 서식이 있습니다. 그 서식의 기록을 세려면 `"of"`에 그 서식의 이름을 넣고, 그 서식의 칸 이름을 씁니다:
            {{string.Join("\n", referring.Select(t => $"- `{t.Name}` — {string.Join(", ", t.Via.Select(v => $"`{v}`"))} 칸이 이 서식의 문서를 가리킵니다. 셀 수 있는 칸: {string.Join(", ", t.Columns.Select(Column))}"))}}
            이 서식의 문서마다 그것을 가리키는 기록을 세려면(「{{referring[0].Name}} 기록이 많은 것」) 가리키는 칸으로 묶습니다: `{"of": "{{referring[0].Name}}", "groupBy": ["{{referring[0].Via[0]}}"]}`.
            세는 것이 그 서식의 기록이면 `of`를 쓰고, 이 서식의 문서 자체이면 쓰지 않습니다: 「{{referring[0].Name}} 기록이 가장 많은 3개」는 `{"of": "{{referring[0].Name}}", "groupBy": ["{{referring[0].Via[0]}}"], "top": 3}`, 이 서식의 문서가 칸 값마다 몇 개인지는 `of` 없이 이 서식의 칸으로 묶습니다.
            {{ReferringByField(referring[0])}}{{ReferringSum(referring[0])}}
            """;

    /// <summary>
    /// How to count the referring template's records by a field of the document each names — "accidents by aircraft
    /// kind": the records are counted, so `of`, by the column the reference brings. Nothing when the template names none.
    /// </summary>
    private static string ReferringByField(ReferringTemplate referring) =>
        referring.Columns.Where(c => c.Name.StartsWith(referring.Via[0] + ".", StringComparison.Ordinal))
            .OrderByDescending(c => c.Options is { Count: > 0 }).FirstOrDefault() is { } column
            ? $$"""이 서식의 칸 값마다 {{referring.Name}} 기록이 몇 건인지(「{{column.Name[(column.Name.IndexOf('.') + 1)..]}}별 {{referring.Name}} 수」)는 그 기록을 세므로 `of`를 쓰고, 가리키는 칸을 거친 이름으로 묶습니다: `{"of": "{{referring.Name}}", "groupBy": ["{{column.Name}}"]}`."""
            : "";

    /// <summary>
    /// How to add up a number field of the referring template's records per document of this one — a request's items'
    /// amounts: `of`, by the field naming the document, `sum` its number field. Nothing when its records have none.
    /// </summary>
    private static string ReferringSum(ReferringTemplate referring) =>
        referring.Columns.FirstOrDefault(c => IsNumber(c) && !c.Name.Contains('.')) is { } number
            ? "\n" + $$"""이 서식의 문서마다 {{referring.Name}} 기록의 숫자 칸을 더하려면(「{{number.Name}} 합계」) `sum`을 함께 씁니다: `{"of": "{{referring.Name}}", "groupBy": ["{{referring.Via[0]}}"], "sum": "{{number.Name}}"}`."""
            : "";

    private static bool IsNumber(ReferredColumn c) => c.Type is "number" or "range";

    /// <summary>A column as the model is told it: its name, and its choices or that it is a date or a number.</summary>
    private static string Column(ReferredColumn c) =>
        $"`{c.Name}`" + (c.Options is { Count: > 0 } options ? $" (선택지: {string.Join(", ", options)})"
            : c.Type is "date" or "datetime-local" ? " (날짜)" : IsNumber(c) ? " (숫자)" : "");

    /// <summary>What to count for <paramref name="request"/>'s question, as the model's reply — or why there is none.</summary>
    public static Task<ChatReply> ReplyAsync(ChatQueryRequest request, LocalModels local, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Question)) return Task.FromResult(new ChatReply(false, null, ModelFailure.Invalid, null));
        List<ChatMessage> messages =
        [
            new(ChatRole.System, Instructions(request.Template, DateOnly.FromDateTime(DateTime.Now), request.Referred, request.Referring)),
            new(ChatRole.User, request.Question),
        ];
        return ChatAuthoring.SendAsync(new ChatModel(request.Preset, request.BaseUrl, request.ApiKey, request.Model), messages, local, timeout, cancellationToken);
    }
}
