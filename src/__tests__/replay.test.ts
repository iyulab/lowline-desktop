// Records someone already keeps, played back through the app before anyone uses it: a template and the rows a
// person would paste into it (`template.md` and `rows.tsv` — the first row naming the columns, one column the day
// each record was made) in the directory `LOWLINE_REPLAY` names. The rows are brought in the way the app brings
// them in; the first `LOWLINE_REPLAY_BROUGHT_IN_WEEKS` weeks of them all at the start, as a person who imports
// their history would, the rest one by one on the day they were made. The sidecar is asked about each later
// record field by field and the record saved with what it says (`ReplayTests.cs`); what was offered becomes the
// events a save records, and those the weekly counts a person would hand over. Everything is written to
// `LOWLINE_REPLAY_OUT` (default: a folder in the temp directory) — the rows never leave this machine, only what
// the counts say. Records that name documents of another template (`@업소 -> food-business`) come with that template
// and its rows in `base/`, in the same shape: those are brought in first and whole, as a person brings in their
// businesses before the inspections that name them, and the records' reference cells are resolved to them the way
// the app resolves pasted names. Runs only when `LOWLINE_REPLAY` is set; needs `dotnet`.
import { describe, expect, it } from 'vitest'
import { documentFileName, documentTitle, newDocument, type FieldValues } from '../documents.js'
import { charactersTyped, presentation, suggestionEvents, type Offer, type Presentation, type SuggestionEvent } from '../events.js'
import { importFields, planImport } from '../import.js'
import { documentSnapshot, templateSnapshot, type DocumentSnapshot, type Suggestion } from '../projection.js'
import { documentNames } from '../references.js'
import { templateId } from '../template-revision.js'
import type { WeeklyCountsReport } from '../weekly-counts.js'

interface NodeProcess {
  env: Record<string, string | undefined>
  getBuiltinModule(name: 'node:fs'): {
    readFileSync(path: string, encoding: 'utf8'): string
    writeFileSync(path: string, text: string): void
    mkdirSync(path: string, options: { recursive: true }): void
    existsSync(path: string): boolean
  }
  getBuiltinModule(name: 'node:child_process'): {
    execFileSync(file: string, args: string[], options: { env: Record<string, string | undefined>; stdio: 'inherit'; timeout: number }): void
  }
}
const process = (globalThis as { process?: NodeProcess }).process
const env = process?.env ?? {}

/** The Monday of the week `ms` falls in, in this device's time, as `YYYY-MM-DD` — as the counts write a week. */
function weekOf(ms: number): string {
  const at = new Date(ms)
  const monday = new Date(at.getFullYear(), at.getMonth(), at.getDate() - ((at.getDay() + 6) % 7)) // getDay: 0 = Sunday
  return [monday.getFullYear(), String(monday.getMonth() + 1).padStart(2, '0'), String(monday.getDate()).padStart(2, '0')].join('-')
}

/** One line the sidecar's side writes: what was offered for a field, and the fields filled when it was asked. */
interface Offered {
  doc: string
  field: string
  suggestion: Suggestion
  filled: string[]
  /** What had been typed when it was shown; null before typing. */
  typed: string | null
  /** The precision the field's replay promised for it; null when nothing was offered or nothing was promised. */
  promised: number | null
}

const DAY = 24 * 60 * 60 * 1000

