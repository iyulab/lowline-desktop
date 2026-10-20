// What the e2e scenarios share: the fixture vault's templates, reading what the app wrote to disk, and
// watching the sidecar and the window.

import { fileURLToPath } from 'node:url'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { parseFormdown } from '@formdown/core'
import { IDENTIFIER, command } from './app.mjs'

export const here = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE = '서식/버그 리포트.fd.md'
/** The fixture vault's templates: their names, references and files. */
export const BUG = { name: '버그 리포트', ref: 'bug-report@1', path: TEMPLATE }
export const INTAKE = { name: '접수', ref: 'intake@1', path: '서식/접수.fd.md' }
/** The template's inline title field (`제목: ___@제목`). */
export const TITLE = '[data-field-name="제목"]'

/** Documents the fixture vault ships with: confirmed intake records suggestions learn from. */
export const FIXTURE_DOCUMENT = /^접수-\d+\.md$/

/** The documents the scenarios created. */
export async function documentsIn(vault) {
  return (await readdir(join(vault, '문서'))).filter((n) => n.endsWith('.md') && !FIXTURE_DOCUMENT.test(n))
}

/** Every suggestion event the vault holds, oldest first. */
export async function events(vault) {
  const dir = join(vault, '.lowline', 'events')
  const files = existsSync(dir) ? await readdir(dir) : []
  const lines = []
  for (const f of files) lines.push(...(await readFile(join(dir, f), 'utf8')).split('\n').filter(Boolean))
  return lines.map((l) => JSON.parse(l))
}

/** This device's record of the suggestions it showed, outside the vault (one file per vault). */
export async function presentations() {
  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), IDENTIFIER, 'presentations')
  const files = existsSync(dir) ? await readdir(dir) : []
  const lines = []
  for (const f of files) lines.push(...(await readFile(join(dir, f), 'utf8')).split('\n').filter(Boolean))
  return lines.map((l) => JSON.parse(l))
}

export const fileValues = async (path) => parseFormdown(await readFile(path, 'utf8')).frontMatter?.data ?? {}

/** Everything after the front matter. */
export async function fileBody(path) {
  const source = await readFile(path, 'utf8')
  const span = parseFormdown(source).frontMatter?.span
  assert.ok(span, `${path} has front matter`)
  return source.slice(span.end)
}


/**
 * How long the window's main thread was held by tasks of 50 ms or more since the page loaded, as a phrase for a
 * measurement line: work a restart does on the UI thread — listing, reading, rendering a large vault — blocks the
 * window before it shows in the time to the table, as a list rendered row by row against the whole list once did.
 */
export async function longTasks(app) {
  const { count, total, longest } = await app.cdp.evaluate(`new Promise((resolve) => {
    const done = (entries) => resolve({
      count: entries.length,
      total: Math.round(entries.reduce((sum, e) => sum + e.duration, 0)),
      longest: Math.round(Math.max(0, ...entries.map((e) => e.duration))),
    })
    // The buffered entries come in one call; with none, there is no call.
    const observer = new PerformanceObserver((list) => { observer.disconnect(); done(list.getEntries()) })
    observer.observe({ type: 'longtask', buffered: true })
    setTimeout(() => { observer.disconnect(); done([]) }, 1000)
  })`)
  return `main thread held ${total} ms in ${count} long tasks, longest ${longest}`
}

/** Waits until the sidecar has kept thresholds chosen after `since` beside the e2e app's caches; false if it never did. */
export async function thresholdsChosenSince(since, timeoutMs = 180_000) {
  const { stat } = await import('node:fs/promises')
  const caches = join(process.env.LOCALAPPDATA ?? tmpdir(), IDENTIFIER, 'projections')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const name of await readdir(caches).catch(() => [])) {
      if (name.endsWith('.thresholds.json') && (await stat(join(caches, name))).mtimeMs >= since) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/** Waits until the sidecar spends under a tenth of a core over two seconds; false if it never did. */
export async function sidecarQuiet(timeoutMs = 180_000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; ) if ((await sidecarCpuOver(2_000)) < 200) return true
  return false
}

/** The CPU time the sidecar spends over the next `ms`, in milliseconds. */
export async function sidecarCpuOver(ms) {
  const cpu = async () =>
    Number((await command('powershell', ['-NoProfile', '-Command', `(Get-Process Lowline.Host).TotalProcessorTime.TotalMilliseconds`])).trim())
  const before = await cpu()
  await new Promise((resolve) => setTimeout(resolve, ms))
  return Math.round((await cpu()) - before)
}

/**
 * What the app was saying when a scenario failed, for the runner to print beside the failure and its
 * picture: the page's open dialog, alerts and status lines, what the sidecar answers — a failure there is
 * kept off the screen, suggestions being optional — and the last error reports.
 */
