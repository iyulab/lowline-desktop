using Unhwp;
using Unpdf;

namespace Lowline.Host;

/// <summary>A file the person picked to start a template from: its path on this computer.</summary>
public sealed record SourceFileRequest(string Path);

/// <summary>
/// A picked file as Markdown — its name and text — or, when there is none, why: one of <see cref="SourceFileFailure"/>'s,
/// never the parser's words.
/// </summary>
public sealed record SourceFileReply(bool Ok, string? Name, string? Markdown, string? Failure);

/// <summary>Why a picked file gives no Markdown.</summary>
public static class SourceFileFailure
{
    /// <summary>The file is of a kind this does not read.</summary>
    public const string Unsupported = "unsupported";

    /// <summary>The file is not there, or could not be read as the kind its name says.</summary>
    public const string Unreadable = "unreadable";

    /// <summary>The file was read but holds no text — a scanned form, say.</summary>
    public const string Empty = "empty";

    /// <summary>The form's text is longer than a model on an ordinary computer can read with the instructions.</summary>
    public const string TooLong = "too-long";
}

/// <summary>
/// Blank forms as they are handed out — HWP, HWPX and PDF files — read into Markdown, so the chat that writes templates
/// can draft one from the form's own fields, rows and choices. The file is read here and goes nowhere else.
/// </summary>
public static class SourceFiles
{
    /// <summary>The longest Markdown handed on: a blank form is a few thousand characters; a longer file is not a form.</summary>
    public const int Limit = 16_000;

    /// <summary>The kinds of file read, by extension.</summary>
    public static readonly IReadOnlyList<string> Extensions = ["hwp", "hwpx", "pdf"];

    /// <summary><paramref name="request"/>'s file as Markdown, or why not.</summary>
    public static SourceFileReply Read(SourceFileRequest request)
    {
        var name = System.IO.Path.GetFileName(request.Path);
        var extension = System.IO.Path.GetExtension(request.Path).TrimStart('.').ToLowerInvariant();
        if (!Extensions.Contains(extension)) return new SourceFileReply(false, name, null, SourceFileFailure.Unsupported);
        if (!File.Exists(request.Path)) return new SourceFileReply(false, name, null, SourceFileFailure.Unreadable);

        string markdown;
        try
        {
            markdown = extension == "pdf" ? Pdf(request.Path) : Hwp(request.Path);
        }
        catch (Exception e) when (e is UnhwpException or UnpdfException or IOException or UnauthorizedAccessException)
        {
            return new SourceFileReply(false, name, null, SourceFileFailure.Unreadable);
        }

        markdown = markdown.Trim();
        if (markdown.Length == 0) return new SourceFileReply(false, name, null, SourceFileFailure.Empty);
        if (markdown.Length > Limit) return new SourceFileReply(false, name, null, SourceFileFailure.TooLong);
        return new SourceFileReply(true, name, markdown, null);
    }

    static string Hwp(string path)
    {
        using var document = UnhwpDocument.ParseFile(path);
        return document.ToMarkdown(new Unhwp.MarkdownOptions());
    }

    static string Pdf(string path)
    {
        using var document = UnpdfDocument.ParseFile(path, new ParseOptions());
        return document.ToMarkdown(new Unpdf.MarkdownOptions());
    }
}
