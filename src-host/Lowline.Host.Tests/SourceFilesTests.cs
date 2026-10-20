namespace Lowline.Host.Tests;

/// <summary>Blank form files read into Markdown for the chat that writes templates.</summary>
public sealed class SourceFilesTests
{
    [Fact]
    public void Reads_only_hwp_hwpx_pdf_docx_and_xlsx()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.txt");
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

        foreach (var extension in new[] { "pdf", "docx" })
        {
            var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.{extension}");
            File.WriteAllText(path, "plain text, not what the name says");
            try
            {
                Assert.Equal((false, SourceFileFailure.Unreadable), Read(path));
            }
            finally
            {
                File.Delete(path);
            }
        }
    }

    [Fact]
    public void Reads_a_word_form_with_its_table()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.docx");
        File.WriteAllBytes(path, MinimalDocx("물품 청구서", [["일련번호", "품명", "청구량"], ["1", "", ""], ["2", "", ""], ["3", "", ""]]));
        try
        {
            var reply = SourceFiles.Read(new SourceFileRequest(path));
            Assert.True(reply.Ok, reply.Failure);
            Assert.Contains("물품 청구서", reply.Markdown);
            Assert.Equal([["일련번호", "품명", "청구량"]], SourceFiles.RepeatedRows(reply.Markdown!));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Reads_an_excel_form_with_its_rows()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.xlsx");
        File.WriteAllBytes(path, MinimalXlsx([["일련번호", "품명", "청구량"], ["1", "", ""], ["2", "", ""], ["3", "", ""]]));
        try
        {
            var reply = SourceFiles.Read(new SourceFileRequest(path));
            Assert.True(reply.Ok, reply.Failure);
            Assert.Contains("품명", reply.Markdown);
            Assert.Equal([["일련번호", "품명", "청구량"]], SourceFiles.RepeatedRows(reply.Markdown!));
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>A workbook of one sheet holding <paramref name="rows"/>, every cell a string written in place.</summary>
    internal static byte[] MinimalXlsx(string[][] rows)
    {
        static string Column(int i) => ((char)('A' + i)).ToString();
        var sheet = string.Concat(rows.Select((r, y) => $"<row r=\"{y + 1}\">"
            + string.Concat(r.Select((c, x) => c.Length == 0 ? "" : $"<c r=\"{Column(x)}{y + 1}\" t=\"inlineStr\"><is><t>{System.Security.SecurityElement.Escape(c)}</t></is></c>"))
            + "</row>"));
        return Zip(new()
        {
            ["[Content_Types].xml"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
                + "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>",
            ["_rels/.rels"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>",
            ["xl/workbook.xml"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" "
                + "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"청구서\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
            ["xl/_rels/workbook.xml.rels"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>",
            ["xl/worksheets/sheet1.xml"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>"
                + sheet + "</sheetData></worksheet>",
        });
    }

    /// <summary>A zip package of <paramref name="parts"/>, by name.</summary>
    private static byte[] Zip(Dictionary<string, string> parts)
    {
        using var bytes = new MemoryStream();
        using (var zip = new System.IO.Compression.ZipArchive(bytes, System.IO.Compression.ZipArchiveMode.Create))
        {
            foreach (var (name, xml) in parts)
            {
                using var writer = new StreamWriter(zip.CreateEntry(name).Open());
                writer.Write(xml);
            }
        }
        return bytes.ToArray();
    }

    /// <summary>A Word document holding a heading and one table of <paramref name="rows"/> — the least a blank form is.</summary>
    internal static byte[] MinimalDocx(string heading, string[][] rows)
    {
        static string Escape(string text) => System.Security.SecurityElement.Escape(text);
        static string Paragraph(string text) => $"<w:p><w:r><w:t xml:space=\"preserve\">{Escape(text)}</w:t></w:r></w:p>";
        var table = "<w:tbl><w:tblPr><w:tblBorders><w:insideH w:val=\"single\"/><w:insideV w:val=\"single\"/></w:tblBorders></w:tblPr>"
            + string.Concat(rows.Select(r => "<w:tr>" + string.Concat(r.Select(c => $"<w:tc>{Paragraph(c)}</w:tc>")) + "</w:tr>"))
            + "</w:tbl>";
        return Zip(new()
        {
            ["[Content_Types].xml"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
            ["_rels/.rels"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>",
            ["word/document.xml"] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>"
                + Paragraph(heading) + table + "</w:body></w:document>",
        });
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

    [Fact]
    public void Finds_tables_of_numbered_rows_to_fill_with_the_columns_above_them()
    {
        var form = string.Join('\n',
            "| 연월일 | | 운용부서명 | |",
            "| :--- | :--- | :--- | :--- |",
            "| 일련번호 | 품명 | 청구량 | 용도 |",
            "| 1 | | | |",
            "| 2 | | | |",
            "| 3 | | | |",
            "",
            "| 항목 | 결과 |",
            "| :--- | :--- |",
            "| 1 | 정상 |",
            "| 2 | 불량 |",
            "| 3 | 정상 |");

        var rows = SourceFiles.RepeatedRows(form);

        Assert.Equal([["일련번호", "품명", "청구량", "용도"]], rows); // the second table's rows are filled in already: a list, not rows to add
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
