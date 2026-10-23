// The vault as the UI hands it to the sidecar, and the questions it asks, written to files the sidecar's tests
// read: what the UI sends is pinned here, and there each field is either read or left out on purpose — a field
// the sidecar silently drops (as a choice field's options once were) fails one side or the other.
import { describe, expect, it, vi } from 'vitest'
import { newDocument } from '../documents.js'
import { suggestionEvents } from '../events.js'
import { documentSnapshot, templateSnapshot, type VaultSnapshot } from '../projection.js'
import { host } from '../vault-client.js'

/** Each command the UI invoked, with what it handed the shell. */
const invoked = vi.hoisted(() => [] as [string, Record<string, unknown>][])
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    invoked.push([command, args])
    return null
  },
}))

const intake = `---
id: intake
version: 2
lowline:
  suggest: [담당]
  coarse: { 담당: 1 }
---
# 접수

@요청: [textarea suggest:evidence=false]

@부서: [select options="sales=영업,dev=개발"]

@담당: [radio options="장비,총무" suggest:policy=confirm suggest:must-catch="장비"]

@태그: [checkbox options="급함,반복" suggest:parent=부서]

@고객 -> customer: [select]
`

describe('the vault the sidecar is handed', () => {
  it('is the shape the sidecar reads', async () => {
    const template = templateSnapshot(intake)
    const source = newDocument(intake, { 요청: '모니터가 깜빡여요', 부서: 'sales', 담당: '장비', 태그: ['급함'], 고객: 'customer-1' }, 'doc-1')
    const document = documentSnapshot('문서/2026-10-03-모니터.md', source, 1_790_000_000_000)!
    const events = suggestionEvents(
      new Map([['담당', { suggestion: { value: '장비', mode: 'key', source: '부서: sales' }, shown: new Date('2026-10-03T00:00:00Z'), filled: ['요청', '부서'], typed: 0, decided: new Date('2026-10-03T00:00:05Z'), decidedTyped: 0 }]]),
      new Set(),
      { 담당: '장비' },
      document.id,
      new Date('2026-10-03T00:00:10Z'),
      template.ref,
    )
    const vault: VaultSnapshot = { templates: [template], documents: [{ ...document, conflicted: true, outside: true, proposed: ['담당'] }], events }
    await expect(JSON.stringify(vault, null, 2) + '\n').toMatchFileSnapshot('../../src-host/Lowline.Host.Tests/ui-snapshot.json')
  })
})

describe('the questions the sidecar is asked', () => {
  it('are the bodies the sidecar reads', async () => {
    await host.suggest('intake@2', '담당', { 요청: '모니터가 깜빡여요', 부서: 'sales', 태그: ['급함'] }, 'doc-1', '장')
    await host.search('모니터', 'intake@2')
    await host.similar('문서/2026-10-03-모니터.md')
    await host.projection('intake@2', [{ column: '부서', op: 'contains', value: 'sales' }])
    // The shell hands a `request` on as the body; a table's template and filters it puts in one body as they are.
    const bodies = Object.fromEntries(invoked.map(([command, args]) => [command, 'request' in args ? args.request : args]))
    await expect(JSON.stringify(bodies, null, 2) + '\n').toMatchFileSnapshot('../../src-host/Lowline.Host.Tests/ui-requests.json')
  })
})
