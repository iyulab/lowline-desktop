import { LitElement, css, html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { strings } from './strings.js'
import { model as models, type LocalModels, type ModelFailure, type ModelProbeResult } from './vault-client.js'
import type { ModelSettings } from './settings.js'

/** A kind of model endpoint the person can pick: an IronProw preset, and what it asks for. */
export interface ModelPreset {
  id: string
  label: string
  /** Whether it asks for an address — with `optional`, the preset's own is used when none is given. */
  address: 'none' | 'optional' | 'required'
  /** Whether it asks for a key. */
  key: 'none' | 'optional' | 'required'
  /** Who receives what is sent to the chat, when that is a company outside the person's own computers. */
  outside: string | null
}

/** The preset of a model Lowline gets and runs on this computer itself (LMSupply), rather than an endpoint. */
export const LOCAL_PRESET = 'local'

/** What the chat can run on: this computer first, then servers on the person's own computers, then companies' services. */
export const MODEL_PRESETS: readonly ModelPreset[] = [
  { id: LOCAL_PRESET, label: strings.modelPresetLocal, address: 'none', key: 'none', outside: null },
  { id: 'ollama', label: strings.modelPresetOllama, address: 'optional', key: 'none', outside: null },
  { id: 'gpustack', label: strings.modelPresetGpustack, address: 'required', key: 'optional', outside: null },
  { id: 'custom', label: strings.modelPresetCustom, address: 'required', key: 'optional', outside: null },
  { id: 'openai', label: 'OpenAI', address: 'none', key: 'required', outside: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic', address: 'none', key: 'required', outside: 'Anthropic' },
  { id: 'gemini', label: 'Google Gemini', address: 'none', key: 'required', outside: 'Google' },
  { id: 'grok', label: 'xAI Grok', address: 'none', key: 'required', outside: 'xAI' },
]

export const presetOf = (id: string) => MODEL_PRESETS.find((p) => p.id === id)

/** Why an endpoint did not answer, in the app's words — never the endpoint's own. */
export function failureText(failure: ModelFailure | null, statusCode: number | null): string {
  switch (failure) {
    case 'invalid':
      return strings.modelFailureInvalid
    case 'unauthorized':
      return strings.modelFailureUnauthorized
    case 'http-status':
      return strings.modelFailureHttpStatus(statusCode)
    case 'timeout':
      return strings.modelFailureTimeout
    case 'refused':
      return strings.modelFailureRefused
    case 'host-not-found':
      return strings.modelFailureHostNotFound
    case 'unreachable':
      return strings.modelFailureUnreachable
    case 'not-downloaded':
      return strings.modelFailureNotDownloaded
    case 'not-started':
      return strings.modelFailureNotStarted
    default:
      return strings.modelFailureTransport
  }
}

/** Bytes as gigabytes, to a tenth. */
export const gigabytes = (bytes: number) => (bytes / 1e9).toFixed(1)

/**
 * The tier a model Lowline runs on this computer is offered as, under the name it has had and the one LMSupply gives
 * it from its next release on (`qwen3-default` → `basic`): the tier stays when the model behind it changes, and the
 * picker already says which model that is. An id of no known tier is shown without LMSupply's prefix.
 */
const LOCAL_TIERS: Readonly<Record<string, string>> = {
  'gguf:qwen3-default': strings.modelLocalTierBasic,
  'gguf:basic': strings.modelLocalTierBasic,
  'gguf:qwen3-balanced': strings.modelLocalTierBalanced,
  'gguf:balanced': strings.modelLocalTierBalanced,
}

/** How a model on this computer is named outside its picker: by its tier. */
export const localModelLabel = (id: string) => LOCAL_TIERS[id] ?? id.replace(/^gguf:/, '')

/** How a model set up is named in the chat: by where it runs, and which. */
export function modelLabel(setting: ModelSettings): string {
  if (setting.preset === LOCAL_PRESET) return `${strings.modelLocalShort} · ${localModelLabel(setting.model)}`
  return `${presetOf(setting.preset)?.label ?? setting.preset} · ${setting.model}`
}

/** What getting a model ready on this computer is doing now, in the app's words; empty when nothing is. */
export function localProgressText(progress: LocalModels['progress']): string {
  switch (progress.phase) {
    case 'getting':
      return progress.getting && progress.total
        ? strings.modelLocalGetting(progress.getting, gigabytes(progress.received ?? 0), gigabytes(progress.total))
        : strings.modelLocalGettingSize(progress.getting ?? 'model')
    case 'starting':
      return strings.modelLocalStarting
    case 'ready':
      return strings.modelLocalReady
    default:
      return ''
  }
}

/** Where what is sent to the chat goes, for the preset and address chosen. */
export function destinationText(preset: ModelPreset): string {
  if (preset.id === LOCAL_PRESET) return strings.modelStaysHere
  return preset.outside ? strings.modelGoesOutside(preset.outside) : strings.modelStaysAtAddress
}

/**
 * Sets up the model the chat uses: the kind of endpoint, its address, its key — kept by the shell in the system's
 * credential store, never here — a check that it answers, and the model chosen from those it lists. Saving tells
 * `ll-model` with the setting, and stopping using one tells it with null; the app keeps it.
 */
@customElement('ll-model-settings')
export class LlModelSettings extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-2);
      font-size: var(--dc-font-size-md);
    }
    h3 {
      margin: 0;
      font-size: var(--dc-font-size-md);
    }
    p {
      margin: 0;
      font-size: var(--dc-font-size-sm);
    }
    label {
      display: flex;
      flex-direction: column;
      gap: var(--dc-space-1);
      font-size: var(--dc-font-size-sm);
      color: var(--dc-color-text-secondary);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--dc-space-2);
    }
    .row > span {
      font-size: var(--dc-font-size-sm);
    }
    .muted {
      color: var(--dc-color-text-muted);
    }
    .error {
      color: var(--dc-color-danger-text);
    }
    .ok {
      color: var(--dc-color-success-text);
    }
  `

  /** The setting in use, if any: the form starts from it. */
  @property({ attribute: false }) current: ModelSettings | null = null

  @state() private preset = MODEL_PRESETS[0].id
  @state() private address = ''
  @state() private key = ''
  @state() private keyKept = false
  @state() private checking = false
  @state() private result: ModelProbeResult | undefined
  @state() private chosen = ''
  @state() private error = ''
  /** The models Lowline can run on this computer, and where getting one ready stands — for the local preset. */
  @state() private local: LocalModels | undefined
  private following: ReturnType<typeof setTimeout> | undefined

  connectedCallback() {
    super.connectedCallback()
    if (this.current) {
      this.preset = this.current.preset
      this.address = this.current.baseUrl ?? ''
      this.chosen = this.current.model
    }
    void this.readKeyKept()
    if (this.preset === LOCAL_PRESET) void this.follow()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    clearTimeout(this.following)
  }

  private get kind(): ModelPreset {
    return presetOf(this.preset) ?? MODEL_PRESETS[0]
  }

  private async readKeyKept() {
    this.keyKept = this.kind.key === 'none' ? false : await models.keyKept(this.preset).catch(() => false)
  }

  private pick(id: string) {
    this.preset = id
    this.address = ''
    this.key = ''
    this.result = undefined
    this.chosen = ''
    this.error = ''
    void this.readKeyKept()
    if (id === LOCAL_PRESET) void this.follow()
  }

  /** Reads the models on this computer, again while one is being got ready. */
  private async follow() {
    clearTimeout(this.following)
    try {
      this.local = await models.local()
      this.error = ''
    } catch {
      this.error = strings.modelLocalListFailed
      return
    }
    if (!this.chosen || !this.local.models.some((m) => m.id === this.chosen))
      this.chosen = (this.local.models.find((m) => m.recommended) ?? this.local.models[0])?.id ?? ''
    if (this.isConnected && (this.local.progress.phase === 'getting' || this.local.progress.phase === 'starting'))
      this.following = setTimeout(() => void this.follow(), 500)
  }

  /** Gets the model chosen ready on this computer — fetching it when it is not here — and follows it. */
  private async prepare() {
    this.error = ''
    try {
      await models.prepareLocal(this.chosen)
    } catch {
      this.error = strings.modelCheckFailed
    }
    await this.follow()
  }

  /** Keeps a key typed in, then asks the endpoint for its models with the key kept. */
  private async check() {
    this.checking = true
    this.error = ''
    this.result = undefined
    try {
      if (this.key.trim()) {
        await models.keepKey(this.preset, this.key.trim())
        this.key = ''
        this.keyKept = true
      }
      const result = await models.probe(this.preset, this.address.trim() || undefined, this.preset)
      this.result = result
      if (result.ok && !result.modelIds.includes(this.chosen)) this.chosen = result.modelIds[0] ?? ''
    } catch {
      this.error = strings.modelCheckFailed
    } finally {
      this.checking = false
    }
  }

  private async forgetKey() {
    await models.forgetKey(this.preset).catch(() => {})
    this.keyKept = false
    this.result = undefined
  }

  /** Stops using a model: the chat asks for one again when next opened. The key stays until it is forgotten. */
  private stopUsing() {
    this.dispatchEvent(new CustomEvent<ModelSettings | null>('ll-model', { detail: null, bubbles: true, composed: true }))
  }

  private save() {
    const setting: ModelSettings = { preset: this.preset, baseUrl: this.address.trim() || null, model: this.chosen }
    this.dispatchEvent(new CustomEvent<ModelSettings>('ll-model', { detail: setting, bubbles: true, composed: true }))
  }

  /** The local preset's part: the models, getting the one chosen ready, and where that stands. */
  private renderLocal() {
    const local = this.local
    const progress = local?.progress
    const mine = progress?.model === this.chosen ? progress : undefined
    const busy = progress?.phase === 'getting' || progress?.phase === 'starting'
    const chosen = local?.models.find((m) => m.id === this.chosen)
    return html`
      <p class="muted">${strings.modelLocalFetch}</p>
      ${local
        ? html`<label>
              ${strings.modelLocalChoose}
              <dc-select
                aria-label=${strings.modelLocalChoose}
                .value=${this.chosen}
                ?disabled=${busy}
                .options=${local.models.map((m) => ({
                  value: m.id,
                  label: strings.modelLocalOption(m.name, gigabytes(m.sizeBytes), m.downloaded, m.recommended),
                }))}
                @change=${(e: Event) => (this.chosen = (e.target as HTMLInputElement).value)}
              ></dc-select>
            </label>
            <p>${destinationText(this.kind)}</p>
            <div class="row">
              ${mine?.phase === 'ready'
                ? nothing
                : html`<dc-button size="sm" ?disabled=${busy || !chosen} @click=${this.prepare}
                    >${strings.modelLocalPrepare(chosen?.downloaded ?? false)}</dc-button
                  >`}
              ${busy && progress
                ? html`<span class="muted" role="status">${localProgressText(progress)}</span>`
                : mine?.phase === 'ready'
                  ? html`<span class="ok" role="status">${strings.modelLocalReady}</span>`
                  : nothing}
              ${mine?.phase === 'failed' ? html`<span class="error" role="alert">${failureText(mine.failure, null)}</span>` : nothing}
              ${this.error ? html`<span class="error" role="alert">${this.error}</span>` : nothing}
            </div>`
        : this.error
          ? html`<span class="error" role="alert">${this.error}</span>`
          : nothing}
      <div class="row">
        <dc-button variant="primary" size="sm" ?disabled=${mine?.phase !== 'ready'} @click=${this.save}>${strings.modelSave}</dc-button>
        ${this.current ? html`<dc-button variant="ghost" size="sm" @click=${this.stopUsing}>${strings.modelStopUsing}</dc-button>` : nothing}
      </div>
    `
  }

  render() {
    const kind = this.kind
    return html`
      <h3>${strings.modelTitle}</h3>
      <p class="muted">${strings.modelHelp}</p>
      <label>
        ${strings.modelPreset}
        <dc-select
          aria-label=${strings.modelPreset}
          .value=${this.preset}
          .options=${MODEL_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          @change=${(e: Event) => this.pick((e.target as HTMLInputElement).value)}
        ></dc-select>
      </label>
      ${kind.id === LOCAL_PRESET ? this.renderLocal() : this.renderEndpoint(kind)}
    `
  }

  /** An endpoint's part: its address and key, a check that it answers, and the model chosen from those it lists. */
  private renderEndpoint(kind: ModelPreset) {
    const ok = this.result?.ok === true
    const ready = ok && this.chosen !== ''
    return html`
      ${kind.address === 'none'
        ? nothing
        : html`<label>
            ${kind.address === 'required' ? strings.modelAddress : strings.modelAddressOptional}
            <dc-input
              aria-label=${strings.modelAddress}
              placeholder=${kind.id === 'ollama' ? 'http://localhost:11434' : 'http://…/v1'}
              .value=${this.address}
              @input=${(e: Event) => ((this.address = (e.target as HTMLInputElement).value), (this.result = undefined))}
            ></dc-input>
          </label>`}
      ${kind.key === 'none'
        ? nothing
        : html`<label>
            ${kind.key === 'required' ? strings.modelKey : strings.modelKeyOptional}
            <dc-input
              type="password"
              aria-label=${strings.modelKey}
              placeholder=${this.keyKept ? strings.modelKeyKept : ''}
              .value=${this.key}
              @input=${(e: Event) => ((this.key = (e.target as HTMLInputElement).value), (this.result = undefined))}
            ></dc-input>
          </label>
          ${this.keyKept
            ? html`<div class="row">
                <span class="muted">${strings.modelKeyKeptNote}</span>
                <dc-button size="sm" variant="secondary" @click=${this.forgetKey}>${strings.modelKeyForget}</dc-button>
              </div>`
            : nothing}`}
      <p>${destinationText(kind)}</p>
      <div class="row">
        <dc-button size="sm" ?disabled=${this.checking} @click=${this.check}>${strings.modelCheck}</dc-button>
        ${this.checking ? html`<span class="muted" role="status">${strings.modelChecking}</span>` : nothing}
        ${this.error ? html`<span class="error" role="alert">${this.error}</span>` : nothing}
        ${this.result && !ok
          ? html`<span class="error" role="alert">${failureText(this.result.failure, this.result.statusCode)}</span>`
          : nothing}
        ${ok ? html`<span class="ok" role="status">${strings.modelAnswered(this.result!.modelIds.length)}</span>` : nothing}
      </div>
      ${ok && this.result!.modelIds.length > 0
        ? html`<label>
            ${strings.modelChoose}
            <dc-select
              aria-label=${strings.modelChoose}
              .value=${this.chosen}
              .options=${this.result!.modelIds.map((id) => ({ value: id, label: id }))}
              @change=${(e: Event) => (this.chosen = (e.target as HTMLInputElement).value)}
            ></dc-select>
          </label>`
        : nothing}
      <div class="row">
        <dc-button variant="primary" size="sm" ?disabled=${!ready} @click=${this.save}>${strings.modelSave}</dc-button>
        ${this.current ? html`<dc-button variant="ghost" size="sm" @click=${this.stopUsing}>${strings.modelStopUsing}</dc-button>` : nothing}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'll-model-settings': LlModelSettings
  }
}
