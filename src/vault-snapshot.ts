// Reads the vault as the sidecar needs it and hands it over. The sidecar only knows what this sends.

import { TemplateError } from './documents.js'
import { parseEvents, type SuggestionEvent } from './events.js'
import { currentRefs, revisedRef } from './template-revision.js'
import { documentSnapshot, templateSnapshot, type DocumentSnapshot, type TemplateSnapshot } from './projection.js'
import { ReadCache } from './read-cache.js'
import { SharedRun } from './shared-run.js'
import type { TemplateItem } from './template-scope.js'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { host, onHostRestarted, onVaultChanged as onShellChange, onWritten, vault, withoutConflictCopies, type VaultChanged, type VaultEntry, type VaultInfo } from './vault-client.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// What was last read of the open vault. A template without an identity is kept as null.
const templateReads = new ReadCache((_entry, source): TemplateSnapshot | null => {
  try {
    return templateSnapshot(source)
  } catch (e) {
    if (e instanceof TemplateError) return null
    throw e
  }
})
const documentReads = new ReadCache((entry, source) => documentSnapshot(entry.path, source, entry.modifiedMs))
const eventReads = new ReadCache((_entry, source) => parseEvents(source))
const reads = [templateReads, documentReads, eventReads]

const listeners = new Set<(change: VaultChanged) => void>()
let watching: Promise<UnlistenFn> | undefined
let restarted: Promise<UnlistenFn> | undefined

/**
 * Hears changes outside the app from the shell — once, for everyone: what was read of a change is
 * forgotten before anyone is told of it, which the shell's own order of handlers would not promise.
 */
function watch(): Promise<UnlistenFn> {
  // A sidecar started again after it ended holds nothing of the vault: every view hands it over again, as on
  // a change that touched no file.
  void (restarted ??= onHostRestarted(() => {
    shared.invalidate()
    for (const listener of [...listeners]) listener({ rescan: false, written: [], removed: [] })
  }))
  return (watching ??= onShellChange((change) => {
    forget(change)
    for (const listener of [...listeners]) listener(change)
  }))
}

/** Drops what the last reads know of files a change outside the app touched. */
function forget(change: VaultChanged) {
  for (const cache of reads) cache.forget(change)
  shared.invalidate()
}

/**
 * Calls `onChange` whenever something outside the app changes the vault, once what the reads knew of
 * it is forgotten: a read started on hearing it — or one under way it would join — has the change.
 * Resolves to the way to stop.
 */
export async function onVaultChanged(onChange: (change: VaultChanged) => void): Promise<UnlistenFn> {
  listeners.add(onChange)
  await watch()
  return () => void listeners.delete(onChange)
}

/** Drops everything read: another vault, or the event files written. */
function clear(caches: readonly ReadCache<unknown>[] = reads) {
  for (const cache of caches) cache.clear()
  shared.invalidate()
}

// A file time may not move between two quick saves (some file systems keep whole seconds).
onWritten.add((path) => (path === null ? clear([eventReads]) : forget({ rescan: false, written: [path], removed: [] })))

/** Opens a vault; nothing read of the one before carries over. */
export async function openVault(path: string): Promise<VaultInfo> {
  clear()
  return vault.open(path)
}

/** Opens the vault the app was last using, if no vault is open yet: it, and where the app was in it. */
export async function resumeVault(): Promise<{ vault: VaultInfo; session: unknown } | null> {
  clear()
  const resumed = await vault.resume()
  if (!resumed) return null
  let session: unknown
  try {
    session = JSON.parse(resumed.session)
  } catch {
    session = undefined
  }
  return { vault: resumed.vault, session }
}

export interface ReadVault {
  templates: TemplateSnapshot[]
  /** Each template's name as the vault shows it (its file name), by reference. */
  names: Map<string, string>
  /** The templates with an identity, as the sidebar lists them, in the vault's order. */
  templateItems: TemplateItem[]
  documents: DocumentSnapshot[]
  /** Every document file, sync conflict copies included, as the vault lists them. */
  documentEntries: VaultEntry[]
  events: SuggestionEvent[]
}