export async function shown(app) {
  const said = await app.cdp.evaluate(
    `[
      ...__e2e.all('dc-confirm-dialog').filter((d) => d.open).map((d) => 'dialog: ' + d.heading),
      ...__e2e.all('[role=alert], [role=status]').map((el) => el.getAttribute('role') + ': ' + el.textContent.trim()),
    ].filter((t) => !t.endsWith(': '))`,
  )
  const sidecar = await app.cdp.evaluate(
    `(async () => { const T = window.__TAURI_INTERNALS__; const out = {}
      for (const cmd of ['host_status', 'host_curves']) {
        try { out[cmd] = JSON.stringify(await T.invoke(cmd)).slice(0, 300) } catch (e) { out[cmd] = 'error: ' + JSON.stringify(e) }
      }
      return out })()`,
  )
  // Where the app is, and how long the page takes to answer: a wait that timed out on a page that answers at once
  // and holds the vault was slow; one on a page that answers late, or holds no vault, was stuck.
  const asked = Date.now()
  const vault = await app.cdp.evaluate(`document.querySelector('ll-app')?.vaultInfo?.name ?? null`)
  const answeredIn = Date.now() - asked
  const at = await app.where()
  // The error reports hold a failure's kind and frames only, nothing of the page: safe to print. Only those
  // written since the run began and not caused on purpose — the folder keeps every run's.
  const reported = (await reportLines()).filter((line) => !reportsSeen.has(line)).slice(-3)
  return `page: ${JSON.stringify(said)}\n    app: ${JSON.stringify({ vault, ...at })} · the page answered in ${answeredIn} ms\n    sidecar: ${JSON.stringify(sidecar)}\n    reports: ${reported.length ? reported.join('\n             ') : 'none this run'}`
}

const LOGS = join(process.env.LOCALAPPDATA ?? tmpdir(), IDENTIFIER, 'logs')
/** The folder of error reports the app writes, a segment per launch, every run's. */
export const REPORTS = join(LOGS, 'reports')

/**
 * Every error report written so far, one JSON line each: each segment's in the order it was written (a
 * launch writes one segment), and the single file earlier versions kept, which the next launch takes in.
 */
export async function reportLines() {
  const files = existsSync(REPORTS) ? (await readdir(REPORTS)).filter((n) => n.endsWith('.jsonl')).map((n) => join(REPORTS, n)) : []
  const legacy = join(LOGS, 'reports.jsonl')
  if (existsSync(legacy)) files.push(legacy)
  const lines = []
  for (const file of files) lines.push(...(await readFile(file, 'utf8')).split('\n').filter(Boolean))
  return lines
}
let reportsSeen = new Set(await reportLines())

/** Leaves the reports written so far out of what a failure prints: a scenario that causes them on purpose calls it. */
export async function reportsCaused() {
  reportsSeen = new Set(await reportLines())
}

/** Over SMB (`E2E_VAULT_UNC`) the vault has no trash: the app asks again, and the answer is `button`. */
export const SMB = Boolean(process.env.E2E_VAULT_UNC)

export async function deleteForGoodOverSmb(app, button) {
  if (!SMB) return
  await app.cdp.waitFor(
    `__e2e.all('dc-confirm-dialog').some((d) => d.open && d.heading === '휴지통으로 옮기지 못했습니다')`,
    'asked to delete for good, where there is no trash',
  )
  await app.click('dc-button', button)
}

/**
 * What the system's trash took from `folder` (see `takeFromRecycleBin`), or `null` where it cannot be
 * looked into: off Windows, on a CI runner, whose service session sees an empty Recycle Bin, and over SMB, where nothing goes to one.
 * Scenarios still check that the file left the vault.
 */
export function trashed(folder) {
  return process.platform === 'win32' && !process.env.CI && !SMB ? takeFromRecycleBin(folder) : Promise.resolve(null)
}

/**
 * The names of what the Recycle Bin holds from `folder`, taken out of it for good — so a scenario
 * checks that a file went to the trash (and was not just deleted) and leaves nothing behind there.
 */
export async function takeFromRecycleBin(folder) {
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
    $bin = (New-Object -ComObject Shell.Application).NameSpace(10)
    $names = @()
    foreach ($item in @($bin.Items())) {
      if ($bin.GetDetailsOf($item, 1) -ne $env:E2E_TRASHED_FROM) { continue }
      $names += $bin.GetDetailsOf($item, 0)
      # Each item is two files: $R… holds the content, $I… where it came from.
      Remove-Item -LiteralPath $item.Path -Recurse -Force
      Remove-Item -LiteralPath (Join-Path (Split-Path $item.Path) ('$I' + (Split-Path $item.Path -Leaf).Substring(2))) -Force -ErrorAction SilentlyContinue
    }
    ConvertTo-Json -InputObject @($names) -Compress`
  const out = await command('powershell', ['-NoProfile', '-Command', script], {
    env: { ...process.env, E2E_TRASHED_FROM: folder },
  })
  return JSON.parse(out.trim() || '[]')
}
