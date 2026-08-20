/**
 * Harness process manager: Electron main owns lifecycle, never Harness code.
 * The Harness runs as a forked `dsh --profile desktop` process with the
 * desktop IPC bridge enabled, so an agent/plugin crash cannot take down the
 * desktop shell.
 */

import { EventEmitter } from 'node:events'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DesktopTransportError,
  parseDesktopChildEnvelope,
  type DesktopChildRequest,
  type DesktopHostRequest,
  type DesktopIpcEvent,
  type DesktopIpcRequestEnvelope,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { IpcRequestRegistry } from './ipc-request-registry.ts'
import { resolveHarnessHome } from './studio-home.ts'

export type HarnessState = 'starting' | 'ready' | 'restarting' | 'stopping' | 'stopped' | 'failed'

/** What the desktop shell wants the Harness process to be doing. */
export type DesiredHarnessState = 'running' | 'stopped'

/** Spawn function seam for deterministic lifecycle tests. */
export type HarnessSpawn = (entry: string, args: string[], options: ForkOptions) => ChildProcess

export interface HarnessProcessOptions {
  /** Absolute dsh CLI bin; defaults to the workspace @deepseek-ai/dsh install. */
  entry?: string
  /** Extra arguments passed before the profile selector. */
  args?: string[]
  /** Child working directory. */
  cwd?: string
  /** Environment overrides merged over `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Disable automatic restart (tests use this to inspect crash behavior). */
  restart?: boolean
  /** Initial restart delay in ms. */
  restartBaseMs?: number
  /** Backoff ladder; the final entry repeats as the cap. */
  restartDelaysMs?: number[]
  /** Sliding crash-loop window in ms. */
  crashWindowMs?: number
  /** Crashes inside {@link crashWindowMs} that enter the `failed` state. */
  crashLimit?: number
  /** Child-process spawn seam; production uses `fork`. */
  spawn?: HarnessSpawn
}

const DEFAULT_RESTART_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000, 8_000, 10_000])
const DEFAULT_CRASH_WINDOW_MS = 60_000
const DEFAULT_CRASH_LIMIT = 5

/** Resolve the built dsh CLI bin from the workspace/package installation. */
function resolveDshCliEntry(): string {
  if (process.env.DSH_DESKTOP_CLI_ENTRY !== undefined) return process.env.DSH_DESKTOP_CLI_ENTRY
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('@deepseek-ai/dsh/package.json')
  const entry = join(dirname(pkgPath), 'lib', 'bin.js')
  if (!existsSync(entry)) {
    throw new Error(`harness-process: dsh CLI entry not built at ${entry}; run pnpm run build first`)
  }
  return entry
}

