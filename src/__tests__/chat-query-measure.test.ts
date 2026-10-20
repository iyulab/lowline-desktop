// What a model on this computer made of questions asked of businesses whose inspections refer to them, judged as the app
// reads replies: each reply's plan against the plan of the reply meant. The replies come from the sidecar's side
// (`ChatQueryMeasureTests.cs`), written to the file `LOWLINE_CHAT_MEASURE` names. A measurement: it says how many plans
// were as meant and fails only when the file cannot be read. Runs only when `LOWLINE_CHAT_MEASURE` is set.
import { describe, expect, it } from 'vitest'
import { queryPlan, type ReadPlan, type ReferringCount } from '../chat-query.js'
import { templateSnapshot, type TemplateField } from '../projection.js'

interface NodeProcess {
  env: Record<string, string | undefined>
  getBuiltinModule(name: 'node:fs'): { readFileSync(path: string, encoding: 'utf8'): string }
}
const process = (globalThis as { process?: NodeProcess }).process
const env = process?.env ?? {}

interface Column {
  name: string
  type: string
  options?: string[] | null
}

/**
 * A plan as the count it makes, so two plans that answer alike compare equal: its conditions in one order, and not
 * counted by a field it keeps one value of (that makes one row, the same number). A question not counted is one,
 * whatever the reason given.
 */
const sorted = (read: ReadPlan) =>
  'plan' in read
    ? {
        ...read.plan,
        groupBy: read.plan.groupBy.filter((g) => !read.plan.filters.some((f) => f.column === g && f.op === 'equal')),
        filters: [...read.plan.filters].sort((a, b) => `${a.column}${a.op}${a.value}`.localeCompare(`${b.column}${b.op}${b.value}`)),
      }
    : 'unanswerable' in read
      ? { unanswerable: true }
      : read

interface Head {
  model: string
  template: string
  referring: { name: string; via: string[]; columns: Column[] }[]
}

describe.runIf(env.LOWLINE_CHAT_MEASURE)('replies a model on this computer made to questions of referred documents', () => {
  it('count what was asked, as often as they do', () => {
    const lines = process!.getBuiltinModule('node:fs').readFileSync(env.LOWLINE_CHAT_MEASURE!, 'utf8').split(/\r?\n/).filter(Boolean)
    const asField = (c: Column): TemplateField => ({ name: c.name, label: c.name, type: c.type, multiple: false, options: c.options ?? [] })
    const today = new Date(2026, 9, 16)
    // Each set begins with a line naming its template and the templates referring to it; its questions follow.
    let set: { model: string; name: string; fields: TemplateField[]; counts: ReferringCount[] } | undefined
    const tally = new Map<string, { meant: number; asked: number }>()
    for (const line of lines) {
      const read = JSON.parse(line) as Head | { question: string; meant: string; reply: string; ms: number }
      if ('template' in read) {
        const fields = templateSnapshot(read.template).fields
        set = {
          model: read.model,
          name: /^# (.+)$/m.exec(read.template)?.[1] ?? '',
          fields,
          counts: read.referring.map((r) => ({ ref: r.name, name: r.name, via: r.via, columns: r.columns.map(asField) })),
        }
        continue
      }
      const { question, meant: wanted, reply, ms } = read
      const plan = queryPlan(reply, set!.fields, today, undefined, set!.counts, question)
      const right = JSON.stringify(sorted(plan)) === JSON.stringify(sorted(queryPlan(wanted, set!.fields, today, undefined, set!.counts)))
      const counted = tally.get(set!.name) ?? { meant: 0, asked: 0 }
      tally.set(set!.name, { meant: counted.meant + (right ? 1 : 0), asked: counted.asked + 1 })
      console.log(`${set!.model} · ${set!.name} · ${right ? 'meant' : 'not meant'} · ${ms} ms · ${question} → ${JSON.stringify(plan)}`)
    }
    for (const [name, { meant, asked }] of tally) console.log(`${set?.model} · ${name} · ${meant}/${asked} plans as meant`)
    expect(tally.size).toBeGreaterThan(0)
  })
})
