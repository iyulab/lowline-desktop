# What stays on this device, and what leaves it

The vault's files are the only originals. Everything else the app keeps can be deleted without losing anything.

## Kept on this device, outside the vault

In the app's local data, one file each per vault:

- A cache of the tables and the index of the documents' values. It is rebuilt from the vault.
- The strength each judgment field's replay chose for the values saved together, so the next launch starts from them instead of replaying its history again. They are chosen again from the vault if the file is gone, after an update of what measures them, or when a field's choices change.
- A record of the suggestions this device showed for the vault: when, for which template and field, and from where — never the value. Nothing learns from it; it is counted, so decisions can be read against what was shown, including suggestions whose document was never saved.

In the app's settings: this install's id, where the app was when last used (see [Working in the app](working.md)), whether to check for updates, whether the first launch's line about what leaves this computer was answered, and the model the chat uses — its kind, its address and the model chosen.

A model's key is kept in the operating system's credential store (Windows Credential Manager), never in the settings, the vault or the window: the app's window only learns whether one is kept.

## The chat

The chat beside a template sends nothing until the person sets up a model and writes to it. Then, with each message, it sends what was written in the chat so far and the template's source as it stands in the editor — nothing else of the vault: no document, no value, no file name. Starting a template from a blank form file (an HWP, HWPX or PDF form picked with "빈 서식 파일에서") reads the file on this computer into text, and from then on that conversation's messages also send the form's text and its file name — never the file itself, nor anything of the folder it is in. Reading records out of text to bring them in sends the text pasted for it, a piece at a time, with the template's source, the same way. Asking a template's records sends the question and the saved template's source only — with, for a field that refers to another template's documents, that template's field names and choices, and the names, field names and choices of the templates whose documents refer to its own — never a document's values: the model answers with what to count, and the app counts it in the vault on this computer — no record's value goes to the model. It goes where the person chose: to a model the app runs on this computer itself, to the server at the address given — on this computer or nearby — or, for a company's service (OpenAI, Anthropic, Google, xAI), to that company, with the key kept for it. The settings say which before anything is sent. What that company keeps of it is under its own terms.

A model the app runs on this computer is got when the person asks for it, not before: its file from Hugging Face and, the first time, the program that runs it (llama.cpp's server) from llama.cpp's releases on GitHub. Those requests carry what any download does — the address they come from — and ask only for the files. Getting a model ready again looks for a newer build of that program; nothing is checked or fetched on its own. The model runs in that program, a process of its own that ends ten minutes after the last reply, or with the app. Both are kept in the shared caches of the components that use them (the Hugging Face cache in the user's profile, and LMSupply's in the app data folder), outside any vault, and can be deleted; the model is then fetched again only when the person gets it ready again.

The model's own error text is not shown or kept: a failure is told by its kind (the key refused, nothing listening at the address, no answer in time, a model on this computer that is not there or would not start, …).

## Error reports

The first launch says in one line what leaves this computer — error reports and update checks — with the whole of it under 정보 (About).


When something fails, an error report is written to the `reports` folder in the app's log folder (one file per launch): the layer, the kind of failure (a class name or an app-owned code), the status a failed request to the sidecar was answered with, the frames of the app's own code, the version and the operating system — never a message, a path, a file name, a template or a value.

A release build sends the reports written since its last send on the next launch, over the operating system's TLS and certificate store. A launch deletes the files of earlier launches whose reports were all sent, and, while the folder holds more than 1 MiB, the oldest of the rest — never the file a running launch is still writing. Before sending, each report is checked again against what the app declares a report may carry; one that holds anything else is not sent. A build made without somewhere to send them — every development build — sends nothing.

## Updates

A release build looks for a newer release when it starts and again every twelve hours while it runs, and remembers when it last looked, so opening the app often does not look each time: it reads one public file, the latest release's `latest.json` on GitHub. The request carries what any download does — the address it comes from — and names the updater component and its version; nothing of the vault, the app's version or the operating system goes with it. Looking can be turned off under 정보 (About); it is on until then.

When a newer release is found, its installer is downloaded in the background from the same release on GitHub, once per version — a download that failed is tried again only after twelve hours or when a newer release appears — and kept only while the app runs. The app says a newer release is out once per version and run, whether it is downloaded yet, and, when the download failed, where the release page is. In the app's data folder, `updates.json` keeps when it last looked and was answered, the version last told of, downloaded, or failed to download, and when that failed; nothing else.

A newer release is installed only when the person chooses to install it — never on its own, not even as the app closes — after the app has asked about any unsaved edits, and only if its update signature is valid. The sidecar is stopped before the installer replaces it, the installer waits for both to have closed, and the new release starts in its place. A development build checks nowhere unless `LOWLINE_UPDATE_ENDPOINT` names a place.
