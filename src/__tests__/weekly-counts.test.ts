import { describe, expect, it } from 'vitest'
import type { Presentation, SuggestionEvent } from '../events.js'
import type { DocumentSnapshot, TemplateSnapshot } from '../projection.js'
import { dwellSpan, namedDay, weekOf, weeklyCounts } from '../weekly-counts.js'

const template = (ref: string, suggest: string[]): TemplateSnapshot => ({
  ref,
  fields: [{ name: '요청', type: 'textarea', label: '요청', multiple: false, options: [] }, ...suggest.map((name) => ({ name, type: 'select', label: name, multiple: false, options: [] }))],
  suggest,
  schema: {},
})

const intake = template('intake@1', ['담당', '긴급'])
const bug = template('bug@2', ['원인'])
const notes = template('note@1', [])

const event = (at: string, doc: string, field: string, kind: SuggestionEvent['kind'], similarity: number | null, tpl?: string): SuggestionEvent => ({
  at,
  doc,
  ...(tpl ? { template: tpl } : {}),
  field,
  kind,
  suggested: '장비',
  value: kind === 'reject' ? null : '장비',
  // A similar record's suggestion carries its similarity; a settled value's carries none.
  source: similarity === null ? 'key' : 'memory',
  recall: '문서/비밀-경로.md',
  similarity,
})

const doc = (path: string, tpl: string, values: Record<string, unknown>, modified?: number): DocumentSnapshot => ({
  path,
  id: path,
  template: tpl,
  values,
  ...(modified ? { modified } : {}),
})

describe('weekOf', () => {
  it('is the Monday the week starts on', () => {
    // In this device's time, as a document's file is named.
    expect(weekOf(new Date(2026, 8, 28, 0, 0, 0).getTime())).toBe('2026-09-28') // a Monday
    expect(weekOf(new Date(2026, 9, 4, 23, 59, 59).getTime())).toBe('2026-09-28') // the Sunday after
    expect(weekOf(new Date(2026, 9, 5, 0, 0, 0).getTime())).toBe('2026-10-05')
    expect(weekOf(new Date(2026, 0, 1, 12).getTime())).toBe('2025-12-29') // across a year
  })
})

