# Edits from outside the app

The shell watches the places in the vault the app reads — `서식/`, `문서/` and other devices' event files (tauri-kit-watch) — so other programs keeping their own files in the same folder do not disturb it. The app's own writes are not reported back to it.

Edits made there by other programs — another editor, a sync client, another device — show up in the lists, the table and the suggestions. A file a sync client brings down from another device without telling (OneDrive does so on Windows) is found by listing the vault again every 15 seconds.

- An open document with no unsaved edits is read again.
- One with unsaved edits is never replaced: the person is told, and saving decides. A notice that leaves the file as it is on screen changes nothing, and an edit made while the file is being read counts as unsaved.
- Before saving, the app checks the file is still what it read; an edit made there since is not overwritten unseen.
- An open document or template removed outside stays on screen as unsaved, so saving makes it again.

## Sync conflict copies

When a sync client keeps both devices' edits of a file as a copy beside it, the list shows the copy with its original and neither is read twice. A copy named after a computer — OneDrive's `접수-1-<computer>.md` — is recognised when it is this computer's name and the original is beside it; a copy named after another computer is listed as a document of its own. Until the person keeps one of the two, the original stays in its table, but suggestions do not learn from it and the weekly counts leave it out.

## Programs that write documents

Another program may add documents to the vault — an automation that turns incoming mail into new records, for example. The app reads them like any other edit from outside. A value in a judgment field is taken as a person's decision: it is what suggestions learn the right answer from. So a program writing documents should fill in the observed fields and leave the judgment fields empty, for a person to confirm in the app with its suggestions.

A program that has a guess for a judgment field can write it as a suggestion instead: the value goes in its field as usual, and the field is named under `lowline.proposed` with who wrote it, in words a person can read:

```yaml
담당: 총무
lowline:
  proposed:
    담당: 메일 분류기
```

The app does not learn from a marked value. Opening the document, the person sees the field empty with the value offered in it — "제안 · 메일 분류기에서 넣은 값" — to take, change or reject. Saving takes the mark off each value the person decided: a value taken or changed is theirs from then on, and one rejected is taken out of the file with its mark. A value left alone stays in the file, still marked. The table shows a marked value with "(제안)" after it. A program that does not know the mark can still read the value; one that writes a value without it is taken at its word.

A template's document list can show only the documents with a judgment field still empty or only proposed, and Ctrl+Enter saves the one open and opens the next. Judgment values a program fills in without the mark are learned from as if someone had decided them. The learning screen says, for each template, how many of the documents with a judgment value the app has never saved — documents whose front matter has no `lowline.id`.

## Shared folders

A vault may sit on a shared folder. Where a location has no trash — a network share, some removable drives — deleting never happens silently: the app says the file could not be moved to a trash, and deletes it for good only when the person chooses so.

## Links in a template or document

A template or document from someone else may carry links — to written instructions, for example. The app's window shows the app and nothing else: clicking a link does not replace it with the linked page, and does not open a window of its own. A link to a web page or to an email address opens in the system's browser or mail app, and the app says so with the address. A link to anything else — a file, a program, another app — is not opened; the app says so and shows the address. Either way, whatever was typed stays as it was. A page that tries to leave the app by itself, without a click, is refused and the address shown; so is a frame that would load a page from outside, and the request for a refused page is not sent. Scripts in a template's or document's body do not run.
