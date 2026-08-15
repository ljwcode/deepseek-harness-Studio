/**
 * DSH Studio Electron main. Owns application/window lifecycle and the
 * Harness process; renderer and Harness communicate only through the
 * validated desktop IPC bridge (`dsh:request` / `dsh:event`).
 */

import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_PROTOCOL_VERSION,
  DesktopTransportError,
  parseDesktopRequestFrame,
  type DesktopBootstrap,
  type DesktopIpcEvent,
  type DesktopRequestFrame,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { HarnessProcessManager, type HarnessState } from './harness-process.ts'
import { WindowManager } from './window-manager.ts'

let harness: HarnessProcessManager | undefined
let windows: WindowManager | undefined
let bootStarted = false
let quitAfterHarnessStop = false

const rendererByWebContents = new Map<number, string>()
const webContentsByRenderer = new Map<string, number>()
const fetchIdsByRenderer = new Map<string, Set<string>>()
const rendererByFetch = new Map<string, string>()

function harnessStatePayload(state: HarnessState): { kind: 'harness-state'; state: HarnessState } {
  return { kind: 'harness-state', state }
}

function activeHarness(): HarnessProcessManager {
  if (harness === undefined) throw new DesktopTransportError('host-unavailable', 'desktop harness is not initialized')
  return harness
}

function assertRendererIdentity(sender: IpcMainInvokeEvent, frame: DesktopRequestFrame): void {
  const previous = rendererByWebContents.get(sender.sender.id)
  if (previous !== undefined && previous !== frame.rendererId) {
    disposeRenderer(previous)
  }
  if (previous !== frame.rendererId) {
    const owner = webContentsByRenderer.get(frame.rendererId)
    if (owner !== undefined && owner !== sender.sender.id) {
      throw new DesktopTransportError('protocol-error', `desktop rendererId ${frame.rendererId} is already owned by webContents ${owner}`)
    }
    rendererByWebContents.set(sender.sender.id, frame.rendererId)
    webContentsByRenderer.set(frame.rendererId, sender.sender.id)
  }
}

function assertHostGeneration(frame: DesktopRequestFrame): void {
  const manager = activeHarness()
  if (frame.hostGeneration === manager.hostGeneration) return
  if (frame.message.kind === 'bootstrap' && frame.hostGeneration === 0) return
  throw new DesktopTransportError(
    'host-restarting',
    `desktop frame hostGeneration ${frame.hostGeneration} is stale; current generation is ${manager.hostGeneration}`,
  )
}

function recordFetch(rendererId: string, fetchId: string): void {
  const ids = fetchIdsByRenderer.get(rendererId) ?? new Set<string>()
  ids.add(fetchId)
  fetchIdsByRenderer.set(rendererId, ids)
  rendererByFetch.set(fetchId, rendererId)
}

function forgetFetch(fetchId: string): void {
  const rendererId = rendererByFetch.get(fetchId)
  if (rendererId !== undefined) {
    fetchIdsByRenderer.get(rendererId)?.delete(fetchId)
    rendererByFetch.delete(fetchId)
  }
}

function disposeRendererByWebContents(webContentsId: number): void {
  const rendererId = rendererByWebContents.get(webContentsId)
  if (rendererId !== undefined) disposeRenderer(rendererId)
}

function disposeRenderer(rendererId: string): void {
  const manager = harness
  const fetchIds = [...fetchIdsByRenderer.get(rendererId) ?? []]
  if (manager !== undefined) {
    for (const fetchId of fetchIds) {
      void manager.request({ kind: 'fetch-abort', fetchId }, { rendererId }).catch(() => undefined)
    }
    manager.abortRenderer(rendererId, new DesktopTransportError('request-aborted', `desktop renderer ${rendererId} disconnected`))
  }
  for (const fetchId of fetchIds) forgetFetch(fetchId)
  const webContentsId = webContentsByRenderer.get(rendererId)
  if (webContentsId !== undefined && rendererByWebContents.get(webContentsId) === rendererId) {
    rendererByWebContents.delete(webContentsId)
  }
  webContentsByRenderer.delete(rendererId)
  fetchIdsByRenderer.delete(rendererId)
}

