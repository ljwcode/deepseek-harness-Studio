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

const EXPECTED = 'cold persistence answer'

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime cold persistence', () => {
  let server: MockLlmServer | undefined
  let first: DesktopRuntimeHarness | undefined
  let second: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await first?.kill('SIGKILL').catch(() => undefined)
    await second?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('restores workspace, session, and history from a different Harness process', async () => {
    const home = createDesktopTestHome('dsh-desktop-persistence-')
    server = await startMockLlmServer({
      sequence: ['slow_success', 'success'],
      apiKey: 'desktop-test-key',
      successText: EXPECTED,
      chunkDelayMs: 2,
    })
    first = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key', home })
    await first.openMux()
    const workspaceId = await first.createWorkspace()
    const sessionId = await first.createSession(workspaceId)
    await first.prompt(sessionId, 'persist this turn')
    await first.waitForTurnEnd(sessionId)
    await first.waitForSessionIdle(sessionId)
    await first.shutdown()
    expect(first.exitCode).toBe(0)

    second = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key', home, restartGeneration: 2 })
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
    const message = (assistantMessages[0]!.event.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message
    expect(message?.content?.find(block => block.type === 'text')?.text).toBe(EXPECTED)
  }, 90_000)
})
