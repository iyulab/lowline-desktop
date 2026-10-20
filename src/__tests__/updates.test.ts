import { describe, expect, it } from 'vitest'
import { toTell, type UpdateView } from '../updates.ts'

const found = (available: string | null, more: Partial<UpdateView> = {}): UpdateView => ({ available, ready: false, failed: false, ...more })

describe('the newer release to tell of', () => {
  it('is none while nothing newer is found, or before the shell answered', () => {
    expect(toTell(undefined, undefined)).toBeUndefined()
    expect(toTell(found(null), undefined)).toBeUndefined()
  })

  it('is the one found, downloading, downloaded or failed to download', () => {
    expect(toTell(found('0.4.0'), undefined)).toEqual(found('0.4.0'))
    expect(toTell(found('0.4.0', { ready: true }), undefined)?.ready).toBe(true)
    expect(toTell(found('0.4.0', { failed: true }), undefined)?.failed).toBe(true)
  })

  it('is not one the person put off, until a newer one is found', () => {
    expect(toTell(found('0.4.0', { ready: true }), '0.4.0')).toBeUndefined()
    expect(toTell(found('0.4.1'), '0.4.0')).toEqual(found('0.4.1'))
  })
})
