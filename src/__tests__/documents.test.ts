import { describe, expect, it } from 'vitest'
import { parseFormdown, readFrontMatter } from '@formdown/core'
import { judgedFields } from '../projection.js'
import {
  TemplateError,
  documentFileName,
  fileName,
  fileNameFor,
  documentTitle,
  documentFrontMatter,
  settleProposed,
  fieldValues,
  newDocument,
  setDocumentId,
  optionsText,
  setOptions,
  setSuggest,
  moveSuggestToFields,
  reviseDocument,
  referenceProblems,
  sharedId,
  strayFields,
  templateBody,
  templateInfo,
  templateProblems,
  updateDocument,
  hasFields,
  withTemplateBody,
} from '../documents.js'
import { starterTemplate, strings } from '../strings.js'

const template = `---
id: bug-report
version: 1
---
# Bug report

**Title**: ___@title

@severity: [select options="low,medium,high,critical" required]

@steps: [textarea rows=6]

Expected result: ___@expected
`

describe('templateInfo', () => {
  it('reads id and version from front matter', () => {
    expect(templateInfo(template)).toEqual({ id: 'bug-report', version: '1', ref: 'bug-report@1' })
  })

  it('refuses a template without an id or version', () => {
    expect(() => templateInfo('# No front matter\n')).toThrow(TemplateError)
    expect(() => templateInfo('---\nid: a\n---\nx')).toThrow('missing-version')
    expect(() => templateInfo('---\nid: "a b"\nversion: 1\n---\nx')).toThrow('invalid-id')
  })

  it('refuses a template with a field named as a key documents keep for themselves', () => {
    expect(() => templateInfo('---\nid: a\nversion: 1\n---\n@template: []\n')).toThrow('reserved-field')
    expect(() => templateInfo('---\nid: a\nversion: 1\n---\nBy ___@lowline\n')).toThrow('reserved-field')
  })
})

describe('newDocument', () => {
  const values = {
    title: 'Editor freezes when saving: 10 MB',
    severity: 'high',
    steps: '1. Open a large file.\n2. Press Ctrl+S.',
    expected: '',
  }

  it('copies the template body and records the template and values in front matter', () => {
    const doc = newDocument(template, values, 'doc-1')
    const parsed = parseFormdown(doc)
    expect(parsed.frontMatter?.data).toEqual({
      template: 'bug-report@1',
      lowline: { id: 'doc-1' },
      title: values.title,
      severity: 'high',
      steps: values.steps,
    })
    expect(doc.endsWith(templateBody(template))).toBe(true)
    expect(parsed.forms.map((f) => f.name)).toEqual(['title', 'severity', 'steps', 'expected'])
  })

  it('binds the recorded values to the fields', () => {
    const parsed = parseFormdown(newDocument(template, values, 'doc-1'))
    const title = parsed.forms.find((f) => f.name === 'title')
    expect(title?.value).toBe(values.title)
  })

  it('keeps values that YAML would read as another type as strings', () => {
    const doc = newDocument(template, { title: 'true', severity: '007' }, 'doc-1')
    expect(documentFrontMatter(doc).values).toEqual({ title: 'true', severity: '007' })
  })
})

