// What the sidecar gets to see of the vault: templates as field lists, documents as values.
// The UI parses (Formdown lives here); the sidecar projects. Neither re-reads the other's work.

import { getSchema, parseFormdown, type FieldSuggest, type FormDownSchema } from '@formdown/core'
import { documentFrontMatter, holdsValue, templateInfo } from './documents.js'
import { documentId } from './identity.js'
import { templateId } from './template-revision.js'
import type { SuggestionEvent } from './events.js'

export interface TemplateField {
  name: string
  /** What the form shows for the field; the table's column heading. */
  label: string
  /** The Formdown field type (`text`, `select`, `checkbox`, …). */
  type: string
  /** A checkbox with options: its value is a list. */
  multiple: boolean
  /** A choice field's option values (select, radio, checkbox group) — what a document holds; empty for any other field. */
  options: string[]
  /** What the form shows for an option whose text differs from its value (`value=Label`), by value. */
  optionLabels?: Record<string, string>
  /**
   * The id of the template whose documents the field's value names (`@고객 -> customer: [select]`): its value
   * is one of those documents' ids. Absent for a field that refers to none.
   */
  reference?: string
  /**
   * What the field says of suggesting its value beyond being judged (Formdown's `suggest:*`), for the sidecar's engine:
   * `confirm` — suggested but only a person puts the value in; `evidence: false` — no clue for the other fields; the
   * field its choices depend on; values never to miss; the group of fields it is settled together with. Absent when it
   * says none of these.
   */
  suggest?: FieldSuggestion
}

/** The parts of a field's `suggest:*` attributes the sidecar's engine acts on beyond whether it is judged. */
export interface FieldSuggestion {
  policy?: 'confirm'
  evidence?: boolean
  parent?: string
  mustCatch?: string[]
  together?: string
}

