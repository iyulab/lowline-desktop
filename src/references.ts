// Fields whose value names another document: `@고객 -> customer: [select]` holds the id of one of the
// documents of the template `customer` (its `lowline.id`, or its path when it has none — identity.ts), and
// shows it by that document's file name. The file keeps the id alone, so renaming the document changes
// nothing in the files that name it.

import { fileName, fileNameTitle, type FieldValues } from './documents.js'
import { PATH_COLUMN, cellText, type DocumentSnapshot, type ProjectionTable, type TemplateSnapshot } from './projection.js'
import { strings } from './strings.js'
import { templateId } from './template-revision.js'

/**
 * The documents reference fields name, both ways: a document's id by its name — the name a person, or a model, says it
 * by — and its name by its id, among the documents of the template a field refers to.
 */
export interface DocumentNames {
  idOf(target: string, name: string): string | undefined
  nameOf(target: string, id: string): string | undefined
}

/** The day a new document's file name starts with (`2026-10-16-가나상사`) — not part of what a person calls it. */
const NAMED_DAY = /^\d{4}-\d{2}-\d{2}-(?=.)/

/**
 * The names of `documents`, each among its own template's — as a reference field offers them. A name is a document's
 * file name; the title the app named a new document by names it too (`가나상사` for `2026-10-16-가나상사`, `A/S 센터` for
 * `2026-10-16-A S 센터`), when no document has that file name and only one was named by it.
 */
export function documentNames(documents: readonly DocumentSnapshot[]): DocumentNames {
  const names = new Map<string, string>()
  const ids = new Map<string, string>()
  const undated = new Map<string, string>()
  // Two documents of one template with one name: neither is the one a name says.
  const add = (map: Map<string, string>, key: string, id: string) => map.set(key, map.has(key) ? '' : id)
  for (const d of documents) {
    const name = fileName(d.path, '.md')
    const target = templateId(d.template)
    names.set(`${target}\n${d.id}`, name)
    add(ids, `${target}\n${name}`, d.id)
    if (NAMED_DAY.test(name)) add(undated, `${target}\n${name.replace(NAMED_DAY, '')}`, d.id)
  }
  return {
    idOf: (target, name) => {
      const key = `${target}\n${name}`
      return (ids.has(key) ? ids.get(key) : undated.get(`${target}\n${fileNameTitle(name)}`)) || undefined
    },
    nameOf: (target, id) => names.get(`${target}\n${id}`),
  }
}

/**
 * A value a reference field can take: a document's id, shown by its name — and, when the template it refers to names
 * the fields that say what a document means (`lowline.describe`), what those say.
 */
export interface ReferenceChoice {
  value: string
  label: string
  description?: string
}

/**
 * What a document's describing fields say, as one line: a field's value alone when the template names one, each as
 * `label: value` joined by ` · ` when it names more; fields left blank are left out. Undefined when none says anything.
 */
function described(document: DocumentSnapshot, template: TemplateSnapshot | undefined): string | undefined {
  const fields = (template?.describe ?? []).flatMap((name) => {
    const text = cellText(document.values[name]).trim()
    const field = template!.fields.find((f) => f.name === name)
    return text ? [{ label: field?.label ?? name, text }] : []
  })
  if (fields.length === 0) return undefined
  return (template!.describe!.length === 1 ? fields.map((f) => f.text) : fields.map((f) => `${f.label}: ${f.text}`)).join(' · ')
}

/**
 * The documents each reference field of `template` can name, by field name, in the order of their names.
 * A value the field holds that names no document in the vault is kept and shown as missing rather than
 * dropped. `self` — the document being written — is not offered for its own fields.
 */
export function referenceChoices(
  template: TemplateSnapshot | undefined,
  templates: readonly TemplateSnapshot[],
  documents: readonly DocumentSnapshot[],
  names: ReadonlyMap<string, string>,
  values: FieldValues,
  self?: string,
): Record<string, ReferenceChoice[]> {
  const choices: Record<string, ReferenceChoice[]> = {}
  for (const field of template?.fields ?? []) {
    const target = field.reference
    if (!target) continue
    const targetTemplate = templates.find((t) => templateId(t.ref) === target)
    const listed: ReferenceChoice[] = documents
      .filter((d) => templateId(d.template) === target && d.id !== self)
      .map((d) => {
        const description = described(d, targetTemplate)
        return { value: d.id, label: fileName(d.path, '.md'), ...(description ? { description } : {}) }
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'ko'))
    const value = values[field.name]
    if (typeof value === 'string' && value && !listed.some((c) => c.value === value)) {
      const ref = targetTemplate?.ref
      listed.push({ value, label: strings.missingReference((ref && names.get(ref)) || target, value) })
    }
    choices[field.name] = listed
  }
  return choices
}

