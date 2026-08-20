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
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import electronPath from 'electron'
import type { MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

const APP_DIR = fileURLToPath(new URL('../..', import.meta.url))

export interface LaunchDesktopOptions {
  server: MockLlmServer
  apiKey?: string
  home?: string
}

export interface LaunchedDesktop {
  app: ElectronApplication
  page: Page
  home: string
  server: MockLlmServer
}

export async function launchDesktop(options: LaunchDesktopOptions): Promise<LaunchedDesktop> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'dsh-electron-e2e-'))
  const app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: ['.'],
    cwd: APP_DIR,
    env: {
      ...process.env,
      DSH_STUDIO_HOME: home,
      DEEPSEEK_API_KEY: options.apiKey ?? 'desktop-electron-key',
      DEEPSEEK_BASE_URL: options.server.baseURL,
      DSH_TELEMETRY_DISABLED: '1',
    },
  })
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForFunction(() => typeof window.dshDesktop === 'object')
  return { app, page, home, server: options.server }
}

export interface DesktopBootstrapFromRenderer {
  protocolVersion: number
  hostGeneration: number
  graph: { rev: string; entries: Array<{ id: string }> }
  host: unknown
  pid: number
  harnessVersion: string
}

/** Call preload bootstrap until the Harness generation is ready. */
export async function bootstrapRenderer(page: Page, timeoutMs = 45_000): Promise<DesktopBootstrapFromRenderer> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await page.evaluate(() => window.dshDesktop.bootstrap()) as DesktopBootstrapFromRenderer
    } catch (error) {
      lastError = error
      await page.waitForTimeout(200)
    }
  }
  throw new Error(`desktop renderer bootstrap failed: ${String(lastError)}`)
}

/** Run one logical RPC through the real preload/main/child desktop carrier. */
export async function rpcInRenderer(
  method: string,
  payload: unknown,
  page: Page,
): Promise<{ rpcId: string; result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }> {
  return page.evaluate(async ({ method, payload }) => {
    const bridge = window.dshDesktop
    const fetchId = crypto.randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload })
    const readyPromise = bridge.request({
      kind: 'fetch',
      fetchId,
      url: `http://dsh.internal/api/${method}`,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body },
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
    const ready = await readyPromise as { hasBody: boolean; status: number }
    if (ready.status >= 400) throw new Error(`${method} readiness failed with HTTP ${ready.status}`)
    if (!ready.hasBody) return JSON.parse('{"type":"server-response","rpcId":"","result":{"ok":false,"error":{"code":"empty","message":"empty body"}}}')
    return JSON.parse(await bodyPromise)
  }, { method, payload })
}

/** Extract the ok value or throw the wire business error. */
export async function rpcValue<T>(page: Page, method: string, payload: unknown): Promise<T> {
  const response = await rpcInRenderer(method, payload, page)
  if (!response.result.ok) {
    throw new Error(`${method} failed: ${response.result.error?.code ?? 'rpc-error'}: ${response.result.error?.message ?? 'unknown'}`)
  }
  return response.result.value as T
}
