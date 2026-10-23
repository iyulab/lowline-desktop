// Checks the installer the way a person gets the app: installed silently for this user into a temporary
// folder with its third-party notices beside it, started — and the sidecar it ships starts with it,
// from the installed folder — then closed, taking the sidecar with it, and uninstalled. Then the way a
// person updates it: the latest published release installed and its sidecar given a vault, so it writes
// the caches a person's copy keeps, this installer installed over it, and the updated sidecar given the
// same vault over those caches — it must answer the same table and suggestion with no failure. Windows only.
//
//   node scripts/check-installer.mjs [<installer>]
//
// Without an argument it takes the installer of this version from the bundle folder (`tauri build`).
// The published release is fetched with `gh`; with none published other than this version, that part is
// skipped. The installed app is the app itself, with its own identifier, so it keeps its data where a
// person's own Lowline does: those folders are set aside for the check and put back afterwards, with
// nothing the check wrote.

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSchema, parseFormdown } from '@formdown/core'
import {
  downloadInstaller,
  fileVersion,
  findInstaller,
  nsisArgs,
  pickUpgradeFrom,
  publishedReleases,
  run,
  withAppDataSetAside,
  withInstalled,
} from '@iyulab/tauri-kit-dev/installer'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { productName, version, identifier } = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const EXE = `${productName}.exe`
const SIDECAR = 'Lowline.Host.exe'
const RELEASES = 'iyulab/lowline-releases'
// Where the app keeps what is this device's: caches, logs and the web view's profile (local), the session,
// the settings and the device id (roaming).
const LOCAL = join(process.env.LOCALAPPDATA, identifier)
const ROAMING = join(process.env.APPDATA, identifier)

/**
 * The environment for Windows PowerShell: without the module path PowerShell 7 sets for its children,
 * under which Windows PowerShell cannot load its own modules (signatures, for one).
 */
function windowsPowerShellEnv() {
  const { PSModulePath, ...env } = process.env
  return env
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The running processes named `name` whose executable is under `folder`. */
function runningFrom(name, folder) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.ExecutablePath -like '${folder.replaceAll("'", "''")}\\*' } | Measure-Object | Select-Object -ExpandProperty Count`
  return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: windowsPowerShellEnv() }).trim())
}

async function until(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(500)
  }
  return false
}

/**
 * Starts the app installed in `target`, waits until its sidecar runs from there, checks it stays up, then
 * closes it and checks the sidecar goes with it.
 */
async function startAndClose(target) {
  const app = spawn(join(target, EXE), [], { stdio: 'ignore' })
  try {
    if (!(await until(() => runningFrom(SIDECAR, target) > 0, 30_000))) throw new Error(`the installed app did not start ${SIDECAR} from ${target}`)
    await sleep(3_000)
    if (app.exitCode !== null) throw new Error(`the installed app exited (${app.exitCode}) while its sidecar ran`)
  } finally {
    app.kill()
    await new Promise((done) => (app.exitCode !== null || app.signalCode !== null ? done() : app.once('exit', done)))
  }
  // The sidecar lives in the app's job object: when the app goes, so does the sidecar.
  if (!(await until(() => runningFrom(SIDECAR, target) === 0, 10_000))) throw new Error(`${SIDECAR} outlived the installed app`)
}

/**
 * A vault as the shell hands it to the sidecar: a template with a judgment field, and documents settling it. The
 * template carries formdown's schema of its fields, as the window sends it (`templateSnapshot`) — the sidecar declares
 * the template's columns from it. A release before that ignores it.
 */
function snapshot() {
  const teams = ['가', '나', '다']
  const owners = { 가: '장비', 나: '총무', 다: '인사' }
  const body = [
    '@요청: [textarea]',
    `@부서: [select options="${teams.join(',')}"]`,
    `@담당: [select options="${Object.values(owners).join(',')}"]`,
    '@날짜: [date]',
  ].join('\n\n')
  return {
    templates: [
      {
        ref: 'intake@1',
        fields: [
          { name: '요청', type: 'textarea' },
          { name: '부서', type: 'select', options: teams },
          { name: '담당', type: 'select', options: Object.values(owners) },
          { name: '날짜', type: 'date' },
        ],
        suggest: ['담당'],
        schema: getSchema(parseFormdown(body)),
      },
    ],
    documents: Array.from({ length: 60 }, (_, i) => ({
      path: `문서/접수-${i + 1}.md`,
      template: 'intake@1',
      values: { 요청: `노트북 배터리 교체 ${i + 1}`, 부서: teams[i % 3], 담당: owners[teams[i % 3]], 날짜: `2026-09-${String((i % 28) + 1).padStart(2, '0')}` },
      modified: 1790000000000 + i * 60000,
    })),
    events: [],
  }
}

/**
 * Runs the sidecar the app installed in `target` as the shell does — a launch token, a folder for its caches —
 * hands it the vault, and answers what a person would see of it: the table's rows, a suggestion, and the
 * failures it recorded.
 */