/**
 * Every template with an identity and every document that names a template. Sync clients' conflict
 * copies are not read: a copy is not a second document, template or event file, and the document it
 * copies is marked as not settled. Only files changed since the last read are read and parsed again.
 *
 * The sidebar, the list, the table and the template each ask when they appear, often at once: a
 * read under way is shared with them, unless something changed since it began.
 */
export function readVault(): Promise<ReadVault> {
  void watch()
  return shared.call()
}

/**
 * The vault read anew: a read under way is not joined, whatever it knows. For a question whose answer would otherwise
 * deny something (a template, a document) on a read made before it — files whose time did not move are not read again.
 */
export function readVaultAgain(): Promise<ReadVault> {
  shared.invalidate()
  return readVault()
}

const shared = new SharedRun(readNow)

async function readNow(): Promise<ReadVault> {
  performance.mark('vault:list')
  const listed = await Promise.all([vault.listTemplates(), vault.listDocuments(), vault.listEvents()])
  performance.measure('vault:list', 'vault:list')
  const [templateEntries, documentEntries, eventEntries] = listed.map((entries) => withoutConflictCopies(entries).files)
  const { conflicted } = withoutConflictCopies(listed[1])
  // One call into the shell per kind of file, not one per file: a vault of thousands of documents
  // would otherwise spend most of a read crossing that boundary. A file removed since it was listed
  // is left out — the change that removed it reads the vault again.
  performance.mark('vault:read')
  const [templateValues, documentValues, eventValues] = await Promise.all([
    templateReads.read(templateEntries, vault.readMany),
    documentReads.read(documentEntries, vault.readMany),
    eventReads.read(eventEntries, vault.readMany),
  ])
  performance.measure('vault:read', 'vault:read')
  const templates: TemplateSnapshot[] = []
  const names = new Map<string, string>()
  const templateItems: TemplateItem[] = []
  templateEntries.forEach((entry, i) => {
    const template = templateValues[i]
    if (!template) return
    const name = entry.name.replace(/\.fd\.md$/, '')
    templates.push(template)
    names.set(template.ref, name)
    templateItems.push({ ref: template.ref, name, path: entry.path })
  })
  // A document or event of an earlier revision belongs to its template as it is now: its files say the
  // revision they were written with, and are left as they are.
  const current = currentRefs(templates)
  const documents: DocumentSnapshot[] = []
  documentEntries.forEach((entry, i) => {
    const read = documentValues[i]
    if (!read) return
    const document = { ...read, template: revisedRef(read.template, current) }
    documents.push(conflicted.has(entry.path) ? { ...document, conflicted: true } : document)
  })
  const events = eventValues.flatMap((parsed) => parsed ?? []).map((e) => (e.template ? { ...e, template: revisedRef(e.template, current) } : e))
  return { templates, names, templateItems, documents, documentEntries: listed[1], events }
}

/** Why the sidecar is not there, thrown as a string by `sidecarReady`. */
export class SidecarUnavailable extends Error {}

/** Waits for the sidecar; throws `SidecarUnavailable` if it failed to start. */
export async function sidecarReady() {
  for (;;) {
    const status = await host.status()
    if (status.state === 'ready') return
    if (status.state === 'failed') throw new SidecarUnavailable(status.message)
    await sleep(200)
  }
}

/**
 * Reads the vault and hands it to the sidecar — after `change`, when a change outside the app is why.
 * Each step leaves a `vault:*` performance measure, so what a sync costs can be read from the page.
 */
export async function syncVault(change?: VaultChanged) {
  if (change) forget(change)
  await sidecarReady()
  const read = await readVault()
  performance.mark('vault:ingest')
  const ingest = await host.ingest({ templates: read.templates, documents: read.documents, events: read.events })
  performance.measure('vault:ingest', 'vault:ingest')
  return { ...read, ingest }
}
