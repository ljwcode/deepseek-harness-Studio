
/**
 * Desktop wire client. The preload bridge is the only transport; the plugin
 * provides the same `ctx.connection` handle shape as the Web connection so
 * the existing client runtime and UI tree mount unchanged.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks } from './connection-controller.ts'
import { DesktopApiClient } from './desktop-api-client.ts'
import { desktopBridge } from './desktop-bridge.ts'
/** Observable Host description published by each completed connection handshake. */
/** Generic logical RPC caller over the desktop carrier. */
export interface ClientConnectionRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<import('./api.ts').RpcResult<unknown>>
}

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  getSnapshot(): HostDescription | undefined
  subscribe(listener: () => void): () => void
}

/** The ctx.connection service API (shape-identical to the Web carrier). */
export interface ConnectionHandle {
  readonly api: IApiClient
  readonly isLoopback: boolean
  readonly hostDescription: HostDescriptionSource
  readonly rpc: ClientConnectionRpc
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/** Client plugin body: provide the desktop-backed connection handle. */
export function apply(ctx: Context): void {
  const api = new DesktopApiClient(desktopBridge())
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[desktop-connection] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc: api.rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
