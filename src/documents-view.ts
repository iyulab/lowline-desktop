import { LitElement, css, html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { formdownTheme } from './formdown-theme.js'
import { desktopMedia } from '@iyulab/desktop-patterns/breakpoints'
import '@iyulab/desktop-patterns/list-detail'
import { guard } from 'lit/directives/guard.js'
import { keyed } from 'lit/directives/keyed.js'
import {
  documentTitle,
  fileName,
  fileNameFor,
  documentFrontMatter,
  fieldValues,
  hasFields,
  newDocument,
  reviseDocument,
  setDocumentId,
  settleProposed,
  templateBody,
  templateInfo,
  updateDocument,
  withTemplateBody,
  holdsValue,
  type FieldValues,
} from './documents.js'
import { documentId, newDocumentId, sharedIds } from './identity.js'
import { currentRefs, revisedRef, templateId, templateVersion } from './template-revision.js'
import { describeError } from './errors.js'
import { JudgmentController } from './judgment-controller.js'
import { cellText, referenceTargets, type CaseHit, type DocumentSnapshot, type Suggestion, type TemplateSnapshot } from './projection.js'
import { namedEvidence, referenceChoices, referringDocuments, referringTable } from './references.js'
import { strings } from './strings.js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { failureKind, host, removedBy, touches, vault, type VaultChanged, type VaultEntry, type VaultInfo } from './vault-client.js'
import { readVault, syncVault, onVaultChanged } from './vault-snapshot.js'
import { documentsOf, newestFirst, type TemplateItem } from './template-scope.js'
import { createDocumentFile } from './document-files.js'
import type { ModelSettings } from './settings.js'
import { conflictLabels, conflictNoticeFor, conflictOf, isCopy, noteFor } from './conflicts.js'
import { found, matchingLine, shownName, type Found } from './cases.js'
import { confirmDiscard, markUnsaved } from './unsaved.js'
import { deleteFile, keepConflictCopy } from './file-lifecycle.js'
import './import-view.js'
import './rename-control.js'
import './delete-control.js'
import './keep-copy-control.js'

/** How long typing in the list's filter pauses before the documents' values are looked in. */
const SEARCH_DELAY_MS = 250

/** What the view is asked from elsewhere to show: a document to open, or a new one started with values. */
export type Opening = { path: string } | { values: FieldValues }

/** What is open in the editor: a new document from a template, or an existing document. */
type Draft =
  | { kind: 'new'; templateSource: string; templateRef: string }
  | {
      kind: 'existing'
      path: string
      id: string
      /** The file as it was read: what a save checks it still holds. */
      source: string
      templateRef?: string
      /**
       * For a file with no fields of its own — front matter alone, as another program may write a record — its front
       * matter above its template's body: what the form draws, and what saving writes, so the file becomes the copy
       * of its template a document is.
       */
      filled?: string
    }

/**
 * A template's documents: fill in the template to create one, or open one and change its values.
 * Without a template (`null`), the documents that name none the vault has — to open and keep.
 */
@customElement('ll-documents')
export class LlDocuments extends LitElement {
  static styles = [
    formdownTheme,
    css`
    /* dp-list-detail lays the list out as wide as the sidebar beside it (1 : 1), the document taking
       the rest — and, in a narrow window, shows one of the two. */
    :host {
      display: flex;
      height: 100%;
      min-height: 0;
    }
    nav {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-1);
      padding-inline-end: var(--dc-space-2);
    }
    /* As wide as its label: the space beside it is not part of what toggles it. */
    nav .unsettled {
      align-self: flex-start;
    }
    section {
      padding-inline-start: var(--dc-space-4);
    }
    /* The way back to the list is needed only where the list is not beside the document. */
    /* So is what became of a document that closed — deleted, say — said where the list is. */
    @media ${desktopMedia} {
      .back,
      .closed {
        display: none;
      }
    }
    nav button {
      text-align: left;
      padding: var(--dc-space-2);
      border: 1px solid transparent;
      border-radius: var(--dc-radius-md);
      background: none;
      font: inherit;
      color: inherit;
      cursor: pointer;
    }
    nav button[aria-current='true'] {
      border-color: var(--dc-color-border);
      background: var(--dc-color-surface);
    }
    nav button .note,
    .similar button .note {
      display: block;
      font-size: 0.85em;
      color: var(--dc-color-text-muted);
    }
    .referring h3,
    .referring h4 {
      margin: var(--dc-space-2) 0 var(--dc-space-1);
      font-size: 0.875em;
      color: var(--dc-color-text-muted);
    }
    .referring-head {
      display: flex;
      align-items: center;
      gap: var(--dc-space-2);
    }
    .referring dc-data-table {
      font-size: 13px;
    }
    .similar summary {
      cursor: pointer;
      color: var(--dc-color-text-muted);
    }
    .similar ul {
      list-style: none;
      margin: var(--dc-space-1) 0 0;
      padding: 0;
    }
    .similar button {
      text-align: left;
      width: 100%;
      padding: var(--dc-space-2);
      border: 1px solid transparent;
      border-radius: var(--dc-radius-md);
      background: none;
      font: inherit;
      color: inherit;
      cursor: pointer;
    }
    .similar button:hover {
      background: var(--dc-color-surface);
    }
    .new {
      display: flex;
      gap: var(--dc-space-1);
      margin-bottom: var(--dc-space-2);
    }
    section {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-2);
      min-height: 100%;
      box-sizing: border-box;
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
    p.judgment {
      margin: 0;
      font-size: 0.875em;
    }
  `,
  ]

  @property({ attribute: false }) vaultInfo!: VaultInfo
  /** Whose documents: a template, or `null` for those naming none the vault has. */
  @property({ attribute: false }) scope: TemplateItem | null = null
  /**
   * What to show as soon as the view shows, asked for from elsewhere: a document to open, or a new one started with
   * values filled in — one naming the document a person was on, say.
   */
  @property({ attribute: false }) opening?: Opening
  /** The model set up for the chat, if any: importing can have it read records out of text. */
  @property({ attribute: false }) model: ModelSettings | null = null

  /** This template's documents, their conflict copies included. */
  @state() private documents: VaultEntry[] = []
  @state() private draft?: Draft
  /**
   * Values handed to the form when a draft opens; the form owns them after that. Lit
   * re-sets object values on every render, so the binding is guarded by `opened` —
   * otherwise each re-render (and each save) would hand the form its opening values again.
   */
  @state() private initialValues: FieldValues = {}
  /** Text the listed documents are narrowed to: in their names (ignoring case) or the words of their values. */
  @state() private nameFilter = ''
  /** Only the documents with a judgment field still empty are listed — those a person has yet to settle. */
  @state() private unsettledOnly = false
  private unsettledOf?: { inputs: readonly unknown[]; paths: Set<string> }
  /** This template's documents whose values hold the words of the filter text, as the sidecar found them. */
  @state() private valueHits: CaseHit[] = []
  /** The sidecar is looking through the values; or it could not, and only names are looked in. */
  @state() private valueSearch: 'idle' | 'searching' | 'failed' = 'idle'
  private searchTimer?: ReturnType<typeof setTimeout>
  /** Counts searches; only the latest one's answer is shown. */
  private searchRun = 0
  /** Counts reads of the vault's list, and the latest read the sidecar has been handed since. */
  private reads = 0
  /** The vault's templates and documents as last read: what reference fields offer (`references.ts`). */
  private vaultTemplates: TemplateSnapshot[] = []
  private vaultDocuments: DocumentSnapshot[] = []
  private handedOver = -1
  /** The documents most like the open one, once asked for by opening their list. */
  @state() private similar?: CaseHit[] | 'loading' | 'failed'
  /** Counts drafts opened; changes only when another draft is opened. */
  @state() private opened = 0
  /** The latest open or new document asked for: one that lands after a later one was asked for is dropped. */
  private asked = 0
  /** The form's current values, as it reports them. */
  private values: FieldValues = {}
  /** The draft's judgment fields: their suggestions, and what the person did with them. */
  private readonly judgment = new JudgmentController(this, {
    draft: () => this.draft && { templateRef: this.draft.templateRef, id: this.draft.kind === 'existing' ? this.draft.id : undefined },
    values: () => this.values,
    sourceOf: (s) => this.sourceOf(s),
    hasCases: () => this.draft?.kind === 'existing' && !!this.scope,
  })
  /** Ids more than one document holds (a file copied outside the app); see `sharedIds`. */
  private sharedIds = new Set<string>()
  /** The field the person was last in, to go back to once a save has drawn the form again. */
  private lastField?: string
  /** Template names (their file names) by `id@version`. */
  @state() private templateNames = new Map<string, string>()
  /** Each template id's reference now: a document of an earlier revision is read as its template now. */
  private currentRefs = new Map<string, string>()
  /** The open document's template reference as its file names it, when that is an earlier revision. */
  @state() private writtenWith?: string
  /** Counts accepted suggestions, so the form is handed its values again. */
  @state() private applied = 0
  @state() private dirty = false
  /** The import panel is showing instead of a document. */
  @state() private importing = false
  /** The open document changed outside while it had unsaved edits: the person chooses which to keep. */
  @state() private changedOutside = false
  /** The trash would not take the open document: whether to delete it for good is being asked. */
  @state() private untrashable = false
  /** The trash would not take the original of the open conflict copy being kept: whether to delete it for good is being asked. */
  @state() private originalUntrashable = false
  @state() private message = ''
  @state() private error = ''

  private unlisten?: Promise<UnlistenFn>

  connectedCallback() {
    super.connectedCallback()
    void this.refresh()
    if (this.opening) void this.openAsked(this.opening)
    this.unlisten = onVaultChanged((change) => void this.outsideChange(change))
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    void this.unlisten?.then((stop) => stop())
    markUnsaved('documents', false)
  }

  willUpdate(changed: Map<string, unknown>) {
    // Another template: the app asked before letting unsaved edits go.
    const before = changed.get('scope') as TemplateItem | null | undefined
    if (changed.has('scope') && before !== undefined && before?.ref !== this.scope?.ref) {
      this.reset()
      this.draft = undefined
      void this.refresh()
    }
    // Asked to open a document, or start one, while already showing. The first is opened as the view connects.
    if (changed.has('opening') && this.hasUpdated && this.opening) void this.openAsked(this.opening)
  }

  updated(changed: Map<string, unknown>) {
    // A view no longer shown holds no edits: an outside change that lands after it left says nothing.
    if (changed.has('dirty')) markUnsaved('documents', this.isConnected && this.dirty)
  }

  /**
   * Shows what another program did to the vault. The open document is read again only when it
   * has no unsaved edits; otherwise the person is told, and saving decides. Suggestions learn from
   * the vault as it is now.
   */
  private async outsideChange(change: VaultChanged) {
    await this.refresh()
    // A change that touched no file is the sidecar started again after it ended (`vault-snapshot.ts`): what it
    // could not suggest for the open draft is asked again, once it has the vault.
    if (!change.rescan && change.written.length === 0 && change.removed.length === 0) {
      if (this.draft) void this.judgment.prepare(this.draft.templateRef)
      return
    }
    const draft = this.draft
    if (draft?.kind === 'existing' && touches(change, draft.path)) {
      if (removedBy(change, draft.path, this.documents.map((d) => d.path))) {
        // What is on screen is now held nowhere else: it is unsaved, whatever was typed.
        this.dirty = true
        this.error = strings.removedOutside
        this.message = '' // an earlier "saved" no longer holds
      } else {
        const source = await vault.read(draft.path)
        // A notice that changed nothing leaves the screen alone. An edit made while the file was being
        // read is not replaced: the notice was about the file, not about what was typed since.
        if (this.draft !== draft || source === draft.source) {
          // nothing to show
        } else if (this.dirty) {
          this.error = strings.changedOutsideDirty
          this.message = ''
          this.changedOutside = true
        } else {
          await this.open(draft.path)
          if (!change.rescan) this.message = strings.reloadedOutside
          return // opening prepares the suggestions again
        }
      }
    }
    if (this.judgment.template) void this.judgment.prepare(draft?.templateRef)
  }

  private async refresh() {
    try {
      const read = await readVault()
      const templateOf = new Map(read.documents.map((d) => [d.path, d.template]))
      this.documents = newestFirst(documentsOf(read.documentEntries, templateOf, this.scope?.ref ?? null, new Set(read.names.keys())))
      this.templateNames = read.names
      this.currentRefs = currentRefs(read.templates)
      this.sharedIds = sharedIds(read.documents)
      this.vaultTemplates = read.templates
      this.vaultDocuments = read.documents
    } catch (e) {
      this.error = describeError(e)
    }
    this.reads++
    // What is being looked for may be in another document now, or in another template.
    this.scheduleSearch()
  }

  /**
   * Hands the sidecar the vault as the list last read it, if it has not been handed it since: what it
   * searches is what it was given, and the list may show documents written since.
   */
  private async handOver() {
    const read = this.reads
    if (this.handedOver >= read) return
    await syncVault()
    this.handedOver = Math.max(this.handedOver, read)
  }

  /** Looks for the filter text in this template's values a moment after typing stops. */
  private scheduleSearch() {
    clearTimeout(this.searchTimer)
    const text = this.nameFilter.trim()
    const run = ++this.searchRun
    if (!text || !this.scope) {
      this.valueHits = []
      this.valueSearch = 'idle'
      return
    }
    this.valueSearch = 'searching'
    const template = this.scope.ref
    this.searchTimer = setTimeout(async () => {
      try {
        await this.handOver()
        const hits = await host.search(text, template)
        if (run === this.searchRun) {
          this.valueHits = hits
          this.valueSearch = 'idle'
        }
      } catch {
        // Names are still looked in; the list says the values were not.
        if (run === this.searchRun) {
          this.valueHits = []
          this.valueSearch = 'failed'
        }
      }
    }, SEARCH_DELAY_MS)
  }

  /** Asks for the documents most like the open one the first time their list is opened. */
  private async showSimilar(path: string) {
    if (this.similar !== undefined && this.similar !== 'failed') return
    this.similar = 'loading'
    const isOpen = () => this.draft?.kind === 'existing' && this.draft.path === path
    try {
      await this.handOver()
      const similar = await host.similar(path)
      if (isOpen()) this.similar = similar
    } catch {
      if (isOpen()) this.similar = 'failed'
    }
  }

  private reset() {
    this.lastField = undefined
    this.error = ''
    this.importing = false
    this.writtenWith = undefined
    this.changedOutside = false
    this.untrashable = false
    this.originalUntrashable = false
    this.message = ''
    this.dirty = false
    this.judgment.reset()
    this.similar = undefined
  }

  /**
   * Puts a suggested value into the form. It is a value like any other until the document is saved. A class taken is
   * the start of the value: the cursor goes back into the field, after it, for the rest.
   */
  private accept(field: string, value: string) {
    const open = this.judgment.take(field)
    this.setValues({ ...this.values, [field]: value })
    this.initialValues = this.values
    this.applied++
    this.dirty = true
    this.message = ''
    if (open) void this.focusForm(field)
  }

  /** The form's values, and the order its fields were filled in. */
  private setValues(values: FieldValues) {
    this.values = values
    this.judgment.track(values)
  }

  /** Drops the unsaved edits and shows the document as it is on disk now. */
  private async readOutside() {
    if (this.draft?.kind !== 'existing') return
    await this.open(this.draft.path)
    this.message = strings.reloadedOutside
  }

  private async openAsked(opening: Opening) {
    if ('path' in opening) await this.open(opening.path)
    else if (this.scope) await this.startNew(this.scope.path, opening.values)
  }

  private async startNew(templatePath: string, values: FieldValues = {}) {
    const asked = ++this.asked
    this.reset()
    try {
      const templateSource = await vault.read(templatePath)
      if (asked !== this.asked) return
      const { ref } = templateInfo(templateSource)
      this.setValues(values)
      this.initialValues = this.values
      this.draft = { kind: 'new', templateSource, templateRef: ref }
      this.opened++
      void this.judgment.prepare(ref)
      // A new document is started to be written: the cursor goes to its first field.
      await this.focusForm()
    } catch (e) {
      if (asked === this.asked) this.error = describeError(e)
    }
  }

  private async open(path: string) {
    // On a slow vault (a network share) reads take a while: what was asked for last is what opens, and a read
    // that lands late does not draw its form over the one the person has gone on to fill in.
    const asked = ++this.asked
    this.reset()
    try {
      const source = await vault.read(path)
      if (asked !== this.asked) return
      const { template, id, values, proposed } = documentFrontMatter(source)
      // Written with an earlier revision, it is a document of its template as the template is now.
      const templateRef = template === undefined ? template : revisedRef(template, this.currentRefs)
      // A value another program only proposed is offered in its field, not filled in.
      this.setValues(this.judgment.opened(templateRef, fieldValues(values), proposed))
      this.initialValues = this.values
      const scope = this.scope
      const filled =
        !hasFields(source) && scope && template !== undefined && templateId(template) === templateId(scope.ref)
          ? withTemplateBody(source, await vault.read(scope.path))
          : undefined
      if (asked !== this.asked) return
      this.draft = { kind: 'existing', path, id: documentId(path, id), source, templateRef, ...(filled ? { filled } : {}) }
      this.writtenWith = template !== templateRef && template !== undefined ? template : undefined
      this.opened++
      void this.judgment.prepare(this.draft.templateRef)
    } catch (e) {
      if (asked === this.asked) this.error = describeError(e)
    }
  }

  /** Starts a new document of the template, once unsaved edits are let go; the app's Ctrl+N calls this. */
  newDocument() {
    if (this.scope) this.leaveFor(() => this.startNew(this.scope!.path))
  }

  /** Puts the cursor in the form once it is drawn: in the field named, or the first one a person can reach. */
  private async focusForm(field?: string) {
    await this.updateComplete
    const form = this.renderRoot.querySelector('formdown-ui')
    if (!form) return
    await form.updateComplete
    if (!(field && form.focusField(field))) form.focusField()
  }

  /** Remembers the field the person is in (a field of the form names itself). */
  private onFormFocus(e: FocusEvent) {
    for (const target of e.composedPath()) {
      if (!(target instanceof HTMLElement)) continue
      const name = target.getAttribute('data-field-name') ?? target.getAttribute('name')
      if (name) {
        this.lastField = name
        return
      }
      if (target.localName === 'formdown-ui') return
    }
  }

  /**
   * The list is one stop for Tab — the open document, or the first — and the arrow keys move within it,
   * so getting past a long list takes one key, not one per document.
   */
  private tabStop(paths: string[]): string | undefined {
    const open = this.draft?.kind === 'existing' ? this.draft.path : undefined
    return open !== undefined && paths.includes(open) ? open : paths[0]
  }

  /** ↑ ↓ Home End move focus along the list; Enter (the button's own) opens the document. */
  private moveInList(e: KeyboardEvent, at: number) {
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('nav button.document')]
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[e.key]
    if (to === undefined || to < 0 || to >= buttons.length) return
    e.preventDefault()
    buttons[at].tabIndex = -1
    buttons[to].tabIndex = 0
    buttons[to].focus()
  }

  /** Puts the cursor in the box that finds documents, if there are any to find; the app's Ctrl+F calls this. */
  focusFinder() {
    this.renderRoot.querySelector<HTMLElement>('nav dc-input')?.focus()
  }

  /**
   * Moves the open document, written with an earlier revision, to its template's revision now: its values
   * stay, its body becomes the revision's (`reviseDocument`). Unsaved edits are saved first.
   */
  private readonly reviseDocument = async () => {
    if (!(await this.savedFirst())) return
    const draft = this.draft
    if (draft?.kind !== 'existing' || !this.scope) return
    this.error = ''
    try {
      const source = reviseDocument(draft.source, await vault.read(this.scope.path))
      await vault.writeIfUnchanged(draft.path, draft.source, source)
      await this.refresh()
      await this.open(draft.path)
      this.message = strings.revised
    } catch (e) {
      this.error = failureKind(e) === 'changed-outside' ? strings.changedOutsideDirty : describeError(e)
    }
  }

  /** Saves the open document; the app's save shortcut calls this too. */
  async save() {
    const draft = this.draft
    if (!draft) return
    this.error = ''
    this.message = '' // "saved" is said again only once this save has landed
    try {
      if (draft.kind === 'existing') {
        // A copy saved with a change is a document of its own from now on. One known by its path — written by another
        // program, or before documents had ids — is given that path as its id, as renaming does: what is recorded
        // about it stays with it when it is moved.
        const id = this.sharedIds.has(draft.id) ? newDocumentId() : draft.id
        // A value still only proposed stays in the file as it was, marked; one the person decided loses its mark.
        const { values, settled } = this.judgment.forSave(this.values)
        const updated = settleProposed(updateDocument(draft.filled ?? draft.source, values), settled)
        const source = id === draft.id && documentFrontMatter(draft.source).id ? updated : setDocumentId(updated, id)
        // Unless the person was told the file changed outside, an edit made there since it was read is
        // not overwritten unseen — the watch may not have reported it yet, or at all.
        try {
          if (this.changedOutside) await vault.write(draft.path, source)
          else await vault.writeIfUnchanged(draft.path, draft.source, source)
        } catch (e) {
          if (failureKind(e) !== 'changed-outside') throw e
          this.error = strings.changedOutsideDirty
          this.changedOutside = true
          return
        }
        const { filled: _, ...read } = draft
        this.draft = { ...read, id, source }
      } else {
        const id = newDocumentId()
        const source = newDocument(draft.templateSource, this.values, id)
        const path = await this.createDocument(source, documentTitle(draft.templateSource, this.values))
        this.draft = { kind: 'existing', path, id, source, templateRef: draft.templateRef }
      }
      // The app's own writes are not reported back, so the list is read here: a new document, or
      // one made again after it was removed outside, joins it.
      await this.refresh()
      // What the save confirmed about the suggestions is recorded; what was typed is no longer being typed.
      await this.judgment.saved(this.draft?.kind === 'existing' ? this.draft.id : undefined)
      this.dirty = false
      this.changedOutside = false
      this.message = strings.saved
      // Saving draws the form again; the person goes on where they were.
      await this.focusForm(this.lastField)
      this.dispatchEvent(new CustomEvent('ll-confirmed', { bubbles: true, composed: true }))
      // What was just saved is confirmed: the next suggestions learn from it.
      void this.judgment.prepare(this.draft?.templateRef)
    } catch (e) {
      this.error = describeError(e)
    }
  }

  /**
   * Gives the open document the name typed — its file's name, which is what the lists show (R-1).
   * Unsaved edits are saved first. A document known by its path is given that path as its id before
   * it moves, so what was recorded about it stays with it. A name another document has is refused.
   */
  private async rename(name: string) {
    if (this.draft?.kind !== 'existing') return
    const file = fileNameFor(name, '.md')
    if (!file) {
      this.error = strings.nameInvalid
      return
    }
    const from = this.draft.path
    const to = `${from.slice(0, from.lastIndexOf('/') + 1)}${file}`
    if (to === from) return
    this.error = ''
    this.message = ''
    if (!(await this.savedFirst())) return
    const draft = this.draft
    if (draft?.kind !== 'existing') return
    try {
      const source = documentFrontMatter(draft.source).id ? draft.source : setDocumentId(draft.source, draft.id)
      if (source !== draft.source) await vault.writeIfUnchanged(draft.path, draft.source, source)
      try {
        await vault.rename(draft.path, to)
      } catch (e) {
        // Refused: the file is left as it was.
        if (source !== draft.source) await vault.write(draft.path, draft.source)
        throw e
      }
      this.draft = { ...draft, source, path: to }
      await this.refresh()
      this.message = strings.renamed
      // The sidecar knows documents by their paths too: it is handed the vault as it is now.
      void this.judgment.prepare(draft.templateRef)
    } catch (e) {
      const kind = failureKind(e)
      if (kind === 'changed-outside') this.changedOutside = true
      this.error = kind === 'already-exists' ? strings.nameTaken : kind === 'changed-outside' ? strings.changedOutsideDirty : describeError(e)
    }
  }

  /**
   * Deletes the open document — to the system's trash, or for good once the person chose that for a
   * file the trash would not take. Unsaved edits go with it: the question said so. What was recorded
   * about the document stays in the event files under its id; its values no longer teach suggestions.
   */
  private async delete(permanently: boolean) {
    const draft = this.draft
    if (draft?.kind !== 'existing') return
    const conflict = conflictOf(draft.path, this.documents)
    this.untrashable = false
    this.error = ''
    this.message = ''
    const deletion = await deleteFile(draft.path, permanently)
    if (deletion !== 'deleted') {
      if (deletion === 'untrashable') this.untrashable = true
      else this.error = deletion.error
      return
    }
    if (conflict !== undefined && 'copyOf' in conflict) {
      // Deleting a conflict copy keeps its original: that is where the person is taken.
      await this.refresh()
      await this.open(conflict.copyOf)
      this.message = strings.keptOriginal(permanently)
      return
    }
    this.reset()
    this.draft = undefined
    await this.refresh()
    this.message = permanently ? strings.removed : strings.trashed
  }

  /**
   * Keeps the open conflict copy in its original's place: the original goes to the system's trash (or
   * for good, once the person chose that for a file the trash would not take), and the copy takes its
   * name. Unsaved edits to the copy are saved first. The copy is not given an id of its own: it holds
   * the original's, or — a document known by its path — takes the original's path, and with it what
   * was recorded about the original.
   */
  private async keepCopy(permanently: boolean) {
    const draft = this.draft
    if (draft?.kind !== 'existing') return
    const conflict = conflictOf(draft.path, this.documents)
    if (conflict === undefined || !('copyOf' in conflict)) return
    const original = conflict.copyOf
    this.originalUntrashable = false
    this.error = ''
    this.message = ''
    if (!(await this.savedFirst())) return
    const kept = await keepConflictCopy(draft.path, original, permanently)
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
    await this.open(original)
    this.message = strings.keptCopy(permanently)
  }

  /** Saves unsaved edits to the open document first; false when they could not be saved — the error says why. */
  private async savedFirst(): Promise<boolean> {
    if (this.dirty) await this.save()
    return !this.dirty
  }

  /** Creates the document under a free name; never replaces an existing file. */
  private createDocument(source: string, title: string | undefined): Promise<string> {
    return createDocumentFile(this.vaultInfo.documentsDir, source, title)
  }

  /** Opens the document clicked in the list; the one open already stays as it is, edits and all. */
  private pick(path: string) {
    if (this.draft?.kind === 'existing' && this.draft.path === path) return
    this.leaveFor(() => this.open(path))
  }

  /** Goes elsewhere once unsaved edits to the open document are let go. */
  private async leaveFor(next: () => unknown) {
    if (await confirmDiscard()) await next()
  }

  /** What the draft's reference fields can name: the documents of the templates they refer to. */
  private choices(draft: Draft) {
    const template = this.vaultTemplates.find((t) => t.ref === draft.templateRef)
    return referenceChoices(template, this.vaultTemplates, this.vaultDocuments, this.templateNames, this.initialValues, draft.kind === 'existing' ? draft.id : undefined)
  }

  /** Closes the open document — in a narrow window, where the list and the document take turns, for the list. */
  private backToList() {
    this.reset()
    this.asked++ // a document still being read does not open over this
    this.draft = undefined
  }

  private startImport() {
    this.reset()
    this.asked++ // a document still being read does not open over this
    this.draft = undefined
    this.importing = true
  }

  private async imported(created: number) {
    this.importing = false
    await this.refresh()
    this.message = strings.imported(created)
  }

  /**
   * Takes the values of the form opened as draft `opened`. A form that has been replaced — another
   * draft opened, or the document deleted — can still report once, as its focused field blurs on
   * the way out: that is not an edit of what is open now.
   */
  private onData(e: CustomEvent<{ formData: Record<string, unknown> }>, opened: number) {
    if (opened !== this.opened || !this.draft) return
    const before = this.values
    this.values = fieldValues(e.detail.formData)
    this.judgment.edited(before, this.values)
    this.dirty = true
    this.message = ''
  }

  /** Which fields of this template learn from confirmed documents — set on the template's page. */
  private renderJudgment() {
    if (this.judgment.unavailable) return html`<p class="message judgment" role="status">${strings.suggestionsUnavailable}</p>`
    const template = this.judgment.template
    if (!template) return nothing
    return html`<p class="message judgment">${strings.judgmentFields(template.suggest.map((f) => this.judgment.label(f)))}</p>`
  }

  /** What a suggestion rests on, in words: the value it was settled with, or the similar document by its name. */
  private sourceOf(s: Suggestion): string {
    if (!s.source) return strings.suggestion
    if (s.mode === 'memory') {
      const path = this.vaultDocuments.find((d) => d.id === s.source)?.path
      return strings.suggestionSimilar(path ? fileName(path, '.md') : s.source)
    }
    const template = this.vaultTemplates.find((t) => t.ref === this.draft?.templateRef)
    return strings.suggestionKey(namedEvidence(s.source, template, this.vaultTemplates, this.vaultDocuments, this.templateNames))
  }

  /** The documents whose names or values hold the filter text (see `found`), and only those unsettled if asked. */
  private listed(unsettled = this.unsettled()): Found[] {
    const listed = found(this.documents, this.nameFilter, this.valueHits)
    return this.unsettledOnly ? listed.filter((l) => unsettled.has(l.entry.path)) : listed
  }

  /**
   * The documents of this list with a judgment field of their template left empty, or holding a value another program
   * only proposed: records another program wrote for a person to confirm, or ones saved before every judgment was made. Conflict copies are not among them —
   * they are settled by keeping one of the two.
   */
  private unsettled(): Set<string> {
    // Worked out again only when the list or what was read changed: the view draws often, a vault holds thousands.
    const inputs = [this.documents, this.vaultDocuments, this.vaultTemplates, this.scope] as const
    if (this.unsettledOf?.inputs.every((input, i) => input === inputs[i])) return this.unsettledOf.paths
    const suggest = new Map(this.vaultTemplates.map((t) => [t.ref, t.suggest]))
    const scoped = this.scope ? suggest.get(this.scope.ref) : undefined
    const listed = new Set(this.documents.filter((d) => d.conflictOf === undefined).map((d) => d.path))
    const unsettled = new Set<string>()
    for (const d of this.vaultDocuments) {
      if (!listed.has(d.path)) continue
      const fields = suggest.get(d.template) ?? scoped ?? []
      // A value another program proposed is not settled until a person decides it.
      const settled = (f: string) => !d.proposed?.includes(f) && holdsValue(typeof d.values[f] === 'string' ? (d.values[f] as string).trim() : d.values[f])
      if (fields.some((f) => !settled(f)))
        unsettled.add(d.path)
    }
    this.unsettledOf = { inputs, paths: unsettled }
    return unsettled
  }

  /**
   * Saves the open document, then opens the next one with a judgment field still empty, in the list's order after
   * it — round to the top; the app's Ctrl+Enter calls this. With none left, the document stays open and says so.
   */
  async saveAndNext() {
    if (!this.draft) return
    if (!(await this.savedFirst())) return
    const at = this.draft?.kind === 'existing' ? this.draft.path : undefined
    const unsettled = this.unsettled()
    const order = found(this.documents, this.nameFilter, this.valueHits).map((l) => l.entry.path)
    const from = at === undefined ? -1 : order.indexOf(at)
    const next = [...order.slice(from + 1), ...order.slice(0, from + 1)].find((p) => p !== at && unsettled.has(p))
    if (next === undefined) {
      this.message = strings.noMoreUnsettled
      return
    }
    await this.open(next)
    await this.focusForm()
  }

  /**
   * What a similar document confirmed in this template's judgment fields, as the vault holds it — the evidence a
   * person reads for themselves, never a suggestion.
   */
  private judgedIn(path: string) {
    const fields = this.judgment.template?.suggest ?? []
    const values = this.vaultDocuments.find((d) => d.path === path)?.values
    const judged = fields.flatMap((f) => (holdsValue(values?.[f]) ? [{ label: this.judgment.label(f), value: cellText(values![f]) }] : []))
    return judged.length ? html`<span class="note judged">${strings.similarJudged(judged)}</span>` : nothing
  }

  /** The documents most like the open one, folded until opened: a person asks for them, they are not offered. */
  private renderSimilar(path: string) {
    const similar = this.similar
    return html`<details class="similar" @toggle=${(e: Event) => (e.target as HTMLDetailsElement).open && void this.showSimilar(path)}>
      <summary>${strings.similarCases}</summary>
      ${similar === undefined || similar === 'loading'
        ? html`<p class="message" role="status">${strings.similarLoading}</p>`
        : similar === 'failed'
          ? html`<p class="message" role="status">${strings.similarFailed}</p>`
          : similar.length === 0
            ? html`<p class="message">${strings.similarNone}</p>`
            : html`<ul>
                ${similar.map(
                  (hit) => html`<li>
                    <button @click=${() => this.leaveFor(() => this.open(hit.path))}>
                      ${fileName(hit.path, '.md')}
                      <span class="note">${matchingLine(hit.text, '')}</span>
                      ${this.judgedIn(hit.path)}
                    </button>
                  </li>`,
                )}
              </ul>`}
    </details>`
  }

  /**
   * Under a document of a template other documents refer to — a customer — the documents that name it, by
   * template, the newest first, as a table: the rows a paper form lists under it (the items of a requisition), each
   * a document of its own. A new one is started naming it. One of another template opens in its own place.
   */
  private renderReferring(id: string) {
    const scope = this.scope
    if (!scope || !referenceTargets(this.vaultTemplates).has(templateId(scope.ref))) return nothing
    const groups = referringDocuments(id, templateId(scope.ref), this.vaultTemplates, this.vaultDocuments)
    return html`<div class="referring" role="region" aria-label=${strings.referringTitle}>
      <h3>${strings.referringTitle}</h3>
      ${groups.map((group) => {
        const name = this.templateNames.get(group.template) ?? group.template
        const table = referringTable(group, this.vaultTemplates.find((t) => t.ref === group.template), this.vaultTemplates, this.vaultDocuments, this.templateNames)
        return html`<div class="referring-head">
            <h4>${strings.referringGroup(name, group.documents.length)}</h4>
            <dc-button size="sm" variant="secondary" @click=${() => this.leaveFor(() => this.startNaming(group.template, { [group.fields[0]]: id }))}
              >${strings.referringAdd(name)}</dc-button
            >
          </div>
          <dc-data-table
            .columns=${table.columns}
            .rows=${table.rows}
            empty-label=${strings.referringNone}
            @activate=${(e: CustomEvent<{ id: string }>) => this.leaveFor(() => this.openNaming(group.template, e.detail.id))}
          ></dc-data-table>`
      })}
    </div>`
  }

  /** Opens a document that names the one open here: in this view if it is of this template, else in its own place. */
  private async openNaming(template: string, path: string) {
    if (this.scope && templateId(template) === templateId(this.scope.ref)) return this.open(path)
    this.dispatchEvent(
      new CustomEvent('ll-open-document', { detail: { path, template: revisedRef(template, this.currentRefs) }, bubbles: true, composed: true }),
    )
  }

  /** Starts a document naming the one open here: in this view if it is of this template, else in its own place. */
  private async startNaming(template: string, values: FieldValues) {
    if (this.scope && templateId(template) === templateId(this.scope.ref)) return this.startNew(this.scope.path, values)
    this.dispatchEvent(
      new CustomEvent('ll-new-document', { detail: { template: revisedRef(template, this.currentRefs), values }, bubbles: true, composed: true }),
    )
  }

  render() {
    const draft = this.draft
    const opened = this.opened
    // Worked out once for the list, not once per row: a vault holds thousands of documents.
    const unsettled = this.unsettled()
    const listed = this.listed(unsettled)
    const tabStop = this.tabStop(listed.map((l) => l.entry.path))
    const conflictLabel = conflictLabels(this.documents, '.md')
    return html`<dp-list-detail ?detail-open=${!!draft || this.importing}>
      <nav slot="list" aria-label=${strings.navDocuments}>
        ${this.scope
          ? html`<div class="new">
              <dc-button size="sm" variant="secondary" @click=${() => this.leaveFor(() => this.startNew(this.scope!.path))}
                >${strings.newDocument}</dc-button
              >
              <dc-button size="sm" variant="ghost" @click=${() => this.leaveFor(() => this.startImport())}>${strings.import}</dc-button>
            </div>`
          : nothing}
        ${this.documents.length > 0
          ? html`<dc-input
              size="sm"
              type="search"
              aria-label=${strings.documentsFilter}
              placeholder=${strings.documentsFilter}
              .value=${this.nameFilter}
              @input=${(e: Event) => {
                this.nameFilter = (e.target as HTMLInputElement).value
                this.scheduleSearch()
              }}
            ></dc-input>`
          : nothing}
        ${unsettled.size > 0 || this.unsettledOnly
          ? html`<dc-checkbox class="unsettled" .checked=${this.unsettledOnly} @change=${(e: Event) => (this.unsettledOnly = (e.target as HTMLInputElement).checked)}
              >${strings.documentsUnsettledOnly(unsettled.size)}</dc-checkbox
            >`
          : nothing}
        ${!draft && !this.importing && (this.error || this.message)
          ? html`<p class="closed ${this.error ? 'error' : 'message'}" role=${this.error ? 'alert' : 'status'}>
              ${this.error || this.message}
            </p>`
          : nothing}
        ${this.valueSearch === 'idle'
          ? nothing
          : html`<p class="message" role="status">
              ${this.valueSearch === 'searching' ? strings.documentsSearching : strings.documentsSearchFailed}
            </p>`}
        ${this.documents.length === 0
          ? html`<p class="message">${strings.noDocuments}</p>`
          : listed.length === 0
            ? this.valueSearch === 'searching'
              ? nothing
              : html`<p class="message">${strings.documentsNoMatch}</p>`
            : listed.map(
              ({ entry: d, line }, i) => html`<button
                class="document"
                aria-current=${draft?.kind === 'existing' && draft.path === d.path}
                tabindex=${tabStop === d.path ? 0 : -1}
                @click=${() => this.pick(d.path)}
                @keydown=${(e: KeyboardEvent) => this.moveInList(e, i)}
              >
                ${shownName(d)}
                ${noteFor(conflictLabel(d))}
                ${line === undefined ? nothing : html`<span class="note">${line}</span>`}
              </button>`,
            )}
      </nav>
      <section>
        ${this.importing
          ? html`<ll-import
              .vaultInfo=${this.vaultInfo}
              .template=${this.scope}
              .model=${this.model}
              @ll-imported=${(e: CustomEvent<{ created: number }>) => void this.imported(e.detail.created)}
              @ll-import-cancel=${() => (this.importing = false)}
            ></ll-import>`
          : draft
          ? html`
              <div class="bar">
                <dc-button class="back" size="sm" variant="ghost" @click=${() => this.leaveFor(() => this.backToList())}
                  >${strings.backToList}</dc-button
                >
                <dc-button size="sm" ?disabled=${!this.dirty} @click=${this.save}>${strings.save}</dc-button>
                ${unsettled.size > (draft.kind === 'existing' && unsettled.has(draft.path) ? 1 : 0)
                  ? html`<dc-button size="sm" variant="secondary" title="Ctrl+Enter" @click=${() => void this.saveAndNext()}
                      >${strings.saveAndNext}</dc-button
                    >`
                  : nothing}
                ${draft.kind === 'existing'
                  ? html`<ll-rename
                      .name=${fileName(draft.path, '.md')}
                      @ll-rename=${(e: CustomEvent<{ name: string }>) => void this.rename(e.detail.name)}
                      @ll-rename-cancel=${() => (this.error = '')}
                    ></ll-rename>
                    <ll-delete
                      heading=${isCopy(draft.path, this.documents) ? strings.deleteCopyHeading : strings.deleteDocumentHeading}
                      body=${(isCopy(draft.path, this.documents) ? strings.deleteCopyBody : strings.deleteDocumentBody)(this.dirty)}
                      .untrashable=${this.untrashable}
                      @ll-delete=${(e: CustomEvent<{ permanently: boolean }>) => void this.delete(e.detail.permanently)}
                      @ll-delete-cancel=${() => (this.untrashable = false)}
                    ></ll-delete>`
                  : nothing}
                ${draft.templateRef && !this.scope
                  ? html`<span class="message">${strings.documentFrom(this.templateNames.get(draft.templateRef) ?? draft.templateRef)}</span>`
                  : nothing}
                ${this.error
                  ? html`<span class="error" role="alert">${this.error}</span>`
                  : html`<span class="message" role="status">${this.message}</span>`}
                ${this.changedOutside
                  ? html`<dc-button size="sm" variant="secondary" @click=${this.readOutside}>${strings.readOutside}</dc-button>`
                  : nothing}
              </div>
              ${draft.kind === 'existing'
                ? conflictNoticeFor(draft.path, this.documents, '.md', strings.conflictedOriginal, {
                    view: (copy) => void this.leaveFor(() => this.open(copy)),
                    keep: (original) => html`<ll-keep-copy
                      original=${original}
                      .untrashable=${this.originalUntrashable}
                      @ll-keep-copy=${(e: CustomEvent<{ permanently: boolean }>) => void this.keepCopy(e.detail.permanently)}
                      @ll-keep-copy-cancel=${() => (this.originalUntrashable = false)}
                    ></ll-keep-copy>`,
                  })
                : nothing}
              ${draft.kind === 'existing' && this.writtenWith && draft.templateRef
                ? html`<p class="message">${strings.writtenWith(templateVersion(this.writtenWith), templateVersion(draft.templateRef))}</p>
                    <div class="bar"><dc-button size="sm" variant="secondary" @click=${this.reviseDocument}>${strings.reviseDocument}</dc-button></div>`
                : nothing}
              ${this.renderJudgment()}
              ${keyed(
                opened,
                html`<formdown-ui
                .content=${draft.kind === 'new' ? templateBody(draft.templateSource) : (draft.filled ?? draft.source)}
                .data=${guard([this.opened, this.applied], () => this.initialValues)}
                .choices=${guard([this.opened, this.reads], () => this.choices(draft))}
                .fieldStates=${guard([this.judgment.suggestions, this.judgment.abstained, this.judgment.proposed], () => this.judgment.fieldStates())}
                @focusin=${this.onFormFocus}
                @formdown-data-update=${(e: CustomEvent<{ formData: Record<string, unknown> }>) => this.onData(e, opened)}
                @formdown-suggestion-pick=${(e: CustomEvent<{ field: string; value: string }>) => this.accept(e.detail.field, e.detail.value)}
                @formdown-suggestion-decline=${(e: CustomEvent<{ field: string }>) => this.judgment.reject(e.detail.field)}
              ></formdown-ui>`,
              )}
              ${draft.kind === 'existing' ? this.renderReferring(draft.id) : nothing}
              ${draft.kind === 'existing' && this.scope ? keyed(opened, this.renderSimilar(draft.path)) : nothing}
            `
          : this.error
            ? html`<p class="error" role="alert">${this.error}</p>`
            : this.message
              ? html`<p class="message" role="status">${this.message}</p>`
              : nothing}
      </section>
    </dp-list-detail>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'll-documents': LlDocuments
  }
}
