import { LitElement, css, html, nothing } from 'lit'
import { customElement, queryAll, state } from 'lit/decorators.js'
import { live } from 'lit/directives/live.js'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DpSidebarActionEvent, DpSidebarActivateEvent, DpSidebarSelectEvent } from '@iyulab/desktop-patterns/sidebar'
import { desktopMinWidth } from '@iyulab/desktop-patterns/breakpoints'
import type { DcTabChangeEvent } from '@iyulab/desktop-compact/tab-bar'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { createSampleTemplate, createTemplateFile } from './document-files.js'
import type { LlMark } from './brand/mark.js'
import { describeError } from './errors.js'
import { referenceTargets } from './projection.js'
import { strings } from './strings.js'
import { NEW_TEMPLATE, documentsOf, placeId, placeOf, sidebarEntries, templatesAfterRead, type Place, type TemplateItem } from './template-scope.js'
import { onNavigationRefused, onWritten, openLink, vault, type VaultInfo } from './vault-client.js'
import { openVault, readVault, resumeVault, onVaultChanged } from './vault-snapshot.js'
import { confirmDiscard, hasUnsaved, setDiscardQuestion } from './unsaved.js'
import { RELEASES_PAGE, toTell, update, type UpdateView } from './updates.js'
import { DEFAULT_SETTINGS, settings as deviceSettings, type ModelSettings, type Settings } from './settings.js'
import './templates-view.js'
import './documents-view.js'
import type { LlDocuments, Opening } from './documents-view.js'
import type { FieldValues } from './documents.js'
import './table-view.js'
import './learning-view.js'
import './about-dialog.js'

/** What of a template shows: its table, its source, or its documents. */
type Tab = 'table' | 'template' | 'documents'

/** Whether a modal dialog is open anywhere in the page — dialogs live in components' shadow roots. */
function modalOpen(root: Document | ShadowRoot): boolean {
  if (root.querySelector('dialog[open]')) return true
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot && modalOpen(el.shadowRoot)) return true
  return false
}

/** The sidebar's foot: actions that show the shortcuts and what Lowline is, not places. */
const SHORTCUTS = 'shortcuts'
const ABOUT = 'about'

