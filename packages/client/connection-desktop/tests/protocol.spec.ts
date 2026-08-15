import { describe, expect, it } from 'vitest'
import {
  parseDesktopChildEnvelope,
  parseDesktopHostRequest,
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
})
