/* oxlint-disable typescript/no-unsafe-argument -- raw child-process IPC fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-assignment -- raw child-process IPC fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw child-process IPC fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw child-process IPC fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-return -- raw child-process IPC fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-redundant-type-constituents -- raw envelopes can be both undefined and unknown-shaped. */

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DesktopBootGraph,
  DesktopFetchReady,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'

const CLI_ENTRY = join(process.cwd(), 'apps/cli/lib/bin.js')
const PROFILE = 'desktop'

interface BootstrapValue {
  graph: DesktopBootGraph
  host: unknown
  pid: number
}

interface FetchEnvelope {
  ready: DesktopFetchReady
  body: unknown
}

interface RawEnvelope {
  kind: 'ready' | 'response' | 'event'
  requestId?: string
  ok?: boolean
  value?: unknown
  error?: { code: string; message: string }
  event?: { kind: string; fetchId: string; data?: string; error?: { code: string; message: string } }
  pid?: number
  profile?: string
}

function activeChild(child: ChildProcess | undefined): ChildProcess {
  if (child === undefined) throw new Error('harness child is not running')
  return child
}

describe.skipIf(!existsSync(CLI_ENTRY))('desktop Harness IPC kernel', () => {
  let child: ChildProcess | undefined
  let ready = false

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-studio-ipc-'))
    child = fork(CLI_ENTRY, ['--profile', PROFILE], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_DESKTOP_IPC: '1',
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout?.on('data', chunk => process.stdout.write(`[desktop-test:out] ${String(chunk)}`))
    child.stderr?.on('data', chunk => process.stderr.write(`[desktop-test:err] ${String(chunk)}`))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('desktop profile did not become ready within 45s')) }, 45_000)
      activeChild(child).on('message', (raw: unknown) => {
        if ((raw as RawEnvelope).kind === 'ready') {
          clearTimeout(timer)
          ready = true
          resolve()
        }
      })
      activeChild(child).once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`harness exited before ready (code=${String(code)})`))
      })
    })
  }, 60_000)

  afterAll(async () => {
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise(resolve => activeChild(child).once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5_000)),
      ])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })

  function request(message: unknown): Promise<unknown> {
    if (!ready || child === undefined) throw new Error('harness not ready')
    const process = activeChild(child)
    const requestId = `t-${crypto.randomUUID()}`
    return new Promise((resolve, reject) => {
      const onMessage = (raw: unknown): void => {
        const envelope = raw as RawEnvelope
        if (envelope.kind !== 'response' || envelope.requestId !== requestId) return
        process.off('message', onMessage)
        if (envelope.ok === true) resolve(envelope.value)
        else reject(new Error(`${envelope.error?.code ?? 'host-error'}: ${envelope.error?.message ?? 'unknown'}`))
      }
      process.on('message', onMessage)
      process.send({ kind: 'request', requestId, message })
    })
  }

  async function fetchEnvelope(path: string, rpcMethod: string, payload: unknown): Promise<FetchEnvelope> {
    const process = activeChild(child)
    const fetchId = `t-${crypto.randomUUID()}`
    const requestId = `req-${fetchId}`
    const body = JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: rpcMethod, payload })
    const readyPromise = new Promise<DesktopFetchReady>((resolve, reject) => {
      const onMessage = (raw: unknown): void => {
        const envelope = raw as RawEnvelope
        if (envelope.kind !== 'response' || envelope.requestId !== requestId) return
        process.off('message', onMessage)
        if (envelope.ok === true) resolve(envelope.value as DesktopFetchReady)
        else reject(new Error(envelope.error?.message ?? 'fetch failed'))
      }
      process.on('message', onMessage)
    })
    process.send({
      kind: 'request',
      requestId,
      message: {
        kind: 'fetch',
        fetchId,
        url: `http://dsh.internal${path}`,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      },
    })
    const readyValue = await readyPromise
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      const onMessage = (raw: unknown): void => {
        const envelope = raw as RawEnvelope
        if (envelope.kind !== 'event' || envelope.event?.fetchId !== fetchId) return
        if (envelope.event.kind === 'fetch-data' && typeof envelope.event.data === 'string') {
          chunks.push(Buffer.from(envelope.event.data, 'base64'))
          return
        }
        if (envelope.event.kind === 'fetch-end') {
          process.off('message', onMessage)
          resolve(Buffer.concat(chunks).toString('utf8'))
          return
        }
        if (envelope.event.kind === 'fetch-error') {
          process.off('message', onMessage)
          reject(new Error(envelope.event.error?.message ?? 'stream failed'))
        }
      }
      process.on('message', onMessage)
    })
    return { ready: readyValue, body: JSON.parse(text) }
  }

  it('boots without a Web connection row and serves the desktop bundle', async () => {
    const bootstrap = await request({ kind: 'bootstrap' }) as BootstrapValue
    expect(bootstrap.graph.entries.length).toBeGreaterThan(20)
    const ids = bootstrap.graph.entries.map(entry => entry.id)
    expect(ids).toContain('@deepseek-ai/dsh-client-connection-desktop')
    expect(ids).toContain('@deepseek-ai/dsh-client-runtime')
    expect(ids).toContain('@deepseek-ai/dsh-client-ui-theme')
    expect(ids).not.toContain('@deepseek-ai/dsh-client-connection')
    expect(ids).not.toContain('@deepseek-ai/dsh-host-webserver')

    const connectionEntry = bootstrap.graph.entries.find(entry => entry.id === '@deepseek-ai/dsh-client-connection-desktop')
    expect(connectionEntry).toBeDefined()
    const bundle = await request({ kind: 'bundle', url: connectionEntry!.url }) as { contentType: string; code: string }
    expect(bundle.contentType).toBe('text/javascript; charset=utf-8')
    expect(bundle.code).toContain('__ModuleLoader__.load')
    expect(bundle.code).toContain('@deepseek-ai/dsh-client-connection-desktop')
  }, 30_000)

  it('serves unary RPC and Typert remote endpoints over IPC fetch', async () => {
    const describe = await fetchEnvelope('/api/host.describe', 'host.describe', {}) as {
      ready: DesktopFetchReady
      body: { result: { ok: boolean; value: { version: string; canOpenPath: boolean } } }
    }
    expect(describe.ready.status).toBe(200)
    expect(describe.body.result.ok).toBe(true)
    expect(typeof describe.body.result.value.version).toBe('string')

    const inventory = await fetchEnvelope('/api/pluginInventory/list', 'pluginInventory/list', { args: {} }) as {
      body: { result: { ok: boolean; value: { entries: Array<{ entryId: string }> } } }
    }
    expect(inventory.body.result.ok).toBe(true)
    expect(inventory.body.result.value.entries.length).toBeGreaterThan(0)
  }, 30_000)

  it('opens and aborts an event stream over IPC', async () => {
    const process = activeChild(child)
    const fetchId = `t-stream-${crypto.randomUUID()}`
    const requestId = `req-${fetchId}`
    const readyValue = await new Promise<DesktopFetchReady>((resolve, reject) => {
      const onMessage = (raw: unknown): void => {
        const envelope = raw as RawEnvelope
        if (envelope.kind === 'response' && envelope.requestId === requestId) {
          process.off('message', onMessage)
          if (envelope.ok === true) resolve(envelope.value as DesktopFetchReady)
          else reject(new Error('stream open failed'))
        }
      }
      process.on('message', onMessage)
      process.send({
        kind: 'request',
        requestId,
        message: { kind: 'fetch', fetchId, url: 'http://dsh.internal/api/events.mux', init: { method: 'GET', headers: {} } },
      })
    })
    expect(readyValue.status).toBe(200)
    expect(readyValue.hasBody).toBe(true)
    const aborted = await request({ kind: 'fetch-abort', fetchId }) as { aborted: boolean }
    expect(aborted.aborted).toBe(true)
  }, 30_000)
})
