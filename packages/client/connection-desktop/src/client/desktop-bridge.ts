
import type { DesktopHostRequest, DesktopIpcEvent } from '../protocol.ts'

/**
 * The renderer-visible surface installed by apps/desktop preload as
 * `window.dshDesktop`. The connection plugin only ever sees this narrow face.
 */
export interface DesktopBridge {
  request(message: DesktopHostRequest): Promise<unknown>
  subscribe(listener: (event: DesktopIpcEvent) => void): () => void
}

/** Global window slot carrying the preload-installed desktop bridge. */
export interface DesktopWindow {
  dshDesktop?: DesktopBridge
}

/**
 * Resolve the preload-installed bridge, failing loud outside the Studio shell.
 * @returns the frozen renderer bridge.
 */
export function desktopBridge(): DesktopBridge {
  const bridge = (globalThis as DesktopWindow).dshDesktop
  if (bridge === undefined) {
    throw new Error('desktop connection: window.dshDesktop is missing; run inside the DSH Studio shell')
  }
  return bridge
}
