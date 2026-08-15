import type { DesktopHostRequest, DesktopIpcEvent } from '@deepseek-ai/dsh-client-connection-desktop/protocol'

declare global {
  interface Window {
    dshDesktop: {
      bootstrap(): Promise<unknown>
      request(message: DesktopHostRequest): Promise<unknown>
      respond(message: DesktopHostRequest): Promise<unknown>
      subscribe(listener: (event: DesktopIpcEvent | { kind: 'harness-state'; state: string }) => void): () => void
      platform(): NodeJS.Platform
      openExternal(url: string): Promise<void>
      showItemInFolder(path: string): Promise<void>
    }
  }
}

export {}