/**
 * The table as people read it: each reference field's value — a document's id — as that document's name,
 * or as missing when the vault does not have it. What the table filters and sorts by stays the id.
 */
export function withReferenceNames(
  table: ProjectionTable,
  template: TemplateSnapshot | undefined,
  templates: readonly TemplateSnapshot[],
  documents: readonly DocumentSnapshot[],
  names: ReadonlyMap<string, string>,
): ProjectionTable {
  const fields = (template?.fields ?? []).filter((f) => f.reference)
  if (!fields.length) return table
  // A document is found among its own template's documents only, as the field offers them.
  const nameOf = new Map(documents.map((d) => [`${templateId(d.template)}\n${d.id}`, fileName(d.path, '.md')]))
  const shown = (target: string, value: unknown) => {
    if (typeof value !== 'string' || !value) return value
    const name = nameOf.get(`${target}\n${value}`)
    if (name !== undefined) return name
    const ref = templates.find((t) => templateId(t.ref) === target)?.ref
    return strings.missingReference((ref && names.get(ref)) || target, value)
  }
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      values: { ...row.values, ...Object.fromEntries(fields.map((f) => [f.name, shown(f.reference!, row.values[f.name])])) },
    })),
  }
}

/**
 * The documents of one template that name a document, newest first, and the template's fields that can name it —
 * `fields[0]` is the one a new document of the template is started naming it by.
 */
export interface Referring {
  template: string
  fields: string[]
  documents: { path: string; name: string; values: Record<string, unknown> }[]
}

/**
 * The documents whose reference fields name document `id` of template `target` (by id), by template in the
 * vault's order, each template's newest first — what a customer's page lists under the customer. A template whose
 * fields can name it is listed with none yet too: a first one can be added from there.
 */
export function referringDocuments(
  id: string,
  target: string,
  templates: readonly TemplateSnapshot[],
  documents: readonly DocumentSnapshot[],
): Referring[] {
  return templates.flatMap((template) => {
    const fields = template.fields.filter((f) => f.reference === target).map((f) => f.name)
    if (!fields.length) return []
    const naming = documents
      .filter((d) => templateId(d.template) === templateId(template.ref) && d.id !== id && fields.some((f) => d.values[f] === id))
      .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0) || a.path.localeCompare(b.path))
      .map((d) => ({ path: d.path, name: fileName(d.path, '.md'), values: d.values }))
    return [{ template: template.ref, fields, documents: naming }]
  })
}

/** A table of documents to show: its columns, and a row per document keyed by its path. */
export interface ShownTable {
  columns: { key: string; label: string }[]
  rows: { id: string; cells: Record<string, string> }[]
}

/**
 * The documents naming one as a table, the way the paper form's rows read under it: each by its name, then the
 * template's fields but the ones naming it — they would only say it again — a document named by its name.
 */
export function referringTable(
  referring: Referring,
  template: TemplateSnapshot | undefined,
  templates: readonly TemplateSnapshot[],
  documents: readonly DocumentSnapshot[],
  names: ReadonlyMap<string, string>,
): ShownTable {
  const fields = (template?.fields ?? []).filter((f) => !referring.fields.includes(f.name))
  const shown = withReferenceNames(
    { template: referring.template, columns: [], rows: referring.documents.map((d) => ({ path: d.path, values: d.values })) },
    template,
    templates,
    documents,
    names,
  )
  return {
    columns: [{ key: PATH_COLUMN, label: strings.referringName }, ...fields.map((f) => ({ key: f.name, label: f.label }))],
    rows: shown.rows.map((row) => ({
      id: row.path,
      cells: { [PATH_COLUMN]: fileName(row.path, '.md'), ...Object.fromEntries(fields.map((f) => [f.name, cellText(row.values[f.name])])) },
    })),
  }
}

/**
 * A suggestion's evidence as people read it. A value settled alongside another is backed by a `field: value`
 * line; when that field names a document, its value is the document's id, shown as the document's name.
 */
export function namedEvidence(
  evidence: string,
  template: TemplateSnapshot | undefined,
  templates: readonly TemplateSnapshot[],
  documents: readonly DocumentSnapshot[],
  names: ReadonlyMap<string, string>,
): string {
  const at = evidence.indexOf(': ')
  if (at < 0) return evidence
  const name = evidence.slice(0, at)
  const field = template?.fields.find((f) => f.name === name && f.reference)
  if (!field) return evidence
  const row = { path: '', values: { [name]: evidence.slice(at + 2) } }
  const shown = withReferenceNames({ template: template!.ref, columns: [], rows: [row] }, { ...template!, fields: [field] }, templates, documents, names)
  return `${name}: ${String(shown.rows[0].values[name])}`
}
