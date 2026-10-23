import { describe, expect, it } from 'vitest'
import { cellText, documentSnapshot, referenceTargets, templateSnapshot } from '../projection.js'
import { newDocument } from '../documents.js'

const template = `---
id: bug-report
version: 2
lowline:
  suggest: [심각도, 없는칸]
---
# 버그 리포트

제목: ___@제목

@심각도: [select options="낮음,높음"]

@재현됨: [checkbox]

@재현_절차: [textarea]

@태그: [checkbox options="UI,저장"]
`

describe('templateSnapshot', () => {
  it('lists the fields in template order with their types', () => {
    const { schema: _, ...snapshot } = templateSnapshot(template)
    expect(snapshot).toEqual({
      ref: 'bug-report@2',
      fields: [
        { name: '제목', label: '제목', type: 'text', multiple: false, options: [] },
        { name: '심각도', label: '심각도', type: 'select', multiple: false, options: ['낮음', '높음'] },
        { name: '재현됨', label: '재현됨', type: 'checkbox', multiple: false, options: [] },
        { name: '재현_절차', label: '재현 절차', type: 'textarea', multiple: false, options: [] },
        { name: '태그', label: '태그', type: 'checkbox', multiple: true, options: ['UI', '저장'] },
      ],
      suggest: ['심각도'],
    })
  })

  it('lists a field whose name is used twice once, as it first appears — a document holds one value per name', () => {
    const twice = template.replace('@재현됨: [checkbox]', '@심각도: [text]')
    const fields = templateSnapshot(twice).fields
    expect(fields.map((f) => f.name)).toEqual(['제목', '심각도', '재현_절차', '태그'])
    expect(fields[1].type).toBe('select')
    expect(templateSnapshot(twice).suggest).toEqual(['심각도'])
  })

  it("carries formdown's schema of exactly the fields it lists, in their order — what the sidecar declares columns from", () => {
    const twice = template.replace('@재현됨: [checkbox]', '@심각도: [text]')
    const { fields, schema } = templateSnapshot(twice)
    expect(Object.keys(schema)).toEqual(fields.map((f) => f.name))
    expect(schema['심각도']).toMatchObject({ type: 'select', options: [{ value: '낮음' }, { value: '높음' }] })
    expect(schema['재현_절차']).toMatchObject({ type: 'textarea', label: '재현 절차' })
  })

  it("carries the template a field refers to by its id, and only for a field that refers to one", () => {
    const inquiry = '---\nid: inquiry\nversion: 1\n---\n# 문의\n\n@고객 -> customer: [select]\n@태그 <-> tag: [checkbox]\n@제목: [text]\n'
    const fields = templateSnapshot(inquiry).fields
    expect(fields.map((f) => [f.name, f.reference])).toEqual([
      ['고객', 'customer'],
      // Many to many is not read yet: its field is the type it is written as.
      ['태그', undefined],
      ['제목', undefined],
    ])
  })

  it('carries option values, and the text shown for those that have one', () => {
    const { fields } = templateSnapshot('---\nid: t\nversion: 1\n---\n@분류: [select options="hw=하드웨어,sw=소프트웨어,기타"]\n@메모: [text]\n')
    expect(fields[0]).toMatchObject({ options: ['hw', 'sw', '기타'], optionLabels: { hw: '하드웨어', sw: '소프트웨어' } })
    expect(fields[1]).not.toHaveProperty('optionLabels')
  })

  it('turns suggestions on only for fields the author names', () => {
    expect(templateSnapshot(template.replace(/lowline:\n  suggest: .*\n/, '')).suggest).toEqual([])
    expect(templateSnapshot(template.replace('suggest: [심각도, 없는칸]', 'suggest: 심각도')).suggest).toEqual([])
  })

  it("turns suggestions on for a field its own Formdown attributes judge, and the field's word beats the front matter's", () => {
    const plain = template.replace(/lowline:\n  suggest: .*\n/, '')
    const attributed = (from: string, to: string, source = plain) => templateSnapshot(source.replace(from, to))
    // Said on the field alone, as a tool that knows only Formdown writes it.
    expect(attributed('[select options="낮음,높음"]', '[select options="낮음,높음" suggest:role=judged]').suggest).toEqual(['심각도'])
    expect(attributed('[select options="낮음,높음"]', '[select options="낮음,높음" suggest:role=observed]').suggest).toEqual([])
    // Listed in the front matter, but the field says it is observed, or never suggested: off.
    expect(attributed('[select options="낮음,높음"]', '[select options="낮음,높음" suggest:role=observed]', template).suggest).toEqual([])
    expect(attributed('[select options="낮음,높음"]', '[select options="낮음,높음" suggest:policy=off]', template).suggest).toEqual([])
    // An attribute that says nothing of the role leaves it to the front matter.
    expect(attributed('[select options="낮음,높음"]', '[select options="낮음,높음" suggest:evidence=false]', template).suggest).toEqual(['심각도'])
    // The front matter's names first, then the fields that only their attributes turn on.
    expect(attributed('@재현_절차: [textarea]', '@재현_절차: [textarea suggest:role=judged]', template).suggest).toEqual(['심각도', '재현_절차'])
  })

  it("carries a judgment field's class length as the field says it, before the front matter", () => {
    const own = template.replace('[select options="낮음,높음"]', '[select options="낮음,높음" suggest:coarse=2]')
    expect(templateSnapshot(own).coarse).toEqual({ 심각도: 2 })
    expect(templateSnapshot(own.replace('suggest: [심각도, 없는칸]', 'suggest: [심각도]\n  coarse: { 심각도: 1 }')).coarse).toEqual({ 심각도: 2 })
    expect(templateSnapshot(template.replace('suggest: [심각도, 없는칸]', 'suggest: [심각도]\n  coarse: { 심각도: 1 }')).coarse).toEqual({ 심각도: 1 })
  })

  it('carries how many leading characters name the class of a judgment field taking one value, and nothing else', () => {
    const coarse = (line: string) => templateSnapshot(template.replace('suggest: [심각도, 없는칸]', `suggest: [심각도, 태그]\n  coarse: ${line}`)).coarse
    expect(coarse('{ 심각도: 1 }')).toEqual({ 심각도: 1 })
    // Not a judgment field, several values, no whole number of characters, not a map: none of it counts.
    expect(coarse('{ 제목: 2, 태그: 1, 심각도: 0 }')).toBeUndefined()
    expect(coarse('{ 심각도: 1.5 }')).toBeUndefined()
    expect(coarse('{ 심각도: "2" }')).toBeUndefined()
    expect(coarse('[심각도]')).toBeUndefined()
    expect(templateSnapshot(template)).not.toHaveProperty('coarse')
  })
})

