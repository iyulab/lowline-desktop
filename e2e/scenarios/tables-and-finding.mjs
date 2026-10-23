import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { parseFormdown } from '@formdown/core'
import { q } from '../app.mjs'
import { INTAKE, fileValues } from '../shared.mjs'

export default {
  async 'filters a table by name, by a choice field, and by text in a field'(app, vault) {
    const intake = []
    for (const name of (await readdir(join(vault, '문서'))).filter((n) => n.endsWith('.md'))) {
      const values = await fileValues(join(vault, '문서', name))
      if (values.template === 'intake@1') intake.push({ name: name.replace(/\.md$/, ''), ...values })
    }
    const shows = (n, what) =>
      app.cdp.waitFor(
        `__e2e.all('[role=status]').some((el) => el.textContent.trim() === ${q(what)}) && (${n} === 0 || __e2e.all('tbody tr').length === ${n})`,
        what,
        { timeoutMs: 15_000 },
      )
    const pick = (label, value) =>
      app.cdp.evaluate(`(() => { const s = __e2e.all('dc-select').find((el) => el.getAttribute('aria-label') === ${q(label)})
        const inner = s.shadowRoot.querySelector('select'); inner.value = ${q(value)}; inner.dispatchEvent(new Event('change')); return true })()`)
    const typeIn = (label, text) =>
      app.cdp.evaluate(`(() => { const i = __e2e.all('dc-input').find((el) => el.getAttribute('aria-label') === ${q(label)})
        const inner = i.shadowRoot.querySelector('input'); inner.value = ${q(text)}
        inner.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)

    await app.showTable(INTAKE)
    await shows(intake.length, `문서 ${intake.length}건`)

    // A choice field's value: the rows whose 부서 is 영업.
    const sales = intake.filter((d) => d.부서 === '영업')
    assert.ok(sales.length > 1, 'more than one document of 영업 to filter')
    await pick('부서', '영업')
    await shows(sales.length, `조건에 맞는 문서 ${sales.length}건`)
    const column = await app.cdp.evaluate(`__e2e.all('thead th').map((th) => th.textContent).indexOf('부서')`)
    const shown = await app.cdp.evaluate(`__e2e.all('tbody tr').map((tr) => tr.children[${column}].textContent.trim())`)
    assert.deepEqual([...new Set(shown)], ['영업'])

    // And a name: every filter holds.
    const named = sales.filter((d) => d.name.includes('A-1'))
    assert.equal(named.length, 1)
    await typeIn('이름에 든 글자', 'A-1')
    await shows(1, '조건에 맞는 문서 1건')

    // Text within a field, alone.
    await pick('부서', '')
    await typeIn('이름에 든 글자', '')
    await pick('글자를 찾을 칸', '요청')
    await typeIn('칸에 든 글자', '토너')
    const toner = intake.filter((d) => String(d.요청 ?? '').includes('토너'))
    assert.ok(toner.length > 0)
    await shows(toner.length, `조건에 맞는 문서 ${toner.length}건`)

    // Nothing matching says so; cleared, every document is back.
    await typeIn('칸에 든 글자', '어디에도 없는 말')
    await shows(0, '조건에 맞는 문서 0건')
    assert.ok(await app.cdp.evaluate(`__e2e.all('dc-data-table').some((t) => t.shadowRoot.textContent.includes('조건에 맞는 문서가 없습니다'))`))
    await typeIn('칸에 든 글자', '')
    await shows(intake.length, `문서 ${intake.length}건`)

    // A judgment field left blank — as in records another program wrote for a person to confirm — is found by its
    // filter's 「비어 있음」, whether the field is written empty or not written at all; with another field's value, both hold.
    const blanks = [join(vault, '문서', '밖에서 쓴 기록-1.md'), join(vault, '문서', '밖에서 쓴 기록-2.md')]
    await writeFile(blanks[0], '---\ntemplate: intake@1\n요청: 밖에서 쓴 요청 1\n부서: 영업\n담당: ""\n---\n# 접수\n')
    await writeFile(blanks[1], '---\ntemplate: intake@1\n요청: 밖에서 쓴 요청 2\n부서: 개발\n---\n# 접수\n')
    const unsettled = intake.filter((d) => !String(d.담당 ?? '').trim())
    await shows(intake.length + 2, `문서 ${intake.length + 2}건`)
    assert.ok(
      await app.cdp.evaluate(`__e2e.all('dc-select').find((el) => el.getAttribute('aria-label') === '담당').options.some((o) => o.label === '담당: 비어 있음')`),
      'the filter offers 비어 있음',
    )
    await pick('담당', '\u0000')
    await shows(unsettled.length + 2, `조건에 맞는 문서 ${unsettled.length + 2}건`)
    await pick('부서', '개발')
    const unsettledDev = unsettled.filter((d) => d.부서 === '개발').length + 1
    await shows(unsettledDev, `조건에 맞는 문서 ${unsettledDev}건`)
    // A value picked in its place takes the blank away.
    await pick('부서', '')
    await pick('담당', '장비')
    const equipment = intake.filter((d) => d.담당 === '장비').length
    await shows(equipment, `조건에 맞는 문서 ${equipment}건`)
    await pick('담당', '')
    await Promise.all(blanks.map((f) => rm(f)))
    await shows(intake.length, `문서 ${intake.length}건`)

    // The document list narrows by name as it is typed.
    await app.documentsOf(INTAKE)
    await app.cdp.waitFor(
      `__e2e.all('ll-documents').flatMap((d) => [...d.shadowRoot.querySelectorAll('nav button')]).length === ${intake.length}`,
      'the whole list',
    )
    const all = await app.documentLabels()
    // Names are looked in at once; values after the sidecar answers — no value here holds "a-1".
    const searched = `!__e2e.all('ll-documents').some((d) => [...d.shadowRoot.querySelectorAll('p.message')].some((p) => p.textContent.includes('칸 값에서 찾는 중')))`
    await typeIn('이름이나 칸 값으로 찾기', 'a-1')
    await app.cdp.waitFor(`(${JSON.stringify(all.filter((l) => l.toLowerCase().includes('a-1')))}).join('|') === __e2e.all('ll-documents').flatMap((d) => [...d.shadowRoot.querySelectorAll('nav button')]).map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).join('|') && ${searched}`, 'the list narrowed to A-1, ignoring case', { timeoutMs: 15_000 })
    await typeIn('이름이나 칸 값으로 찾기', '어디에도 없는 이름')
    await app.cdp.waitFor(`__e2e.all('p.message').some((p) => p.textContent.includes('이름이나 칸 값이 맞는 문서가 없습니다'))`, 'nothing matching said', { timeoutMs: 15_000 })
    await typeIn('이름이나 칸 값으로 찾기', '')
    assert.deepEqual(await app.documentLabels(), all)
    await app.noAlert()
  },

  async 'lists only the documents with a judgment left empty, and saves one and opens the next with Ctrl+Enter'(app, vault) {
    // Records another program wrote for a person to confirm: 담당 written empty, or not written at all.
    const written = [1, 2, 3].map((i) => join(vault, '문서', `확인할 기록-${i}.md`))
    // A document is a copy of its template's body, as the program writing it is told (`docs/vault.md`).
    const body = '# 접수\n\n요청: ___@요청\n\n@부서: [select options="영업,개발,인사"]\n\n@담당: [select options="장비,인사,총무"]\n'
    await writeFile(written[0], `---\ntemplate: intake@1\n요청: 밖에서 쓴 요청 1\n부서: 영업\n담당: ""\n---\n${body}`)
    await writeFile(written[1], `---\ntemplate: intake@1\n요청: 밖에서 쓴 요청 2\n부서: 개발\n---\n${body}`)
    // One written with its front matter alone: it is drawn with its template's body, and saving makes it the copy.
    await writeFile(written[2], '---\ntemplate: intake@1\n요청: 밖에서 쓴 요청 3\n부서: 인사\n---\n# 접수\n')
    const unsettledNow = async () => {
      let n = 0
      for (const name of (await readdir(join(vault, '문서'))).filter((n) => n.endsWith('.md') && !n.includes('충돌'))) {
        const values = await fileValues(join(vault, '문서', name))
        if (values.template === 'intake@1' && !String(values.담당 ?? '').trim()) n++
      }
      return n
    }
    const unsettled = await unsettledNow()
    assert.ok(unsettled >= 3)
    const listedCount = `__e2e.all('ll-documents').flatMap((d) => [...d.shadowRoot.querySelectorAll('nav button.document')]).length`
    const openName = `__e2e.all('ll-documents').flatMap((d) => [...d.shadowRoot.querySelectorAll('nav button[aria-current="true"]')]).map((b) => b.textContent.replace(/\\s+/g, ' ').trim())[0]`

    await app.documentsOf(INTAKE)
    await app.click('dc-checkbox', `미확정만 (${unsettled})`)
    await app.cdp.waitFor(`${listedCount} === ${unsettled}`, 'only the unsettled documents listed', { timeoutMs: 15_000 })

    // One is settled and saved with Ctrl+Enter, and the next unsettled one opens.
    // The form of the document clicked, not the one open before it: on a slow vault (SMB) the earlier form is still
    // drawn for a moment, and a value chosen there is not the clicked document's.
    const formOf = (i, 부서) =>
      app.cdp.waitFor(`__e2e.one('select[name="담당"]') && __e2e.one('select[name="부서"]')?.value === '${부서}'`, `the form of 확인할 기록-${i}`, { timeoutMs: 15_000 })
    await app.click('nav button.document', '확인할 기록-1')
    await formOf(1, '영업')
    await app.choose('select[name="담당"]', '장비')
    await app.cdp.press('Enter', { code: 'Enter', modifiers: 2, keyCode: 13 })
    await app.cdp.waitFor(`${openName} !== undefined && !${openName}.startsWith('확인할 기록-1')`, 'the next unsettled document open', { timeoutMs: 15_000 })
    assert.equal((await fileValues(written[0])).담당, '장비', 'saved')
    // Written without an id, it is given its path as one when saved: what is recorded about it follows it if moved.
    assert.deepEqual((await fileValues(written[0])).lowline, { id: '문서/확인할 기록-1.md' })
    await app.cdp.waitFor(`${listedCount} === ${unsettled - 1}`, 'the saved document gone from the unsettled list', { timeoutMs: 15_000 })
    assert.ok(await app.cdp.evaluate(`__e2e.all('dc-checkbox').some((c) => c.textContent.trim() === '미확정만 (${unsettled - 1})')`))
    await app.noAlert()

    await app.click('nav button.document', '확인할 기록-3')
    await formOf(3, '인사') // a record written with its front matter alone is drawn with its template's fields
    await app.choose('select[name="담당"]', '인사')
    await app.cdp.press('s', { code: 'KeyS', modifiers: 2, keyCode: 83 })
    await app.status('저장했습니다')
    assert.deepEqual(parseFormdown(await readFile(written[2], 'utf8')).forms.map((f) => f.name), ['요청', '부서', '담당'], 'the body written')
    assert.equal((await fileValues(written[2])).담당, '인사')
    await app.noAlert()

    // The learning screen says how many of the documents suggestions learn from no one saved here: those written
    // with a judgment value by another program — the fixture's records — and not the two just saved.
    let outside = 0
    let confirmed = 0
    for (const name of (await readdir(join(vault, '문서'))).filter((n) => n.endsWith('.md') && !n.includes('충돌'))) {
      const values = await fileValues(join(vault, '문서', name))
      if (values.template !== 'intake@1' || !String(values.담당 ?? '').trim()) continue
      confirmed++
      if (!values.lowline?.id) outside++
    }
    assert.ok(outside > 0 && confirmed > outside, `${outside} of ${confirmed} written outside`)
    await app.click('dc-checkbox', `미확정만 (${unsettled - 2})`)
    await app.learning() // nothing open: removing the records is not an open document gone
    await app.cdp.waitFor(
      `__e2e.all('p.outside').some((p) => p.textContent.startsWith('접수: 판단 칸이 채워진 문서 ${confirmed}건 가운데 ${outside}건은 Lowline에서 저장한 적이 없습니다.'))`,
      'the documents no one saved here counted on the learning screen',
      { timeoutMs: 15_000 },
    )

    // Leave the vault as the scenarios after this one expect it.
    await Promise.all(written.map((f) => rm(f)))
    await app.documentsOf(INTAKE)
    await app.cdp.waitFor(`!__e2e.all('ll-documents').some((d) => d.shadowRoot.textContent.includes('확인할 기록'))`, 'the records gone from the list', {
      timeoutMs: 30_000,
    })
  },

  async 'finds documents by the words of their values, and opens one of the cases most like a document'(app, vault) {
    const CASES = { name: '사례', ref: 'cases@1', path: '서식/사례.fd.md' }
    const body = '# 사례\n\n요청: ___@요청\n\n@담당: [select options="장비,인사"]\n'
    const files = [join(vault, CASES.path)]
    await writeFile(files[0], `---\nid: cases\nversion: 1\nlowline:\n  suggest: [담당]\n---\n${body}`)
    const cases = [
      ['프린터', '프린터 토너가 떨어졌어요', '장비'],
      ['복합기', '복합기 토너 교체 요청', '장비'],
      ['연차', '연차를 이월하고 싶어요', '인사'],
    ]
    for (const [name, request, owner] of cases) {
      const file = join(vault, '문서', `${name}.md`)
      files.push(file)
      await writeFile(file, `---\ntemplate: cases@1\n요청: ${request}\n담당: ${owner}\n---\n${body}`)
    }
    const typeIn = (text) =>
      app.cdp.evaluate(`(() => { const i = __e2e.all('dc-input').find((el) => el.getAttribute('aria-label') === '이름이나 칸 값으로 찾기')
        const inner = i.shadowRoot.querySelector('input'); inner.value = ${q(text)}
        inner.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)
    const listed = `__e2e.all('ll-documents').flatMap((d) => [...d.shadowRoot.querySelectorAll('nav button')]).map((b) => b.textContent.replace(/\\s+/g, ' ').trim())`
    try {
      await app.tabOf(CASES, '문서', { timeoutMs: 30_000 })
      await app.cdp.waitFor(`(${listed}).length === 3`, 'the three documents', { timeoutMs: 30_000 })

      // No name holds "토너"; two documents' values do, and each shows the line that matched.
      await typeIn('토너')
      const found = await app.cdp.waitFor(`(() => { const l = ${listed}; return l.length === 2 && l })()`, 'the documents holding 토너', { timeoutMs: 30_000 })
      assert.deepEqual([...found].sort(), ['복합기 복합기 토너 교체 요청', '프린터 프린터 토너가 떨어졌어요'])
      // A stem finds a word with its ending: "이월" in "이월하고".
      await typeIn('이월')
      await app.cdp.waitFor(`(${listed}).join('|') === '연차 연차를 이월하고 싶어요'`, 'the document holding 이월', { timeoutMs: 15_000 })
      await typeIn('')
      await app.cdp.waitFor(`(${listed}).length === 3`, 'the whole list again')

      // The cases most like a document: asked for by opening them, the same template's, itself left out.
      await app.pickDocument('프린터')
      await app.cdp.waitFor(`__e2e.one('select[name="담당"]')?.value === '장비'`, 'the document open')
      await app.click('summary', '비슷한 사례')
      const similar = await app.cdp.waitFor(
        `(() => { const b = __e2e.all('.similar button').map((b) => b.textContent.replace(/\\s+/g, ' ').trim()); return b.length ? b : null })()`,
        'the similar cases',
        { timeoutMs: 30_000 },
      )
      // Each with what it confirmed in the judgment field: evidence to read, not a suggestion.
      assert.equal(similar[0], '복합기 복합기 토너 교체 요청 확정: 담당 장비')
      assert.ok(!similar.some((s) => s.startsWith('프린터')), 'itself left out')
      await app.click('.similar button', similar[0])
      await app.cdp.waitFor(`__e2e.one('[data-field-name="요청"]')?.textContent === '복합기 토너 교체 요청'`, 'the similar case open')
      await app.noAlert()
    } finally {
      // Leave the vault as the scenarios after this one expect it.
      await app.learning()
      await Promise.all(files.map((f) => rm(f, { force: true })))
    }
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '사례')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
  },

  async "filters a table by a number field's bounds"(app, vault) {
    const SCORES = { name: '점수표', ref: 'scores@1', path: '서식/점수표.fd.md' }
    const body = '# 점수표\n\n제목: ___@제목\n\n@점수: [number]\n'
    const files = [join(vault, SCORES.path)]
    await writeFile(files[0], `---\nid: scores\nversion: 1\n---\n${body}`)
    for (const [i, score] of ['1', '2.5', '3', ''].entries()) {
      const file = join(vault, '문서', `점수-${i + 1}.md`)
      files.push(file)
      await writeFile(file, `---\ntemplate: scores@1\n제목: 기록 ${i + 1}\n${score ? `점수: ${score}\n` : ''}---\n${body}`)
    }
    const shows = (n, what) =>
      app.cdp.waitFor(
        `__e2e.all('[role=status]').some((el) => el.textContent.trim() === ${q(what)}) && __e2e.all('tbody tr').length === ${n}`,
        what,
        { timeoutMs: 15_000 },
      )
    const typeIn = (label, text) =>
      app.cdp.evaluate(`(() => { const i = __e2e.all('dc-input').find((el) => el.getAttribute('aria-label') === ${q(label)})
        const inner = i.shadowRoot.querySelector('input'); inner.value = ${q(text)}
        inner.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)
    try {
      await app.showTable(SCORES, { timeoutMs: 30_000 })
      await shows(4, '문서 4건')
      await typeIn('점수 이상', '2')
      await shows(2, '조건에 맞는 문서 2건')
      // Both bounds hold, and each is included.
      await typeIn('점수 이하', '2.5')
      await shows(1, '조건에 맞는 문서 1건')
      assert.ok(await app.cdp.evaluate(`__e2e.all('tbody tr')[0].textContent.includes('기록 2')`))
      await typeIn('점수 이상', '')
      await typeIn('점수 이하', '')
      await shows(4, '문서 4건')
      await app.noAlert()
    } finally {
      await app.learning()
      await Promise.all(files.map((f) => rm(f, { force: true })))
    }
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '점수표')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
  },

  async "fills a field that refers to another template's documents by their names, keeping their ids"(app, vault) {
    const CUSTOMER = { name: '고객', ref: 'customer@1', path: '서식/고객.fd.md' }
    const INQUIRY = { name: '문의', ref: 'inquiry@1', path: '서식/문의.fd.md' }
    const customerBody = '# 고객\n\n상호: ___@상호\n'
    const inquiryBody = '# 문의\n\n@고객 -> customer: [select]\n\n내용: ___@내용\n'
    const files = [
      [CUSTOMER.path, `---\nid: customer\nversion: 1\n---\n${customerBody}`],
      [INQUIRY.path, `---\nid: inquiry\nversion: 1\n---\n${inquiryBody}`],
      ['문서/한빛상사.md', `---\ntemplate: customer@1\nlowline:\n  id: c-hanbit\n상호: 한빛상사\n---\n${customerBody}`],
      ['문서/가나상회.md', `---\ntemplate: customer@1\nlowline:\n  id: c-gana\n상호: 가나상회\n---\n${customerBody}`],
      ['문서/옛 문의.md', `---\ntemplate: inquiry@1\n고객: 3f2a1b2c-0000-4000-8000-000000000000\n내용: 옛 기록\n---\n${inquiryBody}`],
    ].map(([path, text]) => [join(vault, path), text])
    for (const [file, text] of files) await writeFile(file, text)
    const offered = () =>
      app.cdp.evaluate(`[...__e2e.one('select[name="고객"]').options].map((o) => o.value + '=' + o.textContent.trim())`)
    try {
      await app.tabOf(INQUIRY, '문서', { timeoutMs: 30_000 })
      // The template inquiries refer to leads the sidebar, in a group of its own.
      await app.cdp.waitFor(
        `__e2e.all('#group-references[aria-label="기준"] .label').map((l) => l.textContent.trim()).join('|') === '고객'`,
        'the group of templates referred to',
        { timeoutMs: 15_000 },
      )
      await app.click('dc-button', '새 문서')
      await app.cdp.waitFor(`__e2e.one('select[name="고객"]')?.options.length === 2`, 'the customers offered', { timeoutMs: 15_000 })
      // By name, valued by id; nothing picked until the person picks.
      assert.deepEqual(await offered(), ['c-gana=가나상회', 'c-hanbit=한빛상사'])
      assert.equal(await app.cdp.evaluate(`__e2e.one('select[name="고객"]').selectedIndex`), -1)
      const before = new Set(await readdir(join(vault, '문서')))
      await app.choose('select[name="고객"]', 'c-hanbit')
      await app.fill('[data-field-name="내용"]', '견적 요청')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      const saved = (await readdir(join(vault, '문서'))).find((f) => !before.has(f))
      assert.ok(saved, 'the new inquiry saved')
      files.push([join(vault, '문서', saved)])
      assert.equal((await fileValues(join(vault, '문서', saved))).고객, 'c-hanbit', 'the file keeps the id')

      // A value naming a document the vault does not have is kept, and said to be missing.
      await app.pickDocument('옛 문의')
      await app.cdp.waitFor(
        `[...(__e2e.one('select[name="고객"]')?.options ?? [])].some((o) => o.selected && o.textContent.trim() === '없는 고객 (3f2a1b2c)')`,
        'the missing customer shown',
        { timeoutMs: 15_000 },
      )

      // The table names the customer, and filters by the customer picked by name.
      await app.showTable(INQUIRY)
      const cells = () => app.cdp.evaluate(`__e2e.all('tbody tr').map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`)
      await app.cdp.waitFor(`__e2e.all('tbody tr').length === 2`, 'both inquiries in the table', { timeoutMs: 15_000 })
      const rows = await cells()
      assert.ok(rows.some((r) => r.includes('한빛상사')), `named in the table: ${rows}`)
      assert.ok(rows.some((r) => r.includes('없는 고객 (3f2a1b2c)')), `missing said in the table: ${rows}`)
      assert.ok(!rows.some((r) => r.includes('c-hanbit')), 'the id is not what is shown')
      await app.cdp.evaluate(`(() => { const s = __e2e.all('dc-select').find((el) => el.getAttribute('aria-label') === '고객')
        const inner = s.shadowRoot.querySelector('select'); inner.value = 'c-hanbit'; inner.dispatchEvent(new Event('change')); return true })()`)
      await app.cdp.waitFor(
        `__e2e.all('[role=status]').some((el) => el.textContent.trim() === '조건에 맞는 문서 1건') && __e2e.all('tbody tr').length === 1`,
        'the inquiries of 한빛상사',
        { timeoutMs: 15_000 },
      )

      // A customer lists the inquiries naming it as a table — each by its name, then its fields but 고객 — and one
      // opens in its own place.
      const inquiryName = saved.replace(/\.md$/, '')
      await app.openDocument(CUSTOMER, '한빛상사')
      const row = await app.cdp.waitFor(
        `__e2e.all('div.referring dc-data-table').flatMap((t) => [...t.shadowRoot.querySelectorAll('tbody tr')]).map((r) => r.textContent.replace(/\\s+/g, ' ').trim()).find((t) => t.startsWith(${q(inquiryName)}))`,
        'the inquiry naming 한빛상사',
        { timeoutMs: 15_000 },
      )
      assert.ok(row.includes('견적 요청') && !row.includes('한빛상사'), `the inquiry's fields but the one naming the customer: ${row}`)
      assert.ok(await app.cdp.evaluate(`__e2e.all('div.referring h4').some((h) => h.textContent.trim() === '문의 1건')`))
      await app.click('tbody th button', inquiryName) // the table's rows are its own: one opens by its name
      await app.cdp.waitFor(
        `__e2e.one('nav button[aria-current="true"]')?.textContent.trim() === ${q(inquiryName)} && __e2e.one('select[name="고객"]')?.value === 'c-hanbit'`,
        'the inquiry open in its own place',
        { timeoutMs: 15_000 },
      )
      assert.equal((await app.where()).place, '문의')
      await app.openDocument(CUSTOMER, '가나상회')
      await app.cdp.waitFor(
        `__e2e.all('div.referring h4').some((h) => h.textContent.trim() === '문의 0건') && __e2e.all('div.referring dc-data-table').flatMap((t) => [...t.shadowRoot.querySelectorAll('tbody tr')]).length === 0`,
        'nothing naming 가나상회',
      )

      // Rows pasted into the inquiries name their customers by name: each comes in holding the customer's id, and a
      // name no customer has is kept as written and said.
      const pastedBefore = new Set(await readdir(join(vault, '문서')))
      await app.documentsOf(INQUIRY)
      await app.click('dc-button', '가져오기')
      const zone = `__e2e.all('textarea').find((t) => t.getRootNode().host?.localName === 'dc-paste-rows-zone')`
      await app.cdp.waitFor(`Boolean(${zone})`, 'the paste zone')
      const pasted = [['고객', '내용'], ['가나상회', '배송 문의'], ['없는회사', '반품 문의']].map((r) => r.join('\t')).join('\n')
      await app.cdp.evaluate(`(() => {
        const data = new DataTransfer()
        data.setData('text/plain', ${q(pasted)})
        ${zone}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        return true
      })()`)
      await app.status('문서 2건을 만듭니다')
      assert.ok(
        await app.cdp.evaluate(`__e2e.all('li').some((li) => li.textContent.trim() === '3행 고객: 없는회사 — 이 이름의 문서가 없거나 둘 이상입니다')`),
        'a name no customer has is said',
      )
      await app.click('dc-button', '2건 가져오기')
      await app.status('2건을 가져왔습니다')
      const imported = (await readdir(join(vault, '문서'))).filter((f) => !pastedBefore.has(f))
      for (const name of imported) files.push([join(vault, '문서', name)])
      const customers = await Promise.all(imported.map(async (name) => (await fileValues(join(vault, '문서', name))).고객))
      assert.deepEqual(customers.sort(), ['c-gana', '없는회사'], 'the customer named by name is held by its id')
      await app.openDocument(CUSTOMER, '가나상회')
      await app.cdp.waitFor(`__e2e.all('div.referring h4').some((h) => h.textContent.trim() === '문의 1건')`, 'the imported inquiry naming 가나상회', {
        timeoutMs: 15_000,
      })

      // A row added under the customer: a new inquiry, started naming it, in the inquiries' place.
      const addedBefore = new Set(await readdir(join(vault, '문서')))
      await app.click('div.referring dc-button', '새 문의')
      await app.cdp.waitFor(`__e2e.one('select[name="고객"]')?.value === 'c-gana'`, 'a new inquiry naming 가나상회', { timeoutMs: 15_000 })
      assert.equal((await app.where()).place, '문의')
      await app.fill('[data-field-name="내용"]', '설치 문의')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      const added = (await readdir(join(vault, '문서'))).find((f) => !addedBefore.has(f))
      assert.ok(added, 'the new inquiry saved')
      files.push([join(vault, '문서', added)])
      assert.equal((await fileValues(join(vault, '문서', added))).고객, 'c-gana', 'it names the customer by id')
      await app.openDocument(CUSTOMER, '가나상회')
      await app.cdp.waitFor(
        `__e2e.all('div.referring h4').some((h) => h.textContent.trim() === '문의 2건') && __e2e.all('div.referring dc-data-table').flatMap((t) => [...t.shadowRoot.querySelectorAll('tbody tr')]).some((r) => r.textContent.includes('설치 문의'))`,
        'the added inquiry under 가나상회',
        { timeoutMs: 15_000 },
      )
      await app.noAlert()
    } finally {
      await app.learning()
      await Promise.all(files.map(([f]) => rm(f, { force: true })))
    }
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '문의')`, 'the templates gone from the sidebar', { timeoutMs: 30_000 })
  },

  async 'narrows a field referring to many documents by typing part of a name, keeping the id'(app, vault) {
    const SHOP = { name: '업소', ref: 'shop@1', path: '서식/업소.fd.md' }
    const VISIT = { name: '점검', ref: 'visit@1', path: '서식/점검.fd.md' }
    const shopBody = '# 업소\n\n상호: ___@상호\n'
    const visitBody = '# 점검\n\n@업소 -> shop: [select]\n\n내용: ___@내용\n'
    // More than a select lists comfortably: the field becomes one to type into.
    const shops = Array.from({ length: 30 }, (_, i) => (i === 17 ? '푸른들 정육점' : `가게 ${String(i + 1).padStart(2, '0')}`))
    const files = [
      [SHOP.path, `---\nid: shop\nversion: 1\n---\n${shopBody}`],
      [VISIT.path, `---\nid: visit\nversion: 1\n---\n${visitBody}`],
      ...shops.map((name, i) => [`문서/${name}.md`, `---\ntemplate: shop@1\nlowline:\n  id: s-${i + 1}\n상호: ${name}\n---\n${shopBody}`]),
    ].map(([path, text]) => [join(vault, path), text])
    for (const [file, text] of files) await writeFile(file, text)
    const combobox = `__e2e.one('input[role="combobox"]')`
    try {
      await app.tabOf(VISIT, '문서', { timeoutMs: 30_000 })
      await app.click('dc-button', '새 문서')
      await app.cdp.waitFor(`__e2e.one('select[name="업소"]')?.options.length === 30 && !!${combobox}`, 'the shops offered to type into', { timeoutMs: 15_000 })
      // The select is still the field, out of the way; the combobox is what a person reaches.
      assert.equal(await app.cdp.evaluate(`__e2e.one('select[name="업소"]').getAttribute('aria-hidden')`), 'true')

      await app.cdp.evaluate(`${combobox}.focus()`)
      await app.cdp.insertText('정육')
      await app.cdp.waitFor(
        `__e2e.all('[role="option"]').map((o) => o.textContent).join('|') === '푸른들 정육점'`,
        'the one shop whose name holds 정육',
      )
      await app.cdp.press('Enter', { keyCode: 13 })
      await app.cdp.waitFor(`${combobox}.value === '푸른들 정육점' && __e2e.one('select[name="업소"]').value === 's-18'`, 'the shop chosen')

      const before = new Set(await readdir(join(vault, '문서')))
      await app.fill('[data-field-name="내용"]', '냉장 온도 확인')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      const saved = (await readdir(join(vault, '문서'))).find((f) => !before.has(f))
      assert.ok(saved, 'the visit saved')
      files.push([join(vault, '문서', saved)])
      assert.equal((await fileValues(join(vault, '문서', saved))).업소, 's-18', 'the file keeps the id, not the name typed')
      await app.noAlert()
    } finally {
      await app.learning()
      await Promise.all(files.map(([f]) => rm(f, { force: true })))
    }
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '점검')`, 'the templates gone from the sidebar', { timeoutMs: 30_000 })
  },

  async 'filters a table by a date range and names the dates it could not read'(app, vault) {
    const VISITS = { name: '방문 기록', ref: 'visits@1', path: '서식/방문 기록.fd.md' }
    const body = '# 방문 기록\n\n제목: ___@제목\n\n@방문일: [date]\n'
    const files = [join(vault, VISITS.path)]
    await writeFile(files[0], `---\nid: visits\nversion: 1\n---\n${body}`)
    for (const [i, day] of ['2026-01-15', '2026-01-31', '2026-02-01', '다음 주쯤'].entries()) {
      const file = join(vault, '문서', `방문-${i + 1}.md`)
      files.push(file)
      await writeFile(file, `---\ntemplate: visits@1\n제목: 방문 ${i + 1}\n방문일: ${day}\n---\n${body}`)
    }
    const shows = (n, what) =>
      app.cdp.waitFor(
        `__e2e.all('[role=status]').some((el) => el.textContent.trim() === ${q(what)}) && __e2e.all('tbody tr').length === ${n}`,
        what,
        { timeoutMs: 15_000 },
      )
    const typeIn = (label, text) =>
      app.cdp.evaluate(`(() => { const i = __e2e.all('dc-input').find((el) => el.getAttribute('aria-label') === ${q(label)})
        const inner = i.shadowRoot.querySelector('input'); inner.value = ${q(text)}
        inner.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)
    try {
      await app.showTable(VISITS, { timeoutMs: 30_000 })
      // The unreadable date keeps its row; only its cell is empty, and the table says which.
      await shows(4, '문서 4건')
      assert.ok(await app.cdp.evaluate(`__e2e.all('tbody tr')[0].textContent.includes('2026-01-15')`), 'a date shows as written')
      await app.cdp.waitFor(
        `__e2e.all('.skipped summary').some((s) => s.textContent.trim() === '값을 읽지 못해 비운 칸 1개')`,
        'the unreadable date named',
      )
      await typeIn('방문일 부터', '2026-01-16')
      await shows(2, '조건에 맞는 문서 2건')
      // Both ends hold, and each is included.
      await typeIn('방문일 까지', '2026-01-31')
      await shows(1, '조건에 맞는 문서 1건')
      assert.ok(await app.cdp.evaluate(`__e2e.all('tbody tr')[0].textContent.includes('방문 2')`))
      await typeIn('방문일 부터', '')
      await typeIn('방문일 까지', '')
      await shows(4, '문서 4건')
      // In its document the date field cannot hold it either: the value shows beside the field, and a save keeps it.
      await app.openDocument(VISITS, '방문-4')
      await app.cdp.waitFor(`__e2e.all('.formdown-unread').some((el) => el.textContent === '다음 주쯤')`, 'the unreadable date beside its field')
      await app.fill('[data-field-name="제목"]', '방문 4 다시')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      const saved = await readFile(files[4], 'utf8')
      assert.match(saved, /방문일: 다음 주쯤/, 'the unreadable date kept by the save')
      assert.match(saved, /방문 4 다시/)
      await app.noAlert()
    } finally {
      await app.learning()
      await Promise.all(files.map((f) => rm(f, { force: true })))
    }
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '방문 기록')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
  },
}
