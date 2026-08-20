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
import { afterEach, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { DesktopRuntimeHarness } from '../support/desktop-harness.ts'
import { createDesktopTestHome, desktopCliEntry } from '../support/test-home.ts'

const EXPECTED = 'crash recovery answer'

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime Harness crash recovery', () => {
  let server: MockLlmServer | undefined
  let first: DesktopRuntimeHarness | undefined
  let second: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await first?.kill('SIGKILL').catch(() => undefined)
    await second?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('restores one session without duplicate messages after a real child kill', async () => {
    const home = createDesktopTestHome('dsh-desktop-crash-')
    server = await startMockLlmServer({
      sequence: ['success', 'success'],
      apiKey: 'desktop-test-key',
      successText: EXPECTED,
      chunkDelayMs: 2,
    })
    first = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key', home })
    await first.openMux()
    const workspaceId = await first.createWorkspace()
    const sessionId = await first.createSession(workspaceId)
    const firstPid = first.pid
    await first.prompt(sessionId, 'survive this crash')
    await first.waitForTurnEnd(sessionId)
    await first.waitForSessionIdle(sessionId)

    await first.kill('SIGKILL')
    expect(first.pid).toBe(firstPid)

    second = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key', home, restartGeneration: 2 })
    expect(second.pid).not.toBe(firstPid)

    const workspaces = await second.value<{ items: Array<{ workspaceId: string; sessionIds: string[] }> }>('workspace.list', {})
    expect(workspaces.items.find(item => item.workspaceId === workspaceId)?.sessionIds).toContain(sessionId)

    const sessions = await second.value<{ items: Array<{ sessionId: string; running: boolean }> }>('session.list', {})
    expect(sessions.items.find(item => item.sessionId === sessionId)?.running).toBe(false)

    const history = await second.history(sessionId)
    const humanMessages = history.events.filter(entry => entry.event.type === 'user/message'
      && (entry.event.data as { source?: { kind?: string } }).source?.kind === 'user')
    const assistantMessages = history.events.filter(entry => entry.event.type === 'assistant/message')
    expect(humanMessages).toHaveLength(1)
    expect(assistantMessages).toHaveLength(1)
    expect(JSON.stringify(assistantMessages)).toContain(EXPECTED)
  }, 90_000)
})
