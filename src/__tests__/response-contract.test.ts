// What the sidecar answers, as the sidecar's own test wrote it from its real endpoints, read against the UI's
// types: the shell passes the answers through untouched and the types vanish at run time, so a field the sidecar
// renames would read as empty here without a word. Each type's keys are listed below in a shape the compiler holds
// to the type — every key, nothing more, optional exactly where the type says — and the file has to match it both
// ways: nothing the UI does not know, nothing it needs missing, and every key carried at least once.
import { describe, expect, it } from 'vitest'
import type { AggregateAnswer, Abstention, CaseHit, FieldCurve, IngestResult, ProjectionTable, Suggestion } from '../projection.js'
import type { ChatReply, LocalModelProgress, LocalModels, ModelFailure, ModelProbeResult, SourceFileFailure, SourceFileReply } from '../vault-client.js'
import file from './sidecar-responses.json'

type Item<V> = V extends readonly (infer E)[] ? E : V
type Presence<T, K extends keyof T> = {} extends Pick<T, K> ? 'optional' : 'required'
/** What the UI reads inside a value: nothing for a leaf, any keys for a map, else the keys of the object (or of each item). */
type Inside<V> = [Item<NonNullable<V>>] extends [infer E] ? ([E] extends [object] ? (string extends keyof E ? 'any keys' : Shape<E>) : null) : never
type Field<T, K extends keyof T> = Inside<T[K]> extends null ? Presence<T, K> : { presence: Presence<T, K>; inside: Inside<T[K]> }
type Shape<T> = { readonly [K in keyof T]-?: Field<T, K> }

const ingest: Shape<IngestResult> = {
  appended: 'required',
  retired: 'required',
  projections: 'required',
  skipped: { presence: 'required', inside: { path: 'required', reason: 'required' } },
  skippedFields: { presence: 'required', inside: { template: 'required', path: 'required', field: 'required', reason: 'required' } },
}

const projection: Shape<ProjectionTable> = {
  template: 'required',
  columns: { presence: 'required', inside: { name: 'required', type: 'required' } },
  rows: { presence: 'required', inside: { path: 'required', values: { presence: 'required', inside: 'any keys' } } },
}

const curve: Shape<FieldCurve> = {
  template: 'required',
  field: 'required',
  accepted: 'required',
  corrected: 'required',
  rejected: 'required',
  points: { presence: 'required', inside: { n: 'required', at: 'required', rate: 'required' } },
  bySource: { presence: 'optional', inside: { source: 'required', decided: 'required', accepted: 'required' } },
  replay: {
    presence: 'optional',
    inside: {
      threshold: 'required',
      precision: 'required',
      promise: 'required',
      promiseAnswered: 'required',
      promiseOver: 'required',
      answerRate: 'required',
      answered: 'required',
      lookups: 'required',
      dependsOn: 'optional',
    },
  },
  whyNoReplay: 'optional',
  coarse: {
    presence: 'optional',
    inside: {
      threshold: 'required',
      precision: 'required',
      promise: 'required',
      promiseAnswered: 'required',
      promiseOver: 'required',
      answerRate: 'required',
      answered: 'required',
      lookups: 'required',
    },
  },
  closest: {
    presence: 'optional',
    inside: { precision: 'required', answerRate: 'required', answered: 'required', lookups: 'required', target: 'required' },
  },
  rechoosing: 'required',
  counting: { presence: 'optional', inside: { counting: 'required', checks: 'required', countOnFrom: 'required', rate: 'required' } },
  similar: {
    presence: 'optional',
    inside: {
      threshold: 'required',
      precision: 'required',
      promise: 'required',
      promiseAnswered: 'required',
      promiseOver: 'required',
      answerRate: 'required',
      answered: 'required',
      lookups: 'required',
      offered: 'required',
      offeredFrom: 'required',
    },
  },
  typing: {
    presence: 'optional',
    inside: {
      characters: 'required',
      threshold: 'required',
      precision: 'required',
      answerRate: 'required',
      answered: 'required',
      lookups: 'required',
    },
  },
}

const suggestion: Shape<Suggestion> = {
  value: 'required',
  mode: 'required',
  source: 'required',
  reason: 'optional',
  probability: 'optional',
  held: 'optional',
}

const hit: Shape<CaseHit> = { path: 'required', template: 'required', text: 'required', conflicted: 'required', score: 'required' }

const probe: Shape<ModelProbeResult> = { ok: 'required', failure: 'required', statusCode: 'required', modelIds: 'required' }

const chat: Shape<ChatReply> = { ok: 'required', text: 'required', failure: 'required', statusCode: 'required' }

const sourceFile: Shape<SourceFileReply> = { ok: 'required', name: 'required', markdown: 'required', failure: 'required' }

const localProgress: Shape<LocalModelProgress> = {
  model: 'required',
  phase: 'required',
  getting: 'required',
  received: 'required',
  total: 'required',
  failure: 'required',
}

const localModels: Shape<LocalModels> = {
  models: { presence: 'required', inside: { id: 'required', name: 'required', sizeBytes: 'required', downloaded: 'required', recommended: 'required' } },
  progress: { presence: 'required', inside: localProgress },
}

