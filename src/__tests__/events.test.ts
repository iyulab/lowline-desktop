import { describe, expect, it } from 'vitest'
import {
  charactersTyped,
  checkEvents,
  fillOrder,
  parseEvents,
  parsePresentations,
  presentation,
  suggestionEvents,
  type Check,
  type Offer,
} from '../events.js'
import type { Suggestion } from '../projection.js'

const suggestion = (value: string): Suggestion => ({ value, mode: 'key', source: '부서: 영업' })
const shown = new Date('2026-09-28T11:59:00Z')
const offer = (value: string, decided?: Date): Offer => ({ suggestion: suggestion(value), shown, filled: ['요청'], typed: 0, ...(decided ? { decided } : {}) })
const at = new Date('2026-09-28T12:00:00Z')

describe('suggestionEvents', () => {
  const offered = new Map([
    ['담당', offer('장비', new Date('2026-09-28T11:59:30Z'))],
    ['긴급', offer('예')],
    ['분류', offer('하드웨어')],
    ['무시', offer('아무거나')],
  ])

  it('reads accept, correct and reject off what was saved', () => {
    const events = suggestionEvents(offered, new Set(['분류']), { 담당: '장비', 긴급: '아니오' }, '문서/a.md', at)
    expect(events.map((e) => [e.field, e.kind, e.value])).toEqual([
      ['담당', 'accept', '장비'],
      ['긴급', 'correct', '아니오'],
      ['분류', 'reject', null],
    ])
    expect(events[0]).toEqual({
      at: '2026-09-28T12:00:00.000Z',
      doc: '문서/a.md',
      field: '담당',
      kind: 'accept',
      suggested: '장비',
      value: '장비',
      source: 'key',
      recall: '부서: 영업',
      similarity: null,
      filled: ['요청'],
      shownAt: '2026-09-28T11:59:00.000Z',
      decidedAt: '2026-09-28T11:59:30.000Z',
      typed: 0,
    })
    expect(events[1]).not.toHaveProperty('decidedAt') // changed by hand, neither taken nor rejected
  })

  it('treats a rejected suggestion that was later filled in as a correction', () => {
    const [event] = suggestionEvents(new Map([['담당', offer('장비')]]), new Set(['담당']), { 담당: '총무' }, 'd', at)
    expect(event.kind).toBe('correct')
  })

  it('says nothing about a suggestion that was neither taken nor rejected', () => {
    expect(suggestionEvents(offered, new Set(), {}, 'd', at)).toEqual([])
  })

  it('reads a class as taken when the value saved begins with it, whatever follows', () => {
    const chapter = new Map([['코드', { ...offer('32'), suggestion: { value: '32', mode: 'coarse' as const, source: '설비: 펌프' } }]])
    const [taken] = suggestionEvents(chapter, new Set(), { 코드: '3203' }, 'd', at)
    expect([taken.kind, taken.source, taken.suggested, taken.value]).toEqual(['accept', 'coarse', '32', '3203'])
    expect(suggestionEvents(chapter, new Set(), { 코드: '5210' }, 'd', at)[0].kind).toBe('correct')
  })
})

describe('checkEvents', () => {
  const checks = new Map<string, Check>([
    ['담당', { held: '장비', probability: 0.05, shown, filled: ['요청'] }],
    ['긴급', { held: '예', probability: 0.05, shown, filled: [] }],
  ])

  it('records what was entered in a field whose suggestion was held back, with the value held back and its chance', () => {
    const events = checkEvents(checks, { 담당: '인사' }, '문서/a.md', at, 'intake@1')
    expect(events).toEqual([
      {
        at: '2026-09-28T12:00:00.000Z',
        doc: '문서/a.md',
        template: 'intake@1',
        field: '담당',
        kind: 'check',
        suggested: '장비',
        value: '인사',
        source: 'check',
        recall: null,
        similarity: null,
        filled: ['요청'],
        shownAt: '2026-09-28T11:59:00.000Z',
        probability: 0.05,
      },
    ])
    // A field left empty settled nothing.
    expect(checkEvents(checks, {}, '문서/a.md', at)).toEqual([])
  })

  it('is read back from the event file', () => {
    const events = checkEvents(checks, { 담당: '장비' }, '문서/a.md', at)
    expect(parseEvents(events.map((e) => JSON.stringify(e)).join('\n'))).toEqual(events)
  })
})

