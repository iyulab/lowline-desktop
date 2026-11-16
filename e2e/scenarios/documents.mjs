import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { EXPORTS, q } from '../app.mjs'
import { BUG, TITLE, documentsIn, fileValues, fileBody } from '../shared.mjs'

export default {
  async 'creates a document, edits it, and saves again in place'(app, vault) {
    await app.newDocument(BUG)
    // Looking at an empty field is not an edit: focus in and out leaves nothing to save.
    await app.cdp.waitFor(`(() => { const t = __e2e.one(${q(TITLE)}); if (!t) return false; t.focus(); t.blur(); return true })()`, 'the empty title')
    await app.cdp.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    assert.equal(await app.cdp.evaluate(`__e2e.one('dc-button', '저장').disabled`), true, 'a focus and blur alone leave Save off')
    await app.fill(TITLE, '저장 후 멈춤')
    await app.choose('select[name="심각도"]', '높음')
    await app.fill('textarea[name="재현_절차"]', '1. 문서를 연다\n2. 저장한다')
    await app.click('input[name="재현됨"]')
    await app.click('input[name="환경"][value="맥"]')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    await app.noAlert()

    const created = await documentsIn(vault)
    assert.equal(created.length, 1, 'one document created')
    const path = join(vault, '문서', created[0])
    assert.match(created[0], /^\d{4}-\d{2}-\d{2}-저장 후 멈춤\.md$/, 'named after the first text field')
    const { lowline, ...saved } = await fileValues(path)
    assert.match(lowline?.id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a new document names itself')
    assert.deepEqual(
      saved,
      { template: 'bug-report@1', 제목: '저장 후 멈춤', 심각도: '높음', 재현_절차: '1. 문서를 연다\n2. 저장한다', 재현됨: true, 환경: '맥' },
    )
    const bodyBefore = await fileBody(path)
    assert.match(bodyBefore, /# 버그 리포트/)

    await app.fill(TITLE, '저장 후 화면이 멈춤')
    // Saved again with Ctrl+S, from inside the field being typed in — as a template is.
    await app.cdp.press('s', { code: 'KeyS', modifiers: 2, keyCode: 83 })
    await app.status('저장했습니다')
    await app.noAlert()
    assert.deepEqual(await documentsIn(vault), created, 'saved in place, no new file')
    const values = await fileValues(path)
    assert.equal(values.제목, '저장 후 화면이 멈춤')
    assert.equal(values.심각도, '높음')
    assert.equal(values.재현됨, true, 'an untouched checkbox keeps its value through a save')
    assert.equal(values.환경, '맥')
    assert.equal(await app.value(TITLE), values.제목, 'screen = file')
    const bodyAfter = await fileBody(path)
    assert.equal(bodyAfter, bodyBefore, 'the body is untouched by a value change')
  },

  async 'reopens the saved document with the values from the file'(app, vault) {
    await app.cdp.send('Page.reload')
    await app.ready()
    await app.openVault(vault)
    const [name] = await documentsIn(vault)
    await app.openDocument(BUG, name.replace(/\.md$/, ''))
    const values = await fileValues(join(vault, '문서', name))
    await app.cdp.waitFor(`__e2e.one(${q(TITLE)})?.textContent === ${q(values.제목)}`, 'the title from the file')
    assert.equal(await app.value('select[name="심각도"]'), values.심각도)
    assert.equal(await app.value('textarea[name="재현_절차"]'), values.재현_절차)
    assert.equal(await app.checked('input[name="재현됨"]'), true, 'the checkbox reopens checked')
    assert.equal(await app.checked('input[name="환경"][value="맥"]'), true, 'the radio reopens on its value')

    // Unchecking is a value too: it must reach the file and come back unchecked.
    await app.click('input[name="재현됨"]')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal((await fileValues(join(vault, '문서', name))).재현됨, false)
    await app.cdp.send('Page.reload')
    await app.ready()
    await app.openVault(vault)
    await app.openDocument(BUG, name.replace(/\.md$/, ''))
    await app.cdp.waitFor(`__e2e.one(${q(TITLE)})?.textContent === ${q(values.제목)}`, 'the document again')
    assert.equal(await app.checked('input[name="재현됨"]'), false, 'the checkbox reopens unchecked')
    await app.noAlert()
  },

  async 'shows an edit made outside the app, and never replaces an unsaved one'(app, vault) {
    // The document is open from the scenario before, with nothing unsaved.
    const [name] = await documentsIn(vault)
    const path = join(vault, '문서', name)
    const severity = async (value) => writeFile(path, (await readFile(path, 'utf8')).replace(/^심각도: .*$/m, `심각도: ${value}`))

    await severity('낮음')
    await app.status('밖에서 바뀌어 다시 읽었습니다')
    assert.equal(await app.value('select[name="심각도"]'), '낮음', 'the open document shows the outside edit')

    // With an unsaved edit, an outside edit is announced and nothing typed is lost.
    await app.choose('select[name="심각도"]', '보통')
    await severity('높음')
    await app.cdp.waitFor(
      `__e2e.all('[role=alert]').some((el) => el.textContent.includes('밖에서 바뀌었습니다'))`,
      'the outside edit announced',
    )
    assert.equal(await app.value('select[name="심각도"]'), '보통', 'the unsaved edit is kept')

    // Saving decides. The save is the app's own write: it is not taken for an outside edit.
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal((await fileValues(path)).심각도, '보통')
    await app.cdp.evaluate(`new Promise((resolve) => setTimeout(resolve, 1500))`)
    await app.status('저장했습니다')
    await app.noAlert()

    // Or the person keeps what is on disk: reading it again drops the unsaved edit.
    await app.choose('select[name="심각도"]', '낮음')
    await severity('높음')
    await app.click('dc-button', '밖의 내용으로 다시 읽기')
    await app.status('밖에서 바뀌어 다시 읽었습니다')
    assert.equal(await app.value('select[name="심각도"]'), '높음', 'the outside edit is shown')
    assert.equal((await fileValues(path)).심각도, '높음', 'the file is left as the outside edit made it')

    // Saved straight after an outside edit the watch has not reported yet: the file is not overwritten unseen.
    // (It ends at 높음, as the scenarios after this one expect.)
    await app.choose('select[name="심각도"]', '보통')
    await severity('낮음')
    await app.click('dc-button', '저장')
    await app.cdp.waitFor(
      `__e2e.all('[role=alert]').some((el) => el.textContent.includes('밖에서 바뀌었습니다'))`,
      'the outside edit announced at saving',
    )
    assert.equal((await fileValues(path)).심각도, '낮음', 'the outside edit is still in the file')
    assert.equal(await app.value('select[name="심각도"]'), '보통', 'and the unsaved edit on screen')
    // Told, the person decides: saving again replaces it.
    await app.choose('select[name="심각도"]', '높음')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal((await fileValues(path)).심각도, '높음')
    await app.noAlert()
  },

  async 'says when the open document is removed outside, and saving makes it again'(app, vault) {
    // Another device removed the document this one has open; a sync client carries the removal here.
    const [name] = await documentsIn(vault)
    const path = join(vault, '문서', name)
    const before = await fileValues(path)
    await rm(path)
    await app.cdp.waitFor(
      `__e2e.all('[role=alert]').some((el) => el.textContent.includes('밖에서 지워졌습니다'))`,
      'the removal announced',
    )
    assert.equal(await app.value('select[name="심각도"]'), before.심각도, 'what was on screen is still there')

    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.ok((await documentsIn(vault)).includes(name), 'made again under its own name')
    assert.deepEqual(await fileValues(path), before, 'with the values that were on screen')
    await app.noAlert()
  },

  async 'makes a copied document its own when the copy is saved'(app, vault) {
    // A file copied outside the app carries its original's id.
    const [name] = await documentsIn(vault)
    const original = join(vault, '문서', name)
    const copyName = name.replace(/\.md$/, ' - 복사본.md')
    const copy = join(vault, '문서', copyName)
    await writeFile(copy, await readFile(original, 'utf8'))
    const { lowline } = await fileValues(original)
    assert.equal((await fileValues(copy)).lowline.id, lowline.id)

    await app.openDocument(BUG, copyName.replace(/\.md$/, ''))
    await app.cdp.waitFor(`__e2e.all('nav button[aria-current="true"]').some((b) => b.textContent.includes('복사본'))`, 'the copy open')
    await app.choose('select[name="심각도"]', '보통')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    const saved = await fileValues(copy)
    assert.equal(saved.심각도, '보통')
    assert.notEqual(saved.lowline.id, lowline.id, 'the copy that was changed is a new document')
    assert.equal((await fileValues(original)).lowline.id, lowline.id, 'the original keeps its id')
    await app.noAlert()

    // The scenarios after this one expect the one document.
    await app.openDocument(BUG, name.replace(/\.md$/, ''))
    await rm(copy)
    await app.cdp.waitFor(`!__e2e.all('nav button').some((b) => b.textContent.includes('복사본'))`, 'the copy gone from the list')
    await app.noAlert()
  },
  async 'shows each document as one row of its template table'(app, vault) {
    await app.showTable(BUG)
    const [name] = await documentsIn(vault)
    const values = await fileValues(join(vault, '문서', name))
    const rows = await app.cdp.waitFor(
      `(() => { const rows = __e2e.all('tbody tr'); return rows.length > 0 && rows.map((tr) => [...tr.children].map((cell) => cell.textContent.trim())) })()`,
      'the table rows',
      { timeoutMs: 30_000 },
    )
    const headers = await app.cdp.evaluate(`__e2e.all('thead th').map((th) => th.textContent)`)
    assert.deepEqual(headers, ['제목', '심각도', '재현 절차', '재현됨', '환경', '메모'])
    assert.equal(rows.length, 1, 'one row per document, however often it was saved')
    const row = Object.fromEntries(headers.map((h, i) => [h, rows[0][i]]))
    assert.equal(row.제목, values.제목)
    assert.equal(row.심각도, values.심각도)
    assert.equal(row.재현됨, values.재현됨 === undefined ? '' : values.재현됨 ? '✓' : '✗')
    assert.equal(row.환경, values.환경)

    // Exporting writes the table as CSV where the person picks in the save dialog — here the scenario's answer.
    await rm(EXPORTS, { recursive: true, force: true })
    await mkdir(EXPORTS, { recursive: true })
    app.answerDialogs([{ kind: 'save', path: join(EXPORTS, '버그 리포트.csv') }])
    await app.click('dc-button', 'CSV로 내보내기')
    await app.status('버그 리포트.csv(으)로 내보냈습니다')
    assert.deepEqual(
      app.askedDialogs().at(-1),
      { kind: 'save', title: '', defaultPath: '버그 리포트.csv', filters: [{ name: 'CSV (쉼표로 구분)', extensions: ['csv'] }] },
      'the save dialog offers the template\'s name and CSV',
    )
    const lines = (await readFile(join(EXPORTS, '버그 리포트.csv'), 'utf8')).split('\r\n')
    assert.equal(lines[0], '\uFEFF문서,제목,심각도,재현 절차,재현됨,환경,메모', 'labels as the table shows them, after the document')
    assert.equal(lines.filter(Boolean).length, 2, 'the heading and one line per document')
    assert.ok(lines[1].startsWith(`${name.replace(/\.md$/, '')},${values.제목},${values.심각도},`), lines[1])
    await rm(EXPORTS, { recursive: true, force: true })
    await app.noAlert()
  },
  async 'opens a document from its table row'(app, vault) {
    const [name] = await documentsIn(vault)
    const values = await fileValues(join(vault, '문서', name))
    // The row's first cell is a button: a keyboard opens the row the way a click does.
    await app.click('tbody th button', values.제목)
    await app.cdp.waitFor(
      `__e2e.one('nav button[aria-current="true"]')?.textContent.trim() === ${JSON.stringify(name.replace(/\.md$/, ''))}`,
      "the documents view with the row's document open",
    )
    assert.equal(await app.value('select[name="심각도"]'), values.심각도)
    await app.noAlert()
  },
}
