// The UI's only way to the vault: commands handled by the shell, which owns every file.
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AggregateAnswer, CaseHit, ColumnFilter, FieldCurve, IngestResult, ProjectionTable, Suggestion, VaultSnapshot } from './projection.js'

export interface VaultInfo {
  root: string
  name: string
  templatesDir: string
  documentsDir: string
}

export interface VaultEntry {
  /** Relative to the vault root, `/`-separated. */
  path: string
  name: string
  modifiedMs: number
  /**
   * For a copy a sync client made when the file changed on two devices, the path of the file it is a
   * copy of. Which of the two to keep is the person's to decide.
   */
  conflictOf?: string
}

/** A listing's files apart from their conflict copies, and the paths that have a copy. */
export function withoutConflictCopies(entries: readonly VaultEntry[]): { files: VaultEntry[]; conflicted: Set<string> } {
  const conflicted = new Set<string>()
  const files: VaultEntry[] = []
  for (const entry of entries) {
    if (entry.conflictOf === undefined) files.push(entry)
    else conflicted.add(entry.conflictOf)
  }
  return { files, conflicted }
}

/**
 * What a failed command says went wrong, as the shell names it; `shell-failure-kinds.json` holds the shell's own
 * list, and a test holds this one to it.
 */
export const VAULT_FAILURE_KINDS = ['outside-vault', 'already-exists', 'not-found', 'not-trashed', 'changed-outside', 'io', 'no-vault'] as const

/** A failed command, as the shell reports it. */
export interface VaultFailure {
  kind: (typeof VAULT_FAILURE_KINDS)[number]
  message: string
}

export function isVaultFailure(e: unknown): e is VaultFailure {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e
}

/** What a failure says went wrong, when it is the shell's; undefined for anything else. */
export function failureKind(e: unknown): VaultFailure['kind'] | undefined {
  return isVaultFailure(e) ? e.kind : undefined
}

/**
 * Told of each file the app itself writes — the watch does not report those back — with the vault
 * path, or `null` for this device's event file.
 */
export const onWritten = new Set<(path: string | null) => void>()

const wrote = (path: string | null) => {
  for (const listener of onWritten) listener(path)
}

export const vault = {
  open: (path: string) => invoke<VaultInfo>('open_vault', { path }),
  /** The vault the app was last using, opened while no vault is open; null when there is none to open. */
  resume: () => invoke<{ vault: VaultInfo; session: string } | null>('resume_vault'),
  /** Where the app is now — its vault and place — for the next launch. */
  writeSession: (session: string) => invoke<void>('write_session', { session }),
  listTemplates: () => invoke<VaultEntry[]>('list_templates'),
  listDocuments: () => invoke<VaultEntry[]>('list_documents'),
  read: (path: string) => invoke<string>('read_file', { path }),
  /** Several files in one call, in order; `null` for one removed since it was listed. */
  readMany: (paths: string[]) => invoke<(string | null)[]>('read_files', { paths }),
  /** Replaces the file atomically. */
  write: async (path: string, content: string) => {
    await invoke<void>('write_file', { path, content })
    wrote(path)
  },
  /**
   * Replaces the file atomically while it still holds `expected` — what the app last read or wrote
   * there — and rejects with `changed-outside`, leaving it, when it holds something else. A file that
   * is gone is made again.
   */
  writeIfUnchanged: async (path: string, expected: string, content: string) => {
    await invoke<void>('write_file_if_unchanged', { path, expected, content })
    wrote(path)
  },
  /**
   * Creates a file named `name` in `dir` atomically — under that name numbered, `name (1)`, when it
   * is taken; never replacing one. Resolves to the path it was created at.
   */
  create: async (dir: string, name: string, content: string) => {
    const path = await invoke<string>('create_file', { dir, name, content })
    wrote(path)
    return path
  },
  /** Gives a file another name in its folder; rejects with `already-exists` instead of replacing one. */
  rename: async (from: string, to: string) => {
    await invoke<void>('rename_file', { from, to })
    wrote(from)
    wrote(to)
  },
  /** Moves a file to the system's trash; rejects with `not-trashed`, leaving it, where there is none. */
  trash: async (path: string) => {
    await invoke<void>('trash_file', { path })
    wrote(path)
  },
  /** Deletes a file for good — only once the person chose that for a file the trash would not take. */
  remove: async (path: string) => {
    await invoke<void>('remove_file', { path })
    wrote(path)
  },
  /** Appends a suggestion event to this device's event file in the vault. */
  recordEvent: async (event: object) => {
    await invoke<void>('record_event', { event })
    wrote(null)
  },
  /** Every device's event file. */
  listEvents: () => invoke<VaultEntry[]>('list_events'),
  /** Keeps a suggestion shown on this device, outside the vault (see `Presentation`). */
  recordPresentation: (presentation: object) => invoke<void>('record_presentation', { presentation }),
  /** This device's record of the suggestions it has shown for the open vault. */
  readPresentations: () => invoke<string>('read_presentations'),
  /**
   * Saves an export outside the vault, where the person picks in the save dialog the shell opens.
   * Resolves to the chosen file's name, or null when the dialog was closed.
   */
  exportFile: (name: string, content: string, filter: string, extension: string) =>
    invoke<string | null>('export_file', { name, content, filter, extension }),
}

