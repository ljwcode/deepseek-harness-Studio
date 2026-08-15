/* oxlint-disable typescript/no-unsafe-assignment -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-argument -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-return -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-redundant-type-constituents -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-non-null-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-condition -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopTransportError } from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { IpcRequestRegistry } from '../src/main/ipc-request-registry.ts'

describe('IpcRequestRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves and removes exactly one pending request', () => {
    const registry = new IpcRequestRegistry()
    const resolve = vi.fn()
    const reject = vi.fn()
    registry.register({ id: 'r1', generation: 1, resolve, reject })
    registry.resolve('r1', { ok: true })
    expect(resolve).toHaveBeenCalledWith({ ok: true })
    expect(reject).not.toHaveBeenCalled()
    expect(registry.has('r1')).toBe(false)
    registry.resolve('r1', { late: true })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('settles timeouts with the desktop transport timeout category', () => {
    const registry = new IpcRequestRegistry()
    const reject = vi.fn()
    registry.register({ id: 'r1', generation: 1, resolve: vi.fn(), reject, timeoutMs: 500 })
    vi.advanceTimersByTime(501)
    expect(reject).toHaveBeenCalledTimes(1)
    const error = reject.mock.calls[0]?.[0]
    expect(error).toBeInstanceOf(DesktopTransportError)
    expect((error as DesktopTransportError).code).toBe('request-timeout')
    expect(registry.size).toBe(0)
  })

  it('honors an external AbortSignal and removes the listener after settlement', () => {
    const registry = new IpcRequestRegistry()
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const reject = vi.fn()
    registry.register({ id: 'r1', generation: 1, resolve: vi.fn(), reject, signal: controller.signal })
    controller.abort('renderer gone')
    expect(reject).toHaveBeenCalledTimes(1)
    expect((reject.mock.calls[0]?.[0] as DesktopTransportError).code).toBe('request-aborted')
    expect(registry.size).toBe(0)
    expect(removeSpy).toHaveBeenCalled()
  })

  it('scopes bulk rejection by generation and renderer identity', () => {
    const registry = new IpcRequestRegistry()
    const rejected: string[] = []
    for (const id of ['g1-a', 'g1-b', 'g2-a']) {
      const generation = id.startsWith('g1') ? 1 : 2
      registry.register({
        id,
        generation,
        rendererId: id.endsWith('a') ? 'renderer-a' : 'renderer-b',
        resolve: vi.fn(),
        reject: (error) => { rejected.push(`${id}:${(error as DesktopTransportError).code}`) },
      })
    }
    registry.rejectGeneration(1, new DesktopTransportError('host-unavailable', 'host gone'))
    expect(rejected).toEqual(['g1-a:host-unavailable', 'g1-b:host-unavailable'])
    registry.rejectRenderer('renderer-a', new DesktopTransportError('request-aborted', 'renderer gone'))
    expect(rejected).toEqual(['g1-a:host-unavailable', 'g1-b:host-unavailable', 'g2-a:request-aborted'])
    expect(registry.size).toBe(0)
  })

  it('rejects everything on transport close', () => {
    const registry = new IpcRequestRegistry()
    const reject = vi.fn()
    registry.register({ id: 'r1', generation: 1, resolve: vi.fn(), reject })
    registry.register({ id: 'r2', generation: 1, resolve: vi.fn(), reject })
    registry.rejectAll(new DesktopTransportError('transport-closed', 'closed'))
    expect(reject).toHaveBeenCalledTimes(2)
    expect(registry.size).toBe(0)
  })
})
