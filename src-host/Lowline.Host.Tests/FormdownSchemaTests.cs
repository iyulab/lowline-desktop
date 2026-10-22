using System.Text.Json;
using Formbase.Core.Primitives;
using Formbase.Core.Schema;
using Formbase.Formdown;

namespace Lowline.Host.Tests;

/// <summary>
/// How a template's columns are typed: Formbase's formdown adapter reads the schema the UI sends (formdown's
/// <c>getSchema</c>), so a formdown type has one reading. Checked on every kind of field a template can hold, as
/// formdown wrote their schema.
/// </summary>
public sealed class FormdownSchemaTests
{
    /// <summary>formdown core's <c>getSchema</c> of one field of each kind (drawing-only keys left out).</summary>
    private const string EveryKind = """
        {"금액":{"type":"number","label":"금액 원","position":1},"비율":{"type":"range","label":"비율","position":2},
         "날짜":{"type":"date","label":"날짜","position":3},"일시":{"type":"datetime-local","label":"일시","position":4},
         "여부":{"type":"checkbox","label":"여부","position":5},
         "태그":{"type":"checkbox","label":"태그","position":6,"options":[{"value":"a"},{"value":"b"}]},
         "분류":{"type":"select","label":"분류","position":7,"options":[{"value":"x"},{"value":"y"}]},
         "등급":{"type":"radio","label":"등급","position":8,"options":[{"value":"상"},{"value":"하"}]},
         "고객":{"type":"select","label":"고객","position":9,"relation":{"target":"customer","type":"fk"}},
         "메모":{"type":"textarea","label":"메모","position":10},"제목":{"type":"text","label":"제목","position":11},
         "첨부":{"type":"file","label":"첨부","position":12},"시각":{"type":"time","label":"시각","position":13},
         "전자우편":{"type":"email","label":"전자우편","position":14},"달":{"type":"month","label":"달","position":16},
         "켬":{"type":"checkbox","label":"켬","position":15,"switch":true}}
        """;

    [Fact]
    public void Each_kind_of_field_is_the_column_type_the_projection_reads_it_as()
    {
        var hints = FormdownAdapter.AdaptSchema(EveryKind, FormTypeRef.Create("t@1"), "t_1").Hints.Fields.ToDictionary(f => f.Name);

        // A number is a decimal whatever its step — values arrive from outside the form too (imports, other programs).
        Assert.Equal(ColumnType.Decimal, hints["금액"].Type);
        Assert.Equal(ColumnType.Decimal, hints["비율"].Type);
        // A date, or a date and time, without a zone: ranges compare dates rather than text.
        Assert.Equal(ColumnType.Timestamp, hints["날짜"].Type);
        Assert.Equal(ColumnType.Timestamp, hints["일시"].Type);
        Assert.Equal(ColumnType.Boolean, hints["여부"].Type);
        Assert.Equal(ColumnType.Boolean, hints["켬"].Type);
        // A checkbox with options holds a list.
        Assert.Equal(ColumnType.Jsonb, hints["태그"].Type);
        foreach (var text in new[] { "분류", "등급", "고객", "메모", "제목", "첨부", "시각", "전자우편", "달" })
            Assert.Equal(ColumnType.Text, hints[text].Type);
    }

    [Fact]
    public void A_template_counts_by_columns_declared_from_the_schema_it_was_sent()
    {
        var customer = new TemplateSnapshot("customer@2", [new TemplateField("등급", "number")],
            Schema: JsonDocument.Parse("""{"등급":{"type":"number","label":"고객 등급"}}""").RootElement);
        var order = new TemplateSnapshot("order@1", [new TemplateField("금액", "number"), new TemplateField("고객", "select", Reference: "customer")],
            Schema: JsonDocument.Parse("""{"금액":{"type":"number","label":"금액 원"},"고객":{"type":"select","relation":{"target":"customer","type":"fk"}}}""").RootElement);

        var columns = VaultProjection.CountColumnsOf(order, [customer, order]).ToDictionary(c => c.Name);

        Assert.Equal((ColumnType.Decimal, "금액 원"), (columns["금액"].Hint.Type, columns["금액"].Hint.BusinessName));
        Assert.Equal(ColumnType.Text, columns["고객"].Hint.Type);
        // A field of the document a field names: typed as that template declares it, read through the reference.
        var through = columns["고객.등급"].Hint;
        Assert.Equal((ColumnType.Decimal, FieldBinding.Reference, "고객"), (through.Type, through.Binding, through.Target!.ViaField));
    }

    [Fact]
    public void A_template_sent_without_its_schema_is_refused()
    {
        var bare = new TemplateSnapshot("bare@1", [new TemplateField("제목", "text")]);
        Assert.Throws<InvalidOperationException>(() => VaultProjection.CountColumnsOf(bare, [bare]));
    }

    [Fact]
    public void A_column_is_headed_by_the_label_its_author_wrote()
    {
        var hints = FormdownAdapter.AdaptSchema(EveryKind, FormTypeRef.Create("t@1"), "t_1").Hints.Fields.ToDictionary(f => f.Name);
        Assert.Equal("금액 원", hints["금액"].BusinessName);
    }
}