describe.runIf(env.LOWLINE_REPLAY)('records played back through the app', () => {
  it('brings them in, offers what it would, and counts what was done with it by the week', { timeout: 60 * 60_000 }, () => {
    const fs = process!.getBuiltinModule('node:fs')
    const { execFileSync } = process!.getBuiltinModule('node:child_process')
    const source = env.LOWLINE_REPLAY!
    const out = env.LOWLINE_REPLAY_OUT ?? `${env.TEMP ?? env.TMPDIR ?? '.'}/lowline-replay`
    const broughtInWeeks = Number(env.LOWLINE_REPLAY_BROUGHT_IN_WEEKS ?? 0)
    fs.mkdirSync(out, { recursive: true })

    // Brought in as the app brings in pasted rows.
    const rowsIn = (dir: string) =>
      fs
        .readFileSync(`${dir}/rows.tsv`, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => line.split('\t'))
    // Named as the app names them — by the record's day and its first value, numbered when the name is taken.
    const named = (taken: Set<string>, day: Date, title: string | undefined) => {
      let name = documentFileName(day, title)
      for (let n = 1; taken.has(name); n++) name = name.replace(/( \(\d+\))?\.md$/, ` (${n}).md`)
      taken.add(name)
      return name
    }
    // The documents the records refer to, if any: planned and named first, for the records' cells to name them.
    const baseSource = fs.existsSync(`${source}/base/template.md`) ? fs.readFileSync(`${source}/base/template.md`, 'utf8') : undefined
    const base = baseSource ? templateSnapshot(baseSource) : undefined
    const basePlan = baseSource ? planImport(rowsIn(`${source}/base`), importFields(baseSource)) : undefined
    expect(basePlan?.problems ?? [], 'every row of the documents referred to fits their form').toEqual([])
    const baseTaken = new Set<string>()
    const baseNamed = (basePlan?.documents ?? []).map((record, i) => ({
      record,
      id: `base-${i}`,
      path: `문서/${named(baseTaken, record.date ?? new Date(0), documentTitle(baseSource!, record.values))}`,
    }))
    const names = documentNames(baseNamed.map((b) => ({ path: b.path, id: b.id, template: base!.ref, values: {} })))

    const templateSource = fs.readFileSync(`${source}/template.md`, 'utf8')
    const template = templateSnapshot(templateSource)
    const rows = rowsIn(source)
    const plan = planImport(rows, importFields(templateSource), undefined, names)
    expect(plan.problems, 'every row fits the form, and names one document of each template it refers to').toEqual([])
    expect(plan.documents.length).toBe(rows.length - 1)
    expect(plan.documents.every((r) => r.date), 'every record has its day').toBe(true)

    // Made in office hours on its day, half an hour apart; the history brought in all at once, just before the rest.
    const perDay = new Map<number, number>()
    const made = plan.documents.map((r) => {
      const day = r.date!.getTime()
      const nth = perDay.get(day) ?? 0
      perDay.set(day, nth + 1)
      return day + 9 * 60 * 60 * 1000 + nth * 30 * 60 * 1000
    })
    const firstWeek = Date.parse(weekOf(made[0]))
    const broughtIn = made.filter((at) => at < firstWeek + broughtInWeeks * 7 * DAY).length
    const importedAt = (made[broughtIn] ?? made[made.length - 1]) - 60 * 60 * 1000
    const taken = new Set<string>()
    const documents: DocumentSnapshot[] = plan.documents.map((record, i) => {
      const name = named(taken, record.date!, documentTitle(templateSource, record.values))
      return documentSnapshot(`문서/${name}`, newDocument(templateSource, record.values, `replay-${i}`), i < broughtIn ? importedAt + i : made[i])!
    })
    // The documents referred to were there before any record: brought in all at once, just before the rest.
    const baseDocuments: DocumentSnapshot[] = baseNamed.map(
      (b, i) => documentSnapshot(b.path, newDocument(baseSource!, b.record.values, b.id), Math.min(importedAt, made[0]) - 60 * 60 * 1000 + i)!,
    )
    const baseIds = new Set(baseDocuments.map((d) => d.id))
    // Documents brought in for the records to refer to are referred to: the form reads its reference field.
    if (base) expect(template.fields.some((f) => f.reference === templateId(base.ref)), `${template.ref} refers to ${base.ref}`).toBe(true)
    for (const field of template.fields.filter((f) => f.reference))
      expect(documents.every((d) => baseIds.has(String(d.values[field.name]))), `every record's ${field.name} names a document referred to`).toBe(true)
    const templates = base ? [base, template] : [template]
    const snapshot = `${out}/snapshot.json`
    fs.writeFileSync(snapshot, JSON.stringify({ templates, documents: [...baseDocuments, ...documents], broughtIn: baseDocuments.length + broughtIn }))

    // Asked and saved one by one, on the sidecar's side.
    const offersFile = `${out}/offers.jsonl`
    fs.writeFileSync(`${out}/measurement.txt`, '')
    execFileSync('dotnet', ['test', '--project', 'src-host/Lowline.Host.Tests', '--', '--filter-method', '*Replays_records_in_the_order_they_were_made'], {
      env: { ...env, LOWLINE_REPLAY_SNAPSHOT: snapshot, LOWLINE_REPLAY_OFFERS: offersFile, LOWLINE_PERF_OUT: `${out}/measurement.txt` },
      stdio: 'inherit',
      timeout: 60 * 60_000,
    })
    const offered: Offered[] = fs
      .readFileSync(offersFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
    const before = offered.filter((o) => o.typed === null)
    expect(before.length, 'every judgment field of every later record asked').toBe((documents.length - broughtIn) * template.suggest.length)

    // Each save records what became of what it was offered: taken when it was the value, changed otherwise.
    const byDoc = new Map<string, Offered[]>()
    for (const o of offered) byDoc.set(o.doc, [...(byDoc.get(o.doc) ?? []), o])
    const events: SuggestionEvent[] = []
    const shown: Presentation[] = []
    documents.forEach((document, i) => {
      if (i < broughtIn) return
      const at = new Date(made[i])
      const offers = new Map<string, Offer>()
      // A class taken leaves the field open for the rest of the value: what the save says about it is kept apart, as the app keeps it.
      const classes = new Map<string, Offer>()
      for (const o of byDoc.get(document.id) ?? []) {
        if (o.suggestion.value === null) continue
        // Taken or changed the moment it showed, at what had been typed: a replay has no person to take time over it.
        const typed = charactersTyped(o.typed ?? undefined)
        const offer: Offer = { suggestion: o.suggestion, shown: at, filled: o.filled, typed, decided: at, decidedTyped: typed }
        ;(o.suggestion.mode === 'coarse' ? classes : offers).set(o.field, offer)
        shown.push(presentation(document.template, o.field, offer))
      }
      for (const kept of [classes, offers])
        events.push(...suggestionEvents(kept, new Set(), document.values as FieldValues, document.id, at, document.template))
    })
    fs.writeFileSync(`${out}/events.jsonl`, events.map((e) => JSON.stringify(e)).join('\n') + '\n')

    // Counted where the app counts them, on the sidecar's side.
    const countsIn = `${out}/weekly-counts-in.json`
    const countsOut = `${out}/weekly-counts-report.json`
    fs.writeFileSync(countsIn, JSON.stringify({ snapshot: { templates, documents: [...baseDocuments, ...documents], events }, presentations: shown }))
    execFileSync('dotnet', ['test', '--project', 'src-host/Lowline.Host.Tests', '--', '--filter-method', '*Counts_a_vault_written_to_a_file'], {
      env: { ...env, LOWLINE_WEEKLY_COUNTS_IN: countsIn, LOWLINE_WEEKLY_COUNTS_OUT: countsOut },
      stdio: 'inherit',
      timeout: 10 * 60_000,
    })
    const counts = (JSON.parse(fs.readFileSync(countsOut, 'utf8')) as WeeklyCountsReport).export
    const text = JSON.stringify(counts, null, 2)
    fs.writeFileSync(`${out}/weekly-counts.json`, text + '\n')

    // Every suggestion shown is counted once, as shown and as decided.
    const decided = counts.counts.reduce((n, c) => n + c.accepted + c.corrected + c.rejected, 0)
    const presented = counts.counts.reduce((n, c) => n + c.presented, 0)
    expect(decided).toBe(events.length)
    expect(presented).toBe(shown.length)
    expect(counts.counts.reduce((n, c) => n + Object.values(c.bySource).reduce((m, s) => m + s.decided, 0), 0)).toBe(decided)
    // Every decision and presentation here was recorded with what had been typed, so each falls in one slot.
    expect(counts.counts.reduce((n, c) => n + Object.values(c.byTyped).reduce((m, s) => m + s.decided, 0), 0)).toBe(decided)
    expect(counts.counts.reduce((n, c) => n + Object.values(c.byTyped).reduce((m, s) => m + s.presented, 0), 0)).toBe(presented)
    // Each says when it was shown and decided, so each has a time — none at all, here.
    const timed = counts.counts.flatMap((c) => Object.values(c.byTyped).flatMap((s) => (s.dwell ? [...s.dwell.accepted, ...s.dwell.other] : [])))
    expect(timed.reduce((n, k) => n + k, 0)).toBe(decided)

    // Nothing that says what the records are about: no form or field name, no value. Only the counts' words can say
    // it — their numbers are counts, and a record's amount (`18`) is told apart from them by being a word, not by
    // its digits. A number a record holds may sit inside a word (`2024-01-18`), so it counts only as a whole word.
    const words: string[] = []
    const collect = (node: unknown): void => {
      if (typeof node === 'string') words.push(node)
      else if (Array.isArray(node)) node.forEach(collect)
      else if (node && typeof node === 'object')
        for (const [key, child] of Object.entries(node)) {
          words.push(key)
          collect(child)
        }
    }
    collect(JSON.parse(text))
    const values = new Set([...baseDocuments, ...documents].flatMap((d) => Object.values(d.values).map(String)).filter((v) => v.length >= 2))
    const namesOfForms = templates.flatMap((t) => [t.ref.split('@')[0], ...t.fields.map((f) => f.name)])
    for (const secret of [...namesOfForms, ...values]) {
      const said = /^\d+(\.\d+)?$/.test(secret) ? words.includes(secret) : words.some((w) => w.includes(secret))
      expect(said, `${secret} in the counts`).toBe(false)
    }

    // The form's records a week are counted by the weeks they were made in — those brought in all at once too.
    const used = documents.length - broughtIn
    const weeks = Math.round((Date.parse(weekOf(made[made.length - 1])) - Date.parse(weekOf(made[0]))) / (7 * DAY)) + 1
    const form = counts.forms[0]
    console.log(
      `replay · ${broughtIn} brought in · ${used} made · ${documents.length} over ${weeks} weeks (${(documents.length / weeks).toFixed(2)}/week)` +
        ` · counted: ${form.confirmed} confirmed over ${form.weeks} weeks (${form.perWeek}/week) · ${events.length} decided of ${before.length} asked · ${shown.length} shown`,
    )
    // Quarter by quarter, for each field: how often a value was offered before typing and while typing, how often it
    // was the one saved, and what its replay promised when it was offered — what the app shows under the field's curve.
    const tally = () => ({ asked: 0, offered: 0, right: 0, promised: 0, promises: 0 })
    const summary: Record<
      string,
      Record<string, { before: ReturnType<typeof tally>; typing: ReturnType<typeof tally>; class: ReturnType<typeof tally>; similar: ReturnType<typeof tally> }>
    > = {}
    const start = Date.parse(weekOf(made[broughtIn]))
    for (const o of offered) {
      const i = Number(o.doc.slice('replay-'.length))
      const quarter = `q${Math.floor((Date.parse(weekOf(made[i])) - start) / (13 * 7 * DAY)) + 1}`
      const cells = ((summary[o.field] ??= {})[quarter] ??= { before: tally(), typing: tally(), class: tally(), similar: tally() })
      if (o.typed === null) cells.before.asked++
      if (o.suggestion.value === null) continue
      // A class is offered where the value is not, and a similar record's value where none settled alongside answers: each
      // is counted apart, against the asks before typing.
      const cell =
        o.suggestion.mode === 'coarse' ? cells.class : o.suggestion.mode === 'memory' ? cells.similar : cells[o.typed === null ? 'before' : 'typing']
      cell.offered++
      const saved = String(documents[i].values[o.field])
      if (o.suggestion.mode === 'coarse' ? saved.startsWith(o.suggestion.value) : o.suggestion.value === saved) cell.right++
      if (o.promised !== null) {
        cell.promised += o.promised
        cell.promises++
      }
    }
    fs.writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2) + '\n')
    // The same before typing, by the field whose value the offer rested on (its `source`, `<field>: <value>`): a promise
    // is one for the field, so keys of different worth answering under it show here apart.
    const byKey: Record<string, Record<string, Record<string, ReturnType<typeof tally>>>> = {}
    for (const o of offered) {
      if (o.typed !== null || o.suggestion.value === null || o.suggestion.mode === 'coarse') continue
      const i = Number(o.doc.slice('replay-'.length))
      const quarter = `q${Math.floor((Date.parse(weekOf(made[i])) - start) / (13 * 7 * DAY)) + 1}`
      const key = o.suggestion.mode === 'memory' ? '(similar records)' : (o.suggestion.source?.split(':')[0] ?? '-')
      const cell = (((byKey[o.field] ??= {})[key] ??= {})[quarter] ??= tally())
      cell.offered++
      if (o.suggestion.value === String(documents[i].values[o.field])) cell.right++
      if (o.promised !== null) {
        cell.promised += o.promised
        cell.promises++
      }
    }
    fs.writeFileSync(`${out}/by-key.json`, JSON.stringify(byKey, null, 2) + '\n')
    const read = (t: ReturnType<typeof tally>) =>
      `${t.offered}${t.asked ? `/${t.asked}` : ''} right ${t.offered ? Math.round((100 * t.right) / t.offered) : 0}%` +
      (t.promises ? ` (promised ${Math.round((100 * t.promised) / t.promises)}%)` : '')
    for (const field of template.suggest) {
      const quarters = Object.entries(summary[field] ?? {})
      console.log(`  ${field}: ` + quarters.map(([q, { before }]) => `${q} ${read(before)}`).join(' · '))
      if (quarters.some(([, { typing }]) => typing.offered > 0))
        console.log(`  ${field} while typing: ` + quarters.map(([q, { typing }]) => `${q} ${read(typing)}`).join(' · '))
      if (quarters.some(([, c]) => c.similar.offered > 0))
        console.log(`  ${field} from similar records: ` + quarters.map(([q, c]) => `${q} ${read(c.similar)}`).join(' · '))
      if (quarters.some(([, c]) => c.class.offered > 0))
        console.log(`  ${field} class: ` + quarters.map(([q, c]) => `${q} ${read(c.class)}`).join(' · '))
    }
    expect(form).toEqual({ form: 1, confirmed: documents.length, outside: 0, weeks, perWeek: Math.round((documents.length / weeks) * 100) / 100 })
  })
})
