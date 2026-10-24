import { describe, expect, it } from 'vitest'
import { removedBy, Saves, type VaultChanged } from '../vault-client.js'

const change = (c: Partial<VaultChanged>): VaultChanged => ({ rescan: false, written: [], removed: [], ...c })

describe('removedBy', () => {
  const path = '문서/a.md'

  it('is true when the change names the path as removed', () => {
    expect(removedBy(change({ removed: [path] }), path, [])).toBe(true)
  })

  it('is false when the path was written, or not touched', () => {
    expect(removedBy(change({ written: [path] }), path, [])).toBe(false)
    expect(removedBy(change({ removed: ['문서/b.md'] }), path, [])).toBe(false)
  })

  it('reads the listing when changes were lost', () => {
    expect(removedBy(change({ rescan: true }), path, ['문서/b.md'])).toBe(true)
    expect(removedBy(change({ rescan: true }), path, [path, '문서/b.md'])).toBe(false)
  })
})

describe('Saves', () => {
  it('tells a notice handled while a save ran, or after one, from one no save overlapped', async () => {
    const saves = new Saves()
    const before = saves.mark()
    expect(saves.quietSince(before)).toBe(true)

    let finish!: () => void
    const running = saves.run(() => new Promise<void>((resolve) => (finish = resolve)))
    const during = saves.mark()
    expect(saves.quietSince(during)).toBe(false) // still saving
    finish()
    await running
    expect(saves.quietSince(during)).toBe(false) // the save ended after the mark
    expect(saves.quietSince(before)).toBe(false)
    expect(saves.quietSince(saves.mark())).toBe(true)
  })

  it('ends the save when it fails', async () => {
    const saves = new Saves()
    await expect(saves.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(saves.quietSince(saves.mark())).toBe(true)
  })
})
