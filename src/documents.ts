// Templates and documents as text. A template is a Formdown file whose front matter carries
// its `id` and `version`. A document is a copy of the template body whose front matter records
// which template it came from (`template: <id>@<version>`), its own id (`lowline.id`, see
// `identity.ts`) and the value of each field. `template` and `lowline` are not field values.

import { formatOptions, parseFormdown, parseOptionList, readFrontMatter, setFieldAttribute, updateFrontMatter } from '@formdown/core'
import { templateId } from './template-revision.js'

/** A field's value: text, a list of texts (checkbox group), or a boolean (single checkbox). */
export type FieldValue = string | string[] | boolean
export type FieldValues = Record<string, FieldValue>

export interface TemplateInfo {
  id: string
  version: string
  /** `<id>@<version>`, as written in a document's `template` key. */
  ref: string
}

export class TemplateError extends Error {}

/** Front matter keys a document uses for itself, not for field values. */
const RESERVED_KEYS = ['template', 'lowline']

/** Reads a template's identity from its front matter. There is no fallback: no id, no template. */
export function templateInfo(source: string): TemplateInfo {
  const data = readFrontMatter(source)?.frontMatter.data ?? {}
  const id = data.id
  const version = data.version
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TemplateError('missing-id')
  }
  if ((typeof version !== 'string' && typeof version !== 'number') || String(version).trim() === '') {
    throw new TemplateError('missing-version')
  }
  if (/[@\s]/.test(id)) {
    throw new TemplateError('invalid-id')
  }
  // A document keeps these beside its values in front matter: a field of the same name would overwrite them.
  if (parseFormdown(source).forms.some((f) => RESERVED_KEYS.includes(f.name))) {
    throw new TemplateError('reserved-field')
  }
  return { id, version: String(version), ref: `${id}@${version}` }
}

/** The template text after its front matter, byte for byte. */
export function templateBody(source: string): string {
  const span = readFrontMatter(source)?.frontMatter.span
  if (!span) return source
  return source.slice(span.end).replace(/^\r?\n/, '')
}

/**
 * Front matter changes that record `values`; empty text or an empty list removes its key.
 * A boolean is always recorded — an unchecked box is `false`, not a missing value.
 */
function valueChanges(values: FieldValues): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const empty = Array.isArray(value) ? value.length === 0 : value === ''
    changes[name] = empty ? undefined : value
  }
  return changes
}

/**
 * Field values from front matter or form data. Text, lists and booleans keep their type — a
 * checkbox written as text ("true") would read back as a different value. Other scalars
 * (numbers, dates) are read as text; missing values are dropped.
 */
export function fieldValues(data: Record<string, unknown>): FieldValues {
  const values: FieldValues = {}
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean') values[name] = value
    else if (Array.isArray(value)) values[name] = value.map(String)
    else values[name] = String(value)
  }
  return values
}

