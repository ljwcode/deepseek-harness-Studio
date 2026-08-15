/* oxlint-disable typescript/no-unsafe-assignment -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-argument -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-return -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-redundant-type-constituents -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-non-null-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-condition -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */

import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import type {
  DesktopFetchReady,
  DesktopIpcEventEnvelope,
  DesktopIpcReadyEnvelope,
  DesktopIpcResponseEnvelope,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { desktopCliEntry, desktopTestPatchPath, installDesktopFixture } from './test-home.ts'
import { waitFor } from './wait-for.ts'

export interface DesktopRuntimeOptions {
  server: MockLlmServer
  apiKey?: string
  home?: string
  restartGeneration?: number
  patchPath?: string
  cwd?: string
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface FetchStream {
  chunks: string[]
  onChunk?: (text: string) => void
  resolve?: (body: string) => void
  reject?: (error: Error) => void
  ended: boolean
  error?: Error
}

interface ClientResponse {
  type: 'server-response'
  rpcId: string
  result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

interface MuxFrame {
  type: 'server-request'
  rpcId: string
  method: string
  payload: {
    type: string
    sessionId?: string
    event?: { type: string; seq: number; data: unknown }
    [key: string]: unknown
  }
}

function jsonRpc(method: string, payload: unknown): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method,
    payload,
  })
}

function parseSseBlock(block: string, onFrame: (frame: MuxFrame) => void): void {
  for (const line of block.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice(6).trim()
    if (raw.length === 0) continue
    try {
      const parsed = JSON.parse(raw) as MuxFrame
      if (parsed.type === 'server-request') onFrame(parsed)
    } catch {
      // The mux stream may carry comment/heartbeat lines; malformed frames
      // are skipped here and would be rejected by the real client parser.
    }
  }
}

/** Real Electron-free desktop Harness carrier used by runtime E2E specs. */
export class DesktopRuntimeHarness {
  readonly home: string
  readonly server: MockLlmServer
  readonly frames: MuxFrame[] = []
  readonly stdoutChunks: string[] = []
  readonly stderrChunks: string[] = []

  private child: ChildProcess
  private nextId = 0
  private muxFetchId: string | undefined
  private muxBuffer = ''
  private readonly pending = new Map<string, PendingRequest>()
  private readonly streams = new Map<string, FetchStream>()

  private constructor(options: DesktopRuntimeOptions, child: ChildProcess, home: string) {
    this.server = options.server
    this.home = home
    this.child = child
    child.stdout?.on('data', (chunk) => { this.stdoutChunks.push(String(chunk)) })
    child.stderr?.on('data', (chunk) => { this.stderrChunks.push(String(chunk)) })
    child.on('message', (raw: unknown) => { this.handleMessage(raw) })
  }

