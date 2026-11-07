// Walks the update a person's installed copy takes on its own: the release before the newest published one is
// installed and started, finds the newest release, downloads its installer, and installs it when «지금 설치» is
// pressed — pressed in its window through Windows UI Automation, as a person presses it, since Lowline installs
// only when asked. The walk then checks the installed version, that the app starts again, and that the next
// launch lets go of what it kept. Windows only; the newest release must already be published.
//
//   node scripts/walk-update.mjs [<from-tag>]
//
// The installed app is the app itself, with its own identifier, so it keeps its data where a person's own
// Lowline does: those folders are set aside for the walk and put back afterwards, with nothing the walk wrote.
// It refuses to run while Lowline is installed on this computer.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pressButtonWhenShown, walkUpdate, withAppDataSetAside } from '@iyulab/tauri-kit-dev/installer'

if (process.platform !== 'win32') {
  console.error('walk-update: Windows only')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { productName, identifier } = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
// The button's accessible name — the label the app shows (src/strings.ts `updateInstall`), read from there so the
// walk follows a renamed label.
const INSTALL = readFileSync(join(root, 'src', 'strings.ts'), 'utf8').match(/updateInstall:\s*'([^']+)'/)?.[1]
if (!INSTALL) throw new Error('walk-update: `updateInstall` not found in src/strings.ts')
// Where the app keeps what is this device's: caches, logs and the web view's profile (local), the session, the
// settings, the device id and the update state (roaming — `app_data_dir`, src-tauri/src/update.rs).
const LOCAL = join(process.env.LOCALAPPDATA, identifier)
const ROAMING = join(process.env.APPDATA, identifier)

const { from, to, steps } = await withAppDataSetAside(LOCAL, () =>
  withAppDataSetAside(ROAMING, () =>
    walkUpdate({
      repo: 'iyulab/lowline-releases',
      exe: `${productName}.exe`,
      product: productName,
      stateFile: join(ROAMING, 'updates.json'),
      from: process.argv[2],
      // The downloaded installer is held in memory, not kept in a file (src-tauri/src/update.rs), so there is
      // no `keptInstaller` to look for.
      install: ({ pid }) => pressButtonWhenShown(pid, INSTALL),
      restarts: true,
    }),
  ),
)

console.log(`walk-update ${from} → ${to}`)
for (const { name, ok, detail } of steps) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
process.exit(steps.every((s) => s.ok) ? 0 : 1)