describe('document id', () => {
  it('is read from the front matter and is not a value', () => {
    const doc = newDocument(template, { title: 'A' }, 'doc-1')
    expect(documentFrontMatter(doc)).toEqual({ template: 'bug-report@1', id: 'doc-1', values: { title: 'A' } })
    expect(documentFrontMatter(updateDocument(doc, { title: 'B' })).id).toBe('doc-1')
  })

  it('marks values a person has not decided as suggestions of who wrote them — a field holding none, not', () => {
    const doc = newDocument(template, { title: 'A', severity: 'high' }, 'doc-1', { severity: '채팅(qwen3-default)', owner: '채팅(qwen3-default)' })
    expect(documentFrontMatter(doc)).toEqual({
      template: 'bug-report@1',
      id: 'doc-1',
      values: { title: 'A', severity: 'high' },
      proposed: { severity: '채팅(qwen3-default)' },
    })
    expect(documentFrontMatter(newDocument(template, { title: 'A' }, 'doc-1', { severity: '채팅(m)' })).proposed).toBeUndefined()
  })

  it('takes the marks off values a person decided, leaving the rest', () => {
    const doc = '---\ntemplate: bug-report@1\nseverity: high\nowner: 총무\nlowline:\n  id: doc-1\n  proposed:\n    severity: 메일 분류기\n    owner: 메일 분류기\n---\n'
    const one = settleProposed(doc, ['severity'])
    expect(documentFrontMatter(one)).toEqual({
      template: 'bug-report@1',
      id: 'doc-1',
      values: { severity: 'high', owner: '총무' },
      proposed: { owner: '메일 분류기' },
    })
    const both = settleProposed(one, ['owner'])
    expect(documentFrontMatter(both)).not.toHaveProperty('proposed')
    expect(both).not.toContain('proposed')
    expect(documentFrontMatter(both).id).toBe('doc-1')
    expect(settleProposed(doc, ['title'])).toBe(doc)
    // With nothing else under `lowline`, the key goes with the last mark.
    expect(settleProposed('---\ntemplate: t@1\na: x\nlowline:\n  proposed:\n    a: p\n---\n', ['a'])).not.toContain('lowline')
  })

  it('reads which values another program proposed, and who', () => {
    const doc = '---\ntemplate: bug-report@1\ntitle: A\nlowline:\n  id: doc-1\n  proposed:\n    severity: 메일 분류기\n    owner: 3\n---\n'
    expect(documentFrontMatter(doc)).toEqual({
      template: 'bug-report@1',
      id: 'doc-1',
      values: { title: 'A' },
      proposed: { severity: '메일 분류기', owner: '' },
    })
    expect(documentFrontMatter(doc.replace(/ {2}proposed:\n(?: {4}.*\n)+/, '  proposed: [severity]\n'))).not.toHaveProperty('proposed')
  })

  it('is set without touching the rest of the file or other keys under lowline', () => {
    const doc = '---\ntemplate: bug-report@1\nlowline:\n  note: kept\ntitle: A\n---\n# Body\n'
    const moved = setDocumentId(doc, '문서/old.md')
    expect(readFrontMatter(moved)?.frontMatter.data).toEqual({ template: 'bug-report@1', lowline: { note: 'kept', id: '문서/old.md' }, title: 'A' })
    expect(moved.endsWith('---\n# Body\n')).toBe(true)
  })
})

describe('checkbox values', () => {
  const withCheckbox = template.replace('Expected result', '@reproduced: [checkbox]\n\nExpected result')

  it('records a checkbox as a boolean, false included, and reads it back as one', () => {
    const doc = newDocument(withCheckbox, { title: 'A', reproduced: true }, 'doc-1')
    expect(documentFrontMatter(doc).values).toEqual({ title: 'A', reproduced: true })
    const unchecked = updateDocument(doc, { reproduced: false })
    expect(documentFrontMatter(unchecked).values).toEqual({ title: 'A', reproduced: false })
    expect(fieldValues(documentFrontMatter(unchecked).values)).toEqual({ title: 'A', reproduced: false })
  })
})

describe('fieldValues', () => {
  it('keeps text, lists and booleans as they are', () => {
    expect(fieldValues({ a: 'x', b: ['p', 'q'], c: true, d: false })).toEqual({ a: 'x', b: ['p', 'q'], c: true, d: false })
  })

  it('reads other scalars as text and drops missing values', () => {
    expect(fieldValues({ n: 7, when: null, gone: undefined, list: [1, 'two'] })).toEqual({ n: '7', list: ['1', 'two'] })
  })
})

