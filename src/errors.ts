import { TemplateError } from './documents.js'
import { strings } from './strings.js'
import { isVaultFailure } from './vault-client.js'

/** A sentence for the user describing why an action failed. */
export function describeError(e: unknown): string {
  if (e instanceof TemplateError) {
    const key = e.message as 'missing-id' | 'missing-version' | 'invalid-id' | 'reserved-field'
    return strings.errors[key] ?? strings.errors.unknown(e.message)
  }
  if (isVaultFailure(e)) {
    return strings.errors.shell[e.kind] ?? strings.errors.shell.io
  }
  return strings.errors.unknown(e instanceof Error ? e.message : String(e))
}
