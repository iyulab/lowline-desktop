import { describe, expect, it } from 'vitest'
import {
  LOCAL_PRESET,
  MODEL_PRESETS,
  destinationText,
  failureText,
  localModelLabel,
  localProgressText,
  modelLabel,
  presetOf,
} from '../model-settings.ts'
import type { LocalModelProgress, ModelFailure } from '../vault-client.ts'

describe('model settings', () => {
  it('offer this computer first, then servers on the person’s own computers, and say who receives what is sent otherwise', () => {
    expect(MODEL_PRESETS[0].id).toBe(LOCAL_PRESET)
    const outside = MODEL_PRESETS.map((p) => p.outside !== null)
    expect(outside.indexOf(true)).toBeGreaterThan(outside.lastIndexOf(false))
    expect(destinationText(presetOf('anthropic')!)).toContain('Anthropic')
    expect(destinationText(presetOf('ollama')!)).not.toContain('Anthropic')
    expect(destinationText(presetOf(LOCAL_PRESET)!)).toContain('밖으로 나가지 않습니다')
  })

  it('ask a company’s service for a key, a server of the person’s own for an address when it has no default, and this computer for neither', () => {
    for (const p of MODEL_PRESETS.filter((p) => p.outside)) expect(p.key).toBe('required')
    expect(presetOf('custom')!.address).toBe('required')
    expect(presetOf('ollama')!.address).toBe('optional')
    expect(presetOf(LOCAL_PRESET)).toMatchObject({ address: 'none', key: 'none' })
  })

  it('word every failure the sidecar can name, and never pass on the endpoint’s own words', () => {
    const failures: ModelFailure[] = [
      'invalid',
      'unauthorized',
      'http-status',
      'timeout',
      'refused',
      'host-not-found',
      'unreachable',
      'transport',
      'not-downloaded',
      'not-started',
    ]
    const texts = failures.map((f) => failureText(f, 404))
    expect(new Set(texts).size).toBe(failures.length)
    expect(failureText('http-status', 404)).toContain('404')
    expect(failureText('http-status', null)).not.toContain('HTTP')
  })

  it('name a model on this computer by where it runs and its tier, under its old id and its new one alike', () => {
    expect(modelLabel({ preset: LOCAL_PRESET, baseUrl: null, model: 'gguf:qwen3-default' })).toBe('이 컴퓨터 · 기본 모델')
    expect(modelLabel({ preset: LOCAL_PRESET, baseUrl: null, model: 'gguf:basic' })).toBe('이 컴퓨터 · 기본 모델')
    expect(localModelLabel('gguf:qwen3-balanced')).toBe(localModelLabel('gguf:balanced'))
    expect(localModelLabel('gguf:qwen3-fast')).toBe('qwen3-fast')
    expect(modelLabel({ preset: 'custom', baseUrl: 'http://x/v1', model: 'large-8b' })).toBe('다른 주소(OpenAI 호환) · large-8b')
  })

  it('say what getting a model ready is doing: what is fetched and how far, starting it, ready', () => {
    const at = (p: Partial<LocalModelProgress>): LocalModelProgress => ({
      model: 'gguf:qwen3-default',
      phase: 'idle',
      getting: null,
      received: null,
      total: null,
      failure: null,
      ...p,
    })
    expect(localProgressText(at({ phase: 'getting', getting: 'model', received: 1_200_000_000, total: 3_000_000_000 }))).toBe(
      '모델을 받는 중 1.2 / 3.0 GB',
    )
    expect(localProgressText(at({ phase: 'getting', getting: 'runtime' }))).toBe('실행 프로그램을 받는 중…')
    expect(localProgressText(at({ phase: 'starting' }))).toContain('켜는 중')
    expect(localProgressText(at({ phase: 'ready' }))).toBe('준비됐습니다.')
    expect(localProgressText(at({ phase: 'idle' }))).toBe('')
  })
})