describe('updateDocument', () => {
  it('changes values and leaves the body byte for byte', () => {
    const doc = newDocument(template, { title: 'First', severity: 'low' }, 'doc-1')
    const updated = updateDocument(doc, { title: 'Second', severity: '' })
    expect(documentFrontMatter(updated).values).toEqual({ title: 'Second' })
    expect(documentFrontMatter(updated).template).toBe('bug-report@1')
    expect(updated.endsWith(templateBody(template))).toBe(true)
  })

  it('keeps CRLF line endings', () => {
    const crlf = newDocument(template.replace(/\n/g, '\r\n'), { title: 'A' }, 'doc-1')
    const updated = updateDocument(crlf, { title: 'B' })
    expect(updated.includes('\n') && !/[^\r]\n/.test(updated)).toBe(true)
  })
})

describe('documentFileName', () => {
  const day = new Date(2026, 8, 28)

  it('starts with the date and uses the title', () => {
    expect(documentFileName(day, 'Editor freezes')).toBe('2026-09-28-Editor freezes.md')
    expect(documentFileName(day, undefined)).toBe('2026-09-28.md')
  })

  it('replaces characters that are not allowed in file names', () => {
    expect(documentFileName(day, 'a/b:c*?"<>|d. ')).toBe('2026-09-28-a b c d.md')
  })
})

describe('documentTitle', () => {
  it('uses the first text field in template order and skips choices', () => {
    expect(documentTitle(template, { severity: 'high', expected: 'Saves', title: 'Freeze' })).toBe('Freeze')
    expect(documentTitle(template, { severity: 'high', expected: 'Saves' })).toBe('Saves')
    expect(documentTitle(template, { severity: 'high' })).toBeUndefined()
  })
})

describe('starterTemplate', () => {
  it('is a template whose fields are labelled in Korean', () => {
    const source = starterTemplate('t1')
    expect(templateInfo(source).ref).toBe('t1@1')
    expect(parseFormdown(source).forms.map((f) => [f.name, f.label])).toEqual([
      ['제목', '제목'],
      ['상태', '상태'],
      ['메모', '메모'],
    ])
  })

  it('names new documents after its title field', () => {
    const source = starterTemplate('t1')
    expect(documentTitle(source, { 상태: '열림', 제목: '첫 기록' })).toBe('첫 기록')
  })
})

describe('setOptions', () => {
  const field = (source: string, name: string) => parseFormdown(source).forms.find((f) => f.name === name)!

  it('writes the options typed into the field, and nothing else', () => {
    const template = '# 접수\n\n@심각도: [select options="낮음,보통"]\n'
    expect(setOptions(template, '심각도', '낮음, 보통, 긴급')).toBe('# 접수\n\n@심각도: [select options="낮음,보통,긴급"]\n')
  })

  it('writes nothing for no option, the same options, or a field the template does not have', () => {
    const template = '@심각도: [select options="낮음,보통"]'
    expect(setOptions(template, '심각도', ' , ')).toBeUndefined()
    expect(setOptions(template, '심각도', '낮음,  보통')).toBeUndefined()
    expect(setOptions(template, '없는칸', 'a')).toBeUndefined()
  })

  it('keeps an "other" choice written among the options', () => {
    const inBrackets = setOptions('@경로: [radio options="전화,메일,*(직접 입력)"]', '경로', '전화, 메일, 방문')!
    expect(inBrackets).toBe('@경로: [radio options="전화,메일,방문,*(직접 입력)"]')
    expect(field(inBrackets, '경로')).toMatchObject({ options: [{ value: '전화' }, { value: '메일' }, { value: '방문' }], allowOther: true, otherLabel: '직접 입력' })

    const inBraces = setOptions('@경로{전화,메일,*}: r[]', '경로', '전화, 방문')!
    expect(field(inBraces, '경로')).toMatchObject({ options: [{ value: '전화' }, { value: '방문' }], allowOther: true })
  })

  it('reads and writes values apart from the text shown for them', () => {
    const template = '@분류: [select options="hw=하드웨어,sw=소프트웨어"]'
    expect(optionsText(field(template, '분류').options!)).toBe('hw=하드웨어, sw=소프트웨어')
    const next = setOptions(template, '분류', 'hw=장비, sw=소프트웨어, net=네트워크')!
    expect(next).toBe('@분류: [select options="hw=장비,sw=소프트웨어,net=네트워크"]')
    expect(setOptions(template, '분류', 'hw = 하드웨어,  sw=소프트웨어')).toBeUndefined()
  })

  it('leaves an "other" choice written as its own attribute where it is', () => {
    const template = '@경로: [radio options="전화,메일" allow-other other-label="직접 입력"]'
    expect(setOptions(template, '경로', '전화, 방문')).toBe('@경로: [radio options="전화,방문" allow-other other-label="직접 입력"]')
  })
})

