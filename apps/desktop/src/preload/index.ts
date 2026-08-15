/**
 * The only renderer-facing Electron surface. `nodeIntegration` and Node APIs
 * stay off; every message crosses `ipcRenderer.invoke('dsh:request', ...)`
 * through main's schema-validated desktop envelope. The preload mints one
 * rendererId per boot and caches the host generation learned from bootstrap;
 * a reload therefore gets a fresh identity and cannot emit stale frames.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_PROTOCOL_VERSION,
  type DesktopBootstrap,
  type DesktopHostRequest,
  type DesktopIpcEvent,
  type DesktopRequestFrame,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'

export interface DshDesktopApi {
  readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  readonly rendererId: string
  bootstrap(): Promise<DesktopBootstrap>
  request(message: DesktopHostRequest): Promise<unknown>
  respond(message: DesktopHostRequest): Promise<unknown>
  subscribe(listener: (event: DesktopIpcEvent | { kind: 'harness-state'; state: string }) => void): () => void
  platform(): NodeJS.Platform
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
}

const rendererId = crypto.randomUUID()
let hostGeneration: number | undefined

function assertBootstrapped(message: DesktopHostRequest): number {
  if (message.kind === 'bootstrap') return hostGeneration ?? 0
  if (hostGeneration === undefined) {
    throw new Error('desktop preload: bootstrap must complete before any other desktop request')
  }
  return hostGeneration
}

async function invoke(message: DesktopHostRequest): Promise<unknown> {
  const frame: DesktopRequestFrame = {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    rendererId,
    hostGeneration: assertBootstrapped(message),
    message,
  }
  return ipcRenderer.invoke('dsh:request', frame)
}

const api: DshDesktopApi = Object.freeze({
  protocolVersion: DESKTOP_PROTOCOL_VERSION,
  rendererId,
  bootstrap: async () => {
    const raw = await invoke({ kind: 'bootstrap' })
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('desktop preload: invalid bootstrap frame from Electron main')
    }
    const value = raw as Record<string, unknown>
    if (value.protocolVersion !== DESKTOP_PROTOCOL_VERSION
      || typeof value.hostGeneration !== 'number'
      || !Number.isSafeInteger(value.hostGeneration)
      || value.hostGeneration < 0) {
      throw new Error('desktop preload: invalid bootstrap frame from Electron main')
    }
    const bootstrap = value as unknown as DesktopBootstrap
    hostGeneration = bootstrap.hostGeneration
    return bootstrap
  },
  request: (message: DesktopHostRequest) => invoke(message),
  respond: (message: DesktopHostRequest) => invoke(message),
  subscribe: (listener: (event: DesktopIpcEvent | { kind: 'harness-state'; state: string }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopIpcEvent | { kind: 'harness-state'; state: string }): void => {
      listener(payload)
    }
    ipcRenderer.on('dsh:event', wrapped)
    return () => {
      ipcRenderer.removeListener('dsh:event', wrapped)
    }
  },
  platform: () => process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('dsh:openExternal', url) as Promise<void>,
  showItemInFolder: (path: string) => ipcRenderer.invoke('dsh:showItemInFolder', path) as Promise<void>,
})

contextBridge.exposeInMainWorld('dshDesktop', api)