describe('weeklyCounts', () => {
  const documents = [
    doc('문서/환자-김철수.md', 'intake@1', { 요청: '비밀', 담당: '장비' }, Date.parse('2026-09-29T10:00:00Z')),
    doc('문서/2.md', 'intake@1', { 요청: '다른 비밀' }, Date.parse('2026-09-30T10:00:00Z')),
    doc('문서/3.md', 'intake@1', { 긴급: '예' }, Date.parse('2026-10-13T10:00:00Z')),
  ]
  const events = [
    event('2026-09-29T10:00:00.000Z', '문서/환자-김철수.md', '담당', 'accept', 0.83, 'intake@1'),
    event('2026-09-30T10:00:00.000Z', '문서/2.md', '담당', 'reject', 0.61),
    event('2026-10-01T10:00:00.000Z', '문서/3.md', '긴급', 'correct', 0.66, 'intake@1'),
    event('2026-10-06T10:00:00.000Z', '문서/3.md', '담당', 'accept', null, 'intake@1'),
    event('2026-10-06T10:00:00.000Z', '문서/없음.md', '담당', 'accept', 0.9), // template unknown: left out
    event('2026-10-06T10:00:00.000Z', '문서/3.md', '요청', 'accept', 0.9, 'intake@1'), // not a judgment field
  ]
  const counts = weeklyCounts([notes, intake, bug], documents, events)

  it('counts decisions by week, form and judgment field, by number', () => {
    expect(counts.counts.map(({ week, form, field, accepted, corrected, rejected }) => [week, form, field, accepted, corrected, rejected])).toEqual([
      ['2026-09-28', 2, 1, 1, 0, 1],
      ['2026-09-28', 2, 2, 0, 1, 0],
      ['2026-10-05', 2, 1, 1, 0, 0],
    ])
  })

  it('buckets decisions by the similarity the suggestion was made at', () => {
    expect(counts.counts[0].bySimilarity).toEqual({ '0.8': { decided: 1, accepted: 1 }, '0.6': { decided: 1, accepted: 0 } })
    expect(counts.counts[2].bySimilarity).toEqual({})
  })

  it('counts decisions by the source of the suggestion, each read against its own promise', () => {
    expect(counts.counts[0].bySource).toEqual({ memory: { decided: 2, accepted: 1 } })
    expect(counts.counts[2].bySource).toEqual({ key: { decided: 1, accepted: 1 } })
  })

  it('numbers only forms with judgment fields, in the order of their references', () => {
    // bug@2 is 1, intake@1 is 2; a form without judgment fields is not counted.
    expect(counts.forms).toEqual([
      { form: 1, confirmed: 0, outside: 0, weeks: 0, perWeek: 0 },
      { form: 2, confirmed: 2, outside: 0, weeks: 3, perWeek: 0.67 },
    ])
  })

  it('does not count a document with a conflict copy as confirmed', () => {
    const unsettled = documents.map((d) => (d.path === '문서/3.md' ? { ...d, conflicted: true } : d))
    expect(weeklyCounts([notes, intake, bug], unsettled, events).forms[1]).toEqual({ form: 2, confirmed: 1, outside: 0, weeks: 1, perWeek: 1 })
  })

  it('does not count as confirmed a document whose judgment values another program only proposed', () => {
    const proposed = documents.map((d) => (d.path === '문서/3.md' ? { ...d, proposed: Object.keys(d.values) } : d))
    expect(weeklyCounts([notes, intake, bug], proposed, events).forms[1]).toEqual({ form: 2, confirmed: 1, outside: 0, weeks: 1, perWeek: 1 })
    // One value settled by a person is enough.
    const partly = documents.map((d) => (d.path === '문서/3.md' ? { ...d, values: { ...d.values, 긴급: '높음' }, proposed: ['담당'] } : d))
    expect(weeklyCounts([notes, intake, bug], partly, events).forms[1].confirmed).toBe(2)
  })

  it('counts a document in the week of the day its file is named by, not when its file was last written', () => {
    // A year of records brought in at once, then two made in the app: the form gets one a week, not fifty-four.
    const importedAt = Date.parse('2026-10-05T08:00:00Z')
    const history = Array.from({ length: 52 }, (_, i) => {
      const day = weekOf(new Date(2025, 9, 6 + i * 7).getTime())
      return doc(`문서/${day}-접수.md`, 'intake@1', { 담당: '장비' }, importedAt + i)
    })
    const made = [
      doc('문서/2026-10-05-접수.md', 'intake@1', { 담당: '장비' }, Date.parse('2026-10-05T10:00:00Z')),
      doc('문서/2026-10-12-접수 (1).md', 'intake@1', { 담당: '장비' }, Date.parse('2026-10-12T10:00:00Z')),
    ]
    expect(weeklyCounts([intake], [...history, ...made], []).forms).toEqual([{ form: 1, confirmed: 54, outside: 0, weeks: 54, perWeek: 1 }])
  })

  it('counts a decision in the week of the document it was saved with, early on a Monday too', () => {
    const early = new Date(2026, 9, 5, 7, 30).getTime() // Monday morning here, which may still be Sunday elsewhere
    const counted = weeklyCounts(
      [intake],
      [doc('문서/2026-10-05-접수.md', 'intake@1', { 담당: '장비' }, early)],
      [event(new Date(early).toISOString(), '문서/2026-10-05-접수.md', '담당', 'accept', null, 'intake@1')],
    )
    expect(counted.counts.map((c) => c.week)).toEqual(['2026-10-05'])
    expect(counted.forms).toEqual([{ form: 1, confirmed: 1, outside: 0, weeks: 1, perWeek: 1 }])
  })

  it('counts apart the confirmed documents the app has never saved', () => {
    const outside = { ...doc('문서/2026-10-05-접수.md', 'intake@1', { 담당: '총무' }), outside: true }
    const blank = { ...doc('문서/2026-10-06-접수.md', 'intake@1', {}), outside: true } // no judgment value: not confirmed at all
    const made = doc('문서/2026-10-07-접수.md', 'intake@1', { 담당: '장비' })
    expect(weeklyCounts([intake], [outside, blank, made], []).forms[0]).toMatchObject({ confirmed: 2, outside: 1 })
  })

  it('reads the day a file is named by, if it is one', () => {
    expect(namedDay('문서/2026-10-13-문의.md')).toBe(new Date(2026, 9, 13).getTime())
    expect(namedDay('2026-10-13.md')).toBe(new Date(2026, 9, 13).getTime())
    expect(namedDay('문서/2026-10-13 (1).md')).toBe(new Date(2026, 9, 13).getTime())
    expect(namedDay('문서/2026-02-30-문의.md')).toBeUndefined() // no such day
    expect(namedDay('문서/20261013-문의.md')).toBeUndefined()
    expect(namedDay('문서/2026-10-130.md')).toBeUndefined()
    expect(namedDay('2026-10-13/문의.md')).toBeUndefined() // a folder's name is not the file's
  })

  it('carries no name, value or path', () => {
    const text = JSON.stringify(counts)
    for (const secret of ['intake', 'bug', '담당', '긴급', '장비', '비밀', '환자', '문서', '.md']) expect(text).not.toContain(secret)
  })

  it('counts suggestions shown on this device beside the decisions', () => {
    const shown = (at: string, tpl: string, field: string): Presentation => ({ at, template: tpl, field, source: 'memory' })
    const withShown = weeklyCounts([notes, intake, bug], documents, events, [
      shown('2026-09-29T09:59:00.000Z', 'intake@1', '담당'),
      shown('2026-09-30T09:00:00.000Z', 'intake@1', '담당'), // shown, then rejected
      shown('2026-09-30T09:30:00.000Z', 'intake@1', '담당'), // shown, the draft let go
      shown('2026-10-20T09:00:00.000Z', 'bug@2', '원인'), // shown only
      shown('2026-10-20T09:00:00.000Z', 'intake@2', '담당'), // a version not in the vault: left out
    ])
    expect(withShown.counts.map(({ week, form, field, presented, accepted }) => [week, form, field, presented, accepted])).toEqual([
      ['2026-09-28', 2, 1, 3, 1],
      ['2026-09-28', 2, 2, 0, 0],
      ['2026-10-05', 2, 1, 0, 1],
      ['2026-10-19', 1, 1, 1, 0],
    ])
  })

  it('counts what was shown and decided by the characters typed when it was first shown, leaving out what did not say', () => {
    const at = '2026-10-20T09:00:00.000Z'
    const typedEvent = (kind: SuggestionEvent['kind'], typed?: number): SuggestionEvent => ({
      ...event(at, '문서/c.md', '원인', kind, null, 'bug@2'),
      ...(typed === undefined ? {} : { typed }),
    })
    const shown = (typed?: number): Presentation => ({ at, template: 'bug@2', field: '원인', source: 'key', ...(typed === undefined ? {} : { typed }) })
    const typed = weeklyCounts(
      [bug],
      [],
      [typedEvent('accept', 0), typedEvent('correct', 1), typedEvent('accept', 3), typedEvent('accept', 7), typedEvent('accept')],
      [shown(0), shown(1), shown(2), shown(3), shown(7), shown()],
    )
    const [cell] = typed.counts
    expect([cell.presented, cell.accepted, cell.corrected]).toEqual([6, 4, 1])
    expect(cell.byTyped).toEqual({
      '0': { presented: 1, decided: 1, accepted: 1 },
      '1': { presented: 1, decided: 1, accepted: 0 },
      '2': { presented: 1, decided: 0, accepted: 0 },
      '3+': { presented: 2, decided: 2, accepted: 2 },
    })
    expect(counts.counts[0].byTyped).toEqual({}) // events from before the count was kept are in no slot
  })

  it('counts how long each decision took from showing to taking or rejecting, by span', () => {
    const shownAt = '2026-10-20T09:00:00.000Z'
    const after = (ms: number) => new Date(Date.parse(shownAt) + ms).toISOString()
    const timed = (kind: SuggestionEvent['kind'], ms: number | undefined, typed: number, decidedTyped?: number): SuggestionEvent => ({
      ...event(shownAt, '문서/c.md', '원인', kind, null, 'bug@2'),
      typed,
      shownAt,
      ...(ms === undefined ? {} : { decidedAt: after(ms) }),
      ...(decidedTyped === undefined ? {} : { decidedTyped }),
    })
    const counted = weeklyCounts(
      [bug],
      [],
      [
        timed('accept', 300, 0, 0), // read and taken: under 0.5 s
        timed('accept', 2_500, 0, 2), // taken after two characters: 2 to 4 s
        timed('accept', 40_000, 0), // from before what was in the field was kept: in `accepted` alone
        timed('reject', 1_000, 0, 0), // exactly on an edge counts in the span it starts
        timed('correct', undefined, 0), // changed by hand, never taken or rejected: no time
        timed('accept', -5_000, 0, 0), // the clock moved back: no time
        timed('accept', 600, 1, 1),
      ],
    )
    expect(counted.dwellEdgesSec).toEqual([0.5, 1, 2, 4, 8, 16, 32])
    const { byTyped } = counted.counts[0]
    expect(byTyped['0'].dwell).toEqual({
      accepted: [1, 0, 0, 1, 0, 0, 0, 1],
      acceptedNoTyping: [1, 0, 0, 0, 0, 0, 0, 0],
      acceptedAfterTyping: [0, 0, 0, 1, 0, 0, 0, 0],
      other: [0, 0, 1, 0, 0, 0, 0, 0],
    })
    expect(byTyped['0'].decided).toBe(6) // the decisions without a time are still counted, outside `dwell`
    expect(byTyped['1'].dwell?.acceptedNoTyping).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
  })

  it('puts a time in the span whose edge it reached', () => {
    expect([0, 0.49, 0.5, 1.99, 2, 31.9, 32, 3600].map(dwellSpan)).toEqual([0, 0, 1, 2, 3, 6, 7, 7])
  })

  it('has no times for decisions that never said them', () => {
    expect(counts.counts.every((c) => Object.values(c.byTyped).every((slot) => slot.dwell === undefined))).toBe(true)
  })
})
