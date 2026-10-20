// Asking the vault: what a model's reply says to count — checked against the template's fields — before the vault counts
// it. The model never writes a number: the counts, and the documents behind each, come from the vault's aggregate.

import { DATE_TYPES, type ColumnFilter, type TemplateField } from './projection.js'
import type { DocumentNames } from './references.js'
import { templateId } from './template-revision.js'
import { strings } from './strings.js'

/**
 * What to count: by which fields, of which documents, and how many of the largest counts to show (all when unset).
 * `of` is the template whose documents are counted when it is not the one asked about — one whose documents refer to
 * it, as inspections name their business. `sum` is a number field to add up over each count's documents too.
 */
export interface QueryPlan {
  groupBy: string[]
  filters: ColumnFilter[]
  top?: number
  of?: string
  sum?: string
}

/** The field types a sum adds up: what the projection keeps as a number. */
export const NUMBER_TYPES: readonly string[] = ['number', 'range']

/**
 * A template whose documents refer to the one asked about, as a question may count it: its reference, its name as the
 * vault shows it, its fields that name the asked template's documents, and the columns its documents are counted by
 * (`countColumns`).
 */
export interface ReferringCount {
  ref: string
  name: string
  via: readonly string[]
  columns: readonly TemplateField[]
}

/** What the reply asked for, checked: a plan to count — or why it is not one, in the app's terms. */
export type ReadPlan =
  | { plan: QueryPlan }
  | { unanswerable: string }
  | { problem: 'no-plan' }
  | { problem: 'unknown-template'; template: string }
  | { problem: 'unknown-field'; field: string }
  | { problem: 'bad-filter'; field: string }

const OPS = new Set(['equal', 'contains', 'atLeast', 'atMost', 'empty', 'period'])

/**
 * The spans of time a question names relative to today. The model says which one; the app works out its days, so a
 * small model's date arithmetic is never what is counted. A week starts on Monday.
 */
export const PERIODS = ['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'this-year', 'last-year'] as const
export type Period = (typeof PERIODS)[number]

const day = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/**
 * The first and last day of `period` on this computer's calendar, `today` being the day it is — or of a month named
 * `YYYY-MM`, or a year `YYYY`; null for anything else.
 */
export function periodDays(period: string, today: Date): { from: string; to: string } | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
  if (month) return { from: day(new Date(+month[1], +month[2] - 1, 1)), to: day(new Date(+month[1], +month[2], 0)) }
  if (/^\d{4}$/.test(period)) return { from: `${period}-01-01`, to: `${period}-12-31` }
  return (PERIODS as readonly string[]).includes(period) ? relativeDays(period as Period, today) : null
}

function relativeDays(period: Period, today: Date): { from: string; to: string } {
  const [y, m, d] = [today.getFullYear(), today.getMonth(), today.getDate()]
  const span = (from: Date, to: Date) => ({ from: day(from), to: day(to) })
  const monday = d - ((today.getDay() + 6) % 7)
  switch (period) {
    case 'today':
      return span(today, today)
    case 'yesterday':
      return span(new Date(y, m, d - 1), new Date(y, m, d - 1))
    case 'this-week':
      return span(new Date(y, m, monday), new Date(y, m, monday + 6))
    case 'last-week':
      return span(new Date(y, m, monday - 7), new Date(y, m, monday - 1))
    case 'this-month':
      return span(new Date(y, m, 1), new Date(y, m + 1, 0))
    case 'last-month':
      return span(new Date(y, m - 1, 1), new Date(y, m, 0))
    case 'this-year':
      return span(new Date(y, 0, 1), new Date(y, 11, 31))
    case 'last-year':
      return span(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31))
  }
}

/**
 * Whether `question` asks about something left blank: a condition that a field is empty is kept only then. A small
 * model adds one to questions that never said so ("accidents per aircraft kind" counted only where the damage is
 * blank); what was counted is said in words either way.
 */
const ASKS_BLANK = /비어|비었|빈 |빈칸|공란|없는|없이|없고|안 적|안 쓴|안 채|미입력|미기재|누락|blank|empty|missing/i

/**
 * Whether `question` names the choice `value` of `field` — as written, by the label the form shows for it, or without
 * a part in parentheses ("Risk 1" for `Risk 1 (High)`) — letter case and spaces aside.
 */
