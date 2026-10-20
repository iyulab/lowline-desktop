namespace Lowline.Host.Tests;

/// <summary>Blank form files read into Markdown for the chat that writes templates.</summary>
public sealed class SourceFilesTests
{
    [Fact]
    public void Reads_only_hwp_hwpx_and_pdf()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.docx");
        File.WriteAllText(path, "not read");
        try
        {
            Assert.Equal((false, SourceFileFailure.Unsupported), Read(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Says_a_file_that_is_not_there_or_not_what_its_name_says_could_not_be_read()
    {
        Assert.Equal((false, SourceFileFailure.Unreadable), Read(Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.hwp")));

        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllText(path, "plain text, no PDF");
        try
        {
            Assert.Equal((false, SourceFileFailure.Unreadable), Read(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Reads_a_pdf_into_markdown_with_the_file_name()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.pdf");
        File.WriteAllBytes(path, MinimalPdf("Requester name: ____"));
        try
        {
            var reply = SourceFiles.Read(new SourceFileRequest(path));
            Assert.Equal((true, Path.GetFileName(path), null), (reply.Ok, reply.Name, reply.Failure));
            Assert.Contains("Requester name", reply.Markdown);
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>A one-page PDF showing <paramref name="text"/> (ASCII) in a standard font — the least a reader must read.</summary>
    internal static byte[] MinimalPdf(string text)
    {
        var content = $"BT /F1 12 Tf 72 720 Td ({text}) Tj ET";
        string[] objects =
        [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            $"<< /Length {content.Length} >>\nstream\n{content}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];
        var pdf = new System.Text.StringBuilder("%PDF-1.4\n");
        var offsets = new List<int>();
        for (var i = 0; i < objects.Length; i++)
        {
            offsets.Add(pdf.Length);
            pdf.Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }
        var xref = pdf.Length;
        pdf.Append($"xref\n0 {objects.Length + 1}\n0000000000 65535 f \n");
        foreach (var offset in offsets) pdf.Append($"{offset:D10} 00000 n \n");
        pdf.Append($"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return System.Text.Encoding.ASCII.GetBytes(pdf.ToString());
    }

    /// <summary>
    /// Real blank forms, when <c>LOWLINE_BLANK_FORMS</c> names a folder of them (one folder per form, holding
    /// <c>form.hwp</c> and its <c>f.pdf</c>): each read into Markdown with its table rows.
    /// </summary>
    [Fact]
    public void Reads_blank_forms_with_their_tables()
    {
        var root = Environment.GetEnvironmentVariable("LOWLINE_BLANK_FORMS");
        Assert.SkipWhen(string.IsNullOrEmpty(root), "LOWLINE_BLANK_FORMS is not set");

        foreach (var form in Directory.GetDirectories(root!))
        {
            foreach (var file in new[] { "form.hwp", "f.pdf" }.Select(f => Path.Combine(form, f)).Where(File.Exists))
            {
                var reply = SourceFiles.Read(new SourceFileRequest(file));
                Assert.True(reply.Ok, $"{file}: {reply.Failure}");
                var rows = reply.Markdown!.Split('\n').Count(l => l.StartsWith('|'));
                TestContext.Current.TestOutputHelper?.WriteLine($"{Path.GetFileName(form)}/{Path.GetFileName(file)}: {reply.Markdown.Length} chars, {rows} table lines");
                Assert.True(rows > 0, $"{file} has no table");
            }
        }
    }

    private static (bool, string?) Read(string path)
    {
        var reply = SourceFiles.Read(new SourceFileRequest(path));
        return (reply.Ok, reply.Failure);
    }
}
