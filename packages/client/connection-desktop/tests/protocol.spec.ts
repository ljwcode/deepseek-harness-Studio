import { describe, expect, it } from 'vitest'
import {
  DesktopTransportError,
  parseDesktopChildEnvelope,
  parseDesktopChildRequest,
  parseDesktopHostRequest,
  parseDesktopRequestFrame,
  type DesktopIpcEventEnvelope,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'

describe('desktop IPC protocol', () => {
  it('accepts the restricted renderer request vocabulary', () => {
    expect(parseDesktopHostRequest({ kind: 'bootstrap' })).toEqual({ ok: true, value: { kind: 'bootstrap' } })
    expect(parseDesktopHostRequest({ kind: 'ping' })).toEqual({ ok: true, value: { kind: 'ping' } })
    expect(parseDesktopHostRequest({ kind: 'bundle', url: '/plugins/%40scope%2Fpkg/client.js?rev=abc' })).toEqual({
      ok: true,
      value: { kind: 'bundle', url: '/plugins/%40scope%2Fpkg/client.js?rev=abc' },
    })
    expect(parseDesktopHostRequest({
      kind: 'fetch',
      fetchId: 'f1',
      url: 'http://dsh.internal/api/host.describe',
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    })).toEqual({
      ok: true,
      value: {
        kind: 'fetch',
        fetchId: 'f1',
        url: 'http://dsh.internal/api/host.describe',
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      },
    })
  })

  it('rejects channels outside /api and /plugins', () => {
    const parsed = parseDesktopHostRequest({
      kind: 'fetch',
      fetchId: 'f1',
      url: 'http://dsh.internal/etc/passwd',
      init: { method: 'GET', headers: {} },
    })
    expect(parsed.ok).toBe(false)
  })

  it('normalizes base64 streaming frames from Node child IPC', () => {
    const envelope: DesktopIpcEventEnvelope = {
      kind: 'event',
      requestId: 'r1',
      event: { kind: 'fetch-data', fetchId: 'f1', data: Buffer.from('hello').toString('base64') },
    }
    const parsed = parseDesktopChildEnvelope(envelope)
    expect(parsed).toEqual({ ok: true, value: envelope })
  })

  it('accepts parent-only shutdown but never exposes it to renderer parsing', () => {
    expect(parseDesktopChildRequest({ kind: 'shutdown' })).toEqual({ ok: true, value: { kind: 'shutdown' } })
    expect(parseDesktopHostRequest({ kind: 'shutdown' }).ok).toBe(false)
  })

  it('validates renderer frames and their host generation', () => {
    const frame = {
      protocolVersion: 1,
      rendererId: crypto.randomUUID(),
      hostGeneration: 7,
      message: { kind: 'ping' },
    }
    expect(parseDesktopRequestFrame(frame)).toEqual({ ok: true, value: frame })
    expect(parseDesktopRequestFrame({ ...frame, protocolVersion: 2 }).ok).toBe(false)
    expect(parseDesktopRequestFrame({ ...frame, rendererId: '' }).ok).toBe(false)
    expect(parseDesktopRequestFrame({ ...frame, hostGeneration: -1 }).ok).toBe(false)
    expect(parseDesktopRequestFrame({ ...frame, message: { kind: 'shutdown' } }).ok).toBe(false)
  })

  it('requires the main-assigned generation on host readiness envelopes', () => {
    expect(parseDesktopChildEnvelope({ kind: 'ready', pid: 42, profile: 'desktop', generation: 3 })).toEqual({
      ok: true,
      value: { kind: 'ready', pid: 42, profile: 'desktop', generation: 3 },
    })
    expect(parseDesktopChildEnvelope({ kind: 'ready', pid: 42, profile: 'desktop' }).ok).toBe(false)
  })

  it('keeps transport error codes machine-readable and distinct from host errors', () => {
    const error = new DesktopTransportError('host-unavailable', 'child exited', new Error('spawn failed'))
    expect(error.name).toBe('DesktopTransportError')
    expect(error.code).toBe('host-unavailable')
    expect(error.cause).toBeInstanceOf(Error)
  })
})
