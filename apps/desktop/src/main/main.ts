/**
 * DSH Studio Electron main. Owns application/window lifecycle and the
 * Harness process; renderer and Harness communicate only through the
 * validated desktop IPC bridge (`dsh:request` / `dsh:event`).
 */

import { app, ipcMain, shell } from 'electron'
import { parseDesktopHostRequest } from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { HarnessProcessManager, type HarnessState } from './harness-process.ts'
import { WindowManager } from './window-manager.ts'

let harness: HarnessProcessManager | undefined
let windows: WindowManager | undefined
let bootStarted = false

function harnessStatePayload(state: HarnessState): { kind: 'harness-state'; state: HarnessState } {
  return { kind: 'harness-state', state }
}

function registerIpc(): void {
  ipcMain.handle('dsh:request', async (event, raw: unknown) => {
    void event
    const parsed = parseDesktopHostRequest(raw)
    if (!parsed.ok) {
      const error = new Error(parsed.error)
      error.name = 'DesktopIpcValidationError'
      throw error
    }
    if (harness === undefined) throw new Error('desktop harness is not initialized')
    return harness.request(parsed.value)
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

function boot(): void {
  if (bootStarted) return
  bootStarted = true
  harness = new HarnessProcessManager()
  harness.on('state', (state: HarnessState) => {
    console.log(`[desktop] harness ${state}`)
    windows?.broadcast('dsh:event', harnessStatePayload(state))
  })
  harness.on('event', (event: unknown) => windows?.broadcastEvent(event as never))
  registerIpc()
  windows = new WindowManager()
  windows.create()
  harness.start()
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
    if (harness === undefined || harness.state === 'stopped' || harness.state === 'stopping') return
    event.preventDefault()
    void harness.stop().then(() => { app.quit() })
  })

  app.on('quit', () => {
    if (harness !== undefined && harness.state !== 'stopped') {
      void harness.stop()
    }
  })
}