@customElement('ll-app')
export class LlApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
    dp-shell {
      height: 100%;
    }
    .place {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-3);
      height: 100%;
      min-height: 0;
    }
    .place > :last-child,
    dp-page > ll-documents {
      flex: 1;
      min-height: 0;
    }
    .error {
      color: var(--dc-color-danger);
    }
    .notice-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--dc-space-2);
      margin: 0 0 var(--dc-space-2);
    }
    .notice-bar a {
      color: var(--dc-color-accent-text);
    }
    .notice {
      margin: 0 0 var(--dc-space-2);
      color: var(--dc-color-text-muted);
      user-select: text; /* an address said here is copied from it */
    }
    .welcome {
      min-height: 60vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--dc-space-5);
      text-align: center;
    }
    .welcome p {
      margin: 0;
      color: var(--dc-color-text-secondary);
    }
    .choices {
      display: flex;
      gap: var(--dc-space-2);
    }
    .tagline {
      font-size: 17px;
      letter-spacing: 0.01em;
    }
  `

  /** Where the app is; unset while the vault has no template (or none is open). */
  @state() private place?: Place
  @state() private tab: Tab = 'documents'
  /** The vault's templates, as the sidebar lists them. */
  @state() private templates: TemplateItem[] = []
  /** The ids of the templates other templates' fields refer to: the sidebar groups them apart. */
  @state() private referenceIds = new Set<string>()
  /** Whether some documents name no template the vault has. */
  @state() private hasOrphans = false
  /**
   * Whether the sidebar is open as a drawer. The shell shows the sidebar beside the content at desktop
   * width whatever this says, and below it as a drawer over the content only while this is set — so it
   * starts closed, and closes when the shell asks (its backdrop) or a place is picked from it.
   */
  @state() private sidebarOpen = false
  /** Whether a wide window shows the sidebar folded to its rail (a drawer always shows it whole). */
  @state() private sidebarCollapsed = false
  /** The shortcuts are showing (Ctrl+/, or 단축키 at the foot of the sidebar). */
  @state() private showingShortcuts = false
  /** What Lowline is and under which terms, from 정보 at the foot of the sidebar. */
  @state() private showingAbout = false
  /** 정보 opened from the first launch's line about what leaves the computer, with that part unfolded. */
  @state() private aboutOutbound = false
  private readonly wideQuery = matchMedia(`(min-width: ${desktopMinWidth}px)`)
  @state() private wide = this.wideQuery.matches
  private readonly onWidth = () => (this.wide = this.wideQuery.matches)
  @state() private vaultInfo?: VaultInfo
  @state() private error = ''
  /** What the app just did that left the place it showed (a template deleted); gone once elsewhere. */
  @state() private notice = ''
  /** This device's settings, once read. */
  @state() private settings?: Settings
  /** Where updating stands; a newer release is installed only when the person says so. */
  @state() private updateView?: UpdateView
  /** The release the person put off in this run of the app: not told of again until a newer one. */
  @state() private putOff?: string
  @state() private installing = false
  private unlistenUpdates?: Promise<() => void>
  /** Where the app was when it was last used, to be shown once the vault it reopened is read. */
  private resumeAt?: { place: Place; tab: Tab }
  /** What the documents view is to show, asked for from elsewhere: a table row's document, a new one naming another. */
  @state() private opening?: Opening
  /** The unsaved-edits question is showing; the answer settles the promise it was asked with. */
  @state() private asking = false
  private answer?: (discard: boolean) => void
  @queryAll('ll-mark') private marks!: NodeListOf<LlMark>
  private unlisten?: Promise<UnlistenFn>
  private unlistenRefused?: Promise<UnlistenFn>
  /** A template the app writes (makes, saves) may change the list. */
  private readonly onTemplateWritten = (path: string | null) => {
    if (path !== null && this.vaultInfo && path.startsWith(this.vaultInfo.templatesDir + '/')) void this.refreshPlaces()
  }

  /**
   * The app's shortcuts, heard on the window so the web view's own (save page, new window, find in
   * page) never run, and the same from any field or with focus on the page itself:
   * - Ctrl+S (⌘S) saves whatever is being edited — a template or a document.
   * - Ctrl+N starts a new document of the template shown, on its documents tab.
   * - Ctrl+F goes to the box that finds the template's documents.
   * - Ctrl+Enter saves the open document and opens the next one with a judgment field still empty.
   * - Ctrl+/ shows the shortcuts, and hides them again.
   * While a dialog is open they do nothing: the question on screen is answered first.
   */
  private readonly onShortcut = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
    const key = e.key.toLowerCase()
    if (key !== 's' && key !== 'n' && key !== 'f' && key !== '/' && key !== 'enter') return
    e.preventDefault()
    if (key === '/' && this.showingShortcuts) return void (this.showingShortcuts = false)
    if (modalOpen(document) || this.showingShortcuts) return
    if (key === '/') return void (this.showingShortcuts = true)
    if (key === 's') {
      const editor = this.renderRoot.querySelector<HTMLElement & { save(): Promise<void> }>('ll-templates, ll-documents')
      void editor?.save()
    } else if (key === 'enter') void this.renderRoot.querySelector<LlDocuments>('ll-documents')?.saveAndNext()
    else void this.toDocuments((documents) => (key === 'n' ? documents.newDocument() : documents.focusFinder()))
  }

  /** Shows the documents tab of the template shown, then does `then` there; elsewhere does nothing. */
  private async toDocuments(then: (documents: LlDocuments) => void) {
    if (this.place?.kind !== 'template') return
    if (this.tab !== 'documents') {
      await this.switchTab('documents')
      if ((this.tab as Tab) !== 'documents') return // the edits were kept: the tab stayed
      await this.updateComplete
    }
    const documents = this.renderRoot.querySelector<LlDocuments>('ll-documents')
    if (!documents) return
    await documents.updateComplete
    then(documents)
  }

  connectedCallback() {
    super.connectedCallback()
    // Typing holds the caret solid; a pause lets it blink again.
    this.addEventListener('keydown', () => this.marks.forEach((m) => m.hold()))
    window.addEventListener('keydown', this.onShortcut)
    this.wideQuery.addEventListener('change', this.onWidth)
    this.addEventListener('pointerdown', () => this.marks.forEach((m) => m.wake()))
    // A save is a confirmation: the mark shows "not yet" becoming "confirmed".
    this.addEventListener('ll-confirmed', () => this.marks.forEach((m) => m.confirm()))
    setDiscardQuestion(
      () =>
        new Promise<boolean>((resolve) => {
          this.answer = resolve
          this.asking = true
        }),
    )
    // Closing the window with unsaved edits asks first, like everywhere else in the app.
    const win = getCurrentWindow()
    void win.onCloseRequested(async (e) => {
      if (!hasUnsaved()) return
      e.preventDefault()
      if (await confirmDiscard()) await win.destroy()
    })
    void this.resume()
    void this.loadSettings()
    this.unlistenUpdates = update.onChange(() => void update.status().then((v) => (this.updateView = v ?? undefined), () => {}))
    this.addEventListener('ll-open-document', (e) => {
      const { path, template } = (e as CustomEvent<{ path: string; template: string }>).detail
      this.openIn(template, { path })
    })
    // A new document of another template, started with values — one naming the document a person was on.
    this.addEventListener('ll-new-document', (e) => {
      const { template, values } = (e as CustomEvent<{ template: string; values: FieldValues }>).detail
      this.openIn(template, { values })
    })
    // The template showing was deleted: its place is gone, and the app shows the next one.
    this.addEventListener('ll-template-deleted', async (e) => {
      const { permanently } = (e as CustomEvent<{ permanently: boolean }>).detail
      this.opening = undefined
      this.place = undefined
      await this.refreshPlaces()
      this.notice = strings.templateDeleted(permanently, this.hasOrphans)
    })
    onWritten.add(this.onTemplateWritten)
    this.unlisten = onVaultChanged(() => void this.refreshPlaces())
    // A link the person clicks opens outside the window, in the system's browser or mail app.
    window.addEventListener('click', this.onLinkClick)
    // The window itself never leaves the app (the shell refuses it) — a link opened another way than by
    // a click, a new window: the person is told so, with the address, rather than left with nothing.
    this.unlistenRefused = onNavigationRefused((address) => (this.notice = strings.linkNotFollowed(address)))
  }

  /**
   * A click on a link to anywhere but the app's own pages — in a template's instructions, a document's body —
   * opens it outside the window when it is to the web or to mail, and says which. The window stays where it was,
   * with whatever was typed.
   */
  private readonly onLinkClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return
    const link = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && n.hasAttribute('href'))
    if (!link) return
    let to: URL
    try {
      to = new URL(link.href)
    } catch {
      return
    }
    if (to.origin === location.origin) return
    e.preventDefault()
    const address = to.href
    openLink(address).then(
      (opened) => (this.notice = opened ? strings.linkOpened(address) : strings.linkNotWeb(address)),
      () => (this.notice = strings.linkNotOpened(address)),
    )
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this.onShortcut)
    window.removeEventListener('click', this.onLinkClick)
    this.wideQuery.removeEventListener('change', this.onWidth)
    onWritten.delete(this.onTemplateWritten)
    void this.unlisten?.then((stop) => stop())
    void this.unlistenRefused?.then((stop) => stop())
    void this.unlistenUpdates?.then((stop) => stop())
  }

  private async loadSettings() {
    this.applySettings(await deviceSettings.read().catch(() => ({ ...DEFAULT_SETTINGS })))
  }

  /** Takes settings into effect: looking for updates starts or stops with its setting. */
  private applySettings(next: Settings) {
    this.settings = next
    void update.watch(next.checkForUpdates).then(
      (view) => (this.updateView = next.checkForUpdates ? (view ?? undefined) : undefined),
      () => {},
    )
  }

  private changeSettings(next: Settings) {
    this.applySettings(next)
    void deviceSettings.write(next).catch((e) => (this.error = describeError(e)))
  }

  /** The first launch's line about what leaves the computer is told once: answered, it is not shown again. */
  private toldOutbound(more: boolean) {
    if (this.settings) this.changeSettings({ ...this.settings, outboundToldOnce: true })
    if (more) {
      this.aboutOutbound = true
      this.showingAbout = true
    }
  }

  /** The newer release, downloaded or on its way — or failed to download, with where to get it by hand. */
  private renderUpdate() {
    const tell = toTell(this.updateView, this.putOff)
    if (!tell?.available) return nothing
    const version = tell.available
    return html`<p class="notice-bar update" role="status">
      ${tell.failed ? strings.updateDownloadFailed(version) : strings.updateAvailable(version, tell.ready)}
      ${tell.failed ? html`<a href=${RELEASES_PAGE}>${strings.updateReleasePage}</a>` : nothing}
      <dc-button size="sm" ?disabled=${this.installing} @click=${() => void this.installUpdate()}
        >${this.installing ? strings.updateInstalling : strings.updateInstall}</dc-button
      >
      <dc-button size="sm" variant="secondary" ?disabled=${this.installing} @click=${() => (this.putOff = version)}>${strings.updateLater}</dc-button>
    </p>`
  }

  /** Installs the newer release — after the unsaved-edits question, since the app restarts. */
  private async installUpdate() {
    if (!(await confirmDiscard())) return
    this.installing = true
    try {
      await update.install()
    } catch {
      this.installing = false
      this.error = strings.updateFailed
    }
  }

  /**
   * Opens the vault the app was last using, at the place it showed — unless a vault is open by then, or
   * that one can no longer be opened (then the first screen, as for a first launch).
   */
  private async resume() {
    const resumed = await resumeVault().catch(() => null)
    if (!resumed || this.vaultInfo) return
    const session = resumed.session as { place?: unknown; tab?: unknown } | undefined
    const place = typeof session?.place === 'string' ? placeOf(session.place) : undefined
    const tab = session?.tab
    if (place) this.resumeAt = { place, tab: tab === 'template' || tab === 'table' ? tab : 'documents' }
    this.vaultInfo = resumed.vault
  }

  updated(changed: Map<string, unknown>) {
    // Where the app is, for the next launch: kept on this device (the shell's app settings), not in the vault.
    if ((changed.has('vaultInfo') || changed.has('place') || changed.has('tab')) && this.vaultInfo && this.place) {
      const session = { vault: this.vaultInfo.root, place: placeId(this.place), tab: this.tab }
      void vault.writeSession(JSON.stringify(session)).catch(() => {})
    }
  }

  willUpdate(changed: Map<string, unknown>) {
    // Another vault: its own templates, starting from the first.
    if (changed.has('vaultInfo')) {
      this.place = undefined
      this.templates = []
      this.hasOrphans = false
      void this.refreshPlaces()
    }
  }

  /** Reads which templates the vault has now; a place that is gone gives way to the first template. */
  private async refreshPlaces() {
    if (!this.vaultInfo) return
    try {
      const read = await readVault()
      const templateOf = new Map(read.documents.map((d) => [d.path, d.template]))
      const place = this.place
      const shown = place?.kind === 'template' ? this.templates.find((t) => t.ref === place.ref) : undefined
      const after = templatesAfterRead(read.templateItems, shown)
      this.templates = after.templates
      this.referenceIds = referenceTargets(read.templates)
      this.hasOrphans = documentsOf(read.documentEntries, templateOf, null, new Set(read.names.keys())).length > 0
      // The template showing may be the same file under a reference edited in it: the place follows the file.
      const now: Place | undefined = after.shown && place?.kind === 'template' ? { kind: 'template', ref: after.shown.ref } : place
      const stays =
        now?.kind === 'learning' ||
        (now?.kind === 'orphans' && this.hasOrphans) ||
        (now?.kind === 'template' && this.templates.some((t) => t.ref === now.ref))
      const resume = this.resumeAt
      this.resumeAt = undefined
      const there = (p: Place) =>
        p.kind === 'learning' || (p.kind === 'orphans' && this.hasOrphans) || (p.kind === 'template' && this.templates.some((t) => t.ref === p.ref))
      if (!stays && resume && there(resume.place)) {
        this.place = resume.place
        this.tab = resume.tab
      } else if (!stays) {
        // First the template with documents — where the work is — else the first one.
        const worked = this.templates.find((t) => read.documents.some((d) => d.template === t.ref)) ?? this.templates[0]
        this.place = worked ? { kind: 'template', ref: worked.ref } : undefined
      }
      else if (now?.kind === 'template' && place?.kind === 'template' && now.ref !== place.ref) this.place = now
    } catch (e) {
      this.error = describeError(e)
    }
  }

  private settle(discard: boolean) {
    this.asking = false
    this.answer?.(discard)
    this.answer = undefined
  }

  /** Shows a template's documents with one opened, or a new one started, there; unsaved edits were let go first. */
  private openIn(template: string, opening: Opening) {
    this.opening = opening
    this.place = { kind: 'template', ref: template }
    this.tab = 'documents'
  }

  /** Goes to a place once unsaved edits are let go; otherwise the sidebar shows the place kept. */
  private async go(place: Place) {
    if (this.place && placeId(place) === placeId(this.place)) return
    if (!(await confirmDiscard())) return this.requestUpdate()
    this.opening = undefined
    this.notice = ''
    this.place = place
    void this.refreshPlaces() // a template kept while it showed, gone outside, leaves the list
  }

  private async switchTab(tab: Tab) {
    if (tab === this.tab) return
    if (!(await confirmDiscard())) return this.requestUpdate()
    this.opening = undefined
    this.notice = ''
    this.tab = tab
  }

  private onSidebarSelect(e: DpSidebarSelectEvent) {
    if (e.itemId === NEW_TEMPLATE) {
      e.preventDefault() // an action, not a place: the selection stays where it is
      void this.createTemplate()
      return
    }
    const place = placeOf(e.itemId)
    if (place) void this.go(place)
  }

  /** Makes a template from the starter and opens its source. */
  private async createTemplate() {
    const info = this.vaultInfo
    if (!info || !(await confirmDiscard())) return
    try {
      const path = await createTemplateFile(info.templatesDir)
      await this.refreshPlaces()
      const made = this.templates.find((t) => t.path === path)
      if (made) {
        this.opening = undefined
        this.place = { kind: 'template', ref: made.ref }
        this.tab = 'template'
      }
    } catch (e) {
      this.error = describeError(e)
    }
  }

  private async openVault() {
    if (!(await confirmDiscard())) return
    const path = await open({ directory: true, title: strings.openVaultTitle })
    if (typeof path !== 'string') return
    try {
      this.vaultInfo = await openVault(path)
      this.error = ''
    } catch (e) {
      this.error = describeError(e)
    }
  }

  private async newVault() {
    if (!(await confirmDiscard())) return
    const path = await open({ directory: true, title: strings.newVaultTitle })
    if (typeof path === 'string') await this.makeVault(path)
  }

  /**
   * Makes a vault in the empty folder at `path`: opens it and puts the sample template in it, then
   * shows the sample's documents, ready for a first one. A folder that holds anything is refused.
   */
  async makeVault(path: string) {
    try {
      if (!(await invoke<boolean>('folder_is_empty', { path }))) {
        this.error = strings.newVaultNotEmpty
        return
      }
      const info = await openVault(path)
      const sample = await createSampleTemplate(info.templatesDir)
      this.vaultInfo = info
      this.error = ''
      await this.updateComplete // the new vault's places are read
      await this.refreshPlaces()
      const made = this.templates.find((t) => t.path === sample)
      if (made) {
        this.place = { kind: 'template', ref: made.ref }
        this.tab = 'documents'
      }
    } catch (e) {
      this.error = describeError(e)
    }
  }

  /**
   * The sidebar toggle: a wide window folds the sidebar to its rail and back; a narrow one opens it
   * as a drawer over the content.
   */
  private readonly toggleSidebar = () => {
    if (this.wide) this.sidebarCollapsed = !this.sidebarCollapsed
    else this.sidebarOpen = !this.sidebarOpen
  }

  /**
   * Whether the place shows a list of documents beside the one open — the three columns: sidebar, the
   * list, what is picked in it. The list and the document then scroll on their own, not the page.
   */
  private showsDocuments(): boolean {
    const place = this.place
    return !!this.vaultInfo && (place?.kind === 'orphans' || (place?.kind === 'template' && this.tab === 'documents'))
  }

  /** How wide the page may grow: a template's documents and its source are workspaces of columns, the rest is read. */
  private pageWidth(): 'full' | 'xl' | 'md' {
    if (this.showsDocuments()) return 'full'
    return this.place?.kind === 'template' && this.tab === 'template' ? 'xl' : 'md'
  }

  private heading(): string {
    const place = this.place
    if (place?.kind === 'learning') return strings.navLearning
    if (place?.kind === 'orphans') return strings.orphanDocuments
    if (place?.kind === 'template') return this.templates.find((t) => t.ref === place.ref)?.name ?? place.ref
    return ''
  }

  private renderPlace(info: VaultInfo) {
    const place = this.place
    if (!place)
      return html`<div class="welcome">
        <p>${strings.noTemplates}</p>
        <dc-button @click=${() => void this.createTemplate()}>${strings.makeTemplate}</dc-button>
      </div>`
    if (place.kind === 'learning') return html`<ll-learning .vaultInfo=${info}></ll-learning>`
    if (place.kind === 'orphans') return html`<ll-documents .vaultInfo=${info} .scope=${null}></ll-documents>`
    const template = this.templates.find((t) => t.ref === place.ref)
    if (!template) return nothing
    return html`<div class="place">
      <dc-tab-bar
        .items=${[
          { id: 'documents', label: strings.navDocuments },
          { id: 'table', label: strings.navTable },
          { id: 'template', label: strings.navTemplates },
        ]}
        .activeId=${live(this.tab)}
        @dc-tab-change=${(e: DcTabChangeEvent) => void this.switchTab(e.tabId as Tab)}
      ></dc-tab-bar>
      ${this.tab === 'table'
        ? html`<ll-table .vaultInfo=${info} .template=${template.ref}></ll-table>`
        : this.tab === 'template'
          ? html`<ll-templates .vaultInfo=${info} .path=${template.path} .model=${this.settings?.model ?? null}></ll-templates>`
          : html`<ll-documents
              .vaultInfo=${info}
              .scope=${template}
              .opening=${this.opening}
              .model=${this.settings?.model ?? null}
            ></ll-documents>`}
    </div>`
  }

  render() {
    const info = this.vaultInfo
    return html`
      <dp-shell
        ?sidebar-open=${this.sidebarOpen}
        @dp-shell-sidebar-close=${() => (this.sidebarOpen = false)}
        @ll-model=${(e: CustomEvent<ModelSettings | null>) => this.settings && this.changeSettings({ ...this.settings, model: e.detail })}
      >
        <dp-sidebar
          slot="sidebar"
          ?collapsed=${this.sidebarCollapsed && this.wide}
          header=${info?.name ?? strings.appName}
          nav-label=${strings.navLabel}
          .activeId=${live(this.place ? placeId(this.place) : '')}
          .items=${info
            ? sidebarEntries(this.templates, this.hasOrphans, {
                templates: strings.navTemplates,
                newTemplate: strings.makeTemplate,
                learning: strings.navLearning,
                orphans: strings.orphanDocuments,
                references: strings.navReferences,
              }, this.referenceIds)
            : []}
          .bottomItems=${[
            { id: SHORTCUTS, icon: '⌨', label: strings.shortcuts },
            { id: ABOUT, icon: 'ⓘ', label: strings.about },
          ]}
          @dp-sidebar-select=${(e: DpSidebarSelectEvent) => this.onSidebarSelect(e)}
          @dp-sidebar-activate=${(_: DpSidebarActivateEvent) => (this.sidebarOpen = false) /* a drawer gives way to any pick, the place already shown too */}
          @dp-sidebar-action=${(e: DpSidebarActionEvent) => {
            if (e.itemId !== SHORTCUTS && e.itemId !== ABOUT) return
            this.sidebarOpen = false
            if (e.itemId === SHORTCUTS) this.showingShortcuts = true
            else this.showingAbout = true
          }}
        >
          <ll-mark slot="icon" size="20" label=""></ll-mark>
        </dp-sidebar>
        <dp-toolbar
          slot="toolbar"
          heading=${info?.name ?? strings.appName}
          subtitle=${this.heading()}
          show-toggle
          toggle-label=${strings.toggleSidebar}
          .expanded=${this.wide ? !this.sidebarCollapsed : this.sidebarOpen}
          @dp-toolbar-toggle=${this.toggleSidebar}
        >
          <dc-button slot="actions" variant="secondary" size="sm" @click=${this.openVault}>${strings.openVault}</dc-button>
        </dp-toolbar>
        <dp-page ?fill=${this.showsDocuments()} max-width=${this.pageWidth()}>
          ${this.settings && !this.settings.outboundToldOnce
            ? html`<p class="notice-bar outbound-once" role="status">
                ${strings.outboundOnce}
                <dc-button size="sm" variant="secondary" @click=${() => this.toldOutbound(true)}>${strings.outboundOnceMore}</dc-button>
                <dc-button size="sm" @click=${() => this.toldOutbound(false)}>${strings.outboundOnceOk}</dc-button>
              </p>`
            : nothing}
          ${this.renderUpdate()}
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ''}
          ${this.notice ? html`<p class="notice" role="status">${this.notice}</p>` : ''}
          ${!info
            ? html`<div class="welcome">
                <ll-mark variant="wordmark" size="96" intro></ll-mark>
                <p class="tagline">${strings.tagline}</p>
                <p>${strings.noVault}</p>
                <div class="choices">
                  <dc-button @click=${this.newVault}>${strings.newVault}</dc-button>
                  <dc-button variant="secondary" @click=${this.openVault}>${strings.openFolder}</dc-button>
                </div>
              </div>`
            : this.renderPlace(info)}
        </dp-page>
      </dp-shell>
      <dp-shortcut-overlay
        heading=${strings.shortcuts}
        close-label=${strings.shortcutsClose}
        .shortcuts=${strings.shortcutList}
        ?open=${this.showingShortcuts}
        @dp-shortcut-overlay-dismiss=${() => (this.showingShortcuts = false)}
      ></dp-shortcut-overlay>
      <ll-about
        ?open=${this.showingAbout}
        ?outbound=${this.aboutOutbound}
        .settings=${this.settings}
        @close=${() => {
          this.showingAbout = false
          this.aboutOutbound = false
        }}
        @ll-settings=${(e: CustomEvent<Settings>) => this.changeSettings(e.detail)}
      ></ll-about>
      <dc-confirm-dialog
        heading=${strings.unsavedHeading}
        confirm-label=${strings.unsavedDiscard}
        cancel-label=${strings.unsavedKeep}
        danger
        .open=${this.asking}
        @confirm=${() => this.settle(true)}
        @cancel=${() => this.settle(false)}
        >${strings.unsavedBody}</dc-confirm-dialog
      >
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'll-app': LlApp
  }
}
