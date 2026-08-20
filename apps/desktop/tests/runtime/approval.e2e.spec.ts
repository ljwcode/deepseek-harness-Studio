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

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime approval round trip', () => {
  let server: MockLlmServer | undefined
  let harness: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await harness?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('replays the same approval rpcId after a renderer-stream reconnect and answers once', async () => {
    server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success', 'success'],
      apiKey: 'desktop-test-key',
      toolName: 'fixture_approval',
      toolArguments: '{"reason":"desktop approval test"}',
      successText: 'approval completed',
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()

    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)
    await harness.prompt(sessionId, 'call fixture_approval with the test reason, then report the outcome')
    const first = await harness.waitForFrame('approval/requested', sessionId)
    const firstRpcId = first.rpcId

    // Reconnect the mux stream before answering: the Host must replay the
    // pending ServerRequest with its original rpcId, never mint a new one.
    await harness.closeMux()
    await harness.openMux()
    const replay = await harness.waitForFrame('approval/requested', sessionId)
    expect(replay.rpcId).toBe(firstRpcId)

    const payload = replay.payload as { approvalId: string; sessionId: string }
    const receipt = await harness.respond(replay.rpcId, {
      ok: true,
      value: { sessionId: payload.sessionId, approvalId: payload.approvalId, outcome: 'allowed-once' },
    })
    expect(receipt.accepted).toBe(true)

    await harness.waitForFrame('approval/resolved', sessionId)
    await harness.waitForTurnEnd(sessionId)
    await harness.waitForSessionIdle(sessionId)

    const resolved = harness.frames.find(frame => frame.method === 'approval/resolved' && frame.payload.sessionId === sessionId)
    expect(resolved?.payload.outcome).toBe('allowed-once')
    const duplicate = await harness.respond(replay.rpcId, {
      ok: true,
      value: { sessionId: payload.sessionId, approvalId: payload.approvalId, outcome: 'allowed-once' },
    })
    expect(duplicate.accepted).toBe(false)
    expect(duplicate.reason).toBe('not-pending')

    const results = harness.sessionEvents(sessionId, 'tool/result')
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0]?.data)).toContain('allowed-once')
  }, 90_000)
})
