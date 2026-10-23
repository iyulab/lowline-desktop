import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { parseFormdown, readFrontMatter } from '@formdown/core'
import { TEMPLATE, BUG, INTAKE, documentsIn, fileValues } from '../shared.mjs'
import { SETTINGS, q } from '../app.mjs'

/** A one-page PDF showing `text` (ASCII) in a standard font: a blank form as small as one gets. */
function minimalPdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const at = pdf.length
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return at
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'ascii')
}

/** A request's body as text: its chunks put together first, so a character split between two is read whole. */
const bodyOf = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

export default {
  async 'starts the sidecar with the app'(app) {
    const status = await app.cdp.waitFor(
      `window.__TAURI_INTERNALS__.invoke('host_status').then((s) => s.state !== 'starting' && s)`,
      'the sidecar to start',
      { timeoutMs: 30_000 },
    )
    assert.deepEqual(status, { state: 'ready' })
  },

  async 'edits a template and saves it with Ctrl+S'(app, vault) {
    await app.templateOf(BUG)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: bug-report')`, 'the template source')
    await app.cdp.evaluate(`(() => { const t = __e2e.one('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true })()`)
    await app.cdp.insertText('\n메모: ___@메모\n')
    await app.cdp.press('s', { code: 'KeyS', modifiers: 2, keyCode: 83 })
    await app.status('저장했습니다')
    await app.noAlert()
    const onDisk = await readFile(join(vault, TEMPLATE), 'utf8')
    assert.equal(onDisk, await app.value('textarea'), 'file = editor text')
    assert.match(onDisk, /메모: ___@메모\n$/)
  },

  async 'says when the open template is removed outside, and saving makes it again'(app, vault) {
    const path = join(vault, TEMPLATE)
    const before = await readFile(path, 'utf8')
    await rm(path)
    await app.cdp.waitFor(
      `__e2e.all('[role=alert]').some((el) => el.textContent.includes('밖에서 지워졌습니다'))`,
      'the removal announced',
    )
    assert.equal(await app.value('textarea'), before, 'what was on screen is still there')

    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal(await readFile(path, 'utf8'), before, 'made again with what was on screen')
    await app.noAlert()
  },

  async 'turns suggestions on for a field from the template page, and shows it on the document'(app, vault) {
    const path = join(vault, TEMPLATE)
    await app.templateOf(BUG)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: bug-report')`, 'the template source')
    await app.click('dc-checkbox', '심각도')
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('suggest:role="judged"')`, 'the choice written on the field')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    const on = parseFormdown(await readFile(path, 'utf8'))
    assert.equal(on.forms.find((f) => f.name === '심각도')?.suggest?.role, 'judged')
    assert.equal(on.frontMatter?.data?.lowline, undefined, 'said on the field, not in the front matter')

    await app.newDocument(BUG)
    await app.cdp.waitFor(
      `__e2e.all('p.judgment').some((el) => el.textContent.includes('제안 받는 칸: 심각도'))`,
      'the judgment field named on the document',
      { timeoutMs: 30_000 },
    )

    // Off again: the attribute goes, and the rest of the file is as it was.
    await app.templateOf(BUG)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('suggest:role')`, 'the template source')
    await app.click('dc-checkbox', '심각도')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal(parseFormdown(await readFile(path, 'utf8')).forms.find((f) => f.name === '심각도')?.suggest, undefined)
    await app.noAlert()
  },

  async 'moves the judgment fields a template names in its front matter onto the fields, meaning the same'(app, vault) {
    const BEFORE = { name: '이전 방식', ref: 'before@1', path: '서식/이전 방식.fd.md' }
    const path = join(vault, BEFORE.path)
    const body = '# 이전 방식\n\n@코드: [text]\n\n@메모: [text]\n'
    await writeFile(path, `---\nid: before\nversion: 1\nlowline:\n  suggest: [코드]\n  coarse: { 코드: 2 }\n---\n${body}`)
    await app.sidebar(BEFORE.name, { timeoutMs: 30_000 })
    await app.templateOf(BEFORE)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: before')`, 'the template source')
    await app.cdp.waitFor(`!!__e2e.one('.move-to-fields')`, 'the way onto the fields')
    assert.equal(await app.cdp.evaluate(`__e2e.one('dc-checkbox[name="코드"]')?.checked`), true)

    await app.click('dc-button', '칸으로 옮기기')
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('suggest:role="judged"')`, 'the choice written on the field')
    assert.equal(await app.cdp.evaluate(`__e2e.one('dc-checkbox[name="코드"]')?.checked`), true, 'still a judgment field')
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    const saved = parseFormdown(await readFile(path, 'utf8'))
    assert.equal(saved.frontMatter?.data?.lowline, undefined)
    assert.deepEqual(saved.forms.find((f) => f.name === '코드')?.suggest, { role: 'judged', coarse: 2 })
    assert.equal(await app.cdp.evaluate(`!!__e2e.one('.move-to-fields')`), false, 'nothing left to move')
    await app.noAlert()

    // Leave the vault as the scenarios after this one expect it.
    await app.learning()
    await rm(path)
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '이전 방식')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
  },

  async 'edits the options of a choice field from the template page, in its place in the source'(app, vault) {
    const path = join(vault, TEMPLATE)
    await app.templateOf(BUG)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: bug-report')`, 'the template source')
    const before = await app.value('textarea')
    const enter = () => app.cdp.press('Enter', { code: 'Enter', keyCode: 13 })
    assert.equal(await app.value('input[aria-label="심각도 선택지"]'), '낮음, 보통, 높음')

    await app.fill('input[aria-label="심각도 선택지"]', '낮음, 보통, 높음, 긴급')
    await enter()
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('options="낮음,보통,높음,긴급"')`, 'the options written into the field')
    assert.equal(
      await app.value('textarea'),
      before.replace('options="낮음,보통,높음"', 'options="낮음,보통,높음,긴급"'),
      'nothing else in the source changed',
    )
    await app.cdp.waitFor(`__e2e.all('select[name="심각도"] option').some((o) => o.value === '긴급')`, 'the new option in the preview')

    // A field keeps at least one option: clearing them writes nothing and shows the source's again.
    await app.fill('input[aria-label="환경 선택지"]', ' , ')
    await enter()
    await app.cdp.waitFor(`__e2e.one('input[aria-label="환경 선택지"]')?.value === '윈도우, 맥'`, 'the options as the source holds them')
    assert.ok((await app.value('textarea')).includes('@환경: [radio options="윈도우,맥"]'))

    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal(await readFile(path, 'utf8'), await app.value('textarea'), 'file = editor text')

    // As it was, for the scenarios after this one.
    await app.fill('input[aria-label="심각도 선택지"]', '낮음, 보통, 높음')
    await enter()
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal(await readFile(path, 'utf8'), before)
    await app.noAlert()
  },

  async 'completes a field as it is typed into the source, and one undo takes the completion away'(app, vault) {
    const path = join(vault, TEMPLATE)
    await app.templateOf(BUG)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: bug-report')`, 'the template source')
    const before = await app.value('textarea')
    const source = () => app.value('textarea')
    await app.cdp.evaluate(`(() => { const t = __e2e.one('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true })()`)

    // Three underscores after text start an inline field: its name follows the @ put after them.
    await app.cdp.insertText('\n요청자: ___')
    await app.cdp.waitFor(`__e2e.one('textarea').value.endsWith('요청자: ___@')`, 'the @ after the underscores')
    await app.cdp.insertText('요청자')
    assert.ok((await source()).endsWith('\n요청자: ___@요청자'))

    // One undo takes the completion away and leaves what was typed.
    await app.cdp.insertText('\n비고: ___')
    await app.cdp.waitFor(`__e2e.one('textarea').value.endsWith('비고: ___@')`, 'the @ after the underscores')
    await app.cdp.press('z', { code: 'KeyZ', modifiers: 2, keyCode: 90 })
    await app.cdp.waitFor(`__e2e.one('textarea').value.endsWith('비고: ___')`, 'the completion undone')

    // A block field's brackets open after its name, with the caret inside for the type.
    await app.cdp.insertText('\n@분류: ')
    await app.cdp.waitFor(`__e2e.one('textarea').value.endsWith('@분류: []')`, 'the brackets after the name')
    await app.cdp.insertText('select options="가,나"')
    assert.ok((await source()).endsWith('\n@분류: [select options="가,나"]'))
    await app.cdp.waitFor(`__e2e.all('select[name="분류"] option').some((o) => o.value === '나')`, 'the new field in the preview')

    // A line of underscores alone is a Markdown rule: nothing is added.
    await app.cdp.evaluate(`(() => { const t = __e2e.one('textarea'); t.setSelectionRange(t.value.length, t.value.length); return true })()`)
    await app.cdp.insertText('\n___')
    await app.cdp.evaluate(`new Promise((resolve) => setTimeout(resolve, 200))`)
    assert.ok((await source()).endsWith('\n___'))

    // As it was, for the scenarios after this one.
    await app.cdp.evaluate(`(() => { const t = __e2e.one('textarea'); t.focus(); t.select(); return true })()`)
    await app.cdp.insertText(before)
    await app.click('dc-button', '저장')
    await app.status('저장했습니다')
    assert.equal(await readFile(path, 'utf8'), before)
    await app.noAlert()
  },

  async 'renames a template, and its documents stay with it'(app, vault) {
    const enter = () => app.cdp.press('Enter', { code: 'Enter', keyCode: 13 })
    const renamed = { ...BUG, name: '결함 보고', path: '서식/결함 보고.fd.md' }
    const before = await readFile(join(vault, TEMPLATE), 'utf8')
    await app.documentsOf(BUG)
    const documents = await app.documentLabels()

    await app.templateOf(BUG)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: bug-report')`, 'the template source')
    await app.click('dc-button', '이름 바꾸기')
    // A name another template has is refused.
    await app.fill('input[aria-label="새 이름"]', '접수')
    await enter()
    await app.cdp.waitFor(`__e2e.all('[role=alert]').some((el) => el.textContent.includes('같은 이름의 서식이 이미 있습니다'))`, 'the name refused')
    await app.fill('input[aria-label="새 이름"]', renamed.name)
    await enter()
    await app.status('이름을 바꿨습니다')

    const files = await readdir(join(vault, '서식'))
    assert.ok(files.includes('결함 보고.fd.md') && !files.includes('버그 리포트.fd.md'), files.join(', '))
    assert.equal(await readFile(join(vault, renamed.path), 'utf8'), before, 'the same file under its new name')
    await app.cdp.waitFor(`!!__e2e.one('button.item', '결함 보고') && !__e2e.one('button.item', '버그 리포트')`, 'the sidebar showing its new name')
    await app.documentsOf(renamed)
    await app.cdp.waitFor(`__e2e.all('ll-documents').length === 1`, 'its documents')
    assert.deepEqual(await app.documentLabels(), documents, 'its documents are still its own')

    // As it was, for the scenarios after this one.
    await app.templateOf(renamed)
    await app.click('dc-button', '이름 바꾸기')
    await app.fill('input[aria-label="새 이름"]', BUG.name)
    await enter()
    await app.status('이름을 바꿨습니다')
    assert.equal(await readFile(join(vault, TEMPLATE), 'utf8'), before)
    await app.noAlert()
  },

  async 'works out a field from others as they are typed, and saves what it worked out'(app, vault) {
    const REQUISITION = { name: '물품청구', ref: 'requisition@1', path: '서식/물품청구.fd.md' }
    const template = join(vault, REQUISITION.path)
    await writeFile(
      template,
      '---\nid: requisition\nversion: 1\n---\n# 물품청구\n\n품명: ___@품명\n\n@청구량: [number]\n\n@단가: [number description="원, 부가세 포함"]\n\n@금액: [number compute="청구량 * 단가"]\n',
    )
    const before = new Set(await documentsIn(vault))
    try {
      await app.sidebar(REQUISITION.name, { timeoutMs: 30_000 })
      await app.newDocument(REQUISITION)
      await app.cdp.waitFor(`__e2e.one('input[name="금액"]')?.readOnly === true`, 'the amount, worked out rather than typed')
      // How to fill a field, under it.
      assert.equal(await app.cdp.evaluate(`__e2e.one('.formdown-field-description')?.textContent.trim()`), '원, 부가세 포함')
      await app.fill('[data-field-name="품명"]', '복사 용지')
      await app.fill('input[name="청구량"]', '3')
      await app.fill('input[name="단가"]', '1500')
      await app.cdp.waitFor(`__e2e.one('input[name="금액"]')?.value === '4500'`, 'the amount following the quantity and the price')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      const [saved] = (await documentsIn(vault)).filter((n) => !before.has(n))
      assert.ok(saved, 'the requisition saved')
      assert.equal(String((await fileValues(join(vault, '문서', saved))).금액), '4500', 'the file keeps the amount worked out')
      await rm(join(vault, '문서', saved))
    } finally {
      await app.templateOf(BUG)
      await rm(template, { force: true })
    }
    await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '물품청구')`, 'the template gone from the sidebar', { timeoutMs: 30_000 })
    await app.noAlert()
  },

  async 'creates a template from the starter, labelled in Korean'(app, vault) {
    await app.newTemplate()
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('@상태:')`, 'the starter template')
    const created = (await readdir(join(vault, '서식'))).filter((n) => n.startsWith('새 서식'))
    assert.equal(created.length, 1, 'one starter template on disk')
    assert.equal(await readFile(join(vault, '서식', created[0]), 'utf8'), await app.value('textarea'), 'file = editor text')
    const labels = await app.cdp.waitFor(
      `(() => { const l = __e2e.all('label').map((el) => el.textContent.trim()); return l.includes('상태') && l })()`,
      'the preview labels',
    )
    assert.ok(labels.includes('메모'), `labels: ${labels.join(', ')}`)

    // A second one takes the name numbered before the template ending, so it is still a template.
    await app.newTemplate()
    await app.cdp.waitFor(`!!__e2e.one('button.item', '새 서식 (1)')`, 'the second starter in the sidebar')
    const both = (await readdir(join(vault, '서식'))).filter((n) => n.startsWith('새 서식')).sort()
    assert.deepEqual(both, ['새 서식 (1).fd.md', '새 서식.fd.md'])
    // Back to the fixture template for the scenarios that follow, without the second starter.
    await app.templateOf(BUG)
    await app.cdp.waitFor(`__e2e.one('textarea')?.value.includes('id: bug-report')`, 'the fixture template')
    await rm(join(vault, '서식', '새 서식 (1).fd.md'))
    await app.cdp.waitFor(`!__e2e.one('button.item', '새 서식 (1)')`, 'the second starter gone from the sidebar')
  },

  async 'sets up the model the chat uses when the chat is first opened, and puts the template the chat writes into the editor for the person to save'(app, vault) {
    // A server of the person's own that speaks the OpenAI way, and a port where nothing listens: nothing leaves this computer.
    // Asked to write, it first sends a draft with a field named twice, then — told what is wrong — one that works.
    const fence = '```'
    const asked = []
    const draft = (extra) => `---\nid: bug-report\nversion: 1\n---\n# 버그 리포트\n\n제목: ___@제목\n\n@처리 기한: [date]\n${extra}`
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'small-4b', object: 'model' }, { id: 'large-8b', object: 'model' }] }))
        return
      }
      void bodyOf(req).then((body) => {
        asked.push(JSON.parse(body))
        // Asked a third time, for a table of repeated rows: the template, and a template of one row pointing at it.
        const row = `---\nid: bug-step\nversion: 1\n---\n# 재현 단계\n\n@버그 리포트 -> bug-report: [select]\n@순서: [number]\n@동작: [text]\n`
        const text =
          asked.length === 1
            ? `넣었습니다.\n\n${fence}formdown\n${draft('@제목: [text]\n')}${fence}`
            : asked.length === 2
              ? `고쳤습니다.\n\n${fence}formdown\n${draft('')}${fence}`
              : asked.length === 3
                ? `단계를 줄 서식으로 나눴습니다.\n\n${fence}formdown\n${draft('')}${fence}\n\n${fence}formdown\n${row}${fence}`
                : `빈 서식의 칸을 옮겼습니다.\n\n${fence}formdown\n${draft('@신청인: [text]\n')}${fence}`
        res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'large-8b', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const closed = createServer()
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = closed.address().port
    await new Promise((resolve) => closed.close(resolve))
    const settingsNow = async () => JSON.parse(await readFile(SETTINGS, 'utf8').catch(() => '{}'))
    const panel = `__e2e.all('ll-model-settings')[0]?.shadowRoot`
    const type = (label, text) =>
      app.cdp.evaluate(`(() => { const el = ${panel}.querySelector('dc-input[aria-label="${label}"]'); el.value = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)
    const said = `[...${panel}.querySelectorAll('[role=alert], [role=status]')].map((el) => el.textContent.trim()).join(' / ')`
    try {
      await app.templateOf(BUG)
      await app.click('dc-button', '채팅')
      // This computer first: the models Lowline can get and run itself, the recommended one chosen, and what getting it
      // fetches from where — nothing is fetched until the person asks.
      await app.cdp.waitFor(`!!${panel}?.querySelector('dc-select[aria-label="모델"]')`, 'the models on this computer in the chat panel')
      const local = await app.cdp.evaluate(`${panel}.textContent`)
      assert.match(local, /이 컴퓨터 밖으로 나가지 않습니다/, 'what is sent stays here')
      assert.match(local, /Hugging Face.*GitHub/s, 'where getting a model fetches from')
      assert.equal(await app.cdp.evaluate(`${panel}.querySelector('dc-select[aria-label="모델"]').value`), 'gguf:qwen3-default', 'the recommended model')
      assert.equal(await app.cdp.evaluate(`${panel}.querySelector('dc-button[variant="primary"]').disabled`), true, 'nothing ready to keep')
      await app.choose('dc-select[aria-label="어디에 있는 모델인가요"]', 'custom')
      assert.match(await app.cdp.evaluate(`${panel}.textContent`), /이 주소의 서버로만 갑니다/, 'where what is sent goes')
      await app.cdp.waitFor(`!!${panel}.querySelector('dc-input[aria-label="주소"]')`, 'an address asked for')

      await type('주소', `http://127.0.0.1:${closedPort}/v1`)
      await app.click('dc-button', '연결 확인')
      await app.cdp.waitFor(`${said}.includes('듣고 있는 서버가 없습니다')`, 'why the closed port does not answer', { timeoutMs: 30_000 })
      assert.equal(await app.cdp.evaluate(`${panel}.querySelector('dc-button[variant="primary"]').disabled`), true, 'nothing to keep yet')

      await type('주소', `http://127.0.0.1:${server.address().port}/v1`)
      await app.click('dc-button', '연결 확인')
      await app.cdp.waitFor(`${said}.includes('모델 2개')`, 'the models the server lists', { timeoutMs: 30_000 })
      await app.choose('dc-select[aria-label="모델"]', 'large-8b')
      await app.click('dc-button', '이 모델로 쓰기')
      for (let tries = 0; !(await settingsNow()).model; tries++) {
        assert.ok(tries < 50, 'the model written to this device')
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.deepEqual((await settingsNow()).model, { preset: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'large-8b' })
      const chat = `__e2e.all('ll-chat-panel')[0]?.shadowRoot`
      await app.cdp.waitFor(`${chat}?.textContent.includes('large-8b') && !!${chat}.querySelector('u-prompt')`, 'the chat on the model kept')

      // Asked in words; the draft is checked, asked again once, tidied, and put into the editor unsaved.
      const before = await app.value('textarea')
      await app.cdp.evaluate(`(() => { const p = ${chat}.querySelector('u-prompt'); p.value = '처리 기한 칸을 날짜로 넣어 줘'; p.submit(); return true })()`)
      await app.cdp.waitFor(`${chat}.querySelector('.note[role=status]')?.textContent.includes('넣은 칸: 처리_기한')`, 'the draft put into the editor', { timeoutMs: 30_000 })
      // What each ask ended with, said when it is not as expected.
      const ends = asked.map((a) => `${a.messages.length} messages, last ${a.messages.at(-1)?.role}: ${String(a.messages.at(-1)?.content).slice(0, 80)}`)
      assert.equal(asked.length, 2, `asked once more after a draft with a problem: ${ends.join(' | ')}`)
      assert.match(asked[0].messages[0].content, /id: bug-report/, 'the template as it stood went with the question')
      assert.match(asked[1].messages.at(-1).content, /다시 보내/, `and what was wrong with the first draft: ${ends.join(' | ')}`)
      // The chat's words and the box to write in are in the type the rest of the window uses.
      const typeIn = `((sel) => { const find = (root) => root.querySelector(sel) ?? [...root.querySelectorAll('*')].map((el) => el.shadowRoot && find(el.shadowRoot)).find(Boolean)
        const el = find(${chat}); const s = getComputedStyle(el); return s.fontSize + ' ' + s.fontFamily })`
      const appType = await app.cdp.evaluate(`(() => { const probe = document.createElement('span')
        probe.style.cssText = 'font-size: var(--dc-font-size-md); font-family: var(--dc-font-family)'; document.body.append(probe)
        const s = getComputedStyle(probe); const type = s.fontSize + ' ' + s.fontFamily; probe.remove(); return type })()`)
      assert.equal(await app.cdp.evaluate(`${typeIn}('u-marked-block')`), appType, "the answer in the window's type")
      assert.equal(await app.cdp.evaluate(`${typeIn}('textarea')`), appType, "the box to write in in the window's type")
      const drafted = await app.value('textarea')
      assert.match(drafted, /^@처리_기한: \[date\]$/m, 'a field name made one word')
      assert.equal(await readFile(join(vault, TEMPLATE), 'utf8'), before, 'nothing saved: the person saves')
      assert.equal(await app.cdp.evaluate(`__e2e.one('dc-button', '저장').disabled`), false, 'the draft is there to save')

      // What the editor held before can be put back.
      await app.cdp.evaluate(`${chat}.querySelector('.note[role=status] dc-button').click()`)
      await app.cdp.waitFor(`__e2e.one('textarea')?.value === ${JSON.stringify(before)}`, 'the source as it was')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')
      await app.noAlert()

      // A table of repeated rows comes as a template of its own, pointing at this one: the person makes it.
      await app.cdp.evaluate(`(() => { const p = ${chat}.querySelector('u-prompt'); p.value = '재현 단계를 여러 줄 적게 해 줘'; p.submit(); return true })()`)
      const make = `[...${chat}.querySelectorAll('.note.row dc-button')].find((b) => b.textContent.includes('재현 단계'))`
      await app.cdp.waitFor(`!!${make}`, 'the row template offered to make', { timeoutMs: 30_000 })
      assert.equal(asked.length, 3, 'a draft whose row template works is not asked for again')
      assert.ok(!(await readdir(join(vault, '서식'))).includes('재현 단계.fd.md'), 'nothing made until the person makes it')
      await app.cdp.evaluate(`${make}.click()`)
      await app.cdp.waitFor(`${chat}.querySelector('.note.row')?.textContent.includes('만들었습니다')`, 'the row template made')
      assert.match(await readFile(join(vault, '서식', '재현 단계.fd.md'), 'utf8'), /^@버그_리포트 -> bug-report: \[select\]$/m, 'tidied as a draft is, still pointing at this template')
      await app.cdp.waitFor(`!!__e2e.one('button.item', '재현 단계')`, 'the row template in the sidebar')
      // Left as it was: the row template gone, the editor's draft put back.
      await rm(join(vault, '서식', '재현 단계.fd.md'))
      await app.cdp.waitFor(`!__e2e.one('button.item', '재현 단계')`, 'the row template gone from the sidebar')
      await app.cdp.evaluate(`[...${chat}.querySelectorAll('.note[role=status]')].at(-2).querySelector('dc-button').click()`)
      await app.cdp.waitFor(`__e2e.one('textarea')?.value === ${JSON.stringify(before)}`, 'the source as it was again')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')

      // A blank form file to start from, a PDF: read on this computer, its text and name sent with the request, the request
      // in the person's words, the draft put in the editor.
      const form = join(await mkdtemp(join(tmpdir(), 'lowline-form-')), '신청서.pdf')
      await writeFile(form, minimalPdf('Requester name: ____'))
      // The system's file picker is the operating system's; the scenario hands the panel the path it would have answered.
      assert.ok(await app.cdp.evaluate(`[...${chat}.querySelectorAll('.model dc-button')].some((b) => b.textContent.includes('빈 서식 파일에서'))`), 'a way to start from a blank form file')
      await app.cdp.evaluate(`__e2e.all('ll-chat-panel')[0].fromFile(${q(form)}).then(() => true)`)
      await app.cdp.waitFor(`[...${chat}.querySelectorAll('.note[role=status]')].some((n) => /넣은 칸:[^/]*신청인/.test(n.textContent))`, 'the draft from the blank form put into the editor', { timeoutMs: 30_000 })
      assert.match(asked[3].messages[0].content, /«신청서\.pdf»[\s\S]*Requester name/, "the form's name and text after the rules")
      assert.equal(asked[3].messages.at(-1).content, '빈 서식 «신청서.pdf»으로 이 서식을 만들어 주세요.', "the request in the person's words")
      assert.doesNotMatch(asked[3].messages.at(-1).content, /Requester name/, 'the form is not pasted into what the person said')
      // The draft kept fields of the template it replaced that the form never names: asked once more to leave them out.
      assert.equal(asked.length, 5, 'asked once more for the fields the form does not have')
      assert.match(asked[4].messages.at(-1).content, /빈 서식에 없는 칸 «제목»/, 'what was left over, said')
      assert.match(asked[4].messages[0].content, /Requester name/, 'the form goes with the second request too')
      assert.equal(await readFile(join(vault, TEMPLATE), 'utf8'), before, 'nothing saved: the person saves')
      await app.cdp.evaluate(`[...${chat}.querySelectorAll('.note[role=status]')].at(-1).querySelector('dc-button').click()`)
      await app.cdp.waitFor(`__e2e.one('textarea')?.value === ${JSON.stringify(before)}`, 'the source as it was, once more')
      await app.click('dc-button', '저장')
      await app.status('저장했습니다')

      // In a window too narrow for three columns, the chat takes the place of the fields and the preview.
      const side = `getComputedStyle(__e2e.all('ll-templates')[0].shadowRoot.querySelector('section.side')).display`
      try {
        await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
        await app.cdp.waitFor(`innerWidth === 1600 && ${side} !== 'none'`, 'all three in a wide window')
        await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 560, deviceScaleFactor: 1, mobile: false })
        await app.cdp.waitFor(`innerWidth === 800 && ${side} === 'none'`, 'the chat in the place of the preview')
        assert.ok(await app.cdp.evaluate(`__e2e.all('ll-chat-panel')[0].getBoundingClientRect().width >= 256`), 'the chat as wide as it needs')
        // A long line in the box folds at its width rather than running past it.
        const box = `(() => { const find = (root) => root.querySelector('textarea') ?? [...root.querySelectorAll('*')].map((el) => el.shadowRoot && find(el.shadowRoot)).find(Boolean); return find(${chat}) })()`
        const oneLine = await app.cdp.evaluate(`${box}.clientHeight`)
        await app.cdp.evaluate(`(() => { const p = ${chat}.querySelector('u-prompt'); p.value = ${q('처리 기한 칸을 날짜로 넣고, 담당 부서 칸은 선택지로 바꾸고, 접수 경로 칸 아래에 메모 칸을 하나 더 넣어 줘')}; return true })()`)
        await app.cdp.waitFor(`${box}.clientHeight > ${oneLine}`, 'the long line folded onto more lines')
        assert.ok(await app.cdp.evaluate(`${box}.scrollWidth <= ${box}.clientWidth`), 'nothing past the width of the box')
        // And it grows to every line it folded onto: a scrollbar showing while it grew must not leave the last one hidden.
        await app.cdp.waitFor(`${box}.scrollHeight <= ${box}.clientHeight`, 'every folded line in view')
        await app.cdp.evaluate(`(() => { const p = ${chat}.querySelector('u-prompt'); p.value = ''; return true })()`)
      } finally {
        await app.cdp.send('Emulation.clearDeviceMetricsOverride')
      }
    } finally {
      server.close()
      // Leave this device without a model, and the chat closed.
      if (await app.cdp.evaluate(`!!__e2e.all('ll-chat-panel')[0]?.shadowRoot.querySelector('u-prompt')`)) {
        await app.cdp.evaluate(`__e2e.all('ll-chat-panel')[0].shadowRoot.querySelector('.model dc-button').click()`)
        await app.cdp.waitFor(`!!${panel}?.querySelector('dc-select')`, 'the model settings again')
      }
      if (await app.cdp.evaluate(`!!${panel}`)) await app.click('dc-button', '모델 쓰지 않기').catch(() => {})
      for (let tries = 0; (await settingsNow()).model && tries < 50; tries++) await new Promise((r) => setTimeout(r, 100))
      if (await app.cdp.evaluate(`!!__e2e.all('ll-chat-panel')[0]`)) await app.click('dc-button', '채팅')
    }
  },

  async 'reads records out of pasted text with the model set up, its judgment values coming in as its suggestions'(app, vault) {
    // A server of the person's own that speaks the OpenAI way: it reads two records out of the text it is given.
    const fence = '```'
    const asked = []
    const records = [
      { 요청: '스캐너에 용지가 걸렸어요', 부서: '영업', 담당: '총무' },
      { 요청: '회의실 의자 다리가 부러졌어요', 부서: '개발', 담당: '장비' },
    ]
    const server = createServer((req, res) => {
      void bodyOf(req).then((body) => {
        asked.push(JSON.parse(body))
        res.setHeader('content-type', 'application/json')
        // A piece of the long text that fails: the server errs on it.
        if (asked.at(-1).messages[1].content.includes('[실패]')) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: { message: 'boom' } }))
          return
        }
        const text = `${fence}json\n${JSON.stringify(records)}\n${fence}`
        res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'small-4b', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const model = { preset: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'small-4b' }
    const useModel = (setting) =>
      app.cdp.evaluate(`__e2e.all('dp-shell')[0].dispatchEvent(new CustomEvent('ll-model', { detail: ${q(setting)}, bubbles: true, composed: true }))`)
    const pasted = '[메일] 영업팀 김민수: 스캐너에 용지가 걸렸어요. 총무팀에서 처리 부탁드려요.\n[메모] 개발팀 — 회의실 의자 다리가 부러짐, 장비 담당 확인 필요'
    const imp = `__e2e.all('ll-import')[0]?.shadowRoot`
    const before = new Set(await documentsIn(vault))
    let created = []
    try {
      await app.documentsOf(INTAKE)
      await app.click('dc-button', '가져오기')
      // Without a model, the import says where one is set up.
      await app.cdp.waitFor(`${imp}?.textContent.includes('모델을 정하면')`, 'where to set a model up')
      await useModel(model)
      await app.cdp.waitFor(`!!${imp}?.querySelector('textarea[aria-label="붙여 넣은 글"]')`, 'the text for the model to read')
      await app.cdp.evaluate(`(() => { const t = ${imp}.querySelector('textarea[aria-label="붙여 넣은 글"]'); t.value = ${q(pasted)}
        t.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)
      // Text long enough to be read in three pieces, the last failing: what the first two read is kept, and how far
      // reading got is said.
      const long = `${pasted}\n\n${'[메모] 다른 기록이 이어집니다. '.repeat(12)}\n\n[실패] ${'이 조각은 읽지 못합니다. '.repeat(12)}`
      await app.cdp.evaluate(`(() => { const t = ${imp}.querySelector('textarea[aria-label="붙여 넣은 글"]'); t.value = ${q(long)}
        t.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)
      await app.click('dc-button', '모델로 읽기')
      await app.cdp.waitFor(`${imp}.textContent.includes('조각까지 읽은 기록입니다')`, 'how far reading got', { timeoutMs: 30_000 })
      assert.match(await app.cdp.evaluate(`${imp}.querySelector('[role=alert]')?.textContent ?? ''`), /모델이 읽지 못했습니다/, 'why it stopped')
      assert.ok(await app.cdp.evaluate(`!!${imp}.querySelector('table[aria-label="모델이 읽은 기록"]')`), 'the records read before it')
      assert.match(await app.cdp.evaluate(`${imp}.textContent`), /3조각 중 2조각까지/)
      await app.status('문서 4건을 만듭니다') // two records read out of each piece read
      // Then the short text alone, read whole.
      await app.cdp.evaluate(`(() => { const t = ${imp}.querySelector('textarea[aria-label="붙여 넣은 글"]'); t.value = ${q(pasted)}
        t.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true })()`)
      await app.click('dc-button', '모델로 읽기')
      await app.status('문서 2건을 만듭니다')
      // What the model read is shown before anything is written: each record, its judgment field marked.
      const table = await app.cdp.evaluate(`${imp}.querySelector('table[aria-label="모델이 읽은 기록"]').textContent.replace(/\\s+/g, ' ')`)
      for (const value of ['스캐너에 용지가 걸렸어요', '회의실 의자 다리가 부러졌어요', '총무', '장비', '담당 *']) assert.ok(table.includes(value), `${value} in ${table}`)
      assert.match(await app.cdp.evaluate(`${imp}.textContent`), /채팅\(small-4b\)의 제안으로 들어가고/, 'whose suggestion the judgment values are')
      // The model was given the template and the text — nothing else of the vault.
      const last = asked.at(-1)
      assert.match(last.messages[0].content, /@담당: \[select options="장비,인사,총무"\]/)
      assert.equal(last.messages[1].content, pasted)

      await app.click('dc-button', '2건 가져오기')
      await app.status('2건을 가져왔습니다')
      await app.noAlert()
      created = (await documentsIn(vault)).filter((n) => !before.has(n))
      assert.equal(created.length, 2, 'one document per record')
      for (const name of created) {
        const data = readFrontMatter(await readFile(join(vault, '문서', name), 'utf8')).frontMatter.data
        assert.deepEqual(data.lowline.proposed, { 담당: '채팅(small-4b)' }, `the judgment value of ${name} is a suggestion`)
        assert.ok(['영업', '개발'].includes(data.부서), 'the other values are the document\'s own')
      }
    } finally {
      server.close()
      await useModel(null)
      for (let tries = 0; JSON.parse(await readFile(SETTINGS, 'utf8').catch(() => '{}')).model && tries < 50; tries++)
        await new Promise((r) => setTimeout(r, 100))
      // Leave the vault as it was for the scenarios that follow.
      for (const name of created) await rm(join(vault, '문서', name))
      await app.cdp.waitFor(
        `!__e2e.all('button.item').some((b) => /스캐너에 용지가|의자 다리가/.test(b.textContent))`,
        'the imported documents gone from the list',
        { timeoutMs: 15_000 },
      )
    }
  },

  async 'asks a template\'s records in words: the model says what to count, the vault counts it, each count with the documents it is made of'(app, vault) {
    // A server of the person's own that speaks the OpenAI way: it answers each question with what to count.
    const fence = '```'
    const asked = []
    let plan = ''
    const server = createServer((req, res) => {
      void bodyOf(req).then((body) => {
        asked.push(JSON.parse(body))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'small-4b', choices: [{ index: 0, message: { role: 'assistant', content: plan }, finish_reason: 'stop' }] }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const useModel = (setting) =>
      app.cdp.evaluate(`__e2e.all('dp-shell')[0].dispatchEvent(new CustomEvent('ll-model', { detail: ${q(setting)}, bubbles: true, composed: true }))`)
    const chat = `__e2e.all('ll-chat-panel')[0]?.shadowRoot`
    const ask = async (question, reply) => {
      plan = reply
      const lines = await app.cdp.evaluate(`${chat}.querySelectorAll('u-message').length`)
      await app.cdp.evaluate(`(() => { const p = ${chat}.querySelector('u-prompt'); p.value = ${q(question)}; p.submit(); return true })()`)
      await app.cdp.waitFor(`${chat}.querySelectorAll('u-message:not([loading])').length >= ${lines + 2}`, `the answer to ${question}`, { timeoutMs: 30_000 })
      return app.cdp.evaluate(`${chat}.querySelector('u-message:last-of-type').textContent.replace(/\\s+/g, ' ').trim()`)
    }
    // What the vault holds, read from its files: what the counts are checked against.
    const intake = []
    for (const name of await readdir(join(vault, '문서'))) {
      if (!name.endsWith('.md')) continue
      const data = readFrontMatter(await readFile(join(vault, '문서', name), 'utf8'))?.frontMatter.data
      if (data?.template === INTAKE.ref) intake.push(data)
    }
    const by = (key, of = intake) => Object.entries(Object.groupBy(of, (d) => d[key])).map(([value, ds]) => [value, ds.length])
    try {
      await useModel({ preset: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'small-4b' })
      await app.templateOf(INTAKE)
      await app.click('dc-button', '채팅')
      await app.cdp.waitFor(`!!${chat}?.querySelector('u-prompt')`, 'the chat on the model set up')
      await app.cdp.evaluate(`[...${chat}.querySelector('dc-segmented-control').shadowRoot.querySelectorAll('[role=radio]')].find((b) => b.textContent.includes('기록에 묻기')).click()`)
      await app.cdp.waitFor(`${chat}.textContent.includes('기록의 값은 모델에 가지 않습니다')`, 'what asking the records sends')

      // Counted by a field: a row per value, the largest first, each with the documents it is made of.
      const answer = await ask('부서별로 몇 건이야?', `${fence}json\n{"groupBy": ["부서"]}\n${fence}`)
      assert.match(answer, /센 것: 모든 기록 · 부서별/, `what was counted, in words: ${answer}`)
      assert.match(answer, new RegExp(`모두 ${intake.length}건`))
      const rows = await app.cdp.evaluate(
        `[...${chat}.querySelectorAll('u-message:last-of-type tbody tr')].map((tr) => [tr.cells[0].textContent.trim(), Number(tr.cells[1].textContent)])`,
      )
      const byName = (a, b) => a[0].localeCompare(b[0])
      assert.deepEqual([...rows].sort(byName), by('부서').sort(byName), 'the counts the vault holds')
      assert.ok(rows.every((row, i) => i === 0 || rows[i - 1][1] >= row[1]), `the largest first: ${JSON.stringify(rows)}`)
      // The model was given the template and the question — no document's value.
      const sent = asked.at(-1).messages
      assert.match(sent[0].content, /@부서: \[select options="영업,개발,인사"\]/)
      assert.ok(!sent.some((m) => m.content.includes(intake[0].요청)), 'no value of a record went to the model')
      assert.equal(sent.at(-1).content, '부서별로 몇 건이야?')

      // Narrowed, counted by another field, only the largest: said as counted.
      const narrowed = await ask('영업 부서 일은 누가 제일 많이 맡았어?', '{"groupBy": ["담당"], "filters": [{"field": "부서", "op": "equal", "value": "영업"}], "top": 1}')
      assert.match(narrowed, /센 것: 부서 = 영업 · 담당별 · 많은 것 1개/)
      assert.equal(await app.cdp.evaluate(`${chat}.querySelectorAll('u-message:last-of-type tbody tr').length`), 1, 'only the largest')
      // The conversation shows its newest answer.
      await app.cdp.waitFor(`(() => { const log = ${chat}.querySelector('.log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 2 })()`, 'scrolled to the newest answer')

      // A question the fields cannot count is said to be one, not counted as something else.
      assert.match(await ask('고객이 제일 많이 불평한 건 뭐야?', '{"unanswerable": "불평을 적는 칸이 없습니다"}'), /이 서식의 칸으로는 셀 수 없습니다 — 불평을 적는 칸이 없습니다/)
      // Nor is a plan the template's fields cannot hold.
      assert.match(await ask('지역별로?', '{"groupBy": ["지역"]}'), /서식에 없는 칸\(지역\)으로 세려 했습니다/)

      // A count's document opens where documents are.
      const first = await app.cdp.evaluate(`${chat}.querySelector('u-message:nth-last-of-type(5) tbody tr .evidence dc-button').textContent.trim()`)
      await app.cdp.evaluate(`${chat}.querySelector('u-message:nth-last-of-type(5) tbody tr .evidence dc-button').click()`)
      await app.cdp.waitFor(
        `__e2e.all('ll-documents').some((d) => [...d.shadowRoot.querySelectorAll("nav button[aria-current='true']")].some((b) => b.textContent.includes(${q(first)})))`,
        `the document ${first} open`,
      )
      await app.noAlert()

      // A template whose field refers to another's documents is counted by that document's fields as it holds them now.
      await writeFile(join(vault, CUSTOMER.path), '---\nid: customer\nversion: 1\n---\n# 고객\n\n@이름: [text]\n\n@지역: [select options="서울,부산"]\n')
      await writeFile(join(vault, INQUIRY.path), '---\nid: inquiry\nversion: 1\n---\n# 문의\n\n@고객 -> customer: [select]\n\n@내용: [text]\n\n@금액: [number]\n')
      const customers = [['가나상사', '서울', 'cust-a'], ['다라무역', '부산', 'cust-b']]
      for (const [name, region, id] of customers)
        await writeFile(join(vault, '문서', `${name}.md`), `---\ntemplate: customer@1\nlowline:\n  id: ${id}\n이름: ${name}\n지역: ${region}\n---\n`)
      for (const [i, [id, amount]] of [['cust-a', 1000], ['cust-a', 2500.5], ['cust-b', null]].entries())
        await writeFile(join(vault, '문서', `문의-${i + 1}.md`), `---\ntemplate: inquiry@1\n고객: ${id}\n내용: 문의 ${i + 1}\n${amount === null ? '' : `금액: ${amount}\n`}---\n`)
      await app.sidebar(INQUIRY.name, { timeoutMs: 30_000 })
      await app.templateOf(INQUIRY)
      if (!(await app.cdp.evaluate(`!!${chat}?.querySelector('u-prompt')`))) await app.click('dc-button', '채팅')
      await app.cdp.waitFor(`!!${chat}?.querySelector('u-prompt')`, 'the chat beside 문의')
      await app.cdp.evaluate(`[...${chat}.querySelector('dc-segmented-control').shadowRoot.querySelectorAll('[role=radio]')].find((b) => b.textContent.includes('기록에 묻기')).click()`)
      const byRegion = await ask('고객 지역별 문의 수?', '{"groupBy": ["고객.지역"]}')
      assert.match(byRegion, /센 것: 모든 기록 · 고객\.지역별/)
      const regions = await app.cdp.evaluate(`[...${chat}.querySelectorAll('u-message:last-of-type tbody tr')].map((tr) => [tr.cells[0].textContent.trim(), Number(tr.cells[1].textContent)])`)
      assert.deepEqual(regions, [['서울', 2], ['부산', 1]])
      // The model was told those fields by name and choices — and no customer's name or region was sent.
      const told = asked.at(-1).messages[0].content
      assert.match(told, /- `고객\.지역` \(선택지: 서울, 부산\)/)
      assert.ok(!told.includes('가나상사'), 'no value of a referred document went to the model')
      // A document named by its name in the field that refers to it: counted as the document it names.
      const named = await ask('가나상사 문의는 몇 건?', '{"filters": [{"field": "고객", "op": "equal", "value": "가나상사"}]}')
      assert.match(named, /센 것: 고객 = 가나상사/)
      assert.match(named, /모두 2건/)
      // Counted by the reference itself: each document by its name, not its id.
      await ask('고객별로?', '{"groupBy": ["고객"]}')
      const byCustomer = await app.cdp.evaluate(`[...${chat}.querySelectorAll('u-message:last-of-type tbody tr')].map((tr) => tr.cells[0].textContent.trim())`)
      assert.deepEqual(byCustomer, ['가나상사', '다라무역'])

      // Asked of the customers, the inquiries naming each are counted: the documents that refer to them, by the one each names.
      await app.templateOf(CUSTOMER)
      if (!(await app.cdp.evaluate(`!!${chat}?.querySelector('u-prompt')`))) await app.click('dc-button', '채팅')
      await app.cdp.waitFor(`!!${chat}?.querySelector('u-prompt')`, 'the chat beside 고객')
      await app.cdp.evaluate(`[...${chat}.querySelector('dc-segmented-control').shadowRoot.querySelectorAll('[role=radio]')].find((b) => b.textContent.includes('기록에 묻기')).click()`)
      const most = await ask('문의가 제일 많은 고객은?', '{"of": "문의", "groupBy": ["고객"], "top": 1}')
      assert.match(most, /센 것: 「문의」의 모든 기록 · 고객별 · 많은 것 1개/, `what was counted, in words: ${most}`)
      const mostRows = await app.cdp.evaluate(`[...${chat}.querySelectorAll('u-message:last-of-type tbody tr')].map((tr) => [tr.cells[0].textContent.trim(), Number(tr.cells[1].textContent)])`)
      assert.deepEqual(mostRows, [['가나상사', 2]])
      // Their amounts added up per customer, the largest sum first: a customer whose inquiries have none has no sum — not 0 —
      // and the whole is the vault's, said with how many of the documents had an amount.
      const summed = await ask('고객별 문의 금액 합계는?', '{"of": "문의", "groupBy": ["고객"], "sum": "금액"}')
      assert.match(summed, /센 것: 「문의」의 모든 기록 · 고객별 · 금액 합계/, `what was counted, in words: ${summed}`)
      assert.match(summed, /금액 합계 3,500\.5 \(3건 중 2건에 값\)/, `the whole: ${summed}`)
      const sumRows = await app.cdp.evaluate(`[...${chat}.querySelectorAll('u-message:last-of-type tbody tr')].map((tr) => [tr.cells[0].textContent.trim(), Number(tr.cells[1].textContent), tr.cells[2].textContent.replace(/\\s+/g, ' ').trim()])`)
      assert.deepEqual(sumRows, [['가나상사', 2, '3,500.5'], ['다라무역', 1, '(비어 있음)']])
      assert.match(asked.at(-1).messages[0].content, /`금액` \(숫자\)/, 'the model was told which fields are numbers')
      // The model was told which template refers to the customers, by which field, and what it is counted by — no value.
      const toldOf = asked.at(-1).messages[0].content
      assert.match(toldOf, /- `문의` — `고객` 칸이 이 서식의 문서를 가리킵니다/)
      assert.ok(!toldOf.includes('가나상사') && !toldOf.includes('문의 1'), 'no value went to the model')
      await app.noAlert()
      // A template that does not refer to the customers is not counted for them — said, last, as the chat says what it could not count.
      assert.match(await ask('메모 수?', '{"of": "메모", "groupBy": []}'), /이 서식을 가리키지 않는 서식\(메모\)의 기록을 세려 했습니다/)
    } finally {
      server.close()
      await useModel(null)
      for (let tries = 0; JSON.parse(await readFile(SETTINGS, 'utf8').catch(() => '{}')).model && tries < 50; tries++)
        await new Promise((r) => setTimeout(r, 100))
      // Leave the vault as it was for the scenarios that follow — with no template of it open.
      await app.learning()
      for (const file of [CUSTOMER.path, INQUIRY.path, '문서/가나상사.md', '문서/다라무역.md', '문서/문의-1.md', '문서/문의-2.md', '문서/문의-3.md'])
        await rm(join(vault, file), { force: true })
      await app.cdp.waitFor(`!__e2e.one('button.item:not(.group-toggle)', '문의')`, 'the templates gone from the sidebar', { timeoutMs: 30_000 })
    }
  },
}

const CUSTOMER = { name: '고객', ref: 'customer@1', path: '서식/고객.fd.md' }
const INQUIRY = { name: '문의', ref: 'inquiry@1', path: '서식/문의.fd.md' }