function namesChoice(question: string, value: string, field: TemplateField): boolean {
  const plain = (text: string) => text.toLowerCase().replace(/\s+/g, '')
  const said = plain(question)
  const label = field.optionLabels?.[value]
  return [value, label, value.replace(/\s*\([^)]*\)\s*/g, ' ')]
    .filter((text): text is string => !!text && plain(text).length > 0)
    .some((text) => said.includes(plain(text)))
}

/** The JSON object in the reply's last fenced block — or the reply itself — or null. */
function objectOf(reply: string): Record<string, unknown> | null {
  const blocks = [...reply.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1])
  for (const text of [...blocks.reverse(), reply]) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end < start) continue
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Not JSON: the next candidate, if any.
    }
  }
  return null
}

/**
 * What a reply asks to count, checked against `fields`: each field named one the template has (by name, or by its
 * label), each condition one the vault asks, a value where it needs one — a choice field's value one of its choices.
 * A field named twice to count by counts once. A `period` of a date field — one relative to `today`, a month, a year —
 * becomes its first and last day;
 * of a date-and-time field, from the start of the first to the end of the last. A field that refers to other documents
 * holds their ids: one named by its name in `names` is kept as its id. A reply that counts `of` another template counts
 * one of `referring` — by its name or its id — and is checked against that template's columns instead. Given the
 * `question`, a condition that a field is empty is kept only when the question speaks of something blank, and one that a
 * choice field holds a choice only when the question names that choice. A `sum` names a number field of those columns;
 * one of another kind — a model adding up a date where the question asked how many — is left out, and what was counted
 * says so by saying no sum.
 */
export function queryPlan(
  reply: string,
  columns: readonly TemplateField[],
  today: Date = new Date(),
  names?: DocumentNames,
  referring: readonly ReferringCount[] = [],
  question?: string,
): ReadPlan {
  const asked = objectOf(reply)
  if (!asked) return { problem: 'no-plan' }
  if (typeof asked.unanswerable === 'string') return { unanswerable: asked.unanswerable }
  // A column by its name or label — or, counting a referring template, a field of the asked one as the referring
  // template reaches it through the field naming it (`업소유형` of the business is `업소.업소유형` of its inspection).
  const columnOf = (of: readonly TemplateField[], text: unknown, via: readonly string[] = []) => {
    const wanted = String(text ?? '').trim().replace(/^@/, '')
    const reached = via.flatMap((v) => of.filter((f) => f.name === `${v}.${wanted}`))
    return of.find((f) => f.name === wanted || f.label === wanted) ?? (reached.length === 1 ? reached[0] : undefined)
  }
  let counted: ReferringCount | undefined
  if (asked.of !== undefined && asked.of !== null && asked.of !== '') {
    const wanted = String(asked.of).trim()
    counted = referring.find((r) => r.name === wanted || templateId(r.ref) === wanted || r.ref === wanted)
    if (!counted) return { problem: 'unknown-template', template: wanted }
  } else {
    // A reply that counts by fields the asked template does not have, all of them one referring template's, counts that
    // template's documents — said as counted, so a question taken the wrong way is seen for what it counted.
    const used = [
      ...(Array.isArray(asked.groupBy) ? asked.groupBy : []),
      ...(Array.isArray(asked.filters) ? asked.filters : []).map((c) => (c as Record<string, unknown> | null)?.field),
      ...(asked.sum === undefined || asked.sum === null || asked.sum === '' ? [] : [asked.sum]),
    ]
    if (used.some((name) => !columnOf(columns, name))) {
      const holding = referring.filter((r) => used.every((name) => columnOf(r.columns, name, r.via)))
      if (holding.length === 1) counted = holding[0]
    }
  }
  const fields = counted?.columns ?? columns
  const of = counted?.ref
  const named = (text: unknown) => columnOf(fields, text, counted?.via)
  const groupBy: string[] = []
  for (const name of Array.isArray(asked.groupBy) ? asked.groupBy : []) {
    const field = named(name)
    if (!field) return { problem: 'unknown-field', field: String(name) }
    if (!groupBy.includes(field.name)) groupBy.push(field.name)
  }
  const filters: ColumnFilter[] = []
  for (const condition of Array.isArray(asked.filters) ? asked.filters : []) {
    const { field: name, op, value } = (condition ?? {}) as Record<string, unknown>
    const field = named(name)
    if (!field) return { problem: 'unknown-field', field: String(name) }
    if (typeof op !== 'string' || !OPS.has(op)) return { problem: 'bad-filter', field: field.name }
    if (op === 'empty') {
      if (question === undefined || ASKS_BLANK.test(question)) filters.push({ column: field.name, op, value: '' })
      continue
    }
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
    if (!text) return { problem: 'bad-filter', field: field.name }
    if (op === 'period') {
      const days = DATE_TYPES.includes(field.type) ? periodDays(text, today) : null
      if (!days) return { problem: 'bad-filter', field: field.name }
      const { from, to } = days
      const timed = field.type === 'datetime-local'
      filters.push({ column: field.name, op: 'atLeast', value: timed ? `${from}T00:00` : from })
      filters.push({ column: field.name, op: 'atMost', value: timed ? `${to}T23:59:59` : to })
      continue
    }
    // A choice the question never names is the model's own addition ("accidents per aircraft kind" counted only where the
    // damage was substantial): left out, as an unasked blank is.
    if (op === 'equal' && field.options.length > 0 && question !== undefined && !namesChoice(question, text, field)) continue
    if (op === 'equal' && field.options.length > 0 && !field.options.includes(text)) return { problem: 'bad-filter', field: field.name }
    const id = op === 'equal' && field.reference ? names?.idOf(field.reference, text) : undefined
    filters.push({ column: field.name, op: op as ColumnFilter['op'], value: id ?? text })
  }
  let sum: string | undefined
  if (asked.sum !== undefined && asked.sum !== null && asked.sum !== '') {
    const field = named(asked.sum)
    if (!field) return { problem: 'unknown-field', field: String(asked.sum) }
    if (NUMBER_TYPES.includes(field.type)) sum = field.name
  }
  const top = typeof asked.top === 'number' && Number.isInteger(asked.top) && asked.top > 0 ? asked.top : undefined
  return { plan: { groupBy, filters, ...(top ? { top } : {}), ...(of ? { of } : {}), ...(sum ? { sum } : {}) } }
}

