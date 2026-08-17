/* oxlint-disable typescript/no-unsafe-assignment -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-call -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-member-access -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-argument -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-return -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-redundant-type-constituents -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-non-null-assertion -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unnecessary-condition -- Electron page.evaluate payloads cross the Playwright wire as unknown. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import {
  bootstrapRenderer,
  launchDesktop,
  rpcValue,
  type LaunchedDesktop,
} from './desktop-electron.ts'

const EXPECTED = 'electron runtime prompt answer'

interface PromptRun {
  sessionId: string
  workspaceId: string
  eventTypes: string[]
}

async function runPrompt(page: import('@playwright/test').Page, workspacePath: string, text: string): Promise<PromptRun> {
  return page.evaluate(async ({ workspacePath, text }) => {
    const bridge = window.dshDesktop

    const fetchBody = async (method: string, payload: unknown): Promise<{ rpcId: string; result: { ok: boolean; value?: unknown } }> => {
      const fetchId = crypto.randomUUID()
      const readyPromise = bridge.request({
        kind: 'fetch',
        fetchId,
        url: `http://dsh.internal/api/${method}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
        },
      })
      const bodyPromise = new Promise<string>((resolve, reject) => {
        const chunks: string[] = []
        const unsubscribe = bridge.subscribe((event) => {
          if (event.kind === 'harness-state' || event.fetchId !== fetchId) return
          if (event.kind === 'fetch-data') chunks.push(new TextDecoder().decode(Uint8Array.from(atob(event.data), char => char.charCodeAt(0))))
          if (event.kind === 'fetch-end') {
            unsubscribe()
            resolve(chunks.join(''))
          }
          if (event.kind === 'fetch-error') {
            unsubscribe()
            reject(new Error(event.error.message))
          }
        })
      })
      const ready = await readyPromise as { status: number }
      if (ready.status >= 400) throw new Error(`${method} failed with HTTP ${ready.status}`)
      return JSON.parse(await bodyPromise)
    }

    const workspace = await fetchBody('workspace.create', { path: workspacePath })
    const session = await fetchBody('session.create', { workspaceId: (workspace.result.value as { workspace: { workspaceId: string } }).workspace.workspaceId })
    const sessionId = (session.result.value as { sessionId: string }).sessionId

    const muxFetchId = crypto.randomUUID()
    const muxFrames: Array<{ method: string; payload: { sessionId?: string; event?: { type: string } } }> = []
    let muxBuffer = ''
    const turnEnded = new Promise<void>((resolve) => {
      bridge.subscribe((event) => {
        if (event.kind === 'harness-state' || event.fetchId !== muxFetchId) return
        if (event.kind === 'fetch-data') {
          muxBuffer += new TextDecoder().decode(Uint8Array.from(atob(event.data), char => char.charCodeAt(0)))
          let boundary = muxBuffer.indexOf('\n\n')
          while (boundary >= 0) {
            const block = muxBuffer.slice(0, boundary)
            muxBuffer = muxBuffer.slice(boundary + 2)
            for (const line of block.split('\n')) {
              if (!line.startsWith('data: ')) continue
              try {
                const frame = JSON.parse(line.slice(6))
                muxFrames.push(frame)
                if (frame.payload?.sessionId === sessionId && frame.payload?.event?.type === 'turn/end') resolve()
              } catch {
                // Ignore malformed test frame.
              }
            }
            boundary = muxBuffer.indexOf('\n\n')
          }
        }
      })
    })

    const muxReady = await bridge.request({
      kind: 'fetch',
      fetchId: muxFetchId,
      url: 'http://dsh.internal/api/events.mux',
      init: { method: 'GET', headers: {} },
    }) as { status: number }
    if (muxReady.status !== 200) throw new Error(`events.mux failed with HTTP ${muxReady.status}`)

    await fetchBody('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
    await Promise.race([
      turnEnded,
      new Promise((_, reject) => setTimeout(() => { reject(new Error('turn did not end in time')) }, 45_000)),
    ])

    return {
      sessionId,
      workspaceId: (workspace.result.value as { workspace: { workspaceId: string } }).workspace.workspaceId,
      eventTypes: muxFrames.flatMap(frame => frame.payload?.event?.type ? [frame.payload.event.type] : []),
    }
  }, { workspacePath, text })
}

describe('desktop Electron runtime and crash recovery', () => {
  let server: MockLlmServer | undefined
  let launched: LaunchedDesktop | undefined

  afterEach(async () => {
    await launched?.app.close().catch(() => undefined)
    await server?.close()
  })

  it('streams a prompt, survives renderer reload, and reconnects after Harness SIGKILL', async () => {
    server = await startMockLlmServer({
      sequence: ['slow_success', 'success'],
      apiKey: 'desktop-electron-key',
      successText: EXPECTED,
      chunkSize: 9,
      chunkDelayMs: 2,
    })
    launched = await launchDesktop({ server, apiKey: 'desktop-electron-key' })
    const page = launched.page
    const first = await bootstrapRenderer(page)
    const firstPid = first.pid

    const workspacePath = mkdtempSync(join(tmpdir(), 'dsh-electron-workspace-'))
    const run = await runPrompt(page, workspacePath, 'stream this through the electron shell')
    expect(run.eventTypes).toContain('turn/start')
    expect(run.eventTypes).toContain('assistant/chunk')
    expect(run.eventTypes).toContain('assistant/message')
    expect(run.eventTypes).toContain('turn/end')

    const history = await rpcValue<{ events: Array<{ event: { type: string; data: unknown } }> }>(
      page, 'session.history', { sessionId: run.sessionId },
    )
    const human = history.events.filter(entry => entry.event.type === 'user/message'
      && (entry.event.data as { source?: { kind?: string } }).source?.kind === 'user')
    const assistant = history.events.filter(entry => entry.event.type === 'assistant/message')
    expect(human).toHaveLength(1)
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant)).toContain(EXPECTED)

    const beforeReloadRenderer = await page.evaluate(() => window.dshDesktop.rendererId)
    await page.reload()
    await page.waitForFunction(previous => window.dshDesktop.rendererId !== previous, beforeReloadRenderer)
    const afterReload = await bootstrapRenderer(page)
    expect(afterReload.pid).toBe(firstPid)
    expect(afterReload.hostGeneration).toBe(first.hostGeneration)

    const historyAfterReload = await rpcValue<{ events: Array<{ event: { type: string } }> }>(
      page, 'session.history', { sessionId: run.sessionId },
    )
    expect(historyAfterReload.events.filter(entry => entry.event.type === 'assistant/message')).toHaveLength(1)

    process.kill(firstPid, 'SIGKILL')
    await page.reload()
    const recovered = await bootstrapRenderer(page, 60_000)
    expect(recovered.pid).not.toBe(firstPid)
    expect(recovered.hostGeneration).toBeGreaterThan(first.hostGeneration)

    const workspaces = await rpcValue<{ items: Array<{ workspaceId: string; sessionIds: string[] }> }>(
      page, 'workspace.list', {},
    )
    expect(workspaces.items.find(item => item.workspaceId === run.workspaceId)?.sessionIds).toContain(run.sessionId)
    const sessions = await rpcValue<{ items: Array<{ sessionId: string; running: boolean }> }>(
      page, 'session.list', {},
    )
    expect(sessions.items.find(item => item.sessionId === run.sessionId)?.running).toBe(false)
  }, 120_000)
})
