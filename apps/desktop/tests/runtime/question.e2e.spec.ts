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

async function askQuestion(harness: DesktopRuntimeHarness, toolArguments: string, server: MockLlmServer) {
  const workspaceId = await harness.createWorkspace()
  const sessionId = await harness.createSession(workspaceId)
  await harness.prompt(sessionId, 'call fixture_question with the supplied test arguments')
  const frame = await harness.waitForFrame('question/requested', sessionId)
  type QuestionRequestPayload = {
    sessionId: string
    questions: Array<{ id: string; options?: Array<{ label: string }>; multiSelect?: boolean }>
  }
  const payload = frame.payload as QuestionRequestPayload
  expect(payload.questions).toHaveLength(1)
  void server
  return { frame, sessionId, question: payload.questions[0]! }
}

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime user-question round trip', () => {
  let server: MockLlmServer | undefined
  let harness: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await harness?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('accepts a single-select answer over the shared respond protocol', async () => {
    server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success', 'success'],
      apiKey: 'desktop-test-key',
      toolName: 'fixture_question',
      toolArguments: '{"id":"q1","question":"Pick one","options":["a","b"]}',
      successText: 'question completed',
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()
    const { frame, sessionId, question } = await askQuestion(harness, '', server)

    const receipt = await harness.respond(frame.rpcId, {
      ok: true,
      value: {
        sessionId,
        answer: { answers: [{ id: question.id, selected: ['a'] }] },
      },
    })
    expect(receipt.accepted).toBe(true)
    await harness.waitForFrame('question/resolved', sessionId)
    await harness.waitForTurnEnd(sessionId)
    const resolved = harness.frames.find(candidate => candidate.method === 'question/resolved' && candidate.payload.sessionId === sessionId)
    expect(resolved?.payload.outcome).toBe('answered')
  }, 60_000)

  it('keeps the Host as validation authority for invalid single-select combinations', async () => {
    server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success', 'success'],
      apiKey: 'desktop-test-key',
      toolName: 'fixture_question',
      toolArguments: '{"id":"q1","question":"Pick one","options":["a","b"]}',
      successText: 'question completed',
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()
    const { frame, sessionId, question } = await askQuestion(harness, '', server)

    const invalid = await harness.respond(frame.rpcId, {
      ok: true,
      value: {
        sessionId,
        answer: { answers: [{ id: question.id, selected: ['a'], custom: 'must be mutually exclusive' }] },
      },
    })
    expect(invalid.accepted).toBe(false)
    expect(invalid.reason).toBe('bad-response')

    const valid = await harness.respond(frame.rpcId, {
      ok: true,
      value: { sessionId, answer: { answers: [{ id: question.id, selected: ['b'] }] } },
    })
    expect(valid.accepted).toBe(true)
    await harness.waitForTurnEnd(sessionId)
  }, 60_000)
})