/**
 * What `plan` counts, in words — which documents, by what, how many — shown with every answer, so a question the
 * model took the wrong way is seen for what was counted. Fields by their labels, choices by what the form shows; the
 * documents of another template by its name, `counted` (`fields` are then its columns).
 */
export function planWords(plan: QueryPlan, fields: readonly TemplateField[], names?: DocumentNames, counted?: string): string {
  const of = (name: string) => fields.find((f) => f.name === name)
  const label = (name: string) => of(name)?.label ?? name
  const shown = (name: string, value: string) => {
    const target = of(name)?.reference
    return (target && names?.nameOf(target, value)) || (of(name)?.optionLabels?.[value] ?? value)
  }
  // A field's lower and upper bounds are one range, said where the first of them is.
  const said: (string | { column: string; from?: string; to?: string })[] = []
  for (const f of plan.filters) {
    if (f.op === 'atLeast' || f.op === 'atMost') {
      let range = said.find((s) => typeof s !== 'string' && s.column === f.column) as { column: string; from?: string; to?: string } | undefined
      if (!range) said.push((range = { column: f.column }))
      if (f.op === 'atLeast') range.from = f.value
      else range.to = f.value
    } else if (f.op === 'equal') said.push(strings.queryEqual(label(f.column), shown(f.column, f.value)))
    else if (f.op === 'contains') said.push(strings.queryContains(label(f.column), f.value))
    else said.push(strings.queryEmpty(label(f.column)))
  }
  const words = said.map((s) =>
    typeof s === 'string' ? s : strings.queryBounds(label(s.column), s.from, s.to, DATE_TYPES.includes(of(s.column)?.type ?? '')),
  )
  if (words.length === 0) words.push(counted ? strings.queryAllOf(counted) : strings.queryAll)
  else if (counted) words.unshift(strings.queryOf(counted))
  if (plan.groupBy.length > 0) words.push(strings.queryBy(plan.groupBy.map(label)))
  if (plan.sum) words.push(strings.querySumOf(label(plan.sum)))
  if (plan.top) words.push(plan.sum ? strings.queryTopSum(plan.top) : strings.queryTop(plan.top))
  return words.join(' · ')
}