async function sidecarOver(target, cache) {
  const token = randomBytes(32).toString('hex')
  const host = spawn(join(target, 'host', SIDECAR), [], {
    env: { ...process.env, LOWLINE_HOST_TOKEN: token, LOWLINE_HOST_CACHE: cache },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  host.stderr.on('data', (d) => (stderr += d))
  try {
    const port = await new Promise((resolve, reject) => {
      let out = ''
      host.stdout.on('data', (d) => {
        out += d
        const ready = out.match(/lowline-host port=(\d+)/)
        if (ready) resolve(Number(ready[1]))
      })
      host.once('exit', (code) => reject(new Error(`${SIDECAR} exited (${code}) before it listened: ${stderr}`)))
    })
    const call = async (path, body) => {
      const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await answer.text()
      if (!answer.ok) throw new Error(`${path} answered ${answer.status}: ${text}`)
      return text ? JSON.parse(text) : null
    }
    await call(`/vault/ingest?vault=${encodeURIComponent('C:/upgrade-check-vault')}`, snapshot())
    const table = await call('/projection', { template: 'intake@1' })
    // Thresholds are chosen again in the background when the suggestion engine's version changed — kept ones
    // were chosen on its scores — so a suggestion is waited for, not asked once.
    const ask = () => call('/suggest', { template: 'intake@1', field: '담당', values: { 요청: '처음 보는 요청', 부서: '나' } })
    let suggestion = await ask()
    for (const deadline = Date.now() + 60_000; suggestion?.value == null && Date.now() < deadline; suggestion = await ask()) await sleep(500)
    const failures = await call('/failures/take')
    await call('/shutdown').catch(() => {})
    return { rows: table.rows.length, suggested: suggestion?.value ?? null, failures }
  } finally {
    if (host.exitCode === null) {
      await new Promise((done) => {
        const forced = setTimeout(() => (host.kill(), done()), 10_000)
        host.once('exit', () => (clearTimeout(forced), done()))
      })
    }
  }
}

const installer = process.argv[2] ?? findInstaller(join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis'), { version, hint: 'run `npx tauri build --bundles nsis` first' })
console.log(`installer: ${installer}`)

await withAppDataSetAside(LOCAL, () => withAppDataSetAside(ROAMING, async () => {
  await withInstalled(
    installer,
    async (target) => {
      const notices = join(target, 'THIRD-PARTY-NOTICES.txt')
      if (!existsSync(notices) || !readFileSync(notices, 'utf8').includes('third-party packages')) throw new Error(`the installer did not ship ${notices}`)
      console.log(`  ✓ ships its third-party notices`)
      // A release build is signed: every program it installs carries a valid signature. Only the
      // installed copies say so — the bundler signs what goes into the installer, not the build output.
      if (process.env.LOWLINE_EXPECT_SIGNED) {
        const ps = `Get-ChildItem -LiteralPath '${target.replaceAll("'", "''")}' -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object { '{0}|{1}' -f $_.Name, (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status }`
        const programs = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: windowsPowerShellEnv() }).trim().split(/\r?\n/).map((l) => l.split('|'))
        const unsigned = programs.filter(([, status]) => status !== 'Valid').map(([name, status]) => `${name} (${status})`)
        if (!programs.some(([name]) => name.toLowerCase() === EXE.toLowerCase())) throw new Error(`the installer did not install ${EXE}`)
        if (unsigned.length) throw new Error(`not signed: ${unsigned.join(', ')}`)
        console.log(`  ✓ every installed program is signed: ${programs.map(([name]) => name).join(', ')}`)
      }
      await startAndClose(target)
      console.log(`  ✓ installed, started with its sidecar from the installed folder, stays up, and closing it ends the sidecar`)
    },
    { exe: EXE, prefix: 'lowline-installed-' },
  )
  console.log(`  ✓ uninstalled`)

  const from = pickUpgradeFrom(publishedReleases(RELEASES), version)
  if (!from) {
    console.log(`  - no published release other than ${version} to update from`)
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'lowline-upgrade-'))
  try {
    const published = await downloadInstaller({ repo: RELEASES, tag: from, dir: scratch })
    const cache = join(scratch, 'projections')
    await withInstalled(
      published,
      async (target) => {
        const before = await sidecarOver(target, cache)
        if (before.failures.length) throw new Error(`${from}'s sidecar failed: ${JSON.stringify(before.failures)}`)
        console.log(`  ✓ ${from} installed, and its sidecar cached a vault (${before.rows} rows)`)
        run(installer, nsisArgs(target), `installing ${version} over ${from}`)
        const installed = fileVersion(join(target, EXE))
        if (installed !== version) throw new Error(`${EXE} is ${installed} after installing ${version} over ${from}`)
        const after = await sidecarOver(target, cache)
        if (after.failures.length) throw new Error(`${version} over ${from}: the sidecar failed on the caches ${from} wrote: ${JSON.stringify(after.failures)}`)
        if (after.rows !== before.rows || after.suggested !== before.suggested) {
          throw new Error(`${version} over ${from} reads the vault differently: ${JSON.stringify(before)} then ${JSON.stringify(after)}`)
        }
        await startAndClose(target)
        console.log(`  ✓ ${version} installed over ${from}: its sidecar reads the caches ${from} wrote to the same table and suggestion, and the app starts`)
      },
      { exe: EXE, prefix: 'lowline-upgraded-' },
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}))
console.log(`  ✓ uninstalled, and the data folders are as they were`)