describe('parseEvents', () => {
  it('reads one event per line and skips lines that are not events', () => {
    const [event] = suggestionEvents(new Map([['담당', offer('장비')]]), new Set(['담당']), {}, '문서/a.md', at)
    const text = [
      JSON.stringify(event),
      '',
      '{"at":"2026-09-28T12:00:00.000Z","doc":"문서/a.md","fi', // cut short
      JSON.stringify({ ...event, kind: 'ignored' }),
      '[1, 2]',
      `${JSON.stringify(event)}\r`,
    ].join('\n')
    expect(parseEvents(text)).toEqual([event, event])
  })
})

describe('fillOrder', () => {
  it('keeps the order fields were filled in, and drops emptied ones', () => {
    let order = fillOrder([], { 요청: '프린터', 담당: '' })
    expect(order).toEqual(['요청'])
    order = fillOrder(order, { 긴급: '예', 요청: '프린터' })
    expect(order).toEqual(['요청', '긴급'])
    order = fillOrder(order, { 담당: '장비', 긴급: '예', 요청: '' })
    expect(order).toEqual(['긴급', '담당'])
    expect(fillOrder(order, { 긴급: [], 담당: '장비' })).toEqual(['담당'])
  })
})

describe('presentations', () => {
  it('keep where a suggestion was shown and nothing of its value', () => {
    const p = presentation('intake@1', '담당', offer('장비'))
    expect(p).toEqual({ at: '2026-09-28T11:59:00.000Z', template: 'intake@1', field: '담당', source: 'key', typed: 0 })
    const text = [JSON.stringify(p), '{"at":"x","templ', '[1]', JSON.stringify({ ...p, field: 3 }), ''].join('\n')
    expect(parsePresentations(text)).toEqual([p])
  })

  it('read one from before the characters typed were kept as not knowing them', () => {
    const { typed: _, ...older } = presentation('intake@1', '담당', offer('장비'))
    expect(parsePresentations(JSON.stringify(older))).toEqual([older])
    expect(parsePresentations(JSON.stringify({ ...older, typed: '2' }))).toEqual([older])
  })
})

describe('charactersTyped', () => {
  it('counts characters as a person does — a Hangul syllable or one being composed is one — and nothing typed as 0', () => {
    expect(charactersTyped(undefined)).toBe(0)
    expect(charactersTyped('')).toBe(0)
    expect(charactersTyped('박영')).toBe(2)
    expect(charactersTyped('ㅂ')).toBe(1)
    expect(charactersTyped('A3😀')).toBe(3)
  })

  it('is what an event and a presentation say was typed when the suggestion was first shown', () => {
    const typed: Offer = { ...offer('박영희'), typed: charactersTyped('박영') }
    const [event] = suggestionEvents(new Map([['담당', typed]]), new Set(), { 담당: '박영희' }, 'd', at)
    expect(event.typed).toBe(2)
    expect(presentation('intake@1', '담당', typed).typed).toBe(2)
  })

  it('says what was in the field when a suggestion was taken or rejected, and nothing when it was neither', () => {
    const decided = new Date('2026-09-28T11:59:30Z')
    const taken: Offer = { ...offer('박영희', decided), decidedTyped: 2 }
    const declined: Offer = { ...offer('장비', decided), decidedTyped: 1 }
    const changed: Offer = offer('최민수')
    const events = suggestionEvents(
      new Map([['담당', taken], ['분류', declined], ['처리', changed]]),
      new Set(['분류']),
      { 담당: '박영희', 처리: '김철수' },
      'd',
      at,
    )
    expect(events.map((e) => [e.field, e.kind, e.typed, e.decidedTyped])).toEqual([
      ['담당', 'accept', 0, 2],
      ['분류', 'reject', 0, 1],
      ['처리', 'correct', 0, undefined],
    ])
    expect('decidedTyped' in events[2]).toBe(false)
  })
})