describe('setSuggest', () => {
  const template = ['---', 'id: intake', 'version: 1', '---', '# 접수', '', '요청: ___@요청', '', '@부서: [select options="영업,개발"]', '', '@담당: [select options="장비,총무"]', ''].join('\n')

  it('turns suggestions on and off on the field itself, as Formdown reads it', () => {
    const on = setSuggest(template, '담당', true)
    expect(on).toContain('@담당: [select options="장비,총무" suggest:role="judged"]')
    expect(readFrontMatter(on)?.frontMatter.data).toEqual({ id: 'intake', version: 1 })
    expect(judgedFields(on)).toEqual(['담당'])
    expect(setSuggest(on, '담당', false)).toBe(template)
    // A field said never to be suggested is turned on for good.
    const off = template.replace('[select options="장비,총무"]', '[select options="장비,총무" suggest:policy=off]')
    expect(judgedFields(setSuggest(off, '담당', true))).toEqual(['담당'])
  })

  it('moves what a template written before kept in its front matter onto its fields, meaning the same', () => {
    const before = template
      .replace('version: 1', 'version: 1\nlowline:\n  suggest: [부서, 담당, 없는칸]\n  coarse: { 담당: 1 }\n  note: keep')
      .replace('[select options="영업,개발"]', '[select options="영업,개발" suggest:role=observed]')
    const after = moveSuggestToFields(before)!
    // 부서 said its own role, which was the one that counted; 담당 is judged on the field, with its class length.
    expect(judgedFields(after)).toEqual(judgedFields(before))
    expect(judgedFields(after)).toEqual(['담당'])
    const fields = parseFormdown(after).forms
    expect(fields.find((f) => f.name === '담당')?.suggest).toEqual({ role: 'judged', coarse: 1 })
    expect(fields.find((f) => f.name === '부서')?.suggest).toEqual({ role: 'observed' })
    // A name that is not a field stays where the page says so; other keys stay.
    expect(readFrontMatter(after)?.frontMatter.data.lowline).toEqual({ suggest: ['없는칸'], note: 'keep' })
    expect(moveSuggestToFields(after)).toBeUndefined()
    expect(moveSuggestToFields(template)).toBeUndefined()
    // Nothing left under lowline: the key goes.
    const only = template.replace('version: 1', 'version: 1\nlowline:\n  suggest: [담당]')
    expect(readFrontMatter(moveSuggestToFields(only)!)?.frontMatter.data).toEqual({ id: 'intake', version: 1 })
  })

  it('takes a field out of the front matter list templates written before kept, keeping the rest', () => {
    const before = template.replace('version: 1', 'version: 1\nlowline:\n  suggest: [부서, 담당]\n  note: keep')
    const on = setSuggest(before, '담당', true)
    expect(readFrontMatter(on)?.frontMatter.data.lowline).toEqual({ suggest: ['부서'], note: 'keep' })
    expect(judgedFields(on)).toEqual(['부서', '담당'])
    const off = setSuggest(before, '부서', false)
    expect(readFrontMatter(off)?.frontMatter.data.lowline).toEqual({ suggest: ['담당'], note: 'keep' })
    expect(judgedFields(off)).toEqual(['담당'])
    const none = setSuggest(setSuggest(off, '담당', false), '담당', false)
    expect(readFrontMatter(none)?.frontMatter.data.lowline).toEqual({ note: 'keep' })
  })

  it('names a file after what a person typed, or refuses a name no file can have', () => {
    expect(fileNameFor('  배터리 문의  ', '.md')).toBe('배터리 문의.md')
    expect(fileNameFor('끝에 점...', '.md')).toBe('끝에 점.md')
    expect(fileNameFor('', '.md')).toBeNull()
    expect(fileNameFor(' . ', '.md')).toBeNull()
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a?b', 'a*b', 'a"b', 'a<b', 'a|b', 'a\tb']) expect(fileNameFor(bad, '.md')).toBeNull()
    expect(fileNameFor('고객 문의', '.fd.md')).toBe('고객 문의.fd.md')
    expect(fileName('서식/고객 문의.fd.md', '.fd.md')).toBe('고객 문의')
    expect(fileName('문서/접수-1.md', '.md')).toBe('접수-1')
  })
})

