# Vaults, templates and documents

## A vault is a folder

Everything Lowline keeps is a file in a folder you choose, the vault: templates in `서식/`, documents in `문서/`, and the record of what happened to suggestions in `.lowline/events/`. Other programs may keep their own files in the same folder; Lowline reads only its own places.

The first screen opens an existing folder or makes a new vault in an empty one, starting from a sample template with one judgment field turned on and no documents — suggestions learn only from what a person saves.

The sidebar lists the vault's templates. Each shows its documents (first), its table and its source; a new template starts from the end of that list. Documents naming no template the vault has are listed apart while there are any.

## Templates

A template is a Formdown form. Its front matter gives it an `id` and a `version`. A field that suggestions are turned on for — a judgment field — says so itself, with Formdown's `suggest:role=judged`:

```text
---
id: intake
version: 1
---
@담당: [radio options="장비,계정,급여,시설" suggest:role=judged]
```

The file stays a plain Formdown template, and any tool that reads Formdown reads which fields are judged. The field's other `suggest:*` attributes are followed too: `suggest:policy=off` keeps it from ever being suggested, `suggest:policy=confirm` suggests it without putting the value in (Lowline never puts a suggested value in on its own, so it shows such a field as any other), `suggest:must-catch` names values never to miss, `suggest:evidence=false` keeps a field — an identity such as a name — out of the clues for the others, and `suggest:parent` names the field its choices depend on.

A judgment field whose values name a broader class in their first characters — the chapter of a fault code, the class of a part number — can say how many characters, with `suggest:coarse`. Where its value cannot be suggested, its class may be (see [Suggestions](suggestions.md)):

```text
@고장코드: [text suggest:role=judged suggest:coarse=2]
```

Only a judgment field that takes one value counts, with a whole number of characters from one; anything else is ignored. It is written in the source; the template's page has no control for it.

Templates written before fields said this name their judgment fields in the front matter, under `lowline` — a key other Formdown tools ignore — and their class lengths under `coarse`:

```yaml
lowline:
  suggest: [고장코드]
  coarse: { 고장코드: 2 }
```

These are read as they are. Where a field says its role, its class length or that it is never suggested, the field's word counts; the front matter's list speaks for the rest.

On a template's page:

