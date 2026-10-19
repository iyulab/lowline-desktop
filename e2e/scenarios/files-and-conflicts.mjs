import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { q } from '../app.mjs'
import { BUG, INTAKE, reportLines, documentsIn, fileValues, fileBody, SMB, deleteForGoodOverSmb, trashed } from '../shared.mjs'

export default {
  async 'shows a sync conflict copy beside its original, and learns from neither until one is kept'(app, vault) {
    // A sync client kept another device's edit of 접수-1 as a copy.
    const copy = join(vault, '문서', '접수-1 (다른 기기의 충돌된 사본 2026-09-29).md')
    const copyPath = '문서/접수-1 (다른 기기의 충돌된 사본 2026-09-29).md'
    const original = await readFile(join(vault, '문서', '접수-1.md'), 'utf8')
    // What the shell announces from here on. A copy made and removed within one debounce window is
    // no change at all, so each step waits until the app has heard of it before the next is taken.
    await app.cdp.evaluate(`(() => { window.__changes = []; const T = window.__TAURI_INTERNALS__
      return T.invoke('plugin:event|listen', { event: 'vault-changed', target: { kind: 'Any' }, handler: T.transformCallback((e) => window.__changes.push(e.payload)) }) })()`)
    const heard = (kind) =>
      app.cdp.waitFor(`window.__changes.some((c) => c.${kind}.includes(${q(copyPath)}))`, `the copy ${kind} announced`, { timeoutMs: 15_000 })
    await writeFile(copy, original.replace('담당: 장비', '담당: 총무'))
    try {
      await heard('written')
      await app.documentsOf(INTAKE)
      const listed = () => app.documentLabels()
      await app.cdp.waitFor(`__e2e.all('nav button').some((b) => b.textContent.includes('충돌 사본 — 원본: 접수-1'))`, 'the copy, with its original', { timeoutMs: 15_000 })
      assert.ok((await listed()).includes('접수-1 충돌 사본 있음'), 'the original, marked as having a copy')

      // 접수-1's own request, whose value only 접수-1 settled, is now answered only from other records.
      await app.newDocument(INTAKE)
      await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
      await app.fill('[data-field-name="요청"]', '노트북 배터리가 금방 닳아요')
      await app.choose('select[name="부서"]', '영업')
      const note = await app.cdp.waitFor(
        `__e2e.all('.formdown-suggestion').map((el) => el.closest('[data-formdown-note]').textContent.replace(/\\s+/g, ' ').trim())[0]`,
        'a suggestion for 담당',
        { timeoutMs: 15_000 },
      )
      assert.doesNotMatch(note, /요청:/, 'the unsettled original settles nothing')
      assert.doesNotMatch(note, /총무/, 'nor does its copy')

      await app.pickDocument('접수-1 충돌 사본 있음')
      await app.answerUnsaved('편집 버리기')
      await app.cdp.waitFor(`__e2e.all('p.conflict').some((p) => p.textContent.includes('제안이 이 문서에서 배우지 않습니다'))`, 'what the conflict means')
      await app.noAlert()
    } finally {
      await rm(copy, { force: true })
    }
    // Keeping one file settles it.
    await heard('removed')
    await app.cdp.waitFor(`!__e2e.one('nav button', '접수-1 충돌 사본 있음') && __e2e.all('p.conflict').length === 0`, 'the conflict settled', { timeoutMs: 15_000 })
  },

  async "keeps a conflict copy in its original's place"(app, vault) {
    const trashedFrom = (folder) => trashed(join(vault, folder))
    const asked = (heading) =>
      app.cdp.waitFor(`__e2e.all('dc-confirm-dialog').some((d) => d.open && d.heading === ${q(heading)})`, `the question "${heading}"`)
    await app.cdp.evaluate(`(() => { window.__changes = []; const T = window.__TAURI_INTERNALS__
      return T.invoke('plugin:event|listen', { event: 'vault-changed', target: { kind: 'Any' }, handler: T.transformCallback((e) => window.__changes.push(e.payload)) }) })()`)
    const written = (path) =>
      app.cdp.waitFor(`window.__changes.some((c) => c.written.includes(${q(path)}))`, `${path} announced`, { timeoutMs: 15_000 })

    // A document: another device's edit of 접수-1, kept from the original's page.
    const originalDoc = join(vault, '문서', '접수-1.md')
    const copyDocPath = '문서/접수-1 (다른 기기의 충돌된 사본 2026-09-30).md'
    const before = await readFile(originalDoc, 'utf8')
    await writeFile(join(vault, copyDocPath), before.replace('담당: 장비', '담당: 총무'))
    try {
      await written(copyDocPath)
      await app.documentsOf(INTAKE)
      await app.cdp.waitFor(`!!__e2e.one('nav button', '접수-1 충돌 사본 있음')`, 'the original with its copy', { timeoutMs: 15_000 })
      await app.pickDocument('접수-1 충돌 사본 있음')
      await app.click('dc-button', '사본 보기')
      await app.cdp.waitFor(`__e2e.one('nav button[aria-current="true"]')?.textContent.includes('충돌 사본 — 원본: 접수-1')`, 'the copy open')
      await app.click('dc-button', '이 사본을 남기기')
      await asked('이 사본을 남길까요?')
      await app.click('dc-button', '사본 남기기')
      await deleteForGoodOverSmb(app, '원본 영구히 지우기')
      await app.status(SMB ? '사본을 남겼습니다. 원본은 지웠습니다.' : '사본을 남겼습니다. 원본은 휴지통에 있습니다.')
      await app.noAlert()
      assert.ok(!existsSync(join(vault, copyDocPath)), 'the copy took the original’s name')
      assert.match(await readFile(originalDoc, 'utf8'), /담당: 총무/, 'the original’s name holds what the copy held')
      const trashed = await trashedFrom('문서')
      if (trashed) assert.deepEqual(trashed, ['접수-1.md'], 'the original in the Recycle Bin')
      await app.cdp.waitFor(
        `__e2e.one('nav button[aria-current="true"]')?.textContent.trim() === '접수-1' && __e2e.all('p.conflict').length === 0`,
        'the original’s name open, settled',
      )

      // Settled, it shows the value that was kept. (That memory leaves out a document while it has a copy and takes it
      // back once settled is the sidecar's to check: one request seen once settles no suggestion on screen here.)
      await app.cdp.waitFor(`__e2e.one('select[name="담당"]')?.value === '총무'`, 'the kept value in the original’s place')
      await app.templateOf(INTAKE)
    } finally {
      await rm(join(vault, copyDocPath), { force: true })
      await writeFile(originalDoc, before)
    }
    await written('문서/접수-1.md')

    // A template: its copy is not in the sidebar; the original's page shows it.
    const originalTemplate = join(vault, INTAKE.path)
    const copyTemplatePath = '서식/접수.fd.sync-conflict-20260930-101500-ABCDEFG.md'
    const templateBefore = await readFile(originalTemplate, 'utf8')
    const showCopy = async () => {
      await writeFile(join(vault, copyTemplatePath), `${templateBefore.trimEnd()}\n\n메모: ___@메모\n`)
      await written(copyTemplatePath)
      await app.templateOf(INTAKE)
      await app.click('dc-button', '사본 보기')
      await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('메모: ___@메모')`, 'the copy’s source')
    }
    try {
      // Deleting the copy keeps the original, which is shown again.
      await showCopy()
      await app.click('dc-button', '지우기')
      await asked('이 사본을 지울까요?')
      await app.click('dc-button', '휴지통으로 옮기기')
      await deleteForGoodOverSmb(app, '영구히 지우기')
      await app.status(SMB ? '사본을 지우고 원본을 남겼습니다.' : '사본을 휴지통으로 옮기고 원본을 남겼습니다.')
      assert.ok(!existsSync(join(vault, copyTemplatePath)), 'the copy gone')
      assert.equal(await app.value('textarea'), templateBefore, 'the original shown again')
      const trashedCopy = await trashedFrom('서식')
      if (trashedCopy) assert.deepEqual(trashedCopy, ['접수.fd.sync-conflict-20260930-101500-ABCDEFG.md'])

      // Keeping the copy: the template the app knows under the original's name holds what the copy held.
      await showCopy()
      await app.click('dc-button', '이 사본을 남기기')
      await asked('이 사본을 남길까요?')
      await app.click('dc-button', '사본 남기기')
      await deleteForGoodOverSmb(app, '원본 영구히 지우기')
      await app.status(SMB ? '사본을 남겼습니다. 원본은 지웠습니다.' : '사본을 남겼습니다. 원본은 휴지통에 있습니다.')
      assert.ok(!existsSync(join(vault, copyTemplatePath)), 'the copy took the original’s name')
      assert.match(await readFile(originalTemplate, 'utf8'), /메모: ___@메모/)
      assert.match(await app.value('textarea'), /메모: ___@메모/, 'the kept template shown')
      const trashedOriginal = await trashedFrom('서식')
      if (trashedOriginal) assert.deepEqual(trashedOriginal, ['접수.fd.md'], 'the original in the Recycle Bin')
      await app.cdp.waitFor(`__e2e.all('p.conflict').length === 0`, 'settled')
      await app.noAlert()
    } finally {
      await rm(join(vault, copyTemplatePath), { force: true })
      await writeFile(originalTemplate, templateBefore)
    }
    await written(INTAKE.path)
  },

  async 'renames a document, and what was recorded about it stays with it'(app, vault) {
    const rows = async () => {
      await app.showTable(INTAKE)
      return app.cdp.waitFor(`(() => { const n = __e2e.all('tbody tr').length; return n > 0 && n })()`, 'the intake table', { timeoutMs: 30_000 })
    }
    const rowsBefore = await rows()
    const enter = () => app.cdp.press('Enter', { code: 'Enter', keyCode: 13 })
    const refused = (text) => app.cdp.waitFor(`__e2e.all('[role=alert]').some((el) => el.textContent.includes(${JSON.stringify(text)}))`, `refused: ${text}`)
    const original = join(vault, '문서', '접수-2.md')
    const before = await readFile(original, 'utf8')
    const valuesBefore = await fileValues(original)
    assert.ok(!valuesBefore.lowline?.id, 'a document known by its path')

    await app.documentsOf(INTAKE)
    await app.pickDocument('접수-2')
    await app.cdp.waitFor(`__e2e.one('nav button[aria-current="true"]')?.textContent.trim() === '접수-2'`, 'the document open')
    await app.click('dc-button', '이름 바꾸기')

    // A name another document has is refused, and so is one no file can have; nothing moves.
    await app.fill('input[aria-label="새 이름"]', '접수-1')
    await enter()
    await refused('같은 이름의 문서가 이미 있습니다')
    await app.fill('input[aria-label="새 이름"]', '프린터/토너')
    await enter()
    await refused('파일 이름에 쓸 수 없는 글자')
    assert.equal(await readFile(original, 'utf8'), before)

    await app.fill('input[aria-label="새 이름"]', '프린터 토너 문의')
    await enter()
    await app.status('이름을 바꿨습니다')
    const names = await documentsIn(vault)
    assert.ok(names.includes('프린터 토너 문의.md') && !names.includes('접수-2.md'), names.join(', '))
    const moved = await fileValues(join(vault, '문서', '프린터 토너 문의.md'))
    // Known by its old path until now, it keeps that path as its id: its events still name it.
    assert.equal(moved.lowline?.id, '문서/접수-2.md')
    assert.equal(moved.요청, valuesBefore.요청, 'its values as they were')
    await app.cdp.waitFor(`__e2e.one('nav button[aria-current="true"]')?.textContent.trim() === '프린터 토너 문의'`, 'the list showing its new name')
    assert.equal(await rows(), rowsBefore, 'still one row in its table')
    await app.noAlert()
  },

  async 'lists apart the documents whose template is not in the vault, while there are any'(app, vault) {
    const stray = join(vault, '문서', '옛 서식 문서.md')
    await writeFile(stray, '---\ntemplate: retired@1\n제목: 남은 기록\n---\n# 옛 서식\n\n제목: ___@제목\n')
    try {
      await app.sidebar('서식 없는 문서', { timeoutMs: 15_000 })
      await app.cdp.waitFor(`__e2e.all('nav button').some((b) => b.textContent.trim() === '옛 서식 문서')`, 'the stray document listed')
      assert.ok(!(await app.documentLabels()).includes('접수-1'), "a template's documents are not listed there")
      await app.pickDocument('옛 서식 문서')
      await app.cdp.waitFor(`__e2e.one('[data-field-name="제목"]')?.textContent === '남은 기록'`, 'the stray document open')
    } finally {
      await rm(stray, { force: true })
    }
    // Once none is left, the place goes, and so does the app from it.
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '서식 없는 문서')`, 'the place gone', { timeoutMs: 15_000 })
    assert.equal((await app.where()).place, BUG.name, 'back at the first template')
    await app.noAlert()
  },

  async "deletes a document and a template to the system trash; the template's documents stay"(app, vault) {
    const trashedFrom = (folder) => trashed(join(vault, folder))
    const asked = (heading) =>
      app.cdp.waitFor(`__e2e.all('dc-confirm-dialog').some((d) => d.open && d.heading === ${q(heading)})`, `the question "${heading}"`)
    const doc = join(vault, '문서', '지울 문의.md')
    await writeFile(doc, `---\ntemplate: intake@1\n요청: 지울 기록\n---\n${(await fileBody(join(vault, INTAKE.path))).trimStart()}`)
    await app.documentsOf(INTAKE)
    await app.cdp.waitFor(`__e2e.all('nav button').some((b) => b.textContent.trim() === '지울 문의')`, 'the document listed', { timeoutMs: 15_000 })
    const others = (await app.documentLabels()).filter((l) => l !== '지울 문의')
    await app.pickDocument('지울 문의')
    await app.cdp.waitFor(`__e2e.one('nav button[aria-current="true"]')?.textContent.trim() === '지울 문의'`, 'the document open')

    // Asked first; cancelling leaves it.
    await app.click('dc-button', '지우기')
    await asked('이 문서를 지울까요?')
    await app.click('dc-button', '취소')
    await app.cdp.waitFor(`!__e2e.all('dc-confirm-dialog').some((d) => d.open)`, 'the question gone')
    assert.ok(existsSync(doc), 'kept when cancelled')

    // Unsaved edits: the question says they go too.
    await app.fill('[data-field-name="요청"]', '고치던 중')
    await app.click('dc-button', '지우기')
    await asked('이 문서를 지울까요?')
    await app.cdp.waitFor(
      `__e2e.all('dc-confirm-dialog').some((d) => d.open && d.textContent.includes('저장하지 않은 편집은 함께 사라집니다'))`,
      'the unsaved edits named',
    )
    await app.click('dc-button', '휴지통으로 옮기기')
    await deleteForGoodOverSmb(app, '영구히 지우기')
    await app.status(SMB ? '지웠습니다' : '휴지통으로 옮겼습니다')
    assert.ok(!existsSync(doc), 'gone from the vault')
    const trashedDoc = await trashedFrom('문서')
    if (trashedDoc) assert.deepEqual(trashedDoc, ['지울 문의.md'], 'in the Recycle Bin, not deleted')
    assert.deepEqual(await app.documentLabels(), others, 'the other documents stay')
    // Deleting its edits with it was asked about: nothing is left unsaved to ask about again.
    await app.showTable(INTAKE)
    assert.equal((await app.where()).tab, '표')

    // A template: its documents are not deleted with it, and are listed apart.
    const template = join(vault, '서식', '지울 서식.fd.md')
    const templateDoc = join(vault, '문서', '지울 서식 기록.md')
    await writeFile(template, '---\nid: retiring\nversion: 1\n---\n# 지울 서식\n\n제목: ___@제목\n')
    await writeFile(templateDoc, '---\ntemplate: retiring@1\n제목: 남길 기록\n---\n# 지울 서식\n\n제목: ___@제목\n')
    try {
      await app.tabOf({ name: '지울 서식' }, '서식', { timeoutMs: 15_000 })
      await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: retiring')`, 'the template source')
      await app.click('dc-button', '지우기')
      await asked('이 서식을 지울까요?')
      await app.click('dc-button', '휴지통으로 옮기기')
      await deleteForGoodOverSmb(app, '영구히 지우기')
      await app.cdp.waitFor(
        `__e2e.all('[role=status]').some((el) => el.textContent.includes(${q(SMB ? '서식을 지웠습니다' : '서식을 휴지통으로 옮겼습니다')}) && el.textContent.includes('서식 없는 문서'))`,
        'the template deleted, its documents pointed to',
      )
      assert.ok(!existsSync(template), 'the template gone from the vault')
      assert.ok(existsSync(templateDoc), 'its document stays')
      const trashedTemplate = await trashedFrom('서식')
      if (trashedTemplate) assert.deepEqual(trashedTemplate, ['지울 서식.fd.md'], 'in the Recycle Bin, not deleted')
      await app.cdp.waitFor(`!__e2e.one('button.item', '지울 서식')`, 'the template gone from the sidebar')
      await app.sidebar('서식 없는 문서', { timeoutMs: 15_000 })
      await app.cdp.waitFor(`__e2e.all('nav button').some((b) => b.textContent.trim() === '지울 서식 기록')`, 'its document listed apart')
    } finally {
      await rm(template, { force: true })
      await rm(templateDoc, { force: true })
    }
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '서식 없는 문서')`, 'the place gone', { timeoutMs: 15_000 })
    await app.noAlert()
  },

  async 'keeps values the form cannot show as written, when another field is edited and saved'(app, vault) {
    // Written outside the app: an owner the choice field does not offer, and a long request over several lines.
    const request = `첫 줄\n${'길게 이어지는 내용 '.repeat(200).trim()}\n마지막 줄`
    const file = join(vault, '문서', '경계 값.md')
    const body = '# 접수\n\n요청: ___@요청\n\n@부서: [select options="영업,개발,인사"]\n\n@담당: [select options="장비,인사,총무"]\n'
    await writeFile(file, `---\ntemplate: intake@1\n요청: ${JSON.stringify(request)}\n부서: 영업\n담당: 외부 업체\n---\n${body}`)
    await app.documentsOf(INTAKE)
    await app.cdp.waitFor(`__e2e.all('nav button').some((b) => b.textContent.includes('경계 값'))`, 'the document in the list', { timeoutMs: 30_000 })
    await app.pickDocument('경계 값')
    await app.cdp.waitFor(`__e2e.one('select[name="부서"]')?.value === '영업'`, 'the document open')
    assert.equal(await app.value('select[name="담당"]'), '외부 업체', 'a value the field does not offer is shown, not a blank or its first option')

    await app.choose('select[name="부서"]', '개발')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    await app.noAlert()
    const saved = await fileValues(file)
    assert.equal(saved.부서, '개발')
    assert.equal(saved.담당, '외부 업체', 'the value the field does not offer is kept')
    assert.equal(saved.요청, request, 'the long request keeps every line')

    // Leave the vault as the scenarios after this one expect it.
    await app.learning()
    await rm(file)
  },

  async 'says what is wrong in a template source, and does not save one whose front matter cannot be read'(app, vault) {
    const EDGE = { name: '경계 서식', ref: 'edge@1', path: '서식/경계 서식.fd.md' }
    const file = join(vault, EDGE.path)
    const source = '---\nid: edge\nversion: 1\nlowline:\n  suggest: [담당, 분류]\n---\n# 경계\n\n@담당: [select options="장비,인사"]\n\n@담당: [text]\n\n@메모: [text visible-if="분류=급함"]\n\n@고객 -> customer: [select]\n\n@태그 <-> tag: [checkbox]\n'
    const hostReports = async () => (await reportLines()).filter((l) => l.includes('"layer":"host"')).length
    const hostBefore = await hostReports()
    await writeFile(file, source)
    await app.tabOf(EDGE, '서식', { timeoutMs: 30_000 })
    const problems = await app.cdp.waitFor(
      `(() => { const l = __e2e.all('ul.problems li').map((li) => li.textContent.trim()); return l.length ? l : null })()`,
      'what is wrong in the source',
      { timeoutMs: 30_000 },
    )
    assert.deepEqual(problems, [
      '칸 이름 "담당"이(가) 두 번 이상 쓰였습니다(다시 쓰인 줄: 11). 문서에는 이 이름으로 값이 하나만 남아 두 칸이 같은 값을 가집니다.',
      '칸 "메모"의 조건이 이 서식에 없는 칸 "분류"을(를) 가리킵니다. 값이 들어올 수 없어 늘 같게 판정됩니다 — visible-if라면 칸이 계속 숨습니다.',
      'lowline.suggest의 "분류"은(는) 이 서식의 칸이 아니라 제안이 켜지지 않습니다.',
      '칸 "고객"이(가) 가리키는 서식 "customer"이(가) 볼트에 없습니다. 고를 문서가 없어, 그 서식(id: customer)이 생길 때까지 값은 적힌 그대로 둡니다.',
      '칸 "태그"의 "<-> tag"(여러 문서를 가리킴)은 아직 읽지 않습니다 — 이 칸은 적힌 타입 그대로 쓰입니다. 한 문서를 가리키려면 "->"를 쓰세요.',
    ])
    assert.equal(
      await app.cdp.evaluate(`__e2e.all('dc-checkbox').filter((c) => c.getAttribute('name') === '담당').length`),
      1,
      'a name used twice is listed once',
    )
    // The sidecar takes the template in too — one field of that name — rather than failing the whole vault.
    await app.showTable(EDGE)
    await app.cdp.waitFor(`__e2e.all('ll-table').some((t) => /문서 0건/.test(t.shadowRoot.textContent))`, "the template's table", { timeoutMs: 30_000 })
    assert.equal(await hostReports(), hostBefore, 'no failure reported by the sidecar')
    await app.templateOf(EDGE)

    // Front matter that cannot be read is said as that, not as a missing id, and the file is left as it was.
    await app.fill('textarea', source.replace('version: 1', 'version: [1'))
    await app.click('dc-button', '저장')
    const said = await app.cdp.waitFor(`__e2e.all('[role=alert]').map((el) => el.textContent.trim()).find(Boolean)`, 'why it was not saved')
    assert.match(said, /^서식 앞부분\(front matter\)을 읽을 수 없어 저장하지 않습니다 — /)
    assert.equal(await readFile(file, 'utf8'), source, 'not saved')

    // Leave the vault as the scenarios after this one expect it.
    await app.learning()
    await app.answerUnsaved('편집 버리기')
    await rm(file)
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '경계 서식')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
  },

  async 'fixes a line the parser can tell the meaning of, and one undo takes the fix away'(app, vault) {
    const LOOSE = { name: '느슨한 서식', ref: 'loose@1', path: '서식/느슨한 서식.fd.md' }
    const file = join(vault, LOOSE.path)
    const source = '---\nid: loose\nversion: 1\n---\n# 느슨\n\n요청: ___@요청\n\n@처리_기한: date\n'
    await writeFile(file, source)
    await app.tabOf(LOOSE, '서식', { timeoutMs: 30_000 })
    const problems = `__e2e.all('ul.problems li').map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`
    const said = await app.cdp.waitFor(`(${problems}).find((t) => t.includes('처리_기한'))`, 'the line that is not a field', { timeoutMs: 30_000 })
    assert.match(said, /이렇게 쓰면 칸이 됩니다: @처리_기한: \[date\]/)

    await app.click('ul.problems dc-button', '고치기')
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('@처리_기한: [date]\\n')`, 'the fix in the source')
    assert.equal(await app.value('textarea'), source.replace('@처리_기한: date', '@처리_기한: [date]'), 'nothing else changed')
    await app.cdp.waitFor(`(${problems}).length === 0`, 'nothing more to say once fixed')

    // Put in as typing is, so one undo takes it away.
    await app.cdp.press('z', { code: 'KeyZ', modifiers: 2, keyCode: 90 })
    await app.cdp.waitFor(`__e2e.one('textarea')?.value === ${JSON.stringify(source)}`, 'the source as it was')
    await app.cdp.waitFor(`(${problems}).some((t) => t.includes('처리_기한'))`, 'the problem said again')

    // Leave the vault as the scenarios after this one expect it.
    await app.learning()
    await app.answerUnsaved('편집 버리기')
    await rm(file)
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '느슨한 서식')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
  },

  async 'opens a link in a template body outside the window, keeping the window on the app with what was typed'(app, vault) {
    const GUIDE = { name: '안내 링크', ref: 'guide@1', path: '서식/안내 링크.fd.md' }
    const file = join(vault, GUIDE.path)
    await writeFile(
      file,
      '---\nid: guide\nversion: 1\n---\n# 안내\n\n작성 전에 [사내 규정](https://example.com/) 을 확인하세요.\n\n<a href="https://example.org/" target="_blank">새 창 안내</a> · [담당자](mailto:desk@example.com) · <a href="file:///C:/Windows/notepad.exe">프로그램</a>\n\n요청: ___@요청\n',
    )
    await app.newDocument(GUIDE)
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form', { timeoutMs: 30_000 })
    await app.fill('[data-field-name="요청"]', '저장 안 한 입력')
    const page = await app.cdp.evaluate('location.href')
    const told = (address) =>
      app.cdp.waitFor(`__e2e.all('p.notice').map((p) => p.textContent.trim()).find((t) => t.includes(${JSON.stringify(address)}))`, `what became of ${address}`)
    const stays = async (what) => {
      assert.equal(await app.cdp.evaluate('location.href'), page, `${what}: the window stays on the app`)
      assert.equal(await app.cdp.evaluate(`__e2e.one('[data-field-name="요청"]').textContent`), '저장 안 한 입력', `${what}: what was typed stays`)
    }

    // The web and mail open in the system's own app (an e2e build only says so); anything else is not opened.
    for (const [link, address, saying] of [
      ['사내 규정', 'https://example.com/', /^브라우저에서 열었습니다: /],
      ['새 창 안내', 'https://example.org/', /^브라우저에서 열었습니다: /],
      ['담당자', 'mailto:desk@example.com', /^브라우저에서 열었습니다: /],
      ['프로그램', 'file:///C:/Windows/notepad.exe', /^웹 주소와 메일 링크만 엽니다\./],
    ]) {
      await app.click('a', link)
      assert.match(await told(address), saying)
      await stays(link)
    }
    // Leaving the app another way than by a click is still refused by the window, and said.
    await app.cdp.evaluate(`location.href = 'https://example.net/'`)
    assert.match(await told('https://example.net/'), /^링크는 Lowline 창에서 열지 않습니다\./)
    await stays('a page going elsewhere by itself')
    // Nor does a frame load a page from outside, nor a window open by a script: the web view refuses them, and says so.
    await app.cdp.evaluate(`document.body.appendChild(Object.assign(document.createElement('iframe'), { src: 'https://example.net/frame' })), true`)
    assert.match(await told('https://example.net/frame'), /^링크는 Lowline 창에서 열지 않습니다\./)
    await app.cdp.evaluate(`document.querySelector('iframe[src="https://example.net/frame"]').remove(), true`)
    await app.cdp.evaluate(`window.open('https://example.net/window'), true`)
    assert.match(await told('https://example.net/window'), /^링크는 Lowline 창에서 열지 않습니다\./)
    await stays('a frame or a window from a script')

    // Leave the vault as the scenarios after this one expect it.
    await app.learning()
    await app.answerUnsaved('편집 버리기')
    await rm(file)
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '안내 링크')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
  },
}
