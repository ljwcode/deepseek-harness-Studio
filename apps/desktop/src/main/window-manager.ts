
/** BrowserWindow ownership: one window, recreate after a renderer crash. */

import { EventEmitter } from 'node:events'
import { BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { DesktopIpcEvent } from '@deepseek-ai/dsh-client-connection-desktop/protocol'

const MAIN_DIR = dirname(fileURLToPath(import.meta.url))

export interface WindowManagerOptions {
  preloadPath?: string
  rendererEntry?: string
  showOnReady?: boolean
}

export class WindowManager extends EventEmitter {
  private window: BrowserWindow | undefined
  private readonly preloadPath: string
  private readonly rendererEntry: string
  private readonly showOnReady: boolean
  private readonly disposedWebContents = new Set<number>()

  constructor(options: WindowManagerOptions = {}) {
    super()
    this.preloadPath = options.preloadPath ?? join(MAIN_DIR, '../preload/index.cjs')
    this.rendererEntry = options.rendererEntry ?? join(MAIN_DIR, '../renderer/index.html')
    this.showOnReady = options.showOnReady ?? true
  }

  get isDestroyed(): boolean {
    return this.window === undefined || this.window.isDestroyed()
  }

  create(): BrowserWindow {
    const existing = this.window
    if (existing !== undefined && !existing.isDestroyed()) return existing
    const window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: 'DSH Studio',
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    this.window = window
    // Capture webContents identity while it is alive. `closed` and
    // `render-process-gone` can fire after the webContents object is already
    // destroyed; accessing `window.webContents` in those callbacks throws
    // "Object has been destroyed" and can crash the main process during quit.
    const webContents = window.webContents
    const webContentsId = webContents.id
    window.on('ready-to-show', () => {
      if (this.showOnReady) window.show()
    })
    window.on('closed', () => {
      if (this.window === window) this.window = undefined
      this.disposeRenderer(webContentsId)
    })
    webContents.on('destroyed', () => {
      this.disposeRenderer(webContentsId)
    })
    webContents.on('render-process-gone', (_event, details) => {
      // A renderer crash must never take the Harness process down.
      console.error(`[desktop] renderer process gone: ${details.reason}`)
      this.disposeRenderer(webContentsId)
    })
    webContents.on('console-message', (_event, _level, message) => {
      console.log(`[renderer] ${message}`)
    })
    webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    void window.loadFile(this.rendererEntry)
    return window
  }

  /** Emit one `renderer-disposed` event per webContents lifetime. */
  private disposeRenderer(webContentsId: number): void {
    if (this.disposedWebContents.has(webContentsId)) return
    this.disposedWebContents.add(webContentsId)
    this.emit('renderer-disposed', webContentsId)
  }

  broadcast(channel: string, payload: unknown): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    window.webContents.send(channel, payload)
  }

  broadcastEvent(event: DesktopIpcEvent): void {
    this.broadcast('dsh:event', event)
  }
}
