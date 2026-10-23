import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { FieldStates } from '@formdown/ui'
import { holdsValue, isEmpty, type FieldValues } from './documents.js'
import { charactersTyped, checkEvents, fillOrder, presentation, suggestionEvents, type Check, type Offer } from './events.js'
import type { Abstention, Suggestion, TemplateSnapshot } from './projection.js'
import { strings } from './strings.js'
import { host, vault } from './vault-client.js'
import { readVault, syncVault } from './vault-snapshot.js'

/** How long typing pauses before suggestions are asked for again. */
const SUGGEST_DELAY_MS = 300
/** The field types whose value a person types out, rather than picks, checks or enters as a number or date. */
const TYPED_TYPES = new Set(['text', 'textarea', 'email', 'tel', 'url', 'search'])

/** What the panel reads from the view that holds it: the open draft and its form's values. */
export interface JudgmentSource {
  /** The open draft's template reference, and its document id once it has one; undefined when nothing is open. */
  draft(): { templateRef?: string; id?: string } | undefined
  /** The form's current values, as it last reported them. */
  values(): FieldValues
  /** What a suggestion rests on, in words. */
  sourceOf(suggestion: Suggestion): string
  /** Whether the documents a judgment field could be compared with are at hand (an existing document in a template's list). */
  hasCases(): boolean
}

/**
 * The judgment fields of the open draft: what is suggested for them or why nothing is, what the person took,
 * rejected or is typing, and — once the document is saved — the events that record it. Suggestions are an aid:
 * without the sidecar the document is filled in by hand as before.
 */
