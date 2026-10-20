import { describe, expect, it } from 'vitest'
import { periodDays, planWords, queryPlan } from '../chat-query.ts'
import { countColumns, referringTemplates, templateSnapshot } from '../projection.ts'
import { documentNames } from '../references.ts'
import { strings } from '../strings.ts'

const fence = '```'
const fields = templateSnapshot(`---
id: visit
version: 1
---
@원인: [select options="부품,설정,사용자"]
@방문일(방문한 날): [date]
@지역: [text]
@접수(접수 시각): [datetime-local]
`).fields

describe('what a reply asks to count', () => {
  it('is the plan in its last block, checked against the template: fields by name or label, conditions the vault asks', () => {
    const reply = `${fence}json\n{"groupBy": ["원인"], "filters": [{"field": "방문한 날", "op": "atLeast", "value": "2026-09-01"}, {"field": "방문일", "op": "atMost", "value": "2026-09-30"}], "top": 2}\n${fence}`
    expect(queryPlan(reply, fields)).toEqual({
      plan: {
        groupBy: ['원인'],
        filters: [
          { column: '방문일', op: 'atLeast', value: '2026-09-01' },
          { column: '방문일', op: 'atMost', value: '2026-09-30' },
        ],
        top: 2,
      },
    })
  })

  it('counts everything when it names nothing, counts a field named twice once, and keeps a blank condition without a value', () => {
    expect(queryPlan('{"groupBy": []}', fields)).toEqual({ plan: { groupBy: [], filters: [] } })
    expect(queryPlan('{"groupBy": ["@원인", "원인"], "filters": [{"field": "지역", "op": "empty"}], "top": 0}', fields)).toEqual({
      plan: { groupBy: ['원인'], filters: [{ column: '지역', op: 'empty', value: '' }] },
    })
  })

  it('says why it is not a plan: none in the reply, a field the template does not have, a condition it cannot ask', () => {
    expect(queryPlan('세어 보겠습니다.', fields)).toEqual({ problem: 'no-plan' })
    expect(queryPlan('{"groupBy": ["담당"]}', fields)).toEqual({ problem: 'unknown-field', field: '담당' })
    expect(queryPlan('{"filters": [{"field": "원인", "op": "like", "value": "부"}]}', fields)).toEqual({ problem: 'bad-filter', field: '원인' })
    expect(queryPlan('{"filters": [{"field": "원인", "op": "equal", "value": "배터리"}]}', fields)).toEqual({ problem: 'bad-filter', field: '원인' })
    expect(queryPlan('{"filters": [{"field": "지역", "op": "contains", "value": " "}]}', fields)).toEqual({ problem: 'bad-filter', field: '지역' })
  })

  it('keeps a condition that a field is blank only when the question speaks of something blank', () => {
    const reply = '{"groupBy": ["원인"], "filters": [{"field": "지역", "op": "empty"}]}'
    expect(queryPlan(reply, fields, new Date(), undefined, [], '원인별로 몇 건?')).toEqual({ plan: { groupBy: ['원인'], filters: [] } })
    for (const question of ['지역이 비어 있는 것 원인별로?', '지역 안 적힌 기록은 원인별로?', '지역 없는 방문 원인별로'])
      expect(queryPlan(reply, fields, new Date(), undefined, [], question)).toEqual({
        plan: { groupBy: ['원인'], filters: [{ column: '지역', op: 'empty', value: '' }] },
      })
  })

  it('keeps a choice only when the question names it — as written, by its label, or without its part in parentheses', () => {
    const graded = templateSnapshot(`---
id: inspection
version: 1
---
@위험도: [select options="Risk 1 (High),Risk 2 (Medium)"]
@결과: [select options="pass=합격,fail=불합격"]
`).fields
    const asking = (filters: string, question: string) =>
      queryPlan(`{"groupBy": [], "filters": [${filters}]}`, graded, new Date(), undefined, [], question)
    const kept = (column: string, value: string) => ({ plan: { groupBy: [], filters: [{ column, op: 'equal', value }] } })
    expect(asking('{"field": "결과", "op": "equal", "value": "fail"}', '위험도별로 몇 건?')).toEqual({ plan: { groupBy: [], filters: [] } })
    expect(asking('{"field": "결과", "op": "equal", "value": "fail"}', '불합격은 몇 건?')).toEqual(kept('결과', 'fail'))
    expect(asking('{"field": "결과", "op": "equal", "value": "fail"}', 'FAIL 몇 건?')).toEqual(kept('결과', 'fail'))
    expect(asking('{"field": "위험도", "op": "equal", "value": "Risk 1 (High)"}', '위험도 높음(Risk 1) 검사는 몇 건?')).toEqual(kept('위험도', 'Risk 1 (High)'))
  })

  it('passes on that the question cannot be counted from the template, as the model put it', () => {
    expect(queryPlan('{"unanswerable": "담당자 칸이 없습니다"}', fields)).toEqual({ unanswerable: '담당자 칸이 없습니다' })
  })

  it('turns a period of a date field into its first and last day from today: the model never works out a date', () => {
    const wednesday = new Date(2026, 9, 14)
    expect(queryPlan('{"groupBy": ["원인"], "filters": [{"field": "방문일", "op": "period", "value": "last-month"}]}', fields, wednesday)).toEqual({
      plan: {
        groupBy: ['원인'],
        filters: [
          { column: '방문일', op: 'atLeast', value: '2026-09-01' },
          { column: '방문일', op: 'atMost', value: '2026-09-30' },
        ],
      },
    })
    // Of a date-and-time field, from the start of the first day to the end of the last.
    expect(queryPlan('{"filters": [{"field": "접수", "op": "period", "value": "today"}]}', fields, wednesday)).toEqual({
      plan: { groupBy: [], filters: [{ column: '접수', op: 'atLeast', value: '2026-10-14T00:00' }, { column: '접수', op: 'atMost', value: '2026-10-14T23:59:59' }] },
    })
    // Only a date field has days, and only the periods the app knows are periods.
    expect(queryPlan('{"filters": [{"field": "지역", "op": "period", "value": "this-week"}]}', fields, wednesday)).toEqual({ problem: 'bad-filter', field: '지역' })
    expect(queryPlan('{"filters": [{"field": "방문일", "op": "period", "value": "last-quarter"}]}', fields, wednesday)).toEqual({ problem: 'bad-filter', field: '방문일' })
  })

  it('knows each period by the calendar: weeks from Monday, months and years whole, across a year end', () => {
    const wednesday = new Date(2026, 9, 14)
    expect(periodDays('today', wednesday)).toEqual({ from: '2026-10-14', to: '2026-10-14' })
    expect(periodDays('yesterday', wednesday)).toEqual({ from: '2026-10-13', to: '2026-10-13' })
    expect(periodDays('this-week', wednesday)).toEqual({ from: '2026-10-12', to: '2026-10-18' })
    expect(periodDays('last-week', wednesday)).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(periodDays('this-month', wednesday)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(periodDays('this-year', wednesday)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(periodDays('last-year', wednesday)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    const sunday = new Date(2026, 0, 4)
    expect(periodDays('this-week', sunday)).toEqual({ from: '2025-12-29', to: '2026-01-04' })
    expect(periodDays('last-month', sunday)).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(periodDays('yesterday', new Date(2026, 2, 1))).toEqual({ from: '2026-02-28', to: '2026-02-28' })
  })

  it('knows a month or a year named by its number, and nothing else', () => {
    const today = new Date(2026, 9, 14)
    expect(periodDays('2025-12', today)).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(periodDays('2024-02', today)).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(periodDays('2025', today)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    for (const not of ['2025-13', '2025-1', '25-12', 'last-quarter', '']) expect(periodDays(not, today)).toBeNull()
    expect(queryPlan('{"groupBy": ["지역"], "filters": [{"field": "방문일", "op": "period", "value": "2025-12"}]}', fields, today)).toEqual({
      plan: { groupBy: ['지역'], filters: [{ column: '방문일', op: 'atLeast', value: '2025-12-01' }, { column: '방문일', op: 'atMost', value: '2025-12-31' }] },
    })
  })
})

describe('what a plan counts, in words', () => {
  it('says which documents, by what, and how many — fields by their labels, a range as one', () => {
    const plan = {
      groupBy: ['원인'],
      filters: [
        { column: '방문일', op: 'atLeast' as const, value: '2026-09-01' },
        { column: '지역', op: 'contains' as const, value: '서울' },
        { column: '방문일', op: 'atMost' as const, value: '2026-09-30' },
      ],
      top: 3,
    }
    expect(planWords(plan, fields)).toBe('방문한 날 2026-09-01 ~ 2026-09-30 · 지역에 「서울」 포함 · 원인별 · 많은 것 3개')
    expect(planWords({ groupBy: [], filters: [] }, fields)).toBe('모든 기록')
    expect(planWords({ groupBy: ['지역'], filters: [{ column: '원인', op: 'empty', value: '' }, { column: '방문일', op: 'atMost', value: '2026-09-30' }] }, fields)).toBe(
      '원인 비어 있음 · 방문한 날 2026-09-30까지 · 지역별',
    )
  })
})

describe('what a reply asks to count through a reference', () => {
  const customer = templateSnapshot(`---
id: customer
version: 2
---
@이름: [text]
@지역: [select options="서울,부산"]
@담당자 -> staff: [select]
`)
  const inquiry = templateSnapshot(`---
id: inquiry
version: 1
---
@고객 -> customer: [select]
@담당: [select options="장비,인사"]
@접수일: [date]
`)
  const columns = countColumns(inquiry, [customer, inquiry])

  it("counts by the fields of the documents a field refers to, one step: the other template's own references are not followed", () => {
    expect(columns.filter((c) => c.via).map((c) => [c.name, c.label, c.type, c.options])).toEqual([
      ['고객.이름', '고객.이름', 'text', []],
      ['고객.지역', '고객.지역', 'select', ['서울', '부산']],
    ])
    expect(countColumns(inquiry, [inquiry]).filter((c) => c.via)).toEqual([]) // a template the vault does not have
  })

  it('checks a referred field as its own template has it — a choice one of its choices', () => {
    const reply = (filters: string) => `${fence}json\n{"groupBy": ["담당"], "filters": [${filters}]}\n${fence}`
    expect(queryPlan(reply('{"field": "고객.지역", "op": "equal", "value": "서울"}'), columns)).toEqual({
      plan: { groupBy: ['담당'], filters: [{ column: '고객.지역', op: 'equal', value: '서울' }] },
    })
    expect(queryPlan(reply('{"field": "고객.지역", "op": "equal", "value": "대구"}'), columns)).toEqual({ problem: 'bad-filter', field: '고객.지역' })
    expect(queryPlan(reply('{"field": "고객.담당자", "op": "empty"}'), columns)).toEqual({ problem: 'unknown-field', field: '고객.담당자' })
  })

  it('keeps a document named by its name in the field that refers to it as its id, and says it by its name', () => {
    const names = documentNames([
      { path: '문서/가나상사.md', id: 'c-1', template: 'customer@2', values: {} },
      { path: '문서/다라무역.md', id: '문서/다라무역.md', template: 'customer@2', values: {} },
      // A document the app named after its day is named without it too.
      { path: '문서/2026-10-01-마바산업.md', id: 'c-5', template: 'customer@2', values: {} },
      // Two of one name in one template: the name says neither.
      { path: '서식2/같은이름.md', id: 'c-3', template: 'customer@2', values: {} },
      { path: '서식3/같은이름.md', id: 'c-4', template: 'customer@2', values: {} },
    ])
    const reply = (value: string) => `${fence}json
{"filters": [{"field": "고객", "op": "equal", "value": "${value}"}]}
${fence}`
    const kept = queryPlan(reply('가나상사'), columns, new Date(), names)
    expect(kept).toEqual({ plan: { groupBy: [], filters: [{ column: '고객', op: 'equal', value: 'c-1' }] } })
    expect('plan' in kept && planWords(kept.plan, columns, names)).toBe(strings.queryEqual('고객', '가나상사'))
    expect(queryPlan(reply('마바산업'), columns, new Date(), names)).toEqual({ plan: { groupBy: [], filters: [{ column: '고객', op: 'equal', value: 'c-5' }] } })
    // A name no document has, or two have, is kept as said: it counts what the vault holds under it — none.
    for (const said of ['없는회사', '같은이름'])
      expect(queryPlan(reply(said), columns, new Date(), names)).toEqual({ plan: { groupBy: [], filters: [{ column: '고객', op: 'equal', value: said }] } })
  })
})

describe('what a reply asks to count of the documents that refer to the ones asked about', () => {
  const customer = templateSnapshot(`---
id: customer
version: 1
---
@이름: [text]
@지역: [select options="서울,부산"]
`)
  const inquiry = templateSnapshot(`---
id: inquiry
version: 1
---
@고객 -> customer: [select]
@분류: [select options="배송,반품"]
`)
  const other = templateSnapshot(`---
id: memo
version: 1
---
@상위 -> memo: [select]
@글: [text]
`)
  const referring = referringTemplates(customer, [customer, inquiry, other]).map(({ template, via }) => ({
    ref: template.ref,
    name: '문의',
    via,
    columns: countColumns(template, [customer, inquiry]),
  }))

  it('are the other templates whose fields name them, one document each, with those fields', () => {
    expect(referringTemplates(customer, [customer, inquiry, other]).map((r) => [r.template.ref, r.via])).toEqual([['inquiry@1', ['고객']]])
    // A template's documents naming its own are not another template's.
    expect(referringTemplates(other, [customer, inquiry, other])).toEqual([])
  })

  it('counts the template it names — by its name or id — checked against that template, back through its reference too', () => {
    const reply = (asked: string) => `${fence}json\n${asked}\n${fence}`
    const most = { plan: { groupBy: ['고객'], filters: [], top: 3, of: 'inquiry@1' } }
    expect(queryPlan(reply('{"of": "문의", "groupBy": ["고객"], "top": 3}'), customer.fields, new Date(), undefined, referring)).toEqual(most)
    expect(queryPlan(reply('{"of": "inquiry", "groupBy": ["고객"], "top": 3}'), customer.fields, new Date(), undefined, referring)).toEqual(most)
    expect(
      queryPlan(reply('{"of": "문의", "groupBy": ["고객"], "filters": [{"field": "고객.지역", "op": "equal", "value": "서울"}, {"field": "분류", "op": "equal", "value": "반품"}]}'), customer.fields, new Date(), undefined, referring),
    ).toEqual({
      plan: {
        groupBy: ['고객'],
        filters: [
          { column: '고객.지역', op: 'equal', value: '서울' },
          { column: '분류', op: 'equal', value: '반품' },
        ],
        of: 'inquiry@1',
      },
    })
    // A template that does not refer to it is not counted for it.
    expect(queryPlan(reply('{"of": "메모", "groupBy": []}'), customer.fields, new Date(), undefined, referring)).toEqual({ problem: 'unknown-template', template: '메모' })
    // Without `of`, the asked template is counted as before.
    expect(queryPlan(reply('{"groupBy": ["지역"]}'), customer.fields, new Date(), undefined, referring)).toEqual({ plan: { groupBy: ['지역'], filters: [] } })
  })

  it("counts the referring template when the reply counts by its fields without naming it, and reaches the asked template's fields through the field naming them", () => {
    const reply = (asked: string) => `${fence}json
${asked}
${fence}`
    const of = (asked: string) => queryPlan(reply(asked), customer.fields, new Date(), undefined, referring)
    // Fields only the inquiries have: the inquiries are counted.
    expect(of('{"groupBy": ["고객"], "filters": [{"field": "분류", "op": "equal", "value": "반품"}]}')).toEqual({
      plan: { groupBy: ['고객'], filters: [{ column: '분류', op: 'equal', value: '반품' }], of: 'inquiry@1' },
    })
    // A customer's field among them is the inquiry's way to it.
    expect(of('{"groupBy": ["지역", "분류"]}')).toEqual({ plan: { groupBy: ['고객.지역', '분류'], filters: [], of: 'inquiry@1' } })
    expect(of('{"of": "문의", "groupBy": ["지역"]}')).toEqual({ plan: { groupBy: ['고객.지역'], filters: [], of: 'inquiry@1' } })
    // Fields the customers have are the customers' own count.
    expect(of('{"groupBy": ["지역"]}')).toEqual({ plan: { groupBy: ['지역'], filters: [] } })
    // A field neither has is said as it was.
    expect(of('{"groupBy": ["담당자"]}')).toEqual({ problem: 'unknown-field', field: '담당자' })
  })

  it('says the template it counted', () => {
    const plan = { groupBy: ['고객'], filters: [{ column: '분류', op: 'equal' as const, value: '반품' }], top: 3, of: 'inquiry@1' }
    expect(planWords(plan, referring[0].columns, undefined, '문의')).toBe(
      [strings.queryOf('문의'), strings.queryEqual('분류', '반품'), strings.queryBy(['고객']), strings.queryTop(3)].join(' · '),
    )
    expect(planWords({ groupBy: ['고객'], filters: [], of: 'inquiry@1' }, referring[0].columns, undefined, '문의')).toBe(
      [strings.queryAllOf('문의'), strings.queryBy(['고객'])].join(' · '),
    )
  })
})

describe('what a reply asks to add up', () => {
  const request = templateSnapshot(`---
id: request
version: 1
---
@이름: [text]
`)
  const item = templateSnapshot(`---
id: item
version: 1
---
@청구서 -> request: [select]
@품명: [text]
@수량: [number]
@단가: [number]
@금액: [number compute="수량 * 단가"]
`)
  const referring = referringTemplates(request, [request, item]).map(({ template, via }) => ({
    ref: template.ref,
    name: '청구 품목',
    via,
    columns: countColumns(template, [request, item]),
  }))

  it('adds up a number field it names, beside the counts', () => {
    expect(queryPlan('{"groupBy": ["청구서"], "sum": "금액"}', item.fields)).toEqual({ plan: { groupBy: ['청구서'], filters: [], sum: '금액' } })
    // A sum left empty is no sum.
    expect(queryPlan('{"groupBy": [], "sum": ""}', item.fields)).toEqual({ plan: { groupBy: [], filters: [] } })
  })

  it('adds up only a number field the template has: one of another kind is left out, the count kept', () => {
    expect(queryPlan('{"groupBy": [], "sum": "품명"}', item.fields)).toEqual({ plan: { groupBy: [], filters: [] } })
    expect(queryPlan('{"groupBy": [], "sum": "합계"}', item.fields)).toEqual({ problem: 'unknown-field', field: '합계' })
  })

  it("adds up the referring template's field per document asked about — named, or reached by the field alone", () => {
    const perRequest = { plan: { groupBy: ['청구서'], filters: [], of: 'item@1', sum: '금액' } }
    expect(queryPlan('{"of": "청구 품목", "groupBy": ["청구서"], "sum": "금액"}', request.fields, new Date(), undefined, referring)).toEqual(perRequest)
    expect(queryPlan('{"groupBy": ["청구서"], "sum": "금액"}', request.fields, new Date(), undefined, referring)).toEqual(perRequest)
  })

  it('says what it adds up, and that the largest sums come first', () => {
    expect(planWords({ groupBy: ['청구서'], filters: [], sum: '금액', top: 3 }, item.fields)).toBe(
      [strings.queryAll, strings.queryBy(['청구서']), strings.querySumOf('금액'), strings.queryTopSum(3)].join(' · '),
    )
  })
})
