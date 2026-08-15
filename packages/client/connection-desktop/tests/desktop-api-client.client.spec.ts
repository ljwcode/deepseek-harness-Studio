/* oxlint-disable typescript/no-unsafe-assignment -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-argument -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-return -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-redundant-type-constituents -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-non-null-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-condition -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */

import { describe, expect, it, vi } from 'vitest'
import type {
  DesktopFetchReady,
  DesktopHostRequest,
  DesktopIpcEvent,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { DesktopApiClient } from '../src/client/desktop-api-client.ts'
import type { DesktopBridge } from '../src/client/desktop-bridge.ts'

const READY: DesktopFetchReady = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  hasBody: true,
}

function describePayload(rpcId: string): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: {
      ok: true,
      value: { version: 'desktop-test', cwd: '/tmp/dsh-desktop', attachedSessions: 0, canOpenPath: false },
    },
  })
}

class FakeBridge implements DesktopBridge {
  readonly requests: DesktopHostRequest[] = []
  readonly events: DesktopIpcEvent[] = []
  private readonly listeners = new Set<(event: DesktopIpcEvent) => void>()
  private readonly pending = new Map<string, { resolve: (value: DesktopFetchReady) => void; reject: (error: Error) => void }>()

  request(message: DesktopHostRequest): Promise<unknown> {
    this.requests.push(message)
    if (message.kind === 'fetch') {
      return new Promise((resolve, reject) => {
        this.pending.set(message.fetchId, { resolve: resolve as (value: DesktopFetchReady) => void, reject })
        if (this.autoReady) this.completeFetch(message.fetchId)
      })
    }
    if (message.kind === 'fetch-abort') return Promise.resolve({ aborted: true })
    return Promise.resolve(undefined)
  }

  subscribe(listener: (event: DesktopIpcEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  constructor(private readonly autoReady = true) {}

  emit(event: DesktopIpcEvent): void {
    this.events.push(event)
    for (const listener of [...this.listeners]) listener(event)
  }

  ready(fetchId: string): void {
    const pending = this.pending.get(fetchId)
    if (pending === undefined) return
    this.pending.delete(fetchId)
    pending.resolve(READY)
  }

  fail(fetchId: string, error: Error): void {
    const pending = this.pending.get(fetchId)
    if (pending === undefined) return
    this.pending.delete(fetchId)
    pending.reject(error)
  }

  completeFetch(fetchId: string): void {
    const request = this.requests.findLast(candidate => candidate.kind === 'fetch' && candidate.fetchId === fetchId)
    if (request?.kind !== 'fetch') return
    const body = request.init.body
    const rpcId = typeof body === 'string' ? (JSON.parse(body) as { rpcId?: unknown }).rpcId : undefined
    const payload = describePayload(typeof rpcId === 'string' ? rpcId : 'missing')
    const bytes = new TextEncoder().encode(payload)
    const binary = Buffer.from(bytes).toString('base64')
    queueMicrotask(() => { this.ready(fetchId) })
    setTimeout(() => {
      this.emit({ kind: 'fetch-data', fetchId, data: binary })
      this.emit({ kind: 'fetch-end', fetchId })
    }, 0)
  }
}

describe('DesktopApiClient request/stream lifecycle', () => {
  it('carries a logical RPC through the desktop fetch envelope and decodes the response', async () => {
    const bridge = new FakeBridge()
    const api = new DesktopApiClient(bridge)
    const response = await api.host.describe({})
    expect(response.rpcId).toBeTypeOf('string')
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.version).toBe('desktop-test')

    const fetch = bridge.requests.findLast(request => request.kind === 'fetch')
    expect(fetch?.kind).toBe('fetch')
    if (fetch?.kind !== 'fetch') throw new Error('missing fetch request')
    expect(new URL(fetch.url).pathname).toBe('/api/host.describe')
    expect(JSON.parse(fetch.init.body ?? '{}')).toMatchObject({ type: 'client-request', rpcId: response.rpcId })
    api.close()
  })

  it('emits data, end and removes one stream state exactly once', async () => {
    const bridge = new FakeBridge()
    const api = new DesktopApiClient(bridge)
    await api.host.describe({})
    const fetchId = bridge.requests.findLast(request => request.kind === 'fetch')?.fetchId
    expect(fetchId).toBeTypeOf('string')
    expect(bridge.events.filter(event => event.fetchId === fetchId).map(event => event.kind)).toEqual(['fetch-data', 'fetch-end'])
    api.close()
    expect(bridge.events).toHaveLength(2)
  })

  it('turns fetch-error into a transport rejection and forgets the stream', async () => {
    const bridge = new FakeBridge()
    const api = new DesktopApiClient(bridge)
    const pending = api.host.describe({})
    const fetch = bridge.requests.findLast(request => request.kind === 'fetch')
    if (fetch?.kind !== 'fetch') throw new Error('missing fetch')
    bridge.fail(fetch.fetchId, new Error('host went away'))
    await expect(pending).rejects.toThrow('host went away')
    api.close()
  })

  it('aborts an in-flight fetch and asks the host to cancel the physical stream', async () => {
    const bridge = new FakeBridge(false)
    const api = new DesktopApiClient(bridge)
    const controller = new AbortController()
    const pending = api.host.describe({}, controller.signal)
    const fetch = bridge.requests.findLast(request => request.kind === 'fetch')
    if (fetch?.kind !== 'fetch') throw new Error('missing fetch')
    controller.abort('renderer disposed')
    await expect(pending).rejects.toThrow('renderer disposed')
    expect(bridge.requests.some(request => request.kind === 'fetch-abort' && request.fetchId === fetch.fetchId)).toBe(true)
    api.close()
  })

  it('closing the bridge fails every open stream', async () => {
    const bridge = new FakeBridge(false)
    const api = new DesktopApiClient(bridge)
    const first = api.host.describe({})
    const second = api.host.describe({})
    const unsubscribe = vi.fn()
    const spyBridge: DesktopBridge = {
      request: message => bridge.request(message),
      subscribe: (listener) => {
        bridge.subscribe(listener)
        return unsubscribe
      },
    }
    const spyApi = new DesktopApiClient(spyBridge)
    const third = spyApi.host.describe({})
    api.close()
    spyApi.close()
    await expect(first).rejects.toThrow('desktop connection closed')
    await expect(second).rejects.toThrow('desktop connection closed')
    await expect(third).rejects.toThrow('desktop connection closed')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
