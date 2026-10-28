import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { q } from '../app.mjs'
import { BUG, INTAKE, documentsIn, events, presentations, fileValues } from '../shared.mjs'

// Fields settled together (`suggest:together`): templates written into the vault with the documents they are learned from,
// as a person's own would be, and left again before the next scenario.
const ROUTING = { name: '결재', ref: 'routing@1', path: '서식/결재.fd.md' }
const ROUTING_BODY =
  '# 결재\n\n요청: ___@요청\n\n@부서: [select options="영업,개발,인사"]\n\n' +
  '@담당: [select options="장비,인사,총무" suggest:role=judged suggest:evidence=false suggest:together=결재]\n\n' +
  '@승인: [select options="김,이,박" suggest:role=judged suggest:evidence=false suggest:together=결재]\n'
const CODING = { name: '업체', ref: 'coding@1', path: '서식/업체.fd.md' }
const CODING_BODY =
  '# 업체\n\n@회사: [select options="은행,상점,병원,지점"]\n\n' +
  '@산업: [select options="금융,유통,보건" suggest:role=judged suggest:together=코딩]\n\n' +
  '@직업: [select options="분석가,점원,간호사,창구" suggest:role=judged suggest:together=코딩]\n'
const DEPARTMENTS = ['영업', '개발', '인사']
const OWNERS = ['장비', '인사', '총무']
const APPROVERS = ['김', '이', '박']

/** Runs `run` with the template written into the vault and its documents learned from, then takes both away. */
async function learnedFrom(app, vault, template, body, rows, run) {
  const path = join(vault, template.path)
  await writeFile(path, `---\nid: ${template.ref.split('@')[0]}\nversion: 1\n---\n${body}`)
  const names = []
  for (const [i, values] of rows.entries()) {
    const name = `${template.name}-${i + 1}.md`
    names.push(name)
    const fields = Object.entries(values).map(([k, v]) => `${k}: ${v}`).join('\n')
    await writeFile(join(vault, '문서', name), `---\ntemplate: ${template.ref}\n${fields}\n---\n${body}`)
  }
  const before = new Set(await documentsIn(vault))
  try {
    await app.sidebar(template.name, { timeoutMs: 60_000 })
    await run()
  } finally {
    // Left before it goes: removed while open, a document is said to be gone outside. A scenario that failed with
    // a form half filled in leaves by throwing the edits away, so the failure it ended on is the one reported.
    const unsaved = await app.cdp.evaluate(`__e2e.all('dc-confirm-dialog').some((d) => d.open)`)
    if (!unsaved) await app.templateOf(BUG).catch(() => {})
    if (unsaved || (await app.cdp.evaluate(`__e2e.all('dc-confirm-dialog').some((d) => d.open)`))) {
      await app.answerUnsaved('편집 버리기')
      await app.templateOf(BUG)
    }
    for (const name of (await documentsIn(vault)).filter((n) => !before.has(n) || names.includes(n))) await rm(join(vault, '문서', name), { force: true })
    await rm(path, { force: true })
  }
  await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '${template.name}')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
}

/**
 * Waits until the sidecar answers for `field`, given `values`, as `expected` says ({ value } or { reason }). It chooses its
 * thresholds away from the ingest of the files just written, which it is given when a document of the template is opened; and a
 * document is asked about once per pause in typing, so what is entered before they are in use keeps the answer it got.
 */
