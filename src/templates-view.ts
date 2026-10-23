import { LitElement, css, html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { formdownTheme } from './formdown-theme.js'
import { authoringCompletion, parseFormdown, setFieldAttribute } from '@formdown/core'
import {
  fileName,
  fileNameFor,
  moveSuggestToFields,
  optionsText,
  referenceProblems,
  setOptions,
  setSuggest,
  sharedId,
  strayFields,
  templateInfo,
  templateProblems,
  type SourceFix,
} from './documents.js'
import { readVault, onVaultChanged } from './vault-snapshot.js'
import { judgedFields, type DocumentSnapshot } from './projection.js'
import type { TemplateItem } from './template-scope.js'
import './rename-control.js'
import './delete-control.js'
import './keep-copy-control.js'
import './chat-panel.js'
import type { ModelSettings } from './settings.js'
import { conflictNoticeFor, conflictOf, isCopy } from './conflicts.js'
import { describeError } from './errors.js'
import { confirmDiscard, markUnsaved } from './unsaved.js'
import { deleteFile, keepConflictCopy } from './file-lifecycle.js'
import { strings } from './strings.js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { failureKind, removedBy, touches, vault, type VaultChanged, type VaultEntry, type VaultInfo } from './vault-client.js'

/** What a template's file name ends with. */
const TEMPLATE_SUFFIX = '.fd.md'

/** A template: its Formdown source next to a live preview, saved in place. */
@customElement('ll-templates')
export class LlTemplates extends LitElement {
  static styles = [
    formdownTheme,
    css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      container-type: inline-size;
    }
    .page {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: minmax(0, 1fr);
      gap: var(--dc-space-4);
      height: 100%;
    }
    .page.chatting {
      grid-template-columns: 1fr 1fr minmax(16rem, 22rem);
    }
    /* The chat keeps its input in view however long the preview beside it grows: as tall as the window below the
       page's heading and tabs, held there while the page scrolls. */
    ll-chat-panel {
      position: sticky;
      top: 0;
      align-self: start;
      height: max(20rem, calc(100vh - 9rem));
      box-sizing: border-box;
    }
    /* Too narrow for three — the source and the preview at least 20rem each beside the chat: the chat takes the place
       of the fields and the preview while it is open. */
    @container (max-width: 60rem) {
      .page.chatting {
        grid-template-columns: 1fr minmax(16rem, 1fr);
      }
      .page.chatting > .side {
        display: none;
      }
    }
    section {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-2);
      min-height: 0;
    }
    /* The source is written here, so it is a plain text area (caret, selection, typing that undoes
       as one) drawn in the design system's colors, like its fields. */
    textarea {
      flex: 1;
      min-height: 20rem;
      box-sizing: border-box;
      font-family: var(--dc-font-mono);
      font-size: 13px;
      padding: var(--dc-space-2);
      border: 1px solid var(--dc-color-border);
      border-radius: var(--dc-radius-sm);
      background: var(--dc-color-bg);
      color: var(--dc-color-text);
      resize: none;
    }
    textarea:focus-visible {
      outline: var(--dc-focus-ring-width) solid var(--dc-color-accent);
      outline-offset: 1px;
    }
    .preview {
      flex: 1;
      overflow: auto;
      border: 1px solid var(--dc-color-border);
      border-radius: var(--dc-radius-md);
      padding: var(--dc-space-3);
    }
    /* When the column is narrow the status goes to a line of its own; a heading or a button never breaks. */
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--dc-space-2);
    }
    .bar > * {
      white-space: nowrap;
    }
    .bar > [role='status'],
    .bar > [role='alert'] {
      white-space: normal;
    }
    .message {
      color: var(--dc-color-text-muted);
    }
    .error {
      color: var(--dc-color-danger);
    }
    /* Said while typing, before a save: a warning, not a failure. */
    .problems {
      margin: 0 0 var(--dc-space-2);
      padding-inline-start: 1.25em;
      color: var(--dc-color-warning-text);
      font-size: 0.875em;
    }
    /* Each field on one row: its judgment checkbox (as wide as its label, so a click beside it does
       nothing), then a choice field's options. */
    .fields {
      display: grid;
      grid-template-columns: max-content max-content minmax(8rem, 1fr);
      align-items: center;
      justify-items: start;
      gap: var(--dc-space-1) var(--dc-space-3);
    }
    .fields h3,
    .fields p {
      grid-column: 1 / -1;
    }
    .fields .label-edit {
      --ll-rename-width: 7rem;
      display: flex;
      align-items: center;
      gap: var(--dc-space-1);
    }
    .fields p {
      margin: 0;
      font-size: 0.875em;
    }
    .fields dc-input {
      justify-self: stretch;
    }
    h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
    }
  `,
  ]

  @property({ attribute: false }) vaultInfo!: VaultInfo
  /** The template's file. The app asks before leaving unsaved edits, so a new one is simply shown. */
  @property({ attribute: false }) path!: string
  /** The model the chat uses, if one is set up. */
  @property({ attribute: false }) model: ModelSettings | null = null

  /** The template files, conflict copies included: what tells whether this one has a copy. */
  @state() private entries: VaultEntry[] = []
  /** The vault's documents as last read: see `strayFields`. */
  @state() private documents: DocumentSnapshot[] = []
  /** The vault's templates as last read: see `sharedId`. */
  @state() private templateItems: TemplateItem[] = []
  @state() private selected?: string
  @state() private source = ''
  /** The open template as it was last read or saved: what the file holds unless changed outside. */
  private loaded = ''
  @state() private dirty = false
  /** The open template changed outside while it had unsaved edits: the person chooses which to keep. */
  @state() private changedOutside = false
  /** The trash would not take the open template: whether to delete it for good is being asked. */
  @state() private untrashable = false
  /** The trash would not take the original of the open conflict copy being kept: whether to delete it for good is being asked. */
  @state() private originalUntrashable = false
  @state() private message = ''
  @state() private error = ''
  /** Whether the chat is open beside the template. */
  @state() private chatting = false
  /** A completion is being inserted: its own input is not completed again. */
  private completing = false

  private unlisten?: Promise<UnlistenFn>

  connectedCallback() {
    super.connectedCallback()
    void this.refresh()
    this.unlisten = onVaultChanged((change) => void this.outsideChange(change))
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    void this.unlisten?.then((stop) => stop())
    markUnsaved('templates', false)
  }

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('path') && this.path !== this.selected) void this.select(this.path).catch((e) => (this.error = describeError(e)))
  }

  updated(changed: Map<string, unknown>) {
    // A view no longer shown holds no edits: an outside change that lands after it left says nothing.
    if (changed.has('dirty')) markUnsaved('templates', this.isConnected && this.dirty)
  }

  /** Shows what another program did to the templates; an edit in progress is never replaced. */
  private async outsideChange(change: VaultChanged) {
    try {
      await this.refresh()
      const selected = this.selected
      if (!selected || !touches(change, selected)) return
      if (removedBy(change, selected, this.entries.map((e) => e.path))) {
        // What is on screen is now held nowhere else: it is unsaved, whatever was typed.
        this.dirty = true
        this.error = strings.removedOutside
        this.message = '' // an earlier "saved" no longer holds
      } else {
        const source = await vault.read(selected)
        // A notice that changed nothing leaves the screen alone. An edit made while the file was being
        // read is not replaced: the notice was about the file, not about what was typed since.
        if (this.selected !== selected || source === this.loaded) return
        if (this.dirty) {
          this.error = strings.changedOutsideDirty
          this.message = ''
          this.changedOutside = true
        } else {
          this.show(selected, source)
          if (!change.rescan) this.message = strings.reloadedOutside
        }
      }
    } catch (e) {
      this.error = describeError(e)
    }
  }

  private async refresh() {
    try {
      this.entries = await vault.listTemplates()
      // The documents' values, for what they hold that the source no longer has.
      const read = await readVault()
      this.documents = read.documents
      this.templateItems = read.templateItems
    } catch (e) {
      this.error = describeError(e)
    }
  }

  private async select(path: string) {
    this.show(path, await vault.read(path))
  }

  private show(path: string, source: string) {
    this.error = ''
    this.message = ''
    this.source = source
    this.loaded = source
    this.selected = path
    this.dirty = false
    this.changedOutside = false
  }

  /** Drops the unsaved edits and shows the template as it is on disk now. */
  private async readOutside() {
    if (!this.selected) return
    try {
      await this.select(this.selected)
      this.message = strings.reloadedOutside
    } catch (e) {
      this.error = describeError(e)
    }
  }

  /**
   * Takes what was typed into the source, completing a field just started (`___` → `___@`,
   * `@name: ` → `@name: []`). The completion goes in as typing does, so one undo takes it away.
   */
  private onSourceInput(e: InputEvent) {
    const area = e.target as HTMLTextAreaElement
    const caret = area.selectionStart
    if (e.inputType === 'insertText' && !this.completing && caret === area.selectionEnd) {
      const completion = authoringCompletion(area.value, caret)
      if (completion) {
        this.completing = true
        document.execCommand('insertText', false, completion.text)
        this.completing = false
        area.setSelectionRange(caret + completion.caret, caret + completion.caret)
      }
    }
    this.source = area.value
    this.dirty = true
    this.message = ''
  }

  /**
   * Puts a problem's fix in place of the source it is about, as typing does — one undo takes it away — with the caret
   * after it. Nothing is completed on top of it.
   */
  private applyFix(fix: SourceFix) {
    const area = this.renderRoot.querySelector('textarea')
    if (!area || area.value.length < fix.end) return
    area.focus()
    area.setSelectionRange(fix.start, fix.end)
    this.completing = true
    document.execCommand('insertText', false, fix.text)
    this.completing = false
  }

  /** A draft the chat wrote, or what the editor held before it: in the editor, unsaved — the person saves it. */
  private takeDraft(source: string) {
    if (source === this.source) return
    this.source = source
    this.dirty = true
    this.message = ''
  }

  /**
   * The source's fields: whether each is a judgment field, and a choice field's options (a select, or
   * a radio or checkbox group). Nothing while the source does not parse.
   */
  private fields(): { name: string; label: string; judgment: boolean; options?: string }[] {
    try {
      const on = new Set(judgedFields(this.source))
      // A name used twice is one field to the documents: listed once (the problem is said above the source).
      const forms = parseFormdown(this.source).forms.filter((f, i, all) => all.findIndex((g) => g.name === f.name) === i)
      return forms.map((f) => ({
        name: f.name,
        label: f.label ?? f.name,
        judgment: on.has(f.name),
        options: ['select', 'radio', 'checkbox'].includes(f.type) && f.options?.length ? optionsText(f.options) : undefined,
      }))
    } catch {
      return []
    }
  }

  /** Turns suggestions on or off for a field: an edit of the source like any other, kept by saving. */
  /** Moves the judgment fields a template written before named in its front matter onto the fields: an edit, kept by saving. */
  private moveToFields(moved: string) {
    this.source = moved
    this.dirty = true
    this.message = ''
    this.error = ''
  }

  private toggleJudgment(field: string, on: boolean) {
    try {
      this.source = setSuggest(this.source, field, on)
      this.dirty = true
      this.message = ''
      this.error = ''
    } catch (e) {
      this.error = describeError(e)
    }
  }

  /**
   * Gives a field the name it shows — its label — leaving its name, which documents, the table and what was
   * learned know it by, as it is: an edit of the source like any other, kept by saving. A name left
   * empty, or the field's own name, takes the label away.
   */
  private setLabel(field: string, typed: string) {
    const label = typed.trim()
    const current = this.fields().find((f) => f.name === field)?.label
    if (label === current) return
    try {
      this.source = setFieldAttribute(this.source, field, 'label', label && label !== field ? label : undefined)
      this.dirty = true
      this.message = ''
      this.error = ''
    } catch (e) {
      this.error = describeError(e)
    }
  }

  /**
   * Writes a field's options, as typed, into its place in the source (`setOptions`): an edit of the source
   * like any other, kept by saving. A field is left with at least one option, and keeps its "other" choice.
   */
  private writeOptions(field: string, typed: string, input: HTMLInputElement & { value: string }) {
    try {
      const next = setOptions(this.source, field, typed)
      if (next === undefined) {
        input.value = this.fields().find((f) => f.name === field)?.options ?? '' // nothing to write: show what the source holds
        return
      }
      this.source = next
      this.dirty = true
      this.message = ''
      this.error = ''
    } catch (e) {
      this.error = describeError(e)
    }
  }

  /**
   * Gives the template the name typed — its file's name, which is what the sidebar shows (R-1).
   * Documents name their template by its id, not its file, so they stay with it. Unsaved edits are
   * saved first; a name another template has is refused.
   */
  private async rename(name: string) {
    const from = this.selected
    if (!from) return
    const file = fileNameFor(name, TEMPLATE_SUFFIX)
    if (!file) {
      this.error = strings.nameInvalid
      return
    }
    const to = `${from.slice(0, from.lastIndexOf('/') + 1)}${file}`
    if (to === from) return
    this.error = ''
    this.message = ''
    if (!(await this.savedFirst())) return
    try {
      await vault.rename(from, to)
      this.selected = to // the app lists it under its new name and hands it back: nothing to read again
      await this.refresh()
      this.message = strings.renamed
    } catch (e) {
      this.error = failureKind(e) === 'already-exists' ? strings.templateNameTaken : describeError(e)
    }
  }

  /**
   * Deletes the template — to the system's trash, or for good once the person chose that for a file
   * the trash would not take. Its documents stay: they name a template the vault no longer has. The
   * app is told with `ll-template-deleted`, and shows somewhere else.
   */
  private async delete(permanently: boolean) {
    const path = this.selected
    if (!path) return
    this.untrashable = false
    this.error = ''
    this.message = ''
    const deletion = await deleteFile(path, permanently)
    if (deletion !== 'deleted') {
      if (deletion === 'untrashable') this.untrashable = true
      else this.error = deletion.error
      return
    }
    this.dirty = false // what was on screen went with the file, as the question said
    const conflict = conflictOf(path, this.entries)
    if (conflict !== undefined && 'copyOf' in conflict) {
      // Deleting a conflict copy keeps its original, which is still the app's template: shown again.
      await this.refresh()
      try {
        await this.select(conflict.copyOf)
      } catch (e) {
        this.error = describeError(e)
        return
      }
      this.message = strings.keptOriginal(permanently)
      return
    }
    this.dispatchEvent(
      new CustomEvent('ll-template-deleted', { detail: { path, permanently }, bubbles: true, composed: true }),
    )
  }
  /**
   * Keeps the open conflict copy in its original's place: the original goes to the system's trash (or
   * for good, once the person chose that for a file the trash would not take), and the copy takes its
   * name — the one the app knows the template by. Unsaved edits to the copy are saved first.
   */
  private async keepCopy(permanently: boolean) {
    const copy = this.selected
    if (!copy) return
    const conflict = conflictOf(copy, this.entries)
    if (conflict === undefined || !('copyOf' in conflict)) return
    const original = conflict.copyOf
    this.originalUntrashable = false
    this.error = ''
    this.message = ''
    if (!(await this.savedFirst())) return
    const kept = await keepConflictCopy(copy, original, permanently)
    if (kept === 'untrashable') {
      this.originalUntrashable = true
      return
    }
    if (kept !== 'kept') {
      // Once the original is gone as asked, the copy stays under its own name, still a copy: the list shows it so.
      if (kept.originalGone) await this.refresh()
      this.error = kept.error
      return
    }
    await this.refresh()
    try {
      await this.select(original)
    } catch (e) {
      this.error = describeError(e)
      return
    }
    this.message = strings.keptCopy(permanently)
  }

  /** Saves unsaved edits to the open template first; false when they could not be saved — the error says why. */
  private async savedFirst(): Promise<boolean> {
    if (this.dirty) await this.save()
    return !this.dirty
  }

  /** Shows a conflict copy of the open template, once unsaved edits to it are let go. */
  private async viewCopy(copy: string) {
    if (!(await confirmDiscard())) return
    await this.select(copy).catch((e) => (this.error = describeError(e)))
  }


  /** Saves the template as it is on screen; the app's save shortcut calls this too. */
  async save() {
    if (!this.selected) return
    this.error = ''
    this.message = '' // "saved" is said again only once this save has landed
    try {
      // Unreadable front matter would read as a missing id: say what is actually wrong.
      const unreadable = templateProblems(this.source).find((p) => p.kind === 'front-matter')
      if (unreadable) {
        this.error = strings.templateProblem(unreadable)
        return
      }
      templateInfo(this.source) // a template must name itself
      // Unless the person was told the file changed outside, an edit made there since is not overwritten unseen.
      try {
        if (this.changedOutside) await vault.write(this.selected, this.source)
        else await vault.writeIfUnchanged(this.selected, this.loaded, this.source)
      } catch (e) {
        if (failureKind(e) !== 'changed-outside') throw e
        this.error = strings.changedOutsideDirty
        this.changedOutside = true
        return
      }
      this.loaded = this.source
      // The app's own writes are not reported back: a template made again after it was removed
      // outside rejoins the list here.
      await this.refresh()
      this.dirty = false
      this.changedOutside = false
      this.message = strings.saved
      this.dispatchEvent(new CustomEvent('ll-confirmed', { bubbles: true, composed: true }))
    } catch (e) {
      this.error = describeError(e)
    }
  }

  /** What stands in the way of the source working as written, as it is typed. */
  private renderProblems() {
    let problems: ReturnType<typeof templateProblems>
    try {
      problems = [
        ...templateProblems(this.source),
        ...sharedId(this.source, this.path, this.templateItems),
        ...referenceProblems(this.source, this.templateItems),
        ...strayFields(this.source, this.documents),
      ]
    } catch {
      return nothing
    }
    if (problems.length === 0) return nothing
    return html`<ul class="problems" aria-label=${strings.templateProblemsTitle}>
      ${problems.map(
        (p) =>
          html`<li>
            ${strings.templateProblem(p)}
            ${p.kind === 'unrecognized-field' && p.fix
              ? html`<dc-button size="sm" @click=${() => this.applyFix(p.fix!)}>${strings.templateFix}</dc-button>`
              : nothing}
          </li>`,
      )}
    </ul>`
  }

  /** For a template that names its judgment fields in its front matter, as templates written before did: the way onto the fields. */
  private renderMoveToFields() {
    let moved: string | undefined
    try {
      moved = moveSuggestToFields(this.source)
    } catch {
      return nothing
    }
    if (moved === undefined) return nothing
    return html`<p class="message move-to-fields">
      ${strings.suggestInFrontMatter}
      <dc-button size="sm" @click=${() => this.moveToFields(moved)}>${strings.moveSuggestToFields}</dc-button>
    </p>`
  }

  /** The template's fields: each can be made a judgment field, and a choice field's options edited. */
  private renderFields() {
    const fields = this.fields()
    const commit = (field: string) => (e: Event) => {
      const input = e.currentTarget as HTMLInputElement
      this.writeOptions(field, input.value, input)
    }
    return html`<div class="fields" role="group" aria-label=${strings.fieldsTitle}>
      <h3>${strings.fieldsTitle}</h3>
      <p class="message">${strings.fieldsHelp}</p>
      ${this.renderMoveToFields()}
      ${fields.length === 0
        ? html`<p class="message">${strings.fieldsNone}</p>`
        : fields.map(
            (f) => html`<dc-checkbox
                name=${f.name}
                .checked=${f.judgment}
                @change=${(e: Event) => this.toggleJudgment(f.name, (e.target as HTMLInputElement).checked)}
                >${f.label}</dc-checkbox
              >
              <span class="label-edit"
                ><ll-rename .name=${f.label} @ll-rename=${(e: CustomEvent<{ name: string }>) => this.setLabel(f.name, e.detail.name)}></ll-rename
              ></span>
              ${f.options
                ? html`<dc-input
                    aria-label=${strings.optionsOf(f.label)}
                    .value=${f.options}
                    @focusout=${commit(f.name)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') commit(f.name)(e)
                    }}
                  ></dc-input>`
                : html`<span></span>`}`,
          )}
    </div>`
  }

  render() {
    return html`
      ${this.selected
        ? html`<div class="page ${this.chatting ? 'chatting' : ''}">
            <section>
              <div class="bar">
                <h3>${strings.templateSource}</h3>
                <dc-button size="sm" ?disabled=${!this.dirty} @click=${this.save}>${strings.save}</dc-button>
                <ll-rename
                  .name=${fileName(this.selected, TEMPLATE_SUFFIX)}
                  @ll-rename=${(e: CustomEvent<{ name: string }>) => void this.rename(e.detail.name)}
                  @ll-rename-cancel=${() => (this.error = '')}
                ></ll-rename>
                <ll-delete
                  heading=${isCopy(this.selected, this.entries) ? strings.deleteCopyHeading : strings.deleteTemplateHeading}
                  body=${(isCopy(this.selected, this.entries) ? strings.deleteCopyBody : strings.deleteTemplateBody)(this.dirty)}
                  .untrashable=${this.untrashable}
                  @ll-delete=${(e: CustomEvent<{ permanently: boolean }>) => void this.delete(e.detail.permanently)}
                  @ll-delete-cancel=${() => (this.untrashable = false)}
                ></ll-delete>
                ${this.error
                  ? html`<span class="error" role="alert">${this.error}</span>`
                  : html`<span class="message" role="status">${this.message}</span>`}
                ${this.changedOutside
                  ? html`<dc-button size="sm" variant="secondary" @click=${this.readOutside}>${strings.readOutside}</dc-button>`
                  : nothing}
                <dc-button
                  size="sm"
                  variant=${this.chatting ? 'secondary' : 'ghost'}
                  aria-pressed=${this.chatting ? 'true' : 'false'}
                  @click=${() => (this.chatting = !this.chatting)}
                  >${strings.chat}</dc-button
                >
              </div>
              ${conflictNoticeFor(this.selected, this.entries, TEMPLATE_SUFFIX, strings.conflictedTemplate, {
                view: (copy) => void this.viewCopy(copy),
                keep: (original) => html`<ll-keep-copy
                  original=${original}
                  .untrashable=${this.originalUntrashable}
                  @ll-keep-copy=${(e: CustomEvent<{ permanently: boolean }>) => void this.keepCopy(e.detail.permanently)}
                  @ll-keep-copy-cancel=${() => (this.originalUntrashable = false)}
                ></ll-keep-copy>`,
              })}
              ${this.renderProblems()}
              <textarea
                spellcheck="false"
                aria-label=${strings.templateSource}
                .value=${this.source}
                @input=${this.onSourceInput}
              ></textarea>
            </section>
            <section class="side">
              ${this.renderFields()}
              <h3>${strings.preview}</h3>
              <div class="preview">
                <formdown-ui .content=${this.source}></formdown-ui>
              </div>
            </section>
            ${this.chatting
              ? html`<ll-chat-panel
                  aria-label=${strings.chat}
                  .model=${this.model}
                  .template=${this.source}
                  .saved=${this.loaded}
                  .templatesDir=${this.vaultInfo.templatesDir}
                  @ll-chat-draft=${(e: CustomEvent<{ source: string }>) => this.takeDraft(e.detail.source)}
                ></ll-chat-panel>`
              : nothing}
          </div>`
        : nothing}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'll-templates': LlTemplates
  }
}
