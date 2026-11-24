import { LitElement, css, html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { createDocumentFile } from './document-files.js'
import { documentTitle, newDocument } from './documents.js'
import { newDocumentId } from './identity.js'
import { describeError } from './errors.js'
import { importFields, planImport, recordsFromReply, rowsFromRecords, textPieces, type ColumnUse, type ImportField, type ImportPlan } from './import.js'
import { LOCAL_PRESET, failureText, localModelLabel } from './model-settings.js'
import { templateSnapshot } from './projection.js'
import { documentNames, type DocumentNames } from './references.js'
import type { ModelSettings } from './settings.js'
import { strings } from './strings.js'
import type { TemplateItem } from './template-scope.js'
import { model as models, vault, type VaultInfo } from './vault-client.js'
import { readVault } from './vault-snapshot.js'

/** How many values that do not fit are listed; the rest are counted. */
const PROBLEMS_SHOWN = 10

/** The most text taken at once — read piece by piece, which on a computer without a graphics card takes minutes. */
export const TEXT_LIMIT = 4000

/**
 * The text one request reads: a model running on a computer's processor alone reads a few records of it — with its
 * instructions, and its answer — well within one request's time.
 */
export const PIECE_SIZE = 300

/**
 * Brings existing records in: rows copied from a spreadsheet, the first naming the columns, become documents of the
 * template — or, with a model set up, text that is not a table (mail, notes), which the model reads into the
 * template's fields. Nothing is written until the person confirms what the preview shows; a value the model gave a
 * judgment field comes in as its suggestion, for a person to decide.
 */
@customElement('ll-import')
export class LlImport extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-3);
      font-size: 13px;
    }
    p {
      margin: 0;
    }
    h2 {
      margin: 0;
      font-size: 15px;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: var(--dc-space-2);
    }
    select {
      font: inherit;
      padding: var(--dc-space-1);
    }
    dc-paste-rows-zone {
      --dc-font-size-sm: 13px;
    }
    table {
      border-collapse: collapse;
      font-size: 13px;
    }
    th,
    td {
      text-align: left;
      padding: var(--dc-space-1) var(--dc-space-3) var(--dc-space-1) 0;
    }
    .unmatched {
      color: var(--dc-color-text-muted);
    }
    ul {
      margin: 0;
      padding-left: 1.2em;
      font-size: 13px;
    }
    .message {
      color: var(--dc-color-text-muted);
    }
    .error {
      color: var(--dc-color-danger);
    }
    h3 {
      margin: var(--dc-space-2) 0 0;
      font-size: 13px;
    }
    textarea {
      font: inherit;
      min-height: 7em;
      padding: var(--dc-space-2);
      resize: vertical;
    }
    .records {
      overflow-x: auto;
    }
    .records td {
      vertical-align: top;
    }
  `

  @property({ attribute: false }) vaultInfo!: VaultInfo
  /** The template the rows become documents of. */
  @property({ attribute: false }) template!: TemplateItem
  /** The model set up for the chat, if any: it can read records out of text. */
  @property({ attribute: false }) model: ModelSettings | null = null

  @state() private templatePath = ''
  @state() private templateSource = ''
  @state() private fields: ImportField[] = []
  /** The template's judgment fields: what a model's values come in as suggestions for. */
  @state() private judgment: string[] = []
  /** The vault's documents by name, for a reference field's cells to name — read with the template. */
  private names?: DocumentNames
  @state() private plan?: ImportPlan
  /** The pasted rows, kept to plan again when the person changes what a column is kept for. */
  private rows: string[][] = []
  @state() private busy = false
  /** Documents created so far in the running import. */
  @state() private created = 0
  @state() private error = ''
  /** Text pasted for the model to read, and whether it is reading it. */
  @state() private text = ''
  @state() private reading = false
  /** How far reading has got: pieces read of all, and records found so far. */
  @state() private read = { done: 0, of: 0, found: 0 }
  /** When reading ended before the last piece: how far it got, said beside what was read. */
  @state() private partial = ''
  /** Set to stop reading after the piece being read. */
  private stopReading = false
  /** Who the judgment values of the planned records are suggestions of — the model that read them — or none. */
  @state() private proposedBy = ''

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('template') && this.template.path !== this.templatePath) void this.readTemplate(this.template.path)
  }

  private async readTemplate(path: string) {
    this.error = ''
    this.plan = undefined
    this.templatePath = path
    this.fields = []
    this.judgment = []
    this.names = undefined
    try {
      this.templateSource = await vault.read(path)
      const fields = importFields(this.templateSource)
      // Only a template with a reference field needs the vault's documents.
      if (fields.some((f) => f.reference)) this.names = documentNames((await readVault()).documents)
      this.fields = fields
      this.judgment = templateSnapshot(this.templateSource).suggest
    } catch (e) {
      this.error = describeError(e)
    }
  }

  private onRows(e: CustomEvent<{ rows: string[][] }>) {
    this.error = ''
    this.partial = ''
    this.proposedBy = ''
    this.rows = e.detail.rows
    this.plan = planImport(this.rows, this.fields, undefined, this.names)
  }

  /**
   * Has the model read the text into records, a piece at a time — asking once more for a piece whose answer holds none
   * it can read — and plans them as rows are planned. The judgment values it gave are its suggestions. Stopping, or a
   * piece that could not be read, keeps what was read before it, and says how far reading got.
   */
  private async readText() {
    const model = this.model
    if (!model || !this.text.trim() || this.text.length > TEXT_LIMIT) return
    const pieces = textPieces(this.text, PIECE_SIZE)
    this.error = ''
    this.partial = ''
    this.plan = undefined
    this.reading = true
    this.stopReading = false
    this.read = { done: 0, of: pieces.length, found: 0 }
    const records: Record<string, unknown>[] = []
    try {
      for (const piece of pieces) {
        if (this.stopReading) break
        let read: Record<string, unknown>[] | null = null
        for (let tries = 0; tries < 2 && read === null && !this.error; tries++) {
          const reply = await models.extract(model, this.templateSource, piece)
          if (reply.ok) read = recordsFromReply(reply.text ?? '')
          else this.error = strings.importTextFailed(failureText(reply.failure, reply.statusCode))
        }
        if (this.error) break
        if (read === null) {
          this.error = strings.importTextUnread
          break
        }
        records.push(...read)
        this.read = { done: this.read.done + 1, of: pieces.length, found: records.length }
      }
    } catch (e) {
      this.error = describeError(e)
    } finally {
      this.reading = false
    }
    if (records.length === 0) {
      if (!this.error) this.error = strings.importTextNone
      return
    }
    if (this.read.done < pieces.length) this.partial = strings.importTextPartial(this.read.done, pieces.length)
    this.rows = rowsFromRecords(records, this.fields)
    this.proposedBy = strings.importProposedBy(model.preset === LOCAL_PRESET ? localModelLabel(model.model) : model.model)
    this.plan = planImport(this.rows, this.fields, this.fields.map(() => undefined), this.names)
  }

  /** A column that fills no field is kept for `use` — one column for each use. */
  private keepFor(index: number, use: ColumnUse | undefined) {
    if (!this.plan) return
    const uses = this.plan.columns.map((c, i) => (i === index ? use : c.use === use ? undefined : c.use))
    this.plan = planImport(this.rows, this.fields, uses, this.names)
  }

  /** A field's label; a problem about a day names the column, which is no field. */
  private label(field: string | undefined): string {
    return this.fields.find((f) => f.name === field)?.label ?? field ?? ''
  }

  private async importDocuments() {
    const plan = this.plan
    if (!plan || plan.documents.length === 0) return
    this.busy = true
    this.error = ''
    this.created = 0
    let created = 0
    try {
      const today = new Date()
      for (const record of plan.documents) {
        // A judgment value the model read is its suggestion: shown in the field, learned from once a person decides it.
        const proposed = this.proposedBy ? Object.fromEntries(this.judgment.map((f) => [f, this.proposedBy])) : {}
        const source = newDocument(this.templateSource, record.values, newDocumentId(), proposed)
        // Named as the record was: its own day, and its code before the title the fields give.
        const title = [record.name, documentTitle(this.templateSource, record.values)].filter(Boolean).join(' ') || undefined
        await createDocumentFile(this.vaultInfo.documentsDir, source, title, record.date ?? today)
        created++
        this.created = created
      }
      this.dispatchEvent(new CustomEvent('ll-imported', { detail: { created }, bubbles: true, composed: true }))
    } catch (e) {
      // What was created stays: each document is a file of its own.
      this.error = strings.importStopped(created, describeError(e))
      this.plan = undefined
    } finally {
      this.busy = false
    }
  }

  private cancel() {
    this.dispatchEvent(new CustomEvent('ll-import-cancel', { bubbles: true, composed: true }))
  }

  render() {
    const plan = this.plan
    return html`
      <h2>${strings.importTitle}</h2>
      <div class="bar">
        <dc-button size="sm" variant="ghost" ?disabled=${this.busy} @click=${this.cancel}>${strings.cancel}</dc-button>
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.templatePath && this.fields.length
        ? html`<p class="message">${strings.importHint}</p>
            <dc-paste-rows-zone placeholder=${strings.importPaste} @rows=${this.onRows}></dc-paste-rows-zone>
            ${this.renderText()}`
        : nothing}
      ${plan ? this.renderPlan(plan) : nothing}
    `
  }

  /** Text that is not a table, for the model set up to read — or, without one, where to set one up. */
  private renderText() {
    if (!this.model) return html`<h3>${strings.importTextTitle}</h3><p class="message">${strings.importTextNoModel}</p>`
    const over = this.text.length > TEXT_LIMIT
    return html`
      <h3>${strings.importTextTitle}</h3>
      <p class="message">${strings.importTextHint(TEXT_LIMIT)}</p>
      <textarea
        aria-label=${strings.importTextLabel}
        .value=${this.text}
        ?disabled=${this.reading}
        @input=${(e: Event) => (this.text = (e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="bar">
        <dc-button size="sm" ?disabled=${this.reading || this.busy || !this.text.trim() || over} @click=${this.readText}
          >${strings.importTextRead}</dc-button
        >
        <span class=${over ? 'error' : 'message'}>${strings.importTextCount(this.text.length, TEXT_LIMIT)}</span>
        ${this.reading
          ? html`<span class="message" role="status">${strings.importTextReading(this.read.done, this.read.of, this.read.found)}</span>
              <dc-button size="sm" variant="ghost" ?disabled=${this.stopReading} @click=${() => (this.stopReading = true)}
                >${strings.importTextStop}</dc-button
              >`
          : nothing}
      </div>
    `
  }

  /** The records the model read, field by field — what the person checks before they come in. */
  private renderRecords(plan: ImportPlan) {
    const shown = this.fields.filter((f) => plan.documents.some((d) => d.values[f.name] !== undefined))
    const text = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? '예' : '아니오') : String(v ?? ''))
    // A reference field holds a document's id: it is shown by the document's name.
    const cell = (f: ImportField, v: unknown) => (f.reference && typeof v === 'string' && this.names?.nameOf(f.reference, v)) || text(v)
    return html`<div class="records">
      <table aria-label=${strings.importRecords}>
        <thead>
          <tr>
            ${shown.map((f) => html`<th scope="col">${f.label}${this.judgment.includes(f.name) ? ' *' : ''}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${plan.documents.map((d) => html`<tr>${shown.map((f) => html`<td>${cell(f, d.values[f.name])}</td>`)}</tr>`)}
        </tbody>
      </table>
    </div>
    <p class="message">${strings.importProposedNote(this.proposedBy)}</p>
    ${this.partial ? html`<p class="message" role="status">${this.partial}</p>` : nothing}`
  }

  /** Which field each pasted column fills — or, for one that fills none, what it is kept for. */
  private renderColumns(plan: ImportPlan) {
    return html`
      <table>
        <thead>
          <tr>
            <th scope="col">${strings.importColumn}</th>
            <th scope="col">${strings.importField}</th>
          </tr>
        </thead>
        <tbody>
          ${plan.columns.map(
            (c, i) => html`<tr>
              <td>${c.heading}</td>
              <td class=${c.field || c.use ? '' : 'unmatched'}>
                ${c.field
                  ? this.label(c.field)
                  : html`<select
                      aria-label=${strings.importUseOf(c.heading)}
                      .value=${c.use ?? ''}
                      @change=${(e: Event) => this.keepFor(i, ((e.target as HTMLSelectElement).value || undefined) as ColumnUse | undefined)}
                    >
                      <option value="" ?selected=${!c.use}>${strings.importUnmatched}</option>
                      <option value="date" ?selected=${c.use === 'date'}>${strings.importUseDate}</option>
                      <option value="name" ?selected=${c.use === 'name'}>${strings.importUseName}</option>
                    </select>`}
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
    `
  }

  private renderPlan(plan: ImportPlan) {
    const problems = plan.problems
    return html`
      ${this.proposedBy ? this.renderRecords(plan) : this.renderColumns(plan)}
      <p class="message" role="status">${strings.importSummary(plan.documents.length, plan.skipped)}</p>
      ${problems.length
        ? html`<p>${strings.importProblems(problems.length)}</p>
            <ul>
              ${problems
                .slice(0, PROBLEMS_SHOWN)
                .map((p) => html`<li>${strings.importProblem(p.row, this.label(p.field), p.value, p.reason)}</li>`)}
            </ul>`
        : nothing}
      <div class="bar">
        <dc-button
          size="sm"
          ?disabled=${this.busy || plan.documents.length === 0}
          @click=${this.importDocuments}
          >${this.busy
            ? strings.importing(this.created, plan.documents.length)
            : strings.importConfirm(plan.documents.length)}</dc-button
        >
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'll-import': LlImport
  }
}