describe('templateProblems from what the parser could not read', () => {
  const head = '---\nid: t\nversion: 1\n---\n'
  it('says a condition that is not one, and a line that looks like a field but is not one', () => {
    expect(templateProblems(`${head}@부서: [select options="영업,개발"]\n@비고: [text visible-if="부서 == 영업"]\n`)).toContainEqual({ kind: 'invalid-condition', field: '비고' })
    expect(templateProblems(`${head}@경로: r{전화,메일}[]\n`)).toContainEqual(
      expect.objectContaining({ kind: 'unrecognized-field', name: '경로', line: 5, fix: expect.objectContaining({ text: '@경로{전화,메일}: r[]' }) }),
    )
  })

  it('says how to write a field the parser can tell the meaning of, and where that text goes', () => {
    for (const [line, meant] of [
      ['@처리_기한: date', '@처리_기한: [date]'], // written without its brackets
      ['@경로: r{전화,메일}[]', '@경로{전화,메일}: r[]'], // its braces after the colon
    ]) {
      const source = `${head}메모: ___@메모\n${line}\n끝.\n`
      const problem = templateProblems(source).find((p) => p.kind === 'unrecognized-field')
      const fix = problem?.kind === 'unrecognized-field' ? problem.fix : undefined
      expect(fix?.text).toBe(meant)
      expect(strings.templateProblem(problem!)).toContain(`이렇게 쓰면 칸이 됩니다: ${meant}`)
      // Put in place of the text it is about, the line is a field and nothing else changed.
      const fixed = source.slice(0, fix!.start) + fix!.text + source.slice(fix!.end)
      expect(fixed).toBe(source.replace(line, meant))
      expect(templateProblems(fixed).filter((p) => p.kind === 'unrecognized-field')).toEqual([])
    }
  })

  it('says how a field is written when the parser cannot tell what a line meant', () => {
    const text = strings.templateProblem({ kind: 'unrecognized-field', name: '메모', line: 5 })
    expect(text).toContain('칸은 "@이름: [형식]"으로 씁니다')
    expect(text).not.toContain('이렇게 쓰면')
  })
})