describe('documentSnapshot', () => {
  it('carries the template reference and typed values', () => {
    const doc = newDocument(template, { 제목: '멈춤', 재현됨: true, 태그: ['UI'] }, 'id-a')
    expect(documentSnapshot('문서/a.md', doc)).toEqual({
      path: '문서/a.md',
      id: 'id-a',
      template: 'bug-report@2',
      values: { 제목: '멈춤', 재현됨: true, 태그: ['UI'] },
    })
  })

  it('knows a document without an id by its path, as one the app has never saved', () => {
    expect(documentSnapshot('문서/old.md', '---\ntemplate: bug-report@2\n제목: 멈춤\n---\n')).toMatchObject({
      id: '문서/old.md',
      values: { 제목: '멈춤' },
      outside: true,
    })
  })

  it('names the fields whose value another program proposed, if they hold one', () => {
    const doc = '---\ntemplate: bug-report@2\nlowline:\n  id: id-b\n  proposed:\n    심각도: 메일 분류기\n    제목: 메일 분류기\n    재현됨: 규칙\n---\n'
    const withValues = doc.replace('---\n\n', '').replace('lowline:', '제목: 멈춤\n심각도: high\nlowline:')
    expect(documentSnapshot('문서/b.md', withValues)).toMatchObject({ id: 'id-b', proposed: ['심각도', '제목'] })
    expect(documentSnapshot('문서/b.md', doc)).not.toHaveProperty('proposed')
  })

  it('skips a file that names no template', () => {
    expect(documentSnapshot('문서/note.md', '# just a note\n')).toBeUndefined()
  })
})

describe('cellText', () => {
  it('shows values as text', () => {
    expect([cellText('a'), cellText(3), cellText(true), cellText(false), cellText(['x', 'y']), cellText(null)]).toEqual([
      'a',
      '3',
      '✓',
      '✗',
      'x, y',
      '',
    ])
  })

  it('tells a box left unchecked apart from a value never given', () => {
    expect(cellText(false)).not.toBe(cellText(undefined))
    expect(cellText(undefined)).toBe('')
  })
})

describe('referenceTargets', () => {
  const field = (name: string, reference?: string) => ({ name, label: name, type: 'select', multiple: false, options: [], ...(reference ? { reference } : {}) })
  const customer = { ref: 'customer@2', fields: [field('이름')], suggest: [], schema: {} }
  const inquiry = { ref: 'inquiry@1', fields: [field('고객', 'customer'), field('담당', 'staff')], suggest: [], schema: {} }

  it('is the templates in the vault some field refers to, by id whatever their revision', () => {
    expect([...referenceTargets([customer, inquiry])]).toEqual(['customer'])
  })

  it('has none without a field that refers to a template', () => {
    expect([...referenceTargets([customer])]).toEqual([])
  })
})
