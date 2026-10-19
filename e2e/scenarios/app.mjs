import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import assert from 'node:assert/strict'
import { parseFormdown } from '@formdown/core'
import { SETTINGS, command, q, updates } from '../app.mjs'
import { here, reportLines, reportsCaused, INTAKE, documentsIn, fileValues, fileBody, longTasks, thresholdsChosenSince, sidecarQuiet, sidecarCpuOver, SMB, deleteForGoodOverSmb, trashed } from '../shared.mjs'

export default {
  async 'writes an error report with the kind of failure and nothing of what was on screen'(app) {
    const before = new Set(await reportLines())
    await app.cdp.evaluate(`setTimeout(() => { throw new RangeError('문서/비밀 회의록.md — 담당: 장비') }), true`)
    await app.cdp.evaluate(`Promise.reject({ kind: 'outside-vault', message: 'C:\\\\Users\\\\홍길동' }), true`)
    // A request the sidecar fails: a template with no reference cannot be a form type.
    await app.cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('host_ingest', { snapshot: { templates: [{ ref: '', fields: [] }],
      documents: [{ path: '문서/비밀 회의록.md', template: '', values: { 담당: '장비' } }] } }).catch(() => {}), true`)
    const deadline = Date.now() + 10_000
    let lines = []
    while (Date.now() < deadline) {
      lines = (await reportLines()).filter((line) => !before.has(line))
      if (lines.length >= 3) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const written = lines.map((line) => JSON.parse(line))
    // The sidecar's report comes back on its own time: only the page's two are in the order they happened.
    assert.deepEqual(written.filter((r) => r.layer === 'ui').map((r) => r.kind), ['RangeError', 'outside-vault'])
    const host = written.find((r) => r.layer === 'host')
    assert.ok(host && host.kind !== 'Unrecognized' && host.frames.length > 0, `the sidecar's failure: ${JSON.stringify(host)}`)
    assert.ok(!lines.join('\n').match(/비밀|회의록|장비|홍길동|Users/), `nothing of the page: ${lines.join(' ')}`)
    // These three were asked for: a later failure does not print them as if they told what went wrong.
    await reportsCaused()
    await app.noAlert()
  },

  async 'makes a new vault in an empty folder, starting from a sample with a judgment field'(app, vault) {
    const empty = await mkdtemp(join(tmpdir(), 'lowline-e2e-new-'))
    const taken = await mkdtemp(join(tmpdir(), 'lowline-e2e-taken-'))
    await writeFile(join(taken, 'note.md'), 'mine')
    // The folder picker is the seam: the folder it answers with goes to the same method.
    const make = (path) => app.cdp.evaluate(`document.querySelector('ll-app').makeVault(${JSON.stringify(path)}).then(() => true)`)
    try {
      // The first screen says what a vault is, and offers the two ways in.
      await app.cdp.evaluate(`(document.querySelector('ll-app').vaultInfo = undefined, true)`)
      await app.cdp.waitFor(`!!__e2e.one('dc-button', '새 볼트 만들기') && !!__e2e.one('dc-button', '기존 폴더 열기')`, 'the two ways in')
      assert.ok(await app.cdp.evaluate(`__e2e.all('.welcome p').some((p) => p.textContent.includes('서식과 문서를 담는 폴더'))`))

      // A folder that holds anything is not made a vault: nothing is written beside someone's files.
      await make(taken)
      await app.cdp.waitFor(`__e2e.all('[role=alert]').some((el) => el.textContent.includes('빈 폴더를 고르세요'))`, 'the folder refused')
      assert.deepEqual(await readdir(taken), ['note.md'])

      await make(empty)
      await app.cdp.waitFor(`!!__e2e.one('dc-button', '새 문서')`, "the sample's documents")
      assert.deepEqual(await readdir(join(empty, '서식')), ['문의 접수.fd.md'])
      const sample = parseFormdown(await readFile(join(empty, '서식', '문의 접수.fd.md'), 'utf8'))
      assert.deepEqual(sample.frontMatter?.data?.lowline, { suggest: ['담당'] })
      // Its judgment field is a radio group: a suggested option shows in the field itself, not beside it.
      assert.equal(sample.forms.find((f) => f.name === '담당')?.type, 'radio')
      assert.ok(!existsSync(join(empty, '문서')), 'no documents: suggestions learn only from what a person confirms')

      await app.click('dc-button', '새 문서')
      await app.cdp.waitFor(`__e2e.all('p.judgment').some((el) => el.textContent.includes('제안 받는 칸: 담당'))`, 'its judgment field', { timeoutMs: 30_000 })
      const why = await app.cdp.waitFor(`__e2e.all('[data-formdown-note="담당"]').map((el) => el.textContent.trim())[0]`, 'why 담당 has no suggestion yet')
      assert.match(why, /^확정한 문서가 아직 없어/)
      await app.noAlert()

      // The learning view names the sample's judgment field before anything is decided about it.
      await app.learning()
      const undecided = await app.cdp.waitFor(
        `(() => { const h = __e2e.all('h2').find((el) => el.textContent.trim().endsWith('· 담당')); return h && h.parentElement.textContent.replace(/\\s+/g, ' ').trim() })()`,
        "the sample's judgment field in the learning view",
        { timeoutMs: 30_000 },
      )
      assert.match(undecided, /아직 결정된 제안이 없습니다/)
      await app.noAlert()
    } finally {
      await app.openVault(vault) // back to the vault the scenarios after this one use
      await rm(empty, { recursive: true, force: true })
      await rm(taken, { recursive: true, force: true })
    }
  },

  async 'starts a new document with Ctrl+N and finds with Ctrl+F; while a question is open, the shortcuts wait'(app, vault) {
    const ctrl = (key) => app.cdp.press(key, { code: `Key${key.toUpperCase()}`, modifiers: 2, keyCode: key.toUpperCase().charCodeAt(0) })
    const emptyForm = `__e2e.one('[data-field-name="요청"]')?.textContent === ''`
    await app.showTable(INTAKE)
    await ctrl('n')
    await app.cdp.waitFor(emptyForm, 'a new document from the table')
    assert.deepEqual(await app.where(), { place: INTAKE.name, tab: '문서' })

    // A shortcut does not act under the question it would answer.
    const before = await documentsIn(vault)
    await app.fill('[data-field-name="요청"]', '프린터 용지가 걸려요')
    await ctrl('n')
    await app.cdp.waitFor(`__e2e.all('dc-confirm-dialog').some((d) => d.open)`, 'the unsaved-edits question')
    await ctrl('s')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.deepEqual(await documentsIn(vault), before, 'nothing saved under the question')
    assert.ok(await app.cdp.evaluate(`__e2e.all('dc-confirm-dialog').some((d) => d.open)`), 'the question still open')
    await app.answerUnsaved('편집 버리기')
    await app.cdp.waitFor(emptyForm, 'a new document again')

    await ctrl('f')
    await app.cdp.waitFor(`(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el?.type === 'search' })()`, 'the find box focused')
    await app.noAlert()
  },

  async 'keeps the keyboard in the document: a new one opens on its first field, and a save leaves the cursor where it was'(app, vault) {
    const ctrl = (key) => app.cdp.press(key, { code: `Key${key.toUpperCase()}`, modifiers: 2, keyCode: key.toUpperCase().charCodeAt(0) })
    const focusedField = `(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el?.getAttribute('data-field-name') ?? el?.getAttribute('name') ?? el?.localName })()`
    const before = await documentsIn(vault)
    await app.tabOf(INTAKE, '문서')
    await ctrl('n')
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
    await app.cdp.waitFor(`${focusedField} === '요청'`, 'the cursor in the first field')
    await app.cdp.insertText('키보드만으로 쓴 요청') // typed straight away, no click
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === '키보드만으로 쓴 요청'`, 'what was typed in the first field')
    await ctrl('s')
    await app.status('저장했습니다')
    assert.equal(await app.cdp.evaluate(focusedField), '요청', 'the cursor still in the field after saving')
    // A caret, not the value selected: typing goes on, it does not replace what was written.
    assert.equal(
      await app.cdp.evaluate(`(() => { const r = __e2e.all('formdown-ui')[0].shadowRoot; return (r.getSelection?.() ?? getSelection()).isCollapsed })()`),
      true,
      'the caret, not a selection',
    )
    await app.noAlert()
    // Left before they go: removed while open, a document is said to be gone outside.
    await app.learning()
    for (const name of (await documentsIn(vault)).filter((n) => !before.includes(n))) await rm(join(vault, '문서', name))
  },

  async 'shows the shortcuts on Ctrl+/, and moves along the document list with the arrow keys as one Tab stop'(app) {
    const focused = `(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el })()`
    await app.tabOf(INTAKE, '문서')
    await app.cdp.press('/', { code: 'Slash', modifiers: 2, keyCode: 191 })
    await app.cdp.waitFor(`__e2e.all('dp-shortcut-overlay')[0]?.open === true`, 'the shortcuts showing')
    const rows = await app.cdp.evaluate(`[...__e2e.all('dp-shortcut-overlay')[0].shadowRoot.querySelectorAll('li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`)
    assert.ok(rows.includes('저장 Ctrl+S') && rows.includes('단축키 보기 Ctrl+/'), rows.join(' | '))
    // While they show, the other shortcuts wait: Ctrl+N leaves what is open as it was.
    const shown = `__e2e.all('ll-documents')[0].shadowRoot.querySelector('formdown-ui')?.content ?? null`
    const before = await app.cdp.evaluate(shown)
    await app.cdp.press('n', { code: 'KeyN', modifiers: 2, keyCode: 78 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await app.cdp.evaluate(shown), before, 'no new document under the shortcuts')
    await app.cdp.press('Escape', { code: 'Escape', keyCode: 27 })
    await app.cdp.waitFor(`!__e2e.all('dp-shortcut-overlay')[0].open`, 'the shortcuts gone on Escape')

    // The list is one Tab stop: from the find box, Tab lands on one document — past 미확정만, when there is any unsettled
    // document to list alone — and the next Tab leaves the list.
    await app.cdp.press('f', { code: 'KeyF', modifiers: 2, keyCode: 70 })
    await app.cdp.waitFor(`${focused}?.type === 'search'`, 'the find box focused')
    const stops = await app.cdp.evaluate(`__e2e.all('ll-documents')[0].shadowRoot.querySelectorAll('nav button.document[tabindex="0"]').length`)
    assert.equal(stops, 1, 'one Tab stop in the list')
    await app.cdp.press('Tab', { code: 'Tab', keyCode: 9 })
    if (await app.cdp.evaluate(`__e2e.all('ll-documents')[0].shadowRoot.querySelector('nav dc-checkbox') !== null`)) {
      await app.cdp.waitFor(`${focused}?.type === 'checkbox'`, '미확정만 focused')
      await app.cdp.press('Tab', { code: 'Tab', keyCode: 9 })
    }
    await app.cdp.waitFor(`${focused}?.classList.contains('document')`, 'a document of the list focused')
    await app.cdp.press('Home', { code: 'Home', keyCode: 36 })
    const first = await app.cdp.waitFor(`${focused}?.classList.contains('document') && ${focused}.textContent.trim()`, 'the first document focused')
    await app.cdp.press('ArrowDown', { code: 'ArrowDown', keyCode: 40 })
    const second = await app.cdp.waitFor(`${focused}?.classList.contains('document') && ${focused}.textContent.trim()`, 'the next document focused')
    assert.notEqual(second, first, 'ArrowDown moved along the list')
    await app.cdp.press('Home', { code: 'Home', keyCode: 36 })
    assert.equal(await app.cdp.evaluate(`${focused}.textContent.trim()`), first, 'Home went back to the first')
    await app.noAlert()
  },

  async 'shows what Lowline is: its version, its license, where its source is, and the notices of what it ships with'(app) {
    await app.sidebar('정보')
    const about = `__e2e.all('ll-about')[0]`
    const text = `${about}.shadowRoot.textContent.replace(/\\s+/g, ' ')`
    const { version } = JSON.parse(await readFile(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'))
    await app.cdp.waitFor(`${about}.open && ${text}.includes(${q(`판 ${version}`)})`, 'the about dialog with the version')
    const shown = await app.cdp.evaluate(text)
    for (const part of ['© iyulab', 'AGPL-3.0', '어떤 보증도 없이', 'https://github.com/iyulab/lowline'])
      assert.ok(shown.includes(part), `${part} in ${shown}`)
    // The notices are read only when opened: the file the installer lays beside the app.
    await app.click('summary', '함께 쓰는 소프트웨어의 고지')
    const notices = await app.cdp.waitFor(`${about}.shadowRoot.querySelector('pre')?.textContent`, 'the notices', { timeoutMs: 15_000 })
    assert.ok(notices.includes('Formbase.Core') && notices.includes('lit'), 'the notices list what is shipped')
    await app.click('dc-button', '닫기')
    await app.cdp.waitFor(`!${about}.open`, 'the about dialog closed')
    await app.noAlert()
  },

  async 'tells of a newer release when it starts, installs only when asked, and looks no more once told not to'(app, vault) {
    const banner = `(__e2e.all('p.update')[0]?.textContent.replace(/\\s+/g, ' ').trim() ?? '')`
    const settingsNow = async () => JSON.parse(await readFile(SETTINGS, 'utf8').catch(() => '{}'))
    const about = `__e2e.all('ll-about')[0]`
    const toggleChecking = async (on) => {
      await app.sidebar('정보')
      await app.cdp.waitFor(`${about}.open && !!${about}.shadowRoot.querySelector('dc-checkbox')`, 'the about dialog with its update setting')
      await app.cdp.evaluate(`${about}.shadowRoot.querySelector('dc-checkbox').click()`)
      await app.cdp.waitFor(`${about}.shadowRoot.querySelector('dc-checkbox').checked === ${on}`, `checking ${on ? 'on' : 'off'}`)
      for (let tries = 0; (await settingsNow()).checkForUpdates !== on; tries++) {
        assert.ok(tries < 50, 'the setting written to this device')
        await new Promise((r) => setTimeout(r, 100))
      }
      await app.click('dc-button', '닫기')
      await app.cdp.waitFor(`!${about}.open`, 'the about dialog closed')
    }

    // Nothing newer: nothing to tell, though it looked.
    assert.ok(updates.requests > 0, 'it looked when it started')
    assert.equal(await app.cdp.evaluate(banner), '', 'nothing told while nothing is newer')

    updates.newer = '99.0.0'
    try {
      await app.reopen(vault)
      await app.cdp.waitFor(`${banner}.includes('새 판 99.0.0')`, 'the newer release told', { timeoutMs: 15_000 })
      // Put off: told no more in this run of the app, and nothing installed.
      await app.click('dc-button', '나중에')
      await app.cdp.waitFor(`${banner} === ''`, 'put off')

      await toggleChecking(false)
      const looks = updates.requests
      await app.reopen(vault)
      await new Promise((r) => setTimeout(r, 2_000))
      assert.equal(updates.requests, looks, 'no look while checking is off')
      assert.equal(await app.cdp.evaluate(banner), '', 'nothing told while checking is off')
    } finally {
      updates.newer = null
    }
    await toggleChecking(true)
    await app.noAlert()
  },

  async 'tells once, on the first launch, what leaves the computer, and shows the rest under 정보'(app, vault) {
    const line = `(__e2e.all('p.outbound-once')[0]?.textContent.replace(/\\s+/g, ' ').trim() ?? '')`
    const about = `__e2e.all('ll-about')[0]`
    const told = async () => JSON.parse(await readFile(SETTINGS, 'utf8')).outboundToldOnce
    await writeFile(SETTINGS, JSON.stringify({ ...JSON.parse(await readFile(SETTINGS, 'utf8')), outboundToldOnce: false }))
    await app.reopen(vault)
    await app.cdp.waitFor(`${line}.includes('실패 정보만 iyulab에')`, 'the one-time line')
    await app.click('dc-button', '자세히')
    await app.cdp.waitFor(`${about}.open && [...${about}.shadowRoot.querySelectorAll('details')].some((d) => d.open && d.textContent.includes('90일'))`, '정보 with what leaves the computer unfolded')
    await app.click('dc-button', '닫기')
    await app.cdp.waitFor(`!${about}.open && ${line} === ''`, 'the line answered')
    for (let tries = 0; !(await told()); tries++) {
      assert.ok(tries < 50, 'answered on this device')
      await new Promise((r) => setTimeout(r, 100))
    }
    await app.reopen(vault)
    await new Promise((r) => setTimeout(r, 1_000))
    assert.equal(await app.cdp.evaluate(line), '', 'told once only')
    await app.noAlert()
  },

  async 'writes and saves a document with the keyboard alone in at most 12 keys'(app, vault) {
    let keys = 0
    const press = async (key, options) => {
      keys++
      await app.cdp.press(key, options)
    }
    const focusedName = `(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el?.getAttribute('data-field-name') ?? el?.getAttribute('name') ?? null })()`
    /** Tab until the field named has focus — each Tab counted. */
    const tabTo = async (name) => {
      for (let i = 0; i < 6; i++) {
        if ((await app.cdp.evaluate(focusedName)) === name) return
        await press('Tab', { code: 'Tab', keyCode: 9 })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.fail(`${name} not reached with Tab`)
    }
    const before = await documentsIn(vault)
    await app.tabOf(INTAKE, '문서')
    await press('n', { code: 'KeyN', modifiers: 2, keyCode: 78 })
    await app.cdp.waitFor(`${focusedName} === '요청'`, 'the cursor in the first field')
    keys++ // what is typed counts as one
    await app.cdp.insertText('키보드 예산 확인')
    await tabTo('부서')
    await press('ArrowDown', { code: 'ArrowDown', keyCode: 40 })
    await tabTo('담당')
    await press('ArrowDown', { code: 'ArrowDown', keyCode: 40 })
    await press('s', { code: 'KeyS', modifiers: 2, keyCode: 83 })
    await app.status('저장했습니다')
    const made = (await documentsIn(vault)).filter((n) => !before.includes(n))
    assert.equal(made.length, 1, 'one document saved')
    const saved = await fileValues(join(vault, '문서', made[0]))
    assert.equal(saved.요청, '키보드 예산 확인')
    assert.ok(saved.부서 && saved.담당, `both choices made: ${saved.부서} · ${saved.담당}`)
    assert.ok(keys <= 12, `${keys} keys for one document`)
    await app.noAlert()
    await app.learning()
    for (const name of made) await rm(join(vault, '문서', name))
  },

  async 'opens the vault and the place it was left at, on the next launch'(app, vault) {
    await app.tabOf(INTAKE, '문서')
    await new Promise((resolve) => setTimeout(resolve, 500)) // where it is has been written down
    // Launched again, and nothing opened for it: it opens what it was showing.
    await app.restart()
    await app.cdp.waitFor(`document.querySelector('ll-app').vaultInfo?.name === ${JSON.stringify(basename(vault))}`, 'the vault it was using', { timeoutMs: 30_000 })
    await app.cdp.waitFor(`__e2e.one('button.item[aria-current="page"]')?.textContent.trim().endsWith(${JSON.stringify(INTAKE.name)})`, 'the template it was showing', { timeoutMs: 30_000 })
    assert.deepEqual(await app.where(), { place: INTAKE.name, tab: '문서' })
    await app.noAlert()
  },

  async 'keeps a narrow window usable: the sidebar is a drawer that gives way to a pick and to its backdrop'(app, vault) {
    // Below the shell's desktop breakpoint (1024px), and above the window's minimum width (720).
    const drawerOpen = () => app.cdp.evaluate(`__e2e.all('dp-shell')[0].hasAttribute('sidebar-open')`)
    const openDrawer = async () => {
      await app.click(`button[aria-label="사이드바 접기/펼치기"]`)
      await app.cdp.waitFor(`__e2e.all('dp-shell')[0].hasAttribute('sidebar-open')`, 'the drawer open')
    }
    await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
    try {
      await app.cdp.waitFor(`innerWidth === 800`, 'the narrow window')
      assert.equal(await drawerOpen(), false, 'the content is not covered to begin with')

      await openDrawer()
      await app.learning()
      await app.cdp.waitFor(`!__e2e.all('dp-shell')[0].hasAttribute('sidebar-open')`, 'the drawer closed on the pick')
      assert.equal((await app.where()).place, '학습')

      await openDrawer()
      await app.cdp.clickAt({ x: 600, y: 300 }) // the backdrop, right of the drawer
      await app.cdp.waitFor(`!__e2e.all('dp-shell')[0].hasAttribute('sidebar-open')`, 'the drawer closed on its backdrop')
      assert.equal((await app.where()).place, '학습', 'the backdrop picked nothing')

      await openDrawer()
      await app.cdp.press('Escape', { code: 'Escape', keyCode: 27 })
      await app.cdp.waitFor(`!__e2e.all('dp-shell')[0].hasAttribute('sidebar-open')`, 'the drawer closed on Escape')

      // Picking the place already shown still closes the drawer.
      await openDrawer()
      await app.learning()
      await app.cdp.waitFor(`!__e2e.all('dp-shell')[0].hasAttribute('sidebar-open')`, 'the drawer closed on the place already shown')

      // The list and a document take turns: one pane at a time, and a way back to the list.
      await openDrawer()
      await app.tabOf(INTAKE, '문서')
      const shown = () => app.cdp.evaluate(`(() => {
        const view = __e2e.all('dp-list-detail')[0], root = view.shadowRoot
        const visible = (sel) => getComputedStyle(root.querySelector(sel)).display !== 'none'
        return (visible('.list') ? 'list' : '') + (visible('.detail') ? 'detail' : '')
      })()`)
      await app.cdp.waitFor(`__e2e.all('ll-documents')[0]?.shadowRoot.querySelector('nav button.document')`, 'the list')
      assert.equal(await shown(), 'list')
      await app.click('nav button.document')
      await app.cdp.waitFor(`__e2e.all('dp-list-detail')[0].hasAttribute('detail-open')`, 'the document open')
      assert.equal(await shown(), 'detail')
      await app.click('dc-button.back', '목록으로')
      await app.cdp.waitFor(`!__e2e.all('dp-list-detail')[0].hasAttribute('detail-open')`, 'back at the list')
      assert.equal(await shown(), 'list')

      // A document that closes by being deleted returns to the list, and the list says what became of it.
      const doc = join(vault, '문서', '좁은 창에서 지울 문의.md')
      await writeFile(doc, `---
template: intake@1
요청: 지울 기록
---
${(await fileBody(join(vault, INTAKE.path))).trimStart()}`)
      try {
        await app.pickDocument('좁은 창에서 지울 문의')
        await app.cdp.waitFor(`__e2e.all('dp-list-detail')[0].hasAttribute('detail-open')`, 'the document open')
        await app.click('dc-button', '지우기')
        await app.click('dc-button', '휴지통으로 옮기기')
        await deleteForGoodOverSmb(app, '영구히 지우기')
        const said = SMB ? '지웠습니다' : '휴지통으로 옮겼습니다'
        await app.cdp.waitFor(
          `__e2e.all('p.closed').some((p) => p.checkVisibility() && p.textContent.trim() === ${q(said)}) && ${'!'}__e2e.all('dp-list-detail')[0].hasAttribute('detail-open')`,
          'the list saying the document is gone',
        )
        await trashed(join(vault, '문서'))
      } finally {
        await rm(doc, { force: true })
      }
      await app.noAlert()
    } finally {
      await app.cdp.send('Emulation.clearDeviceMetricsOverride')
    }
  },

  async 'lays a wide window out in three columns: the sidebar folds to its rail, the list is as wide as it, each scrolls on its own'(app) {
    const sidebar = `__e2e.all('dp-sidebar')[0]`
    const toggle = `button[aria-label="사이드바 접기/펼치기"]`
    await app.tabOf(INTAKE, '문서')
    const widths = () => app.cdp.evaluate(`(() => {
      // The list's column, scrollbar and all: a long list scrolls inside it.
      const list = __e2e.all('dp-list-detail')[0].shadowRoot.querySelector('.list').getBoundingClientRect()
      return { sidebar: Math.round(${sidebar}.getBoundingClientRect().width), list: Math.round(list.width) }
    })()`)
    const { sidebar: wide, list } = await widths()
    // 1 : 1 — the list is as wide as the sidebar (the list's own column, its border inside).
    assert.ok(Math.abs(wide - list) <= 2, `the list (${list}px) as wide as the sidebar (${wide}px)`)
    assert.equal(await app.cdp.evaluate(`__e2e.one(${JSON.stringify(toggle)}).getAttribute('aria-expanded')`), 'true')
    // The page does not scroll: the list and the document do, each on its own.
    assert.ok(
      await app.cdp.evaluate(`(() => { const p = __e2e.all('dp-page')[0]; return p.hasAttribute('fill') && p.scrollHeight <= p.clientHeight + 1 })()`),
      'the page itself does not scroll',
    )
    for (const pane of ['.list', '.detail'])
      assert.equal(await app.cdp.evaluate(`getComputedStyle(__e2e.all('dp-list-detail')[0].shadowRoot.querySelector('${pane}')).overflowY`), 'auto', pane)

    await app.click(toggle)
    await app.cdp.waitFor(`${sidebar}.hasAttribute('collapsed')`, 'the sidebar folded to its rail')
    assert.equal(await app.cdp.evaluate(`__e2e.one(${JSON.stringify(toggle)}).getAttribute('aria-expanded')`), 'false')
    assert.ok((await widths()).sidebar < wide / 2, 'the rail is narrow')
    assert.equal(await app.cdp.evaluate(`__e2e.all('dp-shell')[0].hasAttribute('sidebar-open')`), false, 'no drawer in a wide window')
    await app.click(toggle)
    await app.cdp.waitFor(`!${sidebar}.hasAttribute('collapsed')`, 'the sidebar whole again')
    await app.noAlert()
  },
  async 'starts the sidecar again when it ends during the session, and suggests again without the person doing anything'(app, vault) {
    const suggestion = `__e2e.one('[data-formdown-note="담당"] .formdown-suggestion')?.textContent`
    await app.newDocument(INTAKE)
    await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === ''`, 'an empty form')
    await app.fill('[data-field-name="요청"]', '프린터 토너가 없어요')
    await app.choose('select[name="부서"]', '영업')
    await app.cdp.waitFor(`${suggestion} === '장비'`, 'a suggestion for 담당', { timeoutMs: 15_000 })

    // The sidecar ends — killed, as a crash would end it.
    const sidecar = async (verb) =>
      (await command('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='Lowline.Host.exe' AND ParentProcessId=${app.child.pid}" | ForEach-Object { ${verb} }`,
      ])).trim()
    const first = await sidecar('$_.ProcessId')
    assert.match(first, /^\d+$/, 'one sidecar of this app')
    await sidecar('Stop-Process -Id $_.ProcessId -Force')

    // The next question finds it gone and starts it again: a sidecar of this app, not the one that ended. Waited
    // for first — the value suggested before stays on screen until the next question is asked, so seeing it
    // proves nothing about the sidecar started again.
    await app.choose('select[name="부서"]', '개발')
    await app.choose('select[name="부서"]', '영업')
    const status = `(async () => (await window.__TAURI_INTERNALS__.invoke('host_status')).state)()`
    let second = first
    for (const until = Date.now() + 60_000; second === first && Date.now() < until; ) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      // A status check finds it gone too, should the question have reached it while it was still ending.
      await app.cdp.evaluate(status, { timeoutMs: 15_000 })
      const found = await sidecar('$_.ProcessId')
      if (found) second = found
    }
    assert.match(second, /^\d+$/, `one sidecar of this app again (found ${JSON.stringify(second)})`)
    assert.notEqual(second, first, 'a sidecar started again')
    await app.cdp.waitFor(`${status}.then((state) => state === 'ready')`, 'the sidecar started again to be ready', { timeoutMs: 60_000 })

    // The vault is handed over again, and the same value is suggested once more — the person only goes on filling in.
    await app.cdp.waitFor(`${suggestion} === '장비'`, 'a suggestion for 담당 from the sidecar started again', { timeoutMs: 60_000 })
    // The sidecar's end was this scenario's doing: a later failure does not print it.
    await reportsCaused()

    // Leave the vault as it was.
    await app.learning()
    await app.answerUnsaved('편집 버리기')
  },

  // With LOWLINE_PERF=1: what reading one file through the shell costs, the step a full read of
  // the vault repeats once per document.
  ...(process.env.LOWLINE_PERF === '1' && {
    async 'measures reading files through the shell'(app, vault) {
      const [name] = await documentsIn(vault)
      const path = `문서/${name}`
      const ms = await app.cdp.evaluate(`(async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke
        for (let i = 0; i < 50; i++) await invoke('read_file', { path: ${JSON.stringify(path)} })
        const started = performance.now()
        for (let i = 0; i < 1000; i++) await invoke('read_file', { path: ${JSON.stringify(path)} })
        const sequential = performance.now() - started
        const again = performance.now()
        await Promise.all(Array.from({ length: 1000 }, () => invoke('read_file', { path: ${JSON.stringify(path)} })))
        const all = performance.now() - again
        const batch = performance.now()
        await invoke('read_files', { paths: Array.from({ length: 1000 }, () => ${JSON.stringify(path)}) })
        return [Math.round(sequential), Math.round(all), Math.round(performance.now() - batch)]
      })()`)
      console.log(`    1000 reads through the shell · one at a time ${ms[0]} ms · all at once ${ms[1]} ms · in one call ${ms[2]} ms`)
    },
    async 'measures one outside edit in a vault of 10,000 documents'(app, vault) {
      const COUNT = 10_000
      const file = (i) => join(vault, '문서', `perf-${String(i).padStart(5, '0')}.md`)
      const source = await readFile(join(vault, '문서', '접수-1.md'), 'utf8')
      for (let i = 0; i < COUNT; i += 500) {
        await Promise.all(
          Array.from({ length: Math.min(500, COUNT - i) }, (_, j) =>
            writeFile(file(i + j), source.replace('노트북 배터리가 금방 닳아요', `노트북 배터리가 금방 닳아요 (${i + j})`)),
          ),
        )
      }
      // A fresh start reads the full vault once, filling the cache.
      const filled = Date.now()
      await app.reopen(vault)
      const opened = Date.now() - filled
      await app.showTable(INTAKE, { timeoutMs: 300_000 })
      await app.cdp.waitFor(`__e2e.all('tbody tr').some((tr) => tr.textContent.includes('(0)'))`, 'the large table', { timeoutMs: 300_000 })
      const first = Date.now() - filled
      // Where the restart went: the window and the vault opened, then each sync step, summed over the
      // syncs it took, each sync's share apart — so a slower restart says which step grew, and whether in
      // the first sync or in the ones after it.
      const syncSteps = async () => {
        const each = await app.cdp.evaluate(`(() => { const each = {}
          for (const m of performance.getEntriesByType('measure')) if (m.name.startsWith('vault:')) (each[m.name.slice(6)] ??= []).push(Math.round(m.duration))
          return each })()`)
        return Object.entries(each)
          .map(([k, v]) => `${k} ${v.reduce((a, b) => a + b, 0)}${v.length > 1 ? ` (${v.join('+')})` : ''}`)
          .join(' · ')
      }
      const restartSteps = await syncSteps()
      const restartBlocked = await longTasks(app)
      // Ten thousand new documents: the sidecar replays the fields' history for their thresholds meanwhile.
      const replaying = await sidecarCpuOver(5_000)

      await app.cdp.evaluate(`performance.clearMeasures()`)
      const edited = Date.now()
      await writeFile(file(0), source.replace('노트북 배터리가 금방 닳아요', '노트북 충전기가 고장났어요 (고침)'))
      await app.cdp.waitFor(`__e2e.all('tbody tr').some((tr) => tr.textContent.includes('(고침)'))`, 'the edit in the table', { timeoutMs: 120_000 })
      const edit = Date.now() - edited
      const steps = await app.cdp.evaluate(
        `Object.fromEntries(performance.getEntriesByType('measure').filter((m) => m.name.startsWith('vault:')).map((m) => [m.name.slice(6), Math.round(m.duration)]))`,
      )

      // A later launch with nothing changed: the thresholds the first launch's replay chose are kept beside
      // the cache, so the sidecar has no replay to run — its CPU over the seconds after is what an idle app costs.
      // The first launch's work is let finish first — its replay and its text index, whichever ends last — or the
      // later launch would only be finishing it.
      const kept = await thresholdsChosenSince(filled)
      const settled = await sidecarQuiet()
      const again = Date.now()
      await app.reopen(vault)
      const reopened = Date.now() - again
      await app.showTable(INTAKE, { timeoutMs: 300_000 })
      await app.cdp.waitFor(`__e2e.all('tbody tr').some((tr) => tr.textContent.includes('(고침)'))`, 'the table again', { timeoutMs: 300_000 })
      const unchanged = Date.now() - again
      const unchangedSteps = await syncSteps()
      const unchangedBlocked = await longTasks(app)
      const idle = await sidecarCpuOver(5_000)
      console.log(
        `    ${COUNT} documents · restart to table ${first} ms (window and vault ${opened} · ${restartSteps} ms · ${restartBlocked}) · one outside edit to table ${edit} ms · last sync ${Object.entries(steps).map(([k, v]) => `${k} ${v} ms`).join(' · ')}`,
      )
      console.log(`    sidecar CPU over 5 s after that restart ${replaying} ms · unchanged restart to table ${unchanged} ms (window and vault ${reopened} · ${unchangedSteps} ms · ${unchangedBlocked}) · sidecar CPU over the next 5 s ${idle} ms${kept ? '' : ' (no thresholds were kept)'}${settled ? '' : ' (the first launch never went quiet)'}`)
    },
  }),
}
