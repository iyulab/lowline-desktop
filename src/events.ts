// Suggestion events: what a person did with a suggestion, recorded when the document is saved —
// saving is when a value is confirmed. The only learning signals are these explicit ones.
// Suggestions shown and never saved are kept apart, on the device (see `Presentation`).

import type { FieldValue, FieldValues } from './documents.js'
import type { Suggestion } from './projection.js'

/**
 * `accept` · `correct` · `reject`: what became of a suggestion shown. `check`: the value entered in a field whose
 * suggestion was held back to check it — `suggested` is the value held back, `probability` the chance it was drawn with.
 */
export type EventKind = 'accept' | 'correct' | 'reject' | 'check'

/** One line of `.lowline/events/<device>.jsonl`. */
export interface SuggestionEvent {
  at: string
  /** The document's id (`identity.ts`) — for a document with none, its path relative to the vault. */
  doc: string
  /**
   * The document's template as `id@version`, so the event still says where it belongs if the document
   * is renamed, and which revision it was made under. Read against the vault it counts for the template of
   * that id as it is now (`template-revision.ts`): a field is the same field across revisions by its name.
   */
  template?: string
  field: string
  kind: EventKind
  suggested: string
  /** The value saved; null when the field was left empty after a rejection. */
  value: FieldValue | null
  /**
   * Where the suggestion came from (`key`: a value settled alongside one this record has · `memory`: a similar
   * record, in events from before similar records stopped being suggested), what it rests on (that value, or that
   * record), and how close the record was — empty for `key`.
   */
  source: string
  recall: string | null
  similarity: number | null
  /** The fields that held a value when the suggestion was made — names only, in the order they were filled. */
  filled?: string[]
  /** When the suggestion was first shown; `at` is when the save confirmed what became of it. */
  shownAt?: string
  /** When it was taken or rejected; absent when the field was changed without either. */
  decidedAt?: string
  /**
   * How many characters were typed in the field when the suggestion was first shown — 0 when it was shown before
   * any typing. The same value still showing as typing goes on is the same presentation, so a value shown before
   * typing and taken after counts 0. Absent in events from before it was recorded: not known, not 0.
   */
  typed?: number
  /**
   * How many characters were in the field when the suggestion was taken or rejected — with `decidedAt`, absent
   * without it. A value shown before typing and taken after two characters has `typed` 0 and `decidedTyped` 2.
   */
  decidedTyped?: number
  /** For a `check`: the chance the field was drawn with — what the value entered is weighted by. */
  probability?: number
  /**
   * The precision the layer that gave the suggestion promised when it was shown — for a `check`, the layer of the value
   * held back. Absent in events from before it was recorded, and when none was reported: not known, not 0.
   */
  promise?: number
}

/** A suggestion as it was shown in a draft, and what the person did with it before saving. */
export interface Offer {
  suggestion: Suggestion
  shown: Date
  /** See {@link SuggestionEvent.filled}. */
  filled: string[]
  /** See {@link SuggestionEvent.typed}. */
  typed: number
  decided?: Date
  /** See {@link SuggestionEvent.decidedTyped}; set with `decided`. */
  decidedTyped?: number
}

/** The characters in `text` as a person counts them — a Hangul syllable is one; none when nothing was typed. */
export function charactersTyped(text: string | undefined): number {
  return text === undefined ? 0 : [...text].length
}

/**
 * The fields holding a value, in the order they were filled: those still filled keep their place,
 * newly filled ones follow in `values`' order, emptied ones drop out.
 */
export function fillOrder(previous: readonly string[], values: FieldValues): string[] {
  const kept = previous.filter((name) => !isEmpty(values[name]))
  const added = Object.keys(values).filter((name) => !isEmpty(values[name]) && !kept.includes(name))
  return [...kept, ...added]
}

