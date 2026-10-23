import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { q } from '../app.mjs'
import { BUG, INTAKE, documentsIn, events, presentations, fileValues } from '../shared.mjs'

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
      const note = await app.cdp.waitFor(
        `__e2e.all('[data-formdown-note="담당"]').map((el) => el.textContent.replace(/\\s+/g, ' ').trim())[0]`,
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
      for (const name of (await documentsIn(vault)).filter((n) => !before.has(n))) await rm(join(vault, '문서', name))
    }
  },
}
