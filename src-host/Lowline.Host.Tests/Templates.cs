using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lowline.Host.Tests;

/// <summary>
/// A template as the UI sends it, for a test that writes its fields by hand: with formdown's schema of those fields,
/// in the shape <c>getSchema</c> gives it — the type, a choice field's options, the template a field refers to.
/// </summary>
internal static class Templates
{
    public static TemplateSnapshot Of(
        string Ref, IReadOnlyList<TemplateField> Fields, IReadOnlyList<string>? Suggest = null, IReadOnlyDictionary<string, int>? Coarse = null) =>
        new(Ref, Fields, Suggest, Coarse, SchemaOf(Fields));

    public static JsonElement SchemaOf(IEnumerable<TemplateField> fields)
    {
        var schema = new JsonObject();
        foreach (var field in fields)
        {
            if (schema.ContainsKey(field.Name)) continue;
            var described = new JsonObject { ["type"] = field.Type, ["label"] = field.Name };
            // A checkbox holds a list when it has options: one written as holding a list has some, named or not.
            var options = field.Options ?? (field.Multiple ? ["?"] : []);
            if (options.Count > 0) described["options"] = new JsonArray([.. options.Select(o => (JsonNode)new JsonObject { ["value"] = o })]);
            if (field.Reference is not null) described["relation"] = new JsonObject { ["target"] = field.Reference, ["type"] = "fk" };
            schema[field.Name] = described;
        }
        return JsonSerializer.SerializeToElement(schema);
    }
}
