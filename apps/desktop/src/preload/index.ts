/**
 * The only renderer-facing Electron surface. `nodeIntegration` and Node APIs
 * stay off; every message crosses `ipcRenderer.invoke('dsh:request', ...)`
 * through main's schema-validated channel.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopHostRequest,
  DesktopIpcEvent,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'

export interface DshDesktopApi {
  bootstrap(): Promise<unknown>
  request(message: DesktopHostRequest): Promise<unknown>
  respond(message: DesktopHostRequest): Promise<unknown>
  subscribe(listener: (event: DesktopIpcEvent | { kind: 'harness-state'; state: string }) => void): () => void
  platform(): NodeJS.Platform
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
}

const api: DshDesktopApi = Object.freeze({
  bootstrap: () => ipcRenderer.invoke('dsh:request', { kind: 'bootstrap' }),
  request: (message: DesktopHostRequest) => ipcRenderer.invoke('dsh:request', message),
  respond: (message: DesktopHostRequest) => ipcRenderer.invoke('dsh:request', message),
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
