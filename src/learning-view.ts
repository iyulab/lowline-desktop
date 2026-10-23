import { LitElement, css, html, nothing, svg } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { describeError } from './errors.js'
import type { FieldCurve, TemplateSnapshot } from './projection.js'
import { strings } from './strings.js'
import { parsePresentations } from './events.js'
import { currentRefs, revisedRef } from './template-revision.js'
import { host, vault, type VaultChanged, type VaultInfo } from './vault-client.js'
import { SidecarUnavailable, syncVault, onVaultChanged } from './vault-snapshot.js'
import { numberedForms, weeklyCounts, type WeeklyCounts } from './weekly-counts.js'

/** The decisions each rate is taken over — the sidecar's window. */
const WINDOW = 10
/** How often the view asks again while a replay is still choosing. */
const FOLLOW_MS = 1000

/** Plot area, in viewBox units. */
const W = 600
const H = 120
const PAD = { top: 8, right: 44, bottom: 8, left: 36 }

/**
 * Whether suggestions get better with use: for each judgment field, the share of recent
 * suggestions people took as offered, decision by decision — the vault's event files, read again.
 */
@customElement('ll-learning')
export class LlLearning extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-5);
      font-size: 13px;
    }
    section {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-2);
    }
    h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    .figures {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--dc-space-2) var(--dc-space-4);
    }
    .headline {
      font-size: 20px;
      font-variant-numeric: tabular-nums;
    }
    .secondary {
      color: var(--dc-color-text-secondary);
      font-variant-numeric: tabular-nums;
    }
    p.replay {
      margin: 0;
    }
    /* A line of prose stays readable however wide the window: the replay and what it is counted on run long. */
    p.secondary {
      max-width: 72ch;
    }
    svg {
      width: 100%;
      height: auto;
      max-width: 720px;
      overflow: visible;
    }
    .grid {
      stroke: var(--dc-color-border);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .axis {
      fill: var(--dc-color-text-muted);
      font-size: 11px;
    }
    .line {
      fill: none;
      stroke: var(--ll-chart-line, #3c67a3);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
      vector-effect: non-scaling-stroke;
    }
    .end {
      fill: var(--ll-chart-line, #3c67a3);
      stroke: var(--dc-color-bg);
      stroke-width: 2;
    }
    .value {
      fill: var(--dc-color-text);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .hit {
      fill: transparent;
    }
    .hit:hover {
      fill: var(--ll-chart-line, #3c67a3);
      fill-opacity: 0.15;
    }
    details table {
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }
    details th,
    details td {
      text-align: right;
      padding: 2px var(--dc-space-3) 2px 0;
    }
    details.counts pre {
      max-height: 240px;
      overflow: auto;
      font-size: 12px;
      background: var(--dc-color-surface);
      border: 1px solid var(--dc-color-border);
      padding: var(--dc-space-2);
    }
    ul.legend {
      margin: 0;
      padding-left: 1.2em;
    }
    .message {
      color: var(--dc-color-text-muted);
      max-width: 60ch;
    }
    .error {
      color: var(--dc-color-danger);
    }
  `

  @property({ attribute: false }) vaultInfo!: VaultInfo

  @state() private curves: FieldCurve[] = []
  @state() private templates: TemplateSnapshot[] = []
  @state() private names = new Map<string, string>()
  @state() private waiting = true
  @state() private counts?: WeeklyCounts
  @state() private copied: 'no' | 'yes' | 'failed' = 'no'
  @state() private error = ''

  private unlisten?: Promise<UnlistenFn>
  private following?: ReturnType<typeof setTimeout>

  connectedCallback() {
    super.connectedCallback()
    void this.load()
    this.unlisten = onVaultChanged((change) => void this.load(change))
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    void this.unlisten?.then((stop) => stop())
    clearTimeout(this.following)
  }

  private async load(change?: VaultChanged) {
    try {
      const synced = await syncVault(change)
      // What this device showed is an aid to the counts: without it they are decisions alone.
      // Shown under an earlier revision, a suggestion counts for its template as it is now, as its events do.
      const current = currentRefs(synced.templates)
      const shown = parsePresentations(await vault.readPresentations().catch(() => '')).map((p) => ({ ...p, template: revisedRef(p.template, current) }))
      // The counts number the forms of these templates: both change together, or a render between would read one
      // against the other's numbering.
      this.templates = synced.templates
      this.names = synced.names
      this.counts = weeklyCounts(synced.templates, synced.documents, synced.events, shown)
      this.copied = 'no'
      this.curves = await host.curves()
      this.error = ''
      this.follow()
    } catch (e) {
      this.error = e instanceof SidecarUnavailable ? strings.hostFailed(e.message) : describeError(e)
    } finally {
      this.waiting = false
    }
  }

  /**
   * While a field's replay is still choosing its strength — for the first time, or again as its history grew — asks again
   * until it has: what it chose shows up here when it is done, without the view having to be opened again.
   */
  private follow() {
    clearTimeout(this.following)
    if (!this.isConnected || !this.curves.some((c) => c.whyNoReplay === 'pending' || c.rechoosing)) return
    this.following = setTimeout(async () => {
      try {
        this.curves = await host.curves()
      } catch (e) {
        this.error = describeError(e)
        return
      }
      this.follow()
    }, FOLLOW_MS)
  }

  /** The fields the field's suggestions rest on, when its replay chose a few of them rather than every value filled in. */
  private renderDependsOn(curve: FieldCurve) {
    const fields = curve.replay?.dependsOn
    if (!fields?.length) return nothing
    return html`<p class="secondary depends-on">${strings.learningDependsOn(fields.map((f) => this.fieldLabel(curve.template, f)))}</p>`
  }

  /** How typing did on replay, for a field whose value is typed out — suggested or not before typing. */
  private renderTyping(curve: FieldCurve) {
    if (!curve.typing) return nothing
    return html`<p class="secondary typing">${strings.learningTyping(curve.typing)}</p>`
  }

  /**
   * Why values settled alongside are not offered — and, when no strength was right often enough for them but similar records
   * are offered, that the field is suggested from those alone.
   */
  private noReplay(curve: FieldCurve) {
    return curve.whyNoReplay === 'below-target' && curve.similar?.offered ? strings.learningSimilarOnly : strings.learningNoReplay(curve.whyNoReplay, curve.closest)
  }

  /** How similar records did on replay where values settled alongside suggested nothing, and whether they are offered. */
  private renderSimilar(curve: FieldCurve) {
    if (!curve.similar) return nothing
    return html`<p class="secondary similar">${strings.learningSimilar(curve.similar)}</p>`
  }

  /** How the field's class did on replay where its value was not suggested, when its template names a class. */
  private renderClass(curve: FieldCurve) {
    if (!curve.coarse) return nothing
    return html`<p class="secondary class">${strings.learningClass(curve.coarse)}</p>`
  }

  private label(curve: FieldCurve): string {
    const template = this.templates.find((t) => t.ref === curve.template)
    return template?.fields.find((f) => f.name === curve.field)?.label ?? curve.field
  }

  render() {
    if (this.error) return html`<p class="error" role="alert">${this.error}</p>`
    if (this.waiting) return html`<p class="message" role="status">${strings.hostStarting}</p>`
    if (this.curves.length === 0) return html`<p class="message">${strings.learningEmpty}</p>`
    return html`${this.renderOutside()}${this.curves.map((c) => this.renderCurve(c))}${this.renderCounts()}`
  }

  /**
   * For each form, how many of the documents suggestions learn from were written by another program and never
   * saved here — values no one may have confirmed. Nothing is said for a form with none.
   */
  private renderOutside() {
    const forms = numberedForms(this.templates)
    return (this.counts?.forms ?? [])
      .filter((f) => f.outside > 0)
      .map((f) => {
        const ref = forms[f.form - 1].ref
        return html`<p class="message outside">${strings.learningOutside(this.names.get(ref) ?? ref, f.outside, f.confirmed)}</p>`
      })
  }

  /**
   * Weekly counts to hand over by hand: numbers only. Which number is which form is shown here, to the
   * person who can see the vault anyway, and is not part of what is copied.
   */
  private renderCounts() {
    const counts = this.counts
    if (!counts || counts.counts.length === 0) return nothing
    const text = JSON.stringify(counts, null, 2)
    const forms = numberedForms(this.templates)
    return html`<details class="counts">
      <summary>${strings.countsTitle}</summary>
      <p class="message">${strings.countsHelp}</p>
      <ul class="legend">
        ${forms.map(
          (t, i) => html`<li>${strings.countsForm(i + 1, this.names.get(t.ref) ?? t.ref, t.suggest.map((f) => this.fieldLabel(t.ref, f)))}</li>`,
        )}
      </ul>
      <pre>${text}</pre>
      <dc-button size="sm" variant="secondary" @click=${() => void this.copy(text)}>${strings.countsCopy}</dc-button>
      ${this.copied === 'no'
        ? nothing
        : html`<span class="secondary" role="status">${this.copied === 'yes' ? strings.countsCopied : strings.countsCopyFailed}</span>`}
    </details>`
  }

  private fieldLabel(template: string, field: string): string {
    return this.templates.find((t) => t.ref === template)?.fields.find((f) => f.name === field)?.label ?? field
  }

  private async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      this.copied = 'yes'
    } catch {
      this.copied = 'failed' // the text is on screen to select and copy by hand
    }
  }

  /** What the field's precision is counted on, and the checks that decide it. */
  private renderCounting(curve: FieldCurve) {
    const counting = curve.counting
    return counting ? html`<p class="secondary counting">${strings.learningCounting(counting)}</p>` : nothing
  }

  private renderCurve(curve: FieldCurve) {
    const label = this.label(curve)
    const points = curve.points
    // Nothing decided yet — imported or saved without a suggestion shown. The replay of what is saved is all
    // there is to say, and it is not a decision: it stands apart from the curve that decisions draw.
    if (points.length === 0)
      return html`<section>
        <h2>${strings.learningTitle(this.names.get(curve.template) ?? curve.template, label)}</h2>
        <p class="message">${strings.learningUndecided}</p>
        <p class="secondary replay">
          ${curve.replay
            ? strings.learningReplay(curve.replay)
            : this.noReplay(curve)}${curve.rechoosing ? ` ${strings.learningRechoosing}` : nothing}
        </p>
        ${this.renderCounting(curve)}
        ${this.renderDependsOn(curve)}${this.renderSimilar(curve)}${this.renderTyping(curve)}${this.renderClass(curve)}
      </section>`
    const last = points[points.length - 1]
    const recent = Math.min(points.length, WINDOW)
    // The first full window, shown beside the latest once the two no longer overlap.
    const first = points.length >= 2 * WINDOW ? points[WINDOW - 1] : undefined
    return html`<section>
      <h2>${strings.learningTitle(this.names.get(curve.template) ?? curve.template, label)}</h2>
      <div class="figures">
        <span class="headline"
          >${recent < WINDOW ? strings.learningFew(Math.round(last.rate * recent), recent) : strings.learningRate(last.rate, recent)}</span
        >
        ${first ? html`<span class="secondary">${strings.learningFirst(first.rate, WINDOW)}</span>` : nothing}
        <span class="secondary">${strings.learningCounts(curve.accepted, curve.corrected, curve.rejected)}</span>
        ${(curve.bySource ?? []).map(
          (s) =>
            html`<span class="secondary by-source">${strings.learningBySource(s.source, s.decided, s.accepted)}</span>`,
        )}
      </div>
      <p class="secondary replay">
        ${curve.replay
          ? strings.learningReplay(curve.replay)
          : this.noReplay(curve)}${curve.rechoosing ? ` ${strings.learningRechoosing}` : nothing}
      </p>
      ${this.renderCounting(curve)}
      ${this.renderDependsOn(curve)}${this.renderSimilar(curve)}${this.renderTyping(curve)}${this.renderClass(curve)}
      ${this.renderChart(curve, label)}
      <details>
        <summary>${strings.learningTable}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">${strings.learningN}</th>
              <th scope="col">${strings.learningAt}</th>
              <th scope="col">${strings.learningShare}</th>
            </tr>
          </thead>
          <tbody>
            ${points.map(
              (p) => html`<tr>
                <td>${p.n}</td>
                <td>${new Date(p.at).toLocaleString()}</td>
                <td>${Math.round(p.rate * 100)}%</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </details>
    </section>`
  }

  /** One series: the share over decisions, 0–100%, with the latest value labelled at its end. */
  private renderChart(curve: FieldCurve, label: string) {
    const points = curve.points
    const span = Math.max(points.length - 1, 1)
    const x = (i: number) => PAD.left + ((W - PAD.left - PAD.right) * (points.length === 1 ? 0.5 : i / span))
    const y = (rate: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - rate)
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ')
    const last = points[points.length - 1]
    const step = (W - PAD.left - PAD.right) / Math.max(points.length, 1)
    return html`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label=${strings.learningChart(label)}>
      ${[0, 0.5, 1].map(
        (r) => svg`<line class="grid" x1=${PAD.left} x2=${W - PAD.right} y1=${y(r)} y2=${y(r)}></line>
          <text class="axis" x=${PAD.left - 6} y=${y(r) + 4} text-anchor="end">${r * 100}%</text>`,
      )}
      ${points.length > 1 ? svg`<path class="line" d=${path}></path>` : nothing}
      <circle class="end" cx=${x(points.length - 1)} cy=${y(last.rate)} r="4.5"></circle>
      <text class="value" x=${x(points.length - 1) + 10} y=${y(last.rate) + 4}>${Math.round(last.rate * 100)}%</text>
      ${points.map(
        (p, i) => svg`<rect class="hit" x=${x(i) - step / 2} y=${PAD.top} width=${step} height=${H - PAD.top - PAD.bottom}>
          <title>${strings.learningPoint(p.n, p.rate)}</title>
        </rect>`,
      )}
    </svg>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'll-learning': LlLearning
  }
}
