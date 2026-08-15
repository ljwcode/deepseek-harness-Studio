
/**
 * Harness process manager: Electron main owns lifecycle, never Harness code.
 * The Harness runs as a forked `dsh --profile desktop` process with the
 * desktop IPC bridge enabled, so an agent/plugin crash cannot take down the
 * desktop shell.
 */

import { EventEmitter } from 'node:events'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  parseDesktopChildEnvelope,
  type DesktopHostRequest,
  type DesktopIpcEvent,
  type DesktopIpcRequestEnvelope,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { resolveHarnessHome } from './studio-home.ts'

export type HarnessState = 'starting' | 'ready' | 'restarting' | 'stopping' | 'stopped' | 'failed'

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
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

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

/** Process manager for the independent Harness host process. */
export class HarnessProcessManager extends EventEmitter {
  private child: ChildProcess | undefined
  private stateValue: HarnessState = 'stopped'
  private stopping = false
  private restartTimer: NodeJS.Timeout | undefined
  private restartAttempt = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly readyWaiters = new Set<() => void>()
  private readonly options: Required<Omit<HarnessProcessOptions, 'entry' | 'env' | 'args' | 'cwd'>> & HarnessProcessOptions

  constructor(options: HarnessProcessOptions = {}) {
    super()
    this.options = {
      restart: options.restart ?? true,
      restartBaseMs: options.restartBaseMs ?? 500,
    }
  }

  get state(): HarnessState {
    return this.stateValue
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  /** Start (or restart) the Harness child process. */
  start(): void {
    if (this.stateValue === 'starting' || this.stateValue === 'ready') return
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.stopping = false
    this.setState('starting')
    const entry = this.options.entry ?? resolveDshCliEntry()
    const args = ['--profile', 'desktop', ...(this.options.args ?? [])]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // fork() uses Electron's binary in a packaged app; this makes it behave
      // as a plain Node process. It is harmless under Node tests.
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_IPC: '1',
      DSH_HOME: resolveHarnessHome(this.options.env ?? process.env),
      ...this.options.env,
    }
    const child = fork(entry, args, {
      cwd: this.options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stdout?.on('data', chunk => process.stdout.write(`[harness] ${String(chunk)}`))
    child.stderr?.on('data', chunk => process.stderr.write(`[harness] ${String(chunk)}`))
    child.on('message', (raw: unknown) => { this.handleChildMessage(raw) })
    child.on('error', (error) => {
      if (this.stopping) return
      this.rejectAllPending(error)
      this.setState('failed')
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.rejectAllPending(new Error(`harness exited before responding (code=${String(code)}, signal=${String(signal)})`))
      if (this.stopping) {
        this.setState('stopped')
        return
      }
      this.setState('failed')
      this.scheduleRestart()
    })
  }

  /** Graceful stop: SIGTERM, then SIGKILL after the bound. */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    if (child === undefined) {
      this.setState('stopped')
      return
    }
    if (this.stateValue !== 'stopping') this.setState('stopping')
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => { resolve() })
      setTimeout(() => { resolve() }, timeoutMs)
    })
    child.kill('SIGTERM')
    await exited
    if (this.child === child && child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    }
    if (this.child === child) this.child = undefined
    this.setState('stopped')
  }

  /** Restart on demand (plugin install/update path can call this later). */
  async restart(): Promise<void> {
    await this.stop()
    this.setState('restarting')
    this.start()
  }

  /** Wait until the desktop profile tree reported ready. */
  waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this.stateValue === 'ready') return Promise.resolve()
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
  request(message: DesktopHostRequest, timeoutMs = 30_000): Promise<unknown> {
    if (this.stateValue !== 'ready' || this.child === undefined || !this.child.connected) {
      return Promise.reject(new Error(`harness is ${this.stateValue}; desktop request ${message.kind} refused`))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`harness request ${message.kind} timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      const envelope: DesktopIpcRequestEnvelope = { kind: 'request', requestId, message }
      const activeChild = this.child
      if (activeChild === undefined || !activeChild.connected) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error('harness child disconnected before request send'))
        return
      }
      activeChild.send(envelope, (error) => {
        if (error === null) return
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  /** Lightweight liveness probe over the IPC channel. */
  async health(): Promise<boolean> {
    try {
      const value = await this.request({ kind: 'ping' }, 2_000)
      return typeof value === 'object' && value !== null && (value as { pong?: unknown }).pong === true
    } catch {
      return false
    }
  }

  private handleChildMessage(raw: unknown): void {
    const parsed = parseDesktopChildEnvelope(raw)
    if (!parsed.ok) {
      console.warn(`harness-process: dropping malformed child envelope: ${parsed.error}`)
      return
    }
    const envelope = parsed.value
    if (envelope.kind === 'ready') {
      this.setState('ready')
      for (const waiter of this.readyWaiters) waiter()
      this.readyWaiters.clear()
      this.restartAttempt = 0
      return
    }
    if (envelope.kind === 'response') {
      const pending = this.pending.get(envelope.requestId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(envelope.requestId)
      if (envelope.ok) pending.resolve(envelope.value)
      else pending.reject(new Error(`${envelope.error?.code ?? 'host-error'}: ${envelope.error?.message ?? 'unknown host error'}`))
      return
    }
    this.emitEvent(envelope.event)
  }

  private emitEvent(event: DesktopIpcEvent): void {
    this.emit('event', event)
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(requestId)
    }
  }

  private scheduleRestart(): void {
    if (!this.options.restart || this.stopping) return
    const delay = Math.min(15_000, this.options.restartBaseMs * 2 ** Math.min(5, this.restartAttempt))
    this.restartAttempt += 1
    this.setState('restarting')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.start()
    }, delay)
  }

  private setState(state: HarnessState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.emit('state', state)
  }
}