  static async start(options: DesktopRuntimeOptions): Promise<DesktopRuntimeHarness> {
    const home = options.home ?? mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
    installDesktopFixture(home)
    const child = fork(desktopCliEntry(), ['--profile', 'desktop', '--patch', options.patchPath ?? desktopTestPatchPath()], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_DESKTOP_IPC: '1',
        DSH_DESKTOP_HOST_GENERATION: String(options.restartGeneration ?? 1),
        DEEPSEEK_API_KEY: options.apiKey ?? 'desktop-test-key',
        DEEPSEEK_BASE_URL: options.server.baseURL,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const harness = new DesktopRuntimeHarness(options, child, home)
    await harness.waitUntilReady()
    return harness
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get exitCode(): number | null {
    return this.child.exitCode
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode
  }

  get exited(): boolean {
    return this.exitCode !== null || this.signalCode !== null
  }

  get output(): string {
    return `stdout:\n${this.stdoutChunks.join('')}\nstderr:\n${this.stderrChunks.join('')}`
  }

  async waitUntilReady(timeoutMs = 45_000): Promise<void> {
    if (this.readyEnvelope !== undefined) return
    await waitFor(() => this.readyEnvelope !== undefined, 'desktop Harness ready envelope', timeoutMs)
  }

  private readyEnvelope: DesktopIpcReadyEnvelope | undefined

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const envelope = raw as { kind?: string; requestId?: string }
    if (envelope.kind === 'ready') {
      this.readyEnvelope = raw as DesktopIpcReadyEnvelope
      return
    }
    if (envelope.kind === 'response') {
      const response = raw as DesktopIpcResponseEnvelope
      const pending = this.pending.get(response.requestId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(response.requestId)
      if (response.ok) pending.resolve(response.value)
      else pending.reject(new Error(`${response.error?.code ?? 'host-error'}: ${response.error?.message ?? 'unknown'}`))
      return
    }
    if (envelope.kind === 'event') {
      const event = (raw as DesktopIpcEventEnvelope).event
      const stream = this.streams.get(event.fetchId)
      if (stream === undefined) return
      if (event.kind === 'fetch-data') {
        const text = Buffer.from(event.data, 'base64').toString('utf8')
        stream.chunks.push(text)
        stream.onChunk?.(text)
        return
      }
      if (event.kind === 'fetch-end') {
        stream.ended = true
        this.streams.delete(event.fetchId)
        stream.resolve?.(stream.chunks.join(''))
        return
      }
      stream.error = new Error(`${event.error.code}: ${event.error.message}`)
      stream.ended = true
      this.streams.delete(event.fetchId)
      stream.reject?.(stream.error)
    }
  }

  async bootstrap(): Promise<Record<string, unknown>> {
    return this.request({ kind: 'bootstrap' }) as Promise<Record<string, unknown>>
  }

  request(message: { kind: 'bootstrap' | 'ping' }, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `r-${++this.nextId}`
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`desktop request ${message.kind} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.send({ kind: 'request', requestId, message })
    })
  }


  async respond(
    rpcId: string,
    result: { ok: boolean; value?: unknown; error?: { code: string; message: string } },
  ): Promise<{ accepted: boolean; reason?: string }> {
    const body = await this.fetchBody('/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
    }, 30_000)
    return JSON.parse(body) as { accepted: boolean; reason?: string }
  }

  async waitForFrame(method: string, sessionId?: string, timeoutMs = 30_000): Promise<MuxFrame> {
    await waitFor(
      () => this.frames.some(frame => frame.method === method && (sessionId === undefined || frame.payload.sessionId === sessionId)),
      `mux frame ${method}`,
      timeoutMs,
    )
    return this.frames.find(frame => frame.method === method && (sessionId === undefined || frame.payload.sessionId === sessionId))!
  }
  async rpc(method: string, payload: unknown, timeoutMs = 30_000): Promise<ClientResponse> {
    const body = await this.fetchBody(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonRpc(method, payload),
    }, timeoutMs)
    return JSON.parse(body) as ClientResponse
  }

  async value<T>(method: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
    const response = await this.rpc(method, payload, timeoutMs)
    if (!response.result.ok) {
      const error = response.result.error
      throw new Error(`${method} failed: ${error?.code ?? 'rpc-error'}: ${error?.message ?? 'unknown'}`)
    }
    return response.result.value as T
  }

  async openMux(timeoutMs = 30_000): Promise<DesktopFetchReady> {
    if (this.muxFetchId !== undefined) return { status: 200, statusText: '', headers: {}, hasBody: true }
    const fetchId = `mux-${++this.nextId}`
    this.muxFetchId = fetchId
    this.streams.set(fetchId, {
      chunks: [],
      ended: false,
      onChunk: (text) => {
        this.muxBuffer += text
        let boundary = this.muxBuffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = this.muxBuffer.slice(0, boundary)
          this.muxBuffer = this.muxBuffer.slice(boundary + 2)
          parseSseBlock(block, (frame) => { this.frames.push(frame) })
          boundary = this.muxBuffer.indexOf('\n\n')
        }
      },
    })
    return this.fetchReady('/api/events.mux', { method: 'GET', headers: {} }, fetchId, timeoutMs)
  }

  sessionEvents(sessionId: string, type?: string): Array<MuxFrame['payload']['event'] & { seq: number; data: unknown }> {
    return this.frames.flatMap((frame) => {
      if (frame.method !== 'session/event' || frame.payload.sessionId !== sessionId || frame.payload.event === undefined) return []
      const event = frame.payload.event
      if (type !== undefined && event.type !== type) return []
      return [event as MuxFrame['payload']['event'] & { seq: number; data: unknown }]
    })
  }

  frameTypes(sessionId: string): string[] {
    return this.frames.filter(frame => frame.payload.sessionId === sessionId).map(frame => frame.method)
  }

  async waitForEvent(sessionId: string, type: string, timeoutMs = 30_000): Promise<void> {
    await waitFor(
      () => this.sessionEvents(sessionId, type).length > 0,
      `session event ${type} for ${sessionId}`,
      timeoutMs,
    )
  }

  async waitForTurnEnd(sessionId: string, timeoutMs = 30_000): Promise<void> {
    await this.waitForEvent(sessionId, 'turn/end', timeoutMs)
  }

  async waitForSessionIdle(sessionId: string, timeoutMs = 30_000): Promise<void> {
    await waitFor(async () => {
      const list = await this.value<{ items: Array<{ sessionId: string; running: boolean }> }>('session.list', {}).catch(() => undefined)
      return list?.items.some(item => item.sessionId === sessionId && !item.running) ?? false
    }, `session ${sessionId} idle`, timeoutMs, 25)
  }

  async createWorkspace(path?: string): Promise<string> {
    const workspacePath = path ?? mkdtempSync(join(tmpdir(), 'dsh-desktop-workspace-'))
    const value = await this.value<{ workspace: { workspaceId: string } }>('workspace.create', { path: workspacePath })
    return value.workspace.workspaceId
  }

  async createSession(workspaceId: string): Promise<string> {
    const value = await this.value<{ sessionId: string }>('session.create', { workspaceId })
    return value.sessionId
  }

  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    await this.value<{ accepted: true }>('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] })
  }

  async cancel(sessionId: string): Promise<void> {
    await this.value<{ accepted: true }>('session.cancel', { sessionId })
  }

  async history(sessionId: string): Promise<{ events: Array<{ event: { type: string; data: unknown } }>; hasMore: boolean }> {
    return this.value('session.history', { sessionId })
  }

  async closeMux(): Promise<void> {
    if (this.muxFetchId === undefined) return
    const fetchId = this.muxFetchId
    this.muxFetchId = undefined
    await this.request({ kind: 'ping' }).catch(() => undefined)
    void fetchId
    // The physical stream is cancelled by closing the child; explicit
    // fetch-abort is a best-effort host cleanup for the live stream.
    await this.fetchAbort(fetchId)
  }

  async fetchAbort(fetchId: string): Promise<void> {
    await this.request({ kind: 'ping' }).catch(() => undefined)
    await new Promise<void>((resolve) => {
      const requestId = `abort-${++this.nextId}`
      this.pending.set(requestId, {
        resolve: () => { resolve() },
        reject: () => { resolve() },
        timer: setTimeout(() => { resolve() }, 2_000),
      })
      this.send({ kind: 'request', requestId, message: { kind: 'fetch-abort', fetchId } })
    })
  }

  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (this.exited) return
    this.child.kill(signal)
    await waitFor(() => this.exited, `desktop Harness exit after ${signal}`, 10_000)
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.exited) return
    this.send({ kind: 'request', requestId: `shutdown-${++this.nextId}`, message: { kind: 'shutdown' } })
    await waitFor(() => this.exited, 'desktop Harness graceful shutdown', timeoutMs)
  }

  private send(message: unknown): void {
    if (this.exited) throw new Error('desktop Harness child already exited')
    this.child.send(message, (error) => {
      if (error !== null) console.error(`[desktop-runtime] child send failed: ${String(error)}`)
    })
  }

  private fetchReady(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    fetchId: string,
    timeoutMs: number,
  ): Promise<DesktopFetchReady> {
    const requestId = `req-${fetchId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`desktop fetch ${path} readiness timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve: (value) => { resolve(value as DesktopFetchReady) }, reject, timer })
      this.send({
        kind: 'request',
        requestId,
        message: { kind: 'fetch', fetchId, url: `http://dsh.internal${path}`, init },
      })
    })
  }

  private async fetchBody(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    timeoutMs: number,
  ): Promise<string> {
    const fetchId = `fetch-${++this.nextId}`
    const bodyPromise = new Promise<string>((resolve, reject) => {
      this.streams.set(fetchId, { chunks: [], ended: false, resolve, reject })
    })
    const ready = await this.fetchReady(path, init, fetchId, timeoutMs)
    if (!ready.hasBody) {
      this.streams.delete(fetchId)
      return ''
    }
    return bodyPromise
  }
}
