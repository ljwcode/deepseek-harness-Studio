
/**
 * Desktop IApiClient carrier. Physical transport is the restricted preload
 * bridge (`window.dshDesktop`); every protocol invariant — rpcId minting,
 * envelope parsing, zod payload validation, SSE framing — remains in
 * AbstractApiClient. This subclass only replaces `doFetch` and adds the
 * generic logical-RPC caller used by the Typert gateway (`/api` intercepts).
 */

import type { RpcResult, RpcId, ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId as mintRpcId, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from './api.ts'
import type { DesktopBridge } from './desktop-bridge.ts'
import { DesktopTransportError, type DesktopFetchReady, type DesktopIpcEvent } from '../protocol.ts'

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface StreamState {
  controller: ReadableStreamDefaultController<Uint8Array> | undefined
  readyReject: ((error: Error) => void) | undefined
  readonly queue: Uint8Array[]
  error: Error | undefined
  closed: boolean
}

interface FetchReady extends DesktopFetchReady {
  status: number
  statusText: string
  headers: Record<string, string>
  hasBody: boolean
}

function isFetchReady(value: unknown): value is FetchReady {
  if (typeof value !== 'object' || value === null) return false
  const ready = value as Record<string, unknown>
  return typeof ready.status === 'number'
    && typeof ready.statusText === 'string'
    && typeof ready.headers === 'object' && ready.headers !== null
    && Object.values(ready.headers as Record<string, unknown>).every(header => typeof header === 'string')
    && typeof ready.hasBody === 'boolean'
}

/** Normalize whatever origin the shell has (file:// included) onto the
 *  fixed internal authority the host-side IPC validator expects. */
function normalizeTransportUrl(input: URL): string {
  const normalized = new URL(input.pathname + input.search, 'http://dsh.internal')
  return normalized.toString()
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}

/** IPC carrier subclass consumed by the desktop connection plugin. */
export class DesktopApiClient extends AbstractApiClient {
  private readonly streams = new Map<string, StreamState>()
  private readonly unsubscribe: () => void
  private readonly bridge: DesktopBridge

  constructor(bridge: DesktopBridge, timeoutMs?: number) {
    super(timeoutMs)
    this.bridge = bridge
    this.unsubscribe = bridge.subscribe((event) => { this.handleEvent(event) })
  }

  /** Release the bridge subscription (host-app teardown, not used by the plugin fiber). */
  close(): void {
    this.unsubscribe()
    const error = new DesktopTransportError('transport-closed', 'desktop connection closed')
    for (const state of this.streams.values()) {
      state.error = error
      state.closed = true
      state.readyReject?.(error)
      state.controller?.error(error)
    }
    this.streams.clear()
  }

  /** Generic logical RPC caller over the same IPC carrier (Typert `/api` intercepts). */
  readonly rpc = {
    call: async (
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<RpcResult<unknown>> => {
      assertTarget(channel, endpoint)
      const rpcId = mintRpcId(crypto.randomUUID())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      this.onEnvelope(message)
      const response = await this.doFetch(new URL(`${channel}/${endpoint}`, this.resolveBase()), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const full = serverResponseSchema.parse(await response.json())
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const fetchId = crypto.randomUUID()
    const state: StreamState = { controller: undefined, readyReject: undefined, queue: [], error: undefined, closed: false }
    this.streams.set(fetchId, state)
    const signal = init?.signal ?? undefined
    const activeSignal = signal ?? new AbortController().signal

    const fail = (error: Error): void => {
      if (state.closed) return
      state.closed = true
      state.error = error
      state.readyReject?.(error)
      if (state.controller === undefined) return
      state.controller.error(error)
    }
    const onAbort = (): void => {
      this.streams.delete(fetchId)
      void this.bridge.request({ kind: 'fetch-abort', fetchId }).catch(() => undefined)
      fail(abortError(activeSignal))
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    if (activeSignal.aborted) {
      onAbort()
      return Promise.reject(state.error ?? new Error('desktop fetch aborted'))
    }

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        state.controller = controller
        if (state.error !== undefined) {
          controller.error(state.error)
          return
        }
        for (const chunk of state.queue) controller.enqueue(chunk)
        state.queue.length = 0
        if (state.closed) controller.close()
      },
    })

    const headers: Record<string, string> = {}
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => { headers[key] = value })
    }
    const method = init?.method ?? 'GET'
    const requestBody = typeof init?.body === 'string' ? init.body : undefined

    return new Promise<unknown>((resolveReady, rejectReady) => {
      state.readyReject = rejectReady
      void this.bridge.request({
        kind: 'fetch',
        fetchId,
        url: normalizeTransportUrl(input),
        init: { method, headers, ...requestBody === undefined ? {} : { body: requestBody } },
      }).then(
        (value) => {
          state.readyReject = undefined
          resolveReady(value)
        },
        (error: unknown) => {
          state.readyReject = undefined
          rejectReady(error instanceof Error ? error : new Error(String(error)))
        },
      )
    }).then((value) => {
      if (!isFetchReady(value)) {
        const error = new DesktopTransportError('protocol-error', 'desktop connection: invalid fetch readiness payload from preload bridge')
        fail(error)
        throw error
      }
      if (state.closed) throw state.error ?? abortError(activeSignal)
      signal?.removeEventListener('abort', onAbort)
      return new Response(value.hasBody ? body : null, {
        status: value.status,
        statusText: value.statusText,
        headers: value.headers,
      })
    }, (error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    })
  }

  private handleEvent(event: DesktopIpcEvent): void {
    const state = this.streams.get(event.fetchId)
    if (state === undefined) return
    if (event.kind === 'fetch-data') {
      if (state.closed) return
      const binary = atob(event.data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      if (state.controller === undefined) {
        state.queue.push(bytes)
      } else {
        state.controller.enqueue(bytes)
      }
      return
    }
    if (event.kind === 'fetch-end') {
      this.streams.delete(event.fetchId)
      if (state.closed) return
      state.closed = true
      if (state.controller === undefined) return
      state.controller.close()
      return
    }
    this.streams.delete(event.fetchId)
    const error = new Error(`${event.error.code}: ${event.error.message}`)
    if (state.closed) return
    state.closed = true
    state.error = error
    state.controller?.error(error)
  }
}

function assertTarget(channel: string, endpoint: string): void {
  if (!CHANNEL_PATTERN.test(channel)
    || endpoint.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}

/** Re-exported for the client plugin and tests. */
export type { RpcId }
