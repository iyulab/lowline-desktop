// How Lowline is set up on this device — kept by the shell in the app's settings, outside any vault. A key for a
// model is not here: the shell keeps it in the system's credential store.

import { invoke } from '@tauri-apps/api/core'

/** The model the chat uses: an IronProw preset, its address when not the preset's own, and the model chosen. */
export interface ModelSettings {
  preset: string
  baseUrl: string | null
  model: string
}

export interface Settings {
  /** Whether to look for a newer release — at start and every twelve hours — and download it in the background. */
  checkForUpdates: boolean
  /** Whether the person has been told, once, what leaves this computer. */
  outboundToldOnce: boolean
  /** The model the chat uses, once the person has set one up. */
  model: ModelSettings | null
}

export const DEFAULT_SETTINGS: Settings = { checkForUpdates: true, outboundToldOnce: false, model: null }

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** A model setting as written, or null when any part of it cannot be used. */
function modelFrom(written: unknown): ModelSettings | null {
  if (typeof written !== 'object' || written === null) return null
  const { preset, baseUrl, model } = written as Record<string, unknown>
  const p = text(preset)
  const m = text(model)
  return p && m ? { preset: p, baseUrl: text(baseUrl), model: m } : null
}

/** The settings as written, over the defaults: a missing or unreadable file, or an unreadable setting, is the default. */
export function settingsFrom(written: string | null): Settings {
  if (!written) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(written) as Record<string, unknown>
    const flag = (key: 'checkForUpdates' | 'outboundToldOnce') =>
      typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : DEFAULT_SETTINGS[key]
    return { checkForUpdates: flag('checkForUpdates'), outboundToldOnce: flag('outboundToldOnce'), model: modelFrom(parsed.model) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * The settings to write: `s` over what the file holds, so a setting this release does not know — one a newer
 * release added, before the person went back to this one — is kept for it rather than dropped.
 */
export function settingsText(s: Settings, written: string | null): string {
  let kept: Record<string, unknown> = {}
  try {
    const parsed: unknown = written ? JSON.parse(written) : null
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) kept = parsed as Record<string, unknown>
  } catch {
    // Unreadable: nothing of it is kept, as nothing of it was read.
  }
  return JSON.stringify({ ...kept, ...s })
}

export const settings = {
  read: async () => settingsFrom(await invoke<string | null>('read_settings')),
  write: async (s: Settings) =>
    invoke<void>('write_settings', { settings: settingsText(s, await invoke<string | null>('read_settings')) }),
}