const aggregate: Shape<AggregateAnswer> = {
  template: 'required',
  groupBy: 'required',
  groups: {
    presence: 'required',
    inside: {
      key: { presence: 'required', inside: 'any keys' },
      count: 'required',
      evidence: 'required',
      sum: { presence: 'required', inside: { total: 'required', counted: 'required' } },
    },
  },
  sum: 'required',
}

/** Each answer in the file, and the shape the UI reads it by. */
const answers = {
  ingest,
  projection,
  curves: curve,
  suggestions: suggestion,
  search: hit,
  similar: hit,
  aggregate,
  probe,
  chatAuthor: chat,
  chatExtract: chat,
  sourceFile,
  localModels,
  localPrepare: localProgress,
}

/** The words the UI branches on — every one its types allow, as the compiler holds them to. */
const words = {
  // `proposed` is the app's own — a value read from the document — and never the sidecar's.
  mode: { key: true, coarse: true, memory: true, abstain: true, rejected: true, check: true } satisfies Record<Exclude<Suggestion['mode'], 'proposed'>, true>,
  reason: { 'no-history': true, 'below-target': true, undecided: true } satisfies Record<Abstention, true>,
  whyNoReplay: { few: true, pending: true, 'below-target': true } satisfies Record<NonNullable<FieldCurve['whyNoReplay']>, true>,
  counting: { settled: true, unprompted: true } satisfies Record<NonNullable<FieldCurve['counting']>['counting'], true>,
  probeFailure: {
    invalid: true,
    unauthorized: true,
    'http-status': true,
    timeout: true,
    refused: true,
    'host-not-found': true,
    unreachable: true,
    transport: true,
    'not-downloaded': true,
    'not-started': true,
  } satisfies Record<ModelFailure, true>,
  localPhase: { idle: true, getting: true, starting: true, ready: true, failed: true } satisfies Record<LocalModelProgress['phase'], true>,
  localGetting: { model: true, runtime: true } satisfies Record<NonNullable<LocalModelProgress['getting']>, true>,
  sourceFailure: { unsupported: true, unreadable: true, empty: true, 'too-long': true } satisfies Record<SourceFileFailure, true>,
}

type AnyShape = Record<string, string | { presence: string; inside: AnyShape | 'any keys' }>

/** Where `value` strays from `shape`; `carried` gathers each key, by its place in the types, found with a value. */
function strays(value: unknown, shape: AnyShape | 'any keys', at: string, place: string, carried: Set<string>): string[] {
  if (shape === 'any keys') return []
  if (Array.isArray(value)) return value.flatMap((item, i) => strays(item, shape, `${at}[${i}]`, place, carried))
  if (typeof value !== 'object' || value === null) return [`${at}: not an object`]
  const found = value as Record<string, unknown>
  const problems = Object.keys(found)
    .filter((key) => !(key in shape))
    .map((key) => `${at}.${key}: sent, and the UI's types do not have it`)
  for (const [key, field] of Object.entries(shape)) {
    const presence = typeof field === 'string' ? field : field.presence
    if (!(key in found)) {
      if (presence === 'required') problems.push(`${at}.${key}: the UI's types need it, and it is not sent`)
      continue
    }
    if (found[key] === null || found[key] === undefined) continue
    carried.add(`${place}.${key}`)
    if (typeof field !== 'string') problems.push(...strays(found[key], field.inside, `${at}.${key}`, `${place}.${key}`, carried))
  }
  return problems
}

/** Every key of `shape`, by its place in the types. */
function places(shape: AnyShape | 'any keys', place: string): string[] {
  if (shape === 'any keys') return []
  return Object.entries(shape).flatMap(([key, field]) => [
    `${place}.${key}`,
    ...(typeof field === 'string' ? [] : places(field.inside, `${place}.${key}`)),
  ])
}

const sent: Record<string, unknown> = file

describe("the sidecar's answers", () => {
  it('are what the UI reads them as, every key of them carried', () => {
    const carried = new Set<string>()
    const problems = Object.entries(answers as Record<string, AnyShape>).flatMap(([name, shape]) =>
      name in sent ? strays(sent[name], shape, name, name, carried) : [`${name}: not in the file`],
    )
    expect(problems).toEqual([])
    const never = Object.entries(answers as Record<string, AnyShape>).flatMap(([name, shape]) => places(shape, name)).filter((p) => !carried.has(p))
    expect(never, 'keys the file never carries with a value — extend the sidecar test so it does').toEqual([])
  })

  it('use only the words the UI branches on, and every one of them', () => {
    const said = sent.words as Record<keyof typeof words, string[]>
    for (const [name, known] of Object.entries(words)) expect([...said[name as keyof typeof words]].sort(), name).toEqual(Object.keys(known).sort())
    const suggestions = sent.suggestions as Suggestion[]
    const curves = sent.curves as FieldCurve[]
    expect(suggestions.every((s) => s.mode in words.mode && (s.reason == null || s.reason in words.reason))).toBe(true)
    expect(curves.every((c) => c.whyNoReplay == null || c.whyNoReplay in words.whyNoReplay)).toBe(true)
  })
})
