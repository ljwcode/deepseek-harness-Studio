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
  rpcInRenderer,
  type LaunchedDesktop,
} from './desktop-electron.ts'

const ANSWER = 'UI click answer'

async function dismissOnboarding(page: import('@playwright/test').Page): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const button = page.locator('button').filter({ hasText: '继续' }).first()
    if (await button.count() > 0) {
      await button.click({ force: true, timeout: 5_000 })
      await page.waitForTimeout(500)
      if (!await page.evaluate(() => document.body.innerText.includes('内测声明'))) break
    }
    await page.waitForTimeout(250)
  }
  await page.waitForFunction(() => !document.body.innerText.includes('内测声明'), undefined, { timeout: 5_000 })
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => document.body.innerText.includes('内测声明'))).toBe(false)
}

async function typeIntoComposer(page: import('@playwright/test').Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder('描述你想要构建的内容')
  await composer.click()
  await composer.pressSequentially(text, { delay: 20 })
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(candidate => candidate.getAttribute('aria-label') === '发送消息')
    return button !== undefined && !(button as HTMLButtonElement).disabled
  }, undefined, { timeout: 30_000 })
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(candidate => candidate.getAttribute('aria-label') === '发送消息')
    if (button === undefined) throw new Error('visible send button is missing')
    ;(button as HTMLButtonElement).click()
  })
}

describe('desktop Electron UI click smoke', () => {
  let server: MockLlmServer | undefined
  let launched: LaunchedDesktop | undefined

  afterEach(async () => {
    await launched?.app.close().catch(() => undefined)
    await server?.close()
  })

  it('sends a prompt from the visible composer and restores it across renderer and Harness restarts', async () => {
    server = await startMockLlmServer({
      sequence: ['slow_success', 'success'],
      apiKey: 'desktop-electron-key',
      successText: ANSWER,
      chunkSize: 9,
      chunkDelayMs: 2,
    })
    launched = await launchDesktop({ server, apiKey: 'desktop-electron-key' })
    const page = launched.page
    await bootstrapRenderer(page)

    // Native OS workspace pickers are intentionally outside Playwright's
    // reach, so the workspace baseline is created over the real preload/main
    // bridge. From here on the visible UI owns the flow.
    const workspacePath = mkdtempSync(join(tmpdir(), 'dsh-ui-click-workspace-'))
    const created = await rpcInRenderer('workspace.create', { path: workspacePath }, page)
    expect(created.result.ok).toBe(true)

    await page.reload()
    await page.waitForFunction(() => typeof window.dshDesktop === 'object')
    const first = await bootstrapRenderer(page)
    await dismissOnboarding(page)

    const composer = page.getByPlaceholder('描述你想要构建的内容')
    await composer.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(1_000)
    await typeIntoComposer(page, 'answer from the visible composer')
    await page.getByText(ANSWER, { exact: false }).first().waitFor({ state: 'visible', timeout: 60_000 })

    // Renderer reload must not disturb the Harness process or the persisted
    // conversation projection.
    await page.reload()
    await page.waitForFunction(() => typeof window.dshDesktop === 'object')
    const afterReload = await bootstrapRenderer(page)
    await dismissOnboarding(page)
    expect(afterReload.pid).toBe(first.pid)
    expect(afterReload.hostGeneration).toBe(first.hostGeneration)
    await page.getByText(ANSWER, { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 })

    // A real Harness child SIGKILL must restart the runtime and the visible
    // UI must resync the same conversation from persistence.
    process.kill(first.pid, 'SIGKILL')
    await page.reload()
    await page.waitForFunction(() => typeof window.dshDesktop === 'object')
    const recovered = await bootstrapRenderer(page, 60_000)
    await dismissOnboarding(page)
    expect(recovered.pid).not.toBe(first.pid)
    expect(recovered.hostGeneration).toBeGreaterThan(first.hostGeneration)
    await page.getByText(ANSWER, { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 })
  }, 150_000)
})