/** A field left empty: no value, empty text, or no item picked. */
export function isEmpty(value: FieldValues[string] | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

/** A saved value, as the vault's front matter holds it (a key written empty reads as null). */
export function holdsValue(value: unknown): boolean {
  return value !== undefined && value !== null && !isEmpty(value as FieldValues[string])
}

/**
 * A new document filled in from `templateSource`, named by `id`. `proposed` marks values a person has not decided —
 * judgment field → who wrote it — under `lowline.proposed`, so they are suggested in the field and not learned from
 * until a person settles them; a field it names that holds no value is not marked.
 */
export function newDocument(templateSource: string, values: FieldValues, id: string, proposed: Record<string, string> = {}): string {
  const { ref } = templateInfo(templateSource)
  const marked = Object.fromEntries(Object.entries(proposed).filter(([field]) => holdsValue(values[field])))
  const lowline = Object.keys(marked).length > 0 ? { id, proposed: marked } : { id }
  return updateFrontMatter(templateBody(templateSource), { template: ref, lowline, ...valueChanges(values) })
}

/**
 * A document moved to its template's revision now: its front matter stays as it is — every value it holds,
 * one in a field the revision no longer has included — naming the revision, above the revision's body. The
 * document is still the same document: it keeps its id and what it confirmed.
 */
export function reviseDocument(documentSource: string, templateSource: string): string {
  const { ref } = templateInfo(templateSource)
  return updateFrontMatter(withTemplateBody(documentSource, templateSource), { template: ref })
}

/** A document's front matter, as it is, above `templateSource`'s body. */
export function withTemplateBody(documentSource: string, templateSource: string): string {
  const span = readFrontMatter(documentSource)?.frontMatter.span
  const newline = documentSource.includes('\r\n') ? '\r\n' : '\n'
  const body = templateBody(templateSource)
  return span ? documentSource.slice(0, span.end) + newline + body : body
}

/**
 * Whether a document's body has fields to fill. A document is a copy of its template's body, but one another
 * program wrote may carry its front matter alone.
 */
export function hasFields(documentSource: string): boolean {
  return parseFormdown(documentSource).forms.length > 0
}

/** Gives a document the id `id`; other keys under `lowline`, and the rest of the file, stay as they are. */
export function setDocumentId(documentSource: string, id: string): string {
  const lowline = readFrontMatter(documentSource)?.frontMatter.data.lowline
  const rest = typeof lowline === 'object' && lowline !== null && !Array.isArray(lowline) ? lowline : {}
  return updateFrontMatter(documentSource, { lowline: { ...rest, id } })
}

/** Records new field values in an existing document; the body stays as it is. */
export function updateDocument(documentSource: string, values: FieldValues): string {
  return updateFrontMatter(documentSource, valueChanges(values))
}

/**
 * A document's template reference, id and values, read from its front matter alone — and `proposed`, the judgment fields
 * whose value another program wrote as a suggestion rather than a person's decision (`lowline.proposed`: field → who
 * wrote it, shown to the person; empty when not said). A value under it is not learned from until a person settles it.
 */
export function documentFrontMatter(documentSource: string): {
  template?: string
  id?: string
  values: Record<string, unknown>
  proposed?: Record<string, string>
} {
  const { template, lowline, ...values } = readFrontMatter(documentSource)?.frontMatter.data ?? {}
  const own = typeof lowline === 'object' && lowline !== null && !Array.isArray(lowline) ? (lowline as Record<string, unknown>) : {}
  const id = own.id
  const proposed = proposedOf(own.proposed)
  return {
    ...(typeof template === 'string' ? { template } : {}),
    ...(typeof id === 'string' && id ? { id } : {}),
    values,
    ...(proposed ? { proposed } : {}),
  }
}

/**
 * Takes the marks off `fields` under `lowline.proposed` — values a person has now decided — dropping the key once none
 * is left. Other keys under `lowline`, and the rest of the file, stay as they are.
 */
export function settleProposed(documentSource: string, fields: readonly string[]): string {
  const lowline = readFrontMatter(documentSource)?.frontMatter.data.lowline
  if (typeof lowline !== 'object' || lowline === null || Array.isArray(lowline)) return documentSource
  const { proposed, ...rest } = lowline as Record<string, unknown>
  if (typeof proposed !== 'object' || proposed === null || Array.isArray(proposed)) return documentSource
  const left = Object.fromEntries(Object.entries(proposed).filter(([field]) => !fields.includes(field)))
  if (Object.keys(left).length === Object.keys(proposed).length) return documentSource
  const next = Object.keys(left).length > 0 ? { ...rest, proposed: left } : rest
  return updateFrontMatter(documentSource, { lowline: Object.keys(next).length > 0 ? next : undefined })
}

/** `lowline.proposed` as field → who wrote it: a name that is not text reads as unsaid; anything but a map, as none. */
function proposedOf(marks: unknown): Record<string, string> | undefined {
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) return undefined
  const proposed: Record<string, string> = {}
  for (const [field, by] of Object.entries(marks)) proposed[field] = typeof by === 'string' ? by.trim() : ''
  return Object.keys(proposed).length > 0 ? proposed : undefined
}

/**
 * The value that names a document: the first field, in template order, holding text.
 * Choice fields (select, radio, checkbox) are skipped — "high" names nothing.
 */
