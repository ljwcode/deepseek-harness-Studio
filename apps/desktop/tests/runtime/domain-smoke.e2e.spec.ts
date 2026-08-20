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

interface GoalProjection {
  goal: { id: string; revision: number; phase: string; objective: string }
  roundsStarted: number
}

describe.skipIf(!existsSync(desktopCliEntry()))('desktop runtime domain smoke', () => {
  let server: MockLlmServer | undefined
  let harness: DesktopRuntimeHarness | undefined

  afterEach(async () => {
    await harness?.kill('SIGTERM').catch(() => undefined)
    await server?.close()
  })

  it('writes, projects, and clears a goal through the desktop carrier', async () => {
    server = await startMockLlmServer({
      sequence: ['success', 'success'],
      apiKey: 'desktop-test-key',
      successText: 'goal smoke completed',
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()
    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)

    const created = await harness.value<{ ref: { id: string; revision: number } }>('goal.create', {
      sessionId,
      objective: 'desktop goal smoke',
      maxGoalRounds: 1,
    })
    await harness.waitForTurnEnd(sessionId)

    const projections = (): GoalProjection[] => harness.frames.flatMap(frame => frame.method === 'session/projection'
      && frame.payload.sessionId === sessionId
      && frame.payload.key === 'goal'
      ? [frame.payload.value as GoalProjection]
      : [])
    await vi.waitFor(() => {
      expect(projections().at(-1)?.goal.revision).toBeGreaterThan(created.ref.revision)
    }, { timeout: 15_000 })
    const latest = projections().at(-1)
    expect(latest).toBeDefined()
    const current = latest!
    expect(current.goal.id).toBe(created.ref.id)
    expect(current.goal.objective).toBe('desktop goal smoke')
    expect(current.goal.revision).toBeGreaterThan(created.ref.revision)
    expect(current.goal.phase).toBe('blocked')

    const cleared = await harness.value<{ cleared: true }>('goal.clear', {
      sessionId,
      ref: { id: current.goal.id, revision: current.goal.revision },
    })
    expect(cleared.cleared).toBe(true)
  }, 60_000)

  it('streams a job snapshot from registration through completion with one stable id', async () => {
    server = await startMockLlmServer({
      sequence: ['tool_call_success', 'success', 'success'],
      apiKey: 'desktop-test-key',
      toolName: 'fixture_job',
      toolArguments: '{"label":"desktop job smoke","ms":600}',
      successText: 'job smoke completed',
      chunkDelayMs: 2,
    })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    await harness.openMux()
    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)
    await harness.prompt(sessionId, 'start the fixture job, then report the result')
    await harness.waitForTurnEnd(sessionId)

    const jobs = (): Array<{ id: string; status: string; label: string }> => harness.frames.flatMap(frame => frame.method === 'session/jobs'
      && frame.payload.sessionId === sessionId
      ? (frame.payload.jobs as Array<{ id: string; status: string; label: string }>)
      : [])
    await vi.waitFor(() => {
      expect(jobs().some(job => job.status === 'completed')).toBe(true)
    }, { timeout: 15_000 })
    const running = jobs().find(job => job.status === 'running')
    const completed = jobs().find(job => job.status === 'completed')
    expect(running).toBeDefined()
    expect(completed).toBeDefined()
    expect(completed!.id).toBe(running!.id)
    expect(completed!.label).toBe('desktop job smoke')
  }, 60_000)

  it('reads the subagent catalog navigation baseline over desktop IPC', async () => {
    server = await startMockLlmServer({ sequence: ['success'], apiKey: 'desktop-test-key' })
    harness = await DesktopRuntimeHarness.start({ server, apiKey: 'desktop-test-key' })
    const workspaceId = await harness.createWorkspace()
    const sessionId = await harness.createSession(workspaceId)
    const catalog = await harness.value<{ entries: unknown[]; parentAvailable: boolean }>('subagent.list', {
      parentSessionId: sessionId,
    })
    expect(catalog.entries).toEqual([])
    expect(catalog.parentAvailable).toBe(true)
  }, 60_000)
})