/** What of a field's `suggest:*` attributes the sidecar acts on beyond `role`, `coarse` and `policy=off`, or undefined. */
function suggestionOf(said: FieldSuggest | undefined): FieldSuggestion | undefined {
  if (!said) return undefined
  const kept: FieldSuggestion = {
    ...(said.policy === 'confirm' && { policy: 'confirm' as const }),
    ...(said.evidence !== undefined && { evidence: said.evidence }),
    ...(said.parent !== undefined && { parent: said.parent }),
    ...(said.mustCatch?.length && { mustCatch: [...said.mustCatch] }),
    ...(said.together !== undefined && { together: said.together }),
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

export interface TemplateSnapshot {
  ref: string
  fields: TemplateField[]
  /** Judgment fields the template's author turned suggestions on for (front matter `lowline.suggest`). */
  suggest: string[]
  /**
   * For judgment fields whose values name a broader class in their leading characters — the chapter of a fault code —
   * how many characters (front matter `lowline.coarse`): where the value cannot be suggested, its class may be.
   * Absent when the template names none.
   */
  coarse?: Record<string, number>
  /**
   * formdown's schema of exactly `fields`, in their order (`getSchema`): what the sidecar declares the template's columns
   * from — their types and headings — through Formbase's formdown adapter, so formdown's types have one reading.
   */
  schema: FormDownSchema
}

export interface DocumentSnapshot {
  path: string
  /** What the document is known by (`identity.ts`): what suggestions learned and events recorded are about. */
  id: string
  template: string
  values: Record<string, unknown>
  /** When the file was last saved (ms since the epoch): its values were last confirmed then. */
  modified?: number
  /**
   * A sync client left a conflict copy of it: its values are not confirmed until the person settles
   * which to keep. It stays in the table; suggestions do not learn from it.
   */
  conflicted?: boolean
  /**
   * Its front matter has no id: the app has never saved it — another program wrote it, or it was made before
   * documents had ids. Its judgment values are learned from all the same, though no one may have confirmed them.
   */
  outside?: boolean
  /**
   * Its fields holding a value another program wrote as a suggestion (`lowline.proposed`): the value stays in the
   * document and the table, but suggestions do not learn from it, and the field is not settled until a person decides it.
   */
  proposed?: string[]
}

export interface VaultSnapshot {
  templates: TemplateSnapshot[]
  documents: DocumentSnapshot[]
  /** What people did with suggestions, from every device's event file. */
  events: SuggestionEvent[]
}

/** A template's reference and fields in template order. Throws `TemplateError` if it has no identity. */
export function templateSnapshot(source: string): TemplateSnapshot {
  const { ref } = templateInfo(source)
  const parsed = parseFormdown(source)
  // A document holds one value per field name, so a name used twice in the source is one field — as it
  // first appears. The template page says the name is used twice; the projection and suggestions go on.
  const seen = new Set<string>()
  const unique = parsed.forms.filter((f) => !seen.has(f.name) && seen.add(f.name))
  const fields = unique.map((f) => {
    const choices = ['select', 'radio', 'checkbox'].includes(f.type) ? (f.options ?? []) : []
    const labelled = choices.filter((o) => o.label !== undefined)
    return {
    name: f.name,
    label: f.label ?? f.name,
    type: f.type,
    multiple: f.type === 'checkbox' && choices.length > 0,
    options: choices.map((o) => o.value),
    ...(labelled.length > 0 ? { optionLabels: Object.fromEntries(labelled.map((o) => [o.value, o.label!])) } : {}),
    // One document of another template (`->`); many to many (`<->`) is not read yet.
    ...(f.relation?.type === 'fk' ? { reference: f.relation.target } : {}),
    ...(suggestionOf(f.suggest) ? { suggest: suggestionOf(f.suggest) } : {}),
    }
  })
  const said = saidOf(unique)
  const suggest = suggestFields(parsed.frontMatter?.data, fields, said)
  const coarse = coarseFields(parsed.frontMatter?.data, fields, suggest, said)
  const schema = getSchema({ ...parsed, forms: unique })
  return { ref, fields, suggest, ...(coarse ? { coarse } : {}), schema }
}

/**
 * A column a template's documents can be counted by: one of its fields, or — through `via`, a field of it naming one
 * document of another template — a field of that document, named `<field>.<its field>` and labelled the same way.
 */
export interface CountColumn extends TemplateField {
  via?: string
}

/**
 * The columns `template`'s documents can be counted by, as the sidecar counts them: its fields, then for each field
 * naming one document of a template in `templates`, that template's fields — not its own references: one step.
 */
export function countColumns(template: TemplateSnapshot, templates: readonly TemplateSnapshot[]): CountColumn[] {
  const byId = new Map(templates.map((t) => [templateId(t.ref), t]))
  return [
    ...template.fields,
    ...template.fields.flatMap((f) => {
      const target = !f.multiple && f.reference ? byId.get(f.reference) : undefined
      return (target?.fields ?? [])
        .filter((g) => !g.reference)
        .map((g) => ({ ...g, name: `${f.name}.${g.name}`, label: `${f.label}.${g.label}`, via: f.name }))
    }),
  ]
}

/**
 * The other templates whose documents refer to `template`'s — inspections naming their business — each with the
 * fields that do: what a question about a business can count ("the businesses inspected most"). One field naming one
 * document each, as `countColumns` follows them; in the vault's order.
 */
export function referringTemplates(template: TemplateSnapshot, templates: readonly TemplateSnapshot[]): { template: TemplateSnapshot; via: string[] }[] {
  const id = templateId(template.ref)
  return templates.flatMap((t) => {
    const via = t.fields.filter((f) => !f.multiple && f.reference === id).map((f) => f.name)
    return templateId(t.ref) !== id && via.length > 0 ? [{ template: t, via }] : []
  })
}

/**
 * The templates the vault's fields refer to, by id: a template is one whose documents are what other
 * documents are about (a customer, an item) because a field says so — nothing marks it otherwise. Only
 * templates in the vault count.
 */
export function referenceTargets(templates: readonly TemplateSnapshot[]): Set<string> {
  const present = new Set(templates.map((t) => templateId(t.ref)))
  return new Set(templates.flatMap((t) => t.fields.flatMap((f) => (f.reference && present.has(f.reference) ? [f.reference] : []))))
}

/** The fields a template source turns suggestions on for (see `templateSnapshot`) — empty while it does not parse. */
export function judgedFields(source: string): string[] {
  try {
    const parsed = parseFormdown(source)
    return suggestFields(parsed.frontMatter?.data, parsed.forms.map((f) => ({ name: f.name })), saidOf(parsed.forms))
  } catch {
    return []
  }
}

/** What each field says of suggesting its value, by name, as Formdown read its `suggest:*` attributes. */
function saidOf(forms: readonly { name: string; suggest?: FieldSuggest }[]): Map<string, FieldSuggest> {
  return new Map(forms.flatMap((f) => (f.suggest ? [[f.name, f.suggest] as const] : [])))
}

/**
 * The fields a template turns suggestions on for. Off unless the author says so: on the field itself, with Formdown's
 * `suggest:role=judged` (and not `suggest:policy=off`) — what any tool that reads Formdown reads too — or, as templates
 * written before said it, by name under the front matter's `lowline.suggest`. Where a field says its role or that it is
 * never suggested, that is what counts; the front matter's list speaks for the rest. Names that are not fields of the
 * template are ignored. The front matter's names come first, in its order, then the fields only their own attributes
 * turn on, in template order.
 */
function suggestFields(
  data: Record<string, unknown> | undefined,
  fields: readonly { name: string }[],
  said: ReadonlyMap<string, FieldSuggest>,
): string[] {
  const lowline = data?.lowline
  const named = typeof lowline === 'object' && lowline !== null ? (lowline as { suggest?: unknown }).suggest : undefined
  const listed = Array.isArray(named) ? named.filter((n): n is string => typeof n === 'string') : []
  const own = (name: string): boolean | undefined => {
    const suggest = said.get(name)
    if (suggest?.policy === 'off') return false
    return suggest?.role === undefined ? undefined : suggest.role === 'judged'
  }
  const known = new Set(fields.map((f) => f.name))
  const fromList = listed.filter((n) => known.has(n) && own(n) !== false)
  const fromFields = fields.map((f) => f.name).filter((n) => own(n) === true && !fromList.includes(n))
  return [...new Set([...fromList, ...fromFields])]
}

/**
 * How many leading characters name the class of a judgment field's values, by field — as the field says with Formdown's
 * `suggest:coarse`, or else as the template's front matter says under `lowline.coarse` — or undefined when none is
 * named. Only a judgment field taking one value, and a whole number of characters from one, count; anything else is
 * ignored.
 */
function coarseFields(
  data: Record<string, unknown> | undefined,
  fields: TemplateField[],
  suggest: string[],
  said: ReadonlyMap<string, FieldSuggest>,
): Record<string, number> | undefined {
  const lowline = data?.lowline
  const named = typeof lowline === 'object' && lowline !== null ? (lowline as { coarse?: unknown }).coarse : undefined
  const listed = typeof named === 'object' && named !== null && !Array.isArray(named) ? (named as Record<string, unknown>) : {}
  const counts = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1
  const coarse = fields
    .filter((f) => !f.multiple && suggest.includes(f.name))
    .flatMap((f) => {
      const n = said.get(f.name)?.coarse ?? listed[f.name]
      return counts(n) ? [[f.name, n] as const] : []
    })
  return coarse.length > 0 ? Object.fromEntries(coarse) : undefined
}

/** A document's template and values, or undefined when it names no template. */
export function documentSnapshot(path: string, source: string, modified?: number): DocumentSnapshot | undefined {
  const { template, id, values, proposed } = documentFrontMatter(source)
  if (!template) return undefined
  // A mark on a field holding no value says nothing.
  const marked = Object.keys(proposed ?? {}).filter((f) => holdsValue(values[f]))
  return {
    path,
    id: documentId(path, id),
    template,
    values,
    ...(modified ? { modified } : {}),
    ...(id ? {} : { outside: true }),
    ...(marked.length > 0 ? { proposed: marked } : {}),
  }
}

/**
 * Counts of a template's documents per value of some fields, the largest first (of a tie, a blank value last) — each
 * with the vault paths of the documents it is made of, read with the count.
 */
/**
 * Counts of a template's documents per value of `groupBy`, each with the documents it is made of — and, when `sum` names
 * a number field, what it adds up to over each group: `total` exact (null when none of them has a value — not 0) and
 * `counted`, how many of them have one.
 */
export interface AggregateAnswer {
  template: string
  groupBy: string[]
  groups: { key: Record<string, unknown>; count: number; evidence: string[]; sum: { total: number | null; counted: number } | null }[]
  sum: string | null
}

export interface ProjectionTable {
  template: string
  columns: { name: string; type: string }[]
  rows: { path: string; values: Record<string, unknown> }[]
}

/** What an ingest changed in the sidecar's projection cache. */
export interface IngestResult {
  appended: number
  retired: number
  projections: string[]
  skipped: { path: string; reason: string }[]
  /** Fields a row leaves empty because their value could not be read as the field's type. */
  skippedFields: { template: string; path: string; field: string; reason: string }[]
}

/**
 * A cell as text: lists joined, booleans as a check or a cross, missing values empty — a box someone
 * left unchecked is an answer, and reads differently from a field nobody has filled in.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? '✓' : '✗'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/**
 * One condition on a template's table, answered by the sidecar from the projection: `column` is a field's
 * name, or `$path` for the document's vault path (its name); `contains` matches text ignoring case,
 * `atLeast`/`atMost` bound a number or date field, both included, and `empty` matches a field left blank
 * (its `value` is not read).
 */
export interface ColumnFilter {
  column: string
  op: 'contains' | 'equal' | 'atLeast' | 'atMost' | 'empty'
  value: string
}

/** Field types the projection keeps as dates: their filters are ranges, not text. */
export const DATE_TYPES: readonly string[] = ['date', 'datetime-local']

/** The column that carries a document's vault path. */
export const PATH_COLUMN = '$path'

/** How a judgment field's suggestions have fared, decision by decision. */
export interface FieldCurve {
  template: string
  field: string
  accepted: number
  corrected: number
  rejected: number
  /** After the nth decision, the share of the latest ones (up to a window) that were right. */
  points: { n: number; at: string; rate: number }[]
  /**
   * The decisions split by where each suggestion came from (`key` · `memory`, as {@link Suggestion.mode}), in that
   * order — each source promises the target on its own, so each is read apart. Decisions recorded without a source
   * are only in the totals.
   */
  bySource?: { source: string; decided: number; accepted: number }[] | null
  /**
   * The field's saved documents replayed in the order they were saved, each asked of the ones before it for a
   * value settled alongside its observed values: the share of lookups that got a suggestion and the share of those
   * that were right, at the strength the replay chose. Absent until the history is long enough to choose one from.
   * `dependsOn` names the fields the replay chose for the suggestions to rest on, when resting on them alone was
   * suggested more often at the same precision; absent or null when every value filled in counts. `promise` is what to
   * expect of the next suggestions at least: the precision of those among the latest `promiseOver` documents (of the
   * whole replay when they are too few to rest on), lowered to what the `promiseAnswered` answers it rests on can vouch
   * for — a floor, not a forecast.
   */
  replay?: {
    threshold: number
    precision: number
    promise: number
    promiseAnswered: number
    promiseOver: number
    answerRate: number
    answered: number
    lookups: number
    dependsOn?: string[] | null
  } | null
  /**
   * Why there is no replay: `few` confirmed documents to choose a strength from, the replay still `pending`, or
   * `below-target` — no strength was right often enough, so nothing is offered for the field.
   */
  whyNoReplay?: 'few' | 'pending' | 'below-target' | null
  /**
   * With `below-target`, how close the replay came: at the most precise strength that still gathered enough
   * answers, the share of them that were right, against the target. It can reach the target and the field still
   * not be offered, when a band of answers within it falls short.
   */
  closest?: { precision: number; answerRate: number; answered: number; lookups: number; target: number } | null
  /**
   * For a field whose value is typed out, once its replay has run: its saved documents typed from their start, for
   * each number of characters typed a strength was chosen for — of the documents the suggestion before did not get
   * right and long enough to type that far, the share that got a suggestion and the share of those that were right.
   * Empty when no number of characters reached the target; absent or null for a field whose value is picked.
   */
  typing?: TypedReplay[] | null
  /**
   * For a field whose template names a class (`lowline.coarse`), once a strength was chosen for the class: of the
   * documents whose value the replay left unsuggested, the share given a class and the share of those right, with what
   * to expect next as for `replay`. Absent or null otherwise.
   */
  coarse?: { threshold: number; precision: number; promise: number; promiseAnswered: number; promiseOver: number; answerRate: number; answered: number; lookups: number } | null
  /**
   * Once a strength was chosen for similar records: of the documents values settled alongside left unsuggested, the share
   * a similar record answered and the share of those right, with what to expect next as for `replay`. `offered`: whether
   * the field is offered their values — only once that promise rests on at least `offeredFrom` answers. Absent or null
   * otherwise.
   */
  /**
   * The field's history has grown or shrunk by a tenth since its strengths were chosen, and they are being chosen again:
   * what `replay`, `similar` and the rest say is from before until they are.
   */
  rechoosing: boolean
  /**
   * What the field's precision was counted on when its strengths were last chosen: `checks` of its documents settled it
   * while its suggestion was held back to check it (one in `1 / rate`), and until `countOnFrom` have, every value a person
   * settled counts (`settled`) — after, only values entered with nothing in view and checks (`unprompted`). Absent or null
   * until its strengths were first chosen.
   */
  counting?: { counting: 'settled' | 'unprompted'; checks: number; countOnFrom: number; rate: number } | null
  similar?: {
    threshold: number
    precision: number
    promise: number
    promiseAnswered: number
    promiseOver: number
    answerRate: number
    answered: number
    lookups: number
    offered: boolean
    offeredFrom: number
  } | null
}

export interface TypedReplay {
  characters: number
  threshold: number
  precision: number
  answerRate: number
  answered: number
  lookups: number
}

/**
 * Why a judgment field got no suggestion: `no-history` — nothing confirmed yet; `below-target` — the values settled
 * alongside the observed ones have not yet shown, replaying its history, that they are right often enough;
 * `undecided` — they have, and this document's observed values settle none.
 */
export type Abstention = 'no-history' | 'below-target' | 'undecided' | 'together' | 'checked-together'

/** A document found by the words of its values: where it is, its template, its matching text, how well it matched. */
export interface CaseHit {
  path: string
  template: string
  /** The document's values, one per line, as the index holds them. */
  text: string
  /** A sync client kept another device's edit of it as a copy beside it. */
  conflicted: boolean
  score: number
}

export interface Suggestion {
  /** The suggested value; null when there is none to offer. */
  value: string | null
  /**
   * `key`: settled alongside a value this document has · `coarse`: not the value but its class — its leading characters,
   * as the template's `lowline.coarse` counts them — kept to the same promise · `memory`: the value a similar document
   * confirmed, where none settled alongside answered — only on a field whose replay of similar documents kept the target
   * over enough answers · `abstain` · `rejected` · `proposed`: the value another program wrote into the document as a
   * suggestion (`lowline.proposed` — the app's own, never the sidecar's) · `check`: no value — the field was drawn to check
   * it, and the value it would be shown is held back (`held`) so that what the person enters counts as entered with
   * nothing in view.
   */
  mode: 'key' | 'coarse' | 'memory' | 'abstain' | 'rejected' | 'proposed' | 'check'
  /**
   * What it rests on: the other field's value (`부서: 영업`) — for a similar document's value, that document's id — or, for a
   * proposed value, who wrote it (empty: unsaid).
   */
  source: string | null
  /** Why there is none, when `value` is null and the field was asked (`abstain`). */
  reason?: Abstention | null
  /** For `check`: the chance the field was drawn with. */
  probability?: number | null
  /** For `check`: the value held back — recorded with what the person enters, never shown. */
  held?: string | null
}