function registerIpc(): void {
  ipcMain.handle('dsh:request', async (event, raw: unknown) => {
    const parsed = parseDesktopRequestFrame(raw)
    if (!parsed.ok) throw new DesktopTransportError('protocol-error', parsed.error)
    const frame = parsed.value
    const manager = activeHarness()
    assertRendererIdentity(event, frame)
    assertHostGeneration(frame)
    if (frame.message.kind === 'fetch') recordFetch(frame.rendererId, frame.message.fetchId)
    if (frame.message.kind === 'fetch-abort') {
      try {
        return await manager.request(frame.message, { rendererId: frame.rendererId })
      } finally {
        forgetFetch(frame.message.fetchId)
      }
    }
    const value = await manager.request(frame.message, { rendererId: frame.rendererId })
    if (frame.message.kind === 'bootstrap') {
      if (typeof value !== 'object' || value === null) {
        throw new DesktopTransportError('protocol-error', 'desktop bootstrap returned a non-object payload')
      }
      const bootstrap = value as Partial<DesktopBootstrap>
      if (bootstrap.graph === undefined || typeof bootstrap.pid !== 'number' || typeof bootstrap.harnessVersion !== 'string') {
        throw new DesktopTransportError('protocol-error', 'desktop bootstrap is missing graph, pid, or harnessVersion')
      }
      return {
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        hostGeneration: manager.hostGeneration,
        graph: bootstrap.graph,
        host: bootstrap.host,
        pid: bootstrap.pid,
        harnessVersion: bootstrap.harnessVersion,
      } satisfies DesktopBootstrap
    }
    return value
  })
  ipcMain.handle('dsh:openExternal', async (_event, raw: unknown) => {
    if (typeof raw !== 'string') throw new Error('openExternal requires a URL string')
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http/https URLs may be opened externally')
    await shell.openExternal(url.toString())
  })
  ipcMain.handle('dsh:showItemInFolder', (_event, raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('showItemInFolder requires a path string')
    shell.showItemInFolder(raw)
  })
}

function handleHarnessEvent(event: DesktopIpcEvent): void {
  if (event.kind === 'fetch-end' || event.kind === 'fetch-error') forgetFetch(event.fetchId)
  windows?.broadcastEvent(event)
}

function boot(): void {
  if (bootStarted) return
  bootStarted = true
  const manager = new HarnessProcessManager()
  harness = manager
  manager.on('state', (state: HarnessState) => {
    console.log(`[desktop] harness ${state}`)
    windows?.broadcast('dsh:event', harnessStatePayload(state))
  })
  manager.on('event', (event: unknown) => { handleHarnessEvent(event as DesktopIpcEvent) })
  registerIpc()
  windows = new WindowManager()
  windows.on('renderer-disposed', (webContentsId: number) => { disposeRendererByWebContents(webContentsId) })
  windows.create()
  manager.start()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = windows
    if (window !== undefined && !window.isDestroyed) {
      const browserWindow = window.create()
      if (browserWindow.isMinimized()) browserWindow.restore()
      browserWindow.focus()
    }
  })

  app.whenReady().then(() => {
    boot()
    app.on('activate', () => {
      if (windows?.isDestroyed ?? false) windows?.create()
    })
  }).catch((error: unknown) => {
    console.error('[desktop] failed to start', error)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    const manager = harness
    if (manager === undefined || manager.desired === 'stopped' || manager.state === 'stopping' || manager.state === 'stopped') return
    event.preventDefault()
    if (quitAfterHarnessStop) return
    quitAfterHarnessStop = true
    void manager.stop().finally(() => {
      quitAfterHarnessStop = false
      app.quit()
    })
  })

  app.on('quit', () => {
    const manager = harness
    if (manager !== undefined && manager.state !== 'stopped') {
      void manager.stop()
    }
  })
}
