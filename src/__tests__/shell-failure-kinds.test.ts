// What a failed shell command can say went wrong, as the shell's own test wrote it, read against the UI's list: a
// kind the shell adds or renames would otherwise reach a view that never branches on it.
import { describe, expect, it } from 'vitest'
import { describeError } from '../errors.js'
import { strings } from '../strings.js'
import { VAULT_FAILURE_KINDS } from '../vault-client.js'
import file from './shell-failure-kinds.json'

describe('the kinds of a failed shell command', () => {
  it('are the ones the UI knows, and no more', () => {
    expect([...VAULT_FAILURE_KINDS].sort()).toEqual([...file].sort())
  })

  it("each say in the app's words what went wrong, not the shell's sentence", () => {
    expect(Object.keys(strings.errors.shell).sort()).toEqual([...VAULT_FAILURE_KINDS].sort())
    for (const kind of VAULT_FAILURE_KINDS) {
      const said = describeError({ kind, message: 'Permission denied (os error 13): 문서/a.md' })
      expect(said).toBe(strings.errors.shell[kind])
      expect(said).not.toContain('os error')
    }
  })
})
