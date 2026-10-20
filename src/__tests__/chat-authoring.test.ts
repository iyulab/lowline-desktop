import { describe, expect, it } from 'vitest'
import { draftOf, draftProblems, draftsOf, fieldChanges, leftoverFields, retryMessage, rowProblems, sourceId, tidyDraft, wordsOf } from '../chat-authoring.ts'

const fence = '```'
const before = '---\nid: intake\nversion: 1\n---\n# 접수\n\n@요청: [textarea rows=3]\n'
const after = '---\nid: intake\nversion: 1\n---\n# 접수\n\n@요청: [textarea rows=3]\n\n@기한: [date]\n'

describe('the chat that writes templates', () => {
  it('takes the template from the block of a reply, and the words from the rest', () => {
    const reply = `기한 칸을 넣었습니다.\n\n${fence}formdown\n${after}${fence}\n\n저장해 주세요.`
    expect(draftOf(reply)).toBe(after)
    expect(wordsOf(reply)).toBe('기한 칸을 넣었습니다.\n\n저장해 주세요.')
  })

  it('takes a block without a language too, and passes over one that holds no template', () => {
    expect(draftOf(`${fence}\n${after}${fence}`)).toBe(after)
    expect(draftOf(`예시: ${fence}js\nconsole.log(1)\n${fence}`)).toBeNull()
    expect(draftOf('기한 칸은 날짜로 두면 됩니다.')).toBeNull()
  })

  it('makes a field name with spaces one word, and leaves every other line as it is', () => {
    expect(tidyDraft('@처리 기한: [date]\n제목: ___@제목\n@요청: [textarea]\n')).toBe('@처리_기한: [date]\n제목: ___@제목\n@요청: [textarea]\n')
  })

  it('puts a field written without its brackets in them, as the parser says to, and leaves text that only starts like one', () => {
    const draft = '---\nid: t\nversion: 1\n---\n# 접수\n\n@고객_이름: text\n@문의_유형: select options="배송,환불"\n@연락처: [email]\n@김: text me later\n'
    expect(tidyDraft(draft)).toBe(
      '---\nid: t\nversion: 1\n---\n# 접수\n\n@고객_이름: [text]\n@문의_유형: [select options="배송,환불"]\n@연락처: [email]\n@김: text me later\n',
    )
    expect(fieldChanges(before, tidyDraft(draft)).added).toEqual(['고객_이름', '문의_유형', '연락처'])
  })

  it('says what stands in the way of a draft, as the template page says it', () => {
    expect(draftProblems(after)).toEqual([])
    expect(draftProblems('# 접수\n\n@요청: [text]\n').length).toBeGreaterThan(0) // no id, no version
    const twice = draftProblems('---\nid: t\nversion: 1\n---\n@요청: [text]\n@요청: [text]\n')
    expect(twice.some((p) => p.includes('요청'))).toBe(true)
    expect(retryMessage(['a', 'b'])).toMatch(/\n- a\n- b$/)
  })

  it('takes a table of repeated rows apart: the template in the editor, each row template whose documents point at it to make', () => {
    const parent = '---\nid: requisition\nversion: 1\n---\n# 물품청구서\n\n@운용부서: [text]\n@청구일: [date]\n'
    const row = '---\nid: requisition-item\nversion: 1\n---\n# 청구 품목\n\n@청구서 -> requisition: [select]\n@품명: [text]\n@청구량: [number]\n'
    const block = (source: string) => `${fence}formdown\n${source}${fence}`
    const reply = `품목을 줄 서식으로 나눴습니다.\n\n${block(parent)}\n\n${block(row)}`
    expect(draftsOf(reply, 'requisition')).toEqual({ draft: parent, rows: [row], reversed: [] })
    // Sent the other way round, the template is still the one with its id.
    expect(draftsOf(`${block(row)}\n${block(parent)}`, 'requisition')).toEqual({ draft: parent, rows: [row], reversed: [] })
    // A new template, its id not yet the one the editor had: the block not pointing at another is the template.
    expect(draftsOf(reply, 'template-abc')).toEqual({ draft: parent, rows: [row], reversed: [] })
    // A reply showing the template as it was, then as changed: the changed one, the last.
    expect(draftsOf(`${block(before)}\n${block(after)}`, 'intake')?.draft).toBe(after)
    expect(draftOf(`${block(before)}\n${block(after)}`)).toBe(after)
    // The template pointing at its row template instead: the reference the wrong way round, said as such.
    const pointing = `${parent}@품목 -> requisition-item: [select]\n`
    const loose = row.replace('@청구서 -> requisition: [select]\n', '')
    expect(draftsOf(`${block(pointing)}\n${block(loose)}`, 'requisition')).toEqual({ draft: pointing, rows: [], reversed: [loose] })
    // A small model often leaves the first fence open: the next template fence starts the next block.
    const unclosed = `나눴습니다.\n\n${fence}formdown\n${parent}\n${block(row)}\n끝.`
    expect(draftsOf(unclosed, 'requisition')).toEqual({ draft: parent, rows: [row], reversed: [] })
    // A field naming another template's documents is left as written; only spaces in a name become underscores.
    expect(tidyDraft(row)).toBe(row)
    expect(tidyDraft('@청구 품목 -> requisition: [select]\n')).toBe('@청구_품목 -> requisition: [select]\n')
    expect(wordsOf(unclosed)).toBe('나눴습니다.\n\n끝.')
    expect(sourceId(row)).toBe('requisition-item')
    expect(rowProblems(row, 'requisition')).toEqual([])
    expect(rowProblems(row.replace('-> requisition', ''), 'requisition').some((p) => p.includes('requisition'))).toBe(true)
    expect(rowProblems(row.replace('id: requisition-item', 'id: requisition'), 'requisition').length).toBeGreaterThan(0)
  })

  it('names the fields a draft adds and takes away', () => {
    expect(fieldChanges(before, after)).toEqual({ added: ['기한'], removed: [] })
    expect(fieldChanges(after, before)).toEqual({ added: [], removed: ['기한'] })
  })

  it('names the fields a draft from a blank form kept from the template it replaced, when the form never names them', () => {
    const starter = '---\nid: new\nversion: 1\n---\n# 새 서식\n\n제목: ___@제목\n\n@상태: [select options="열림,닫힘"]\n\n@메모: [textarea rows=4]\n'
    const form = '| 제목 | |\n| :--- | :--- |\n| 운용부서명 | |\n| 품명 | 청구량 |'
    const draft = '---\nid: new\nversion: 1\n---\n# 물품 청구서\n\n@제목: [text]\n@운용부서명: [text]\n@상태: [select options="열림,닫힘"]\n@메모: [textarea]\n'
    expect(leftoverFields(draft, starter, form)).toEqual(['상태', '메모'])
    expect(leftoverFields(draft.replace('@메모: [textarea]\n', '').replace('@상태: [select options="열림,닫힘"]\n', ''), starter, form)).toEqual([])
  })
})