/** What changed in the vault outside the app. Paths are relative to the vault, `/`-separated. */
export interface VaultChanged {
  /** Changes were lost: everything shown may be stale. */
  rescan: boolean
  written: string[]
  removed: string[]
}

/** Calls `onChange` whenever something outside the app changes the vault; resolves to the way to stop. */
export function onVaultChanged(onChange: (change: VaultChanged) => void): Promise<UnlistenFn> {
  return listen<VaultChanged>('vault-changed', (e) => onChange(e.payload))
}

/** Calls `onRestarted` when the sidecar is back after it ended during the session: it holds nothing of the vault. */
export function onHostRestarted(onRestarted: () => void): Promise<UnlistenFn> {
  return listen('host-restarted', () => onRestarted())
}

/** Calls `onRefused` with each address the window refused to go to or to open a window for. */
export function onNavigationRefused(onRefused: (address: string) => void): Promise<UnlistenFn> {
  return listen<string>('navigation-refused', (e) => onRefused(e.payload))
}

/**
 * Opens a link the person clicked in the system's browser or mail app. Resolves to false for a link to anything but
 * the web or mail, which is not opened.
 */
export const openLink = (address: string) => invoke<boolean>('open_link', { url: address })

/**
 * The saves of the file a view has open, for an outside change to tell whether one overlapped it. A notice handled
 * while the view was saving, or concluded about a file a save has written since the notice began, is about a file the
 * save has replaced — a removal it reports the save has undone — so the view leaves the screen to the save.
 */
export class Saves {
  private ticks = 0
  private running = 0

  /** Runs `save`, marking it as overlapping every notice handled meanwhile. */
  async run<T>(save: () => Promise<T>): Promise<T> {
    this.ticks++
    this.running++
    try {
      return await save()
    } finally {
      this.running--
      this.ticks++
    }
  }

  /** A mark to take before handling a notice. */
  mark(): number {
    return this.ticks
  }

  /** Whether no save ran since `mark` was taken, and none is running. */
  quietSince(mark: number): boolean {
    return this.running === 0 && this.ticks === mark
  }
}

/**
 * Whether a change removed `path`. When changes were lost there is no list of removals, so the
 * vault's listing as it is now — `listed`, read after the change — decides.
 */
export function removedBy(change: VaultChanged, path: string, listed: readonly string[]): boolean {
  return change.removed.includes(path) || (change.rescan && !listed.includes(path))
}

/** Whether a change touches `path`. */
export function touches(change: VaultChanged, path: string): boolean {
  return change.rescan || change.written.includes(path) || change.removed.includes(path)
}

/** Whether the sidecar is up. */
export type HostStatus = { state: 'starting' } | { state: 'ready' } | { state: 'failed'; message: string }

/** The sidecar, through the shell: the UI never holds its address or token. */
/** What the about dialog shows that only the shell can read. */
export const about = {
  /** The third-party notices shipped beside the app. */
  notices: () => invoke<string>('third_party_notices'),
}

export const host = {
  status: () => invoke<HostStatus>('host_status'),
  ingest: (snapshot: VaultSnapshot) => invoke<IngestResult>('host_ingest', { snapshot }),
  /** A template's table: the rows that match every filter, all of them without. */
  projection: (template: string, filters: ColumnFilter[] = []) => invoke<ProjectionTable>('host_projection', { template, filters }),
  curves: () => invoke<FieldCurve[]>('host_curves'),
  /**
   * Counts of a template's documents matching every filter, per value of the `groupBy` fields — or all as one — each
   * with up to `evidence` of its documents.
   */
  aggregate: (template: string, groupBy: string[] = [], filters: ColumnFilter[] = [], evidence?: number, sum?: string) =>
    invoke<AggregateAnswer>('host_aggregate', { request: { template, groupBy, filters, evidence, sum } }),
  /**
   * `document` is the draft's vault path once it has been saved; a rejection there is not offered again. `typed` is what
   * the person has typed into the field so far: only a value that begins with it is offered.
   */
  /**
   * `roll`: a number drawn uniformly from [0, 1) for this field of the open draft, before any answer was seen — the same
   * each time the field is asked about. Below the sidecar's rate, a value the field would be shown is held back (`check`).
   */
  suggest: (template: string, field: string, values: Record<string, unknown>, document?: string, typed?: string, roll?: number) =>
    invoke<Suggestion>('host_suggest', { request: { template, field, values, document, typed, roll } }),
  /** Documents whose values hold these words, best first — of one template when named. */
  search: (query: string, template?: string) => invoke<CaseHit[]>('host_search', { request: { query, template } }),
  /** The documents of the same template most like the one at `path`, best first. */
  similar: (path: string) => invoke<CaseHit[]>('host_similar', { request: { path } }),
}