export function documentTitle(source: string, values: FieldValues): string | undefined {
  for (const field of parseFormdown(source).forms) {
    if (['select', 'radio', 'checkbox'].includes(field.type)) continue
    const value = values[field.name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/**
 * A file name for a new document: the date, then the first field value that reads as a
 * title. Characters that are not allowed in file names are replaced.
 */
export function documentFileName(date: Date, title: string | undefined): string {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  const cleaned = fileNameTitle(title ?? '')
  return cleaned ? `${day}-${cleaned}.md` : `${day}.md`
}

/**
 * A title as a new document's file name holds it, after its day: characters a file name cannot hold become spaces,
 * runs of space one, and it is cut to 60 characters, without a dot or space at its end.
 */
export function fileNameTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '')
}

/** The name a file is shown by (R-1): its file name, without `suffix`. */
export function fileName(path: string, suffix: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith(suffix) ? base.slice(0, -suffix.length) : base
}

/**
 * The file name for a name a person typed — what the lists show a document or template by (R-1) —
 * with `suffix` after it, or `null` when it cannot be one: empty, or holding a character a file name
 * cannot.
 */
export function fileNameFor(name: string, suffix: string): string | null {
  const trimmed = name.trim().replace(/[. ]+$/, '')
  if (!trimmed || /[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)) return null
  return `${trimmed}${suffix}`
}

/**
 * Turns suggestions on or off for one field of a template, on the field itself: Formdown's `suggest:role=judged`
 * (any tool that reads Formdown reads it), and no `suggest:policy=off`. The field leaves the front matter's
 * `lowline.suggest`, where templates written before kept the choice, so it is said in one place; other names and keys
 * under `lowline`, and everything else in the file, are left as they are.
 */
export function setSuggest(templateSource: string, field: string, on: boolean): string {
  let source = setFieldAttribute(templateSource, field, 'suggest:role', on ? 'judged' : undefined)
  const policy = parseFormdown(source).forms.find((f) => f.name === field)?.suggest?.policy
  if (on && policy === 'off') source = setFieldAttribute(source, field, 'suggest:policy', undefined)
  const data = readFrontMatter(source)?.frontMatter.data ?? {}
  const lowline = typeof data.lowline === 'object' && data.lowline !== null && !Array.isArray(data.lowline) ? (data.lowline as Record<string, unknown>) : {}
  if (!Array.isArray(lowline.suggest) || !lowline.suggest.includes(field)) return source
  const suggest = lowline.suggest.filter((n) => n !== field)
  const { suggest: _, ...rest } = lowline
  const next = suggest.length > 0 ? { ...rest, suggest } : rest
  return updateFrontMatter(source, { lowline: Object.keys(next).length > 0 ? next : undefined })
}

/** A choice field's options as the options box shows them and reads them back: `value=Label`, comma-separated. */
export function optionsText(options: readonly { value: string; label?: string }[]): string {
  return formatOptions(options).replace(/(?<!\\),/g, ', ')
}

/**
 * Writes a choice field's options, as typed (`value=Label` or a value, comma-separated — Formdown's option
 * list), into its place in the source — or nothing (`undefined`) when there is nothing to write: no option
 * typed (a field keeps at least one), the options it already has, or no such field. The options are shown
 * without the field's "other" choice, so one written among them (`{a,b,*}`, `options="a,*(직접 입력)"`) is
 * written back with them; one written as its own `allow-other` attribute is left where it is.
 */
export function setOptions(templateSource: string, field: string, typed: string): string | undefined {
  const target = parseFormdown(templateSource).forms.find((f) => f.name === field)
  if (!target) return undefined
  const options = parseOptionList(typed).options
  const written = formatOptions(options)
  if (options.length === 0 || written === formatOptions(target.options ?? [])) return undefined
  const next = setFieldAttribute(templateSource, field, 'options', written)
  if (!target.allowOther || parseFormdown(next).forms.find((f) => f.name === field)?.allowOther) return next
  const other = target.otherLabel ? `*(${target.otherLabel})` : '*'
  return setFieldAttribute(templateSource, field, 'options', `${written},${other}`)
}

/**
 * What stands in the way of a template working as written, in the order a person would fix it: front matter
 * that cannot be read (the template has no identity then), a field name used twice (a document keeps one
 * value under it, so both fields hold the same), a condition that names no field of the template (it never
 * sees a value, so it decides the same way for every document — a `visible-if` keeps its field hidden), a computed
 * value that cannot be read or reads no field of the template (it never has a value), and a `lowline.suggest` name
 * that is not a field (nothing is suggested for it).
 */
export type TemplateProblem =
  | { kind: 'front-matter'; detail: string }
  | { kind: 'duplicate-field'; name: string; lines: number[] }
  | { kind: 'unknown-condition'; field: string; name: string }
  | { kind: 'invalid-condition'; field: string }
  | { kind: 'unknown-compute'; field: string; name: string }
  | { kind: 'invalid-compute'; field: string }
  | { kind: 'unrecognized-field'; name: string; line?: number; fix?: SourceFix }
  | { kind: 'unknown-suggest'; name: string }
  | { kind: 'stray-values'; name: string; count: number }
  | { kind: 'shared-id'; id: string; names: string[] }
  | { kind: 'unknown-reference'; field: string; target: string }
  | { kind: 'many-to-many'; field: string; target: string }

/**
 * Fields the template's documents hold values in that its source does not have — a field renamed or
 * removed there. The values stay in the files, but the table and suggestions no longer see them. Each
 * with how many documents hold a value in it, most first. A source that cannot be read has none.
 */
export function strayFields(
  source: string,
  documents: readonly { template: string; values: Record<string, unknown> }[],
): Extract<TemplateProblem, { kind: 'stray-values' }>[] {
  let ref: string
  try {
    ref = templateInfo(source).ref
  } catch {
    return []
  }
  const names = new Set(parseFormdown(source).forms.map((f) => f.name))
  const counts = new Map<string, number>()
  for (const document of documents) {
    // A document of any revision is the template's (template-revision.ts).
    if (templateId(document.template) !== templateId(ref)) continue
    for (const [name, value] of Object.entries(document.values)) {
      const held = value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
      if (held && !names.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return [...counts]
    .sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
    .map(([name, count]) => ({ kind: 'stray-values', name, count }))
}

/**
 * Other template files with this template's id: a template's revisions are one template, so two files with
 * one id make the vault read one of them as the template (the later revision) and the other as nothing.
 */
export function sharedId(source: string, path: string, templates: readonly { ref: string; path: string; name: string }[]): TemplateProblem[] {
  let id: string
  try {
    id = templateInfo(source).id
  } catch {
    return []
  }
  const names = templates.filter((t) => t.path !== path && templateId(t.ref) === id).map((t) => t.name)
  return names.length ? [{ kind: 'shared-id', id, names }] : []
}

/**
 * Fields that refer to another template's documents and cannot: the template they name is not in the vault
 * (a template refers to its own documents too), or they name many (`<->`), which is not read yet — such a
 * field is the type it is written as.
 */
export function referenceProblems(source: string, templates: readonly { ref: string }[]): TemplateProblem[] {
  const present = new Set(templates.map((t) => templateId(t.ref)))
  try {
    present.add(templateInfo(source).id)
  } catch {
    // A template that cannot be read has no id of its own to refer to.
  }
  const problems: TemplateProblem[] = []
  for (const field of parseFormdown(source).forms) {
    const relation = field.relation
    if (!relation) continue
    if (relation.type === 'many-to-many') problems.push({ kind: 'many-to-many', field: field.name, target: relation.target })
    else if (!present.has(relation.target)) problems.push({ kind: 'unknown-reference', field: field.name, target: relation.target })
  }
  return problems
}

/** Text that, put in place of the source from `start` to `end`, makes it what it looks meant to be. */
export interface SourceFix {
  text: string
  start: number
  end: number
}

export function templateProblems(source: string): TemplateProblem[] {
  const parsed = parseFormdown(source)
  const problems: TemplateProblem[] = (parsed.diagnostics ?? [])
    .filter((d) => d.code.startsWith('front-matter-') && d.severity === 'error')
    .map((d) => ({ kind: 'front-matter', detail: d.message }))
  const names = parsed.forms.map((f) => f.name)
  // The parser says where each repeat of a name is (the lines of the source, front matter included).
  const repeats = new Map<string, number[]>()
  for (const d of parsed.diagnostics ?? []) {
    if (d.code !== 'duplicate-field-name' || d.field === undefined) continue
    repeats.set(d.field, [...(repeats.get(d.field) ?? []), ...(d.span ? [d.span.line] : [])])
  }
  for (const [name, lines] of repeats) problems.push({ kind: 'duplicate-field', name, lines })
  // What the parser could not read or resolve: a condition naming no field of the form, a condition that is not
  // one, a line shaped like a field that is not.
  for (const d of parsed.diagnostics ?? []) {
    if (d.code === 'condition-unknown-field' && d.field !== undefined && d.related !== undefined) {
      problems.push({ kind: 'unknown-condition', field: d.field, name: d.related })
    }
    if (d.code === 'invalid-condition' && d.field !== undefined) problems.push({ kind: 'invalid-condition', field: d.field })
    if (d.code === 'compute-unknown-field' && d.field !== undefined && d.related !== undefined) {
      problems.push({ kind: 'unknown-compute', field: d.field, name: d.related })
    }
    if (d.code === 'invalid-compute' && d.field !== undefined) problems.push({ kind: 'invalid-compute', field: d.field })
    if (d.code === 'unrecognized-field' && d.field !== undefined)
      problems.push({
        kind: 'unrecognized-field',
        name: d.field,
        line: d.span?.line,
        ...(d.fix !== undefined && d.span && { fix: { text: d.fix, start: d.span.start, end: d.span.end } }),
      })
  }
  const lowline = parsed.frontMatter?.data.lowline
  const suggest = typeof lowline === 'object' && lowline !== null ? (lowline as { suggest?: unknown }).suggest : undefined
  for (const name of Array.isArray(suggest) ? suggest : []) {
    if (!names.includes(String(name))) problems.push({ kind: 'unknown-suggest', name: String(name) })
  }
  return problems
}
