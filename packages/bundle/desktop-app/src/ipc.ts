
/**
 * Desktop IPC host bridge. Activated only when the Harness process is forked
 * by Electron main (`DSH_DESKTOP_IPC=1` and an IPC channel is present). It
 * exposes exactly the fetch/bundle/bootstrap vocabulary validated on the main
 * side and never opens an HTTP or WebSocket server.
 * @module @deepseek-ai/dsh-desktop-app/ipc
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import {
  ipcError,
  parseDesktopHostRequest,
  type DesktopFetchReady,
  type DesktopIpcError,
  type DesktopIpcEventEnvelope,
  type DesktopIpcRequestEnvelope,
  type DesktopIpcResponseEnvelope,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'

/** Stable Cordis plugin name. */
export const name = 'desktop-ipc'
/** Services required before the IPC bridge may answer requests. */
export const inject = ['apiProxy', 'desktopRuntime', 'loader']

/** The env marker set by the Electron Harness process manager. */
const DESKTOP_IPC_ENV = 'DSH_DESKTOP_IPC'

interface DesktopTransport {
  fetch(request: Request, fallback: { fetch: typeof fetch }): Promise<Response>
}

function canSend(): boolean {
  return typeof process.send === 'function'
}

function send(message: unknown): void {
  if (typeof process.send !== 'function') return
  try {
    process.send(message)
  } catch {
    // The parent exited; the process shutdown path owns teardown from here.
  }
}

function response(requestId: string, ok: boolean, value?: unknown, error?: DesktopIpcError): DesktopIpcResponseEnvelope {
  return {
    kind: 'response',
    requestId,
    ok,
    ...value === undefined ? {} : { value },
    ...error === undefined ? {} : { error },
  }
}

/**
 * Mount the desktop IPC bridge when the process was launched by the desktop
 * shell. The plugin remains inert for ordinary `dsh --profile desktop` runs.
 * @param ctx - plugin context carrying apiProxy and the desktop client graph.
 */
export function apply(ctx: Context): void {
  if (process.env[DESKTOP_IPC_ENV] !== '1' || !canSend()) return
  const runtime = ctx.desktopRuntime
  const fallback = toFetchHandler(ctx.apiProxy)
  const connection = ctx.get('connection') as DesktopTransport | undefined
  const openFetches = new Map<string, AbortController>()

  const sendEvent = (requestId: string, event: DesktopIpcEventEnvelope['event']): void => {
    send({ kind: 'event', requestId, event } satisfies DesktopIpcEventEnvelope)
  }

  type AnswerResult = { value?: unknown } | { error: DesktopIpcError }
  const answer = (requestId: string, handler: () => Promise<AnswerResult> | AnswerResult): void => {
    void Promise.resolve(handler()).then(
      (result) => {
        if ('error' in result) {
          send(response(requestId, false, undefined, result.error))
        } else {
          send(response(requestId, true, result.value))
        }
      },
      (error: unknown) => { send(response(requestId, false, undefined, ipcError('host-request-failed', error))) },
    )
  }

  const handleFetch = async (
    requestId: string,
    fetchId: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<void> => {
    const controller = new AbortController()
    openFetches.set(fetchId, controller)
    try {
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        ...init.body === undefined ? {} : { body: init.body },
        signal: controller.signal,
      })
      const fetched = connection === undefined
        ? fallback.fetch(request)
        : connection.fetch(request, fallback)
      let result: Response
      try {
        result = await fetched
      } catch (error) {
        send(response(requestId, false, undefined, ipcError('fetch-failed', error)))
        return
      }
      const ready: DesktopFetchReady = {
        status: result.status,
        statusText: result.statusText,
        headers: Object.fromEntries(result.headers.entries()),
        hasBody: result.body !== null,
      }
      send(response(requestId, true, ready))
      if (result.body === null) {
        sendEvent(requestId, { kind: 'fetch-end', fetchId })
        return
      }
      const reader = result.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sendEvent(requestId, { kind: 'fetch-data', fetchId, data: Buffer.from(value).toString('base64') })
        }
        sendEvent(requestId, { kind: 'fetch-end', fetchId })
      } catch (error) {
        if (!controller.signal.aborted) {
          sendEvent(requestId, { kind: 'fetch-error', fetchId, error: ipcError('stream-failed', error) })
        }
      }
    } finally {
      openFetches.delete(fetchId)
    }
  }

  process.on('message', (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null || (raw as { kind?: unknown }).kind !== 'request') return
    const envelope = raw as DesktopIpcRequestEnvelope
    const parsed = parseDesktopHostRequest(envelope.message)
    if (!parsed.ok) {
      send(response(envelope.requestId, false, undefined, { code: 'bad-request', message: parsed.error }))
      return
    }
    const request = parsed.value
    switch (request.kind) {
      case 'bootstrap': {
        answer(envelope.requestId, async () => {
          const described = await ctx.apiProxy.host.describe({ rpcId: RpcId(randomUUID()), payload: {} })
          return {
            value: {
              graph: runtime.graph(),
              host: described.result,
              pid: process.pid,
            },
          }
        })
        return
      }
      case 'ping':
        send(response(envelope.requestId, true, { pong: true, pid: process.pid }))
        return
      case 'bundle':
        answer(envelope.requestId, () => ({ value: runtime.readBundle(request.url) }))
        return
      case 'fetch':
        void handleFetch(envelope.requestId, request.fetchId, request.url, request.init)
        return
      case 'fetch-abort': {
        openFetches.get(request.fetchId)?.abort()
        send(response(envelope.requestId, true, { aborted: true }))
        return
      }
    }
  })

  // Readiness is published only after the full profile tree settled, so main
  // never hands the renderer a half-mounted desktop runtime.
  void ctx.loader.await().then(
    () => { send({ kind: 'ready', pid: process.pid, profile: 'desktop' }) },
    (error: unknown) => { send(response('boot', false, undefined, ipcError('loader-failed', error))) },
  )
}
