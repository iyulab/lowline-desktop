// Updates. The shell looks for a newer release and downloads it in the background; the UI says so, and
// the person says whether to install — nothing is installed without them. Whether to look at all is a
// setting of this device (settings.ts), handed to the shell whenever it is read or changed.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Where updating stands (the shell's `UpdateView`). */
export interface UpdateView {
  /** The newer release found, if any. */
  available: string | null
  /** Its installer is downloaded and checked: installing starts at once. */
  ready: boolean
  /** Its download failed; it is tried again later, and the release page has it meanwhile. */
  failed: boolean
}

/** Where every release can be downloaded by hand. */
export const RELEASES_PAGE = 'https://github.com/iyulab/lowline-releases/releases/latest'

export const update = {
  /**
   * Starts updating, or turns looking on or off, and answers where it stands — null when this build looks
   * nowhere (a development build given no place to look).
   */
  watch: (look: boolean) => invoke<UpdateView | null>('watch_updates', { look }),
  status: () => invoke<UpdateView | null>('update_status'),
  /** Installs the newer release, downloading it first if it is not yet, and starts it; on Windows the app ends here. */
  install: () => invoke<void>('install_update'),
  /** Calls `changed` whenever where updating stands changes. */
  onChange: (changed: () => void): Promise<UnlistenFn> => listen('update-changed', () => changed()),
}

/** The newer release to tell of: none while nothing is found, or once the person put this version off. */
export function toTell(view: UpdateView | undefined, putOff: string | undefined): UpdateView | undefined {
  return view?.available && view.available !== putOff ? view : undefined
}