function isEmpty(value: FieldValue | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

function same(value: FieldValue, suggested: string): boolean {
  return (Array.isArray(value) ? value.join(', ') : String(value)) === suggested
}

/**
 * The events a save confirms, one per field a suggestion was offered for:
 * saved as suggested → accept; saved with another value → correct; rejected and left empty →
 * reject. A suggestion neither taken nor rejected, on a field left empty, says nothing.
 */
export function suggestionEvents(
  offered: ReadonlyMap<string, Offer>,
  rejected: ReadonlySet<string>,
  saved: FieldValues,
  doc: string,
  at: Date,
  template?: string,
): SuggestionEvent[] {
  const events: SuggestionEvent[] = []
  for (const [field, { suggestion, shown, filled, typed, decided, decidedTyped }] of offered) {
    if (suggestion.value === null) continue
    const value = saved[field]
    let kind: EventKind | undefined
    // A class is taken when the value saved is of it — begins with it — whatever the rest of the value is.
    if (!isEmpty(value))
      kind = (suggestion.mode === 'coarse' ? typeof value === 'string' && value.startsWith(suggestion.value) : same(value!, suggestion.value))
        ? 'accept'
        : 'correct'
    else if (rejected.has(field)) kind = 'reject'
    if (!kind) continue
    events.push({
      at: at.toISOString(),
      doc,
      ...(template ? { template } : {}),
      field,
      kind,
      suggested: suggestion.value,
      value: isEmpty(value) ? null : value!,
      source: suggestion.mode,
      recall: suggestion.source,
      // Similar records are no longer suggested; the field stays in the event format, empty.
      similarity: null,
      filled,
      shownAt: shown.toISOString(),
      ...(decided ? { decidedAt: decided.toISOString() } : {}),
      typed,
      ...(decided && decidedTyped !== undefined ? { decidedTyped } : {}),
      ...(typeof suggestion.promise === 'number' ? { promise: suggestion.promise } : {}),
    })
  }
  return events
}

/**
 * The checks a save confirms: one per field drawn to check it that the person filled in. A field left empty settled
 * nothing, and says nothing.
 */
export function checkEvents(
  checks: ReadonlyMap<string, Check>,
  saved: FieldValues,
  doc: string,
  at: Date,
  template?: string,
): SuggestionEvent[] {
  const events: SuggestionEvent[] = []
  for (const [field, { held, probability, promise, shown, filled }] of checks) {
    const value = saved[field]
    if (isEmpty(value)) continue
    events.push({
      at: at.toISOString(),
      doc,
      ...(template ? { template } : {}),
      field,
      kind: 'check',
      suggested: held,
      value: value!,
      source: 'check',
      recall: null,
      similarity: null,
      filled,
      shownAt: shown.toISOString(),
      probability,
      ...(promise !== undefined ? { promise } : {}),
    })
  }
  return events
}

/** A field of the draft drawn to check it: the value held back, the chance it was drawn with, and when. */
export interface Check {
  held: string
  probability: number
  /** See {@link SuggestionEvent.promise}: that of the value held back. */
  promise?: number
  shown: Date
  /** See {@link SuggestionEvent.filled}. */
  filled: string[]
}

const KINDS: readonly string[] = ['accept', 'correct', 'reject', 'check']

/**
 * The events in one device's event file. A line that is not an event — cut short by a sync
 * conflict, or written by a later version — is skipped rather than failing the whole file.
 */
export function parseEvents(text: string): SuggestionEvent[] {
  const events: SuggestionEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (isEvent(event)) events.push(event)
  }
  return events
}

function isEvent(e: unknown): e is SuggestionEvent {
  if (typeof e !== 'object' || e === null) return false
  const { at, doc, field, kind, suggested } = e as Record<string, unknown>
  return (
    typeof at === 'string' &&
    typeof doc === 'string' &&
    typeof field === 'string' &&
    typeof kind === 'string' &&
    KINDS.includes(kind) &&
    typeof suggested === 'string'
  )
}

/**
 * One suggestion shown, as this device keeps it outside the vault: whether or not the document was
 * then saved. Nothing learns from it — it is counted, so decisions can be read against what was shown.
 */
export interface Presentation {
  at: string
  template: string
  field: string
  /** Where the suggestion came from, as in {@link SuggestionEvent.source}. */
  source: string
  /** As in {@link SuggestionEvent.typed}; absent in presentations from before it was recorded. */
  typed?: number
}

export function presentation(template: string, field: string, offer: Offer): Presentation {
  return { at: offer.shown.toISOString(), template, field, source: offer.suggestion.mode, typed: offer.typed }
}

/** The presentations in this device's file; a line that is not one is skipped. */
export function parsePresentations(text: string): Presentation[] {
  const shown: Presentation[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let p: unknown
    try {
      p = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof p !== 'object' || p === null) continue
    const { at, template, field, source, typed } = p as Record<string, unknown>
    if (typeof at === 'string' && typeof template === 'string' && typeof field === 'string' && typeof source === 'string')
      shown.push({ at, template, field, source, ...(typeof typed === 'number' ? { typed } : {}) })
  }
  return shown
}
