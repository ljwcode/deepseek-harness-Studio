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

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime multi-step tool', () => {
  let server: MockLlmServer | undefined
  let harness: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await harness?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('runs model -> fixture_echo -> model and correlates the tool call id', async () => {
    server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success', 'success'],
      apiKey: 'desktop-test-key',
      toolName: 'fixture_echo',
      toolArguments: '{"text":"hello"}',
      successText: 'tool completed',
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()

    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)
    await harness.prompt(sessionId, 'call fixture_echo with text hello, then report the result')
    await harness.waitForTurnEnd(sessionId)

    const events = harness.sessionEvents(sessionId)
    const steps = events.filter(event => event.type === 'step/start')
    const calls = events.filter(event => event.type === 'tool/call')
    const results = events.filter(event => event.type === 'tool/result')
    const assistantMessages = events.filter(event => event.type === 'assistant/message')

    expect(steps).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages.filter(event => (event.data as { message?: { content?: Array<{ type?: string }> } }).message?.content?.some(block => block.type === 'tool-call'))).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)

    const callId = (calls[0]!.data as { callId: string }).callId
    expect((results[0]!.data as { message?: { source?: { callId?: string } } }).message?.source?.callId).toBe(callId)
    expect((calls[0]!.data as { name: string }).name).toBe('fixture_echo')
    expect((calls[0]!.data as { arguments: string }).arguments).toBe('{"text":"hello"}')

    const mockRequests = server.requests.map(request => request.behavior)
    expect(mockRequests).toContain('tool_call_success')
    expect(mockRequests.filter(behavior => behavior === 'success').length).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