- Judgment fields are turned on and off with a checkbox per field, written on the field as `suggest:role=judged`; a field turned on or off leaves the front matter's `lowline.suggest`, so it is said in one place.
- A choice field's options are edited in the field list and written back into that field in the source, nowhere else.
- **Rename** in the field list changes what a field shows — its `label` — and leaves its name as it is. A field's name is what documents record its value under and what suggestions learn by, so the values and what was learned stay with it. Renaming the field in the source instead makes it a new field; the page then says which documents hold values in a field the source no longer has.
- Typing in the source completes a field just started — `@` after three underscores, for the field's name, and `[]` after `@name: `, for its type — and one undo takes the completion away.
- Problems in the source are listed above it: a field name used twice (documents keep one value per name, so the field is read as it first appears), a condition that names a field the template does not have, a computed value (`compute="quantity * price"` — worked out from other fields' numbers as they are typed, and saved with the document) that cannot be read or reads a field the template does not have, a judgment field that is not a field, another template file with the same id, and a field that refers to a template the vault does not have (`@customer -> customer: [select]` names the template by its `id`) or to many documents (`<->`, not read yet). A line shaped like a field that is not read as one — written without its brackets, or with a shorthand's braces after the colon — is said too, with how to write it when that can be told; **Fix** puts that in the source as typing does, so one undo takes it away.
- **Chat** opens a chat beside the source, to change the template in words. The first time, it asks for the model to use: one the app gets and runs on this computer itself (a 4B or 8B model, about 3 or 5 GB, fetched when the person asks — with how far it has got), a server on this computer or nearby (Ollama, GPUStack, any address that speaks the OpenAI way), or a company's service with a key. It checks that the model answers, says why it does not, and says where what is sent goes. A reply that brings a template is checked as the source is checked while typed — the model is asked once more when it has problems — and goes into the editor unsaved, with the fields it added and took away named and what the editor held before a click away. A table of rows repeated down the page — a requisition's fifteen lines of items — is asked for as a template of its own: one row's fields, with a field naming this template's documents, so each row becomes a document shown under its parent ([fields that name other documents](#fields-that-name-other-documents)); the reply brings it as a second template, checked the same way, and the chat offers to make it. A draft that spreads a row over numbered fields (`품목_1_품명`, `품목_2_품명`, …) is asked for once more that way. Nothing is saved until the person saves, or makes the row template. **Ask the records** turns the same chat to questions about the template's saved documents ("지난달 원인별 몇 건?"): the model says only what to count — by which fields, which documents, which span of time — the app checks it against the template and counts it in the vault, and each count comes with the documents it is made of and with what was counted, in words, so a question taken the wrong way shows as that. A question the fields cannot count is said to be one. A field that refers to another template's documents can be asked through: by that template's fields ("서울 고객의 문의" counts by `고객.지역`, as the customer document holds it now) or by one of those documents, named by its name. Asked of a template other templates' documents refer to, it counts those documents too, by the one each names ("검사가 많은 업소" counts the inspections by their business). A number field can be added up beside the counts ("청구서별 금액 합계" adds up the item rows' amounts per requisition): the sum is the vault's, exact, said with how many of the documents had a value — a document left blank there takes no part, and a group with no value at all has no sum rather than 0 — and with a sum asked, the largest sums come first. An average or a share is not worked out; such a question is said to be one the fields cannot count. Where the page is too narrow for three columns, the chat takes the place of the fields and the preview while it is open.

### Versions

A template's versions are revisions of one template: its identity is its `id`. Raising the version keeps its documents in its list and its table, and what they confirmed keeps suggesting. The table's columns are the fields of the version now.

Documents record the version they were written with and are never rewritten for it. A document of an earlier version opens as it was written, with a line saying which version; **Move to the version now** gives that one document the version's body and names the version, and keeps every value in its front matter — a value in a field the version no longer has included — and its id.

Two template files with one id are one template twice: the vault reads the later version as the template, and the template's page says so.

## Documents

A document is a copy of its template's body whose front matter records the template, the document's own id and the values. `template` and `lowline` are the document's own keys, so a template cannot have fields by those names:

```yaml
---
template: intake@1
lowline:
  id: 5f0c2c1e-8a47-4f3b-9d6e-2b1f7c9a0e44
요청: 노트북 배터리가 금방 닳아요
부서: 영업
---
```

What is recorded about a document — its suggestion events, the rejections that hold in it, what suggestions learn from it — is keyed by that id, so it stays with the document when its file is renamed or moved. A document without one — written before documents had ids, or by another tool — is known by its path, the key its earlier events were recorded under. Saving or renaming it gives it that path as its id, so it stays with the document when the file is later moved; the app does not add ids to files nobody asked it to save.

- A new document is named by its day and its first value. A new document or template never replaces a file: when its name is taken it gets a number, `2026-10-03-문의 (1).md`, `새 서식 (1).fd.md` — before the template ending, so it is still a template.
- Renaming a document renames its file within its folder — never over another file — and a document known by its path is given that path as its id first. A template is renamed the same way on its page; documents name their template by its id, so they stay with it.
- Deleting a document or a template moves its file to the system's trash, after asking. Where a location has no trash, the file stays until the person chooses to delete it for good. A deleted template's documents are kept, and listed apart as documents whose template the vault does not have.
- Documents and templates are listed by their file names. A template's documents are listed the last name first — a new document's name starts with its day, so the latest are on top — and a sync conflict copy follows its original.
- A file copied outside the app keeps its original's id; the copy that is then saved with a change gets a new one and becomes a document of its own.
- A document written by another program with its front matter alone opens with its template's fields, and saving it writes the template's body under its front matter.
- A judgment value another program wrote as a suggestion is named under `lowline.proposed`, field by field, with who wrote it (`proposed: { 담당: 메일 분류기 }`). Suggestions do not learn from it, and it is offered in its field instead of filled in; a person deciding it takes the mark off when the document is saved, and a value rejected goes with its mark. See [Edits from outside](outside-edits.md).

### Fields that name other documents

A field written `@고객 -> customer: [select]` names one document of the template whose `id` is `customer`. The field offers that template's documents by their file names — past twenty of them, typing part of a name narrows the list — and the document records the chosen one's id — so renaming it changes nothing in the documents that name it:

```yaml
---
template: inquiry@1
고객: c2a7e3f0-41d2-4b8e-9f3a-6d0e1b5c7a92
---
```

A value naming a document the vault does not have is kept as it is, and shown as missing with the start of its id. A document that others name — a customer named by inquiries, a requisition named by its items — lists them under it as a table for each template that can name it, the latest first: each by its name, then that template's fields but the one naming it. A row opens its document in its own template's place, and **New** beside the table starts one there naming this document — the rows of a paper form's table, each a document of its own. The templates fields refer to lead the sidebar, in a group of their own; nothing else marks them.

## Tables, finding and importing

A template's table has a row per document and a column per field. It filters by name, by a choice field's value, by the document a reference field names — or by either left blank, as in records another program wrote for a person to confirm — by words in a field and by a number or date field's range, and it exports as CSV. A reference field shows, and exports, the name of the document it names. A table row opens its document.

A date field holds a date as written (`2026-01-15`, or `2026-01-15T09:30` with a time) and reads as the same day on every computer, whatever its time zone. A value that is not a date keeps its row and is kept in the file; the table leaves that cell empty and lists the document and field so it can be fixed, and the document shows the value as written beside its empty field until a date is picked. A number field shows a value that is not a number the same way.

A template's list of documents finds them by their names or by the words of their values — a value's line that matched is shown beside it. An open document shows, when asked, the documents of its template most like it, leaving out those whose values are still in doubt. The words are looked up in an index of the documents' values (FluxIndex, character pairs for Korean, no model). These similar documents are for a person to look at, each with the value it confirmed in the template's judgment fields; they never fill in a field and are never suggested from.

Existing records come in by pasting rows copied from a spreadsheet — the first row names the columns — so suggestions have confirmed values to learn from on the first day. A column for a field that refers to another template's documents names them by name — the document's file name, or the name after the day the app put before it — and each row comes in holding the id of the document it names; a name no document of that template has, or two have, comes in as written and is listed before anything is written.

With a model set up for the chat, records also come in from text that is not a table — mail, notes, a document's pages, up to 4,000 characters at a time: the model reads them into the template's fields a few records at a time, nothing guessed, a choice only when the text says which. How far it has got is shown, and reading can be stopped, keeping what was read; on a computer's processor alone it takes about half a minute for every few records. The records it read are shown, field by field, before anything is written, and come in as rows pasted from a spreadsheet do. A value the model gave a judgment field comes in as its suggestion (`lowline.proposed`, written by "채팅(<model>)"): it is offered in the field and not learned from until a person decides it. Values in the other fields are the document's own once brought in.
