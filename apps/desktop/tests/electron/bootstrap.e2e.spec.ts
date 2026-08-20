/* oxlint-disable typescript/no-unsafe-assignment -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-call -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-member-access -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-argument -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unsafe-return -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-redundant-type-constituents -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-non-null-assertion -- Electron page.evaluate payloads cross the Playwright wire as unknown. */
/* oxlint-disable typescript/no-unnecessary-condition -- Electron page.evaluate payloads cross the Playwright wire as unknown. */

import { afterEach, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { bootstrapRenderer, launchDesktop, type LaunchedDesktop } from './desktop-electron.ts'

describe('desktop Electron bootstrap and renderer reload', () => {
  let server: MockLlmServer | undefined
  let launched: LaunchedDesktop | undefined

  afterEach(async () => {
    await launched?.app.close().catch(() => undefined)
    await server?.close()
  })

  it('boots the full shell and keeps the Harness generation stable across renderer reload', async () => {
    server = await startMockLlmServer({ sequence: ['success'], apiKey: 'desktop-electron-key' })
    launched = await launchDesktop({ server, apiKey: 'desktop-electron-key' })
    const page = launched.page

    const first = await bootstrapRenderer(page)
    expect(first.protocolVersion).toBe(1)
    expect(first.hostGeneration).toBeGreaterThanOrEqual(1)
    expect(first.pid).toBeTypeOf('number')
    expect(first.harnessVersion).toBeTypeOf('string')
    expect(first.graph.entries.length).toBeGreaterThan(20)
    expect(first.graph.entries.map(entry => entry.id)).toContain('@deepseek-ai/dsh-client-connection-desktop')

    const rendererId = await page.evaluate(() => window.dshDesktop.rendererId)
    expect(rendererId).toMatch(/^[0-9a-f-]{36}$/)

    await page.reload()
    await page.waitForFunction(previous => window.dshDesktop.rendererId !== previous, rendererId)
    const second = await bootstrapRenderer(page)

    expect(second.hostGeneration).toBe(first.hostGeneration)
    expect(second.pid).toBe(first.pid)
    expect(await page.evaluate(() => window.dshDesktop.rendererId)).not.toBe(rendererId)
  }, 90_000)
})