/** A blank form the person handed the chat that writes templates: the file's name and its text as Markdown. */
export interface ChatSource {
  name: string
  markdown: string
}

/** Why a picked file could not be read (the sidecar's `SourceFiles`). */
export type SourceFileFailure = 'unsupported' | 'unreadable' | 'empty' | 'too-long'

/** A picked file as Markdown, or why not. */
export interface SourceFileReply {
  ok: boolean
  name: string | null
  markdown: string | null
  failure: SourceFileFailure | null
}

/** Why a model endpoint did not answer, for the app to say in its own words (the sidecar's `ModelFailure`). */
export type ModelFailure =
  | 'invalid'
  | 'unauthorized'
  | 'http-status'
  | 'timeout'
  | 'refused'
  | 'host-not-found'
  | 'unreachable'
  | 'transport'
  | 'not-downloaded'
  | 'not-started'

/** Whether a model endpoint answered, and the models it lists; or why not — never the endpoint's own words. */
export interface ModelProbeResult {
  ok: boolean
  failure: ModelFailure | null
  /** The HTTP status it answered with, when it answered one. */
  statusCode: number | null
  modelIds: string[]
}

/** A model Lowline can run on this computer: its LMSupply alias, its name, how much it takes to get, and whether it is here. */
export interface LocalModel {
  id: string
  name: string
  sizeBytes: number
  downloaded: boolean
  recommended: boolean
}

/** Where getting a model ready on this computer stands. */
export interface LocalModelProgress {
  model: string | null
  phase: 'idle' | 'getting' | 'starting' | 'ready' | 'failed'
  /** While `getting`: what is being fetched — the model, or the runtime that runs it. */
  getting: 'model' | 'runtime' | null
  received: number | null
  total: number | null
  failure: ModelFailure | null
}

export interface LocalModels {
  models: LocalModel[]
  progress: LocalModelProgress
}

/** One turn of the chat beside a template. */
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

/** The model's reply to the chat; or why there is none — never the provider's own words. */
export interface ChatReply {
  ok: boolean
  text: string | null
  failure: ModelFailure | null
  statusCode: number | null
}

/**
 * Model endpoints and their keys. A key is kept in the system's credential store by the shell, under the provider it
 * is for: the window hands it over once and only ever learns whether one is kept.
 */
export const model = {
  /** Checks an endpoint — an IronProw preset, its address when not the preset's own — with the key kept for `provider`. */
  probe: (preset: string, baseUrl: string | undefined, provider: string) =>
    invoke<ModelProbeResult>('host_model_probe', { preset, baseUrl, provider }),
  keyKept: (provider: string) => invoke<boolean>('model_key_kept', { provider }),
  keepKey: (provider: string, key: string) => invoke<void>('keep_model_key', { provider, key }),
  forgetKey: (provider: string) => invoke<void>('forget_model_key', { provider }),
  /** The models Lowline can run on this computer, and where getting one ready stands. */
  local: () => invoke<LocalModels>('host_local_models'),
  /** Starts getting a model ready on this computer, fetching what is not here; `local` follows it. */
  prepareLocal: (id: string) => invoke<LocalModelProgress>('host_local_prepare', { model: id }),
  /** A reply about `template` — its source as it stands — to the conversation, by the model set up, with the key kept for its preset. */
  author: (setting: { preset: string; baseUrl: string | null; model: string }, template: string, turns: ChatTurn[], source?: ChatSource | null) =>
    invoke<ChatReply>('host_chat_author', { request: { ...setting, template, turns, source: source ?? null } }),
  /** A blank form — an HWP, HWPX, PDF, Word or Excel file at `path` — read into Markdown on this computer, for `author` to start from. */
  sourceFile: (path: string) => invoke<SourceFileReply>('host_source_file', { path }),
  /**
   * What the model set up says to count for `question` about `template`'s documents — its reply, to be checked by the app —
   * told what the documents its fields refer to are counted by (`referred`) and which templates' documents refer to its
   * own (`referring`), by names and choices only.
   */
  query: (
    setting: { preset: string; baseUrl: string | null; model: string },
    template: string,
    question: string,
    referred: { name: string; type: string; options: string[] }[] = [],
    referring: { name: string; via: string[]; columns: { name: string; type: string; options: string[] }[] }[] = [],
  ) => invoke<ChatReply>('host_chat_query', { request: { ...setting, template, question, referred, referring } }),
  /** The records the model set up reads out of `text`, as values of `template`'s fields — its reply, to be read by the app. */
  extract: (setting: { preset: string; baseUrl: string | null; model: string }, template: string, text: string) =>
    invoke<ChatReply>('host_chat_extract', { request: { ...setting, template, text } }),
}
