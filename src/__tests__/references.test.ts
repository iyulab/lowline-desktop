import { describe, expect, it } from 'vitest'
import type { DocumentSnapshot, TemplateSnapshot } from '../projection.js'
import { namedEvidence, referenceChoices, referringDocuments, referringTable, withReferenceNames } from '../references.js'

const field = (name: string, reference?: string) => ({ name, label: name, type: 'select', multiple: false, options: [], ...(reference ? { reference } : {}) })
const customer: TemplateSnapshot = { ref: 'customer@2', fields: [field('등급')], suggest: [], schema: {} }
const inquiry: TemplateSnapshot = { ref: 'inquiry@1', fields: [field('고객', 'customer'), field('상위', 'inquiry'), field('분류')], suggest: [], schema: {} }
const doc = (path: string, id: string, template: string): DocumentSnapshot => ({ path, id, template, values: {} })
const documents = [
  doc('문서/한빛상사.md', 'c-2', 'customer@2'),
  doc('문서/가나상회.md', 'c-1', 'customer@1'), // an earlier revision's document is the template's too
  doc('문서/문의 1.md', 'q-1', 'inquiry@1'),
  doc('문서/문의 2.md', 'q-2', 'inquiry@1'),
]
const names = new Map([['customer@2', '고객']])

describe('referenceChoices', () => {
  it("offers each reference field the documents of the template it names, by name, valued by their ids", () => {
    const choices = referenceChoices(inquiry, [customer, inquiry], documents, names, {}, 'q-1')
    expect(Object.keys(choices)).toEqual(['고객', '상위'])
    expect(choices['고객']).toEqual([
      { value: 'c-1', label: '가나상회' },
      { value: 'c-2', label: '한빛상사' },
    ])
    // A document does not name itself.
    expect(choices['상위']).toEqual([{ value: 'q-2', label: '문의 2' }])
  })

  it('keeps a value that names no document in the vault, shown as missing', () => {
    const choices = referenceChoices(inquiry, [customer, inquiry], documents, names, { 고객: '3f2a1b2c-9d8e-4f00-aaaa-000000000000' })
    expect(choices['고객'].at(-1)).toEqual({ value: '3f2a1b2c-9d8e-4f00-aaaa-000000000000', label: '없는 고객 (3f2a1b2c)' })
  })

  it('has none for a template without reference fields, or none at all', () => {
    expect(referenceChoices(customer, [customer], documents, names, {})).toEqual({})
    expect(referenceChoices(undefined, [customer], documents, names, {})).toEqual({})
  })
})

describe('withReferenceNames', () => {
  const table = {
    template: 'inquiry@1',
    columns: [{ name: '고객', type: 'select' }, { name: '분류', type: 'select' }],
    rows: [
      { path: '문서/문의 1.md', values: { 고객: 'c-2', 분류: 'c-2' } },
      { path: '문서/문의 2.md', values: { 고객: '3f2a1b2c-dead', 분류: null } },
      { path: '문서/문의 3.md', values: { 고객: null, 분류: null } },
    ],
  }

  it("shows a reference field's value as the document's name, a missing one as missing, and leaves other fields", () => {
    const shown = withReferenceNames(table, inquiry, [customer, inquiry], documents, names)
    expect(shown.rows.map((r) => [r.values['고객'], r.values['분류']])).toEqual([
      ['한빛상사', 'c-2'],
      ['없는 고객 (3f2a1b2c)', null],
      [null, null],
    ])
  })

  it('is the table itself for a template without reference fields', () => {
    expect(withReferenceNames(table, customer, [customer], documents, names)).toBe(table)
  })
})

describe('referringDocuments', () => {
  const naming = (path: string, id: string, template: string, values: Record<string, unknown>, modified: number): DocumentSnapshot => ({ path, id, template, values, modified })
  const all = [
    ...documents,
    naming('문서/문의 a.md', 'q-a', 'inquiry@1', { 고객: 'c-2' }, 1),
    naming('문서/문의 b.md', 'q-b', 'inquiry@1', { 고객: 'c-2' }, 3),
    naming('문서/문의 c.md', 'q-c', 'inquiry@1', { 고객: 'c-1' }, 2),
    naming('문서/문의 d.md', 'q-d', 'inquiry@1', { 분류: 'c-2' }, 4), // not a reference field
  ]

  it('lists the documents naming one, by template, the newest first', () => {
    expect(referringDocuments('c-2', 'customer', [customer, inquiry], all)).toEqual([
      {
        template: 'inquiry@1',
        fields: ['고객'],
        documents: [
          { path: '문서/문의 b.md', name: '문의 b', values: { 고객: 'c-2' } },
          { path: '문서/문의 a.md', name: '문의 a', values: { 고객: 'c-2' } },
        ],
      },
    ])
  })

  it('lists a template that can name it with none yet, so a first one can be added', () => {
    expect(referringDocuments('c-9', 'customer', [customer, inquiry], all)).toEqual([{ template: 'inquiry@1', fields: ['고객'], documents: [] }])
  })

  it('has no template when none can name it', () => {
    expect(referringDocuments('c-9', 'nothing', [customer, inquiry], all)).toEqual([])
  })
})

describe('referringTable', () => {
  const all = [
    ...documents,
    { path: '문서/문의 a.md', id: 'q-a', template: 'inquiry@1', values: { 고객: 'c-2', 상위: 'q-1', 분류: ['장비', '설치'] }, modified: 1 },
  ]

  it('shows each document by its name, then the fields but the one naming the document, another document by its name', () => {
    const [group] = referringDocuments('c-2', 'customer', [customer, inquiry], all)
    expect(referringTable(group, inquiry, [customer, inquiry], all, names)).toEqual({
      columns: [
        { key: '$path', label: '이름' },
        { key: '상위', label: '상위' },
        { key: '분류', label: '분류' },
      ],
      rows: [{ id: '문서/문의 a.md', cells: { $path: '문의 a', 상위: '문의 1', 분류: '장비, 설치' } }],
    })
  })
})

describe('namedEvidence', () => {
  it("shows a document-naming field's value as the document's name", () => {
    expect(namedEvidence('고객: c-2', inquiry, [customer, inquiry], documents, names)).toBe('고객: 한빛상사')
    expect(namedEvidence('고객: 3f2a1b2c-dead', inquiry, [customer, inquiry], documents, names)).toBe('고객: 없는 고객 (3f2a1b2c)')
  })

  it('leaves any other evidence as it is', () => {
    expect(namedEvidence('분류: c-2', inquiry, [customer, inquiry], documents, names)).toBe('분류: c-2')
    expect(namedEvidence('문서/문의 1.md', inquiry, [customer, inquiry], documents, names)).toBe('문서/문의 1.md')
  })
})