export class JudgmentController implements ReactiveController {
  /** The open draft's template as the sidecar knows it; undefined when suggestions are unavailable. */
  template?: TemplateSnapshot
  /** Suggestions for the draft's empty judgment fields, by field name. */
  suggestions = new Map<string, Suggestion>()
  /** Judgment fields asked for a suggestion and given none, with why — or `unavailable` when asking failed. */
  abstained = new Map<string, Abstention | null | 'unavailable'>()
  /** The open draft's template has judgment fields, and the sidecar that suggests for them did not start. */
  unavailable = false
  /** Every suggestion shown since the draft was opened or last saved: what a save confirms or not. */
  offered = new Map<string, Offer>()
  /**
   * Classes taken since the draft was opened or last saved (`coarse`), by field: the field stays open for the rest of
   * the value — and for the suggestions typing it brings, which take its place in `offered` — so what the save says
   * about the class is kept apart.
   */
  private classes = new Map<string, Offer>()
  /**
   * Values another program wrote into the open document as suggestions (`lowline.proposed`) that the person has not
   * decided yet, with who wrote them: the field is shown empty with the value offered in it, and saving leaves the
   * value and its mark in the file as they were.
   */
  proposed = new Map<string, { value: string; by: string }>()
  /** The fields marked as proposed in the file as it was last read or saved. */
  private marked: string[] = []
  /**
   * Marked fields not offered in their field — a value of more than one item, a check, or none — with the value the
   * form was handed: the mark stays until the person changes that value.
   */
  private shownAsIs = new Map<string, FieldValues[string] | undefined>()
  /** Proposed values the person turned down: the save takes them out of the document, with their marks. */
  private cleared = new Set<string>()
  /** For each judgment field, how many settled documents of the template hold a value in it. */
  private learned = new Map<string, number>()
  /** The draft's filled fields in the order they were filled (see `fillOrder`). */
  private filled: string[] = []
  /**
   * Judgment fields the person is typing a value into — typed by hand since the draft was opened or last saved, not
   * taken from a suggestion. Such a field stays open: it is asked about with what has been typed so far.
   */
  private typing = new Set<string>()
  /**
   * Fields whose suggestion was rejected in this draft and not offered again. Once the draft is
   * saved the rejection is an event, and the sidecar keeps it out of the document after reopening.
   */
  private rejected = new Set<string>()
  /**
   * A number drawn once for each judgment field of the open draft, the first time it is asked about — before any answer
   * is seen. The sidecar holds a field's value back to check it when this falls below its rate.
   */
  private rolls = new Map<string, number>()
  /**
   * Fields drawn to check them: shown no value, asked about no more while the draft is open. What the person enters is
   * recorded as a check when the document is saved — the field's precision counts it as entered with nothing in view.
   */
  checks = new Map<string, Check>()
  /**
   * Draws a field's roll, uniformly from [0, 1). End-to-end scenarios fix it through the page's `lowlineRoll`, so whether
   * a suggestion is held back is theirs to say.
   */
  private roll(): number {
    const fixed = (globalThis as { lowlineRoll?: () => number }).lowlineRoll
    return fixed ? fixed() : Math.random()
  }
  private suggestTimer?: ReturnType<typeof setTimeout>
  /** Counts requests for suggestions; only the latest one's answers are shown. */
  private suggestRun = 0

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly source: JudgmentSource,
  ) {
    host.addController(this)
  }

  hostDisconnected() {
    clearTimeout(this.suggestTimer)
  }

  /** Forgets the draft that was open: another one opens, or none. */
  reset() {
    clearTimeout(this.suggestTimer)
    this.template = undefined
    this.suggestions = new Map()
    this.abstained = new Map()
    this.unavailable = false
    this.offered = new Map()
    this.classes = new Map()
    this.filled = []
    this.typing = new Set()
    this.rejected = new Set()
    this.rolls = new Map()
    this.checks = new Map()
    this.proposed = new Map()
    this.marked = []
    this.shownAsIs = new Map()
    this.cleared = new Set()
    this.host.requestUpdate()
  }

  /**
   * A document of template `templateRef` is opened with `values`, `proposed` naming those another program wrote as
   * suggestions: returns the values the form is handed — each proposed one held back, to be offered in its field
   * instead. Only a single value of text is offered so; any other marked value is shown as it is.
   */
  opened(templateRef: string | undefined, values: FieldValues, proposed: Readonly<Record<string, string>> | undefined): FieldValues {
    const shown = { ...values }
    const offers = new Map<string, { value: string; by: string }>()
    for (const [field, by] of Object.entries(proposed ?? {})) {
      const value = values[field]
      if (typeof value !== 'string' || !value.trim()) continue
      offers.set(field, { value, by })
      delete shown[field]
    }
    this.proposed = offers
    this.marked = Object.keys(proposed ?? {})
    this.shownAsIs = new Map(this.marked.filter((f) => !offers.has(f)).map((f) => [f, values[f]]))
    for (const [field, { value, by }] of offers) {
      const offer: Offer = { suggestion: { value, mode: 'proposed', source: by }, shown: new Date(), filled: [], typed: 0 }
      this.offered.set(field, offer)
      if (templateRef) void vault.recordPresentation(presentation(templateRef, field, offer)).catch(() => {})
    }
    this.host.requestUpdate()
    return shown
  }

  /**
   * What saving the form's `values` writes: each value still only proposed left as the file holds it, each one turned
   * down taken out — and `settled`, the fields whose marks come off, as a person has decided them.
   */
  forSave(values: FieldValues): { values: FieldValues; settled: string[] } {
    const written: FieldValues = {}
    for (const [field, value] of Object.entries(values)) if (!this.proposed.has(field)) written[field] = value
    for (const field of this.cleared) written[field] = ''
    return { values: written, settled: this.marked.filter((f) => this.decidedMark(f, values)) }
  }

  /**
   * Whether the person has decided marked field `field`: its offered value taken, changed or turned down — or, for one
   * shown as it is, its value changed. Saving untouched leaves every mark where it was.
   */
  private decidedMark(field: string, values: FieldValues): boolean {
    if (this.proposed.has(field)) return false
    if (!this.shownAsIs.has(field)) return true
    return !sameValue(values[field], this.shownAsIs.get(field))
  }

  /**
   * Hands the sidecar the vault as it is now — its saved documents are what suggestions learn
   * from — finds the draft's template, and asks for its judgment fields.
   */
  async prepare(templateRef: string | undefined) {
    if (!templateRef) return
    try {
      const synced = await syncVault()
      const template = synced.templates.find((t) => t.ref === templateRef)
      if (this.source.draft()?.templateRef !== templateRef) return // another draft opened meanwhile
      this.template = template?.suggest.length ? template : undefined
      // A value another program proposed is not learned from: it is not counted as settled.
      const settled = synced.documents.filter((d) => d.template === templateRef && !d.conflicted)
      this.learned = new Map(template?.suggest.map((f) => [f, settled.filter((d) => holdsValue(d.values[f]) && !d.proposed?.includes(f)).length]))
      this.unavailable = false
      this.host.requestUpdate()
      await this.suggest()
    } catch {
      this.template = undefined
      // Saying nothing would read as "no suggestion to make": say they failed, if the template has fields to suggest for.
      try {
        const read = await readVault()
        if (this.source.draft()?.templateRef !== templateRef) return
        this.unavailable = !!read.templates.find((t) => t.ref === templateRef)?.suggest.length
      } catch {
        // the vault itself could not be read: nothing more to say about suggestions
      }
      this.host.requestUpdate()
    }
  }

  /** The form's values changed: notes the order fields were filled in. */
  track(values: FieldValues) {
    this.filled = fillOrder(this.filled, values)
  }

  /**
   * The person changed the form, from `before` to `values`: a judgment field typed into is being typed (asked
   * about with what it holds), one emptied or picked is not; suggestions are asked for again once typing pauses.
   */
  edited(before: FieldValues, values: FieldValues) {
    // A value of the person's own in a field offered a proposed one decides it.
    for (const field of [...this.proposed.keys()]) {
      if (values[field] !== before[field] && !isEmpty(values[field])) this.settle(field)
    }
    for (const field of this.template?.suggest ?? []) {
      if (values[field] === before[field]) continue
      if (isEmpty(values[field]) || !this.typeable(field)) this.typing.delete(field)
      else this.typing.add(field)
    }
    this.track(values)
    clearTimeout(this.suggestTimer)
    if (this.template) this.suggestTimer = setTimeout(() => void this.suggest(), SUGGEST_DELAY_MS)
  }

  /**
   * The suggested value for `field` is taken: it is a value like any other until the document is saved. A class taken
   * is the start of the value, not all of it: the field stays open, asked about with it as typed, and this answers true.
   */
  take(field: string): boolean {
    this.decided(field)
    const taken = this.suggestions.get(field)
    this.settle(field)
    this.dismiss(field)
    if (taken?.mode !== 'coarse') {
      this.typing.delete(field)
      return false
    }
    const offer = this.offered.get(field)
    if (offer) this.classes.set(field, offer)
    this.offered.delete(field)
    this.typing.add(field)
    clearTimeout(this.suggestTimer)
    this.suggestTimer = setTimeout(() => void this.suggest(), 0)
    return true
  }

  /** The suggestion for `field` is set aside. The rejection is recorded if the field is still empty when saved. */
  reject(field: string) {
    this.decided(field)
    this.rejected.add(field)
    if (this.proposed.has(field)) this.cleared.add(field)
    this.settle(field)
    this.dismiss(field)
  }

  /** Records what saving document `id` confirmed about the suggestions offered; what was typed is no longer being typed. */
  async saved(id: string | undefined) {
    if (id !== undefined) {
      const values = this.source.values()
      const at = new Date()
      const events = suggestionEvents(this.offered, this.rejected, values, id, at, this.template?.ref)
      const classes = suggestionEvents(this.classes, new Set(), values, id, at, this.template?.ref)
      const checks = checkEvents(this.checks, values, id, at, this.template?.ref)
      for (const event of checks) this.checks.delete(event.field)
      // Each event is recorded once; a rejection stays in force while the draft is open. A suggestion
      // the save said nothing about is still the one showing, not a new presentation.
      for (const event of events) this.offered.delete(event.field)
      this.classes = new Map()
      for (const event of [...classes, ...events, ...checks]) await vault.recordEvent(event)
    }
    this.typing = new Set()
    // The file holds marks only on the values not yet decided.
    const values = this.source.values()
    this.marked = this.marked.filter((f) => !this.decidedMark(f, values))
    for (const field of [...this.shownAsIs.keys()]) if (!this.marked.includes(field)) this.shownAsIs.delete(field)
    this.cleared = new Set()
  }

  /** What the form draws by each judgment field: the suggested value to take or decline, or why there is none. */
  fieldStates(): FieldStates {
    const states: FieldStates = {}
    for (const [field, { value, by }] of this.proposed) {
      states[field] = { suggestions: [value], note: strings.suggestionProposed(by), decline: strings.reject }
    }
    for (const [field, s] of this.suggestions) {
      const note = s.mode === 'coarse' ? strings.suggestionClass(this.source.sourceOf(s)) : this.source.sourceOf(s)
      states[field] = { suggestions: [s.value!], note, decline: strings.reject }
    }
    for (const field of this.checks.keys()) states[field] = { note: strings.judgmentCheck }
    for (const [field, reason] of this.abstained) {
      states[field] = {
        note:
          reason === 'unavailable'
            ? strings.judgmentUnavailable
            : strings.judgmentAbstained(reason, this.learned.get(field) ?? 0, this.source.hasCases()),
      }
    }
    return states
  }

  /** A field's label as its template gives it, or its name. */
  label(field: string): string {
    return this.template?.fields.find((f) => f.name === field)?.label ?? field
  }

  /** Asks for a value for each empty judgment field, given what the other fields hold. */
  private async suggest() {
    const template = this.template
    if (!template) return
    const run = ++this.suggestRun
    const values = { ...this.source.values() }
    const next = new Map<string, Suggestion>()
    const abstained = new Map<string, Abstention | null | 'unavailable'>()
    const typedWhenAsked = new Map<string, number>()
    const drawn = new Map<string, Suggestion>()
    for (const field of template.suggest) {
      // Drawn to check it: its value stays held back while the draft is open.
      if (this.checks.has(field)) continue
      // A field being typed into is asked with what has been typed, as an open field; one holding a value otherwise
      // is settled, and not asked about.
      const typed = this.typing.has(field) && typeof values[field] === 'string' ? (values[field] as string) : undefined
      if (!isEmpty(values[field]) && typed === undefined) continue
      // A value another program proposed is offered in the field until the person decides it.
      if (this.proposed.has(field)) continue
      try {
        const document = this.source.draft()?.id
        const { [field]: _, ...others } = values
        let roll = this.rolls.get(field)
        if (roll === undefined) this.rolls.set(field, (roll = this.roll()))
        const suggestion = await host.suggest(template.ref, field, typed === undefined ? values : others, document, typed, roll)
        // Declined here, now or before it was last saved: not offered again, and nothing to explain.
        if (this.rejected.has(field) || suggestion.mode === 'rejected') continue
        if (suggestion.mode === 'check') {
          drawn.set(field, suggestion)
          continue
        }
        // While typing, only a value that adds to the text is worth showing, and no reason is given for there being none.
        if (typed !== undefined) {
          if (suggestion.value !== null && suggestion.value !== typed) next.set(field, suggestion)
        } else if (suggestion.value !== null) next.set(field, suggestion)
        else abstained.set(field, suggestion.reason ?? null)
        typedWhenAsked.set(field, charactersTyped(typed))
      } catch {
        abstained.set(field, 'unavailable')
      }
    }
    // Values may have changed (or another draft opened) while these were asked for.
    if (run !== this.suggestRun || this.template !== template) return
    this.suggestions = next
    this.abstained = abstained
    const filled = fillOrder(this.filled, values)
    for (const [field, { held, probability }] of drawn) {
      if (typeof held === 'string' && typeof probability === 'number')
        this.checks.set(field, { held, probability, shown: new Date(), filled })
    }
    this.host.requestUpdate()
    for (const [field, suggestion] of next) {
      // Asked again after each pause in typing: the same value still showing is the same presentation.
      if (this.offered.get(field)?.suggestion.value === suggestion.value) continue
      const offer: Offer = { suggestion, shown: new Date(), filled, typed: typedWhenAsked.get(field) ?? 0 }
      this.offered.set(field, offer)
      void vault.recordPresentation(presentation(template.ref, field, offer)).catch(() => {})
    }
  }

  /** Notes when a suggestion was taken or rejected, and what was in its field then — before taking it changes that. */
  private decided(field: string) {
    const offer = this.offered.get(field)
    if (!offer) return
    const value = this.source.values()[field]
    offer.decided = new Date()
    offer.decidedTyped = charactersTyped(typeof value === 'string' ? value : undefined)
  }

  /** `field`'s proposed value, if any, is decided: it is no longer offered. */
  private settle(field: string) {
    if (!this.proposed.has(field)) return
    const rest = new Map(this.proposed)
    rest.delete(field)
    this.proposed = rest
    this.host.requestUpdate()
  }

  private dismiss(field: string) {
    const rest = new Map(this.suggestions)
    rest.delete(field)
    this.suggestions = rest
    this.host.requestUpdate()
  }

  /** Whether a person types a field's value out — one value of a text kind, with no choices to pick from. */
  private typeable(field: string): boolean {
    const f = this.template?.fields.find((f) => f.name === field)
    return !!f && !f.multiple && f.options.length === 0 && TYPED_TYPES.has(f.type)
  }
}

/** Whether two values of a field are the same: items in the same order, or both empty. */
function sameValue(a: FieldValues[string] | undefined, b: FieldValues[string] | undefined): boolean {
  if (isEmpty(a) && isEmpty(b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  return a === b
}