describe('templateProblems', () => {
  const head = '---\nid: intake\nversion: 1\nlowline:\n  suggest: [담당]\n---\n'

  it('finds none in a template that works as written', () => {
    expect(templateProblems(`${head}요청: ___@요청\n\n@담당: [select options="장비,인사"]\n`)).toEqual([])
  })

  it('names a field name used more than once, once', () => {
    const source = `${head}@담당: [select options="장비"]\n\n@담당: [text]\n\n@담당: [text]\n`
    // Lines of the source, front matter included: the first 담당 is line 7, its repeats 9 and 11.
    expect(templateProblems(source)).toEqual([{ kind: 'duplicate-field', name: '담당', lines: [9, 11] }])
  })

  it('names a suggest entry that is not a field', () => {
    const source = '---\nid: intake\nversion: 1\nlowline:\n  suggest: [담당, 분류]\n---\n@담당: [text]\n'
    expect(templateProblems(source)).toEqual([{ kind: 'unknown-suggest', name: '분류' }])
  })

  it('says front matter cannot be read, before anything else', () => {
    const [first] = templateProblems('---\nid: intake\nversion: [1\n---\n@담당: [text]\n')
    expect(first.kind).toBe('front-matter')
    expect(first.kind === 'front-matter' && first.detail).toMatch(/YAML/)
  })
})

describe('templateProblems — conditions', () => {
  it('names a condition that points at no field of the template, once per field', () => {
    const source = '---\nid: order\nversion: 1\n---\n@구분: [radio options="개인,법인"]\n\n@회사명: [text visible-if="분류=법인" required-if="분류=법인"]\n\n@메모: [text hidden-if="!구분"]\n'
    expect(templateProblems(source)).toEqual([{ kind: 'unknown-condition', field: '회사명', name: '분류' }])
  })
})

describe('templateProblems — computed values', () => {
  it('names a computation that cannot be read, or reads no field of the template', () => {
    const source =
      '---\nid: requisition\nversion: 1\n---\n@청구량: [number]\n\n@단가: [number]\n\n@금액: [number compute="청구량 * 단가"]\n\n@세액: [number compute="금액 * 세율"]\n\n@합계: [number compute="금액 +"]\n'
    expect(templateProblems(source)).toEqual([
      { kind: 'unknown-compute', field: '세액', name: '세율' },
      { kind: 'invalid-compute', field: '합계' },
    ])
    for (const problem of templateProblems(source)) expect(strings.templateProblem(problem)).toContain('계산')
  })
})

describe('strayFields', () => {
  const source = '---\nid: intake\nversion: 1\n---\n# 접수\n\n요청: ___@요청\n\n@배정: [select options="장비,인사"]\n'
  const doc = (values: Record<string, unknown>, template = 'intake@1') => ({ template, values })

  it("names the fields the template's documents hold values in that the source does not have, most first", () => {
    const documents = [
      doc({ 요청: '노트북', 담당: '장비', 비고: '급함' }),
      doc({ 요청: '휴가', 담당: '인사' }),
      doc({ 요청: '프린터', 담당: '' }),
      doc({ 요청: '회의실', 태그: [] }),
      // Another revision is the same template; another id is not.
      doc({ 담당: '장비' }, 'intake@2'),
      doc({ 담당: '장비', 비고: '다른 서식' }, 'order@1'),
    ]
    expect(strayFields(source, documents)).toEqual([
      { kind: 'stray-values', name: '담당', count: 3 },
      { kind: 'stray-values', name: '비고', count: 1 },
    ])
  })

  it('has none while every value has its field, or when the source cannot be read', () => {
    expect(strayFields(source, [doc({ 요청: '노트북', 배정: '장비' })])).toEqual([])
    expect(strayFields('# 앞부분 없음\n\n요청: ___@요청\n', [doc({ 담당: '장비' })])).toEqual([])
  })
})

describe('sharedId', () => {
  const source = '---\nid: intake\nversion: 2\n---\n# 접수\n'
  const templates = [
    { ref: 'intake@2', path: '서식/접수.fd.md', name: '접수' },
    { ref: 'intake@1', path: '서식/접수 (옛).fd.md', name: '접수 (옛)' },
    { ref: 'bug-report@1', path: '서식/버그 리포트.fd.md', name: '버그 리포트' },
  ]

  it('names the other template files with this template id, whatever their revision', () => {
    expect(sharedId(source, '서식/접수.fd.md', templates)).toEqual([{ kind: 'shared-id', id: 'intake', names: ['접수 (옛)'] }])
  })

  it('has none for a template alone with its id, or one whose front matter cannot be read', () => {
    expect(sharedId(source, '서식/접수.fd.md', templates.slice(0, 1))).toEqual([])
    expect(sharedId('# 앞부분 없음\n', '서식/접수.fd.md', templates)).toEqual([])
  })
})