async function untilSidecarAnswers(app, ref, field, values, expected, timeoutMs = 120_000) {
  const request = JSON.stringify({ template: ref, field, values })
  const start = Date.now()
  let last
  for (;;) {
    last = await app.cdp.evaluate(`(async () => { try { const s = await window.__TAURI_INTERNALS__.invoke('host_suggest', { request: ${request} }); return JSON.stringify({ value: s.value, reason: s.reason }) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    const got = JSON.parse(last)
    if (Object.entries(expected).every(([k, v]) => got[k] === v)) return
    if (Date.now() - start > timeoutMs) assert.fail(`the sidecar did not answer ${JSON.stringify(expected)} for ${field} within ${timeoutMs / 1000} s; last: ${last}`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** What is said under a field (its quiet notes, joined), and the value it offers to take — null when it offers none. */
const saidUnder = (app, field) =>
  app.cdp.evaluate(`__e2e.all('[data-formdown-note="${field}"]').map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | ')`)
const offeredFor = (app, field) => app.cdp.evaluate(`__e2e.one('[data-formdown-note="${field}"] .formdown-suggestion')?.textContent ?? null`)

export default {
  async 'suggests a judgment value from confirmed documents, and saves it once accepted'(app, vault) {
    const before = new Set(await documentsIn(vault))
    await app.newDocument(INTAKE)
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
    await app.fill('[data-field-name="요청"]', '노트북 화면이 어두워요')
    await app.choose('select[name="부서"]', '영업')
    // The suggestion is drawn by the field it is for: its value to take, what it rests on, and a way to decline.
    const note = await app.cdp.waitFor(
      `__e2e.all('[data-formdown-note="담당"]').filter((el) => el.querySelector('.formdown-suggestion')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim())[0]`,
      'a suggestion for 담당',
      { timeoutMs: 15_000 },
    )
    assert.match(note, /^제안 · 함께 확정된 값: 부서: 영업/)
    assert.equal(await app.cdp.evaluate(`__e2e.one('.formdown-suggestion')?.textContent`), '장비')
    assert.equal(await app.cdp.evaluate(`__e2e.one('.formdown-decline')?.textContent`), '거절')
    assert.equal(await app.value('select[name="담당"]'), '', 'nothing is filled in before it is accepted')
    await app.click('.formdown-suggestion', '장비')
    await app.cdp.waitFor(`__e2e.one('select[name="담당"]')?.value === '장비'`, 'the accepted value in the form')
    // Straight after the click: the offered value is gone, and Ctrl+S still saves.
    await app.cdp.press('s', { code: 'KeyS', modifiers: 2, keyCode: 83 })
    await app.status('저장했습니다')
    await app.noAlert()

    const created = (await documentsIn(vault)).filter((n) => !before.has(n))
    assert.equal(created.length, 1)
    const values = await fileValues(join(vault, '문서', created[0]))
    assert.equal(values.담당, '장비')
    assert.equal(values.요청, '노트북 화면이 어두워요')

    const [accepted] = await events(vault)
    // The event names the document by its id, not by where its file is.
    assert.deepEqual(
      { doc: accepted.doc, field: accepted.field, kind: accepted.kind, suggested: accepted.suggested, value: accepted.value },
      { doc: values.lowline.id, field: '담당', kind: 'accept', suggested: '장비', value: '장비' },
    )
    // What it rested on: the value it was settled alongside.
    assert.equal(accepted.recall, '부서: 영업')
    // When it was shown and taken, and what was filled by then — names only.
    assert.equal(accepted.template, 'intake@1')
    // The suggestion may first show after 요청 alone or after both: either way, in the order they were filled.
    assert.ok(['["요청"]', '["요청","부서"]'].includes(JSON.stringify(accepted.filled)), JSON.stringify(accepted.filled))
    assert.ok(Date.parse(accepted.shownAt) <= Date.parse(accepted.decidedAt), 'shown before it was taken')
    assert.ok(Date.parse(accepted.decidedAt) <= Date.parse(accepted.at), 'taken before the save confirmed it')
    // What was shown is kept on this device, outside the vault, without the value.
    const shown = await presentations()
    assert.ok(shown.some((p) => p.template === 'intake@1' && p.field === '담당' && p.at === accepted.shownAt), JSON.stringify(shown))
    assert.ok(!JSON.stringify(shown).includes('장비'), 'no value in the record of what was shown')
  },

  async 'records a rejected suggestion when the document is saved without it'(app, vault) {
    await app.newDocument(INTAKE)
    // A new document from the same template starts empty: nothing carries over from the last one.
    await app.cdp.waitFor(
      `__e2e.one('select[name="부서"]')?.value === '' && __e2e.one('[data-field-name="요청"]')?.textContent === ''`,
      'an empty form',
    )
    await app.fill('[data-field-name="요청"]', '급여 명세서를 다시 받고 싶어요')
    await app.choose('select[name="부서"]', '개발')
    await app.cdp.waitFor(`__e2e.all('.formdown-suggestion').length === 1`, 'a suggestion for 담당', { timeoutMs: 15_000 })
    await app.click('.formdown-decline', '거절')
    await app.cdp.waitFor(`__e2e.all('[data-formdown-note]').length === 0`, 'the suggestion to be set aside')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    await app.noAlert()

    await app.cdp.evaluate(`new Promise((resolve) => setTimeout(resolve, 1000))`)
    assert.equal(await app.cdp.evaluate(`__e2e.all('.formdown-suggestion').length`), 0, 'a rejected suggestion does not come back after saving')
    const all = await events(vault)
    assert.equal(all.length, 2, 'one event per confirmation, not per save')
    assert.deepEqual([all[1].kind, all[1].suggested, all[1].value], ['reject', '인사', null])

    // Reopened, the document still has the rejection: the sidecar learned it from the event file.
    // Opening it again starts a fresh draft: nothing of the last one is kept in the window.
    const rejectedIn = []
    for (const name of await documentsIn(vault)) {
      if ((await fileValues(join(vault, '문서', name))).lowline?.id === all[1].doc) rejectedIn.push(name)
    }
    assert.equal(rejectedIn.length, 1, 'the event names one document by its id')
    await app.pickDocument(rejectedIn[0].replace(/\.md$/, ''))
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent.includes('급여')`, 'the reopened document')
    await app.cdp.evaluate(`new Promise((resolve) => setTimeout(resolve, 2000))`)
    assert.equal(await app.cdp.evaluate(`__e2e.all('.formdown-suggestion').length`), 0, 'a rejected suggestion is not offered on reopening')
  },
  async 'shows nothing when the values filled in settle nothing, not even a similar record'(app, vault) {
    await app.newDocument(INTAKE)
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
    // Nearly a confirmed request word for word, with no 부서: a similar record is not offered as a suggestion.
    await app.fill('[data-field-name="요청"]', '모니터가 깜빡여요!')
    // Suggestions are asked for once typing pauses; this waits well past that and the answer.
    await app.cdp.evaluate(`new Promise((resolve) => setTimeout(resolve, 2500))`)
    assert.equal(await app.cdp.evaluate(`__e2e.all('.formdown-suggestion').length`), 0, 'no suggestion is made up')
    assert.equal(await app.value('select[name="담당"]'), '', 'nothing is filled in')
    // Why the field is empty is said, with how much it has to learn from.
    const why = await app.cdp.evaluate(`__e2e.all('[data-formdown-note="담당"]').map((el) => el.textContent.trim())[0]`)
    assert.equal(why, '지금 입력한 값들로는 함께 확정된 값이 정해지지 않아 비워 둡니다.')

    // Saving it records no suggestion event: nothing was offered, so nothing was decided.
    const eventsBefore = (await events(vault)).length
    const documentsBefore = new Set(await documentsIn(vault))
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal((await events(vault)).length, eventsBefore, 'no suggestion event')
    const [saved] = (await documentsIn(vault)).filter((n) => !documentsBefore.has(n))
    assert.ok(saved, 'the document is saved')
    assert.ok(!(await fileValues(join(vault, '문서', saved))).담당, 'the file has no 담당 either')
    await app.noAlert()
  },
  async 'rebuilds the same table and the same suggestion after a restart, from its cache or from the vault alone'(app, vault) {
    const tableNow = async () => {
      await app.showTable(INTAKE)
      return app.cdp.waitFor(
        `(() => { const rows = __e2e.all('tbody tr'); const text = rows.map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim()); return text.some((t) => t.includes('급여')) && text })()`,
        'the intake table',
        { timeoutMs: 30_000 },
      )
    }
    const suggestionNow = async () => {
      await app.newDocument(INTAKE)
      await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
      await app.fill('[data-field-name="요청"]', '노트북 배터리가 또 금방 닳아요')
      await app.choose('select[name="부서"]', '영업')
      return app.cdp.waitFor(
        `__e2e.all('.formdown-suggestion').map((el) => el.closest('[data-formdown-note]').textContent.replace(/\\s+/g, ' ').trim())[0]`,
        'a suggestion for 담당',
        { timeoutMs: 30_000 },
      )
    }

    const table = await tableNow()
    const suggestion = await suggestionNow()
    assert.equal(table.length, 18, 'fifteen fixture records and the three made above')

    await app.reopen(vault)
    assert.deepEqual(await tableNow(), table, 'the same table from the cache')
    assert.equal(await suggestionNow(), suggestion, 'the same suggestion')

    await app.reopen(vault, { dropCaches: true })
    assert.deepEqual(await tableNow(), table, 'the same table from the vault alone')
    assert.equal(await suggestionNow(), suggestion, 'the same suggestion from the vault alone')
    await app.noAlert()
  },
  async 'asks before dropping unsaved edits'(app) {
    // The scenario before left a new document typed into and not saved.
    await app.documentsOf(INTAKE)
    const typed = await app.cdp.evaluate(`__e2e.one('[data-field-name="요청"]')?.textContent`)
    assert.ok(typed, 'an unsaved draft is open')

    await app.pickDocument('접수-1')
    await app.answerUnsaved('계속 편집')
    assert.equal(await app.cdp.evaluate(`__e2e.one('[data-field-name="요청"]')?.textContent`), typed, 'the edits are kept')

    // Another template or another tab asks too; keeping the edits keeps the sidebar and the tab where they are.
    await app.sidebar(BUG.name)
    await app.answerUnsaved('계속 편집')
    await app.click('button[role="tab"]', '표')
    await app.answerUnsaved('계속 편집')
    assert.deepEqual(await app.where(), { place: INTAKE.name, tab: '문서' }, 'still where the edits are')
    assert.equal(await app.cdp.evaluate(`__e2e.one('[data-field-name="요청"]')?.textContent`), typed, 'the edits are still kept')

    await app.pickDocument('접수-1')
    await app.answerUnsaved('편집 버리기')
    await app.cdp.waitFor(`__e2e.one('nav button[aria-current="true"]')?.textContent.trim() === '접수-1'`, 'the other document open')
    await app.noAlert()
  },
  async 'imports rows copied from a spreadsheet as confirmed records'(app, vault) {
    const before = new Set(await documentsIn(vault))
    // How many records the replay of 담당 asked before the import — earlier scenarios have saved some, and its replay may
    // still be running in the background: at least that many once there is one.
    const asked = await app.cdp.waitFor(
      `(async () => (await window.__TAURI_INTERNALS__.invoke('host_curves')).find((c) => c.template?.startsWith('intake@') && c.field === '담당')?.replay?.lookups)()`,
      'a replay of 접수 · 담당',
      { timeoutMs: 30_000 },
    )
    await app.documentsOf(INTAKE)
    await app.click('dc-button', '가져오기')
    const rows = [
      ['번호', '접수일', '요청', '부서', '담당', '비고'],
      ['A-1', '2026-01-15', '프린터 토너가 떨어졌어요', '영업', '총무', '지난달'],
      // A cell with a line break comes quoted, the way spreadsheets copy it.
      ['A-2', '2026. 1. 16.', '"회의실 프로젝터가\n안 켜져요"', '개발', '경비', ''],
      ['', '', '', '', '', '비고만 있는 행'],
    ]
    const text = rows.map((r) => r.join('\t')).join('\n')
    const zone = `__e2e.all('textarea').find((t) => t.getRootNode().host?.localName === 'dc-paste-rows-zone')`
    await app.cdp.waitFor(`Boolean(${zone})`, 'the paste zone')
    await app.cdp.evaluate(`(() => {
      const data = new DataTransfer()
      data.setData('text/plain', ${q(text)})
      ${zone}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      return true
    })()`)
    await app.status('문서 2건을 만듭니다 · 빈 행 1개는 건너뜁니다')
    assert.ok(
      await app.cdp.evaluate(`__e2e.all('li').some((li) => li.textContent.trim() === '3행 담당: 경비')`),
      'a value the field does not offer is shown',
    )
    // Columns that fill no field: the day each record was made, its code, and one left out.
    assert.deepEqual(
      await app.cdp.evaluate(`__e2e.all('td select').map((s) => s.value)`),
      ['name', 'date', ''],
      'a column of codes names the records, a column of days dates them, the rest is not imported',
    )
    await app.click('dc-button', '2건 가져오기')
    await app.status('2건을 가져왔습니다')
    await app.noAlert()

    const created = (await documentsIn(vault)).filter((n) => !before.has(n))
    assert.equal(created.length, 2, 'one document per row that fills a field')
    assert.deepEqual(
      created.map((n) => n.slice(0, 15)).sort(),
      ['2026-01-15-A-1 ', '2026-01-16-A-2 '],
      'named by the day each record was made and its code',
    )
    const values = await Promise.all(created.map((n) => fileValues(join(vault, '문서', n))))
    const toner = values.find((v) => v.요청 === '프린터 토너가 떨어졌어요')
    assert.deepEqual([toner?.template, toner?.부서, toner?.담당], ['intake@1', '영업', '총무'])
    assert.equal(values.find((v) => v.요청 === '회의실 프로젝터가\n안 켜져요')?.담당, '경비', 'kept as written, line break and all')

    // Imported records are confirmed values: what is learned replays the two imported with the rest. (A request seen
    // once settles nothing by itself here: 부서 has decided 담당 all along, and the imported rows go against it.)
    await app.learning()
    const replay = `(() => { const h = __e2e.all('h2').find((el) => el.textContent.trim() === '접수 · 담당'); const t = h?.parentElement.querySelector('.replay')?.textContent.replace(/\\s+/g, ' ').trim(); const n = Number(/^저장된 (\\d+)건/.exec(t ?? '')?.[1]); return n >= ${asked + 2} && t })()`
    await app.cdp.waitFor(replay, 'the replay of 접수 · 담당 with the imported records', { timeoutMs: 30_000 })

    // Left as the next scenario starts: a new document typed into.
    await app.documentsOf(INTAKE)
    await app.newDocument(INTAKE)
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
    await app.fill('[data-field-name="요청"]', '프린터 토너가 떨어졌어요')
    await app.noAlert()
  },
  async 'shows how often suggestions were right, from the event files'(app, vault) {
    // The scenario before left a new document typed into: leaving it asks first.
    await app.learning()
    await app.answerUnsaved('편집 버리기')
    const figures = await app.cdp.waitFor(
      `(() => { const h = __e2e.all('h2').find((el) => el.textContent.trim() === '접수 · 담당'); return h && h.parentElement.querySelector('.figures').textContent.replace(/\\s+/g, ' ').trim() })()`,
      'the curve of 접수 · 담당',
      { timeoutMs: 30_000 },
    )
    const decided = (await events(vault)).filter((e) => e.field === '담당')
    const accepted = decided.filter((e) => e.kind === 'accept').length
    const rejected = decided.filter((e) => e.kind === 'reject').length
    assert.equal(decided.length, 2, 'one accepted and one rejected suggestion so far')
    assert.ok(figures.includes(`수락 ${accepted} · 교정 0 · 거절 ${rejected}`), figures)
    assert.ok(figures.includes('제안이 나온 2건 중 1건 맞음'), figures) // too few for a share
    // Each source of suggestions read apart, as the event files record it.
    for (const source of new Set(decided.map((e) => e.source))) {
      const of = decided.filter((e) => e.source === source)
      const name = source === 'key' ? '함께 확정된 값' : '비슷한 기록'
      const line = `${name}에서 낸 제안 ${of.length}건 중 ${of.filter((e) => e.kind === 'accept').length}건 수락`
      assert.ok(figures.includes(line), `${line} in ${figures}`)
    }
    assert.ok(decided.every((e) => e.template === 'intake@1'), 'events name their template')

    // Weekly counts to hand over by hand: numbers only, the form's name shown beside them but not in them.
    const counts = JSON.parse(
      await app.cdp.waitFor(`__e2e.all('details.counts pre')[0]?.textContent`, 'the weekly counts', { timeoutMs: 30_000 }),
    )
    assert.equal(counts.format, 'lowline-weekly-counts/1')
    const intake = counts.counts.filter((c) => c.form === 1 && c.field === 1)
    assert.equal(
      intake.reduce((n, c) => n + Object.values(c.bySource).reduce((m, s) => m + s.decided, 0), 0),
      decided.length,
      'every decision counted under its source',
    )
    assert.deepEqual(
      [intake.reduce((n, c) => n + c.accepted, 0), intake.reduce((n, c) => n + c.rejected, 0)],
      [accepted, rejected],
      'the decisions counted',
    )
    const presented = intake.reduce((n, c) => n + c.presented, 0)
    assert.ok(presented >= accepted + rejected, `each decision was shown first (${presented} shown)`)
    const text = JSON.stringify(counts)
    for (const secret of ['접수', '담당', 'intake', '문서', '장비', '인사']) assert.ok(!text.includes(secret), `no ${secret} in the counts`)
    const legend = await app.cdp.evaluate(`__e2e.all('details.counts li').map((li) => li.textContent.trim())`)
    assert.ok(legend[0].startsWith('서식 1 = 접수'), legend[0])
    await app.noAlert()
  },

  async 'holds a suggestion back now and then to check it, and records what was entered instead'(app, vault) {
    const before = new Set(await documentsIn(vault))
    const eventsBefore = (await events(vault)).length
    await app.holdBack(true)
    try {
      await app.newDocument(INTAKE)
      await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
      await app.fill('[data-field-name="요청"]', '프린터 용지가 걸려요')
      await app.choose('select[name="부서"]', '영업')
      // Drawn to check it: no value shown — not even a hint of it — and why is said, quietly.
      // What was said after 요청 alone (nothing settled yet) may still show until the answer for 부서 comes back.
      const note = await app.cdp.waitFor(
        `__e2e.all('[data-formdown-note="담당"]').map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).find((t) => t.startsWith('확인용'))`,
        'the note that 담당 is a check',
        { timeoutMs: 15_000 },
      )
      assert.match(note, /^확인용 — 이번에는 제안 없이 직접 입력해 주세요/)
      assert.equal(await app.cdp.evaluate(`__e2e.all('.formdown-suggestion').length`), 0, 'nothing to take')
      assert.equal(await app.value('select[name="담당"]'), '', 'nothing filled in')
      await app.choose('select[name="담당"]', '총무')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      await app.noAlert()

      const [checked] = (await events(vault)).slice(eventsBefore)
      assert.deepEqual(
        { field: checked.field, kind: checked.kind, suggested: checked.suggested, value: checked.value, probability: checked.probability },
        { field: '담당', kind: 'check', suggested: '장비', value: '총무', probability: 0.05 },
        'the value entered, with the one held back and the chance it was drawn with',
      )
      assert.equal((await events(vault)).length, eventsBefore + 1, 'one check, no decision about a suggestion')
    } finally {
      await app.holdBack(false)
      // Left before it goes: removed while open, a document is said to be gone outside.
      await app.learning()
      for (const name of (await documentsIn(vault)).filter((n) => !before.has(n))) await rm(join(vault, '문서', name))
    }
  },

  async 'leaves both of two fields settled together empty while one is unsure, whichever of them a person settles'(app, vault) {
    // 담당 follows from 부서; 승인 goes either way within a department. Neither is a clue for the other.
    const rows = Array.from({ length: 60 }, (_, i) => {
      const d = i % 3
      return { 요청: `요청 ${i}`, 부서: DEPARTMENTS[d], 담당: OWNERS[d], 승인: APPROVERS[(d + (Math.floor(i / 3) % 2)) % 3] }
    })
    await learnedFrom(app, vault, ROUTING, ROUTING_BODY, rows, async () => {
      await app.newDocument(ROUTING)
      await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
      await untilSidecarAnswers(app, ROUTING.ref, '담당', { 부서: '영업' }, { reason: 'together' })
      await app.fill('[data-field-name="요청"]', '결재 올립니다')
      await app.choose('select[name="부서"]', '영업')
      // The sure one is held back with the unsure one, and says so; the unsure one says why it has nothing.
      await app.cdp.waitFor(
        `__e2e.all('[data-formdown-note="담당"]').some((el) => el.textContent.includes('함께 정하는 칸이 아직 확실하지 않아 비웠습니다'))`,
        '담당 held back with 승인',
        { timeoutMs: 30_000 },
      )
      assert.match(await saidUnder(app, '승인'), /목표만큼 맞는다는 것을 아직 보이지 못해 제안하지 않습니다/)
      assert.equal(await offeredFor(app, '담당'), null)
      assert.equal(await offeredFor(app, '승인'), null)
      assert.equal(await app.cdp.evaluate(`__e2e.all('.formdown-suggestion').length`), 0, 'nothing to take')
      // The person settles the sure one: the unsure one is still unsure, so both stay empty.
      await app.choose('select[name="담당"]', '장비')
      await app.cdp.waitFor(`!__e2e.all('[data-formdown-note="담당"]').some((el) => el.textContent.includes('함께 정하는 칸'))`, '담당 settled, no longer held')
      assert.match(await saidUnder(app, '승인'), /목표만큼 맞는다는 것을 아직 보이지 못해 제안하지 않습니다/)
      assert.equal(await app.value('select[name="승인"]'), '', 'nothing filled in')
      assert.equal(await app.cdp.evaluate(`__e2e.all('.formdown-suggestion').length`), 0, 'nothing to take')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      await app.noAlert()
    })
  },

  async 'shows the sure field of a chain first and the one it keys once that is settled'(app, vault) {
    // A company has one industry; its occupation follows from the company within it — so the occupation waits on the industry.
    const table = [
      ['은행', '금융', '분석가'],
      ['상점', '유통', '점원'],
      ['병원', '보건', '간호사'],
      ['지점', '금융', '창구'],
      ['지점', '금융', '분석가'],
    ]
    const rows = Array.from({ length: 150 }, (_, i) => {
      const [회사, 산업, 직업] = table[i % 5]
      return { 회사, 산업, 직업 }
    })
    await learnedFrom(app, vault, CODING, CODING_BODY, rows, async () => {
      await app.newDocument(CODING)
      await app.cdp.waitFor(`__e2e.one('select[name="회사"]')?.value === ''`, 'an empty form')
      await untilSidecarAnswers(app, CODING.ref, '산업', { 회사: '은행' }, { value: '금융' })
      await app.choose('select[name="회사"]', '은행')
      // The industry is shown; the occupation, still waiting on it, holds nothing back.
      await app.cdp.waitFor(`__e2e.one('[data-formdown-note="산업"] .formdown-suggestion')?.textContent === '금융'`, 'the industry offered', { timeoutMs: 60_000 })
      assert.equal(await offeredFor(app, '직업'), null, 'the occupation is not offered before the industry is settled')
      assert.ok(!(await saidUnder(app, '산업')).includes('함께 정하는 칸'), 'the industry is not held back by the occupation')
      assert.ok(!(await saidUnder(app, '직업')).includes('함께 정하는 칸'), 'nor the occupation by the industry')
      // Settled by the person, the industry lets the occupation be asked.
      await app.click('[data-formdown-note="산업"] .formdown-suggestion', '금융')
      await app.cdp.waitFor(`__e2e.one('select[name="산업"]')?.value === '금융'`, 'the industry taken')
      await app.cdp.waitFor(`__e2e.one('[data-formdown-note="직업"] .formdown-suggestion')?.textContent === '분석가'`, 'the occupation offered once the industry is settled', { timeoutMs: 30_000 })
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      await app.noAlert()
    })
  },

  async 'holds a field back with the partner drawn to be checked, and does not count it as a check'(app, vault) {
    // Both follow from 부서, so both are sure; 담당 asked first is not drawn, its partner 승인 is.
    const rows = Array.from({ length: 60 }, (_, i) => {
      const d = i % 3
      return { 요청: `요청 ${i}`, 부서: DEPARTMENTS[d], 담당: OWNERS[d], 승인: APPROVERS[d] }
    })
    await learnedFrom(app, vault, ROUTING, ROUTING_BODY, rows, async () => {
      const eventsBefore = (await events(vault)).length
      await app.cdp.evaluate(`globalThis.lowlineRoll = ((rolls) => { let n = 0; return () => rolls[Math.min(n++, rolls.length - 1)] })([0.999999, 0, 0.999999])`)
      try {
        await app.newDocument(ROUTING)
        await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
        await untilSidecarAnswers(app, ROUTING.ref, '담당', { 부서: '개발' }, { value: '인사' })
        await app.fill('[data-field-name="요청"]', '결재 올립니다')
        await app.choose('select[name="부서"]', '개발')
        // 승인 is the check; 담당 is held back with it and says only that it is to be settled without a suggestion.
        await app.cdp.waitFor(`__e2e.all('[data-formdown-note="담당"]').some((el) => el.textContent.includes('이번에는 이 칸을 제안 없이 직접 정해 주세요'))`, '담당 held back with the check', { timeoutMs: 60_000 })
        await app.cdp.waitFor(`__e2e.all('[data-formdown-note="승인"]').some((el) => el.textContent.includes('확인용'))`, '승인 drawn to be checked')
        assert.equal(await app.cdp.evaluate(`__e2e.all('.formdown-suggestion').length`), 0, 'nothing to take')
        await app.choose('select[name="담당"]', '총무')
        await app.choose('select[name="승인"]', '박')
        await app.click('dc-button', '저장')
        await app.status('저장했습니다')
        await app.noAlert()
        // Only the drawn field is a check; the one held back with it is no check and no decision about a suggestion.
        const written = (await events(vault)).slice(eventsBefore).map((e) => `${e.field}:${e.kind}`)
        assert.deepEqual(written, ['승인:check'])
      } finally {
        await app.holdBack(false)
      }
    })
  },
}