function transportUnavailable(generation: number, detail: string): DesktopTransportError {
  return new DesktopTransportError('host-unavailable', `desktop Harness generation ${generation} is unavailable: ${detail}`)
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Process manager for the independent Harness host process. */
export class HarnessProcessManager extends EventEmitter {
  private child: ChildProcess | undefined
  private stateValue: HarnessState = 'stopped'
  private desiredState: DesiredHarnessState = 'stopped'
  private generation = 0
  private restartTimer: NodeJS.Timeout | undefined
  private restartAttempt = 0
  private childFailureReported = false
  private readonly crashTimestamps: number[] = []
  private readonly requests = new IpcRequestRegistry()
  private readonly readyWaiters = new Set<() => void>()
  private readonly options: Required<Pick<HarnessProcessOptions, 'restart' | 'restartBaseMs' | 'restartDelaysMs' | 'crashWindowMs' | 'crashLimit'>> & HarnessProcessOptions

  constructor(options: HarnessProcessOptions = {}) {
    super()
    this.options = {
      ...options,
      restart: options.restart ?? true,
      restartBaseMs: options.restartBaseMs ?? 500,
      restartDelaysMs: options.restartDelaysMs ?? [...DEFAULT_RESTART_DELAYS_MS],
      crashWindowMs: options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS,
      crashLimit: options.crashLimit ?? DEFAULT_CRASH_LIMIT,
    }
    this.assertRestartOptions()
  }

  get state(): HarnessState {
    return this.stateValue
  }

  get desired(): DesiredHarnessState {
    return this.desiredState
  }

  get hostGeneration(): number {
    return this.generation
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  /** Start (or restart) the Harness child process. */
  start(): void {
    if (this.desiredState === 'running' && (this.stateValue === 'starting' || this.stateValue === 'ready')) return
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.desiredState = 'running'
    this.crashTimestamps.length = 0
    this.restartAttempt = 0
    this.childFailureReported = false
    this.startInternal()
  }

  /** Graceful stop: `desktop/shutdown`, then SIGTERM, then SIGKILL. */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.desiredState = 'stopped'
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    if (child === undefined || childExited(child)) {
      this.child = undefined
      this.requests.rejectAll(new DesktopTransportError('transport-closed', 'desktop Harness transport closed'))
      this.setState('stopped')
      return
    }
    this.setState('stopping')
    this.childFailureReported = true
    if (child.connected) {
      try {
        await this.control({ kind: 'shutdown' }, Math.max(1, timeoutMs))
      } catch {
        // The child may exit before acknowledging; the exit wait below is authoritative.
      }
    }
    await this.waitForExit(child, Math.max(1, timeoutMs))
    if (this.child !== child || childExited(child)) return
    child.kill('SIGTERM')
    await this.waitForExit(child, Math.min(timeoutMs, 1_000))
    if (this.child !== child || childExited(child)) return
    child.kill('SIGKILL')
    await this.waitForExit(child, Math.min(timeoutMs, 1_000))
    if (this.child === child) this.child = undefined
    this.requests.rejectAll(new DesktopTransportError('transport-closed', 'desktop Harness transport closed'))
    this.setState('stopped')
  }

  /** Restart on demand (plugin install/update path can call this later). */
  async restart(): Promise<void> {
    await this.stop()
    this.crashTimestamps.length = 0
    this.restartAttempt = 0
    this.childFailureReported = false
    this.start()
  }

  /** Wait until the desktop profile tree reported ready. */
  waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this.stateValue === 'ready' && this.desiredState === 'running') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(finish)
        reject(new Error(`harness did not become ready within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      const finish = (): void => {
        clearTimeout(timer)
        this.readyWaiters.delete(finish)
        resolve()
      }
      this.readyWaiters.add(finish)
    })
  }

  /** Send one validated desktop request to the child and await its response. */
  request(message: DesktopHostRequest, options: { rendererId?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.stateValue !== 'ready' || this.child === undefined || !this.child.connected) {
      return Promise.reject(new DesktopTransportError('host-unavailable', `desktop Harness is ${this.stateValue}; request ${message.kind} refused`))
    }
    const requestId = randomUUID()
    const timeoutMs = options.timeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      this.requests.register({
        id: requestId,
        generation: this.generation,
        ...options.rendererId === undefined ? {} : { rendererId: options.rendererId },
        resolve,
        reject,
        timeoutMs,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      const envelope: DesktopIpcRequestEnvelope = { kind: 'request', requestId, message }
      const activeChild = this.child
      if (activeChild === undefined || !activeChild.connected) {
        this.requests.reject(requestId, new DesktopTransportError('transport-closed', 'desktop Harness child disconnected before request send'))
        return
      }
      activeChild.send(envelope, (error) => {
        if (error === null) return
        this.requests.reject(requestId, new DesktopTransportError('transport-closed', `desktop Harness send failed for ${message.kind}`, error))
      })
    })
  }

  /** Reject every pending request owned by one renderer boot. */
  abortRenderer(rendererId: string, error = new DesktopTransportError('request-aborted', `renderer ${rendererId} disconnected`)): void {
    this.requests.rejectRenderer(rendererId, error)
  }

  /** Lightweight liveness probe over the IPC channel. */
  async health(): Promise<boolean> {
    try {
      const value = await this.request({ kind: 'ping' }, { timeoutMs: 2_000 })
      return typeof value === 'object' && value !== null && (value as { pong?: unknown }).pong === true
    } catch {
      return false
    }
  }

  private control(message: DesktopChildRequest, timeoutMs: number): Promise<unknown> {
    const child = this.child
    if (child === undefined || !child.connected) {
      return Promise.reject(new DesktopTransportError('transport-closed', `desktop Harness child unavailable for ${message.kind}`))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      this.requests.register({
        id: requestId,
        generation: this.generation,
        resolve,
        reject,
        timeoutMs,
      })
      const envelope: DesktopIpcRequestEnvelope = { kind: 'request', requestId, message }
      child.send(envelope, (error) => {
        if (error === null) return
        this.requests.reject(requestId, new DesktopTransportError('transport-closed', `desktop Harness control send failed for ${message.kind}`, error))
      })
    })
  }

  private handleChildMessage(child: ChildProcess, generation: number, raw: unknown): void {
    if (generation !== this.generation || child !== this.child) return
    const parsed = parseDesktopChildEnvelope(raw)
    if (!parsed.ok) {
      console.warn(`harness-process: dropping malformed child envelope: ${parsed.error}`)
      return
    }
    const envelope = parsed.value
    if (envelope.kind === 'ready') {
      if (this.desiredState !== 'running' || envelope.generation !== generation) return
      this.childFailureReported = false
      this.restartAttempt = 0
      this.setState('ready')
      for (const waiter of this.readyWaiters) waiter()
      this.readyWaiters.clear()
      return
    }
    if (envelope.kind === 'response') {
      if (!this.requests.has(envelope.requestId)) return
      if (envelope.ok) {
        this.requests.resolve(envelope.requestId, envelope.value)
        return
      }
      // A Host rejection is a delivered logical failure; keep the original
      // business-code shape instead of reclassifying it as transport loss.
      this.requests.reject(envelope.requestId, new Error(`${envelope.error?.code ?? 'host-error'}: ${envelope.error?.message ?? 'unknown host error'}`))
      return
    }
    this.emitEvent(envelope.event)
  }

  private emitEvent(event: DesktopIpcEvent): void {
    this.emit('event', event)
  }

  private startInternal(): void {
    const generation = ++this.generation
    this.childFailureReported = false
    this.setState(this.desiredState === 'running' ? 'starting' : 'stopping')
    const entry = this.options.entry ?? resolveDshCliEntry()
    const args = ['--profile', 'desktop', ...(this.options.args ?? [])]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // fork() uses Electron's binary in a packaged app; this makes it behave
      // as a plain Node process. It is harmless under Node tests.
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_IPC: '1',
      DSH_DESKTOP_HOST_GENERATION: String(generation),
      DSH_HOME: resolveHarnessHome(this.options.env ?? process.env),
      ...this.options.env,
    }
    const spawn = this.options.spawn ?? fork
    const child = spawn(entry, args, {
      cwd: this.options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stdout?.on('data', chunk => process.stdout.write(`[harness] ${String(chunk)}`))
    child.stderr?.on('data', chunk => process.stderr.write(`[harness] ${String(chunk)}`))
    child.on('message', (raw: unknown) => { this.handleChildMessage(child, generation, raw) })
    child.on('error', (error) => {
      if (generation !== this.generation || child !== this.child) return
      if (this.child === child) this.child = undefined
      this.requests.rejectGeneration(generation, transportUnavailable(generation, error.message))
      if (this.desiredState !== 'running') {
        this.setState('stopped')
        return
      }
      if (this.childFailureReported) return
      this.childFailureReported = true
      this.scheduleRestart(error)
    })
    child.on('exit', (code, signal) => {
      if (generation !== this.generation || child !== this.child) return
      if (this.child === child) this.child = undefined
      this.requests.rejectGeneration(generation, transportUnavailable(generation, `exited code=${String(code)} signal=${String(signal)}`))
      if (this.desiredState !== 'running' || this.childFailureReported) {
        this.setState('stopped')
        return
      }
      this.childFailureReported = true
      this.scheduleRestart(new Error(`desktop Harness exited with code=${String(code)} signal=${String(signal)}`))
    })
  }

  private scheduleRestart(cause: Error): void {
    const now = Date.now()
    this.crashTimestamps.push(now)
    while (this.crashTimestamps.length > 0) {
      const oldest = this.crashTimestamps[0]
      if (oldest === undefined || oldest >= now - this.options.crashWindowMs) break
      this.crashTimestamps.shift()
    }
    if (!this.options.restart || this.crashTimestamps.length >= this.options.crashLimit) {
      this.setState('failed')
      if (this.crashTimestamps.length >= this.options.crashLimit) {
        this.emit('crash-loop', { cause, crashes: this.crashTimestamps.length, windowMs: this.options.crashWindowMs })
      }
      return
    }
    const delays = this.options.restartDelaysMs
    const index = Math.min(delays.length - 1, this.restartAttempt)
    const finalDelay = delays.at(-1)
    const delay = Math.max(1, this.options.restartBaseMs > 0
      ? this.options.restartBaseMs * 2 ** index
      : delays[index] ?? finalDelay ?? this.options.restartBaseMs)
    this.restartAttempt += 1
    this.setState('restarting')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.startInternal()
    }, delay)
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (childExited(child)) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        child.off('exit', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      child.once('exit', finish)
    })
  }

  private setState(state: HarnessState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.emit('state', state)
  }

  private assertRestartOptions(): void {
    if (this.options.restartDelaysMs.length === 0 || this.options.restartDelaysMs.some(delay => !Number.isInteger(delay) || delay <= 0)) {
      throw new Error('harness-process: restartDelaysMs must contain positive integers')
    }
    if (!Number.isInteger(this.options.crashWindowMs) || this.options.crashWindowMs <= 0) {
      throw new Error('harness-process: crashWindowMs must be a positive integer')
    }
    if (!Number.isInteger(this.options.crashLimit) || this.options.crashLimit <= 0) {
      throw new Error('harness-process: crashLimit must be a positive integer')
    }
    if (this.options.restartBaseMs < 0) {
      throw new Error('harness-process: restartBaseMs must be non-negative')
    }
  }
}