describe('referenceProblems', () => {
  const inquiry = '---\nid: inquiry\nversion: 1\n---\n# 문의\n\n@고객 -> customer: [select]\n@상위 -> inquiry: [select]\n@태그 <-> tag: [checkbox]\n'
  const templates = [
    { ref: 'inquiry@1', path: '서식/문의.fd.md', name: '문의' },
    { ref: 'customer@2', path: '서식/고객.fd.md', name: '고객' },
  ]

  it('says nothing of a field referring to a template in the vault, whatever its revision, or to its own', () => {
    expect(referenceProblems(inquiry, templates).filter((p) => p.kind === 'unknown-reference')).toEqual([])
  })

  it('names a field referring to a template the vault does not have', () => {
    expect(referenceProblems(inquiry, templates.slice(0, 1))).toContainEqual({ kind: 'unknown-reference', field: '고객', target: 'customer' })
  })

  it('names a many-to-many field, which is not read as a reference yet', () => {
    expect(referenceProblems(inquiry, templates)).toEqual([{ kind: 'many-to-many', field: '태그', target: 'tag' }])
  })
})

describe('reviseDocument', () => {
  const v2 = '---\nid: intake\nversion: 2\n---\n# 접수 (2판)\n\n요청: ___@요청\n\n@긴급: [select options="보통,급함"]\n'
  const old = '---\ntemplate: intake@1\nlowline:\n  id: d-1\n  keep: yes\n요청: 노트북\n담당: 장비\n---\n# 접수\n\n요청: ___@요청\n\n@담당: [select options="장비,인사"]\n'

  it("keeps every value and the document's id, names the revision now, and takes its body", () => {
    const moved = reviseDocument(old, v2)
    const { template, id, values } = documentFrontMatter(moved)
    expect(template).toBe('intake@2')
    expect(id).toBe('d-1')
    // A field the revision no longer has keeps its value in the file.
    expect(values).toEqual({ 요청: '노트북', 담당: '장비' })
    expect(readFrontMatter(moved)?.frontMatter.data.lowline).toEqual({ id: 'd-1', keep: 'yes' })
    expect(moved.endsWith('# 접수 (2판)\n\n요청: ___@요청\n\n@긴급: [select options="보통,급함"]\n')).toBe(true)
    expect(parseFormdown(moved).forms.map((f) => f.name)).toEqual(['요청', '긴급'])
  })
})

describe('a document written with its front matter alone', () => {
  const v1 = '---\nid: intake\nversion: 1\n---\n# 접수\n\n요청: ___@요청\n\n@담당: [select options="장비,인사"]\n'
  const bare = '---\ntemplate: intake@1\n요청: 밖에서 쓴 요청\n---\n# 접수\n'

  it('has no fields to fill, as a copy of its template does', () => {
    expect(hasFields(bare)).toBe(false)
    expect(hasFields('---\ntemplate: intake@1\n---\n')).toBe(false)
    expect(hasFields(newDocument(v1, {}, 'd-1'))).toBe(true)
  })

  it("takes its template's body under its front matter as it is, naming the revision it named", () => {
    const filled = withTemplateBody(bare, v1)
    expect(documentFrontMatter(filled)).toEqual({ template: 'intake@1', values: { 요청: '밖에서 쓴 요청' } })
    expect(parseFormdown(filled).forms.map((f) => f.name)).toEqual(['요청', '담당'])
    expect(updateDocument(filled, { 요청: '밖에서 쓴 요청', 담당: '장비' }).endsWith('@담당: [select options="장비,인사"]\n')).toBe(true)
  })
})
