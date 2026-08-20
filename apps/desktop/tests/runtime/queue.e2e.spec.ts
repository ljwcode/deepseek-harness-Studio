/* oxlint-disable typescript/no-unsafe-assignment -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-argument -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-return -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-redundant-type-constituents -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-non-null-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-condition -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { DesktopRuntimeHarness } from '../support/desktop-harness.ts'
import { desktopCliEntry } from '../support/test-home.ts'

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime queue preservation', () => {
  let server: MockLlmServer | undefined
  let harness: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await harness?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('keeps prompt B queued when stalled prompt A is cancelled', async () => {
    server = await startMockLlmServer({
      sequence: ['stall', 'success', 'success'],
      apiKey: 'desktop-test-key',
      successText: 'B completed after A was cancelled',
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()

    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)
    const responseA = await harness.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'prompt A: stall until cancelled' }],
    })
    expect(responseA.result.ok).toBe(true)
    await vi.waitFor(() => {
      expect(server.requests.some(request => request.behavior === 'stall')).toBe(true)
    }, { timeout: 15_000 })

    const responseB = await harness.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'prompt B: complete after A is cancelled' }],
    })
    expect(responseB.result.ok).toBe(true)
    await vi.waitFor(() => {
      const queued = harness.frames.some(frame => frame.method === 'session/queue'
        && frame.payload.sessionId === sessionId
        && Array.isArray(frame.payload.items)
        && (frame.payload.items as Array<{ placement?: string }>).some(item => item.placement === 'queued'))
      expect(queued).toBe(true)
    }, { timeout: 15_000 })

    await harness.cancel(sessionId)
    await vi.waitFor(() => {
      const completed = harness.sessionEvents(sessionId, 'assistant/message')
        .some(event => JSON.stringify(event.data).includes('B completed after A was cancelled'))
      expect(completed).toBe(true)
    }, { timeout: 30_000 })
    await harness.waitForSessionIdle(sessionId)

    const humanMessages = harness.sessionEvents(sessionId, 'user/message')
      .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'user')
    expect(humanMessages).toHaveLength(2)
    const turns = harness.sessionEvents(sessionId, 'turn/start')
    expect(turns.length).toBeGreaterThanOrEqual(2)
    const stalled = server.requests.find(request => request.behavior === 'stall')
    expect(stalled?.outcome).toBeDefined()
    expect(server.requests.some(request => request.behavior === 'success')).toBe(true)

    const list = await harness.value<{ items: Array<{ sessionId: string; running: boolean }> }>('session.list', {})
    expect(list.items.find(item => item.sessionId === sessionId)?.running).toBe(false)
  }, 90_000)
})
