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

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime cancel', () => {
  let server: MockLlmServer | undefined
  let harness: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await harness?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('aborts a stalled provider stream through session.cancel and settles the turn', async () => {
    server = await startMockLlmServer({ sequence: ['stall'], apiKey: 'desktop-test-key' })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()

    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)
    await harness.prompt(sessionId, 'this prompt must stall until cancelled')
    await harness.waitForEvent(sessionId, 'turn/start')
    await harness.waitForEvent(sessionId, 'step/start')
    await vi.waitFor(() => {
      expect(server.requests.some(request => request.behavior === 'stall')).toBe(true)
    }, { timeout: 15_000 })

    await harness.cancel(sessionId)
    await harness.waitForTurnEnd(sessionId)
    await harness.waitForSessionIdle(sessionId)

    const list = await harness.value<{ items: Array<{ sessionId: string; running: boolean }> }>('session.list', {})
    expect(list.items.find(item => item.sessionId === sessionId)?.running).toBe(false)
    const stalled = server.requests.find(request => request.behavior === 'stall')
    expect(stalled?.outcome).toBeDefined()

    const ends = harness.sessionEvents(sessionId, 'turn/end')
    expect(ends).toHaveLength(1)
  }, 60_000)
})
