// What a save records about the suggestions shown: only what was in view when the person decided, and nothing lost when
// recording fails.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldValues } from '../documents.js'
import type { Suggestion, TemplateSnapshot } from '../projection.js'

/** The sidecar's answers, by field, in the order they are asked for; a field with none left abstains. */
const answers = vi.hoisted(() => new Map<string, Suggestion[]>())
/** An answer the test holds back until it says so, by field. */
const held = vi.hoisted(() => new Map<string, Promise<Suggestion>>())
/** Events recorded, and whether the next recording fails. */
const recorded = vi.hoisted(() => ({ events: [] as { field: string; kind: string }[], failNext: false }))

vi.mock('../vault-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vault-client.js')>()
  return {
    ...actual,
    vault: {
      ...actual.vault,
      recordEvent: async (event: { field: string; kind: string }) => {
        if (recorded.failNext) {
          recorded.failNext = false
          throw new Error('disk full')
        }
        recorded.events.push({ field: event.field, kind: event.kind })
      },
      recordPresentation: async () => {},
    },
    host: {
      ...actual.host,
      suggest: async (_template: string, field: string) =>
        held.get(field) ?? answers.get(field)?.shift() ?? ({ value: null, mode: 'abstain', source: null, reason: null } satisfies Suggestion),
    },
  }
})

const { JudgmentController } = await import('../judgment-controller.js')

const template = {
  ref: 't',
  fields: [
    { name: 'kind', label: '분류', type: 'select', options: ['부품', '설정'], multiple: false },
    { name: 'note', label: '메모', type: 'text', options: [], multiple: false },
  ],
  suggest: ['kind'],
  schema: {},
} as unknown as TemplateSnapshot

const suggestion = (value: string): Suggestion => ({ value, mode: 'key', source: '메모: x' })

function setUp() {
  let values: FieldValues = {}
  const controller = new JudgmentController(
    { addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) },
    { draft: () => ({ templateRef: 't', id: 'd1' }), values: () => values, sourceOf: () => '', hasCases: () => false },
  )
  controller.template = template
  const ask = () => (controller as unknown as { suggest(): Promise<void> }).suggest()
  return { controller, ask, set: (next: FieldValues) => (values = next) }
}

beforeEach(() => {
  answers.clear()
  held.clear()
  recorded.events = []
  recorded.failNext = false
})

describe('a suggestion that leaves the screen', () => {
  it('is not corrected by a value entered after asking again found none', async () => {
    const { controller, ask, set } = setUp()
    answers.set('kind', [suggestion('부품')])
    await ask()
    expect(controller.suggestions.get('kind')?.value).toBe('부품')
    // Another field changes; asked again, the sidecar has nothing for it now.
    set({ note: 'y' })
    await ask()
    expect(controller.suggestions.has('kind')).toBe(false)
    set({ note: 'y', kind: '설정' })
    await controller.saved('d1')
    expect(recorded.events).toEqual([])
  })

  it('is corrected when the person picks another value while asking again is under way', async () => {
    const { controller, ask, set } = setUp()
    answers.set('kind', [suggestion('부품')])
    await ask()
    let answer!: (s: Suggestion) => void
    held.set('kind', new Promise((resolve) => (answer = resolve)))
    set({ note: 'y' })
    const again = ask()
    // Picked with '부품' still in view; the answer that now has none comes after.
    set({ note: 'y', kind: '설정' })
    answer({ value: null, mode: 'abstain', source: null, reason: null })
    await again
    await controller.saved('d1')
    expect(recorded.events).toEqual([{ field: 'kind', kind: 'correct' }])
  })

  it('is still recorded as rejected when asking again fails', async () => {
    const { controller, ask, set } = setUp()
    answers.set('kind', [suggestion('부품')])
    await ask()
    controller.reject('kind')
    held.set('kind', Promise.reject(new Error('sidecar gone')))
    set({ note: 'y' })
    await ask()
    await controller.saved('d1')
    expect(recorded.events).toEqual([{ field: 'kind', kind: 'reject' }])
  })

  it('is corrected when the person picks another value while it is shown', async () => {
    const { controller, ask, set } = setUp()
    answers.set('kind', [suggestion('부품')])
    await ask()
    set({ kind: '설정' })
    await controller.saved('d1')
    expect(recorded.events).toEqual([{ field: 'kind', kind: 'correct' }])
  })
})

describe('recording what a save confirmed', () => {
  it('fails without losing the event: the next save records it', async () => {
    const { controller, ask, set } = setUp()
    answers.set('kind', [suggestion('부품')])
    await ask()
    controller.take('kind')
    set({ kind: '부품' })
    recorded.failNext = true
    await expect(controller.saved('d1')).rejects.toThrow('disk full')
    expect(recorded.events).toEqual([])
    await controller.saved('d1')
    expect(recorded.events).toEqual([{ field: 'kind', kind: 'accept' }])
    // Recorded once: saving again says nothing more.
    await controller.saved('d1')
    expect(recorded.events).toHaveLength(1)
  })
})
