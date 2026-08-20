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
import { desktopCliEntry } from '../support/test-home.ts'

const EXPECTED = 'expected desktop runtime answer'

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime prompt streaming', () => {
  let server: MockLlmServer | undefined
  let harness: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await harness?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('streams a full turn through Desktop IPC and persists conversation state', async () => {
    server = await startMockLlmServer({
      sequence: ['slow_success', 'success'],
      apiKey: 'desktop-test-key',
      successText: EXPECTED,
      chunkSize: 7,
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()

    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)
    await harness.prompt(sessionId, 'please stream the expected text')
    await harness.waitForTurnEnd(sessionId)

    const events = harness.sessionEvents(sessionId)
    const ordered = events.flatMap((event) => {
      if (event.type === 'user/message') {
        const data = event.data as { source?: { kind?: string } }
        return data.source?.kind === 'user' ? [event.type] : []
      }
      if (['turn/start', 'step/start', 'assistant/chunk', 'assistant/message', 'step/end', 'turn/end'].includes(event.type)) return [event.type]
      return []
    })

    expect(ordered[0]).toBe('turn/start')
    expect(ordered[1]).toBe('step/start')
    expect(ordered[2]).toBe('user/message')
    expect(ordered.filter(type => type === 'assistant/chunk').length).toBeGreaterThan(0)
    expect(ordered.at(-3)).toBe('assistant/message')
    expect(ordered.at(-2)).toBe('step/end')
    expect(ordered.at(-1)).toBe('turn/end')

    const assistantMessages = events.filter(event => event.type === 'assistant/message')
    expect(assistantMessages).toHaveLength(1)
    const message = (assistantMessages[0]!.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message
    expect(message?.content?.find(block => block.type === 'text')?.text).toBe(EXPECTED)

    const history = await harness.history(sessionId)
    const humanHistoryMessages = history.events.filter(entry => entry.event.type === 'user/message'
      && (entry.event.data as { source?: { kind?: string } }).source?.kind === 'user')
    expect(humanHistoryMessages).toHaveLength(1)
    expect(history.events.filter(entry => entry.event.type === 'assistant/message')).toHaveLength(1)
    await harness.waitForSessionIdle(sessionId)
    const list = await harness.value<{ items: Array<{ sessionId: string; running: boolean }> }>('session.list', {})
    expect(list.items.find(item => item.sessionId === sessionId)?.running).toBe(false)
  }, 60_000)
})
