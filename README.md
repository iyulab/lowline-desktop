# Lowline

**Your forms, with an AI that learns from your decisions.**

Lowline is a desktop app for the forms you fill again and again — inspections, intake, defect reports. You write a form like a note; fields written inline become columns, a form's documents become one table to filter and export, and the more a form is used, the better it gets at suggesting the fields that need judgment — learned from what people confirmed, on your own machine, with no model to download.

- **Local-first** — documents are plain files on your machine. No account is required, and every feature works offline.
- **Forms, not free notes** — a form's fields are part of the text itself. The same document reads as prose and queries as a row.
- **Suggestions that learn from confirmation** — fill in the observed fields and candidate values are suggested for the judgment fields; start typing into one and it narrows to values that begin with what you typed. People confirm; confirmations become the basis for later suggestions.
- **Honest about what it does not know** — a field it cannot suggest for says why beside it: too few confirmed documents yet, or nothing in this one that settles it. The learning view shows how often its suggestions were taken as offered, field by field.

> Status: early development. Windows builds are published on [lowline-releases](https://github.com/iyulab/lowline-releases/releases/latest).

## How it works

- [Vaults, templates and documents](docs/vault.md) — the folder, templates and their versions, documents, tables, finding and importing
- [Suggestions and learning](docs/suggestions.md) — what is suggested and from what, how often is often enough, the event files, the learning view
- [Working in the app](docs/working.md) — opening where you left off, keyboard, narrow windows
- [Edits from outside the app](docs/outside-edits.md) — other editors, sync clients and their conflict copies, shared folders
- [What stays on this device, and what leaves it](docs/data.md) — caches, the record of suggestions shown, error reports

## Development

Requires Node.js 22.18+, Rust (stable), the .NET 10 SDK and, on Windows, the WebView2 runtime.

```bash
npm install
npm run build:host     # publish the .NET sidecar; the shell bundles it, so build it before cargo
npm run tauri dev      # run the app
npm test               # web UI tests
npm run test:host                                  # sidecar tests
cargo test --manifest-path src-tauri/Cargo.toml   # shell tests
npm run build:e2e && npm run test:e2e              # end-to-end scenarios in the real window
npm run check:installer                            # after `npx tauri build`: install, start, uninstall
```

CI runs the web UI, shell and sidecar tests on Linux for each push, and the end-to-end scenarios in the Windows window on a Windows runner. On a CI runner the scenarios do not look into the Recycle Bin, which its session sees empty; they still check that a deleted file left the vault.

With `LOWLINE_PERF=1`, the web UI tests, the sidecar tests and the end-to-end run also measure what reading and ingesting a vault of 1,000 and 10,000 documents costs — filling an empty cache, one outside edit, a restart, what reference fields cost each time a view draws; they are skipped otherwise.

With `LOWLINE_REPLAY` naming a folder that holds a template (`template.md`) and the rows a person would paste into it (`rows.tsv`, one column the day each record was made), `npx vitest run src/__tests__/replay.test.ts` plays those records back through the app before anyone uses it: brought in the way the app brings in pasted rows — the first `LOWLINE_REPLAY_BROUGHT_IN_WEEKS` weeks of them all at once — the rest asked about field by field on their own day and saved with their values, then counted the way the weekly counts are copied. It writes what was offered, the events and the weekly counts to `LOWLINE_REPLAY_OUT` and prints how often each field was offered a value and how often it was right, quarter by quarter; `by-key.json` says the same by the field each offer rested on. Records that refer to another template's documents come with that template and its rows in `base/`, in the same shape: those are brought in first and whole, and the records' reference cells name them as pasted names do.

With `LOWLINE_CHAT_MEASURE` naming a file, the sidecar test `Measures_replies_to_questions_of_referred_documents_and_those_referring_to_them` asks a model already on this computer (`LOWLINE_CHAT_MODEL`, the recommended one by default — nothing is fetched) questions about three pairs of records — businesses and their inspections, aircraft and their accidents, requisitions and their item rows (sums of a number field) — and writes its replies there; `npx vitest run src/__tests__/chat-query-measure.test.ts` with the same variable reads them as the app does and says how many count what was asked.

Templates asked for in words are measured the same way: with `LOWLINE_CHAT_AUTHORING_MEASURE` naming a file, `Measures_drafts_of_templates_asked_for` asks for ten templates — four of them drawn from published blank forms — and `chat-authoring-measure.test.ts` reads each draft as the chat does, counting the fields asked for, the judgment fields left to a closed list, the fields asked to apply only on another's answer, the fields asked to be worked out from others' numbers, and whether rows repeated down a table came as a template of their own pointing at it. `LOWLINE_CHAT_AUTHORING_CASES` (ids, comma-separated) asks only those. With `LOWLINE_CHAT_AUTHORING_RETRIES_OUT`, `LOWLINE_CHAT_AUTHORING_RETRIES` and `LOWLINE_CHAT_AUTHORING_SECOND` it also asks a second time where the chat would, saying what was wrong, and counts what a person is then shown.

With the snapshot a replay writes (`LOWLINE_REPLAY_SNAPSHOT`) and `LOWLINE_REPLAY_SIMILAR=1`, `Measures_the_similar_documents_layer_on_a_replay` replays the same records through both layers as the app asks them, choosing each layer's strength again as the records grow, and prints, per judged field, how often each layer was right against what its replay promised — the measure behind offering similar documents only on fields whose promise rests on 30 answers or more.

Layout: `src-tauri/` is the shell — the only code that reads or writes files, all inside the open vault folder and all writes atomic. `src/` is the web UI. `src-host/` is the .NET sidecar for projections and suggestions: the shell starts it with the app and a per-launch token, it listens on a loopback port and never touches vault files. `notices/` holds the license texts of shipped packages that publish without one, each pinned to its source at that version; `npm run notices` (run after `build:host`) writes the third-party notices the installer ships beside the app and the app shows under 정보 ([notices/README.md](notices/README.md)).

End-to-end scenarios live in `e2e/`. `npm run build:e2e` builds a debug variant (`src-tauri/tauri.e2e.conf.json`) that exposes the WebView DevTools protocol on port 9223; `npm run test:e2e` copies the fixture vault in `e2e/fixtures/vault/` to a temporary folder, drives the window with clicks and typing through [`@iyulab/tauri-kit-dev`](https://github.com/iyulab/tauri-kit-dev), and checks the saved files on disk. `npm run test:e2e -- --only <text>` runs the scenarios whose names hold the text, `--through <text>` those up to the first such, and `--repeat <n>` runs them n times, each on a fresh vault; a failed scenario's picture is kept in the temp folder; `e2e/app.mjs` is the window itself — launch, open a vault, click, type, take a picture, quit — for a script that walks a flow of its own.

`npm run check:installer` checks an installer the way a person gets the app: installed for the current user into a temporary folder, started — with the sidecar running from the installed folder — closed, which ends the sidecar too, and uninstalled. The installed app uses its real identifier, so run it where no Lowline of your own is in use, or on an installer built with `--config src-tauri/tauri.e2e.conf.json`; the release pipeline runs it before an installer is uploaded.

## License

Lowline is licensed under the [GNU Affero General Public License v3.0](LICENSE). iyulab holds the copyright and also offers Lowline under a separate commercial license for organizations that cannot adopt AGPL-3.0 terms.

Contributions require agreeing to the [Contributor License Agreement](CLA.md) — see its Signing section.
