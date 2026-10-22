// What the reference fields cost each time a view draws, in a vault of 10,000 documents: 1,000 customers and
// 9,000 inquiries that name one each, plus an inquiry field naming another inquiry. The document view offers
// the choices and lists who names the open customer; the table offers the choices as a filter and shows each
// row's names. Runs only with LOWLINE_PERF=1.
import { describe, expect, it } from 'vitest'
import type { DocumentSnapshot, TemplateSnapshot } from '../projection.js'
import { referenceChoices, referringDocuments, withReferenceNames } from '../references.js'

const field = (name: string, reference?: string) => ({ name, label: name, type: 'select', multiple: false, options: [], ...(reference ? { reference } : {}) })
const customer: TemplateSnapshot = { ref: 'customer@1', fields: [field('등급')], suggest: [], schema: {} }
const inquiry: TemplateSnapshot = { ref: 'inquiry@1', fields: [field('고객', 'customer'), field('상위', 'inquiry'), field('분류')], suggest: [], schema: {} }
const templates = [customer, inquiry]
const names = new Map([['customer@1', '고객'], ['inquiry@1', '문의']])

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

function time(run: () => unknown, times = 5) {
  run() // warm
  const started = performance.now()
  for (let i = 0; i < times; i++) run()
  return Math.round((performance.now() - started) / times)
}

describe.runIf(env.LOWLINE_PERF === '1')('reference fields', () => {
  it('cost per draw at 10,000 documents', { timeout: 120_000 }, () => {
    const customers: DocumentSnapshot[] = Array.from({ length: 1_000 }, (_, i) => ({
      path: `문서/고객 ${i}.md`, id: `c-${i}`, template: 'customer@1', values: { 등급: 'A' }, modified: i,
    }))
    const inquiries: DocumentSnapshot[] = Array.from({ length: 9_000 }, (_, i) => ({
      path: `문서/문의 ${i}.md`, id: `q-${i}`, template: 'inquiry@1', values: { 고객: `c-${i % 1_000}`, 분류: '장비' }, modified: i,
    }))
    const documents = [...customers, ...inquiries]
    const table = { template: 'inquiry@1', columns: [], rows: inquiries.map((d) => ({ path: d.path, values: d.values })) }

    const choices = time(() => referenceChoices(inquiry, templates, documents, names, { 고객: 'c-1' }, 'q-1'))
    const referring = time(() => referringDocuments('c-1', 'customer', templates, documents))
    const named = time(() => withReferenceNames(table, inquiry, templates, documents, names))

    expect(referenceChoices(inquiry, templates, documents, names, {})['고객']).toHaveLength(1_000)
    expect(referringDocuments('c-1', 'customer', templates, documents)[0].documents).toHaveLength(9)
    console.log(`10000 docs · reference choices ${choices} ms · referring ${referring} ms · table names ${named} ms (each per draw)`)
  })
})
